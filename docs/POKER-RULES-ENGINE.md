# Authoritative poker rules engine

Status: deterministic core and authoritative realtime candidate implemented; real-value play remains release-gated.

The engine under `server/poker/` is the sole rules authority. A browser may render legal actions, but it must never calculate an accepted bet, winner, side pot, rake amount, or payout.

## Supported rules

- NLH and four-card PLO, two to nine players.
- Correct heads-up and multiway blind/action order.
- Optional table ante and one live straddle from the first seat after the big blind.
- Integer atomic-unit stacks and contributions using JavaScript `bigint` only.
- Optimistic state versions; stale and out-of-turn actions fail closed.
- Fold, check, call, bet, raise and all-in actions.
- Full and short all-in raises, including correct reopening of betting rights.
- PLO maximum raises calculated as the pot after calling.
- Short all-in blinds without reducing the full preflop bring-in.
- Deterministic timeout behavior: check when free, otherwise fold.
- Flop, turn, river and automatic all-in runout transitions.
- Five-card ranking, including ace-to-five wheels and exact ties.
- NLH best five of seven; PLO exactly two hole cards plus exactly three board cards.
- Main/side pots, folded dead money and unmatched-bet refunds.
- One or two boards, split pots and deterministic odd chips clockwise from the button.
- Percentage rake with atomic cap and no-flop-no-drop.
- Conservation checks after pot construction, rake and final payout.

Cards use the same IDs as the fair-deal protocol: `0..12` are `2♣..A♣`, then diamonds, hearts and spades. Every board transition rejects malformed or duplicate cards.

## State flow

```text
BETTING -> AWAITING_DEAL -> BETTING -> ... -> SHOWDOWN
   |                              |
   +-> COMPLETE (all fold)        +-> AWAITING_RUNOUT (all-in)
```

Every accepted command includes `expectedVersion`. The durable service must append the command and resulting state hash in one PostgreSQL transaction, then publish it through the outbox. Redis can coordinate timers and fanout, but cannot be the system of record.

## Fixed rule decisions

- A raise amount is a target total for the current street, not an incremental amount.
- A short all-in does not reopen a player who already acted since the last full raise.
- The first odd chip goes to the first tied winner clockwise after the button.
- On two boards, an indivisible pot chip goes to board one before winner-level odd chips are assigned.
- Rake is removed main-pot-first, never exceeds the configured cap, and is zero if no flop was dealt.
- One table session has one canonical asset mint. Cross-mint pots are invalid.

## Still required around the engine

The service layer now covers reconnect replay, leased timeouts, explicit sit-out/return/leave state, time-bank consumption, ROE scheduling, wallet-bound WebSocket commands, connection-encrypted hole-card envelopes, append-only snapshots, deterministic randomized tests, full zero-value hand lifecycles, API replica replacement, TCP dependency faults, and a bounded 16-table soak. Tournament rules, collusion/bot detection, production hand-history UX, attested-dealer wiring, peak target-load and multi-region exercises, and independent review remain incomplete. Those gaps keep real-value mode disabled even though the mathematical and orchestration cores are implemented.
