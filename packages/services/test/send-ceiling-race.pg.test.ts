import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, outboundSends } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createLogger, SendNotSubmitted } from "@trafficflow/core";
import type { OpenSendAdapter, OutboundMessage, SendOptions } from "@trafficflow/core";
import { SendService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * THE DOUBLE-SEND BOUNDARY ACROSS THE ATTEMPT CEILING — a retry racing a LATE SUCCESS, on real
 * Postgres.
 *
 * The ceiling introduces a state that did not exist before: an attempt whose caller has been
 * answered (`queued`) while the submission it started is STILL RUNNING and may finalize at any
 * moment. Everything the send path guarantees has to survive that overlap, and the overlap is
 * two connections writing the same `outbound_sends` row — one finalizing a delivery, one
 * resolving a retry.
 *
 * ## Why REAL Postgres, and not PGlite (CLAUDE.md)
 * PGlite is one connection: nothing there can hold a row lock against anything else, so the
 * interleaving under test cannot occur at all and a green run would mean nothing. Three
 * production bugs were invisible to it and every one was this class.
 *
 * ## What must be true, in the reader's terms
 * The recipient gets the message ONCE. Whatever order the two writers land in, exactly one
 * envelope was ever offered, and the row ends in a state that does not invite a second one.
 */
const PG_UP = await realPgAvailable();

// The factory's pools, one per request: the binder takes a server handle only from the factory that
// registered its door.
const ownedA = makeOwnedDb(PG_TEST_URL);
const ownedB = makeOwnedDb(PG_TEST_URL);
const dbA = ownedA.db;
const dbB = ownedB.db;
// A reader of pg_stat_activity, never handed to a service.
const sqlA = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });

const NOW = new Date("2026-09-02T12:00:00.000Z");
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * THE RELEASE GATE, as the real adapter passes it (`imap.ts`): the end-of-data mark waits for
 * `beforeRelease`, which commits `complete` on the reservation, and a refused release submitted
 * nothing. A fake that skips it leaves its rows `uploading`, which production never holds once a
 * server can answer: an `uploading` row is forgotten after ten minutes, a `complete` one is not.
 */
async function passReleaseGate(opts: SendOptions | undefined): Promise<void> {
  try {
    await opts?.beforeRelease?.();
  } catch (err) {
    throw new SendNotSubmitted("data", err);
  }
}

