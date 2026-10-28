import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, lt, lte } from "drizzle-orm";
import { drafts, mailboxes, outboundSends, outboundSentCopies } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import { SendService, runSendReconcilePass, runOwedSentCopyPass, SEND_STALE_AFTER_MS } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * TWO RESOLVERS, ONE STRANDED RESERVATION — the reconciling pass racing the client's own
 * same-key retry, on real Postgres.
 *
 * ## Why this file exists at all
 *
 * Before the pass, `resumeExisting` was the ONLY thing that resolved a stale reservation, so
 * "exactly one resolver" was true by construction and the finalizers needed no predicate: both
 * wrote `UPDATE outbound_sends SET status = … WHERE id = $1`, unconditionally. The pass makes a
 * second resolver real, and those two statements then race — with `unverified` able to land on
 * top of `sent`, which is the worst write in this codebase: a message the person demonstrably
 * sent, recorded as one we could not confirm, with the reader told to go and look for it in a
 * folder it is already in.
 *
 * ## Why REAL Postgres, and not PGlite (CLAUDE.md)
 *
 * PGlite is ONE connection. The interleaving under test — a probe in flight on connection A
 * while connection B commits a terminal state — cannot occur there at all, so a green run would
 * mean nothing. Three production bugs were invisible to it and every one was this class. The
 * single-connection half of this story is in `send-reconcile.test.ts`; the overlap is here.
 *
 * ## What must be true, in the reader's terms
 *
 * Whatever order the two land in: the recipient's mailbox is untouched (neither resolver may
 * ever offer an envelope), the reservation ends in exactly ONE terminal state, that state is the
 * first one written, and the loser reports it rather than inventing a second answer.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-09-02T12:00:00.000Z");
const MIN = 60_000;
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * A STRANDED RESERVATION eleven minutes old: `outbound_sends` `pending`, its draft at `sending`,
 * with the send key still standing. Exactly the wreckage a killed invocation leaves.
 */
async function stranded(): Promise<{
  accountId: string; draftId: string; sendId: string; minted: string;
  mailboxId: string; key: string; ctxB: ServiceContext;
}> {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const at = new Date(NOW.getTime() - 11 * MIN);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `rec-${tag}@race.test`, status: "connected",
  }).returning();
  const key = `stranded-${tag}`;
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the stranded one", body: "words",
    to: [{ name: null, address: "you@example.com" }],
    status: "sending", sendKey: key, createdAt: at, updatedAt: at,
  }).returning();
  const minted = `<${randomUUID()}@race.test>`;
  const [s] = await dbA.insert(outboundSends).values({
    accountId, idempotencyKey: key, draftId: d!.id, mintedMessageId: minted,
    status: "pending", createdAt: at,
  }).returning();
  // The RETRY arrives on its own connection, the way a second HTTP request does.
  const ctxB: ServiceContext = { db: dbB, accountId, userId: null, now: () => NOW, requestId: "b" };
  return { accountId, draftId: d!.id, sendId: s!.id, minted, mailboxId: mb!.id, key, ctxB };
}

