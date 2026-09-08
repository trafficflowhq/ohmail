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
 * HOW MANY ADDRESSES ONE RECIPIENT FIELD MAY NAME (`to`, `cc`, `bcc` each).
 *
 * ── THIS BOUNDS A STORED COLUMN. IT IS NOT THE SEND'S BOUND ──────────────────────────────
 *
 * Each of the three fields is a `jsonb` column written by an autosaving compose surface, and
 * before this they were unbounded: `validAddresses` checked every entry's SHAPE and never its
 * count. What this number says is that a single request naming more than 100 addresses in one
 * field is not a compose gesture, and that is all it says.
 *
 * **The per-MESSAGE ceiling is `SEND_MAX_RECIPIENTS` (500), enforced in `SendService.reserve`**,
 * because that is where the count stops being a column and becomes one `RCPT TO` command per
 * address on a held SMTP socket. The two bounds are separate because they are about two different
 * costs, and deriving this one from a per-message provider limit would be a rationale that does
 * not match its enforcement: three fields at 100 is 300, which Outlook and iCloud deliver and
 * Gmail does not — a per-field cap cannot express a per-message policy, so it does not try to.
 *
 * ── IT IS `SEND_MAX_RECIPIENTS`, AND THAT IS A CORRECTION ────────────────────────────────
 *
 * This was 100 per field, on the reading that 100 is *"far above what a person types into a
 * field"*. A person, yes — but a person is not the only producer. **Reply All copies the
 * received audience into `to` and `cc`** (`apps/webapp/app/shell/compose-from.ts`), and a message
 * may legally arrive with more than 100 addresses in `To:` while still being under the 500 this
 * product will SEND. So the tighter ceiling refused a draft the product itself had just composed,
 * from a message it had just accepted — the fourth time in this slice a bound was written from a
 * comment about human behaviour rather than from the code producing the value, and the one that
 * reached furthest into the product before a review round caught it.
 *
 * Two ceilings on the same list must not disagree, so there is one number: a draft may hold what
 * a send may carry. The per-field check stays per field because this function sees one field —
 * a total computed here would have to guess at the two fields a partial update does not carry —
 * and `SendService.reserve` still totals all three where they become RCPT TO commands. A field
 * at the ceiling therefore passes here and the message may still be refused there, which is the
 * honest order: the draft is storage, the send is the network.
 */
export const DRAFT_MAX_RECIPIENTS = SEND_MAX_RECIPIENTS;

/**
 * The longest ADDRESS one recipient entry may carry.
 *
 * **254, not 320, and the difference is the citation being read properly.** RFC 5321 §4.5.3.1
 * gives 64 octets for the local part and 255 for the domain, which is where 320 comes from — but
 * the same section caps the complete FORWARD PATH at 256 octets *including* the angle brackets,
 * so a usable mailbox is at most 254 and the two component maxima cannot both be met. Anything
 * longer is not an address a transport will deliver, so refusing it here is telling the truth
 * earlier.
 *
 * Measured in UTF-16 code units (what `.length` returns) rather than octets, and for a non-ASCII
 * SMTPUTF8 address that is LOOSER, not stricter: 200 two-byte characters are 200 to `.length` and
 * about 400 octets, so such an address passes a guard the RFC would refuse. The direction is
 * deliberate — being generous here costs a stored column and a bounce the transport was going to
 * send anyway, while being strict on a count that is not the RFC's would refuse addresses on the
 * wrong arithmetic. A proper octet validator belongs with address parsing, not with a bound whose
 * job is to stop the unbounded case.
 */
export const RECIPIENT_ADDRESS_MAX_CHARS = 254;

/**
 * The longest SUBJECT a draft may carry — a PRODUCT ceiling, not an RFC one.
 *
 * ── WHY IT IS NOT 998 ────────────────────────────────────────────────────────────────────
 *
 * It was, on the reading that RFC 5322 §2.1.1 makes 998 octets the maximum length of a header
 * line and a subject is one header. That is a LINE limit: a long subject is legally FOLDED
 * across several lines, Nodemailer folds on the way out, and a received message may carry one
 * far longer than 998. `replySubject` inherits a received subject verbatim, so the 998 version
 * refused the first autosave of a reply to real mail — a bound that breaks replying to a message
 * this product already accepted.
 *
 * 8 192 characters instead. Ours, deliberately generous, and its job is only to make the value
 * BOUNDED: with the html cap, the recipient caps and this one, `POST /drafts` has a worst legal
 * body that can be calculated, and `input-bounds-census.test.ts` calculates it against the
 * request door. Before it, `subject` reached a stored column with no ceiling of any kind and the
 * door's own derivation was fiction.
 */
