#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_2022::ID as TOKEN_2022_ID;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use solana_sha256_hasher::hashv;

declare_id!("14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S");

const SETTLEMENT_LEAF_DOMAIN: &[u8] = b"xpoker:settlement:leaf:v1";
const SETTLEMENT_NODE_DOMAIN: &[u8] = b"xpoker:settlement:node:v1";
const MAX_MERKLE_PROOF_DEPTH: usize = 32;
const MAX_REFUND_DELAY_SLOTS: u64 = 1_512_000;
const MIN_CLAIM_DELAY_SLOTS: u64 = 9_000;
const MAX_CLAIM_DELAY_SLOTS: u64 = 216_000;

#[program]
pub mod xpoker_escrow {
    use super::*;

    pub fn initialize_session(
        ctx: Context<InitializeSession>,
        session_id: [u8; 32],
        authority: Pubkey,
        refund_after_slot: u64,
    ) -> Result<()> {
        require!(
            authority != Pubkey::default(),
            EscrowError::InvalidAuthority
        );
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            TOKEN_2022_ID,
            EscrowError::InvalidTokenProgram
        );

        let current_slot = Clock::get()?.slot;
        require!(
            refund_after_slot > current_slot
                && refund_after_slot - current_slot <= MAX_REFUND_DELAY_SLOTS,
            EscrowError::InvalidRefundDeadline
        );

        let session = &mut ctx.accounts.session;
        session.session_id = session_id;
        session.authority = authority;
        session.pending_authority = Pubkey::default();
        session.mint = ctx.accounts.mint.key();
        session.token_program = ctx.accounts.token_program.key();
        session.settlement_root = [0; 32];
        session.transcript_root = [0; 32];
        session.total_deposited = 0;
        session.total_released = 0;
        session.refund_after_slot = refund_after_slot;
        session.claim_after_slot = 0;
        session.status = SessionStatus::Open as u8;
        session.bump = ctx.bumps.session;
        session.vault_bump = ctx.bumps.vault;