/** An adapter that answers `inSent` after `holdMs`, and records any envelope it is offered. */
function probeAfter(
  inSent: boolean, holdMs: number, delivered: OutboundMessage[],
): OpenSendAdapter {
  return async () => ({
    async send(msg: OutboundMessage) {
      delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { await sleep(holdMs); return inSent; },
    async close() { /* nothing to tear down */ },
  });
}

const rowOf = async (sendId: string) =>
  (await dbA.select().from(outboundSends).where(eq(outboundSends.id, sendId)))[0]!;

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

/**
 * EMPTY THE PASS'S CANDIDATE WINDOW BEFORE EACH TEST.
 *
 * The real Postgres instance is shared across every test in this file (and every other pg suite
 * in the run), and this pass selects by AGE ALONE — deliberately, since a stranded row belongs to
 * no account the pass knows about in advance. So without this, the second test's poke claims the
 * first test's leftovers and `claimed` counts them: the first run of this file read
 * `expected 3 to be 1`, which looks like a defect in the batch and is actually the fixture.
 *
 * Scoped to exactly what the pass would take — rows already past `SEND_STALE_AFTER_MS` — rather
 * than truncating the table, so a fresh reservation another suite is mid-way through is left
 * alone.
 */
beforeEach(async () => {
  if (!PG_UP) return;
  await dbA.delete(outboundSends)
    .where(lt(outboundSends.createdAt, new Date(NOW.getTime() - SEND_STALE_AFTER_MS)));
});

describe.skipIf(!PG_UP)("the reconciling pass racing the client's own retry", () => {
  /**
   * THE CRUX. The pass probes, finds nothing, and is about to write `unverified`; meanwhile the
   * client's retry probes on its own connection, DOES find the message, and writes `sent`.
   *
   * Without `AND status = 'pending'` on `finalizeUnverified`, the pass's write lands second and
   * unconditionally — turning a delivered message into an unconfirmed one. The timing that makes
   * it happen is ordinary: the pass holds a slower connection than the retry, which is the usual
   * case for a batch probe against a live request.
   */
  it("a LATE `unverified` cannot overwrite `sent` — the compare-and-swap is what stops it", async () => {
    const w = await stranded();
    const delivered: OutboundMessage[] = [];

    // The pass's probe is SLOW and answers "not in Sent".
    const passRun = runSendReconcilePass(dbA, {
      openSendAdapter: probeAfter(false, 300, delivered),
      now: () => NOW,
    });
    // …and 60 ms later the client's retry probes fast and DOES find it, finalizing `sent`.
    await sleep(60);
    const retry = await new SendService().send(w.ctxB, w.draftId, w.key, {
      openSendAdapter: probeAfter(true, 0, delivered),
    });
    const passResult = await passRun;

    expect(delivered, "NEITHER RESOLVER MAY OFFER AN ENVELOPE").toEqual([]);
    expect(retry.status, "the retry found the message in Sent").toBe("sent");

    const row = await rowOf(w.sendId);
    expect(row.status, "the pass's late `unverified` was refused").toBe("sent");
    expect(row.providerMessageId).toBe(w.minted);

    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status, "and the draft carries the same one terminal state").toBe("sent");
    expect(d!.sendKey, "a terminal outcome ends the bookkeeping").toBeNull();

    // THE LOSER ANSWERS THE WINNER'S STATE, and counts itself as such: not `unverified`, not a
    // second probe, and never a state it did not write.
    expect(passResult.claimed).toBe(1);
    expect(passResult.resolvedElsewhere).toBe(1);
    expect(passResult.unverified).toBe(0);
    expect(passResult.sent).toBe(0);
  }, 60_000);

  /**
   * THE SAME RACE, ARMS SWAPPED — the pass wins with `sent` and the client's retry arrives after.
   * The retry must report the state the pass wrote, not a fresh probe's opinion of it, and must
   * certainly not resend.
   */
  it("a retry arriving AFTER the pass settled reports the pass's answer and sends nothing", async () => {
    const w = await stranded();
    const delivered: OutboundMessage[] = [];

    const passResult = await runSendReconcilePass(dbA, {
      openSendAdapter: probeAfter(true, 0, delivered),
      now: () => NOW,
    });
    expect(passResult.sent).toBe(1);

    // The person comes back to the tab minutes later and their durable key replays.
    const retry = await new SendService().send(w.ctxB, w.draftId, w.key, {
      openSendAdapter: probeAfter(false, 0, delivered),
    });

    expect(delivered, "the replay must never resend").toEqual([]);
    expect(retry.status, "it replays the stored terminal result").toBe("sent");
    expect(retry.providerMessageId).toBe(w.minted);
    expect((await rowOf(w.sendId)).status).toBe("sent");
  }, 60_000);

  /**
   * TWO POKES OF THE PASS OVERLAPPING — the shape a rolling deploy produces, and the one the
   * claim's `SKIP LOCKED` cannot fully arbitrate because this claim writes nothing. The point is
   * that it does not have to: two probes are a cost, two writes would be a defect.
   */
  it("two overlapping pokes cost a duplicate probe and write exactly one terminal state", async () => {
    const w = await stranded();
    const delivered: OutboundMessage[] = [];
    let probes = 0;
    const counting: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: "x" }; },
      async messageInSent() { probes += 1; await sleep(120); return false; },
      async close() { /* nothing */ },
    });

    const [a, b] = await Promise.all([
      runSendReconcilePass(dbA, { openSendAdapter: counting, now: () => NOW }),
      runSendReconcilePass(dbB, { openSendAdapter: counting, now: () => NOW }),
    ]);

    expect(delivered, "no envelope, on either poke").toEqual([]);
    expect(probes, "the duplicate probe is the cost, and it is bounded by the batch")
      .toBeLessThanOrEqual(2);
    // Exactly one poke wrote the state; the other either skipped the locked row or lost the CAS.
    expect(a.unverified + b.unverified, "one writer").toBe(1);
    expect((await rowOf(w.sendId)).status).toBe("unverified");
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("unverified");
  }, 60_000);

  /**
   * THE CLAIM DOES NOT LOCK `mailboxes`, AND THIS TESTS IT RATHER THAN ASSERTING IT.
   *
   * The selection joins `drafts` and `mailboxes` to read the mailbox's status, and a bare
   * `FOR UPDATE` in Postgres locks rows from EVERY table in the FROM list — so it would take a
   * row lock on `mailboxes` for a read it makes no use of. `finalizeSent`'s doorbell note is the
   * standing rule against that: by the time a finalize runs THE MESSAGE HAS ALREADY LEFT, and an
   * update of the mailbox row that waits on somebody else's lock strands a delivered message in
   * no terminal state at all. `MailboxService.delete` and the disabler both take a genuine
   * `FOR UPDATE` on that row.
   *
   * The code says `FOR UPDATE OF outbound_sends SKIP LOCKED`, and the comment beside it explains
   * why. A comment is the claim under test, not evidence for it — so this drives the difference:
   * hold a real lock on the mailbox row from another connection and the pass must still claim and
   * resolve the reservation. With the `OF` dropped, `SKIP LOCKED` skips the joined row instead
   * and the pass silently claims NOTHING — the shape where a guard stays green because the work
   * quietly stopped happening.
   */
  it("claims and resolves while another connection holds the mailbox row locked", async () => {
    const w = await stranded();
    const delivered: OutboundMessage[] = [];

    // Connection B takes the lock the disabler and the deleter take, and HOLDS it.
    let releaseLock!: () => void;
    const holding = new Promise<void>((r) => { releaseLock = r; });
    const locked = dbB.transaction(async (tx) => {
      await tx.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId)).for("update");
      await holding;
    });
    await sleep(80); // let the lock be taken before the pass looks

    try {
      const r = await runSendReconcilePass(dbA, {
        openSendAdapter: probeAfter(true, 0, delivered),
        now: () => NOW,
      });
      expect(r.claimed, "the held mailbox lock made the pass skip its own row").toBe(1);
      expect(r.sent).toBe(1);
      expect((await rowOf(w.sendId)).status).toBe("sent");
      expect(delivered).toEqual([]);
    } finally {
      releaseLock();
      await locked;
    }
  }, 60_000);

  /**
   * THE DRAFT'S OWN COMPARE-AND-SWAP, which is a separate question from the reservation's: a
   * draft that has already left `sending` must not be dragged back by a finalize that arrives
   * afterwards, even though the reservation itself is still the pass's to close.
   */
  it("a draft recovered out of `sending` keeps its state while the reservation is still closed", async () => {
    const w = await stranded();
    const delivered: OutboundMessage[] = [];
    // Somebody (or something) put the draft back to `draft` while the reservation stood.
    await dbB.update(drafts).set({ status: "draft" }).where(eq(drafts.id, w.draftId));

    const r = await runSendReconcilePass(dbA, {
      openSendAdapter: probeAfter(true, 0, delivered),
      now: () => NOW,
    });

    expect(r.sent, "the reservation stops paging the stuck-send alarm").toBe(1);
    expect((await rowOf(w.sendId)).status).toBe("sent");
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status, "but the draft is left exactly where it was found").toBe("draft");
    expect(delivered).toEqual([]);
  }, 60_000);
});

