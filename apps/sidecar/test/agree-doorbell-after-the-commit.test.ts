import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@trafficflow/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@trafficflow/db")>();
  return { ...real, recordChanges: vi.fn(real.recordChanges) };
});
vi.mock("@trafficflow/services/mail", async (importOriginal) => {
  const real = await importOriginal<typeof import("@trafficflow/services/mail")>();
  return { ...real, fenceErasedAccount: vi.fn(real.fenceErasedAccount) };
});

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountSettings, accountSyncState, accounts, changeLog, mailboxes, recordChanges, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { ServiceError, fenceErasedAccount } from "@trafficflow/services/mail";
import type { LocalDb } from "../src/db.js";
import { createSidecarLog, type Diagnostic } from "../src/log.js";
import {
  authorizeOrganizerTakeover, recordConsentWithoutClaim, requestOrganizerTakeover,
} from "../src/organize-here.js";

/**
 * THE DESKTOP DOOR COMMITS THE CONSENT BEFORE ITS SETTINGS DOORBELL RINGS, at each of its five
 * consent transactions, as the hosted press does: the `settings` change row is written in a short
 * transaction of its own after the consent commits, the erasure fence first. A change row that
 * fails costs one doorbell and nothing the person pressed: the answer is the press's, the consent
 * and the window stand, one `_failed` line names the fault by class (no address), nothing retries.
 * An account erased between the two commits answers 410 and gets no change row. On both stores the
 * door runs on: the desktop's PGlite and the phone's SQLite.
 */

const ADDRESS = "planted.person@ex.example";
const EVENT = "organizer_consent_doorbell_failed";
const t0 = new Date("2026-03-01T10:00:00.000Z");
const t1 = new Date("2026-06-01T10:00:00.000Z");

class PlantedFault extends Error {
  constructor() {
    super(`connection for ${ADDRESS} failed`);
    this.name = "PlantedFault";
  }
}

const ring = vi.mocked(recordChanges);
const fence = vi.mocked(fenceErasedAccount);
afterEach(() => { ring.mockClear(); fence.mockClear(); });

type Shape = "reader" | "organizing" | "organizing-no-settings";

/** One account and one mailbox in the state an arm presses: a reader nobody consented on, or organizing with or without a record. */
async function world(shape: Shape) {
  const store = await makeTestDb();
  const tx = store as unknown as Tx;
  const accountId = randomUUID();
  await tx.insert(accounts).values({ id: accountId, name: "agree-after-commit" });
  const [mb] = await tx.insert(mailboxes).values({
    accountId, provider: "imap", address: "me@ohmail.test",
    organizerRole: shape === "reader" ? "reader" : "organizer",
    organizeConsentedAt: shape === "reader" ? null : t0,
  }).returning();
  if (shape === "organizing") {
    await tx.insert(accountSettings).values({
      accountId, dormancyDays: 90, screeningScope: "window", screeningBaselineAt: t0, updatedAt: t0,
    });
  }
  const lines: string[] = [];
  const log: Diagnostic = createSidecarLog({ sink: (l) => { lines.push(l); } });
  const settings = async () => (await tx.select({
    days: accountSettings.dormancyDays, baseline: accountSettings.screeningBaselineAt,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0];
  const consented = async () => (await tx.select({ at: mailboxes.organizeConsentedAt })
    .from(mailboxes).where(eq(mailboxes.id, mb!.id)))[0]!.at;
  const rings = async () => (await tx.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
  ))).length;
  const counter = async () => (await tx.select().from(accountSyncState)
    .where(eq(accountSyncState.accountId, accountId))).length;
  return {
    db: store as unknown as LocalDb, accountId, mailboxId: mb!.id, log, lines, settings, consented, rings, counter,
    named: (event: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event),
  };
}
type World = Awaited<ReturnType<typeof world>>;

interface Arm {
  name: string;
  shape: Shape;
  outcome: string;
  /** The window the press stores, where it asks one. */
  days?: number;
  press: (w: World) => Promise<string>;
}

