import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  claimIdempotencyKey, drafts, mailboxes, messages, outboundSends, recordChange, threads, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import type { EmailAddress } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { IdempotencyRaceLost, ServiceError } from "./errors.js";
import { materializeDraft } from "./dto/materialize.js";
import type { DraftDTO } from "./dto/types.js";
import { DRAFT_HTML_CAP_BYTES, htmlByteLength, prepareOutboundBody } from "./outbound-html.js";
// The per-MESSAGE ceiling, imported rather than restated: two ceilings on one list that can
// disagree is how the reply-all regression happened. See {@link DRAFT_MAX_RECIPIENTS}.
import { SEND_MAX_RECIPIENTS } from "./send-service.js";

/**
 * For `create`: claim the idempotency row INSIDE the transaction that writes the draft.
 *
 * The caller supplies the response because the route's response is not the draft DTO â the
 * `POST /messages/:id/draft` route answers `202 { draftId }` â and the id only exists inside the
 * transaction. `response` is therefore a function of the row that was just written, evaluated
 * in-tx, exactly like `MessageService.move` stores its own materialized DTO in-tx.
 */
export interface DraftCreateIdempotency {
  key: string;
  requestHash: string;
  responseStatus: number;
  /**
   * `draft` is the row MATERIALIZED IN-TX, for the route whose response is the DTO itself
   * (`POST /drafts` answers 201 + the draft): a replay hands back the stored JSON verbatim,
   * so storing anything narrower than the original answer would make the replayed create a
   * different response â the adapter reads `id` off it and a missing field is a client-side
   * failure for a create that succeeded. The AI route keeps ignoring it (`202 {draftId}`).
   */
  response: (r: { draftId: string; seq: number; draft: DraftDTO }) => unknown;
}

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * How many addresses one recipient field may name (`to`, `cc`, `bcc` each). This bounds a STORED
 * COLUMN, not the send: the per-message ceiling is `SEND_MAX_RECIPIENTS` (500) in
 * `SendService.reserve`, where the count becomes one `RCPT TO` per address. It IS
 * `SEND_MAX_RECIPIENTS`, a correction: it was 100 per field on the reading that 100 is far above
 * what a person types — but Reply All copies the received audience into `to` and `cc`, so the
 * tighter ceiling refused a draft the product itself had just composed. Two ceilings on one list
 * must not disagree, so there is one number. Per field because this function sees one field;
 * `reserve` totals all three — the draft is storage, the send is the network.
 */
export const DRAFT_MAX_RECIPIENTS = SEND_MAX_RECIPIENTS;

/**
 * The longest ADDRESS one recipient entry may carry. 254, not 320 — the citation read properly:
 * RFC 5321 §4.5.3.1 gives 64 octets local + 255 domain (where 320 comes from), but the same
 * section caps the complete FORWARD PATH at 256 octets including the angle brackets, so a usable
 * mailbox is at most 254. Anything longer is not an address a transport will deliver; refusing it
 * here is telling the truth earlier. Measured in UTF-16 code units, which for SMTPUTF8 addresses
 * is LOOSER, deliberately: being generous costs a stored column and a bounce the transport would
 * send anyway, while being strict on a count that is not the RFC's would refuse addresses on the
 * wrong arithmetic.
 */
export const RECIPIENT_ADDRESS_MAX_CHARS = 254;

/**
 * The longest SUBJECT a draft may carry — a PRODUCT ceiling, not an RFC one. It was 998, on the
 * reading that RFC 5322 §2.1.1 caps a header line — but that is a LINE limit: a long subject is
 * legally FOLDED, Nodemailer folds on the way out, and a received message may carry one far
 * longer. `replySubject` inherits a received subject verbatim, so the 998 version refused the
 * first autosave of a reply to real mail. 8 192 characters instead — ours, deliberately generous;
 * its job is only to make the value BOUNDED so `POST /drafts` has a worst legal body that can be
 * calculated, which `input-bounds-census.test.ts` calculates against the request door.
 */