        emit!(SessionInitialized {
            session: session.key(),
            session_id,
            authority,
            mint: session.mint,
            token_program: session.token_program,
            refund_after_slot,
        });

        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, requested_amount: u64) -> Result<()> {
        require!(requested_amount > 0, EscrowError::InvalidAmount);
        require_status(&ctx.accounts.session, SessionStatus::Open)?;
        require!(
            Clock::get()?.slot < ctx.accounts.session.refund_after_slot,
            EscrowError::RefundDeadlineReached
        );

        let vault_balance_before = ctx.accounts.vault.amount;
        let transfer_accounts = TransferChecked {
            from: ctx.accounts.player_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.player.to_account_info(),
        };

        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.key(), transfer_accounts),
            requested_amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.vault.reload()?;
        let credited_amount = ctx
            .accounts
            .vault
            .amount
            .checked_sub(vault_balance_before)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        require!(credited_amount > 0, EscrowError::ZeroCredit);

        let deposit = &mut ctx.accounts.deposit_record;
        if deposit.player == Pubkey::default() {
            deposit.session = ctx.accounts.session.key();
            deposit.player = ctx.accounts.player.key();
            deposit.amount = 0;
            deposit.refunded = false;
            deposit.bump = ctx.bumps.deposit_record;
        }

        deposit.amount = deposit
            .amount
            .checked_add(credited_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let session = &mut ctx.accounts.session;
        session.total_deposited = session
            .total_deposited
            .checked_add(credited_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        emit!(DepositCredited {
            session: session.key(),
            player: ctx.accounts.player.key(),
            requested_amount,
            credited_amount,
            player_total: deposit.amount,
            session_total: session.total_deposited,
        });

        Ok(())
    }

    pub fn lock_session(ctx: Context<AuthorityAction>) -> Result<()> {
        require_status(&ctx.accounts.session, SessionStatus::Open)?;
        require!(
            Clock::get()?.slot < ctx.accounts.session.refund_after_slot,
            EscrowError::RefundDeadlineReached
        );
        require!(
            ctx.accounts.session.total_deposited > 0,
            EscrowError::EmptySession
        );

        ctx.accounts.session.status = SessionStatus::Locked as u8;
        emit!(SessionLocked {
            session: ctx.accounts.session.key(),
            total_deposited: ctx.accounts.session.total_deposited,
        });
        Ok(())
    }

    pub fn commit_settlement(
        ctx: Context<AuthorityAction>,
        settlement_root: [u8; 32],
        transcript_root: [u8; 32],
        total_payout: u64,
        claim_after_slot: u64,
    ) -> Result<()> {
        require_status(&ctx.accounts.session, SessionStatus::Locked)?;
        require!(settlement_root != [0; 32], EscrowError::InvalidRoot);
        require!(transcript_root != [0; 32], EscrowError::InvalidRoot);
        require!(
            total_payout == ctx.accounts.session.total_deposited,
            EscrowError::SettlementDoesNotConserve
        );

        let current_slot = Clock::get()?.slot;
        require!(
            current_slot < ctx.accounts.session.refund_after_slot,
            EscrowError::RefundDeadlineReached
        );
        let claim_delay = claim_after_slot
            .checked_sub(current_slot)
            .ok_or(EscrowError::InvalidClaimDeadline)?;
        require!(
            (MIN_CLAIM_DELAY_SLOTS..=MAX_CLAIM_DELAY_SLOTS).contains(&claim_delay),
            EscrowError::InvalidClaimDeadline
        );

        let session = &mut ctx.accounts.session;
        session.settlement_root = settlement_root;
        session.transcript_root = transcript_root;
        session.claim_after_slot = claim_after_slot;
        session.status = SessionStatus::Settling as u8;

        emit!(SettlementCommitted {
            session: session.key(),
            settlement_root,
            transcript_root,
            total_payout,
            claim_after_slot,
        });
        Ok(())
    }

    pub fn claim_payout(
        ctx: Context<ClaimPayout>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require_status(&ctx.accounts.session, SessionStatus::Settling)?;
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(
            proof.len() <= MAX_MERKLE_PROOF_DEPTH,
            EscrowError::ProofTooDeep
        );
        require!(
            Clock::get()?.slot >= ctx.accounts.session.claim_after_slot,
            EscrowError::ClaimWindowNotOpen
        );

        let session_key = ctx.accounts.session.key();
        let leaf = settlement_leaf(&session_key, &ctx.accounts.player.key(), amount);
        require!(
            verify_sorted_merkle_proof(leaf, &proof, ctx.accounts.session.settlement_root),
            EscrowError::InvalidProof
        );

        let new_total_released = ctx
            .accounts
            .session
            .total_released
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        require!(
            new_total_released <= ctx.accounts.session.total_deposited,
            EscrowError::SettlementDoesNotConserve
        );

        let claim = &mut ctx.accounts.claim_record;
        claim.session = session_key;
        claim.player = ctx.accounts.player.key();
        claim.amount = amount;
        claim.bump = ctx.bumps.claim_record;

        transfer_from_vault(
            &ctx.accounts.session,
            &ctx.accounts.vault,
            &ctx.accounts.player_token,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
            amount,
        )?;

        ctx.accounts.session.total_released = new_total_released;
        emit!(PayoutClaimed {
            session: session_key,
            player: ctx.accounts.player.key(),
            amount,
            total_released: new_total_released,
        });

        Ok(())
    }

    pub fn begin_refund(ctx: Context<BeginRefund>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let is_authority = ctx.accounts.caller.key() == ctx.accounts.session.authority;
        let status = SessionStatus::try_from(ctx.accounts.session.status)?;

        let allowed = match status {
            SessionStatus::Open | SessionStatus::Locked => {
                is_authority || current_slot >= ctx.accounts.session.refund_after_slot
            }
            SessionStatus::Settling => {
                is_authority && current_slot < ctx.accounts.session.claim_after_slot
            }
            SessionStatus::Refunding => return err!(EscrowError::AlreadyRefunding),
        };
        require!(allowed, EscrowError::RefundNotAvailable);
        require!(
            ctx.accounts.session.total_released == 0,
            EscrowError::PayoutAlreadyReleased
        );

        ctx.accounts.session.status = SessionStatus::Refunding as u8;
        emit!(RefundStarted {
            session: ctx.accounts.session.key(),
            caller: ctx.accounts.caller.key(),
            at_slot: current_slot,
        });
        Ok(())
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        require_status(&ctx.accounts.session, SessionStatus::Refunding)?;
        require!(
            !ctx.accounts.deposit_record.refunded,
            EscrowError::AlreadyRefunded
        );

        let amount = ctx.accounts.deposit_record.amount;
        require!(amount > 0, EscrowError::InvalidAmount);

        let new_total_released = ctx
            .accounts
            .session
            .total_released
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        require!(
            new_total_released <= ctx.accounts.session.total_deposited,
            EscrowError::SettlementDoesNotConserve
        );

        transfer_from_vault(
            &ctx.accounts.session,
            &ctx.accounts.vault,
            &ctx.accounts.player_token,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
            amount,
        )?;

        ctx.accounts.deposit_record.refunded = true;
        ctx.accounts.session.total_released = new_total_released;
        emit!(RefundClaimed {
            session: ctx.accounts.session.key(),
            player: ctx.accounts.player.key(),
            amount,
            total_released: new_total_released,
        });
        Ok(())
    }

    pub fn propose_authority(
        ctx: Context<AuthorityAction>,
        pending_authority: Pubkey,
    ) -> Result<()> {
        require!(
            pending_authority != Pubkey::default()
                && pending_authority != ctx.accounts.session.authority,
            EscrowError::InvalidAuthority
        );
        require_status(&ctx.accounts.session, SessionStatus::Open)?;

        ctx.accounts.session.pending_authority = pending_authority;
        emit!(AuthorityProposed {
            session: ctx.accounts.session.key(),
            authority: ctx.accounts.session.authority,
            pending_authority,
        });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_status(&ctx.accounts.session, SessionStatus::Open)?;
        require!(
            ctx.accounts.session.pending_authority == ctx.accounts.pending_authority.key(),
            EscrowError::InvalidAuthority
        );

        let previous_authority = ctx.accounts.session.authority;
        ctx.accounts.session.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.session.pending_authority = Pubkey::default();
        emit!(AuthorityAccepted {
            session: ctx.accounts.session.key(),
            previous_authority,
            authority: ctx.accounts.session.authority,
        });
        Ok(())
    }

    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        let status = SessionStatus::try_from(ctx.accounts.session.status)?;
        require!(
            matches!(status, SessionStatus::Settling | SessionStatus::Refunding),
            EscrowError::InvalidStatus
        );
        require!(
            ctx.accounts.session.total_released == ctx.accounts.session.total_deposited,
            EscrowError::SessionNotEmpty
        );
        let surplus = ctx.accounts.vault.amount;
        if surplus > 0 {
            transfer_from_vault(
                &ctx.accounts.session,
                &ctx.accounts.vault,
                &ctx.accounts.authority_token,
                &ctx.accounts.mint,
                &ctx.accounts.token_program,
                surplus,
            )?;
            ctx.accounts.vault.reload()?;
        }
        require!(ctx.accounts.vault.amount == 0, EscrowError::SessionNotEmpty);

        let session_id = ctx.accounts.session.session_id;
        let bump = [ctx.accounts.session.bump];
        let signer_seeds: &[&[u8]] = &[b"session", session_id.as_ref(), &bump];
        let close_accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.authority.to_account_info(),
            authority: ctx.accounts.session.to_account_info(),
        };
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            close_accounts,
            &[signer_seeds],
        ))?;

        emit!(SessionClosed {
            session: ctx.accounts.session.key(),
            total_released: ctx.accounts.session.total_released,
            surplus_swept: surplus,
        });
        Ok(())
    }
}

