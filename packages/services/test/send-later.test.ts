import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  changeLog, drafts, mailboxes, outboundSends, outboundSendFingerprints,
} from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  DraftsService, ScheduleService, SendService, ServiceError, runScheduledSendPass,
  SCHEDULE_MAX_AHEAD_MS,
  SCHEDULED_SEND_EXPIRY_MS, SEND_FAILED_SENTENCE, SEND_STALE_AFTER_MS,
  SEND_DUPLICATE_WINDOW_MS,
} from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * SEND LATER (mail 0077) — the schedule verbs and the pass, one interleaving at a time.
 *
 * Everything here is single-connection PGlite; the two orderings that need a genuinely HELD
 * cross-connection row lock (cancel racing the worker's claim) live in
 * `send-later-claim-race.pg.test.ts` on :5433, per the house rule that PGlite green means
 * nothing for transactional code.
 */

const schedules = new ScheduleService();
const draftsSvc = new DraftsService();
const sends = new SendService();

const NOW = new Date("2026-08-28T12:00:00.000Z");
const AT = new Date("2026-08-28T18:00:00.000Z"); // this evening — comfortably future
const iso = (d: Date): string => d.toISOString();

/**
 * A fake SendAdapter — no network. Counts deliveries; `inSent` drives the recovery probe.
 *
 * The three failure injections are at three DIFFERENT points, and the difference is the whole
 * subject of the post-reservation tests below:
 *   `failWith`     the FACTORY refuses — nothing was offered to any server, so the fate is KNOWN.
 *   `sendThrows`   `adapter.send` throws — the envelope went out; the fate is UNKNOWN.
 *   `probeThrows`  the verify-by-Sent probe throws too, so the unknown fate STAYS unknown.
 */
function fakeAdapter(opts: {
  failWith?: () => Error; inSent?: boolean;
  sendThrows?: () => Error; probeThrows?: () => Error;
} = {}) {
  const state = { opened: [] as string[], delivered: [] as OutboundMessage[], probes: 0 };
  const factory: OpenSendAdapter = async (mailboxId: string) => {
    if (opts.failWith) throw opts.failWith();
    return {
      async send(msg: OutboundMessage) {
        state.opened.push(mailboxId);
        if (opts.sendThrows) throw opts.sendThrows();
        state.delivered.push(msg);
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() {
        state.probes += 1;
        if (opts.probeThrows) throw opts.probeThrows();
        return opts.inSent ?? false;
      },
      async close() { /* nothing to tear down */ },
    };
  };
  return { factory, state };
}

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId: A, provider: "imap", address: "me@later.test",
  }).returning();
  const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => NOW, requestId: "r" };
  const { draft } = await draftsSvc.create(ctx, {
    mailboxId: mb!.id, subject: "later", body: "the words",
    to: [{ name: null, address: "you@example.com" }],
  });
  return { db, A, mb: mb!.id, ctx, draftId: draft.id };
}

