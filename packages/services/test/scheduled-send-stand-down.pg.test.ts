import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import {
  changeLog, closeStoodDownAppointments, drafts, mailboxes, outboundSends, scheduledSendFiles,
  STAND_DOWN_SEND_SENTENCES,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { ScheduleService, runScheduledSendPass, sweepScheduledSendFiles } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE APPOINTMENT A HANDOVER ORPHANED — `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT WAS MEASURED, AND WHY NOTHING FAILED ────────────────────────────────────────────
 *
 * End to end on a real mailbox moved from a standalone install to a managed Cloud account. The
 * appointment was made on the standalone install (`send_at` twelve minutes out); the mailbox was
 * handed over; the standalone was relaunched past due, which is what a person opening their old
 * app does. It stood down (`organized_elsewhere:cloud`), `syncUntilQuiet()` returned **0 cycles**
 * on start and on four further polls, and `scheduled_send_pass` **was never emitted once** —
 * because `sendScheduled()` is inside `drain`, and `syncUntilQuiet` gates on `mayOrganize()`
 * BEFORE `drain`. Seventeen minutes past due the row was still `status:'scheduled'`,
 * `send_error: null`, unchanged, and the Drafts screen still read **"Sends Tue 14:50"** for a
 * time that had gone.
 *
 * Three facts compose it and each is individually reasonable:
 *
 *  1. The appointment lives in the ORGANIZER's own store and does not travel — the portable
 *     profile in `ohmail/_meta` carries screener entries, rules, notify rules, the away responder
 *     and tag names, and deliberately no per-message state and no drafts.
 *  2. The stood-down side cannot send it, correctly: a second organizer's SMTP on a mailbox
 *     somebody else holds is the thing the lease exists to prevent.
 *  3. `SCHEDULED_SEND_EXPIRY_MS` — the constant whose own comment says a quiet late delivery is
 *     worse than an honest failure the user can act on — is enforced INSIDE the unreachable pass.
 *     **An expiry enforced inside a pass that may never run is not an expiry.**
 *
 * So the failure is silent on both sides while the surface actively claims the opposite.
 *
 * ── WHAT THIS FILE PROVES ────────────────────────────────────────────────────────────────
 *
 * The mechanism, on real Postgres: the orphan reproduced exactly, the close that ends it, the
 * rows the close must NOT touch (a live claim, a reservation), the arbitration when a claim and a
 * stand-down race for one row on two connections, and the double-send boundary — after the close,
 * no pass on the old side can ever claim or deliver that appointment again.
 *
 * The BEHAVIOURAL half — the engine's gate actually calling this on the way down, and a
 * stood-down install closing its own on relaunch — is `apps/sidecar/test/scheduled-send-stand-down.test.ts`,
 * against the real engine on the PGlite store that IS production on that door. The STRUCTURAL
 * half — that no stand-down path anywhere can be added without this call — is
 * `packages/db/test/stand-down-sends-census.test.ts`.
 *
 * ## Why REAL Postgres (CLAUDE.md)
 * Two of the claims here are one connection blocking behind another's uncommitted transaction and
 * then re-evaluating its own predicate. PGlite is single-connection and cannot hold a lock against
 * anything, so it would report both as green without ever running them.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────
 *
 * Change `eq(drafts.status, "scheduled")` in `packages/db/src/stand-down-sends.ts` to include
 * `'draft'` and the reservation guards go red; delete the `sendKey: null` from its `set` and the
 * double-send boundary goes red (the pass claims the row again); delete the whole `update` and
 * the reproduction's AFTER half goes red with the row still lying; delete the mailbox
 * precondition and the deposed-leader guard goes red. All four were run.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");

const NOW = new Date("2026-09-01T12:00:00.000Z");
/** Twelve minutes out — the measurement's own interval. */
const DUE = new Date("2026-09-01T12:12:00.000Z");
/** Seventeen minutes past due — where the measurement read the row and found it lying. */
const PAST = new Date("2026-09-01T12:29:00.000Z");
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

interface World {
  ctx: ServiceContext;
  accountId: string;
  mailboxId: string;
  draftId: string;
}

/** An account with one mailbox and one appointment on it, twelve minutes out. */
async function seeded(opts: { at?: Date; files?: { filename: string; contentType: string; content: Buffer }[] } = {}): Promise<World> {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `moved-${tag}@handover.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the appointment", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbA, accountId, userId: null, now: () => NOW, requestId: "r" };
  await schedules.schedule(
    ctx, d!.id, (opts.at ?? DUE).toISOString(), opts.files ? { files: opts.files, surfaceMaxTotalBytes: null } : undefined,
  );
  return { ctx, accountId, mailboxId: mb!.id, draftId: d!.id };
}