export const DRAFT_SUBJECT_MAX_CHARS = 8192;

/**
 * The longest DISPLAY NAME one recipient entry may carry. It exists because {@link
 * DRAFT_MAX_RECIPIENTS} bounds the COUNT and the entries were unbounded strings; together the two
 * make the recipient half of a draft body a computable maximum (`input-bounds-census.test.ts`).
 * 100, down from 200: raising the count ceiling to 500 multiplied the worst legal body by five,
 * and the census failed on the arithmetic. The resolution is what the fleet's smallest door
 * forces: the managed host caps requests at 4.5 MB, and 3 × 500 × (254 + 100) × 6 + 262 144 + 49
 * 152 ≈ 3.34 MB fits under both doors. 100 characters is a display NAME, so the shorter number
 * refuses nothing anybody sends.
 */
export const RECIPIENT_NAME_MAX_CHARS = 100;

export interface CreateDraftBody {
  mailboxId: string;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  subject?: string;
  /**
   * The text/plain body.
   *
   * Legal on its own â that is a plain draft, and the whole product worked that way until
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
   * Blind-carbon recipients. Stored on the draft and delivered on the SMTP ENVELOPE ONLY â never
   * written into the message headers of the delivered mail or the Sent-folder copy (see
   * `SendService.reserve` â `OutboundMessage.bcc`, and `imap.ts#send`). Omit or `[]` for none.
   */
  bcc?: EmailAddress[];
  /** The AI drafter's reasoning (3b). Null/omitted for manual compose. */
  rationale?: string | null;
}

/**
 * PUT/PATCH — any subset of the composable fields, `mailboxId` included. `mailboxId` was fixed
 * after create, which froze the sending IDENTITY at the first autosave: the row is born at the
 * first keystroke, so a From picked afterwards — the explicit selector, or the domain-match
 * switch that fires once recipients exist — changed the screen and nothing else, and the mail
 * left under whatever the picker held when typing began. The pick has to reach the row, so the
 * patch may move it: validated exactly like create (owned, not disabled), and refused with a 409
 * the moment the row has left `draft` — a send in flight keeps the identity it was reserved
 * under.
 */
export type PatchDraftBody = Partial<CreateDraftBody>;

/** A mutation's result: the DTO plus the change_log seq to echo as `X-Sync-Seq`. */
export interface DraftMutation {
  draft: DraftDTO;
  seq: number;
}

/**
 * DraftsService â MANUAL compose CRUD for `/drafts`. A draft is STORED and never
 * auto-sent (the AI drafter and the gated send are separate paths). Every
 * client-visible mutation runs ONE `db.transaction` that writes the `drafts` row
 * AND appends a `draft` change through the `change_log` seam SyncService reads
 * (in-tx) â so draft create/edit/delete surface in `/sync`. `materializeDraft`
 * means a `draft` change re-materializes to the live DTO rather than
 * tombstoning. Every query is scoped to `ctx.accountId`; a cross-account id
 * â 404. `create` validates the `mailboxId` belongs to the account.
 */
/**
 * THE OUTCOMES A PERSON CAN REPORT for a send this server could not confirm.
 *
 * Not a general "set the status" verb: these are the only two things a reader is in a position to
 * know, from the one place they can look. `arrived` means they found it in their Sent folder;
 * `not_arrived` means they looked and it is not there.
 */
export type SendResolution = "arrived" | "not_arrived";

/**
 * The statuses that mean "an attempt is still on record", and why there is exactly one list.
 * `pending` is an invocation live right now (or one that died holding the reservation);
 * `unverified` is the ambiguous ending — SMTP said nothing conclusive and the minted Message-ID
 * was not in Sent. Both are open questions about mail somebody may have received, and while one
 * stands the draft is the account's only copy. `sent` and `failed` are NOT here — the correction
 * this list records: they are LEDGER ENTRIES ABOUT THE PAST, and neither is a reason to keep the
 * text. The old predicate was "does a row exist", which made a definitively-failed send's draft
 * undeletable for ever.
 */
