import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  canonicalJson,
  commitPlayerSeed,
  commitServerSeed,
  createAuditBundle,
  createCommittedHand,
  dealPlan,
  generateSecret,
} from "../fairness/protocol.js";
import { fetchVerifiedBeacon, reserveFutureRound } from "./beacon.js";
import { AuthoritativeHandCoordinator } from "./hand-coordinator.js";
import { PostgresHandEventStore } from "./postgres-hand-store.js";
import { nextHandSetup } from "./table-coordinator.js";
import { TranscriptSigner } from "./transcript.js";

const PREPARATION_PREFIX = "xpoker:safe-beta:preparation:";
const COMMITTED_PREFIX = "xpoker:safe-beta:committed:";
const LOCK_PREFIX = "xpoker:safe-beta:dealer-lock:";

function hash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function logError(logger, event, error, context = {}) {
  logger.error(JSON.stringify({
    level: "error",
    event,
    error: error instanceof Error ? error.message : String(error),
    ...context,
  }));
}

class RedisSafeBetaDealerStore {
  constructor(redis, { ttlSeconds = 7 * 24 * 60 * 60 } = {}) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.durable = true;
  }

  async putPreparation(handId, preparation) {
    const serialized = canonicalJson(preparation);
    const result = await this.redis.set(`${PREPARATION_PREFIX}${handId}`, serialized, {
      EX: this.ttlSeconds,
      NX: true,
    });
    if (result === "OK") return preparation;
    const existing = await this.getPreparation(handId);
    if (canonicalJson(existing) !== serialized) throw new Error("Safe-beta hand preparation conflict");
    return existing;
  }

  async getPreparation(handId) {
    const value = await this.redis.get(`${PREPARATION_PREFIX}${handId}`);
    return value ? JSON.parse(value) : undefined;
  }

  async put(handId, committedHand) {
    const bundle = createAuditBundle(committedHand);
    const serialized = canonicalJson(bundle);
    const result = await this.redis.set(`${COMMITTED_PREFIX}${handId}`, serialized, {
      EX: this.ttlSeconds,
      NX: true,
    });
    if (result === "OK") return true;
    const existing = await this.get(handId);
    if (!existing || canonicalJson(existing.publicRecord) !== canonicalJson(committedHand.publicRecord)) {
      throw new Error("Safe-beta committed hand conflict");
    }
    return false;
  }

  async get(handId) {
    const value = await this.redis.get(`${COMMITTED_PREFIX}${handId}`);
    if (!value) return undefined;
    const bundle = JSON.parse(value);
    const committed = createCommittedHand({
      handId,
      rules: bundle.publicRecord.rules,
      beacon: bundle.publicRecord.beacon,
      players: bundle.reveals.playerSeeds,
      serverSeed: bundle.reveals.serverSeed,
    });
    if (committed.publicRecord.deckRoot !== bundle.publicRecord.deckRoot) {
      throw new Error("Stored safe-beta deck no longer matches its commitment");
    }
    return committed;
  }

  async delete(handId) {
    return (await this.redis.del(`${COMMITTED_PREFIX}${handId}`)) === 1;
  }
}

export class SafeBetaDealer {
  constructor({
    redis,
    tableCoordinator,
    handCoordinator,
    dealerStore,
    beaconReservation = reserveFutureRound,
    beaconFetch = fetchVerifiedBeacon,
    logger = console,
    clock = () => new Date(),
  } = {}) {
    if (!redis?.set || !redis?.eval) throw new Error("Safe-beta dealer requires Redis");
    if (!tableCoordinator?.state || !tableCoordinator?.startHand) throw new Error("Safe-beta dealer requires a table coordinator");
    if (!handCoordinator?.state || !handCoordinator?.openHand) throw new Error("Safe-beta dealer requires a hand coordinator");
    this.redis = redis;
    this.tableCoordinator = tableCoordinator;
    this.handCoordinator = handCoordinator;
    this.dealerStore = dealerStore;
    this.beaconReservation = beaconReservation;
    this.beaconFetch = beaconFetch;
    this.logger = logger;
    this.clock = clock;
    this.closed = false;
    this.timers = new Set();
  }

  schedule(tableId, waitMs = 0) {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.run(tableId).catch((error) => {
        logError(this.logger, "safe_beta_dealer_failed", error, { tableId });
        this.schedule(tableId, 5_000);
      });
    }, waitMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  onTableEvent = async (event) => {
    if (["PLAYER_SEATED", "ACTION_APPLIED", "ACTION_TIMED_OUT", "STREET_DEALT", "RUNOUT_DEALT"].includes(event.type)) {
      this.schedule(event.tableId);
    }
    if (event.type === "HAND_FINISHED") this.schedule(event.tableId, 1_500);
  };