const rowOf = async (id: string) => {
  const [row] = await dbA.select().from(drafts).where(eq(drafts.id, id));
  return row!;
};

/**
 * THE STAND-DOWN'S OTHER HALF, as the organizer writes it. The appointment close is deliberately
 * NOT folded into this — see `closeStoodDownAppointments`' header — so the tests below call the
 * two in the order the gate does.
 *
 * ── MAIL 0083: THE ROLE, NOT THE STATUS ────────────────────────────────────────────────────
 *
 * This wrote `status: 'disabled'` + `disabled_reason`, because that pair WAS a stand-down. A
 * loser is now a READER — `organizer_role = 'reader'`, `status` untouched, `disabled_reason`
 * gaining no writer — and the fixture has to write what the product writes or the tests below
 * prove something about a state nothing produces. `close`'s precondition moved with it.
 *
 * The holder columns ride along because the real write does: `markMailboxStoodDown` and the
 * sidecar's inline write both name who took the mailbox in the same statement that demotes.
 */
const standDownRow = async (mailboxId: string, reason: string): Promise<void> => {
  await dbA.update(mailboxes)
    .set({
      organizerRole: "reader",
      organizedByKind: reason.split(":")[1] ?? "unknown",
      organizedByName: "another machine",
      organizedSince: new Date(),
      organizerState: "held",
      takeoverAuthorizedAt: null,
    })
    .where(eq(mailboxes.id, mailboxId));
};

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a handover orphans a pending scheduled send", () => {
  it("REPRODUCES the measurement — the stood-down side runs no pass, and the row lies for ever", async () => {
    const w = await seeded();
    const fake = fakeAdapter();

    // The handover. The mailbox is now organized elsewhere and this side's gate says no, so
    // `drain` — and with it `sendScheduled()` — is unreachable from here on. NOT running the pass
    // below is not an omission in this test: it IS the defect, and running one would be testing a
    // code path the stood-down install provably cannot enter.
    await standDownRow(w.mailboxId, "organized_elsewhere:cloud");

    // Seventeen minutes past due, exactly as measured: still `scheduled`, still no sentence.
    const before = await rowOf(w.draftId);
    expect(before.status, "the pre-fix state is the point of this arm").toBe("scheduled");
    expect(before.sendError).toBeNull();
    expect(before.sendAt!.getTime()).toBeLessThan(PAST.getTime());
    expect(before.sendKey).not.toBeNull();
    // And nothing was delivered, because nothing ran.
    expect(fake.state.delivered).toHaveLength(0);

    // ── THE FIX ────────────────────────────────────────────────────────────────────────────
    const closed = await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:cloud", now: PAST,
    });
    expect(closed.closed).toBe(1);
    expect(closed.draftIds).toEqual([w.draftId]);

    const after = await rowOf(w.draftId);
    // An ordinary draft again, carrying the sentence the Drafts row quotes. `status:'draft'` +
    // `send_error` is EXACTLY the shape the send-window contract already defines for an
    // appointment that could not be kept, so both clients render it with copy they already have:
    // the webapp's `scheduleFailedNote` under the Drafts list, and the phone's Scheduled screen,
    // which lists a `sendError` draft beside the standing ones because it has no Drafts screen.
    expect(after.status).toBe("draft");
    expect(after.sendAt, "an appointment that will not be kept must not still name a time").toBeNull();
    expect(after.sendKey, "the key is the claim predicate — leaving it is leaving the appointment").toBeNull();
    expect(after.sendError).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]);
    // The sentence a person actually reads, composed as the clients compose it. It says what
    // happened, in the past tense, and what to do — and it names no destination, because the
    // mailbox can come back to this install afterwards and a stored sentence outlives its own
    // occasion.
    expect(`This message wasn't sent at its scheduled time: ${after.sendError!}`).toBe(
      "This message wasn't sent at its scheduled time: ohmail Cloud took over organizing this "
      + "mailbox, so the scheduled send was not made here. Schedule it again where the mailbox "
      + "is organized now.",
    );

    // The mirrors learn it as an ordinary draft update — without this the phone and the webapp
    // would both go on rendering the appointment until something else touched the row.
    const changes = await dbA.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, w.draftId)));
    expect(changes.some((c) => c.entityType === "draft" && c.op === "update")).toBe(true);
  });

  it("THE DOUBLE-SEND BOUNDARY — a closed appointment can never be claimed or delivered again", async () => {
    const w = await seeded();
    await standDownRow(w.mailboxId, "organized_elsewhere:cloud");
    await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:cloud", now: PAST,
    });

    // The old organizer, somehow running a pass anyway — a reclaim, an operator, a second
    // process. Both claim arms require a standing `send_key`, and the close cleared it, so there
    // is nothing here to find however late the pass runs.
    const fake = fakeAdapter();
    await runScheduledSendPass(dbA, {
      openSendAdapter: fake.factory,
      now: () => new Date(DUE.getTime() + 48 * 60 * 60 * 1000),
    });
    const row = await rowOf(w.draftId);
    expect(row.status).toBe("draft");
    expect(row.sendAt).toBeNull();
    // ── THE ASSERTION IS THE RESERVATION, NOT THE ADAPTER'S COUNTER ────────────────────────
    //
    // Scoped to THIS account, because the pass is global and the shared :5433 database carries
    // other runs' residue rows, which the pass legitimately claims: a bare `delivered === 0` here
    // is an assertion about other tests' leftovers and it fails on a busy database (it did).
    // The reservation is the strictly precise substitute rather than a weaker one — `reserve`
    // commits an `outbound_sends` row BEFORE any SMTP dial, so zero reservations on this account
    // is proof no send for it was even attempted, and it stays red under the mutation that
    // matters (leave `send_key` standing and the claim finds the row and reserves).
    const reservations = await dbA.select().from(outboundSends)
      .where(eq(outboundSends.accountId, w.accountId));
    expect(reservations, "a closed appointment minted a reservation").toHaveLength(0);
  });

  it("WITH FILES (mail 0179) — the closed appointment's files are swept, its count stays, nothing is sent", async () => {
    const w = await seeded({ files: [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") }] });
    await standDownRow(w.mailboxId, "organized_elsewhere:cloud");
    await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId, reason: "organized_elsewhere:cloud", now: PAST,
    });
    const files = () => dbA.select().from(scheduledSendFiles).where(eq(scheduledSendFiles.draftId, w.draftId));
    expect(await files(), "the close itself leaves the bytes to the sweep").toHaveLength(1);
    await sweepScheduledSendFiles(dbA, { mailboxIds: [w.mailboxId] });
    expect(await files()).toHaveLength(0);
    expect(await rowOf(w.draftId)).toMatchObject({ status: "draft", sendKey: null, sendFiles: 1 });
    await runScheduledSendPass(dbA, { openSendAdapter: fakeAdapter().factory, now: () => new Date(DUE.getTime() + 60_000) });
    expect(await dbA.select().from(outboundSends).where(eq(outboundSends.accountId, w.accountId))).toHaveLength(0);
  });

  it("THE NEW ORGANIZER DOES NOT ADOPT IT — the appointment is closed on one side and absent on the other", async () => {
    // The other half of the boundary, and the reason option (a) has no double-send surface at
    // all: nothing carries the appointment across. The row is in the old organizer's store, keyed
    // to the old organizer's mailbox id, and the new organizer's claim scan is over ITS OWN
    // account's drafts. Here that is two accounts against one physical mailbox address, which is
    // exactly what a handover produces.
    const old = await seeded();
    const fresh = await (async () => {
      const accountId = randomUUID();
      const [mb] = await dbA.insert(mailboxes).values({
        accountId, provider: "imap", address: "adopted@handover.test",
      }).returning();
      return { accountId, mailboxId: mb!.id };
    })();

    await standDownRow(old.mailboxId, "organized_elsewhere:cloud");
    await closeStoodDownAppointments(dbA, {
      accountId: old.accountId, mailboxId: old.mailboxId,
      reason: "organized_elsewhere:cloud", now: PAST,
    });

    // The new organizer holds no appointment for that message — there is no code path anywhere
    // that appends a draft to a mailbox or writes one into the portable profile, so a handover
    // moves configuration and never an outbox.
    const adopted = await dbA.select().from(drafts)
      .where(eq(drafts.accountId, fresh.accountId));
    expect(adopted, "the new organizer adopted an appointment it must not have").toHaveLength(0);
  });

  it("REFUSES on a mailbox that is not stood down — the deposed leader's guard", async () => {
    // The close is unfenced (see `closeStoodDownAppointments`), so this read is what stands in
    // for the fence. Cloud's `markMailboxStoodDown` is FENCED: an instance that read a stand-down
    // verdict and then lost the shard has its lifecycle write refused. Without this precondition
    // its close would still land, and a deposed leader would cancel an appointment the successor
    // had legitimately accepted after re-organizing the mailbox.
    const w = await seeded();
    // The mailbox is CONNECTED — the successor re-organized it, or the fence refused the write.
    const closed = await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:cloud", now: PAST,
    });
    expect(closed.closed, "a process whose stand-down is not on the row cancelled an appointment")
      .toBe(0);
    const row = await rowOf(w.draftId);
    expect(row.status).toBe("scheduled");
    expect(row.sendError).toBeNull();
  });

  it("REFUSES on a REMOVAL — a tombstone keeps its role, so it is not a handover", async () => {
    // A removal DEMOTES NOTHING: it retires the row, which keeps `organizer_role = 'organizer'`
    // and takes `status` to `disabled`. Since mail 0083 that is what makes the two preconditions
    // disjoint on a column each rather than on two readings of one — and it is the sharper test,
    // because a removal now fails this close on the ROLE, before `status` is consulted at all.
    // A removal's drafts belong to a row the user deleted; writing a handover sentence onto them
    // would explain something that did not happen (`closeRemovedMailboxAppointments` serves it,
    // with its own sentence).
    const w = await seeded();
    await dbA.update(mailboxes)
      .set({ status: "disabled", disabledReason: null })
      .where(eq(mailboxes.id, w.mailboxId));
    const closed = await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:cloud", now: PAST,
    });
    expect(closed.closed).toBe(0);
    expect((await rowOf(w.draftId)).status).toBe("scheduled");
  });

  it("leaves the CLAIM WINDOW alone: a row a pass is already sending is not this function's", async () => {
    const w = await seeded();
    await standDownRow(w.mailboxId, "organized_elsewhere:local");
    // Exactly what `claimDue` commits: the row leaves 'scheduled' for the claim window, with
    // `send_at` and `send_key` standing as the recovery predicate.
    await dbA.update(drafts).set({ status: "draft" }).where(eq(drafts.id, w.draftId));

    const closed = await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:local", now: PAST,
    });
    expect(closed.closed, "the close took a row a live send owns").toBe(0);
    const row = await rowOf(w.draftId);
    expect(row.sendKey, "clearing the key here strands the retry that replays it").not.toBeNull();
    expect(row.sendAt).not.toBeNull();
    expect(row.sendError).toBeNull();
  });

  it("leaves a RESERVATION alone: a 'sending' row belongs to the reservation machinery", async () => {
    const w = await seeded();
    await standDownRow(w.mailboxId, "organized_elsewhere:local");
    await dbA.update(drafts).set({ status: "sending" }).where(eq(drafts.id, w.draftId));

    const closed = await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:local", now: PAST,
    });
    expect(closed.closed).toBe(0);
    const row = await rowOf(w.draftId);
    expect(row.status).toBe("sending");
    expect(row.sendKey, "a pending reservation is resolved by this key; clearing it strands the "
      + "stuck-send alarm on a row nothing can finish").not.toBeNull();
  });

  it("is scoped to the mailbox that stood down — another mailbox's appointment stands", async () => {
    const w = await seeded();
    const [other] = await dbA.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: "second@handover.test",
    }).returning();
    const [d2] = await dbA.insert(drafts).values({
      accountId: w.accountId, mailboxId: other!.id, subject: "the other one", body: "words",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
      createdAt: NOW, updatedAt: NOW,
    }).returning();
    await schedules.schedule(w.ctx, d2!.id, DUE.toISOString());
    // Only the FIRST mailbox stands down. The second stays connected, which is also what makes
    // the close's own mailbox precondition irrelevant to this claim: the scoping is the account
    // and mailbox predicates, not the status read.
    await standDownRow(w.mailboxId, "organized_elsewhere:local");

    await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:local", now: PAST,
    });

    expect((await rowOf(w.draftId)).status).toBe("draft");
    const untouched = await rowOf(d2!.id);
    expect(untouched.status, "one mailbox standing down closed another mailbox's appointment")
      .toBe("scheduled");
    expect(untouched.sendError).toBeNull();
  });

  it("a CLAIM already holding the row wins: the close waits, re-evaluates, and takes nothing", async () => {
    // The interleaving PGlite structurally cannot run. A stand-down landing while an invocation is
    // mid-claim must not cut the ground from under a send that was legitimate when it started —
    // the organizer still held the mailbox at claim time.
    const w = await seeded();
    await standDownRow(w.mailboxId, "organized_elsewhere:cloud");

    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const claimTx = sqlB.begin(async (tx) => {
      await tx`update drafts set status = 'draft', updated_at = now()
               where id = ${w.draftId} and status = 'scheduled'`;
      await held;
    });
    await sleep(150); // let the claim take its row lock

    let settledEarly = false;
    const closeP = closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:cloud", now: PAST,
    }).then((r) => { settledEarly = true; return r; });
    await sleep(300);
    expect(settledEarly,
      "the close answered from a snapshot the claim's lock should have held back").toBe(false);

    releaseLock();
    await claimTx;
    const result = await closeP;

    expect(result.closed, "the close overruled a claim that already owned the row").toBe(0);
    const row = await rowOf(w.draftId);
    expect(row.sendKey).not.toBeNull();
    expect(row.sendError).toBeNull();
  });

  it("a claim behind a COMMITTED close finds nothing — the appointment is over before it looks", async () => {
    // The mirror image, and the direction that matters for the invariant: once the close commits,
    // no later pass — on this side or a reclaimed one — can resurrect the appointment.
    const w = await seeded();
    await standDownRow(w.mailboxId, "organized_elsewhere:local");
    await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:local", now: PAST,
    });

    const fake = fakeAdapter();
    await runScheduledSendPass(dbA, {
      openSendAdapter: fake.factory, now: () => new Date(DUE.getTime() + 60_000),
    });
    // Account-scoped for the reason the test above states in full: this pass is global and the
    // shared database holds other runs' due rows.
    expect(await dbA.select().from(outboundSends).where(eq(outboundSends.accountId, w.accountId)),
      "a closed appointment was claimed and reserved by a later pass").toHaveLength(0);
    expect((await rowOf(w.draftId)).status).toBe("draft");
    expect((await rowOf(w.draftId)).sendKey).toBeNull();
  });
});