fn transfer_from_vault<'info>(
    session: &Account<'info, EscrowSession>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    player_token: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let bump = [session.bump];
    let signer_seeds: &[&[u8]] = &[b"session", session.session_id.as_ref(), &bump];
    let transfer_accounts = TransferChecked {
        from: vault.to_account_info(),
        mint: mint.to_account_info(),
        to: player_token.to_account_info(),
        authority: session.to_account_info(),
    };

    token_interface::transfer_checked(
        CpiContext::new_with_signer(token_program.key(), transfer_accounts, &[signer_seeds]),
        amount,
        mint.decimals,
    )
}

fn settlement_leaf(session: &Pubkey, player: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[
        SETTLEMENT_LEAF_DOMAIN,
        session.as_ref(),
        player.as_ref(),
        &amount.to_be_bytes(),
    ])
    .to_bytes()
}

fn verify_sorted_merkle_proof(
    mut current: [u8; 32],
    proof: &[[u8; 32]],
    expected_root: [u8; 32],
) -> bool {
    for sibling in proof {
        let (left, right) = if current <= *sibling {
            (&current, sibling)
        } else {
            (sibling, &current)
        };
        current = hashv(&[SETTLEMENT_NODE_DOMAIN, left, right]).to_bytes();
    }
    current == expected_root
}

