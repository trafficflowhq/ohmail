import { and, eq } from "drizzle-orm";
import { claimIdempotencyKey, drafts, mailboxes, recordChange, threads, type Tx } from "@trafficflow/db";
import type { EmailAddress } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { IdempotencyRaceLost, ServiceError } from "./errors.js";
import { materializeDraft } from "./dto/materialize.js";
import type { DraftDTO } from "./dto/types.js";
import { DRAFT_HTML_CAP_BYTES, htmlByteLength, prepareOutboundBody } from "./outbound-html.js";

/**
 * For `create`: claim the idempotency row INSIDE the transaction that writes the draft.
 *
 * The caller supplies the response because the route's response is not the draft DTO — the
 * `POST /messages/:id/draft` route answers `202 { draftId }` — and the id only exists inside the
 * transaction. `response` is therefore a function of the row that was just written, evaluated
 * in-tx, exactly like `MessageService.move` stores its own materialized DTO in-tx.
 */
export interface DraftCreateIdempotency {
  key: string;
  requestHash: string;
  responseStatus: number;
  response: (r: { draftId: string; seq: number }) => unknown;
}

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

export interface CreateDraftBody {
  mailboxId: string;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  subject?: string;
  /**
   * The text/plain body.
   *
   * Legal on its own — that is a plain draft, and the whole product worked that way until
   * rich compose. Illegal ALONGSIDE a non-null {@link html}: see {@link DraftsService.richBody}
   * for why the server derives it instead of accepting it.
   */
  body?: string;
  /**
   * The rich body, as the editor produced it. Sanitized before it is stored; `body` is then
   * DERIVED from what survived. Omit or send `null` for a plain-text draft.
   */
  html?: string | null;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  /**
   * Blind-carbon recipients. Stored on the draft and delivered on the SMTP ENVELOPE ONLY — never
   * written into the message headers of the delivered mail or the Sent-folder copy (see
   * `SendService.reserve` → `OutboundMessage.bcc`, and `imap.ts#send`). Omit or `[]` for none.
   */
  bcc?: EmailAddress[];
  /** The AI drafter's reasoning (3b). Null/omitted for manual compose. */
  rationale?: string | null;
}

/**
 * PUT/PATCH — any subset of the composable fields, `mailboxId` included.
 *
 * `mailboxId` was fixed after create, and that froze the sending IDENTITY at the first
 * autosave: the row is born at the first keystroke, so a From picked afterwards — the
 * explicit selector, or the domain-match switch that fires only once recipients exist —
 * changed the screen and nothing else, and the mail left under whatever the picker held
 * when typing began. The pick has to reach the row, so the patch may move it: validated
 * exactly like create (owned, not disabled), and refused with a 409 the moment the row
 * has left `draft` — a send in flight, or already out, keeps the identity it was
 * reserved under (see {@link DraftsService.update}).
 */
export type PatchDraftBody = Partial<CreateDraftBody>;

/** A mutation's result: the DTO plus the change_log seq to echo as `X-Sync-Seq`. */
export interface DraftMutation {
  draft: DraftDTO;
  seq: number;
}

/**
 * DraftsService — MANUAL compose CRUD for `/drafts`. A draft is STORED and never
 * auto-sent (the AI drafter and the gated send are separate paths). Every
 * client-visible mutation runs ONE `db.transaction` that writes the `drafts` row
 * AND appends a `draft` change through the `change_log` seam SyncService reads
 * (in-tx) — so draft create/edit/delete surface in `/sync`. `materializeDraft`
 * means a `draft` change re-materializes to the live DTO rather than
 * tombstoning. Every query is scoped to `ctx.accountId`; a cross-account id
 * → 404. `create` validates the `mailboxId` belongs to the account.
 */