describe("ScheduleService.schedule", () => {
  it("puts the appointment on the draft: status, send_at, a minted key, the DTO — and NO reservation", async () => {
    const { db, ctx, draftId } = await setup();
    const { draft, seq } = await schedules.schedule(ctx, draftId, iso(AT));
    expect(draft.status).toBe("scheduled");
    expect(draft.sendAt).toBe(iso(AT));
    expect(draft.sendError).toBeNull();
    expect(seq).toBeGreaterThan(0);

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.sendKey).toMatch(/^[0-9a-f-]{36}$/);
    // `send_key` never reaches a client — it is the send's Idempotency-Key.
    expect("sendKey" in draft).toBe(false);

    // THE ALARM'S INVARIANT, by construction: no `outbound_sends` row exists until the
    // appointment is due, so `sends_stuck` (status='pending' older than 10m) cannot see a
    // deliberately future send. This line is what makes that a measured claim.
    const reservations = await db.select().from(outboundSends);
    expect(reservations).toHaveLength(0);
  });

  it("refuses a date that does not exist and a time in no zone BY NAME — never sends on another day", async () => {
    /* `Date.parse` rolled "2027-02-30" into March 2 and read an
       offset-less time in the server's zone: an appointment at a moment the person never chose.
       THE MUTATION THAT MAKES THIS RED: in `instant.ts#readInstant`, drop the `day > daysIn(...)`
       bound — the first refusal turns into a scheduled draft for March 2. Watched fail and restored. */
    const { db, ctx, draftId } = await setup();
    await expect(schedules.schedule(ctx, draftId, "2027-02-30T10:00:00Z"))
      .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed", message: "sendAt is not a date" });
    await expect(schedules.schedule(ctx, draftId, "2027-03-01T10:00:00"))
      .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed", message: expect.stringMatching(/^sendAt is not a moment in time/) });
    // NOTHING WAS MARKED: the draft is still an ordinary draft with no appointment.
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.status).toBe("draft");
    expect(row!.sendAt).toBeNull();
    // The positive control: a real instant on the same draft is accepted.
    const { draft } = await schedules.schedule(ctx, draftId, iso(AT));
    expect(draft.status).toBe("scheduled");
    expect(draft.sendAt).toBe(iso(AT));
  });

  it("refuses a past time, a time beyond a year, and an empty envelope — before anything is marked", async () => {
    const { ctx, draftId } = await setup();
    await expect(schedules.schedule(ctx, draftId, iso(new Date(NOW.getTime() - 1000))))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(schedules.schedule(ctx, draftId, iso(new Date(NOW.getTime() + SCHEDULE_MAX_AHEAD_MS + 1000))))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(schedules.schedule(ctx, draftId, "not a time"))
      .rejects.toMatchObject({ httpStatus: 400 });

    // No recipients ⇒ 400 with the send path's own sentence.
    const { ctx: ctx2, mb: mb2 } = await setup();
    const empty = await draftsSvc.create(ctx2, { mailboxId: mb2, subject: "s", body: "b" });
    await expect(schedules.schedule(ctx2, empty.draft.id, iso(AT)))
      .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
  });

  it("refuses a disabled mailbox at schedule time (the user is present to fix it)", async () => {
    const { db, ctx, mb, draftId } = await setup();
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mb));
    await expect(schedules.schedule(ctx, draftId, iso(AT)))
      .rejects.toMatchObject({ httpStatus: 409, code: "mailbox_disabled" });
  });

  it("re-scheduling moves the time and mints a FRESH key; a claim-window row refuses", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const [first] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    const later = new Date(AT.getTime() + 60 * 60 * 1000);
    await schedules.schedule(ctx, draftId, iso(later));
    const [second] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(second!.sendAt!.toISOString()).toBe(iso(later));
    expect(second!.sendKey).not.toBe(first!.sendKey);

    // The worker's claim window: status back to 'draft' with `send_at` standing. A second
    // appointment over a send that is happening would be a second delivery.
    await db.update(drafts).set({ status: "draft" }).where(eq(drafts.id, draftId));
    await expect(schedules.schedule(ctx, draftId, iso(AT)))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it("cross-account ids are 404, and rows past 'draft' are 409", async () => {
    const { db, ctx, draftId } = await setup();
    const stranger: ServiceContext = { ...ctx, accountId: randomUUID() };
    await expect(schedules.schedule(stranger, draftId, iso(AT))).rejects.toMatchObject({ httpStatus: 404 });
    await db.update(drafts).set({ status: "sent" }).where(eq(drafts.id, draftId));
    await expect(schedules.schedule(ctx, draftId, iso(AT))).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("ScheduleService.cancel", () => {
  it("returns the row to an ordinary draft; a repeat cancel is idempotent success", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const { draft } = await schedules.cancel(ctx, draftId);
    expect(draft.status).toBe("draft");
    expect(draft.sendAt).toBeNull();
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.sendKey).toBeNull();

    // The asked-for state already holds — a double-tap or a retry is not an error.
    const again = await schedules.cancel(ctx, draftId);
    expect(again.draft.status).toBe("draft");
  });

  it("answers 409 'already being sent' for the claim window — never a false 'cancelled'", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    // The worker's claim committed: status 'draft', send_at/key standing.
    await db.update(drafts).set({ status: "draft" }).where(eq(drafts.id, draftId));
    await expect(schedules.cancel(ctx, draftId)).rejects.toMatchObject({ httpStatus: 409 });
    // …and for a row already mid-reservation.
    await db.update(drafts).set({ status: "sending" }).where(eq(drafts.id, draftId));
    await expect(schedules.cancel(ctx, draftId)).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("a scheduled draft is FROZEN", () => {
  it("PATCH refuses with the way forward named; discard refuses the same way", async () => {
    const { ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    await expect(draftsSvc.update(ctx, draftId, { body: "edited" }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await expect(draftsSvc.remove(ctx, draftId))
      .rejects.toMatchObject({ httpStatus: 409 });
    // Cancel first, then both verbs work — the promised way forward is real.
    await schedules.cancel(ctx, draftId);
    const upd = await draftsSvc.update(ctx, draftId, { body: "edited" });
    expect(upd.draft.body).toBe("edited");
    await draftsSvc.remove(ctx, draftId);
  });

  it("an edit clears a stale scheduled-send failure sentence", async () => {
    const { db, ctx, draftId } = await setup();
    await db.update(drafts).set({ sendError: "old failure" }).where(eq(drafts.id, draftId));
    const { draft } = await draftsSvc.update(ctx, draftId, { body: "fixed" });
    expect(draft.sendError).toBeNull();
  });
});

describe("runScheduledSendPass", () => {
  it("skips a not-yet-due row entirely — no claim, no dial, no reservation", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT)); // due at 18:00
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory, now: () => NOW, // noon — not due
    });
    expect(r.claimed).toBe(0);
    expect(fake.state.delivered).toHaveLength(0);
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.status).toBe("scheduled");
    expect(await db.select().from(outboundSends)).toHaveLength(0);
  });

  it("sends a due row under the STORED key on the ordinary send path, and a second pass has nothing left", async () => {
    const { db, A, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const [before] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    const fake = fakeAdapter();
    const after = new Date(AT.getTime() + 30 * 1000);

    const r = await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => after });
    expect(r).toMatchObject({ claimed: 1, sent: 1, failed: 0, deferred: 0 });
    expect(fake.state.delivered).toHaveLength(1);
    expect(fake.state.delivered[0]!.text).toContain("the words");

    // The reservation carries the key minted AT SCHEDULE TIME — the crash-safety hinge.
    const [res] = await db.select().from(outboundSends)
      .where(and(eq(outboundSends.accountId, A), eq(outboundSends.idempotencyKey, before!.sendKey!)));
    expect(res?.status).toBe("sent");

    // Terminal outcome cleared the bookkeeping in the finalizer's own transaction.
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.status).toBe("sent");
    expect(row!.sendAt).toBeNull();
    expect(row!.sendKey).toBeNull();

    // ONE press is one delivery: the next pass claims nothing and the fake counts one send.
    const r2 = await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => after });
    expect(r2.claimed).toBe(0);
    expect(fake.state.delivered).toHaveLength(1);
  });

  it("a cancelled appointment NEVER sends", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    await schedules.cancel(ctx, draftId);
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory, now: () => new Date(AT.getTime() + 60_000),
    });
    expect(r.claimed).toBe(0);
    expect(fake.state.delivered).toHaveLength(0);
    expect(await db.select().from(outboundSends)).toHaveLength(0);
  });

  it("an edited message sends ONLY its final content (cancel → edit → schedule again)", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    await schedules.cancel(ctx, draftId);
    await draftsSvc.update(ctx, draftId, { body: "the FINAL words" });
    await schedules.schedule(ctx, draftId, iso(AT));
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory, now: () => new Date(AT.getTime() + 60_000),
    });
    expect(r.sent).toBe(1);
    expect(fake.state.delivered).toHaveLength(1);
    expect(fake.state.delivered[0]!.text).toBe("the FINAL words");
    expect(fake.state.delivered[0]!.text).not.toContain("the words\n");
  });

  it("a deterministic refusal closes the appointment with the sentence, back to an editable draft, change emitted", async () => {
    const { db, A, ctx, mb, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    // The mailbox is disconnected by send time — reserve's own 409.
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mb));
    const fake = fakeAdapter();
    const before = await db.select().from(changeLog).where(eq(changeLog.accountId, A));

    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory, now: () => new Date(AT.getTime() + 60_000),
    });
    expect(r).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(fake.state.delivered).toHaveLength(0);

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.status).toBe("draft");
    expect(row!.sendAt).toBeNull();
    expect(row!.sendKey).toBeNull();
    expect(row!.sendError).toMatch(/disconnected/);
    // The client learns through the ordinary drain: the close emitted a draft change.
    const after = await db.select().from(changeLog).where(eq(changeLog.accountId, A));
    expect(after.length).toBeGreaterThan(before.length);

    // …and the sentence dies with the next edit, exactly as the Drafts row promises.
    const upd = await draftsSvc.update(ctx, draftId, { body: "try again" });
    expect(upd.draft.sendError).toBeNull();
  });

  /**
   * A PRE-SMTP FAULT IS A DEFINITE NON-DELIVERY, AND THE SCHEDULED ROW IS TOLD SO.
   *
   * This test asserted the opposite until the pre-SMTP window landed, and the old contract is
   * worth stating because the change is not a relaxation. It used to require the row to stay
   * `sending` with the key standing and the reservation `pending`, so that the recovery arm
   * would replay the key, probe the Sent folder, find nothing, and finalize `unverified` —
   * *"we couldn't confirm this send, check your Sent folder."*
   *
   * That sentence is FALSE here, and provably so rather than arguably: the adapter FACTORY
   * refused, and the factory (`packages/api/src/send-adapter.ts`) reads credential rows,
   * decrypts them, constructs an `ImapAdapter` and calls `connect()` — an IMAP login and LIST.
   * It builds the SMTP config but never dials it; SMTP happens only inside the returned
   * `send()`. So no envelope was offered to any server, nothing can be in Sent, and the ten
   * minutes of `sending` followed by "go and look" told the reader to do the one thing that
   * could not help while hiding the one that could.
   *
   * So the fate is KNOWN and is recorded as known: terminal `failed`, the appointment cleared
   * so nothing re-claims it, and `send_error` carrying the sentence — which on a schedule is
   * the only channel there is, because the throw is caught by a loop and no route maps it.
   */
  it("a PRE-SMTP fault is a definite non-delivery: terminal, explained, and never probed for", async () => {
    const { db, A, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const [before] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    // The adapter factory throws — after `reserve` committed, before anything was offered.
    const broken = fakeAdapter({ failWith: () => new Error("ECONNRESET") });
    const r1 = await runScheduledSendPass(db, {
      openSendAdapter: broken.factory, now: () => new Date(AT.getTime() + 60_000),
    });
    expect(r1).toMatchObject({ claimed: 1, failed: 1, deferred: 0, sent: 0, unverified: 0 });
    expect(broken.state.delivered).toHaveLength(0);

    const [closed] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(closed!.status).toBe("draft");
    expect(closed!.sendKey).toBeNull();
    expect(closed!.sendAt).toBeNull();
    // The sentence, and specifically NOT the ambiguous one.
    expect(closed!.sendError).toBe(SEND_FAILED_SENTENCE);
    expect(closed!.sendError).not.toMatch(/sent folder/i);

    const [res] = await db.select().from(outboundSends)
      .where(and(eq(outboundSends.accountId, A), eq(outboundSends.idempotencyKey, before!.sendKey!)));
    expect(res?.status, "the reservation is terminal — a same-key replay must not resend").toBe("failed");

    // No later pass ever touches it again: the appointment is gone, so there is nothing to
    // claim and nothing to probe. This is the half the old contract got wrong — it spent a
    // Sent-folder probe on a message that had never left.
    const healed = fakeAdapter({ inSent: false });
    const r2 = await runScheduledSendPass(db, {
      openSendAdapter: healed.factory,
      now: () => new Date(AT.getTime() + SEND_STALE_AFTER_MS + 120_000),
    });
    expect(r2).toMatchObject({ claimed: 0, unverified: 0, failed: 0, deferred: 0 });
    expect(healed.state.probes, "nothing may probe Sent for a message that never left").toBe(0);
    expect(healed.state.delivered).toHaveLength(0);
  });

  /**
   * AND THE UNKNOWN-FATE CASE STILL EXISTS, STILL DEFERS — the boundary, from the other side.
   *
   * The change above narrows what counts as ambiguous; it does not abolish it, and this is the
   * shape that keeps it honest. `adapter.send` throws — so the envelope DID go to the server and
   * may have been accepted — and then the verify-by-Sent probe throws too, so the ambiguity is
   * not resolved either. Nothing may be written up as an ending: the reservation stays `pending`,
   * the row stays `sending` with its key, and the recovery arm replays it once provably stale.
   *
   * Without this test the two states `reservationFailed` distinguishes would have only one of
   * them covered, and a change that failed EVERY post-reservation throw would look green — which
   * is the double-send boundary, since a released key is a licence to send the message again.
   */
  it("an UNKNOWN fate still defers — key kept, row 'sending', reservation pending", async () => {
    const { db, A, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const [before] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    const ambiguous = fakeAdapter({
      sendThrows: () => new Error("write EPIPE after DATA"),
      probeThrows: () => new Error("the Sent probe could not read the folder either"),
    });
    const r = await runScheduledSendPass(db, {
      openSendAdapter: ambiguous.factory, now: () => new Date(AT.getTime() + 60_000),
    });
    expect(r).toMatchObject({ claimed: 1, deferred: 1, failed: 0, sent: 0, unverified: 0 });
    expect(ambiguous.state.opened, "the envelope was offered — that is what makes it ambiguous")
      .toHaveLength(1);

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.status).toBe("sending");
    expect(row!.sendKey).toBe(before!.sendKey);
    expect(row!.sendError, "nothing may be said while the fate is unknown").toBeNull();
    const [res] = await db.select().from(outboundSends)
      .where(and(eq(outboundSends.accountId, A), eq(outboundSends.idempotencyKey, before!.sendKey!)));
    expect(res?.status, "the reservation must survive for the recovery arm to replay").toBe("pending");

    // The standing machinery ends it terminally once stale, with no resend.
    const healed = fakeAdapter({ inSent: false });
    const r2 = await runScheduledSendPass(db, {
      openSendAdapter: healed.factory,
      now: () => new Date(AT.getTime() + SEND_STALE_AFTER_MS + 120_000),
    });
    expect(r2).toMatchObject({ claimed: 1, unverified: 1 });
    expect(healed.state.delivered).toHaveLength(0);
  });

  it("a budgeted pass starts no send that could not finish in time; the rest are appointments again for the next poke", async () => {
    const { db, ctx, mb, draftId } = await setup();
    const ids = [draftId];
    for (const body of ["the second letter", "the third letter"]) {
      ids.push((await draftsSvc.create(ctx, { mailboxId: mb, subject: "later", body, to: [{ name: null, address: "you@example.com" }] })).draft.id);
    }
    for (const id of ids) await schedules.schedule(ctx, id, iso(AT));
    let t = AT.getTime() + 1_000;
    const fake = fakeAdapter();
    // Each send's Sent copy is slow: 30 s of the invocation per letter.
    const slow: OpenSendAdapter = async (m) => {
      const a = await fake.factory(m);
      return { ...a, send: async (msg: OutboundMessage) => { t += 30_000; return a.send(msg); } };
    };
    const started = t;
    const r = await runScheduledSendPass(db, { openSendAdapter: slow, now: () => new Date(t), budgetMs: 60_000 });
    expect(r).toMatchObject({ claimed: 3, sent: 1, deferred: 2 });
    expect(t - started, "the pass ends inside the invocation").toBeLessThanOrEqual(60_000);
    const left = await db.select().from(drafts).where(eq(drafts.status, "scheduled"));
    expect(left.map((d) => d.sendKey === null)).toEqual([false, false]);
    const next = await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => new Date(t), budgetMs: 60_000 });
    expect(next).toMatchObject({ claimed: 2, sent: 2 });
    expect(fake.state.delivered).toHaveLength(3);
  });

  it("an appointment more than a day past due closes with the sentence BEFORE anything dials", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    // A working adapter, deliberately: the refusal must come from the age, not from a fault.
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory,
      now: () => new Date(AT.getTime() + SCHEDULED_SEND_EXPIRY_MS + 60_000),
    });
    expect(r).toMatchObject({ claimed: 1, failed: 1, sent: 0 });
    expect(fake.state.delivered, "a day-late appointment was quietly delivered").toHaveLength(0);
    const [closed] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(closed!.status).toBe("draft");
    expect(closed!.sendAt).toBeNull();
    expect(closed!.sendError).toMatch(/not sent/);
    expect(await db.select().from(outboundSends)).toHaveLength(0);
  });

  it("RECOVERY: a claim that died before reserving is re-found by its standing key and sent once", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    // The crash: claim committed (status 'draft', key standing), sender died. Long past due.
    await db.update(drafts).set({ status: "draft" }).where(eq(drafts.id, draftId));
    const fake = fakeAdapter();
    const wayPast = new Date(AT.getTime() + SEND_STALE_AFTER_MS + 60_000);
    const r = await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => wayPast });
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(fake.state.delivered).toHaveLength(1);
  });

  it("RECOVERY: a crash after the reservation replays the key — verify-by-Sent, never a resend", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    // The crash: reserve committed (draft 'sending', a pending reservation under the stored
    // key with the minted id), SMTP outcome unknown.
    await db.update(drafts).set({ status: "sending" }).where(eq(drafts.id, draftId));
    await db.insert(outboundSends).values({
      accountId: row!.accountId, idempotencyKey: row!.sendKey!, draftId,
      mintedMessageId: "<crashed@later.test>", status: "pending",
      createdAt: new Date(AT.getTime()),
    });
    // The probe finds the copy in Sent ⇒ reconcile to sent, NO resend.
    const fake = fakeAdapter({ inSent: true });
    const wayPast = new Date(AT.getTime() + SEND_STALE_AFTER_MS + 60_000);
    const r = await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => wayPast });
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(fake.state.delivered, "recovery resent a delivery it could not verify").toHaveLength(0);
    expect(fake.state.probes).toBeGreaterThan(0);
    const [after] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(after!.status).toBe("sent");
    expect(after!.sendKey).toBeNull();
  });
});