const SEND_ON_RECORD_STATUSES = ["pending", "unverified"] as const;

export class DraftsService {
  /**
   * Is an attempt still on record for this draft? One predicate, three callers. Takes `tx` rather
   * than `ctx` because every caller asks INSIDE the transaction about to act on the answer, after
   * taking `FOR UPDATE` on the draft row. That order is the whole race: `SendService.reserve`
   * inserts its reservation in another transaction, and that INSERT takes `FOR KEY SHARE` on the
   * draft for the foreign key. `FOR UPDATE` is the one row-lock mode that conflicts with it, so a
   * concurrent reserve either lands before this read (and is seen) or blocks until after the
   * caller commits. A predicate reading this table without that lock would answer about the past.
   */
  private async sendOnRecord(tx: Tx, accountId: string, draftId: string): Promise<boolean> {
    const [row] = await tx.select({ id: outboundSends.id }).from(outboundSends)
      .where(and(
        eq(outboundSends.draftId, draftId),
        eq(outboundSends.accountId, accountId),
        inArray(outboundSends.status, [...SEND_ON_RECORD_STATUSES]),
      ))
      .limit(1);
    return row !== undefined;
  }

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
    const subject = this.validSubject(body.subject);
    const rich = this.richBody(body.html, body.body);
    const text = rich ? rich.text : this.validString(body.body, "body");
    const html = rich ? rich.html : null;
    const to = this.validAddresses(body.to, "to");
    const cc = this.validAddresses(body.cc, "cc");
    const bcc = this.validAddresses(body.bcc, "bcc");
    this.boundRecipientTotal([to, cc, bcc]);
    const rationale = body.rationale ?? null;
    const now = ctx.now();

    const { id, seq, stored } = await asTx(ctx).transaction(async (tx) => {
      // Same order and same ownership rule as `update`: the reply-target thread is read
      // (key-share) BEFORE the draft row exists, and another account's thread id is a 404.
      if (body.threadId) {
        // KEY SHARE, and the strength travels with the call: it blocks a DELETE of the parent
        // without blocking ordinary updates to it, which is the whole reason this read is not the
        // exclusive lock. Promoting it while porting would serialize traffic this deliberately
        // lets past.
        const t = await dialect(ctx.db).forUpdate(
          tx.select({ id: threads.id }).from(threads)
            .where(and(eq(threads.id, body.threadId), eq(threads.accountId, ctx.accountId))),
          { mode: "key share" });
        if (t.length === 0) throw new ServiceError("not_found", 404, "thread not found");
      }
      await this.requireOwnedReplyTarget(tx, ctx, body.inReplyToMessageId ?? null);
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
      let inTx: DraftDTO | null = null;
      if (opts.idempotency) {
        // In-tx on purpose, TWICE over: the row only exists inside this transaction, and the
        // stored response must be the answer the FIRST request gives â so the first 201 also
        // RETURNS this snapshot rather than re-reading after commit, where a concurrent
        // mutation (a thread merge repointing the row) could make the live answer differ
        // from every later replay of the same key.
        inTx = await materializeDraft(tx as unknown as typeof ctx.db, ctx.accountId, row!.id);
        if (!inTx) throw new ServiceError("internal", 500, "draft vanished inside its own transaction");
        const draft = inTx;
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: opts.idempotency.responseStatus,
          responseJson: opts.idempotency.response({ draftId: row!.id, seq: Number(s), draft }),
          seq: Number(s),
          now,
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (the draft included) and `withIdempotency` replays the winner.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }
      return { id: row!.id, seq: s, stored: inTx };
    });