fn require_status(session: &EscrowSession, expected: SessionStatus) -> Result<()> {
    require!(session.status == expected as u8, EscrowError::InvalidStatus);
    Ok(())
}

#[derive(Accounts)]
#[instruction(session_id: [u8; 32])]
pub struct InitializeSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + EscrowSession::LEN,
        seeds = [b"session", session_id.as_ref()],
        bump
    )]
    pub session: Box<Account<'info, EscrowSession>>,
    #[account(
        init,
        payer = payer,
        seeds = [b"vault", session.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = session,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"session", session.session_id.as_ref()],
        bump = session.bump,
        has_one = mint,
        constraint = session.token_program == token_program.key() @ EscrowError::InvalidTokenProgram
    )]
    pub session: Box<Account<'info, EscrowSession>>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + DepositRecord::LEN,
        seeds = [b"deposit", session.key().as_ref(), player.key().as_ref()],
        bump,
        constraint = deposit_record.player == Pubkey::default() || deposit_record.player == player.key() @ EscrowError::InvalidPlayer,
        constraint = deposit_record.session == Pubkey::default() || deposit_record.session == session.key() @ EscrowError::InvalidSession
    )]
    pub deposit_record: Box<Account<'info, DepositRecord>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = player,
        token::token_program = token_program
    )]
    pub player_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"vault", session.key().as_ref()],
        bump = session.vault_bump,
        token::mint = mint,
        token::authority = session,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityAction<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"session", session.session_id.as_ref()],
        bump = session.bump,
        has_one = authority
    )]
    pub session: Box<Account<'info, EscrowSession>>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"session", session.session_id.as_ref()],
        bump = session.bump,
        has_one = mint,
        constraint = session.token_program == token_program.key() @ EscrowError::InvalidTokenProgram
    )]
    pub session: Box<Account<'info, EscrowSession>>,
    #[account(
        init,
        payer = player,
        space = 8 + ClaimRecord::LEN,
        seeds = [b"claim", session.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub claim_record: Box<Account<'info, ClaimRecord>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = player,
        token::token_program = token_program
    )]
    pub player_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"vault", session.key().as_ref()],
        bump = session.vault_bump,
        token::mint = mint,
        token::authority = session,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BeginRefund<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [b"session", session.session_id.as_ref()],
        bump = session.bump
    )]
    pub session: Box<Account<'info, EscrowSession>>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"session", session.session_id.as_ref()],
        bump = session.bump,
        has_one = mint,
        constraint = session.token_program == token_program.key() @ EscrowError::InvalidTokenProgram
    )]
    pub session: Box<Account<'info, EscrowSession>>,
    #[account(
        mut,
        seeds = [b"deposit", session.key().as_ref(), player.key().as_ref()],
        bump = deposit_record.bump,
        has_one = session,
        has_one = player
    )]
    pub deposit_record: Box<Account<'info, DepositRecord>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = player,
        token::token_program = token_program
    )]
    pub player_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"vault", session.key().as_ref()],
        bump = session.vault_bump,
        token::mint = mint,
        token::authority = session,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"session", session.session_id.as_ref()],
        bump = session.bump
    )]
    pub session: Box<Account<'info, EscrowSession>>,
}