describe("the review round's guards (round 1)", () => {
  it("a SUSPENDED account's due appointment is never claimed and never dials — and sends once eligible again", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const fake = fakeAdapter();
    const after = new Date(AT.getTime() + 60_000);

    let handedHandle: unknown = null;
    const r1 = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory, now: () => after,
      accountEligible: async (_accountId, handle) => { handedHandle = handle; return false; },
    });
    // THE DEADLOCK RULE: the gate is handed the CLAIM TRANSACTION's own handle, never the outer
    // db — on the hosted host's pooled connection the captured form queued behind the
    // transaction holding it and every poke of the sender clock timed out (measured in
    // production within minutes of shipping it).
    expect(handedHandle, "the gate ran without being handed a handle").not.toBeNull();
    expect(handedHandle, "the gate was handed the OUTER handle — the production deadlock shape")
      .not.toBe(db);
    expect(r1.claimed).toBe(0);
    expect(fake.state.delivered).toHaveLength(0);
    const [held] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    // Untouched, not re-armed: still 'scheduled', still due, dialled the cycle after the
    // suspension lifts — and no reservation was minted meanwhile.
    expect(held!.status).toBe("scheduled");
    expect(await db.select().from(outboundSends)).toHaveLength(0);

    const r2 = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory, now: () => after,
      accountEligible: async () => true,
    });
    expect(r2).toMatchObject({ claimed: 1, sent: 1 });
    expect(fake.state.delivered).toHaveLength(1);
  });

  /**
   * A TYPED REFUSAL SPEAKS FOR ITSELF — its own message becomes the Drafts row's sentence.
   *
   * Same boundary as the pre-SMTP test above, with the half that only a typed error has: a
   * `ServiceError` is written to be READ, so it is quoted verbatim rather than replaced by the
   * standing sentence. That is the existing convention (`closeAppointment` has always quoted
   * `err.message` into `send_error`); what changed is only WHO writes it, because the terminal
   * finalize now clears `send_key` and the key is what `closeAppointment` is guarded on.
   *
   * This test also asserted the recovery contract until the window landed — `sending`, key kept,
   * reservation `pending`. It was the more misleading of the two: the measured shape is deleted
   * credentials, so the send provably cannot have happened, and the old path still ended at
   * "check your Sent folder".
   */
  it("a typed refusal after the reservation is terminal, and its OWN sentence reaches the row", async () => {
    const { db, A, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    const [before] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    // The measured shape: the adapter FACTORY refuses (credentials deleted between reserve and
    // dial) — a typed ServiceError thrown after `reserve` committed.
    const refusing = fakeAdapter({
      failWith: () => new ServiceError("mailbox_not_signed_in", 424, "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings", undefined, false),
    });
    const r = await runScheduledSendPass(db, {
      openSendAdapter: refusing.factory, now: () => new Date(AT.getTime() + 60_000),
    });
    expect(r).toMatchObject({ claimed: 1, failed: 1, deferred: 0, sent: 0, unverified: 0 });
    expect(refusing.state.delivered).toHaveLength(0);

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.status).toBe("draft");
    expect(row!.sendKey).toBeNull();
    expect(row!.sendAt).toBeNull();
    // The refusal's own words, not the generic sentence and not the ambiguous one.
    expect(row!.sendError).toBe("this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings");
    expect(row!.sendError).not.toBe(SEND_FAILED_SENTENCE);
    expect(row!.sendError).not.toMatch(/sent folder/i);

    const [res] = await db.select().from(outboundSends)
      .where(and(eq(outboundSends.accountId, A), eq(outboundSends.idempotencyKey, before!.sendKey!)));
    expect(res?.status).toBe("failed");

    // …and the sentence dies with the next edit, exactly as the Drafts row promises.
    const upd = await draftsSvc.update(ctx, draftId, { body: "fix the mailbox, then retry" });
    expect(upd.draft.sendError).toBeNull();
  });

  it("the CLAIM WINDOW is frozen too: a stale PUT or DELETE while the key stands answers 409", async () => {
    const { db, ctx, draftId } = await setup();
    await schedules.schedule(ctx, draftId, iso(AT));
    // The worker's claim committed: status 'draft', send_at/key standing.
    await db.update(drafts).set({ status: "draft" }).where(eq(drafts.id, draftId));
    await expect(draftsSvc.update(ctx, draftId, { body: "stale edit racing the reserve" }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await expect(draftsSvc.remove(ctx, draftId))
      .rejects.toMatchObject({ httpStatus: 409 });
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.body).not.toContain("stale edit");
  });
});

