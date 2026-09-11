import { randomUUID } from "node:crypto";
import { dialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { assertOrganizerRole, drafts, mailboxes, recordChange, type Tx } from "@trafficflow/db";
import type { EmailAddress } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { materializeDraft } from "./dto/materialize.js";
import type { DraftMutation } from "./drafts-service.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * HOW FAR AHEAD AN APPOINTMENT MAY BE — one year.
 *
 * Not a product promise ("we hold mail for a year") but a sanity ceiling on the input: a
 * mistyped year would otherwise park a message for a decade with every surface saying it will
 * send, and "this will really leave at that time" is a claim the product should only make over
 * horizons it can plausibly stand behind. A year is comfortably past every preset and every
 * deliberate use ("Monday morning", "after the holidays") while keeping the claim honest.
 */
export const SCHEDULE_MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * ScheduleService — SEND LATER's two verbs (`POST` / `DELETE /drafts/:id/schedule`). A scheduled
 * send is a DRAFT WITH AN APPOINTMENT: `send_at` + `status = 'scheduled'` + a `send_key` minted
 * NOW; the pass claims due rows and runs the ordinary `SendService.send` with that key. THE KEY
 * IS MINTED AT SCHEDULE TIME — the crash-safety hinge: a retry MUST present the SAME
 * Idempotency-Key or `reserve` delivers twice; a key persisted before any attempt is what the
 * retry finds. WHILE SCHEDULED THE DRAFT IS FROZEN (`update`/`remove` 409), so the worker sends
 * what the user last saw. CANCEL IS RACE-SAFE on the row lock: cancel first ⇒ never leaves; claim
 * first ⇒ 409 "already being sent" (`send-later-claim-race.pg.test.ts` pins both).
 */
export class ScheduleService {
  /** `POST /drafts/:id/schedule` — put an appointment on a draft (or move an existing one). */
  async schedule(ctx: ServiceContext, draftId: string, sendAtRaw: unknown): Promise<DraftMutation> {
    const sendAt = this.validSendAt(sendAtRaw, ctx.now());

    const seq = await asTx(ctx).transaction(async (tx) => {
      // FOR UPDATE for the same reason `SendService.reserve` takes it: this read decides
      // whether an appointment may be made, and the send path flips `status` in its own
      // transaction. Locking serializes the two — schedule either waits and sees what the
      // claim committed, or wins and the claim's own predicates rule.
      const [d] = await dialect(ctx.db).forUpdate(tx.select().from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)))
        .limit(1));
      if (!d) throw new ServiceError("not_found", 404, "draft not found");

      // A row PAST the appointment lifecycle cannot be (re-)scheduled: `sending`/`sent`/
      // `unverified` are the ordinary send-path refusals, and a 'draft' row still carrying
      // `send_at` is the worker's CLAIM WINDOW — the send is happening right now, and minting a
      // second appointment (with a second key) over it would be a second delivery.
      if (d.status === "draft" && d.sendAt !== null) {
        throw new ServiceError("conflict", 409, "this message is already being sent");
      }
      if (d.status !== "draft" && d.status !== "scheduled") {
        throw new ServiceError("conflict", 409, `draft cannot be scheduled from status '${d.status}'`);
      }

      // The same two preconditions a send press has, refused while the user is still looking at
      // the message rather than at send time by a worker they cannot see. Both are re-checked
      // authoritatively by `SendService.reserve` when the appointment comes due.
      const recipients =
        ((d.to as EmailAddress[]) ?? []).length +
        ((d.cc as EmailAddress[]) ?? []).length +
        ((d.bcc as EmailAddress[]) ?? []).length;
      if (recipients === 0) {
        throw new ServiceError("validation_failed", 400, "draft has no recipients");
      }
      const [mb] = await tx.select({ status: mailboxes.status }).from(mailboxes)
        .where(eq(mailboxes.id, d.mailboxId)).limit(1);
      if (mb?.status === "disabled") {
        throw new ServiceError(
          "mailbox_disabled", 409,
          "This mailbox is disconnected and cannot send. Reconnect it, or pick another sender.",
        );
      }
      /**
       * A READER MAKES NO APPOINTMENTS (mail 0083). An appointment is a promise to do something
       * LATER, and the pass that keeps it lives behind the organizer gate — a reader's promise
       * cannot be kept; the defect `closeStoodDownAppointments` cleans up after, closed one step
       * earlier. SENDING NOW stays untouched: a send is an APPEND to Sent completing inside the
       * request — `SendService` refuses on `disabled`, and a reader is `connected`. INSIDE the
       * transaction that takes the draft lock, so check and write see one snapshot; AFTER the
       * `disabled` refusal — "reconnect it" is actionable, a reader sentence would be true and
       * useless about a mailbox with no credentials.
       */
      await assertOrganizerRole(tx as unknown as Tx, dialect(ctx.db), ctx.accountId, d.mailboxId);

      await tx.update(drafts).set({
        status: "scheduled",
        sendAt,
        // A FRESH key per appointment — see the class header. `randomUUID` and not anything
        // derived from the time: two appointments at the same instant are still two intents.
        sendKey: randomUUID(),
        // A new appointment answers an old failure; a stale sentence over a live schedule
        // would be the row contradicting itself.
        sendError: null,
        updatedAt: ctx.now(),
      }).where(eq(drafts.id, draftId));

      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });
    });

    return this.finish(ctx, draftId, seq);
  }

  /** `DELETE /drafts/:id/schedule` — take the appointment off; the row is an ordinary draft again. */
  async cancel(ctx: ServiceContext, draftId: string): Promise<DraftMutation> {
    const seq = await asTx(ctx).transaction(async (tx) => {
      // The predicate IS the race guard — see the class header. No prior read: a read-then-write
      // would decide on a snapshot the worker's claim can overtake.
      const cancelled = await tx.update(drafts).set({
        status: "draft", sendAt: null, sendKey: null, updatedAt: ctx.now(),
      })
        .where(and(
          eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId),
          eq(drafts.status, "scheduled"),
        ))
        .returning({ id: drafts.id });

      if (cancelled.length === 0) {
        // Zero rows is four different answers. The row lock so the read waits out whichever
        // writer beat us and reports the SETTLED state, not a snapshot from before it.
        const [row] = await dialect(ctx.db).forUpdate(
          tx.select({ status: drafts.status, sendAt: drafts.sendAt }).from(drafts)
            .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)))
            .limit(1));
        if (!row) throw new ServiceError("not_found", 404, "draft not found");
        // Already an ordinary draft with no appointment: the asked-for state. Idempotent
        // success (a double-tap, a retry after a blip) rather than an error about a schedule
        // that is already gone — `createFolder`'s "already exists is the asked-for state".
        if (row.status === "draft" && row.sendAt === null) {
          return recordChange(tx, {
            accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
          });
        }
        // 'draft' WITH send_at standing is the worker's claim window; 'sending'/'sent'/
        // 'unverified' are past it. Either way the send is no longer cancellable, and saying
        // "cancelled" over mail that is leaving would be the worst false sentence available.
        throw new ServiceError("conflict", 409, "this message is already being sent");
      }

      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });
    });

    return this.finish(ctx, draftId, seq);
  }

  /**
   * The appointment time, validated. A PAST time is refused rather than rounded to "now": the
   * user asked for a time and got a different one is exactly the surprise "send later" must not
   * produce — the client refuses before the wire (its picker cannot express the past), and this
   * is the authoritative copy of the same rule against the SERVER's clock, which is the clock
   * the worker's due scan runs on.
   */
  private validSendAt(raw: unknown, now: Date): Date {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new ServiceError("validation_failed", 400, "sendAt is required (an ISO 8601 timestamp)");
    }
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) {
      throw new ServiceError("validation_failed", 400, "sendAt must be an ISO 8601 timestamp");
    }
    if (t <= now.getTime()) {
      throw new ServiceError("validation_failed", 400, "sendAt is in the past; pick a future time");
    }
    if (t > now.getTime() + SCHEDULE_MAX_AHEAD_MS) {
      throw new ServiceError("validation_failed", 400, "sendAt is more than a year away; pick a closer time");
    }
    return new Date(t);
  }

  /** Re-materialize the DTO (post-commit) and pair it with the emitted seq — `DraftsService.finish`. */
  private async finish(ctx: ServiceContext, id: string, seq: bigint): Promise<DraftMutation> {
    const draft = await materializeDraft(ctx.db, ctx.accountId, id);
    if (!draft) throw new ServiceError("internal", 500, "draft vanished after write");
    return { draft, seq: Number(seq) };
  }
}

export const scheduleService = new ScheduleService();
