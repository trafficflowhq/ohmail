import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@trafficflow/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@trafficflow/db")>();
  return { ...real, recordChanges: vi.fn(real.recordChanges) };
});

import { randomUUID } from "node:crypto";
import { format } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  accountSettings, accountSyncState, accounts, changeLog, mailboxCredentials, mailboxes, recordChanges, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeMailboxService } from "../src/mailbox-service.js";
import { ServiceError } from "../src/errors.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE AGREE PRESS COMMITS BEFORE ITS SETTINGS DOORBELL RINGS. The `settings` change row is written
 * in a short transaction of its own once the press has committed: inside the press it deadlocked a
 * writer that takes the counter before it reads the account row (`organize-here-lock-order.pg`).
 * So a change row that fails costs one doorbell and nothing the person pressed: the consent, the
 * stamp and the window stand, one warn line names the fault by class and code, and nothing
 * retries. The next settings change or the next `GET /consent` carries the window. An account
 * erased between the two commits answers 410, as the fenced seam does, and gets no change row.
 */

const ADDRESS = "planted.person@ex.example";
const NOW = new Date("2026-10-22T10:00:00.000Z");
const EVENT = "organize_settings_doorbell_failed";

class PlantedFault extends Error {
  readonly code = "08006";
  constructor() {
    super(`connection for ${ADDRESS} failed`);
    this.name = "PlantedFault";
  }
}

const ring = vi.mocked(recordChanges);
afterEach(() => { ring.mockClear(); vi.restoreAllMocks(); });

/** The logger's lines, parsed, and everything printed, as the process would show it. */
function heard() {
  const printed: string[] = [];
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    const s = format(...a);
    printed.push(s);
    try { lines.push(JSON.parse(s) as Record<string, unknown>); } catch { /* not a log line */ }
  });
  for (const m of ["error", "warn", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { printed.push(format(...a)); });
  }
  return { printed: () => printed.join("\n"), named: (event: string) => lines.filter((l) => l.event === event) };
}

/** A reader mailbox nobody consented on (the first consent), or one this account organizes with a window (a re-run). */
async function world(shape: "first" | "rerun", opts: { eraseInThePress?: boolean } = {}) {
  const db = await makeTestDb();
  const tx = db as unknown as Tx;
  const accountId = randomUUID();
  await tx.insert(accounts).values({ id: accountId, name: "organize-doorbell" });
  const [mb] = await tx.insert(mailboxes).values({
    accountId, provider: "imap", address: "fresh@example.test",
    organizerRole: shape === "first" ? "reader" : "organizer",
    organizeConsentedAt: shape === "first" ? null : NOW,
  }).returning();
  await tx.insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: "not-a-real-secret", keyVersion: 1,
  });
  if (shape === "rerun") {
    await tx.insert(accountSettings).values({
      accountId, dormancyDays: 90, screeningScope: "window", screeningBaselineAt: NOW, updatedAt: NOW,
    });
  }
  /* THE ERASURE BETWEEN THE TWO COMMITS: stamped inside the press, after its fence, through the
     allowance seam it reaches, so the press commits and only the doorbell's own fence can see it. */
  const svc = makeMailboxService({
    allowance: async (t: unknown) => {
      if (opts.eraseInThePress) {
        await (t as Tx).update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));
      }
    },
  });
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: "r",
  };
  const mailbox = async () => (await tx.select({
    consented: mailboxes.organizeConsentedAt, stamp: mailboxes.takeoverAuthorizedAt,
  }).from(mailboxes).where(eq(mailboxes.id, mb!.id)))[0]!;
  const settings = async () => (await tx.select({
    days: accountSettings.dormancyDays, baseline: accountSettings.screeningBaselineAt,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0];
  const rings = async () => (await tx.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
  ))).length;
  const counter = async () => (await tx.select().from(accountSyncState).where(eq(accountSyncState.accountId, accountId))).length;
  return { svc, ctx, accountId, mailboxId: mb!.id, mailbox, settings, rings, counter };
}