describe("the review round's guards (round 2)", () => {
  it("a suspended account's parked backlog cannot STARVE another account — pages walk past it", async () => {
    const db = await makeTestDb();
    const suspended = randomUUID();
    const healthy = randomUUID();
    const [mbS] = await db.insert(mailboxes).values({
      accountId: suspended, provider: "imap", address: "parked@later.test",
    }).returning();
    const [mbH] = await db.insert(mailboxes).values({
      accountId: healthy, provider: "imap", address: "alive@later.test",
    }).returning();
    const ctxS: ServiceContext = { db, accountId: suspended, userId: null, now: () => NOW, requestId: "r" };
    const ctxH: ServiceContext = { db, accountId: healthy, userId: null, now: () => NOW, requestId: "r" };

    // The suspended account owns the OLDEST due rows — more than one whole scan page of them,
    // which is exactly the prefix that re-filled a fixed window every cycle and starved
    // everything behind it. The healthy account's single appointment is the NEWEST.
    const pageSize = 12; // batch 3 × scan factor 4 — one full page
    for (let i = 0; i <= pageSize; i++) {
      const { draft } = await draftsSvc.create(ctxS, {
        mailboxId: mbS!.id, subject: `parked ${i}`, body: "held",
        to: [{ name: null, address: "you@example.com" }],
      });
      await schedules.schedule(ctxS, draft.id, iso(new Date(AT.getTime() + i * 1000)));
    }
    const { draft: alive } = await draftsSvc.create(ctxH, {
      mailboxId: mbH!.id, subject: "alive", body: "the words that must leave",
      to: [{ name: null, address: "you@example.com" }],
    });
    await schedules.schedule(ctxH, alive.id, iso(new Date(AT.getTime() + 60_000)));

    const fake = fakeAdapter();
    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory,
      now: () => new Date(AT.getTime() + 120_000),
      accountEligible: async (accountId) => accountId !== suspended,
    });
    expect(r.sent, "the healthy account's send starved behind the parked prefix").toBe(1);
    expect(fake.state.delivered).toHaveLength(1);
    expect(fake.state.delivered[0]!.text).toBe("the words that must leave");
    // The parked rows are exactly as they stood — scheduled, undialled.
    const parked = await db.select().from(drafts).where(eq(drafts.accountId, suspended));
    expect(parked.every((d) => d.status === "scheduled")).toBe(true);
  });
});