export class DraftsService {
  async get(ctx: ServiceContext, id: string): Promise<DraftDTO> {
    const dto = await materializeDraft(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("not_found", 404, "draft not found");
    return dto;
  }

  async create(
    ctx: ServiceContext,
    body: CreateDraftBody,
    opts: { idempotency?: DraftCreateIdempotency } = {},
  ): Promise<DraftMutation> {
    const mailboxId = await this.validMailbox(ctx, body.mailboxId);
    const subject = this.validString(body.subject, "subject");
    const rich = this.richBody(body.html, body.body);
    const text = rich ? rich.text : this.validString(body.body, "body");
    const html = rich ? rich.html : null;
    const to = this.validAddresses(body.to, "to");
    const cc = this.validAddresses(body.cc, "cc");
    const bcc = this.validAddresses(body.bcc, "bcc");
    const rationale = body.rationale ?? null;
    const now = ctx.now();

    const { id, seq } = await asTx(ctx).transaction(async (tx) => {
      // Same order and same ownership rule as `update`: the reply-target thread is read
      // (key-share) BEFORE the draft row exists, and another account's thread id is a 404.
      if (body.threadId) {
        const t = await tx.select({ id: threads.id }).from(threads)
          .where(and(eq(threads.id, body.threadId), eq(threads.accountId, ctx.accountId)))
          .for("key share");
        if (t.length === 0) throw new ServiceError("not_found", 404, "thread not found");
      }
      const [row] = await tx.insert(drafts).values({
        accountId: ctx.accountId,
        mailboxId,
        threadId: body.threadId ?? null,
        inReplyToMessageId: body.inReplyToMessageId ?? null,
        subject, body: text, html, to, cc, bcc, rationale,
        status: "draft",
        createdAt: now, updatedAt: now,
      }).returning({ id: drafts.id });
      const s = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: row!.id, op: "create", meta: null,
      });
      // The stored response commits atomically with the draft, closing the
      // commit-then-crash window in which a retry would store a SECOND draft.
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: opts.idempotency.responseStatus,
          responseJson: opts.idempotency.response({ draftId: row!.id, seq: Number(s) }),
          seq: Number(s),
          now,
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (the draft included) and `withIdempotency` replays the winner.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }
      return { id: row!.id, seq: s };
    });

    return this.finish(ctx, id, seq);
  }

  /** PUT/PATCH /drafts/:id — full/partial edit of the composable fields. */
  async update(ctx: ServiceContext, id: string, patch: PatchDraftBody): Promise<DraftMutation> {
    const set: Record<string, unknown> = { updatedAt: ctx.now() };
    // THE SENDING MAILBOX MOVES WITH THE PICK — validated exactly as create validates it
    // (owned, not disabled), and only while the row is still a draft: the status predicate
    // is on the UPDATE itself (below), so a row that a concurrent send has already flipped
    // to `sending` cannot have its identity rewritten between a read and a write here.
    const movesMailbox = patch.mailboxId !== undefined;
    if (movesMailbox) set.mailboxId = await this.validMailbox(ctx, patch.mailboxId);
    if (patch.subject !== undefined) set.subject = this.validString(patch.subject, "subject");
    const rich = this.richBody(patch.html, patch.body);
    if (rich) {
      set.html = rich.html;
      set.body = rich.text;
    } else {
      if (patch.html === null) set.html = null;
      if (patch.body !== undefined) {
        set.body = this.validString(patch.body, "body");
        // A PLAIN edit of a RICH draft is refused rather than resolved. Writing `body` alone
        // would leave the row holding two bodies that disagree — the html the sender still sees
        // in their editor, and the text every plaintext recipient would get — and silently
        // dropping the html to make them agree would delete formatting the user can see, in a
        // request that never mentioned it. Demoting a draft to plain text is legal and is spelt
        // out: send `html: null` in the SAME request.
        if (patch.html === undefined) await this.refuseIfRich(ctx, id);
      }
    }
    if (patch.to !== undefined) set.to = this.validAddresses(patch.to, "to");
    if (patch.cc !== undefined) set.cc = this.validAddresses(patch.cc, "cc");
    if (patch.bcc !== undefined) set.bcc = this.validAddresses(patch.bcc, "bcc");
    if (patch.threadId !== undefined) set.threadId = patch.threadId ?? null;
    if (patch.inReplyToMessageId !== undefined) set.inReplyToMessageId = patch.inReplyToMessageId ?? null;

    const seq = await asTx(ctx).transaction(async (tx) => {
      // A reply target moves FIRST, before the draft row is written: the FK check on the new
      // `thread_id` takes a key-share on the thread row, and every writer of a thread takes
      // thread rows before draft rows (the merge paths hold a thread FOR UPDATE while
      // repointing drafts) — the reversed order is a deadlock both sides pay as a 500. The
      // read is also the OWNERSHIP check the column never had: account isolation is absolute,
      // so another account's thread id is a 404, not a stored reference.
      if (patch.threadId) {
        const t = await tx.select({ id: threads.id }).from(threads)
          .where(and(eq(threads.id, patch.threadId), eq(threads.accountId, ctx.accountId)))
          .for("key share");
        if (t.length === 0) throw new ServiceError("not_found", 404, "thread not found");
      }
      // Scope the UPDATE to the account: a cross-account id matches 0 rows. A mailbox move
      // additionally requires `status = 'draft'` IN THE PREDICATE — not in a prior read —
      // because the send path flips the row to `sending` in its own transaction, and a check
      // that ran before this UPDATE took the row lock would let the move land on a row whose
      // send is already reserved under the old identity.
      const updated = await tx.update(drafts).set(set)
        .where(and(
          eq(drafts.id, id), eq(drafts.accountId, ctx.accountId),
          ...(movesMailbox ? [eq(drafts.status, "draft")] : []),
        ))
        .returning({ id: drafts.id });
      if (updated.length === 0) {
        if (movesMailbox) {
          // Zero rows is two different refusals, and they need different answers: a row that
          // does not exist (or is another account's) is the standing 404; a row past `draft`
          // exists and is refused the MOVE — 409, so the caller learns the identity is fixed
          // rather than that the draft vanished.
          const [row] = await tx.select({ status: drafts.status }).from(drafts)
            .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId))).limit(1);
          if (row) {
            throw new ServiceError(
              "conflict", 409,
              `the sending mailbox cannot change once a draft is '${row.status}'`,
            );
          }
        }
        throw new ServiceError("not_found", 404, "draft not found");
      }
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: id, op: "update", meta: null,
      });
    });

    return this.finish(ctx, id, seq);
  }

  async remove(ctx: ServiceContext, id: string): Promise<{ seq: number }> {
    const seq = await asTx(ctx).transaction(async (tx) => {
      const deleted = await tx.delete(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId)))
        .returning({ id: drafts.id });
      if (deleted.length === 0) throw new ServiceError("not_found", 404, "draft not found");
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: id, op: "delete", meta: null,
      });
    });
    return { seq: Number(seq) };
  }

  /** Re-materialize the DTO (post-commit) and pair it with the emitted seq. */
  private async finish(ctx: ServiceContext, id: string, seq: bigint): Promise<DraftMutation> {
    const draft = await materializeDraft(ctx.db, ctx.accountId, id);
    if (!draft) throw new ServiceError("internal", 500, "draft vanished after write");
    return { draft, seq: Number(seq) };
  }

  /**
   * The mailbox must exist, belong to the caller's account — AND still be
   * connected.
   *
   * ── WHY STATUS BELONGS HERE AND NOT ONLY AT SEND ──────────────────────────────────────────
   *
   * This used to check ownership alone, which let a draft be composed against a mailbox that
   * can never send it. The send path is where that becomes destructive (see `SendService.
   * reserve`, which holds the refusal that actually matters), but refusing at compose is the
   * difference between "you cannot pick this sender" and "we accepted your message and then
   * could not send it". The user finds out while they still have the text in front of them.
   *
   * `'error'` is DELIBERATELY ALLOWED. It is the sync worker's word about IMAP — written by
   * `markMailboxFailed`, cleared by the worker itself on recovery — and SMTP is a separate
   * transport: a mailbox that cannot be read may still be able to send, and an `error` a user
   * cannot clear would strand their outbox on a transient fault they did not cause. The same
   * reasoning excludes `sync_blocked_reason`, which `markMailboxSyncBlocked` writes WITHOUT
   * touching `status` precisely because it is a note about our infrastructure, not the mailbox.
   * Only `'disabled'` — the state a human or a billing/lease decision put the row in — refuses.
   */
  private async validMailbox(ctx: ServiceContext, v: unknown): Promise<string> {
    if (typeof v !== "string" || v.length === 0) {
      throw new ServiceError("validation_failed", 400, "mailboxId is required");
    }
    const [mb] = await ctx.db.select({ id: mailboxes.id, status: mailboxes.status }).from(mailboxes)
      .where(and(eq(mailboxes.id, v), eq(mailboxes.accountId, ctx.accountId))).limit(1);
    if (!mb) throw new ServiceError("validation_failed", 400, "mailboxId does not belong to this account");
    if (mb.status === "disabled") {
      throw new ServiceError(
        "validation_failed", 400,
        "This mailbox is disconnected and cannot send. Reconnect it, or pick another sender.",
      );
    }
    return mb.id;
  }

  /**
   * The rich body, sanitized, with its text/plain alternative derived from what survived.
   *
   * Returns `null` when the request carries no html at all, which is the plain-text path and is
   * left byte-exact — the compose surface that has always sent a string still sends one, and
   * nothing about it changes.
   *
   * ── WHY THE SERVER DERIVES `body` INSTEAD OF ACCEPTING IT ────────────────────────────────
   *
   * A `multipart/alternative` is a promise that its two parts say the same thing. If both parts
   * arrive from the client, that promise is a convention two codebases have to keep, and the
   * first client that gets it wrong ships a message whose plaintext readers see something its
   * html readers do not — including the case that matters, where the html says one thing and
   * the text says another to the same person on two devices. Deriving one from the other makes
   * the promise structural: there is no request that can express a disagreement.
   *
   * So a `body` sent ALONGSIDE html is a `400` rather than something quietly overwritten.
   * Ignoring it would make a client that believes it is setting the plain part indistinguishable
   * from one that is not, and the symptom would appear only in somebody's inbox.
   *
   * ── THE ORDER IS SANITIZE, THEN MEASURE, THEN DERIVE ─────────────────────────────────────
   *
   * The cap is applied to what will be STORED, not to what arrived: a request whose markup is
   * mostly attributes the allowlist strips is not over the limit, and refusing it on its raw
   * length would reject a message the database would have accepted. The text half is derived
   * last, from the sanitized markup, so nothing the sanitizer removed can reappear as words.
   */
  private richBody(html: unknown, body: unknown): { html: string; text: string } | null {
    if (html === undefined || html === null) return null;
    if (typeof html !== "string") {
      throw new ServiceError("validation_failed", 400, "html must be a string or null");
    }
    if (body !== undefined) {
      throw new ServiceError(
        "validation_failed", 400,
        "body is derived from html on the server; send one or the other, not both",
      );
    }
    const prepared = prepareOutboundBody(html);
    const size = htmlByteLength(prepared.html);
    if (size > DRAFT_HTML_CAP_BYTES) {
      // Refused HERE so the constraint never has to. `drafts_html_cap` is the tripwire behind
      // this line — see `0037_draft_html.sql` — and a 413 with a number in it is a sentence a
      // person can act on, where a constraint violation is a 500 they cannot.
      throw new ServiceError(
        "draft_too_large", 413,
        `this message is ${size} bytes of formatted text; the limit is ${DRAFT_HTML_CAP_BYTES}`,
      );
    }
    return prepared;
  }

  /**
   * Refuse a plain-only edit of a draft that currently holds html.
   *
   * A separate read rather than a predicate on the UPDATE, because the two outcomes need
   * different answers: a row that does not exist is the existing 404 (which the UPDATE below
   * still produces), and a row that exists but is rich is a 400 explaining what to send instead.
   * A `WHERE html IS NULL` added to the update would collapse both into "not found".
   */
  private async refuseIfRich(ctx: ServiceContext, id: string): Promise<void> {
    const [row] = await ctx.db.select({ html: drafts.html }).from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId))).limit(1);
    if (row?.html != null) {
      throw new ServiceError(
        "validation_failed", 400,
        "this draft holds formatted text; send html, or send html: null to make it plain",
      );
    }
  }

  private validString(v: unknown, field: string): string {
    if (v === undefined) return "";
    if (typeof v !== "string") throw new ServiceError("validation_failed", 400, `${field} must be a string`);
    return v;
  }

  private validAddresses(v: unknown, field: string): EmailAddress[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new ServiceError("validation_failed", 400, `${field} must be an array`);
    for (const a of v) {
      if (typeof a !== "object" || a === null || typeof (a as EmailAddress).address !== "string") {
        throw new ServiceError("validation_failed", 400, `${field} entries must be { name?, address }`);
      }
    }
    return v as EmailAddress[];
  }
}

export const draftsService = new DraftsService();