export const DRAFT_SUBJECT_MAX_CHARS = 8192;

/**
 * The longest DISPLAY NAME one recipient entry may carry.
 *
 * The reason it exists at all is that {@link DRAFT_MAX_RECIPIENTS} bounds the COUNT and the
 * entries were unbounded strings — so the request's SIZE was still the caller's to choose.
 * Together the two make the recipient half of a draft body a computable maximum, which is what
 * `input-bounds-census.test.ts` checks against the request door's own ceiling.
 *
 * **100, and it was 200 until the count ceiling moved.** Raising {@link DRAFT_MAX_RECIPIENTS}
 * from 100 to 500 (so Reply All cannot compose a draft this service refuses) multiplied the worst
 * legal body by five, and the census — which recomputes that product rather than trusting it —
 * failed with the arithmetic: 5 732 016 bytes against a 3 MiB door. That is the census doing the
 * job it exists for, on the very first change made after it was written.
 *
 * The resolution is the one the fleet's smallest door forces. The managed host is capped by the
 * platform at 4.5 MB whatever we write, so the worst legal body has to clear THAT, not just our
 * own number — a door we set above the platform's would certify a compatibility the deployment
 * does not have. 3 × 500 × (254 + 100) × 6 + 262 144 + 49 152 ≈ 3.34 MB fits under both the
 * 4 MiB door and the platform's ceiling, with headroom.
 *
 * 100 characters is a display NAME — a person's or an organisation's — so the shorter number
 * refuses nothing anybody sends. The address keeps its RFC-derived 254; that one is not ours to
 * trade against a body size.
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
 * PUT/PATCH â any subset of the composable fields, `mailboxId` included.
 *
 * `mailboxId` was fixed after create, and that froze the sending IDENTITY at the first
 * autosave: the row is born at the first keystroke, so a From picked afterwards â the
 * explicit selector, or the domain-match switch that fires only once recipients exist â
 * changed the screen and nothing else, and the mail left under whatever the picker held
 * when typing began. The pick has to reach the row, so the patch may move it: validated
 * exactly like create (owned, not disabled), and refused with a 409 the moment the row
 * has left `draft` â a send in flight, or already out, keeps the identity it was
 * reserved under (see {@link DraftsService.update}).
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
 * THE STATUSES THAT MEAN "AN ATTEMPT IS STILL ON RECORD", and the reason there is exactly one list.
 *
 * `pending` is an invocation that is live right now (or one that died holding the reservation);
 * `unverified` is the ambiguous ending — SMTP said nothing conclusive and the minted Message-ID was
 * not in Sent. Both are open questions about mail that may or may not have gone out, and while one
 * stands, the draft is the account's only copy of a message somebody may have received.
 *
 * `sent` and `failed` are NOT here, and that is the correction this list exists to record. They are
 * LEDGER ENTRIES ABOUT THE PAST — one delivery this server watched succeed, one it watched fail —
 * and neither is a reason to keep the text. The predicate used to be "does a row exist", which
 * conflated the two kinds of fact and made a definitively-failed send's draft undeletable for ever.
 */
const SEND_ON_RECORD_STATUSES = ["pending", "unverified"] as const;