describe("the review round's guards (round 3)", () => {
  it("MANY parked accounts cannot exhaust the walk: the brake is per distinct account, and the healthy row behind them all still sends", async () => {
    const db = await makeTestDb();
    const parkedAccounts: string[] = [];
    // Eleven parked accounts, twelve consecutive oldest rows EACH — the shape that exhausted a
    // ten-page cap and, with no memory between invocations, starved everything behind it
    // permanently. Seeded directly: 132 service round-trips would be test theatre.
    for (let a = 0; a < 11; a++) {
      const accountId = randomUUID();
      parkedAccounts.push(accountId);
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", address: `parked-${a}@deep.test`,
      }).returning();
      await db.insert(drafts).values(Array.from({ length: 12 }, (_, i) => ({
        accountId, mailboxId: mb!.id, subject: `p${a}-${i}`, body: "held",
        to: [{ name: null, address: "you@example.com" }], status: "scheduled",
        sendAt: new Date(AT.getTime() + (a * 12 + i) * 1000), sendKey: randomUUID(),
        createdAt: NOW, updatedAt: NOW,
      })));
    }
    const healthy = randomUUID();
    const [mbH] = await db.insert(mailboxes).values({
      accountId: healthy, provider: "imap", address: "deep-alive@deep.test",
    }).returning();
    const ctxH: ServiceContext = { db, accountId: healthy, userId: null, now: () => NOW, requestId: "r" };
    const { draft: alive } = await draftsSvc.create(ctxH, {
      mailboxId: mbH!.id, subject: "deep alive", body: "past eleven parked accounts",
      to: [{ name: null, address: "you@example.com" }],
    });
    await schedules.schedule(ctxH, alive.id, iso(new Date(AT.getTime() + 300_000)));

    const parked = new Set(parkedAccounts);
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory,
      now: () => new Date(AT.getTime() + 600_000),
      accountEligible: async (accountId) => !parked.has(accountId),
    });
    expect(r.sent, "the walk gave up before the healthy account").toBe(1);
    expect(fake.state.delivered).toHaveLength(1);
    expect(fake.state.delivered[0]!.text).toBe("past eleven parked accounts");
  });
});