#[derive(Accounts)]
pub struct CloseSession<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        close = authority,
        seeds = [b"session", session.session_id.as_ref()],
        bump = session.bump,
        has_one = authority,
        has_one = mint,
        constraint = session.token_program == token_program.key() @ EscrowError::InvalidTokenProgram
    )]
    pub session: Box<Account<'info, EscrowSession>>,
    #[account(
        mut,
        seeds = [b"vault", session.key().as_ref()],
        bump = session.vault_bump,
        token::mint = mint,
        token::authority = session,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = authority,
        token::token_program = token_program
    )]
    pub authority_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct EscrowSession {
    pub session_id: [u8; 32],
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub settlement_root: [u8; 32],
    pub transcript_root: [u8; 32],
    pub total_deposited: u64,
    pub total_released: u64,
    pub refund_after_slot: u64,
    pub claim_after_slot: u64,
    pub status: u8,
    pub bump: u8,
    pub vault_bump: u8,
}

impl EscrowSession {
    pub const LEN: usize = (32 * 7) + (8 * 4) + 3;
}

#[account]
pub struct DepositRecord {
    pub session: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub refunded: bool,
    pub bump: u8,
}

impl DepositRecord {
    pub const LEN: usize = (32 * 2) + 8 + 1 + 1;
}

#[account]
pub struct ClaimRecord {
    pub session: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

impl ClaimRecord {
    pub const LEN: usize = (32 * 2) + 8 + 1;
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionStatus {
    Open = 0,
    Locked = 1,
    Settling = 2,
    Refunding = 3,
}

impl TryFrom<u8> for SessionStatus {
    type Error = anchor_lang::error::Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::Open),
            1 => Ok(Self::Locked),
            2 => Ok(Self::Settling),
            3 => Ok(Self::Refunding),
            _ => err!(EscrowError::InvalidStatus),
        }
    }
}

#[event]
pub struct SessionInitialized {
    pub session: Pubkey,
    pub session_id: [u8; 32],
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub refund_after_slot: u64,
}

#[event]
pub struct DepositCredited {
    pub session: Pubkey,
    pub player: Pubkey,
    pub requested_amount: u64,
    pub credited_amount: u64,
    pub player_total: u64,
    pub session_total: u64,
}

#[event]
pub struct SessionLocked {
    pub session: Pubkey,
    pub total_deposited: u64,
}

#[event]
pub struct SettlementCommitted {
    pub session: Pubkey,
    pub settlement_root: [u8; 32],
    pub transcript_root: [u8; 32],
    pub total_payout: u64,
    pub claim_after_slot: u64,
}

#[event]
pub struct PayoutClaimed {
    pub session: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub total_released: u64,
}

#[event]
pub struct RefundStarted {
    pub session: Pubkey,
    pub caller: Pubkey,
    pub at_slot: u64,
}

#[event]
pub struct RefundClaimed {
    pub session: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub total_released: u64,
}

