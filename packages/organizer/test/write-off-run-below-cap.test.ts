import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, messageFailures, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { DeadLetterLedger, HOLD_EXEMPT_CODES } from "../src/dead-letter.js";

/*
 * WRITE-OFF-RUN-BELOW-CAP-SKIPS-THE-STORED-FILTER, on PGlite (the desktop's store). Below the cap
 * `writeOffRun` returned the raw count, so four write-offs from before a stored message read as a
 * run of four and one new ordinary write-off engaged the hold. The phone's store has its twin in
 * `apps/sidecar/test/set-aside-is-said.test.ts` (B).
 */
const t0 = Date.UTC(2026, 9, 1, 12);
const CAP = 5;

async function seeded(rows: Array<{ code?: string; at: number }>, stored: number[]) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `wor-${randomUUID().slice(0, 8)}@lichtgrat.example` }).returning();
  for (const [i, at] of stored.entries()) {
    await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h-${i}`, dedupKey: `d-${i}`, createdAt: new Date(t0 + at),
    });
  }
  let uid = 1;
  for (const r of rows) {
    await db.insert(messageFailures).values({
      accountId, mailboxId: mb!.id, folder: "INBOX", uidvalidity: 100n, uid: uid++, code: r.code ?? "data_exception",
      attempts: 1, attemptedVersion: "build-one", nextAttemptAt: null,
      firstFailedAt: new Date(t0 + r.at), lastFailedAt: new Date(t0 + r.at),
    });
  }
  return { db, accountId, repo: makeDrizzleRepo(db), mailboxId: mb!.id };
}

/** The run itself; the newest-stored reading a lookup also returns is the ledger's business. */
const run = (r: { count: number; heldSince: Date | null }) => ({ count: r.count, heldSince: r.heldSince });
const four = (at: number) => Array.from({ length: 4 }, (_, i) => ({ at: at + i }));
const locator = (uid: number) => ({ folder: "INBOX", ref: `100:${uid}` });

describe("writeOffRun below the cap applies the stored-message filter (PGlite)", () => {
  it("four write-offs from before the newest stored message count nothing", async () => {
    const { repo, mailboxId } = await seeded(four(-60_000), [0]);
    expect(run(await repo.writeOffRun(mailboxId, "build-one", CAP, HOLD_EXEMPT_CODES))).toEqual({ count: 0, heldSince: null });
  });

  it("…so one new ordinary write-off does not engage the hold", async () => {
    const { repo, mailboxId } = await seeded(four(-60_000), [0]);
    const ledger = new DeadLetterLedger({ holdAtCap: true, perCycleCap: CAP });
    ledger.hydrateRun(await repo.writeOffRun(mailboxId, "build-one", CAP, HOLD_EXEMPT_CODES));
    ledger.beginCycle();
    expect(ledger.record(locator(50), { code: "data_exception", deterministic: true })).toBe("skip");
    expect(ledger.writeOffsHeldSince, "one write-off after a stored message held the mailbox").toBeNull();
  });

  it("CONTROL: four write-offs after the newest stored message still count four", async () => {
    const { repo, mailboxId } = await seeded(four(60_000), [0]);
    expect(run(await repo.writeOffRun(mailboxId, "build-one", CAP, HOLD_EXEMPT_CODES))).toEqual({ count: 4, heldSince: null });
  });

  it("CONTROL: with nothing stored, four write-offs count four", async () => {
    const { repo, mailboxId } = await seeded(four(0), []);
    expect((await repo.writeOffRun(mailboxId, "build-one", CAP, HOLD_EXEMPT_CODES)).count).toBe(4);
  });

  it("CONTROL: a real run still holds — four after the stored message and a fifth new one", async () => {
    const { repo, mailboxId } = await seeded(four(60_000), [0]);
    const ledger = new DeadLetterLedger({ holdAtCap: true, perCycleCap: CAP });
    ledger.hydrateRun(await repo.writeOffRun(mailboxId, "build-one", CAP, HOLD_EXEMPT_CODES));
    ledger.beginCycle();
    ledger.record(locator(50), { code: "data_exception", deterministic: true });
    expect(ledger.writeOffsHeldSince, "five write-offs after the stored message did not hold").not.toBeNull();
  });

  /* LOW 4: the newest stored message was looked up at the top of every
     cycle. It is read once per launch and again only after a cycle stored one. Proved by a stored
     row written behind the ledger's back: a cached reading still counts the four, a fresh one 0. */
  it("the newest stored message is read once, not every cycle, and again after a message is stored", async () => {
    const w = await seeded(four(60_000), [0]);
    const ledger = new DeadLetterLedger({ holdAtCap: true, perCycleCap: CAP });
    let lookups = 0;
    const counting = {
      writeOffRun: (...a: Parameters<NonNullable<typeof w.repo.writeOffRun>>) => {
        if (a[4] === undefined) lookups++;
        return w.repo.writeOffRun!(...a);
      },
    };
    await ledger.hydrateRunFrom(counting, w.mailboxId, "build-one");
    await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h-new", dedupKey: "d-new", createdAt: new Date(t0 + 120_000),
    });
    for (let i = 0; i < 5; i++) {
      ledger.beginCycle();
      await ledger.hydrateRunFrom(counting, w.mailboxId, "build-one");
    }
    expect(lookups, "the newest stored message was looked up on an idle cycle").toBe(1);
    ledger.beginCycle();
    ledger.record(locator(50), { code: "data_exception", deterministic: true });
    expect(ledger.writeOffsHeldSince, "the cached reading lost the run").not.toBeNull();
    ledger.noteStored();
    await ledger.hydrateRunFrom(counting, w.mailboxId, "build-one");
    expect(lookups, "a cycle that stored a message did not refresh the reading").toBe(2);
    expect(ledger.writeOffsHeldSince).toBeNull();
  });
});