describe.skipIf(!PG_UP)("two late Sent-copy passes over one owed copy", () => {
  beforeEach(async () => {
    await dbA.delete(outboundSentCopies).where(lte(outboundSentCopies.nextAttemptAt, NOW));
  });

  it("one dial and one APPEND, whichever claims first", async () => {
    const accountId = randomUUID();
    const tag = randomUUID().slice(0, 8);
    const [mb] = await dbA.insert(mailboxes).values({
      accountId, provider: "imap", address: `owed-${tag}@race.test`, status: "connected",
    }).returning();
    const minted = `<${randomUUID()}@race.test>`;
    const [s] = await dbA.insert(outboundSends).values({
      accountId, idempotencyKey: `owed-${tag}`, mintedMessageId: minted, providerMessageId: minted, status: "sent",
    }).returning();
    await dbA.insert(outboundSentCopies).values({
      sendId: s!.id, accountId, mailboxId: mb!.id, rawB64: Buffer.from(`Message-ID: ${minted}\r\n\r\nhi\r\n`).toString("base64"),
      nextAttemptAt: NOW,
    });
    const folder: string[] = [];
    const seen = { dials: 0, appends: 0, sends: 0 };
    const open: OpenSendAdapter = async () => {
      seen.dials += 1;
      return {
        async send() { seen.sends += 1; return { providerMessageId: "x" }; },
        async messageInSent(id: string) { return folder.includes(id); },
        async fileSentCopy(raw: Buffer, id: string, o?: { look?: boolean }) {
          if (o?.look && folder.includes(id)) return null;
          await sleep(200);
          seen.appends += 1;
          folder.push(id);
          return null;
        },
        async close() { /* nothing held */ },
      };
    };
    const pass = (db: typeof dbA) => runOwedSentCopyPass(db, {
      openSendAdapter: open, resolveStorageCap: async () => UNMETERED_STORAGE_CAP, sends: new SendService(), now: () => NOW,
    });
    const [a, b] = await Promise.all([pass(dbA), pass(dbB)]);
    expect(a.filed + b.filed).toBe(1);
    expect(seen).toEqual({ dials: 1, appends: 1, sends: 0 });
    expect(folder).toEqual([minted]);
    expect(await dbA.select().from(outboundSentCopies).where(eq(outboundSentCopies.sendId, s!.id))).toEqual([]);
  }, 60_000);
});
