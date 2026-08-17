import { randomBytes } from "node:crypto";

import {
  createAuditBundle,
  createCommittedHand,
  dealPlan,
  generateSecret,
  revealCard,
  verifyAuditBundle,
  verifyCardReveal,
} from "./protocol.js";

const handId = `demo-${Date.now()}`;
const rules = {
  game: "NLH",
  seats: 6,
  buttonSeat: 2,
  boards: 1,
  runItTwice: true,
  burns: true,
  dealingMap: "xpoker-standard/v1",
};
const players = Array.from({ length: 6 }, (_, index) => ({
  playerId: `demo-wallet-${index + 1}`,
  seed: generateSecret(),
}));
const beacon = {
  source: "local-demo-not-production",
  round: 0,
  randomness: randomBytes(32).toString("hex"),
};

const hand = createCommittedHand({ handId, rules, beacon, players });
const plan = dealPlan({ game: rules.game, seats: rules.seats, buttonSeat: rules.buttonSeat });
const flop = plan.boards[0].flop.map((position) => revealCard(hand.secretState.deck, position));
const audit = verifyAuditBundle(createAuditBundle(hand));

console.log(JSON.stringify({
  warning: "Local demonstration only. The beacon value has no external signature.",
  publicCommitment: hand.publicRecord,
  dealingPlan: plan,
  revealedFlop: flop.map((reveal) => ({
    position: reveal.position,
    card: reveal.card.code,
    proofValid: verifyCardReveal(hand.publicRecord.deckRoot, reveal),
  })),
  postHandAudit: {
    ok: audit.ok,
    localChecksPassed: audit.localChecksPassed,
    errors: audit.errors,
    beaconSignatureVerified: audit.beaconSignatureVerified,
    firstTenCardsAfterAudit: audit.deck.slice(0, 10).map((card) => card.code),
  },
}, null, 2));
