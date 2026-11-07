import { storageEmptyingNow, storageUpgradeOf, type AccessVerdict, type StorageOffer } from "@trafficflow/db";
import {
  storageCardOf, storageLimitReason, storageSharesOf,
  type StorageCardFacts, type StorageCardLevel, type StorageLimit, type StorageReading,
} from "@trafficflow/db/cloud";

/**
 * THE `storage` BLOCK OF `GET /account/access`, built from one storage reading, the program's verdict
 * and the limit every cap reader applies. Hosted-only, like `routes/account.ts`, which alone imports
 * it. Additive over the fields before it: a client reads each new one as optional.
 */
export interface StorageBlock {
  usedBytes: number;
  limitBytes: number;
  emptiedForSpace: number;
  firstEmptiedAt: string | null;
  keptFrom: string | null;
  withheldOnArrival: number;
  upgrade: "plan" | "addon";
  emptyingNow: boolean;
  planLimitBytes?: number;
  limitDropsAt?: string | null;
  /** Why the cap is what it is: the plan's own limit, the trial's room above it, or a lower limit held. */
  limitReason: "plan" | "trial" | "held";
  /** A mailbox is still on its first import. */
  importing: boolean;
  /** The card to draw atop the Ohbox, the person's dismissal applied. */
  card: StorageCardLevel | null;
  /** Storage mails are on. */
  mail: boolean;
  estimate: {
    expectedBytes: number; expectedLetters: number; storedLetters: number;
    avgLetterBytes: number; avgMeasured: boolean; complete: boolean; at: string | null;
  };
  /** Per mailbox, by id only: the bytes of the counter its letters hold, and what it is expected to need. */
  mailboxes: Array<{
    id: string; usedBytes: number; letters: number; expectedLetters: number; expectedBytes: number; importing: boolean;
  }>;
  /** The program's storage offer, when it answered one. */
  offer?: StorageOffer;
}

/** The facts the card is decided on. */
export function storageCardFactsOf(reading: StorageReading, limit: StorageLimit, now: Date): StorageCardFacts {
  return {
    usedBytes: reading.counter.usedBytes, capBytes: limit.capBytes, planBytes: limit.planBytes,
    dropsAt: limit.dropsAt, emptiedForSpace: reading.counter.emptiedForSpace,
    emptyingNow: storageEmptyingNow(reading.counter, limit.capBytes, now),
  };
}

export function storageBlockOf(
  reading: StorageReading, verdict: Extract<AccessVerdict, { ok: true }>, limit: StorageLimit, now: Date,
): StorageBlock {
  const { counter, estimate, facts } = reading;
  const card = storageCardFactsOf(reading, limit, now);
  const shares = storageSharesOf(counter.usedBytes, facts.mailboxes);
  const byId = new Map(estimate.mailboxes.map((m) => [m.id, m]));
  return {
    usedBytes: counter.usedBytes, limitBytes: limit.capBytes, emptiedForSpace: counter.emptiedForSpace,
    firstEmptiedAt: counter.firstEmptiedAt, keptFrom: counter.keptFrom, withheldOnArrival: counter.withheldOnArrival,
    upgrade: storageUpgradeOf(limit.planBytes ?? limit.capBytes),
    emptyingNow: card.emptyingNow,
    // The trial's floor or a held drop: the plan's own, lower limit and when it applies.
    ...(limit.planBytes !== null ? { planLimitBytes: limit.planBytes, limitDropsAt: limit.dropsAt } : {}),
    limitReason: storageLimitReason(verdict.limits.storageBytes ?? limit.capBytes, limit),
    importing: facts.mailboxes.some((m) => m.importing),
    card: storageCardOf(card, reading.prefs.dismissal, now),
    mail: reading.prefs.mailOffAt === null,
    estimate: {
      expectedBytes: estimate.expectedBytes, expectedLetters: estimate.expectedLetters,
      storedLetters: estimate.storedLetters, avgLetterBytes: estimate.avgLetterBytes,
      avgMeasured: estimate.avgMeasured, complete: estimate.complete,
      at: facts.at === null ? null : facts.at.toISOString(),
    },
    mailboxes: facts.mailboxes.map((m) => {
      const e = byId.get(m.id)!;
      return {
        id: m.id, usedBytes: shares.get(m.id) ?? 0, letters: e.letters,
        expectedLetters: e.expectedLetters, expectedBytes: e.expectedBytes, importing: m.importing,
      };
    }),
    ...(verdict.storageOffer ? { offer: verdict.storageOffer } : {}),
  };
}