#[event]
pub struct AuthorityProposed {
    pub session: Pubkey,
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct AuthorityAccepted {
    pub session: Pubkey,
    pub previous_authority: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct SessionClosed {
    pub session: Pubkey,
    pub total_released: u64,
    pub surplus_swept: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("The session is not in the required state")]
    InvalidStatus,
    #[msg("The authority is invalid")]
    InvalidAuthority,
    #[msg("The refund deadline must be in the future and within the maximum delay")]
    InvalidRefundDeadline,
    #[msg("The refund deadline has been reached")]
    RefundDeadlineReached,
    #[msg("The claim deadline must leave an audit window")]
    InvalidClaimDeadline,
    #[msg("The amount must be greater than zero")]
    InvalidAmount,
    #[msg("The token transfer credited zero base units")]
    ZeroCredit,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("The session has no deposited tokens")]
    EmptySession,
    #[msg("The settlement root is invalid")]
    InvalidRoot,
    #[msg("Settlement must conserve every deposited base unit")]
    SettlementDoesNotConserve,
    #[msg("The claim window is not open")]
    ClaimWindowNotOpen,
    #[msg("The Merkle proof is invalid")]
    InvalidProof,
    #[msg("The Merkle proof exceeds the maximum depth")]
    ProofTooDeep,
    #[msg("Refund mode has already started")]
    AlreadyRefunding,
    #[msg("Refund mode is not available")]
    RefundNotAvailable,
    #[msg("A payout has already been released")]
    PayoutAlreadyReleased,
    #[msg("This deposit has already been refunded")]
    AlreadyRefunded,
    #[msg("The session or vault still contains value")]
    SessionNotEmpty,
    #[msg("The token program does not match the session")]
    InvalidTokenProgram,
    #[msg("The player does not match the record")]
    InvalidPlayer,
    #[msg("The session does not match the record")]
    InvalidSession,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn hex32(value: &str) -> [u8; 32] {
        assert_eq!(value.len(), 64);
        let mut output = [0u8; 32];
        for (index, byte) in output.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        output
    }

    #[test]
    fn sorted_merkle_proof_verifies_and_rejects_tampering() {
        let session = Pubkey::new_unique();
        let alice = Pubkey::new_unique();
        let bob = Pubkey::new_unique();
        let alice_leaf = settlement_leaf(&session, &alice, 40);
        let bob_leaf = settlement_leaf(&session, &bob, 60);
        let (left, right) = if alice_leaf <= bob_leaf {
            (&alice_leaf, &bob_leaf)
        } else {
            (&bob_leaf, &alice_leaf)
        };
        let root = hashv(&[SETTLEMENT_NODE_DOMAIN, left, right]).to_bytes();

        assert!(verify_sorted_merkle_proof(alice_leaf, &[bob_leaf], root));
        assert!(!verify_sorted_merkle_proof(
            settlement_leaf(&session, &alice, 41),
            &[bob_leaf],
            root
        ));
    }

    #[test]
    fn node_and_program_share_a_fixed_settlement_vector() {
        let session = Pubkey::from_str("14dia6Spfd6qu6Q36caisExYQsLA9si4PqFpqfiQ8Z9S").unwrap();
        let alice = Pubkey::from_str("11111111111111111111111111111111").unwrap();
        let alice_leaf = settlement_leaf(&session, &alice, 40);
        let proof = [
            hex32("33ea4c4926275a49fdd434db2ac6c25193100557d9d6cd84b75cab92780a13e3"),
            hex32("fb0cc8d8d6845cfa5478e1ed96c68d5a0d53f52335f76997fd534ca46b886fca"),
        ];
        let expected_root =
            hex32("c95e87ea822c47a3084ecd33c87c2fb33bc595f026dffaa55fbd07f3accc6ebf");

        assert_eq!(
            alice_leaf,
            hex32("944a1b5e38658289c76858c108cf2c03cda71557df5b29f456b6d187257cb11a")
        );
        assert!(verify_sorted_merkle_proof(
            alice_leaf,
            &proof,
            expected_root
        ));
    }
}