export class DraftsService {
  /**
   * IS AN ATTEMPT STILL ON RECORD FOR THIS DRAFT? One predicate, three callers.
   *
   * Takes `tx` rather than `ctx` because every caller asks INSIDE the transaction that is about to
   * act on the answer, and after taking `FOR UPDATE` on the draft row. That order is the whole
   * race: `SendService.reserve` inserts its reservation in another transaction, and that INSERT
   * takes `FOR KEY SHARE` on the draft for the foreign key. `FOR UPDATE` is the one row-lock mode
   * that conflicts with it, so a reserve committing concurrently either lands before this read
   * (and is seen) or blocks until after the caller has committed. A predicate that read this table
   * without that lock held would answer about the past.
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
       * ── AN ATTEMPT STILL ON RECORD FREEZES THE WORDS, for the reason it blocks the discard ──
       *
       * `remove` and `update` ask the SAME question ({@link sendOnRecord}) because a message whose
       * fate is unknown has one property that decides both: somebody may already be holding a
       * copy of exactly these words. Editing them would leave the account's only record of what
       * was sent saying something that was never sent — and if the reader then resolves the row
       * `arrived`, the lie is what gets filed as delivered.
       *
       * `failed` and `sent` are not on record ({@link SEND_ON_RECORD_STATUSES}), so this refuses
       * nothing it used to allow except the one case it is about: an `unverified` row. Resolve it
       * first — `not_arrived` returns the row to an ordinary draft and editing is open again.
       *
       * AFTER the thread read and BEFORE the UPDATE, deliberately. The class takes thread rows
       * before draft rows (the merge paths hold a thread `FOR UPDATE` while repointing drafts) and
       * the reversed order is a deadlock both sides pay as a 500 — so the draft lock cannot move
       * above `patch.threadId`'s key-share. It has to be a `FOR UPDATE` and not a plain read for
       * `remove`'s reason: `SendService.reserve` takes `FOR KEY SHARE` on this row, and only
       * `FOR UPDATE` serializes against it.
       */
      const [locked] = await tx.select({ id: drafts.id }).from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId)))
        .for("update").limit(1);
      if (locked && await this.sendOnRecord(tx, ctx.accountId, id)) {
        throw new ServiceError(
          "send_recorded", 409,
          "this message has a send we could not confirm; resolve it before editing it",
        );
      }
      // Scope the UPDATE to the account: a cross-account id matches 0 rows. A mailbox move
      // additionally requires `status = 'draft'` IN THE PREDICATE â not in a prior read â
      // because the send path flips the row to `sending` in its own transaction, and a check
      // that ran before this UPDATE took the row lock would let the move land on a row whose
      // send is already reserved under the old identity.
      // A row WEARING AN APPOINTMENT is FROZEN (mail 0077): what the worker sends must be
      // exactly what the user last saw when they pressed "Send later", and an edit landing
      // while the claim is picking the row up would send words nobody reviewed at the time
      // they chose. The predicate is `send_key IS NULL`, NOT `status <> 'scheduled'`, because
      // the claim window is the case that matters: the worker's claim flips the row to
      // 'draft' with the key standing, and a status-only freeze would let a stale client PUT
      // win the row lock ahead of the reservation and change the content that sends. The key
      // covers every phase of an appointment's life ('scheduled', the claim window, and
      // 'sending' up to the finalizer that clears it) and nothing else â an ordinary draft
      // never carries one. The edit flow is cancel â edit â schedule again, which re-mints
      // the key, so "an edited message sends only its final content" is structural rather
      // than a race. In the PREDICATE, not a prior read, for the same reason the mailbox
      // move's status check is.
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
   * A PERSON ANSWERS FOR A SEND THIS SERVER COULD NOT CONFIRM.
   *
   * ── WHY THE PRODUCT NEEDED A VERB HERE AT ALL ───────────────────────────────────────────────
   *
   * `finalizeUnverified` is the honest ending for an attempt whose outcome is genuinely unknown:
   * SMTP said nothing conclusive and the minted Message-ID was not in Sent. It leaves the draft at
   * `unverified` and the row says so — *"it may not have been delivered … check your Sent folder."*
   *
   * That sentence asks the reader a question, and until now there was nowhere to put the answer.
   * The row was frozen: Discard refused it, the client parked it, and the state was permanent
   * because it was keyed on STATUS and nothing ever moved the status. A reader who checked their
   * Sent folder, found the message, and came back had no way to say so — which is the whole defect.
   * `SEND_LOCK_TTL_MS` does not help: a 7-day lock expiring does not decide what happened.
   *
   * ── ONE TRANSACTION, AND THE LOCK ORDER IS THE DRAFT THEN ITS SENDS ─────────────────────────
   *
   * `FOR UPDATE` on the draft first, exactly as `remove` does and for the same reason: it is the
   * row `SendService.reserve` takes `FOR KEY SHARE` on, so taking it here serializes this verb
   * against a reservation arriving concurrently. Then the sends, so a second resolve (or a
   * reconciling pass) cannot interleave between the read and the write.
   *
   * ── AND EVERY WRITE IS A COMPARE-AND-SWAP ON `unverified` ───────────────────────────────────
   *
   * The three finalizers all guard their writes on the status they expect to find
   * (`SendService.finalizeSent`'s rule: exactly one resolver writes a terminal state), and this is
   * a fourth resolver, so it obeys the same discipline. `'unverified' → …` in the predicate means:
   *
   *  · a REPEATED resolve matches nothing and is the asked-for state — idempotent success, on
   *    `ScheduleService.cancel`'s terms. It answers 200 with the row as it stands rather than an
   *    error about a decision that has already been made, because the honest reading of a
   *    double-tap or a retry after a blip is that the caller wants the state it asked for.
   *  · the OTHER outcome arriving second cannot reopen the first. Without the predicate,
   *    `not_arrived` after `arrived` would turn a delivery the person had already confirmed back
   *    into an unsent draft — the one direction that manufactures a duplicate send.
   *  · a reconciler that finalizes `sent` while a person is answering `not_arrived` wins or loses
   *    cleanly; neither overwrites the other's terminal word.
   *
   * The draft's own status write is guarded on `unverified` for the same reason: winning the
   * ledger's CAS says what became of the SEND, and this says the row is still the held one nobody
   * has moved.
   *
   * ── WHAT EACH OUTCOME LEAVES BEHIND ─────────────────────────────────────────────────────────
   *
   * `arrived` → the ledger row is `sent` and the draft is `sent`. The draft row is NOT deleted:
   * the mail itself is the copy in the user's Sent folder, and this row is the account's record of
   * having sent it, which is what every other terminal send leaves too. It leaves the Drafts list
   * because the list shows `draft`/`unverified`/interrupted rows, not sent ones.
   *
   * `not_arrived` → the ledger row is `failed` and the draft is an ORDINARY DRAFT again: editable,
   * discardable, and `send_error` cleared because the sentence was about an appointment that is no
   * longer pending. The next Send mints a fresh key rather than replaying this one, because
   * `failed` is terminal for this key and the client releases the durable key on any terminal
   * outcome — so "it didn't arrive, send it again" is a genuinely new delivery and not a replay of
   * a refusal.
   *
   * Neither outcome touches the IMAP mailbox. The mailbox is the master, and a person reporting
   * what they saw in it is not a licence to write to it.
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
      const [row] = await tx.select({ status: drafts.status }).from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId)))
        .for("update").limit(1);
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
       * ── A SEND WE COULD NOT CONFIRM IS REFUSED BY NAME; A FINISHED ONE IS NOT REFUSED AT ALL ──
       *
       * The reservation deliberately OUTLIVES every terminal outcome: `finalizeSent` clears
       * `send_at`/`send_key` and moves the row to `sent`, the ambiguous ending moves it to
       * `unverified`, and a failed attempt puts it back at `draft` — in all three the
       * `outbound_sends` row stays, because it is the guard that makes a same-key retry replay
       * instead of delivering a second copy.
       *
       * THIS USED TO ASK WHETHER A ROW EXISTED, which conflated two different kinds of fact and
       * is the defect the resolution verb exists to close. A `pending` or `unverified` row is an
       * OPEN QUESTION about mail that may be in somebody's inbox. A `sent` or `failed` row is a
       * LEDGER ENTRY ABOUT THE PAST. Only the first is a reason to keep the words, and asking the
       * cruder question made a definitively-FAILED send's draft undeletable for ever — a row whose
       * own `send_error` says it never went out, that could not be thrown away.
       *
       * NOTHING CASCADES. `outbound_sends.draft_id` is nullable `ON DELETE SET NULL` (mail 0095),
       * so the delete below clears the reference and the ledger row survives without it: the
       * reservation's identity is `UNIQUE(account_id, idempotency_key)` — the replay gate — and
       * that gate does not mention the draft. Deleting the reservation to make the delete succeed
       * would hand the next press of the same key a clean slate for a message that may already
       * have been delivered; leaving it in place with a NULL reference keeps the gate and honours
       * what the person asked for, which was that the TEXT go away.
       *
       * Before that migration the statement reached the constraint, Postgres raised
       * `23503 outbound_sends_draft_id_drafts_id_fk`, and — not being a {@link ServiceError} — it
       * left the router as `internal` 500. That is why the named 409 was put in front of it, and
       * why narrowing this predicate without changing the constraint would have turned the honest
       * refusal straight back into the fault it replaced.
       *
       * ── WHY THE ROW IS LOCKED FIRST, AND WHY THAT ORDER IS THE WHOLE RACE ─────────────────
       *
       * A check that merely READ `outbound_sends` would answer about the past: `SendService.reserve`
       * inserts its reservation in another transaction, and that INSERT takes a `FOR KEY SHARE` on
       * this drafts row for the foreign key — so a reserve committing between the read and the
       * DELETE puts the 500 straight back. `FOR UPDATE` is the one row-lock mode that conflicts
       * with `FOR KEY SHARE`, and `reserve`'s first statement is a `FOR UPDATE` on the same row, so
       * taking it here serializes the two: either the reserve committed first and this read sees
       * its reservation (409), or this delete committed first and the reserve's own locked read
       * finds no draft (404). Neither ending is the foreign key.
       *
       * ASKED ONLY FOR A ROW THE DELETE COULD ACTUALLY TAKE. A row wearing an appointment is
       * refused below with the sentence that names the way forward (cancel the schedule), and the
       * worker's claim mints a reservation for exactly such a row — asking about the reservation
       * first would swap the two answers and tell somebody their scheduled message "has a send on
       * record" instead of how to stop it.
       */
      const [held] = await tx.select({ status: drafts.status, sendKey: drafts.sendKey }).from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.accountId, ctx.accountId)))
        .for("update").limit(1);
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
   * The mailbox must exist, belong to the caller's account â AND still be
   * connected.
   *
   * ââ WHY STATUS BELONGS HERE AND NOT ONLY AT SEND ââââââââââââââââââââââââââââââââââââââââââ
   *
   * This used to check ownership alone, which let a draft be composed against a mailbox that
   * can never send it. The send path is where that becomes destructive (see `SendService.
   * reserve`, which holds the refusal that actually matters), but refusing at compose is the
   * difference between "you cannot pick this sender" and "we accepted your message and then
   * could not send it". The user finds out while they still have the text in front of them.
   *
   * `'error'` is DELIBERATELY ALLOWED. It is the sync worker's word about IMAP â written by
   * `markMailboxFailed`, cleared by the worker itself on recovery â and SMTP is a separate
   * transport: a mailbox that cannot be read may still be able to send, and an `error` a user
   * cannot clear would strand their outbox on a transient fault they did not cause. The same
   * reasoning excludes `sync_blocked_reason`, which `markMailboxSyncBlocked` writes WITHOUT
   * touching `status` precisely because it is a note about our infrastructure, not the mailbox.
   * Only `'disabled'` â the state a human or a billing/lease decision put the row in â refuses.
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
   * left byte-exact â the compose surface that has always sent a string still sends one, and
   * nothing about it changes.
   *
   * ââ WHY THE SERVER DERIVES `body` INSTEAD OF ACCEPTING IT ââââââââââââââââââââââââââââââââ
   *
   * A `multipart/alternative` is a promise that its two parts say the same thing. If both parts
   * arrive from the client, that promise is a convention two codebases have to keep, and the
   * first client that gets it wrong ships a message whose plaintext readers see something its
   * html readers do not â including the case that matters, where the html says one thing and
   * the text says another to the same person on two devices. Deriving one from the other makes
   * the promise structural: there is no request that can express a disagreement.
   *
   * So a `body` sent ALONGSIDE html is a `400` rather than something quietly overwritten.
   * Ignoring it would make a client that believes it is setting the plain part indistinguishable
   * from one that is not, and the symptom would appear only in somebody's inbox.
   *
   * ââ THE ORDER IS SANITIZE, THEN MEASURE, THEN DERIVE âââââââââââââââââââââââââââââââââââââ
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
   * THE REPLY TARGET IS THE ACCOUNT'S OWN MESSAGE, OR IT IS A 404.
   *
   * `drafts.in_reply_to_message_id` carries a foreign key to `messages.id` and NOTHING checked
   * whose message that was: both write paths took the value straight from the request body. The
   * asymmetry was visible inside `create` and `update` themselves — the `thread_id` block says so
   * in its own comment, *"the read is also the OWNERSHIP check the column never had: account
   * isolation is absolute, so another account's thread id is a 404, not a stored reference"* — and
   * the column written on the next line had no such read.
   *
   * ── WHAT THE UNCHECKED EDGE ACTUALLY DOES ────────────────────────────────────────────────────
   *
   * It is not primarily a disclosure: the id is stored, not dereferenced into the draft. It is a
   * WRITE into another account's referential graph, and the damage lands when that account tries
   * to leave. The foreign key declares no `ON DELETE`, so it restricts — a stranger's draft row
   * pointing at a victim's message makes deleting that message fail, and account erasure deletes
   * messages. One row authored by somebody the victim has never heard of can hold their erasure
   * open, and the victim can neither see nor remove the row that does it.
   *
   * Precondition: knowing a message id. That is not a defence — isolation is required to be
   * structural rather than to rest on an identifier being hard to guess — but it is why this is a
   * cross-account WRITE rather than a leak.
   *
   * A key-share read, matching the thread block, so the FK check that follows cannot race a
   * concurrent delete of the row it just approved.
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
   * The SUBJECT, type-checked and bounded.
   *
   * ── WHY THIS IS ITS OWN VALIDATOR ────────────────────────────────────────────────────────
   *
   * The ceiling was briefly added inside {@link validString}, which is shared — and `body` goes
   * through it too. So a plain-text draft with a 1 000-character body was refused with a message
   * about a limit that has nothing to do with it, while a RICH draft of the same length was
   * accepted because `richBody` is a different path. A bound that depends on the format the user
   * happened to choose is not a bound; it is a bug with a number in it. Caught by a review round
   * before it shipped, and the lesson is the obvious one: a per-field ceiling belongs in a
   * per-field validator.
   *
   * The plain body's own ceiling is the request door and nothing else. It is stored on one column
   * and later placed in an `OutboundMessage` the transport sends — a real sink, not a terminal
   * one, and the input-bounds census records it that way rather than calling the column the end
   * of the story. The rich body DOES have a ceiling of its own (`DRAFT_HTML_CAP_BYTES`), and the
   * asymmetry is deliberate: the html is sanitized and measured because markup is where a
   * megabyte hides, while plain text is what a person typed.
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
   * One recipient list, validated for SHAPE and for LENGTH.
   *
   * The shape half is original; the length half was missing, and the sink is what made that
   * matter: `SendService.reserve` hands `to`/`cc`/`bcc` to Nodemailer entry by entry, so the
   * number of SMTP `RCPT TO` commands one send issues against the user's own mail server was
   * whatever the request body contained. Three unbounded arrays in one draft, stored on a `PUT`
   * that costs nothing and replayed by every send of that draft.
   *
   * {@link DRAFT_MAX_RECIPIENTS} is per FIELD because this function sees one field. The
   * per-message total is `SEND_MAX_RECIPIENTS`, checked where all three are in hand and where
   * they become network commands — a total computed here would have to guess at the two fields
   * a partial update does not carry.
   */
  /**
   * THE RECIPIENT CEILING IS A TOTAL OVER THE REQUEST, not three independent per-field ones.
   *
   * ── WHY THE PER-FIELD READING DOES NOT WORK, ARITHMETICALLY ──────────────────────────────
   *
   * {@link DRAFT_MAX_RECIPIENTS} is {@link SEND_MAX_RECIPIENTS}, so that Reply All cannot compose
   * a draft this service refuses. Applied per FIELD that is 1 500 entries in one body, and the
   * census computed what that costs: 4 832 016 wire bytes, against a request door the whole
   * slice exists to keep small. No door both admits that and is worth having — 254 octets of
   * address alone, at 1 500 entries and six wire bytes a character, is 2.3 MB before a display
   * name or a byte of html.
   *
   * A total fixes it without giving anything up, because 500 is a ceiling on the MESSAGE and a
   * message's recipients are its `to`, `cc` and `bcc` together — which is exactly how
   * `SendService.reserve` counts them. Reply All produces one audience split across two fields,
   * never 500 in each, so nothing the product composes is refused.
   *
   * ── WHAT IT DOES NOT CLOSE, said plainly ─────────────────────────────────────────────────
   *
   * It bounds the REQUEST, so a caller may still accumulate past 500 across several patches: this
   * sees only the fields the patch carries, and reading the stored row to merge them would put a
   * query in front of a validator. That is deliberate and it costs nothing real — the accumulated
   * draft is storage, and `SendService.reserve` totals all three where they become RCPT TO
   * commands and refuses it there. The door's question is how big one BODY may be, and this
   * answers exactly that.
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
      // ── AND EACH ENTRY IS BOUNDED, not just the list ──────────────────────────────────
      //
      // The COUNT was the obvious half; the entries were unbounded strings, so
      // `DRAFT_MAX_RECIPIENTS` bounded how many megabytes a request could carry only in the sense
      // that 100 of them is not 101. The address ceiling is not ours: RFC 5321 §4.5.3.1 caps the
      // complete FORWARD PATH at 256 octets including the angle brackets, so a usable mailbox is
      // 254 — the familiar 320 is the sum of the component maxima (64 local + 1 + 255 domain),
      // which cannot all be met at once. Anything longer is not an address a transport will
      // deliver, so refusing it here is telling the truth earlier. The display name is the
      // product's own limit, generous enough for any real name and small enough that a hundred
      // of them is a header, not a payload.
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
