import { randomUUID } from "node:crypto";
import { dialect } from "@trafficflow/db/dialect";
import { and, eq, ne, sql } from "drizzle-orm";
import { assertOrganizerRole, drafts, mailboxes, recordChange, scheduledSendFiles, type Tx } from "@trafficflow/db";
import type { EmailAddress } from "@trafficflow/core/mail";
import { bridgeTx, type ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { instantRefusal, readInstant } from "./instant.js";
import { materializeDraft } from "./dto/materialize.js";
import type { DraftMutation } from "./drafts-service.js";
import {
  dropScheduledFiles, scheduledFileRows, sealedFileRows, SCHEDULED_FILES_PLAIN, SCHEDULED_FILES_QUOTA_LOCK_CLASS,
  type ScheduledFile, type ScheduledFilesKeeping, type SealedFileRow,
} from "./scheduled-send-files.js";
import { fenceErasedScope } from "./erasure-fence.js";
import {
  dedupeStagedIds, effectiveAttachmentCap, sendSurfaceFor, type StagedAttachmentSource,
} from "./send-service.js";

const asTx = (ctx: ServiceContext): Tx => bridgeTx(ctx.db);

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

/** The draft-state refusals every schedule makes, in their order. */
function refuseUnschedulable(d: typeof drafts.$inferSelect): void {
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
  // A FORWARD IS NOT AN APPOINTMENT: the pass sends with no reader clock and cannot
  // stream the original's attachments, so the appointment would leave without what it forwards.
  if (d.forwardOfMessageId !== null) {
    throw new ServiceError(
      "forward_not_schedulable", 409,
      "a forwarded message cannot be scheduled; send it now",
    );
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
}

function refuseDisabled(mb: { status: string } | undefined): void {
  if (mb?.status === "disabled") {
    throw new ServiceError(
      "mailbox_disabled", 409,
      "This mailbox is disconnected and cannot send. Reconnect it, or pick another sender.",
    );
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a server holds for an account's other scheduled letters: bytes and files, piece 0 of each. */
async function keptElsewhere(tx: Tx, accountId: string, draftId: string): Promise<{ bytes: number; files: number }> {
  const [row] = await tx.select({
    bytes: sql<string | number>`coalesce(sum(${scheduledSendFiles.sizeBytes}), 0)`,
    files: sql<string | number>`count(*)`,
  }).from(scheduledSendFiles)
    .where(and(
      eq(scheduledSendFiles.accountId, accountId), eq(scheduledSendFiles.seq, 0),
      ne(scheduledSendFiles.draftId, draftId),
    ));
  return { bytes: Number(row?.bytes ?? 0), files: Number(row?.files ?? 0) };
}

/** 429 past the account's quota; not retryable, since only an ending appointment frees it. */
async function refuseOverQuota(
  tx: Tx, accountId: string, draftId: string, adds: { bytes: number; files: number },
  quota: { maxBytes: number; maxFiles: number },
): Promise<void> {
  const held = await keptElsewhere(tx, accountId, draftId);
  if (held.bytes + adds.bytes > quota.maxBytes || held.files + adds.files > quota.maxFiles) {
    throw new ServiceError(
      "schedule_files_quota", 429,
      "Your scheduled messages already hold as many files as can be kept. Send one of them now, or cancel one, and schedule this again.",
      { maxBytes: quota.maxBytes, maxFiles: quota.maxFiles },
      false,
    );
  }
}

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
  /**
   * `POST /drafts/:id/schedule` — put an appointment on a draft (or move an existing one). With
   * `withFiles` (`POST /drafts/:id/schedule-with-files`) the appointment keeps its files until it
   * ends, as the host keeps them (`keeping`, plain when absent: `scheduled-send-files.ts`); a plain
   * schedule keeps none.
   */
  async schedule(
    ctx: ServiceContext, draftId: string, sendAtRaw: unknown,
    withFiles?: {
      files?: readonly ScheduledFile[];
      /** Upload tickets, copied into the appointment at the press so it never needs them again. */
      staged?: { ids: readonly string[]; source: StagedAttachmentSource };
      surfaceMaxTotalBytes?: number | null;
      keeping?: ScheduledFilesKeeping;
    },
  ): Promise<DraftMutation> {
    const sendAt = this.validSendAt(sendAtRaw, ctx.now());
    const keeping = withFiles?.keeping ?? SCHEDULED_FILES_PLAIN;
    if (withFiles !== undefined && keeping.atRest === "sealed") {
      return this.scheduleSealed(ctx, draftId, sendAt, withFiles, keeping);
    }
    if ((withFiles?.staged?.ids.length ?? 0) > 0) {
      // A store that keeps plain rows has no staging: refused, never scheduled without the files.
      throw new ServiceError("validation_failed", 400, "this server does not accept staged attachments");
    }
    const files = withFiles?.files ?? [];

    const seq = await asTx(ctx).transaction(async (tx) => {
      // FILES ARE ROWS THE ERASURE SWEEPS: fenced first (account, then the draft's mailbox), before
      // the draft lock, in the sweeps' own order. A plain schedule writes none and asks nothing.
      let fencedMailbox: string | null = null;
      if (files.length > 0) {
        const [target] = await tx.select({ mailboxId: drafts.mailboxId }).from(drafts)
          .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId))).limit(1);
        if (target) {
          await fenceErasedScope(tx, dialect(ctx.db), { accountId: ctx.accountId, mailboxId: target.mailboxId });
          fencedMailbox = target.mailboxId;
        }
      }
      // FOR UPDATE for the same reason `SendService.reserve` takes it: this read decides
      // whether an appointment may be made, and the send path flips `status` in its own
      // transaction. Locking serializes the two — schedule either waits and sees what the
      // claim committed, or wins and the claim's own predicates rule.
      const [d] = await dialect(ctx.db).forUpdate(tx.select().from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)))
        .limit(1));
      if (!d) throw new ServiceError("not_found", 404, "draft not found");
      if (fencedMailbox !== null && d.mailboxId !== fencedMailbox) {
        throw new ServiceError("conflict", 409, "the sender changed while scheduling; schedule it again");
      }

      refuseUnschedulable(d);
      const [mb] = await tx.select({ status: mailboxes.status, smtpMaxSizeBytes: mailboxes.smtpMaxSizeBytes })
        .from(mailboxes).where(eq(mailboxes.id, d.mailboxId)).limit(1);
      refuseDisabled(mb);
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
      await assertOrganizerRole(bridgeTx(tx), dialect(ctx.db), ctx.accountId, d.mailboxId);

      // A PLAIN MOVE NEVER DROPS FILES: an appointment that carries files is moved only by a
      // schedule that carries them again; otherwise it would leave without them.
      if (withFiles === undefined && d.status === "scheduled" && d.sendFiles > 0) {
        throw new ServiceError(
          "schedule_has_files", 409,
          "this scheduled message carries files; cancel the schedule and schedule it again with them",
        );
      }
      // The send's own cap, at the press rather than at send time: the person is still looking.
      const total = files.reduce((n, f) => n + f.content.byteLength, 0);
      if (files.length > 0) {
        const cap = effectiveAttachmentCap(withFiles?.surfaceMaxTotalBytes, mb?.smtpMaxSizeBytes ?? null);
        if (total > cap) {
          throw new ServiceError("payload_too_large", 413, `attachments total ${total} bytes; the limit is ${cap}`);
        }
      }
      const sendKey = randomUUID();
      // Rows exist only where an appointment had files, so a plain schedule elsewhere costs nothing.
      if (files.length > 0 || d.sendFiles > 0) await dropScheduledFiles(tx, ctx.accountId, draftId);
      for (const row of scheduledFileRows({ accountId: ctx.accountId, mailboxId: d.mailboxId, draftId, sendKey }, files)) {
        // scoped-by: the account and mailbox fenced above; d is this account's draft, locked
        await tx.insert(scheduledSendFiles).values(row);
      }

      // scoped-by: d is the draft loaded by (id, accountId) above; the organizer was just asserted
      await tx.update(drafts).set({
        status: "scheduled",
        sendAt,
        // A FRESH key per appointment — see the class header. `randomUUID` and not anything
        // derived from the time: two appointments at the same instant are still two intents.
        sendKey,
        sendFiles: files.length,
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

  /**
   * SEND LATER WITH FILES ON A SERVER (mail 0180). Three steps, and no download ever happens under
   * the draft lock: everything that can refuse is asked first with no lock held (sizes by the
   * tickets' declarations); then the files are fetched one at a time, hashed and sealed as each
   * arrives; then the transaction asks everything again in the plain path's order, takes the
   * account's quota under its lock and writes the sealed rows under a fresh key. Staged files are
   * copied here, so the appointment never needs its upload tickets again.
   */
  private async scheduleSealed(
    ctx: ServiceContext, draftId: string, sendAt: Date,
    withFiles: {
      files?: readonly ScheduledFile[];
      staged?: { ids: readonly string[]; source: StagedAttachmentSource };
      surfaceMaxTotalBytes?: number | null;
    },
    keeping: Extract<ScheduledFilesKeeping, { atRest: "sealed" }>,
  ): Promise<DraftMutation> {
    const d0 = dialect(ctx.db);
    const inline = withFiles.files ?? [];
    const stagedIds = dedupeStagedIds(withFiles.staged?.ids);
    const count = inline.length + stagedIds.length;
    if (count === 0) {
      throw new ServiceError("validation_failed", 400, "attachments are required here; a letter without files is scheduled at /drafts/:id/schedule");
    }
    if (sendAt.getTime() > ctx.now().getTime() + keeping.maxAheadMs) {
      const days = Math.floor(keeping.maxAheadMs / DAY_MS);
      throw new ServiceError(
        "schedule_files_too_far", 400,
        `A message with files can be scheduled at most ${days} days ahead. Pick a closer time.`,
        { days },
      );
    }
    // The surface the bytes rode, as the send reads it: staged-only rode no request body.
    const surface = sendSurfaceFor(withFiles.surfaceMaxTotalBytes, { attachments: [...inline], stagedAttachmentIds: [...stagedIds] });
    const capFor = (smtpMaxSizeBytes: number | null | undefined): number =>
      Math.min(effectiveAttachmentCap(surface, smtpMaxSizeBytes ?? null), keeping.maxTotalBytes);
    const refuseOverCap = (total: number, cap: number): void => {
      if (total > cap) throw new ServiceError("payload_too_large", 413, `attachments total ${total} bytes; the limit is ${cap}`);
    };

    // 1 · BEFORE ANY DOWNLOAD, with no lock held.
    const pre = asTx(ctx);
    const [target] = await pre.select().from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId))).limit(1);
    if (!target) throw new ServiceError("not_found", 404, "draft not found");
    await fenceErasedScope(pre, d0, { accountId: ctx.accountId, mailboxId: target.mailboxId });
    refuseUnschedulable(target);
    const [mb0] = await pre.select({ status: mailboxes.status, smtpMaxSizeBytes: mailboxes.smtpMaxSizeBytes })
      .from(mailboxes).where(eq(mailboxes.id, target.mailboxId)).limit(1);
    refuseDisabled(mb0);
    await assertOrganizerRole(pre, d0, ctx.accountId, target.mailboxId);
    let declared = inline.reduce((n, f) => n + f.content.byteLength, 0);
    if (stagedIds.length > 0) {
      const source = withFiles.staged!.source;
      const facts = new Map((await source.declare(ctx.accountId, stagedIds)).map((f) => [f.id, f]));
      for (const id of stagedIds) {
        const f = facts.get(id);
        if (!f) throw new ServiceError("not_found", 404, "an uploaded attachment was not found");
        if (f.expiresAt.getTime() <= ctx.now().getTime()) {
          throw new ServiceError("conflict", 409, "an uploaded attachment has expired. Attach the file again and schedule it again.");
        }
        declared += f.sizeBytes;
      }
    }
    refuseOverCap(declared, capFor(mb0?.smtpMaxSizeBytes));
    await refuseOverQuota(pre, ctx.accountId, draftId, { bytes: declared, files: count }, keeping.quota);

    // 2 · THE BYTES, one file at a time, sealed as each arrives; the plaintext is not kept.
    const rows: SealedFileRow[] = [];
    let fileNo = 0;
    let total = 0;
    for (const f of inline) {
      rows.push(...await sealedFileRows({ accountId: ctx.accountId, draftId, fileNo: fileNo++ }, f, keeping.sealer));
      total += f.content.byteLength;
    }
    for (const id of stagedIds) {
      const [f] = await withFiles.staged!.source.fetch(ctx.accountId, [id], ctx.now());
      if (!f) throw new ServiceError("not_found", 404, "an uploaded attachment was not found");
      const content = Buffer.from(f.content.buffer, f.content.byteOffset, f.content.byteLength);
      rows.push(...await sealedFileRows(
        { accountId: ctx.accountId, draftId, fileNo: fileNo++ },
        { filename: f.filename, contentType: f.contentType, content }, keeping.sealer,
      ));
      total += content.byteLength;
    }

    // 3 · THE TRANSACTION, in the plain path's order: fence, draft lock, every refusal again, the
    // quota under its lock, then the write.
    const seq = await asTx(ctx).transaction(async (tx) => {
      await fenceErasedScope(tx, d0, { accountId: ctx.accountId, mailboxId: target.mailboxId });
      const [d] = await d0.forUpdate(tx.select().from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)))
        .limit(1));
      if (!d) throw new ServiceError("not_found", 404, "draft not found");
      if (d.mailboxId !== target.mailboxId) {
        throw new ServiceError("conflict", 409, "the sender changed while scheduling; schedule it again");
      }
      refuseUnschedulable(d);
      const [mb] = await tx.select({ status: mailboxes.status, smtpMaxSizeBytes: mailboxes.smtpMaxSizeBytes })
        .from(mailboxes).where(eq(mailboxes.id, d.mailboxId)).limit(1);
      refuseDisabled(mb);
      await assertOrganizerRole(bridgeTx(tx), d0, ctx.accountId, d.mailboxId);
      refuseOverCap(total, capFor(mb?.smtpMaxSizeBytes));
      await d0.advisoryLock(tx, SCHEDULED_FILES_QUOTA_LOCK_CLASS, ctx.accountId);
      await refuseOverQuota(tx, ctx.accountId, draftId, { bytes: total, files: count }, keeping.quota);

      const sendKey = randomUUID();
      await dropScheduledFiles(tx, ctx.accountId, draftId);
      for (const row of rows) {
        // scoped-by: the account and mailbox fenced above; d is this account's draft, locked
        await tx.insert(scheduledSendFiles).values({ ...row, sendKey, mailboxId: d.mailboxId, createdAt: ctx.now() });
      }
      // scoped-by: d is the draft loaded by (id, accountId) above; the organizer was just asserted
      await tx.update(drafts).set({
        status: "scheduled", sendAt, sendKey, sendFiles: count, sendError: null, updatedAt: ctx.now(),
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
        .returning({ id: drafts.id, sendFiles: drafts.sendFiles });
      // The files go with the appointment; `send_files` stays as the mark that they were not kept.
      if (cancelled.length > 0 && cancelled[0]!.sendFiles > 0) await dropScheduledFiles(tx, ctx.accountId, draftId);

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
    // TOTAL, and refused BY NAME. `Date.parse` rolled February 30 into March 2 and read a time
    // with no offset in the server's zone, so a message left at a moment the person never chose.
    const read = readInstant(raw);
    if (!read.ok) throw new ServiceError("validation_failed", 400, instantRefusal("sendAt", read.why));
    const t = read.at.getTime();
    if (t <= now.getTime()) {
      throw new ServiceError("validation_failed", 400, "sendAt is in the past; pick a future time");
    }
    if (t > now.getTime() + SCHEDULE_MAX_AHEAD_MS) {
      throw new ServiceError("validation_failed", 400, "sendAt is more than a year away; pick a closer time");
    }
    return read.at;
  }

  /** Re-materialize the DTO (post-commit) and pair it with the emitted seq — `DraftsService.finish`. */
  private async finish(ctx: ServiceContext, id: string, seq: bigint): Promise<DraftMutation> {
    const draft = await materializeDraft(ctx.db, ctx.accountId, id);
    if (!draft) throw new ServiceError("internal", 500, "draft vanished after write");
    return { draft, seq: Number(seq) };
  }
}

export const scheduleService = new ScheduleService();