/**
 * TWO IDENTICAL APPOINTMENTS DUE IN THE SAME MINUTE — the scheduled path meets the content claim.
 *
 * The pass runs the ordinary gated send, so the duplicate refusal reaches it as a thrown
 * `ServiceError` like any other. What has to be true is not only that ONE envelope leaves, but
 * what becomes of the other appointment: an appointment that will never be kept must be CLOSED
 * with a sentence the person can read in the Drafts row, and must never be left `scheduled` for a
 * later pass to try again for ever, nor left `sending` with nothing to resolve it.
 */
describe("the scheduled pass and the duplicate-send refusal", () => {
  it("sends ONE, and closes the other as a draft carrying the refusal's own sentence", async () => {
    const { db, ctx, mb } = await setup();
    const fake = fakeAdapter({ inSent: true });

    // Two rows, same envelope, same words, same minute. A person who scheduled the message twice,
    // or a client that wrote the appointment twice.
    const a = await draftsSvc.create(ctx, {
      mailboxId: mb, subject: "twice", body: "the same words",
      to: [{ name: null, address: "you@example.com" }],
    });
    const b = await draftsSvc.create(ctx, {
      mailboxId: mb, subject: "twice", body: "the same words",
      to: [{ name: null, address: "you@example.com" }],
    });
    await schedules.schedule(ctx, a.draft.id, iso(AT));
    await schedules.schedule(ctx, b.draft.id, iso(AT));

    const after = new Date(AT.getTime() + 1000);
    const r = await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => after });

    expect(r.claimed).toBe(2);
    expect(fake.state.delivered, "exactly one envelope reached the mail server").toHaveLength(1);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);

    // Only the two rows this case scheduled — `setup()` plants an unrelated draft of its own.
    const all = await db.select().from(drafts).where(eq(drafts.accountId, ctx.accountId));
    const rows = all.filter((x) => x.id === a.draft.id || x.id === b.draft.id);
    expect(rows).toHaveLength(2);
    const statuses = rows.map((x) => x.status).sort();
    expect(statuses, "one sent, one back to draft — neither stranded in `scheduled` or `sending`")
      .toEqual(["draft", "sent"]);

    const closed = rows.find((x) => x.status === "draft")!;
    expect(closed.sendError, "the Drafts row says why it did not go").toMatch(/identical|exact/i);
    expect(closed.sendAt, "the appointment is over").toBeNull();
    expect(closed.sendKey).toBeNull();

    // And the refused appointment left no reservation of its own.
    const reservations = await db.select().from(outboundSends);
    expect(reservations).toHaveLength(1);
  });

  it("a re-scheduled duplicate PAST the window is sent — the refusal is not permanent", async () => {
    const { db, ctx, mb } = await setup();
    const fake = fakeAdapter({ inSent: true });
    const a = await draftsSvc.create(ctx, {
      mailboxId: mb, subject: "again", body: "identical words",
      to: [{ name: null, address: "you@example.com" }],
    });
    await schedules.schedule(ctx, a.draft.id, iso(AT));
    await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => new Date(AT.getTime() + 1000) });
    expect(fake.state.delivered).toHaveLength(1);

    const b = await draftsSvc.create(ctx, {
      mailboxId: mb, subject: "again", body: "identical words",
      to: [{ name: null, address: "you@example.com" }],
    });
    // A LITERAL clock, not `AT + SEND_DUPLICATE_WINDOW_MS + …`. Derived from the constant, this
    // case moves with it and can therefore see nothing: widen the window a thousandfold and the
    // "past the window" clock is still past the window, so the one property under test — that the
    // claim EXPIRES — is asserted against whatever the constant happens to say. One hour and one
    // minute, chosen against the window pinned on the line below and failing loudly if it moves.
    expect(SEND_DUPLICATE_WINDOW_MS,
      "the literal clock below is one hour and one minute, chosen against this window")
      .toBe(60 * 60_000);
    // AND WHAT THIS CASE DOES NOT PROVE, measured rather than assumed: the two appointments are
    // an hour and a minute apart, `send_at` is a MEMBER of the content digest, so these two rows
    // are different messages and no claim ever conflicts here — two claim rows with two different
    // fingerprints. So the reclaim ARM is not what makes this green, and widening the window a
    // thousandfold leaves it green. The window's expiry is proven where a collision really
    // happens: `send-duplicate-guard.pg.test.ts`'s "PAST THE WINDOW" case, whose two drafts are
    // both unscheduled and therefore agree on every member. What is asserted here is the
    // scheduled path's own property — a re-scheduled duplicate is not permanently refused — and
    // the pin above is what stops this case from silently following the constant.
    const wayLater = new Date(AT.getTime() + 3_660_000);
    const ctxLater: ServiceContext = { ...ctx, now: () => new Date(AT.getTime() + 1000) };
    await schedules.schedule(ctxLater, b.draft.id, iso(wayLater));

    const r = await runScheduledSendPass(db, {
      openSendAdapter: fake.factory, now: () => new Date(wayLater.getTime() + 1000),
    });
    expect(r.sent).toBe(1);
    expect(fake.state.delivered, "past the window it is a second intent, and it goes").toHaveLength(2);
  });
});


