import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, outboundSends, scheduledSendFiles } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider, type OpenSendAdapter, type OutboundMessage } from "@trafficflow/core";
import { ScheduleService, keepScheduledFilesSealed, runScheduledSendPass } from "../src/index.js";
import type { ScheduledFilesKeeping, ServiceContext } from "../src/index.js";

/**
 * SEND LATER's CANCEL vs the worker's CLAIM, under a genuinely HELD cross-connection row lock —
 * the two interleavings the whole feature's honesty rests on, and the ones PGlite structurally
 * cannot run (single connection; nothing can hold a lock against anything).
 *
 * The contract (`ScheduleService.cancel`'s header): exactly one of the two writers wins the row
 * lock. Cancel first ⇒ the row leaves `'scheduled'` and the claim's due scan matches nothing —
 * the mail NEVER leaves. Claim first ⇒ cancel's predicate matches zero rows, the locked re-read
 * waits out the claim and reports the SETTLED state — 409 "already being sent", never a false
 * "cancelled". A third property rides the same lock: the pass's claim is `SKIP LOCKED`, so it
 * never BLOCKS behind a held row (a serverless invocation waiting on somebody's open
 * transaction is a deadline it cannot control) and never double-claims one appointment.
 *
 * ## Why REAL Postgres (CLAUDE.md)
 * Every case is one connection blocking (or deliberately NOT blocking) behind another's
 * uncommitted transaction, then re-evaluating. Three production bugs were invisible to PGlite;
 * this is exactly the class.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");

const NOW = new Date("2026-08-28T12:00:00.000Z");
const DUE = new Date("2026-08-28T12:30:00.000Z");
const schedules = new ScheduleService();
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/** A fake SendAdapter — no network; counts deliveries. */
function fakeAdapter() {
  const state = { delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to tear down */ },
  });
  return { factory, state };
}