    // The idempotent path answers with the SNAPSHOT IT STORED â first response ≡ every replay.
    if (stored) return { draft: stored, seq: Number(seq) };
    return this.finish(ctx, id, seq);
  }

  /** PUT/PATCH /drafts/:id â full/partial edit of the composable fields. */
  async update(ctx: ServiceContext, id: string, patch: PatchDraftBody): Promise<DraftMutation> {
    // An edit answers a scheduled-send failure â the sentence must not outlive the words it was
    // about, so any edit clears it. A `scheduled` row itself refuses edits below.
    const set: Record<string, unknown> = { updatedAt: ctx.now(), sendError: null };
    // THE SENDING MAILBOX MOVES WITH THE PICK â validated exactly as create validates it
    // (owned, not disabled), and only while the row is still a draft: the status predicate
    // is on the UPDATE itself (below), so a row that a concurrent send has already flipped
    // to `sending` cannot have its identity rewritten between a read and a write here.
    const movesMailbox = patch.mailboxId !== undefined;
    if (movesMailbox) set.mailboxId = await this.validMailbox(ctx, patch.mailboxId);
    if (patch.subject !== undefined) set.subject = this.validSubject(patch.subject);
    const rich = this.richBody(patch.html, patch.body);
    if (rich) {
      set.html = rich.html;
      set.body = rich.text;
    } else {
      if (patch.html === null) set.html = null;
      if (patch.body !== undefined) {
        set.body = this.validString(patch.body, "body");
        // A PLAIN edit of a RICH draft is refused rather than resolved. Writing `body` alone
        // would leave the row holding two bodies that disagree â the html the sender still sees
        // in their editor, and the text every plaintext recipient would get â and silently
        // dropping the html to make them agree would delete formatting the user can see, in a
        // request that never mentioned it. Demoting a draft to plain text is legal and is spelt
        // out: send `html: null` in the SAME request.
        if (patch.html === undefined) await this.refuseIfRich(ctx, id);
      }
    }
    const patched: EmailAddress[][] = [];
    if (patch.to !== undefined) { const v = this.validAddresses(patch.to, "to"); set.to = v; patched.push(v); }
    if (patch.cc !== undefined) { const v = this.validAddresses(patch.cc, "cc"); set.cc = v; patched.push(v); }
    if (patch.bcc !== undefined) { const v = this.validAddresses(patch.bcc, "bcc"); set.bcc = v; patched.push(v); }
    this.boundRecipientTotal(patched);
    if (patch.threadId !== undefined) set.threadId = patch.threadId ?? null;
    if (patch.inReplyToMessageId !== undefined) set.inReplyToMessageId = patch.inReplyToMessageId ?? null;

    const seq = await asTx(ctx).transaction(async (tx) => {
      // A reply target moves FIRST, before the draft row is written: the FK check on the new
      // `thread_id` takes a key-share on the thread row, and every writer of a thread takes
      // thread rows before draft rows (the merge paths hold a thread FOR UPDATE while
      // repointing drafts) â the reversed order is a deadlock both sides pay as a 500. The
      // read is also the OWNERSHIP check the column never had: account isolation is absolute,
      // so another account's thread id is a 404, not a stored reference.
      if (patch.threadId) {
        const t = await dialect(ctx.db).forUpdate(
          tx.select({ id: threads.id }).from(threads)
            .where(and(eq(threads.id, patch.threadId), eq(threads.accountId, ctx.accountId))),
          { mode: "key share" });
        if (t.length === 0) throw new ServiceError("not_found", 404, "thread not found");
      }
      await this.requireOwnedReplyTarget(tx, ctx, patch.inReplyToMessageId ?? null);
      /**
       * An attempt still on record FREEZES the words, for the reason it blocks the discard:
       * somebody may already hold a copy of exactly these words, and editing them would leave the
       * account's only record of what was sent saying something never sent. `failed` and `sent`
       * are not on record, so this refuses only the `unverified` case — resolve it first. AFTER
       * the thread read and BEFORE the UPDATE: the class takes thread rows before draft rows, and
       * the reversed order is a deadlock. A `FOR UPDATE`, not a plain read: only `FOR UPDATE`
       * serializes against `reserve`'s `FOR KEY SHARE`.
       */
      const [locked] = await dialect(ctx.db).forUpdate(tx.select({ id: drafts.id }).from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId)))
        .limit(1));
      if (locked && await this.sendOnRecord(tx, ctx.accountId, id)) {
        throw new ServiceError(
          "send_recorded", 409,
          "this message has a send we could not confirm; resolve it before editing it",
        );
      }
      // Scope the UPDATE to the account: a cross-account id matches 0 rows. A mailbox move
      // additionally requires `status = 'draft'` IN THE PREDICATE — not a prior read — because
      // the send path flips the row to `sending` in its own transaction. A row WEARING AN
      // APPOINTMENT is FROZEN (mail 0077): what the worker sends must be exactly what the user
      // last saw. The predicate is `send_key IS NULL`, NOT `status <> 'scheduled'`: the worker's
      // claim flips the row to 'draft' with the key standing, and a status-only freeze would let
      // a stale client PUT win the row lock ahead of the reservation. The key covers every phase
      // of an appointment's life; an ordinary draft never carries one. The edit flow is cancel →
      // edit → schedule again, which re-mints the key, so "an edited message sends only its final
      // content" is structural.
      const updated = await tx.update(drafts).set(set)
        .where(and(
          eq(drafts.id, id), eq(drafts.accountId, ctx.accountId),
          ne(drafts.status, "scheduled"),
          isNull(drafts.sendKey),
          ...(movesMailbox ? [eq(drafts.status, "draft")] : []),
        ))
        .returning({ id: drafts.id });
      if (updated.length === 0) {
        // Zero rows is three different refusals, and they need different answers: a row that
        // does not exist (or is another account's) is the standing 404; a row wearing an
        // appointment is refused the EDIT with the way forward named; a row past `draft` is
        // refused the mailbox MOVE â so the caller learns the identity is fixed rather than
        // that the draft vanished.
        const [row] = await tx.select({ status: drafts.status, sendKey: drafts.sendKey }).from(drafts)
          .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId))).limit(1);
        if (row && (row.status === "scheduled" || row.sendKey !== null)) {
          throw new ServiceError(
            "conflict", 409,
            "this message is scheduled to send; cancel the schedule to edit it",
          );
        }
        if (row && movesMailbox) {
          throw new ServiceError(
            "conflict", 409,
            `the sending mailbox cannot change once a draft is '${row.status}'`,
          );
        }
        throw new ServiceError("not_found", 404, "draft not found");
      }
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: id, op: "update", meta: null,
      });
    });

    return this.finish(ctx, id, seq);
  }

  /**
   * A person answers for a send this server could not confirm. `finalizeUnverified` leaves the
   * draft at `unverified` ("check your Sent folder") — a question with nowhere to put the answer:
   * the row was frozen, keyed on STATUS. One transaction; lock order draft THEN its sends. Every
   * write is a compare-and-swap on `unverified`: a repeated resolve answers 200 with the row as
   * it stands; the other outcome arriving second cannot reopen the first (`not_arrived` after
   * `arrived` would manufacture a duplicate send). `arrived` → ledger and draft `sent`, row kept.
   * `not_arrived` → ledger `failed`, draft ordinary again; the next Send mints a fresh key.
   * Neither touches the IMAP mailbox: the mailbox is the master.
   */
  async resolve(ctx: ServiceContext, id: string, outcome: SendResolution): Promise<DraftMutation> {
    if (outcome !== "arrived" && outcome !== "not_arrived") {
      throw new ServiceError(
        "validation_failed", 400, "outcome must be 'arrived' or 'not_arrived'",
      );
    }
    const now = ctx.now();
    const seq = await asTx(ctx).transaction(async (tx) => {
      // The draft first — see the header: this is the row a concurrent reservation takes
      // `FOR KEY SHARE` on, and `FOR UPDATE` is the mode that conflicts with it.
      const [row] = await dialect(ctx.db).forUpdate(tx.select({ status: drafts.status }).from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId)))
        .limit(1));
      if (!row) throw new ServiceError("not_found", 404, "draft not found");

      const ledgerStatus = outcome === "arrived" ? "sent" : "failed";
      const settled = await tx.update(outboundSends)
        .set({ status: ledgerStatus, resolvedBy: "person", resolvedAt: now })
        .where(and(
          eq(outboundSends.draftId, id),
          eq(outboundSends.accountId, ctx.accountId),
          // THE COMPARE-AND-SWAP. Only an ambiguous attempt is a person's to settle.
          eq(outboundSends.status, "unverified"),
        ))
        .returning({ id: outboundSends.id });

      // Nothing ambiguous was on record: already resolved, or never held. The asked-for state, so
      // it is reported as success — and the `change_log` row is still emitted, because the caller
      // is entitled to a seq it can drain against whether or not this call was the one that moved
      // the row (`ScheduleService.cancel`'s idempotent arm does exactly this).
      if (settled.length === 0) {
        return recordChange(tx, {
          accountId: ctx.accountId, entityType: "draft", entityId: id, op: "update", meta: null,
        });
      }

      await tx.update(drafts)
        .set({
          status: outcome === "arrived" ? "sent" : "draft",
          // An appointment's failure sentence does not survive a resolution: it was about a
          // scheduled send that is now definitively over, and leaving it would put a stale
          // explanation on a row that has just become an ordinary draft.
          sendError: null,
          sendAt: null,
          sendKey: null,
          updatedAt: now,
        })
        .where(and(
          eq(drafts.id, id), eq(drafts.accountId, ctx.accountId),
          // The draft's OWN compare-and-swap — `finalizeSent`'s rule. A row somebody has already
          // recovered by hand must not be dragged back out of the state it is in.
          eq(drafts.status, "unverified"),
        ));

      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: id, op: "update", meta: null,
      });
    });

    return this.finish(ctx, id, seq);
  }

  async remove(ctx: ServiceContext, id: string): Promise<{ seq: number }> {
    const seq = await asTx(ctx).transaction(async (tx) => {
      /**
       * A send we could not confirm is refused by name; a finished one is not refused at all. The
       * reservation OUTLIVES every terminal outcome — the `outbound_sends` row makes a same-key
       * retry replay instead of delivering twice. This used to ask whether a row EXISTED,
       * conflating an open question (`pending`/`unverified`) with a ledger entry
       * (`sent`/`failed`) — a failed send's draft was undeletable. Nothing cascades: `draft_id`
       * is `ON DELETE SET NULL` (mail 0095). The row is locked FIRST — only `FOR UPDATE`
       * conflicts with `reserve`'s `FOR KEY SHARE`: the reserve committed first (409) or the
       * delete did (404). An appointment is refused below with the way forward.
       */
      const [held] = await dialect(ctx.db).forUpdate(
        tx.select({ status: drafts.status, sendKey: drafts.sendKey }).from(drafts)
          .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId)))
          .limit(1));
      if (held && held.status !== "scheduled" && held.sendKey === null) {
        if (await this.sendOnRecord(tx, ctx.accountId, id)) {
          throw new ServiceError(
            "send_recorded", 409,
            "this message has a send we could not confirm; resolve it before discarding it",
          );
        }
      }
      // A row WEARING AN APPOINTMENT refuses the delete with the way forward named, exactly as
      // `update` refuses the edit: cancel first. The predicate is `send_key IS NULL` for
      // `update`'s reason â the claim window ('draft', key standing) is precisely when a
      // DELETE that wins the row lock lands ahead of the reservation and destroys the record
      // of a send that is happening anyway. Cancel is the verb that is race-safe by
      // construction.
      const deleted = await tx.delete(drafts)
        .where(and(
          eq(drafts.id, id), eq(drafts.accountId, ctx.accountId),
          ne(drafts.status, "scheduled"),
          isNull(drafts.sendKey),
        ))
        .returning({ id: drafts.id });
      if (deleted.length === 0) {
        const [row] = await tx.select({ status: drafts.status, sendKey: drafts.sendKey }).from(drafts)
          .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId))).limit(1);
        if (row && (row.status === "scheduled" || row.sendKey !== null)) {
          throw new ServiceError(
            "conflict", 409,
            "this message is scheduled to send; cancel the schedule to discard it",
          );
        }
        throw new ServiceError("not_found", 404, "draft not found");
      }
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
   * The mailbox must exist, belong to the caller's account — AND still be connected. Ownership
   * alone let a draft be composed against a mailbox that can never send it; refusing at compose
   * means the user finds out while the text is still in front of them (`SendService.reserve`
   * holds the refusal that matters). `'error'` is DELIBERATELY ALLOWED: it is the sync worker's
   * word about IMAP, and SMTP is a separate transport — a mailbox that cannot be read may still
   * send. The same reasoning excludes `sync_blocked_reason`. Only `'disabled'` — the state a
   * human or a billing/lease decision put the row in — refuses.
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
   * The rich body, sanitized, with its text/plain alternative derived from what survived. Returns
   * `null` when the request carries no html — the plain-text path, byte-exact. The server DERIVES
   * `body`: a `multipart/alternative` promises its two parts say the same thing, and deriving one
   * from the other makes that structural — no request can express a disagreement. A `body` sent
   * ALONGSIDE html is a 400, never quietly overwritten. Sanitize, then measure, then derive: the
   * cap applies to what will be STORED, and the text half comes last, from the sanitized markup,
   * so nothing the sanitizer removed can reappear as words.
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
      // this line â see `0037_draft_html.sql` â and a 413 with a number in it is a sentence a
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
  /**
   * The reply target is the account's OWN message, or a 404. `drafts.in_reply_to_message_id`
   * carries a foreign key and nothing checked whose message it was. The unchecked edge is not
   * primarily disclosure (the id is stored, not dereferenced) but a WRITE into another account's
   * referential graph: the FK restricts, so a stranger's draft row pointing at a victim's message
   * makes deleting that message fail — and account erasure deletes messages: one stranger's row
   * can hold an erasure open, invisibly. Knowing an id is a precondition, not a defence —
   * isolation must be structural. A key-share read, so the FK check cannot race a concurrent
   * delete.
   */
  private async requireOwnedReplyTarget(
    tx: Tx, ctx: ServiceContext, messageId: string | null,
  ): Promise<void> {
    if (!messageId) return;
    const m = await dialect(ctx.db).forUpdate(
      tx.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId))),
      { mode: "key share" });
    if (m.length === 0) throw new ServiceError("not_found", 404, "reply target not found");
  }

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

  /**
   * The subject, type-checked and bounded — its own validator: the ceiling was briefly inside the
   * shared {@link validString}, and `body` goes through that too, so a plain-text draft with a
   * long body was refused about a limit that has nothing to do with it while a rich draft of the
   * same length passed. A bound that depends on the format the user chose is not a bound. The
   * plain body's ceiling is the request door and nothing else; the rich body has its own
   * (`DRAFT_HTML_CAP_BYTES`) — markup is where a megabyte hides, plain text is what a person
   * typed.
   */
  private validSubject(v: unknown): string {
    const subject = this.validString(v, "subject");
    if (subject.length > DRAFT_SUBJECT_MAX_CHARS) {
      throw new ServiceError(
        "validation_failed", 400,
        `subject is ${subject.length} characters; the limit is ${DRAFT_SUBJECT_MAX_CHARS}`,
      );
    }
    return subject;
  }

  /**
   * One recipient list, validated for SHAPE and for LENGTH. The shape half is original; the
   * length half was missing, and the sink made that matter: `SendService.reserve` hands
   * `to`/`cc`/`bcc` to Nodemailer entry by entry, so the number of SMTP `RCPT TO` commands one
   * send issues was whatever the request contained — three unbounded arrays, stored on a `PUT`
   * that costs nothing and replayed by every send. {@link DRAFT_MAX_RECIPIENTS} is per FIELD
   * because this function sees one field; the per-message total is `SEND_MAX_RECIPIENTS`, checked
   * where all three are in hand and become network commands.
   */
  /**
   * The recipient ceiling is a TOTAL over the request, not three per-field ones. {@link
   * DRAFT_MAX_RECIPIENTS} is {@link SEND_MAX_RECIPIENTS} so Reply All cannot compose a draft this
   * service refuses — but per FIELD that is 1 500 entries, measured at 4 832 016 wire bytes
   * against a door the slice exists to keep small. A total gives nothing up: 500 is a ceiling on
   * the MESSAGE, counted as `reserve` counts it; Reply All splits one audience across two fields,
   * never 500 in each. Not closed, said plainly: accumulation past 500 across several patches —
   * deliberate, because `reserve` totals all three where they become RCPT TO commands. The door's
   * question is how big one BODY may be.
   */
  private boundRecipientTotal(fields: ReadonlyArray<EmailAddress[] | undefined>): void {
    let total = 0;
    for (const f of fields) total += f?.length ?? 0;
    if (total > DRAFT_MAX_RECIPIENTS) {
      throw new ServiceError(
        "payload_too_large", 413,
        `this request names ${total} recipients across to, cc and bcc; the limit is ${DRAFT_MAX_RECIPIENTS}`,
      );
    }
  }

  private validAddresses(v: unknown, field: string): EmailAddress[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new ServiceError("validation_failed", 400, `${field} must be an array`);
    if (v.length > DRAFT_MAX_RECIPIENTS) {
      // 413 with the number, matching the html cap's refusal one method up: a sentence a person
      // can act on ("split this into two messages"), never a silently truncated recipient list.
      throw new ServiceError(
        "payload_too_large", 413,
        `${field} names ${v.length} recipients; the limit is ${DRAFT_MAX_RECIPIENTS} per field`,
      );
    }
    for (const a of v) {
      if (typeof a !== "object" || a === null || typeof (a as EmailAddress).address !== "string") {
        throw new ServiceError("validation_failed", 400, `${field} entries must be { name?, address }`);
      }
      // And each ENTRY is bounded, not just the list. The count was the obvious half; the entries
      // were unbounded strings, so `DRAFT_MAX_RECIPIENTS` bounded the megabytes only in the sense
      // that 100 of them is not 101. The address ceiling is not ours: RFC 5321 §4.5.3.1 caps the
      // complete FORWARD PATH at 256 octets including the brackets, so a usable mailbox is 254 —
      // the familiar 320 is the sum of component maxima that cannot all be met at once. Anything
      // longer is not an address a transport will deliver. The display name is the product's own
      // limit: generous for any real name, small enough that a hundred of them is a header, not a
      // payload.
      const entry = a as EmailAddress;
      if (entry.address.length > RECIPIENT_ADDRESS_MAX_CHARS) {
        throw new ServiceError(
          "validation_failed", 400,
          `a ${field} address is ${entry.address.length} characters; the limit is ${RECIPIENT_ADDRESS_MAX_CHARS}`,
        );
      }
      if (typeof entry.name === "string" && entry.name.length > RECIPIENT_NAME_MAX_CHARS) {
        throw new ServiceError(
          "validation_failed", 400,
          `a ${field} display name is ${entry.name.length} characters; the limit is ${RECIPIENT_NAME_MAX_CHARS}`,
        );
      }
    }
    return v as EmailAddress[];
  }
}

export const draftsService = new DraftsService();