async function seeded() {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `ceiling-${tag}@race.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the slow send", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctxA: ServiceContext = { db: dbFor(dbA, accountId), accountId, userId: null, now: () => NOW, requestId: "a" };
  // The RETRY arrives on its own connection, the way a second HTTP request does.
  const ctxB: ServiceContext = { db: dbFor(dbB, accountId), accountId, userId: null, now: () => NOW, requestId: "b" };
  return { ctxA, ctxB, accountId, draftId: d!.id };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await ownedA.close(); await ownedB.close(); await sqlA.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a retry racing a submission that landed after the ceiling", () => {
  it("the late success wins and the retry offers NOTHING — one envelope, one delivery", async () => {
    const w = await seeded();
    const delivered: OutboundMessage[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });

    // The SLOW adapter: it takes the envelope, then waits — this is the submission that is still
    // in flight when its caller is answered.
    const slow: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage, opts?: SendOptions) {
        delivered.push(msg);
        await passReleaseGate(opts);
        await held;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* nothing to tear down */ },
    });
    // The RETRY's adapter. If the retry ever calls `send` on it, that is a second delivery to a
    // real person — the one outcome the whole reservation design exists to prevent.
    const retryAdapter: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage) {
        delivered.push(msg);
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* nothing to tear down */ },
    });

    // 1 — the press. The ceiling fires while the submission is mid-flight.
    const first = await new SendService().send(
      w.ctxA, w.draftId, "same-key", { openSendAdapter: slow, attemptCeilingMs: 60 },
    );
    expect(first.status, "an abandoned submission is an unknown fate, not an ending").toBe("queued");
    expect(delivered, "one envelope has been offered").toHaveLength(1);
    const [offered] = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(offered!.offerState, "the release gate committed before the server could answer, as in production").toBe("complete");

    // 2 — the impatient retry, under the SAME key, on a SECOND connection, while the first
    //     submission is still running. This is the whole race.
    const retryP = new SendService().send(
      w.ctxB, w.draftId, "same-key", { openSendAdapter: retryAdapter, attemptCeilingMs: 60 },
    );
    await sleep(50);

    // 3 — the first submission lands. Both writers are now live against one row.
    release();
    const retry = await retryP;
    await sleep(150); // let the late finalize commit

    expect(delivered, "THE RECIPIENT GOT IT TWICE").toHaveLength(1);
    expect(
      retry.status,
      "a reservation younger than the stale window may still have a live sender behind it",
    ).toBe("in_flight");

    const [row] = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status, "the late landing settles the row it reserved").toBe("sent");
    expect(row!.providerMessageId).toBe(row!.mintedMessageId);
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status, "and the draft's own flip is what /sync carries to the client").toBe("sent");
    expect(d!.sendKey, "a terminal outcome ends the bookkeeping").toBeNull();
  });

  it("two presses on ONE draft in the ceiling window reserve ONCE — the second is refused, not sent", async () => {
    const w = await seeded();
    const delivered: OutboundMessage[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const adapter = (): OpenSendAdapter => async () => ({
      async send(msg: OutboundMessage, opts?: SendOptions) {
        delivered.push(msg);
        await passReleaseGate(opts);
        await held;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* nothing */ },
    });

    // Two genuinely concurrent presses on two connections, each with its OWN key — the shape a
    // double-tap takes once the durable client lock is bypassed (a second tab, a scripted caller).
    // `drafts.status` is what arbitrates: `reserve` accepts only a `draft`, and the first press's
    // flip to `sending` is what the second one must lose to.
    const [a, b] = await Promise.allSettled([
      new SendService().send(w.ctxA, w.draftId, "key-a", { openSendAdapter: adapter(), attemptCeilingMs: 60 }),
      new SendService().send(w.ctxB, w.draftId, "key-b", { openSendAdapter: adapter(), attemptCeilingMs: 60 }),
    ]);
    release();
    await sleep(150);

    const outcomes = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : "refused"));
    expect(
      outcomes.filter((o) => o === "refused"),
      "both presses reserved: one draft was offered to the recipient twice",
    ).toHaveLength(1);
    expect(delivered, "THE RECIPIENT GOT IT TWICE").toHaveLength(1);

    const rows = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(rows, "one draft, one reservation").toHaveLength(1);
  });
});

/**
 * THE SAME RACE, FORCED BY GATES — the interleaving the sleeps above only sometimes reach (a nightly
 * run on a loaded host reached it): the client's own same-key replay holds the DRAFT row while the
 * late landing settles. A settle that took the reservation row first met that replay crosswise, and
 * Postgres killed one of them (40P01); when it killed the settle the delivered letter stayed
 * `pending` and its Sent copy was never filed.
 *
 * No table lock and no sleep decides the order. A third connection holds the RESERVATION row `FOR
 * KEY SHARE`: the replay's `SELECT … FOR UPDATE` of that row waits on it, with the draft row already
 * taken, while a settle's own UPDATE of the row (no key column) passes a key share. So the replay is
 * parked holding the draft, the 250 is released, the settle is seen waiting on the replay, and the
 * third connection commits. Each party's backends carry their own application name and are watched
 * in `pg_stat_activity`; a gate that is never reached fails the case.
 */
const sleep15 = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 15); });
const codeOf = (e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  return String(x?.code ?? x?.cause?.code ?? x?.message ?? e);
};

/**
 * One party of a race: a pool of the factory's under its own application name (a parameter of the
 * address is one of the connection), and every error a transaction of it ended on. The transaction
 * is read on the pool's handle and runs as the handle it was asked on, so a view bound to an
 * account opens its own bound transaction.
 */
function party(app: string) {
  const address = new URL(PG_TEST_URL);
  address.searchParams.set("application_name", app);
  const pool = makeOwnedDb(address.toString());
  const db = pool.db;
  const ended: string[] = [];
  const h = db as unknown as { transaction: (fn: unknown, ...rest: unknown[]) => Promise<unknown> };
  const inner = h.transaction;
  // A deadlock a caller swallows (the abandoned submission only logs) is still read here.
  Object.defineProperty(h, "transaction", {
    configurable: true, writable: true,
    value(this: unknown, fn: unknown, ...rest: unknown[]) {
      return inner.call(this, fn, ...rest).catch((e: unknown) => { ended.push(codeOf(e)); throw e; });
    },
  });
  return { app, pool, db, ended };
}

/** The statement a backend of `waiter` is blocked on by a backend of `holder`; null when it never is within `ms`. */
async function blockedOn(waiter: string, holder: string, ms = 15_000): Promise<string | null> {
  const end = Date.now() + ms;
  for (;;) {
    const rows = await sqlA<{ q: string }[]>`
      select w.query as q from pg_stat_activity w
       where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'
         and exists (select 1 from pg_stat_activity h
                      where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`;
    if (rows[0]) return rows[0].q.replace(/\s+/g, " ");
    if (Date.now() >= end) return null;
    await sleep15();
  }
}

/** Waits for `seen` to answer true, looking every 15 ms; false when it never does within `ms`. */
async function until(seen: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await seen()) return true;
    if (Date.now() >= end) return false;
    await sleep15();
  }
}

/**
 * A transport shaped as production's: the release gate is passed before the server can answer, the
 * answer can be held, and the Sent copy is the caller's to file (`copy: "caller"`), so `filed` says
 * whether it ever was. `messageInSent` answers from that folder.
 */
function heldTransport() {
  const state = { delivered: [] as OutboundMessage[], filed: [] as string[] };
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage, opts?: SendOptions) {
      state.delivered.push(msg);
      await passReleaseGate(opts);
      await held;
      return {
        providerMessageId: msg.messageId!,
        ...(opts?.copy === "caller" ? { unfiledCopy: Buffer.from("the sent copy") } : {}),
      };
    },
    async fileSentCopy(_raw: Buffer, messageId: string) { state.filed.push(messageId); return null; },
    async messageInSent(messageId: string) { return state.filed.includes(messageId); },
    async close() { /* nothing to tear down */ },
  });
  return { factory, state, release };
}

describe.skipIf(!PG_UP)("the late landing against its own replay, forced by gates", () => {
  it("the replay holds the draft while the late landing settles: nobody is killed, the letter ends sent, its copy is filed", async () => {
    const tag = randomUUID().slice(0, 8);
    const a = party(`ceil-press-${tag}`);
    const b = party(`ceil-replay-${tag}`);
    const third = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, connection: { application_name: `ceil-third-${tag}` } });
    let commitThird: () => void = () => {};
    try {
      const accountId = randomUUID();
      const [mb] = await dbA.insert(mailboxes).values({
        accountId, provider: "imap", address: `gate-${tag}@race.test`,
      }).returning();
      const [d] = await dbA.insert(drafts).values({
        accountId, mailboxId: mb!.id, subject: "the slow send", body: "words",
        to: [{ name: null, address: "you@example.com" }], status: "draft", createdAt: NOW, updatedAt: NOW,
      }).returning();
      const draftId = d!.id;
      const ctxA: ServiceContext = { db: dbFor(a.db, accountId), accountId, userId: null, now: () => NOW, requestId: "a" };
      const ctxB: ServiceContext = { db: dbFor(b.db, accountId), accountId, userId: null, now: () => NOW, requestId: "b" };
      const lines: string[] = [];
      const log = createLogger({ service: "send", sink: (line) => { lines.push(line); } });
      const abandoned = (): boolean => lines.some((l) => l.includes("send_abandoned_after_ceiling"));
      const slow = heldTransport();
      const replayTransport = heldTransport();
      const sends = new SendService();

      // 1 — the press. The ceiling answers while the server's 250 is still held.
      const first = await sends.send(ctxA, draftId, "same-key", { openSendAdapter: slow.factory, attemptCeilingMs: 60, log });
      expect(first.status).toBe("queued");
      const [reserved] = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
      expect(reserved!.offerState, "the row reads as production's does while the answer is held").toBe("complete");

      // 2 — a third connection takes the reservation row FOR KEY SHARE and keeps its transaction open.
      let thirdHolds!: () => void;
      const holding = new Promise<void>((r) => { thirdHolds = r; });
      const releaseThird = new Promise<void>((r) => { commitThird = r; });
      const thirdDone = third.begin(async (tx) => {
        await tx`select id from outbound_sends where id = ${reserved!.id} for key share`;
        thirdHolds();
        await releaseThird;
      });
      await holding;

      // 3 — the same-key replay, on its own connection. GATE: it waits on the third connection, at its
      //     locking read of the reservation row, with the draft row already taken.
      const replay = sends.send(ctxB, draftId, "same-key", { openSendAdapter: replayTransport.factory, attemptCeilingMs: 60, log })
        .then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
      const replayWaits = await blockedOn(b.app, `ceil-third-${tag}`);
      expect(replayWaits, "the replay never reached its read of the reservation row").toMatch(/from "outbound_sends".*for update/i);

      // 4 — the 250 lands. GATE: the settle waits on the replay.
      slow.release();
      const settleWaits = await blockedOn(a.app, b.app);
      expect(settleWaits, "the settle never met the replay").not.toBeNull();

      // 5 — the third connection commits at once.
      commitThird();
      await thirdDone;

      const answered = await replay;
      // The abandoned submission ends by itself: the row leaves `pending`, or its own handler logs.
      await until(async () => {
        const [r] = await dbA.select({ status: outboundSends.status }).from(outboundSends).where(eq(outboundSends.id, reserved!.id));
        return r!.status !== "pending" || abandoned();
      });

      expect([...a.ended, ...b.ended].filter((c) => c === "40P01"), "Postgres killed a party of the race").toEqual([]);
      expect(
        settleWaits,
        "the settle waits for the DRAFT row before it has taken the reservation row (the send path's lock order)",
      ).toMatch(/from "drafts".*for no key update/i);
      expect(answered.ok ? answered.v.status : `threw ${codeOf(answered.e)}`, "the replay is answered as a live attempt").toBe("in_flight");
      expect(abandoned(), "the late landing was abandoned instead of settled").toBe(false);
      const [row] = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
      expect(row!.status, "the late landing settles the row it reserved").toBe("sent");
      expect(row!.providerMessageId).toBe(row!.mintedMessageId);
      const [after] = await dbA.select().from(drafts).where(eq(drafts.id, draftId));
      expect(after!.status, "the draft's own flip is what /sync carries to the client").toBe("sent");
      expect(after!.sendKey).toBeNull();
      expect(await until(() => slow.state.filed.length > 0), "the Sent copy of the delivered letter was never filed").toBe(true);
      expect(slow.state.filed, "one copy, of this letter").toEqual([row!.mintedMessageId]);
      expect([...slow.state.delivered, ...replayTransport.state.delivered], "THE RECIPIENT GOT IT TWICE").toHaveLength(1);
    } finally {
      commitThird();
      await third.end({ timeout: 5 });
      await a.pool.close();
      await b.pool.close();
    }
  }, 60_000);
});