/**
 * A RETRYABLE REFUSAL MUST NOT CLOSE AN APPOINTMENT.
 *
 * The pass treats a `ServiceError` as a settled refusal and closes: `send_at` and `send_key`
 * cleared, the row an ordinary draft again. That is right for a deterministic refusal and wrong for
 * one the server marked RETRYABLE, which means "not yet" rather than "no" — and the appointment is
 * the only thing that would have brought the row back.
 */
describe("the scheduled pass and a RETRYABLE refusal", () => {
  it("keeps the appointment and its key, so the row comes due again", async () => {
    const { db, ctx, mb } = await setup();
    const fake = fakeAdapter({ inSent: true });

    const a = await draftsSvc.create(ctx, {
      mailboxId: mb, subject: "twice", body: "the same words",
      to: [{ name: null, address: "you@example.com" }],
    });
    const b = await draftsSvc.create(ctx, {
      mailboxId: mb, subject: "twice", body: "the same words",
      to: [{ name: null, address: "you@example.com" }],
    });
    await schedules.schedule(ctx, a.draft.id, iso(AT));
    await schedules.schedule(ctx, b.draft.id, iso(AT));

    // Both due in the same minute. One sends; the other is refused as a duplicate — and because
    // the first is `sent` by the time the second is judged, that refusal is TERMINAL and the
    // appointment correctly closes. The retryable arm is exercised by the reservation being
    // `pending` instead, which is the interleaving below.
    const after = new Date(AT.getTime() + 1000);
    await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => after });
    expect(fake.state.delivered).toHaveLength(1);

    // Now the retryable shape: a THIRD appointment for the same words, judged while a reservation
    // for that content is still `pending`. Its appointment must SURVIVE.
    const c = await draftsSvc.create(ctx, {
      mailboxId: mb, subject: "twice", body: "the same words",
      to: [{ name: null, address: "you@example.com" }],
    });
    await schedules.schedule(ctx, c.draft.id, iso(AT));
    await db.update(outboundSends).set({ status: "pending" })
      .where(eq(outboundSends.accountId, ctx.accountId));

    const r = await runScheduledSendPass(db, { openSendAdapter: fake.factory, now: () => after });

    expect(r.deferred, "a retryable refusal defers rather than failing").toBeGreaterThan(0);
    const [row] = await db.select().from(drafts).where(eq(drafts.id, c.draft.id));
    expect(row!.status, "still an appointment").toBe("scheduled");
    expect(row!.sendAt, "the appointment stands").not.toBeNull();
    expect(row!.sendKey, "and so does the key that brings it back").not.toBeNull();
    expect(row!.sendError, "no failure sentence for something that has not failed").toBeNull();
  });
});

/**
 * WHICH INSTANT A DUPLICATE REFUSAL NAMES — the claim's window clock is not a delivery.
 *
 * The 409 tells a person their message was already sent AT A TIME, and that time is the only
 * thing in the sentence they can check: they go to the Sent folder and look for it. Two different
 * instants are available at the refusal and only one of them is that:
 *
 *   · `outbound_send_fingerprints.created_at` — the WINDOW's clock. Stamped when the claim is
 *     taken and RESTAMPED on every re-point, so it is the age of an intent, not of a delivery.
 *   · `outbound_sends.sent_at` — written by the finalize that recorded the send as sent, which is
 *     the instant the Sent copy is stamped with.
 *
 * They come apart whenever a send is CONFIRMED later than it was reserved, which is an ordinary
 * ending rather than an exotic one: `adapter.send` throws, so the fate is unknown, the reservation
 * stays `pending` with its key — and the verify-by-Sent recovery settles it `sent` on ITS clock,
 * minutes or tens of minutes later. The sequence below reserves at t0, is confirmed at t0+50m and
 * is refused at t0+55m.
 *
 * The gap is bounded by the window BY CONSTRUCTION, and it is worth writing down because the
 * defect reads as though it could be arbitrarily large: a 409 requires the claim to be YOUNGER
 * than `SEND_DUPLICATE_WINDOW_MS`, and `sent_at` cannot be later than the request refusing, so the
 * two times can differ by at most that window. An hour-old claim is not refused at all — it is
 * reclaimed and the message goes — the case named "a re-scheduled duplicate PAST the window is
 * sent" above.
 * So "reserved at 09:00, delivered at 17:00" never reaches this sentence; "reserved at 09:00,
 * confirmed at 09:50, pressed again at 09:55" does, and it answered `09:00`.
 *
 * It drives `SendService.send` rather than the scheduled pass for one reason: the digest includes
 * the draft's `send_at`, so two colliding APPOINTMENTS must share an appointment to the
 * millisecond, and two such rows are claimed by one pass in an order decided by their ids. A
 * fixture whose subject depends on which of two uuids sorts first measures the uuids.
 */