/** The five consent transactions of `organize-here.ts`, each through its own door. */
const ARMS: readonly Arm[] = [
  {
    name: "the setup press's first consent", shape: "reader", outcome: "authorized", days: 120,
    press: async (w) => (await requestOrganizerTakeover(w.db, {
      intent: "join", mailboxId: w.mailboxId, accountId: w.accountId, now: t1,
      screening: { dormancyDays: 120, scope: "window" }, log: w.log,
    })).outcome,
  },
  {
    name: "the setup press's re-run with a wider window", shape: "organizing", outcome: "already_organizing", days: 365,
    press: async (w) => (await requestOrganizerTakeover(w.db, {
      intent: "join", mailboxId: w.mailboxId, accountId: w.accountId, now: t1,
      screening: { dormancyDays: 365, scope: "window" }, log: w.log,
    })).outcome,
  },
  {
    name: "the phone's consent without a claim", shape: "reader", outcome: "recorded",
    press: (w) => recordConsentWithoutClaim(w.db, { mailboxId: w.mailboxId, now: t1, log: w.log }),
  },
  {
    name: "the CLI's first consent", shape: "reader", outcome: "authorized",
    press: async (w) => (await authorizeOrganizerTakeover(w.db, {
      mailboxId: w.mailboxId, now: t1, intent: "takeover", log: w.log,
    })).outcome,
  },
  {
    name: "the CLI over an account with no settings record", shape: "organizing-no-settings", outcome: "already_organizing",
    press: async (w) => (await authorizeOrganizerTakeover(w.db, {
      mailboxId: w.mailboxId, now: t1, intent: "takeover", log: w.log,
    })).outcome,
  },
];

describe("the desktop door rings the settings doorbell after the consent commits", () => {
  for (const arm of ARMS) {
    it(`${arm.name}: a failed change row leaves the press answered and its consent standing`, async () => {
      const w = await world(arm.shape);
      ring.mockRejectedValueOnce(new PlantedFault());
      expect(await arm.press(w), "the committed press answered an error").toBe(arm.outcome);
      expect(ring, "the press never reached its doorbell: the case measures nothing").toHaveBeenCalledTimes(1);
      expect(ring.mock.calls[0]![1]).toEqual([
        { accountId: w.accountId, entityType: "settings", entityId: w.accountId, op: "update" },
      ]);
      const s = await w.settings();
      expect(s?.baseline ?? null, "the consent's baseline rolled back with the doorbell").not.toBeNull();
      if (arm.days !== undefined) expect(s?.days, "the window rolled back with the doorbell").toBe(arm.days);
      expect(await w.consented(), "the consent rolled back with the doorbell").not.toBeNull();
      expect(await w.rings(), "a change row the planted fault refused").toBe(0);
      const named = w.named(EVENT);
      expect(named, `${EVENT} was not written exactly once`).toHaveLength(1);
      expect(named[0]).toMatchObject({ event: EVENT, level: "error", mailboxId: w.mailboxId, errorClass: "PlantedFault" });
      expect(named[0], "the census dropped a field the line passes").not.toHaveProperty("droppedFields");
      expect(w.lines.join("\n").includes(ADDRESS), "the planted address reached the log").toBe(false);
    });
  }

  it("CONTROL: with nothing planted the first consent rings once and logs nothing", async () => {
    const w = await world("reader");
    expect(await ARMS[0]!.press(w)).toBe("authorized");
    expect(await w.rings()).toBe(1);
    expect(w.named(EVENT)).toEqual([]);
  });

  it("an account erased between the two commits answers 410, and its doorbell writes nothing", async () => {
    const w = await world("reader");
    const realFence = fence.getMockImplementation()!;
    // The consent's own fence passes; the erasure's stamp lands in its transaction just after it.
    fence.mockImplementationOnce(async (...args: Parameters<typeof fenceErasedAccount>) => {
      await realFence(...args);
      await (args[0] as Tx).update(accounts).set({ erasedAt: t1 }).where(eq(accounts.id, w.accountId));
    });
    const err = await ARMS[0]!.press(w).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect([(err as ServiceError).code, (err as ServiceError).httpStatus]).toEqual(["account_erased", 410]);
    expect(await w.consented(), "the consent itself did not commit").not.toBeNull();
    expect(fence, "the doorbell took no erasure fence of its own").toHaveBeenCalledTimes(2);
    expect(ring, "the doorbell wrote past the erasure fence").not.toHaveBeenCalled();
    expect(await w.rings()).toBe(0);
    expect(await w.counter(), "the doorbell recreated the erased account's counter row").toBe(0);
    expect(w.named(EVENT), "a refusal is not a failed doorbell").toEqual([]);
  });
});