  async #withLock(tableId, operation) {
    const token = randomBytes(18).toString("base64url");
    const key = `${LOCK_PREFIX}${tableId}`;
    const acquired = await this.redis.set(key, token, { PX: 30_000, NX: true });
    if (acquired !== "OK") return false;
    try {
      await operation();
      return true;
    } finally {
      await this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        { keys: [key], arguments: [token] },
      ).catch(() => {});
    }
  }

  async run(tableId) {
    if (this.closed) return;
    await this.#withLock(tableId, async () => {
      let table = await this.tableCoordinator.state(tableId);
      if (table.status === "WAITING") {
        const active = table.seats.filter((seat) => seat.status === "SEATED" && BigInt(seat.stack) > 0n && !seat.leaving);
        if (active.length < 2) return;
        await this.#prepareAndStart(table);
        table = await this.tableCoordinator.state(tableId);
      }
      if (table.status === "HAND_ACTIVE") await this.#advance(tableId);
    });
  }

  async #prepareAndStart(table) {
    const setup = nextHandSetup(table);
    let preparation = await this.dealerStore.getPreparation(setup.handId);
    if (!preparation) {
      const serverSeed = generateSecret();
      const playerSeeds = setup.playerIds.map((playerId) => ({ playerId, seed: generateSecret() }));
      preparation = await this.dealerStore.putPreparation(setup.handId, {
        serverSeed,
        serverCommitment: commitServerSeed({ handId: setup.handId, seed: serverSeed }),
        playerSeeds,
        rules: setup.fairnessRules,
      });
    }

    let hand = await this.handCoordinator.state(setup.handId);
    if (hand.status === "MISSING") {
      await this.handCoordinator.openHand({
        handId: setup.handId,
        roomId: table.roomId,
        rules: setup.fairnessRules,
        players: setup.playerIds,
        serverCommitment: preparation.serverCommitment,
        idempotencyKey: `safe-beta-open:${setup.handId}`,
      });
      hand = await this.handCoordinator.state(setup.handId);
    }
    if (hand.status === "COMMITTING") {
      for (const player of preparation.playerSeeds) {
        if (hand.playerCommitments[player.playerId]) continue;
        await this.handCoordinator.submitPlayerCommitment({
          handId: setup.handId,
          playerId: player.playerId,
          commitment: commitPlayerSeed({ handId: setup.handId, playerId: player.playerId, seed: player.seed }),
          expectedVersion: hand.version,
          idempotencyKey: `safe-beta-player:${setup.handId}:${player.playerId}`,
        });
        hand = await this.handCoordinator.state(setup.handId);
      }
      if (!hand.beaconReservation) {
        const reservation = await this.beaconReservation({ safetyRounds: 2 });
        await this.handCoordinator.reserveBeacon({
          handId: setup.handId,
          reservation,
          expectedVersion: hand.version,
          idempotencyKey: `safe-beta-beacon:${setup.handId}`,
        });
        hand = await this.handCoordinator.state(setup.handId);
      }
    }
    if (hand.status === "BEACON_RESERVED") {
      const waitMs = Math.max(0, Date.parse(hand.beaconReservation.notBefore) - this.clock().getTime() + 150);
      if (waitMs > 0) await delay(Math.min(waitMs, 10_000));
      const beacon = await this.beaconFetch({ reservation: hand.beaconReservation });
      await this.handCoordinator.commitDeck({
        handId: setup.handId,
        beacon,
        serverSeed: preparation.serverSeed,
        playerSeeds: preparation.playerSeeds,
        expectedVersion: hand.version,
        idempotencyKey: `safe-beta-deck:${setup.handId}`,
      });
      hand = await this.handCoordinator.state(setup.handId);
    }
    if (hand.status !== "DEALING") return;
    const current = await this.tableCoordinator.state(table.tableId);
    if (current.status !== "WAITING") return;
    const transcript = (await this.handCoordinator.store.load(setup.handId)).at(-1);
    await this.tableCoordinator.startHand({
      tableId: table.tableId,
      handId: setup.handId,
      deckRoot: hand.deckRoot,
      fairnessTranscriptHead: transcript.eventHash,
      expectedVersion: current.version,
      idempotencyKey: `safe-beta-table-start:${setup.handId}`,
    });
  }

  async #advance(tableId) {
    for (let step = 0; step < 8; step += 1) {
      const table = await this.tableCoordinator.state(tableId);
      if (table.status !== "HAND_ACTIVE") return;
      const betting = table.currentHand.betting;
      if (betting.status === "BETTING") return;
      const handId = table.currentHand.handId;
      let hand = await this.handCoordinator.state(handId);
      if (betting.status === "AWAITING_DEAL") {
        const street = betting.pendingStreet;
        const positions = dealPlan(table.currentHand.fairnessRules).boards[0][street.toLowerCase()];
        const reveals = [];
        const revealEventHashes = [];
        for (const position of positions) {
          const result = await this.handCoordinator.revealPublicCard({
            handId,
            position,
            expectedVersion: hand.version,
            idempotencyKey: `safe-beta-reveal:${handId}:${position}`,
          });
          reveals.push(result.reveal);
          revealEventHashes.push(result.event.eventHash);
          hand = await this.handCoordinator.state(handId);
        }
        await this.tableCoordinator.dealStreet({
          tableId,
          street,
          reveals,
          revealEventHashes,
          expectedVersion: table.version,
          idempotencyKey: `safe-beta-street:${handId}:${street}`,
        });
        continue;
      }
      if (betting.status === "AWAITING_RUNOUT") {
        const board = dealPlan(table.currentHand.fairnessRules).boards[0];
        const positions = [...board.flop, ...board.turn, ...board.river].slice(betting.board.length);
        const reveals = [];
        const revealEventHashes = [];
        for (const position of positions) {
          const result = await this.handCoordinator.revealPublicCard({
            handId,
            position,
            expectedVersion: hand.version,
            idempotencyKey: `safe-beta-reveal:${handId}:${position}`,
          });
          reveals.push(result.reveal);
          revealEventHashes.push(result.event.eventHash);
          hand = await this.handCoordinator.state(handId);
        }
        await this.tableCoordinator.dealRunout({
          tableId,
          reveals,
          revealEventHashes,
          expectedVersion: table.version,
          idempotencyKey: `safe-beta-runout:${handId}`,
        });
        continue;
      }
      if (betting.status === "COMPLETE" || betting.status === "SHOWDOWN") {
        const completed = await this.handCoordinator.completeHand({
          handId,
          expectedVersion: hand.version,
          idempotencyKey: `safe-beta-hand-complete:${handId}`,
        });
        await this.tableCoordinator.finishHand({
          tableId,
          auditBundle: completed.auditBundle,
          fairnessTranscriptHead: completed.event.eventHash,
          expectedVersion: table.version,
          idempotencyKey: `safe-beta-table-finish:${handId}`,
        });
        return;
      }
      return;
    }
    throw new Error("Safe-beta dealer exceeded its bounded state transition loop");
  }

  getHoleCards = async ({ handId, wallet }) => this.handCoordinator.holeCardsFor({ handId, playerId: wallet });

  async audit(handId) {
    const hand = await this.handCoordinator.state(handId);
    if (hand.status !== "COMPLETE") {
      const error = new Error("Hand audit is available only after completion");
      error.statusCode = 409;
      error.code = "audit_not_ready";
      throw error;
    }
    const committed = await this.dealerStore.get(handId);
    if (!committed) throw new Error("Completed hand secret is unavailable");
    const verifiedBeacon = await this.beaconFetch({
      reservation: {
        source: committed.publicRecord.beacon.source,
        chainHash: committed.publicRecord.beacon.chainHash,
        round: committed.publicRecord.beacon.round,
      },
    });
    if (hash(verifiedBeacon) !== hash(committed.publicRecord.beacon)) {
      throw new Error("Stored hand beacon differs from the independently verified round");
    }
    const transcript = await this.handCoordinator.store.load(handId);
    return {
      version: "xpoker-safe-beta-audit/v1",
      fundsMove: false,
      beaconSignatureVerified: true,
      transcriptHead: transcript.at(-1)?.eventHash,
      transcriptLength: transcript.length,
      auditBundle: createAuditBundle(committed),
    };
  }

  async close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

export function createSafeBetaDealer({ pool, redis, tableCoordinator, signingKeyPem, nodeEnv, logger = console } = {}) {
  let privateKey = signingKeyPem;
  if (!privateKey) {
    if (nodeEnv === "production") throw new Error("SAFE_BETA_SIGNING_KEY_PEM is required for a production safe beta");
    privateKey = generateKeyPairSync("ed25519").privateKey;
  }
  const dealerStore = new RedisSafeBetaDealerStore(redis);
  const handCoordinator = new AuthoritativeHandCoordinator({
    store: new PostgresHandEventStore({ pool }),
    dealerStore,
    signer: new TranscriptSigner(privateKey),
    beaconVerifier: async ({ beacon, reservation }) => {
      const verified = await fetchVerifiedBeacon({ reservation });
      return hash(beacon) === hash(verified);
    },
  });
  return new SafeBetaDealer({ redis, tableCoordinator, handCoordinator, dealerStore, logger });
}

export { RedisSafeBetaDealerStore };