async function seeded(
  files?: { filename: string; contentType: string; content: Buffer }[], keeping?: ScheduledFilesKeeping, sendAt = DUE,
) {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `later-${tag}@race.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the appointment", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbA, accountId, userId: null, now: () => NOW, requestId: "r" };
  await schedules.schedule(ctx, d!.id, sendAt.toISOString(), files ? { files, surfaceMaxTotalBytes: null, ...(keeping ? { keeping } : {}) } : undefined);
  return { ctx, accountId, draftId: d!.id };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("cancel vs the scheduled-send claim, across two real connections", () => {
  it("a cancel blocked behind an UNCOMMITTED claim re-evaluates and answers 409 — never a false 'cancelled'", async () => {
    const w = await seeded();

    // Connection B is "the worker's claim": the same write `claimDue` commits — the row leaves
    // 'scheduled' for the claim window ('draft', send_at/key standing) — held open under its lock.
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const claimTx = sqlB.begin(async (tx) => {
      await tx`update drafts set status = 'draft', updated_at = now()
               where id = ${w.draftId} and status = 'scheduled'`;
      await held;
    });
    await sleep(150); // let the claim take its row lock

    // Connection A cancels. It must WAIT for the claim, not decide from a pre-claim snapshot.
    let settledEarly = false;
    const cancelP = schedules.cancel(w.ctx, w.draftId)
      .then(() => { settledEarly = true; return null; })
      .catch((e: unknown) => { settledEarly = true; return e as { httpStatus?: number }; });
    await sleep(300);
    expect(settledEarly, "cancel answered from a snapshot the claim's lock should have held back").toBe(false);

    releaseLock();
    await claimTx;
    const err = await cancelP;

    // The claim won: the honest answer is "already being sent", and the appointment STANDS for
    // the sender the claim belongs to — nothing here may unwind a send in flight.
    expect(err).not.toBeNull();
    expect(err!.httpStatus).toBe(409);
    const [row] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(row!.status).toBe("draft");
    expect(row!.sendAt).not.toBeNull();
    expect(row!.sendKey).not.toBeNull();
  });

  it("a claim behind a COMMITTED cancel finds nothing: a cancelled appointment never sends", async () => {
    const w = await seeded();
    await schedules.cancel(w.ctx, w.draftId);

    const fake = fakeAdapter();
    // Assertions are scoped to THIS account: the shared :5433 database accumulates residue
    // rows from earlier (including killed) runs, and the pass legitimately claims those — a
    // global `claimed === 0` here would be an assertion about other tests' leftovers.
    await runScheduledSendPass(dbA, {
      openSendAdapter: fake.factory, now: () => new Date(DUE.getTime() + 60_000),
    });
    const [row] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(row!.status, "a cancelled appointment was claimed").toBe("draft");
    expect(row!.sendAt).toBeNull();
    const reservations = await dbA.select().from(outboundSends)
      .where(eq(outboundSends.accountId, w.accountId));
    expect(reservations, "a cancelled appointment minted a reservation").toHaveLength(0);
  });

  it("the claim SKIPS a held row rather than waiting on it — and takes it cleanly once released", async () => {
    const w = await seeded();

    // Connection B holds the row (an open cancel, an edit ceremony — any owner of the lock).
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const holdTx = sqlB.begin(async (tx) => {
      await tx`select id from drafts where id = ${w.draftId} for update`;
      await held;
    });
    await sleep(150);

    // The pass must answer NOW with nothing — `SKIP LOCKED` — not block behind the lock: on the
    // hosted deployment this runs inside a serverless invocation whose deadline nobody's open
    // transaction may spend. Watched red against a plain `FOR UPDATE`: this call simply hung
    // until the release below.
    const fake = fakeAdapter();
    const started = Date.now();
    const r1 = await runScheduledSendPass(dbA, {
      openSendAdapter: fake.factory, now: () => new Date(DUE.getTime() + 60_000),
    });
    expect(Date.now() - started, "the claim blocked behind a held row lock").toBeLessThan(2_000);
    expect(r1.claimed).toBe(0);
    expect(fake.state.delivered).toHaveLength(0);

    releaseLock();
    await holdTx;

    // Released ⇒ the next pass takes it and the appointment is kept — the skip deferred the
    // send by one cycle, it did not lose it.
    const r2 = await runScheduledSendPass(dbA, {
      openSendAdapter: fake.factory, now: () => new Date(DUE.getTime() + 120_000),
    });
    expect(r2).toMatchObject({ claimed: 1, sent: 1 });
    expect(fake.state.delivered).toHaveLength(1);
  });

  it("WITH FILES (mail 0179): a cancel that loses to the claim deletes no file; the claim sends them", async () => {
    const files = [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("%PDF the page") }];
    const w = await seeded(files);
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const claimTx = sqlB.begin(async (tx) => {
      await tx`update drafts set status = 'draft', updated_at = now()
               where id = ${w.draftId} and status = 'scheduled'`;
      await held;
    });
    await sleep(150);
    const cancelP = schedules.cancel(w.ctx, w.draftId).then(() => null, (e: unknown) => e as { httpStatus?: number });
    await sleep(300);
    releaseLock();
    await claimTx;
    expect((await cancelP)?.httpStatus).toBe(409);
    const kept = await dbA.select().from(scheduledSendFiles).where(eq(scheduledSendFiles.draftId, w.draftId));
    expect(kept.map((f) => f.filename), "a refused cancel took the files of a letter being sent").toEqual(["a.pdf"]);

    // The claim window's recovery sends the letter once, with its file.
    const fake = fakeAdapter();
    await runScheduledSendPass(dbA, { openSendAdapter: fake.factory, now: () => new Date(DUE.getTime() + 11 * 60_000) });
    const mine = fake.state.delivered.filter((m) => m.subject === "the appointment" && m.attachments?.length);
    expect(mine.map((m) => m.attachments!.map((a) => a.filename))).toEqual([["a.pdf"]]);
  });

  it("WITH FILES: a cancel that wins takes the files, and the claim sends nothing", async () => {
    const w = await seeded([{ filename: "b.png", contentType: "image/png", content: Buffer.from("png") }]);
    await schedules.cancel(w.ctx, w.draftId);
    expect(await dbA.select().from(scheduledSendFiles).where(eq(scheduledSendFiles.draftId, w.draftId))).toHaveLength(0);
    await runScheduledSendPass(dbA, { openSendAdapter: fakeAdapter().factory, now: () => new Date(DUE.getTime() + 60_000) });
    expect(await dbA.select().from(outboundSends).where(eq(outboundSends.accountId, w.accountId))).toHaveLength(0);
  });

  it("SEALED (mail 0180): two passes at once over a server's sealed letter deliver it once, with its file", async () => {
    const keeping = keepScheduledFilesSealed(new StaticKeyProvider({ 1: randomBytes(32) }));
    if (keeping.atRest !== "sealed") throw new Error("a server's keeping is sealed");
    const content = randomBytes(200_000);
    // A minute ahead of every other appointment here, so the claim's (send_at, id) order reaches it first.
    const w = await seeded([{ filename: "c.pdf", contentType: "application/pdf", content }], keeping, new Date(DUE.getTime() - 60_000));
    const fake = fakeAdapter();
    const files = { open: keeping.sealer.open.bind(keeping.sealer), tidy: true };
    const at = (): Date => new Date(DUE.getTime() + 60_000);
    await Promise.all([
      runScheduledSendPass(dbA, { openSendAdapter: fake.factory, now: at, files }),
      runScheduledSendPass(dbA, { openSendAdapter: fake.factory, now: at, files }),
    ]);
    const mine = fake.state.delivered.filter((m) => m.attachments?.some((a) => a.filename === "c.pdf"));
    expect(mine, "the sealed letter was delivered other than once").toHaveLength(1);
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    expect(sha(mine[0]!.attachments![0]!.content)).toBe(sha(content));
    expect(await dbA.select().from(outboundSends).where(eq(outboundSends.accountId, w.accountId))).toHaveLength(1);
    expect(await dbA.select().from(scheduledSendFiles).where(eq(scheduledSendFiles.draftId, w.draftId))).toHaveLength(0);
  });
});