/** The planted call was the doorbell: one change, the account's settings. */
function rangTheDoorbell(accountId: string): void {
  expect(ring, "the press never reached its doorbell: the case measures nothing").toHaveBeenCalledTimes(1);
  expect(ring.mock.calls[0]![1]).toEqual([{ accountId, entityType: "settings", entityId: accountId, op: "update" }]);
}

function loggedOnce(h: ReturnType<typeof heard>, w: { accountId: string; mailboxId: string }): void {
  const named = h.named(EVENT);
  expect(named, `${EVENT} was not written exactly once`).toHaveLength(1);
  expect(named[0]).toMatchObject({
    event: EVENT, level: "warn", accountId: w.accountId, mailboxId: w.mailboxId,
    errorClass: "PlantedFault", errorCode: "08006",
  });
  expect(named[0], "the census dropped a field the line passes").not.toHaveProperty("droppedFields");
  expect(h.printed().includes(ADDRESS), "the planted address reached the process output").toBe(false);
}

describe("organizeHere rings the settings doorbell after its commit", () => {
  it("a first consent whose change row fails answers authorized: the consent, the stamp and the window stand", async () => {
    const w = await world("first");
    ring.mockRejectedValueOnce(new PlantedFault());
    const h = heard();
    const out = await w.svc.organizeHere(w.ctx, w.mailboxId, {
      intent: "join", screening: { dormancyDays: 120, scope: "window" },
    });
    expect(out.outcome, "the committed press answered an error").toBe("authorized");
    rangTheDoorbell(w.accountId);
    const mb = await w.mailbox();
    expect(mb.consented, "the consent rolled back with the doorbell").not.toBeNull();
    expect(mb.stamp, "the stamp rolled back with the doorbell").not.toBeNull();
    expect(await w.settings()).toMatchObject({ days: 120 });
    expect((await w.settings())?.baseline ?? null).not.toBeNull();
    expect(await w.rings(), "a change row the planted fault refused").toBe(0);
    loggedOnce(h, w);
  });

  it("a re-run whose change row fails answers already_organizing, and the widened window stands", async () => {
    const w = await world("rerun");
    ring.mockRejectedValueOnce(new PlantedFault());
    const h = heard();
    const out = await w.svc.organizeHere(w.ctx, w.mailboxId, {
      intent: "join", screening: { dormancyDays: 365, scope: "window" },
    });
    expect(out.outcome).toBe("already_organizing");
    rangTheDoorbell(w.accountId);
    expect(await w.settings(), "the window rolled back with the doorbell").toMatchObject({ days: 365 });
    expect(await w.rings()).toBe(0);
    loggedOnce(h, w);
  });

  it("CONTROL: with nothing planted the same press rings once and logs nothing", async () => {
    const w = await world("first");
    const h = heard();
    const out = await w.svc.organizeHere(w.ctx, w.mailboxId, {
      intent: "join", screening: { dormancyDays: 120, scope: "window" },
    });
    expect(out.outcome).toBe("authorized");
    expect(await w.rings()).toBe(1);
    expect(h.named(EVENT)).toEqual([]);
  });

  it("an account erased between the two commits answers 410, and its doorbell writes nothing", async () => {
    const w = await world("first", { eraseInThePress: true });
    const h = heard();
    const err = await w.svc.organizeHere(w.ctx, w.mailboxId, {
      intent: "join", screening: { dormancyDays: 120, scope: "window" },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect([(err as ServiceError).code, (err as ServiceError).httpStatus]).toEqual(["account_erased", 410]);
    expect((await w.mailbox()).consented, "the press itself did not commit").not.toBeNull();
    expect(ring, "the doorbell wrote past the erasure fence").not.toHaveBeenCalled();
    expect(await w.rings()).toBe(0);
    expect(await w.counter(), "the doorbell recreated the erased account's counter row").toBe(0);
    expect(h.named(EVENT), "a refusal is not a failed doorbell").toEqual([]);
  });
});