describe("the duplicate refusal's TIME", () => {
  it("names the reservation's `sent_at` for a `sent` first send, never the claim's window stamp", async () => {
    const { db, ctx, mb } = await setup();
    const pressedAt = new Date(AT.getTime());                    // the press
    const confirmedAt = new Date(AT.getTime() + 50 * 60_000);    // verify-by-Sent confirms it
    const secondPressAt = new Date(AT.getTime() + 55 * 60_000);  // the second press
    const at = (t: Date): ServiceContext => ({ ...ctx, now: () => t });
    const words = {
      mailboxId: mb, subject: "the note", body: "identical words",
      to: [{ name: null, address: "you@example.com" }],
    };

    // ── 1. THE PRESS. The envelope went to the server and the probe could not read the folder
    // either, so nothing may be written up as an ending: the reservation stays `pending` and the
    // CLAIM is stamped pressedAt.
    const first = await draftsSvc.create(at(pressedAt), words);
    const ambiguous = fakeAdapter({
      sendThrows: () => new Error("write EPIPE after DATA"),
      probeThrows: () => new Error("the Sent probe could not read the folder either"),
    });
    await sends.send(at(pressedAt), first.draft.id, "k-first", { openSendAdapter: ambiguous.factory })
      .catch(() => { /* the unknown fate propagates to the caller; the ROW is the subject here */ });
    const [reserved] = await db.select().from(outboundSends);
    expect(reserved!.status, "an unknown fate leaves the reservation for the recovery").toBe("pending");
    expect(reserved!.sentAt, "nothing has been recorded as sent yet").toBeNull();
    const [claimAtPress] = await db.select().from(outboundSendFingerprints);
    expect(claimAtPress!.createdAt.getTime()).toBe(pressedAt.getTime());

    // ── 2. FIFTY MINUTES LATER, the same key: the row is provably stale, the copy IS in Sent, and
    // the recovery reconciles it without resending. `sent_at` is stamped with THIS clock.
    const healed = fakeAdapter({ inSent: true });
    const res = await sends.send(at(confirmedAt), first.draft.id, "k-first", { openSendAdapter: healed.factory });
    expect(res.status).toBe("sent");
    expect(healed.state.delivered, "recovery verifies, it never resends").toHaveLength(0);
    const [settled] = await db.select().from(outboundSends);
    expect(settled!.sentAt!.getTime(), "the delivery's own instant").toBe(confirmedAt.getTime());
    // AND THE CLAIM'S STAMP DID NOT MOVE. This is what makes the case discriminate: with the two
    // times equal it would pass reading either column.
    const [claimAfter] = await db.select().from(outboundSendFingerprints);
    expect(claimAfter!.createdAt.getTime()).toBe(pressedAt.getTime());
    expect(claimAfter!.createdAt.getTime()).not.toBe(settled!.sentAt!.getTime());

    // ── 3. THE SECOND PRESS, still inside the window: a fresh draft, a fresh key, the same words.
    const second = await draftsSvc.create(at(secondPressAt), words);
    const err = await sends.send(at(secondPressAt), second.draft.id, "k-second", {
      openSendAdapter: healed.factory,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    const refusal = err as ServiceError;
    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe("duplicate_send");
    expect(healed.state.delivered, "nothing was sent a second time").toHaveLength(0);

    const details = refusal.details as { firstSend: { status: string; at: string } };
    expect(details.firstSend.status).toBe("sent");
    expect(details.firstSend.at, "the instant the send was recorded sent, not the claim's clock")
      .toBe(confirmedAt.toISOString());
    // BOTH HALVES, because a client rendering its own copy from the details and an API consumer
    // reading the sentence must be told about the same send.
    expect(refusal.message).toContain(confirmedAt.toISOString());
    expect(refusal.message, "the claim's stamp is not a time anything was sent")
      .not.toContain(pressedAt.toISOString());
  });

  /**
   * THE ARM BESIDE IT — an UNCONFIRMED first attempt still names the time it was ATTEMPTED.
   *
   * The same sequence with the recovery finding NOTHING in Sent: the reservation settles
   * `unverified`, no delivery was ever recorded, and there is no confirmed instant to point at. So
   * the refusal keeps the claim's stamp and the sentence keeps its own wording — the reader is told
   * where to look rather than that the message went.
   *
   * WHY THIS IS A PRODUCT ASSERTION AND NOT A MUTATION GUARD, stated because a green mutation is a
   * question: dropping the `sent`-only condition and reading the column for every status is
   * BEHAVIOURALLY IDENTICAL on every reachable state, because `sent_at` is stamped only by the
   * definite-sent finalize — it is null on an `unverified` or `pending` holder, and the `??` then
   * falls back to exactly this stamp. Measured: with the condition removed, 120 tests across four
   * files stay green. The condition is there to say what the code means rather than to lean on a
   * null, and what this case protects is the ANSWER — that an unconfirmed attempt is not handed a
   * delivery time.
   */
  it("an UNCONFIRMED first send names the attempt's own time, and never claims a delivery", async () => {
    const { db, ctx, mb } = await setup();
    const pressedAt = new Date(AT.getTime());
    const probedAt = new Date(AT.getTime() + 50 * 60_000);
    const secondPressAt = new Date(AT.getTime() + 55 * 60_000);
    const at = (t: Date): ServiceContext => ({ ...ctx, now: () => t });
    const words = {
      mailboxId: mb, subject: "the other note", body: "identical words",
      to: [{ name: null, address: "you@example.com" }],
    };

    const first = await draftsSvc.create(at(pressedAt), words);
    const ambiguous = fakeAdapter({
      sendThrows: () => new Error("write EPIPE after DATA"),
      probeThrows: () => new Error("the Sent probe could not read the folder either"),
    });
    await sends.send(at(pressedAt), first.draft.id, "u-first", { openSendAdapter: ambiguous.factory })
      .catch(() => { /* unknown fate */ });

    // The probe answers NO this time, so the fate stays unknown and is recorded as unknown.
    const empty = fakeAdapter({ inSent: false });
    const res = await sends.send(at(probedAt), first.draft.id, "u-first", { openSendAdapter: empty.factory });
    expect(res.status).toBe("unverified");
    const [settled] = await db.select().from(outboundSends);
    expect(settled!.status).toBe("unverified");
    expect(settled!.sentAt, "nothing was recorded as sent, so there is no instant to name").toBeNull();

    const second = await draftsSvc.create(at(secondPressAt), words);
    const err = await sends.send(at(secondPressAt), second.draft.id, "u-second", {
      openSendAdapter: empty.factory,
    }).catch((e: unknown) => e);
    const refusal = err as ServiceError;
    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe("duplicate_send");
    expect(empty.state.delivered, "nothing was sent a second time").toHaveLength(0);

    const details = refusal.details as { firstSend: { status: string; at: string } };
    expect(details.firstSend.status).toBe("unverified");
    expect(details.firstSend.at, "the attempt's own time — the claim's stamp is all there is")
      .toBe(pressedAt.toISOString());
    expect(refusal.message).toMatch(/could not be confirmed/i);
    expect(refusal.message, "an unconfirmed attempt is never reported as a delivery")
      .not.toMatch(/already sent/i);
  });
});
