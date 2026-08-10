import { and, eq } from "drizzle-orm";
import { drafts, mailboxes, messages, outboundSends, recordChange, threads, type Tx } from "@trafficflow/db";
import {
  mintMessageId,
  type EmailAddress, type OutboundMessage, type OpenSendAdapter,
} from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { sanitizeOutboundHtml } from "./outbound-html.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/** The domain of an email identity (`user@host` → `host`), for minting the id. */
function domainOf(address: string | null | undefined): string {
  const at = (address ?? "").lastIndexOf("@");
  return at >= 0 ? address!.slice(at + 1).trim() : "";
}

/** Per-call send deps: the INJECTED adapter factory (prod = makeSendAdapter; tests = a fake/GreenMail spy). */
export interface SendDeps {
  openSendAdapter: OpenSendAdapter;
}

/**
 * How old a `pending` reservation must be before it counts as ORPHANED rather than in flight.
 *
 * It has to exceed the longest possible lifetime of a sending invocation, or the recovery path
 * will probe Sent for a send that is still happening and mark a succeeding send `unverified`.
 * The hosted API runs under a 60-second invocation ceiling, and the IMAP/SMTP deadlines
 * (`DEFAULT_NET_TIMEOUTS`) keep a single attempt well under that, so 10 minutes is
 * comfortably past "no invocation can still be alive" while still being a delay a human will
 * wait out rather than a state they are stuck in.
 */
export const SEND_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * The outcome the route maps to an HTTP response:
 *  - `sent`       → 200 { status, providerMessageId } (+ X-Sync-Seq)
 *  - `unverified` → 200 { status } — ambiguous, surfaced ("check Sent before retrying")
 *  - `failed`     → 409 — a definitively-undelivered prior attempt under this key
 *  - `in_flight`  → 409 — a genuinely-concurrent attempt is mid-flight
 */
export interface SendResult {
  status: "sent" | "unverified" | "failed" | "in_flight";
  providerMessageId: string | null;
  draftId: string;
  seq: number | null;
}

/** What the RESERVE tx resolves to: a fresh reservation, or an already-existing row to branch on. */
type Reservation =
  | { kind: "new"; sendId: string; mintedMessageId: string; mailboxId: string; msg: OutboundMessage; seq: number }
  | { kind: "existing"; row: typeof outboundSends.$inferSelect; mailboxId: string };

/**
 * SendService (POST /drafts/:id/send) — the SECURITY-SENSITIVE
 * gated idempotent send. It owns a domain state machine in `outbound_sends`; the
 * route is NOT idempotent-marked and 400s when `Idempotency-Key` is absent.
 *
 * The invariant is NO double-send to a recipient, even across a crash between the
 * (non-transactional) SMTP call and its DB finalize. The mechanism:
 *
 *   1. RESERVE (short tx, NO network): reserve `(accountId, idempotencyKey)` via
 *      INSERT … ON CONFLICT DO NOTHING with a Message-ID minted UP FRONT, and mark
 *      the draft `sending`. A conflict means this key was already used → branch on
 *      the stored status instead of sending again.
 *   2. SMTP OUTSIDE the tx (no network in a tx): send with the pre-minted id.
 *   3. FINALIZE (short tx): record `sent` + providerMessageId; mark the draft `sent`.
 *   4. RECOVERY (verify-by-Sent): a same-key request that finds a STALE `pending`
 *      row searches the Sent folder for the minted id — FOUND ⇒ reconcile `sent`
 *      (NO resend); NOT FOUND ⇒ `unverified` (NO resend, surfaced). NEVER resend on
 *      ambiguity.
 *
 * Every draft/outbound_sends transition emits a `draft` change so clients
 * see send progress in `/sync`. All queries are account-scoped: a
 * cross-account draft id is a 404.
 */
export class SendService {
  async send(
    ctx: ServiceContext,
    draftId: string,
    idempotencyKey: string,
    deps: SendDeps,
  ): Promise<SendResult> {
    // ── 1. RESERVE (short tx, NO network) ────────────────────────────────────
    const reservation = await this.reserve(ctx, draftId, idempotencyKey);

    // A same-key request that hit the UNIQUE reservation: branch on stored status.
    if (reservation.kind === "existing") {
      return this.resumeExisting(ctx, reservation.row, reservation.mailboxId, deps);
    }

    // ── 2. SMTP OUTSIDE the tx. Always close() in finally. ───────────────
    const { sendId, mintedMessageId, mailboxId, msg } = reservation;
    const adapter = await deps.openSendAdapter(mailboxId);
    try {
      let providerMessageId: string;
      try {
        const res = await adapter.send(msg);
        providerMessageId = res.providerMessageId;
      } catch {
        // SMTP threw → the delivery is AMBIGUOUS (it may have reached the server
        // before the failure). VERIFY by Sent rather than assume either way; NEVER
        // blindly resend. Reuse the still-open adapter for the probe.
        const inSent = await adapter.messageInSent(mintedMessageId);
        if (inSent) {
          const seq = await this.finalizeSent(ctx, sendId, mintedMessageId, draftId);
          return { status: "sent", providerMessageId: mintedMessageId, draftId, seq };
        }
        const seq = await this.finalizeUnverified(ctx, sendId, draftId);
        return { status: "unverified", providerMessageId: null, draftId, seq };
      }

      // ── 3. FINALIZE (short tx) ──────────────────────────────────────────────
      const seq = await this.finalizeSent(ctx, sendId, providerMessageId, draftId);
      return { status: "sent", providerMessageId, draftId, seq };
    } finally {
      await adapter.close();
    }
  }

  /**
   * The RESERVE tx (short, NO network). Loads the account-scoped draft (404), mints
   * the Message-ID from the mailbox identity, and reserves `(accountId,
   * idempotencyKey)`. A DO-NOTHING conflict means the key already exists → return
   * the locked existing row for the caller to branch on. A fresh insert is only
   * allowed for a `draft`-status draft with recipients; the draft is flipped to
   * `sending` and a `draft` change is emitted. Throwing here rolls the reservation
   * back, so an invalid draft never leaves an orphan `pending` row.
   */
  private async reserve(ctx: ServiceContext, draftId: string, idempotencyKey: string): Promise<Reservation> {
    return asTx(ctx).transaction(async (tx): Promise<Reservation> => {
      const [d] = await tx.select().from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId))).limit(1);
      if (!d) throw new ServiceError("not_found", 404, "draft not found");

      const [mb] = await tx.select({ address: mailboxes.address, status: mailboxes.status }).from(mailboxes)
        .where(eq(mailboxes.id, d.mailboxId)).limit(1);
      const mintedMessageId = mintMessageId(domainOf(mb?.address));

      const inserted = await tx.insert(outboundSends).values({
        accountId: ctx.accountId,
        idempotencyKey,
        draftId,
        mintedMessageId,
        status: "pending",
        createdAt: ctx.now(),
      })
        .onConflictDoNothing({ target: [outboundSends.accountId, outboundSends.idempotencyKey] })
        .returning({ id: outboundSends.id });

      if (inserted.length === 0) {
        // CONFLICT: this key was reserved before. Lock the row and branch on it.
        const [existing] = await tx.select().from(outboundSends)
          .where(and(eq(outboundSends.accountId, ctx.accountId), eq(outboundSends.idempotencyKey, idempotencyKey)))
          .for("update").limit(1);
        if (!existing) throw new ServiceError("internal", 500, "reservation vanished");
        return { kind: "existing", row: existing, mailboxId: d.mailboxId };
      }

      // ── A DISABLED MAILBOX REFUSES HERE, AND THE ROLLBACK IS THE POINT ─────────────────────
      //
      // Until this check existed a disabled mailbox was refused only BY ACCIDENT, and the
      // accident was not even reliable. `MailboxService.delete` disables the row AND deletes its
      // credentials, so `makeSendAdapter` throws 502 "mailbox has no IMAP credentials" — but it
      // throws in `send()`, AFTER this transaction has committed the reservation and flipped the
      // draft to `sending`. The draft is then stuck out of `draft` forever (no new key can send
      // it — see the status check below), and a same-key retry walks it to `in_flight` and,
      // once the row goes stale, to `unverified`: *"check your Sent folder"* for a message that
      // never left the building. A user who is told to go look stops looking. That is the worst
      // ending available here — worse than an error, because it ends the investigation.
      //
      // The other three disable paths do not even get the accident. `disableExcessMailboxes`
      // (billing downgrade), `markMailboxStoodDown` (the organizer lease) and a plain
      // `PATCH {status:'disabled'}` all set the status and LEAVE THE CREDENTIALS IN PLACE, so
      // `makeSendAdapter` opens happily and the mail is genuinely sent — from a mailbox the
      // account is no longer entitled to, or one another organizer now owns. So this is not only
      // moving a refusal earlier; for three of the four ways a mailbox becomes disabled it is
      // the only refusal there is.
      //
      // ── WHY IT SITS AFTER THE INSERT AND NOT BEFORE IT ────────────────────────────────────
      //
      // Placing it above the INSERT would also catch the CONFLICT branch, which returns before
      // reaching here — and that branch is idempotent REPLAY. A client retrying its key after a
      // send that SUCCEEDED, on a mailbox disabled in the meantime, would be told
      // `mailbox_disabled` instead of being handed back the stored `sent` result: the same
      // defect this check exists to remove, pointing the other way. So it belongs with the
      // other NEW-reservation preconditions, and it costs nothing to be here — throwing
      // anywhere in this callback rolls the whole transaction back, the INSERT above included,
      // exactly as the two checks below already rely on. The draft never leaves `draft` and no
      // `outbound_sends` row survives; a test asserts both against real Postgres, because an
      // in-memory Postgres cannot see a rollback it never had to perform.
      //
      // ONLY `'disabled'`. `'error'` is the worker's IMAP verdict and SMTP is a different
      // transport; `sync_blocked_reason` is a note about OUR infrastructure and is written
      // without touching `status` at all. Neither may strand a user's outbox — see the longer
      // note on `DraftsService.validMailbox`.
      if (mb?.status === "disabled") {
        throw new ServiceError(
          "mailbox_disabled", 409,
          "This mailbox is disconnected and cannot send. Reconnect it, or pick another sender.",
        );
      }

      // NEW reservation. Only a fresh `draft` with recipients may be sent; a draft
      // already `sending`/`sent`/`unverified` cannot be re-sent under a NEW key.
      if (d.status !== "draft") {
        throw new ServiceError("conflict", 409, `draft cannot be sent from status '${d.status}'`);
      }
      const to = (d.to as EmailAddress[]) ?? [];
      const cc = (d.cc as EmailAddress[]) ?? [];
      const bcc = (d.bcc as EmailAddress[]) ?? [];
      // A draft with recipients ONLY in Cc/Bcc is still a real send — the "no recipients" refusal is
      // about the envelope being empty, not about To specifically. So the guard counts everyone who
      // will receive the mail, which is exactly the set the RCPT list is built from below.
      if (to.length + cc.length + bcc.length === 0) {
        throw new ServiceError("validation_failed", 400, "draft has no recipients");
      }

      // ── RFC 5322 §3.6.4: References is a CHAIN, not a pointer ─────────────────────────
      //
      // This used to send `references: inReplyTo` — the parent's Message-ID alone. The spec
      // says the reply's References is the parent's References followed by the parent's
      // Message-ID, and the practical consequence of sending only the parent is that a
      // recipient whose client threads on the LEFTMOST reference anchors our reply mid-chain
      // and mints a SECOND conversation for what is one exchange. Our own ingest is keyed on
      // the leftmost entry for exactly that reason (see `threads.rootMessageIdHeader`), so we
      // were sending other people mail we would have mis-threaded ourselves.
      //
      // ── WHY ROOT+PARENT AND NOT THE FULL CHAIN ────────────────────────────────────────
      //
      // We do not store the arriving `References` header anywhere — `messages` has no column
      // for it — so the complete chain is not reconstructable here. What we DO store is the
      // thread's root, and root+parent is the pair that carries the meaning: the root anchors
      // the conversation for leftmost-threading clients, the parent places this reply under
      // the message it answers. Middle ancestors are informational; losing them degrades a
      // reader's ability to reconstruct order, it does not split the thread.
      //
      // The complete fix is to persist `References` at ingest and replay it here. Until then
      // this is an approximation, and it is stated as one rather than dressed up as compliance.
      let inReplyTo: string | undefined;
      let references: string | undefined;
      if (d.inReplyToMessageId) {
        const [parent] = await tx
          .select({ h: messages.messageIdHeader, root: threads.rootMessageIdHeader })
          .from(messages)
          .leftJoin(threads, eq(threads.id, messages.threadId))
          .where(and(eq(messages.id, d.inReplyToMessageId), eq(messages.accountId, ctx.accountId)))
          .limit(1);
        inReplyTo = parent?.h ?? undefined;
        if (inReplyTo) {
          // Ordered oldest-first, as the header requires, and de-duplicated: a reply to the
          // root itself would otherwise repeat one id twice.
          const chain = parent?.root && parent.root !== inReplyTo ? [parent.root, inReplyTo] : [inReplyTo];
          references = chain.join(" ");
        }
      }

      /**
       * THE LAST GATE BEFORE THE BYTES LEAVE THE BUILDING.
       *
       * `DraftsService` already sanitized this html on the way in, so this pass is normally a
       * no-op — `sanitizeOutboundHtml` is idempotent, and a test asserts that rather than
       * assuming it. It is here because "DraftsService is the only writer" is a
       * claim about today: the AI workflow code under `packages/core/src/ai/workflows/` already
       * inserts into `drafts` directly — html included, now that a generated reply is promoted
       * to both halves — and the next writer will not remember to ask. Sanitizing where the
       * envelope is assembled closes every writer at once instead of every known writer.
       *
       * Promoted markup is a FIXED POINT of this pass by construction — paragraphs, breaks and
       * escaped text, every one of them inside the allow-list — and that is asserted rather than
       * assumed, so the direct writer does not depend on this gate to be storing legal markup.
       *
       * `text` stays `d.body` untouched. When the draft is rich, `body` IS the alternative
       * derived from this html at write time; deriving it again here would be a second
       * rendering of the same content that could differ from the stored one, which is the exact
       * disagreement between the two parts that deriving it once exists to prevent.
       */
      const html = d.html ? sanitizeOutboundHtml(d.html) : null;

      // ── CC IS A HEADER, BCC IS ENVELOPE-ONLY, AND THIS IS WHERE THE DIFFERENCE IS SET ──────
      //
      // `cc` and `bcc` are both handed to nodemailer (in `imap.ts#send`), which flattens
      // to+cc+bcc into the SMTP RCPT list — so every bcc recipient is DELIVERED. What keeps bcc
      // off the wire's headers is nodemailer's default `keepBcc: false`: a `Cc:` header is written
      // into the delivered message and the Sent-folder copy, a `Bcc:` header is written into
      // NEITHER. That is the whole correctness property of a Bcc, and it lives one layer down at
      // the MIME builder rather than here — this function only decides WHO is copied, not which of
      // them is visible. Empty arrays are omitted so a plain send builds the exact same options it
      // always did. The Cc/Bcc round-trip test mutation-watches the invariant.
      const msg: OutboundMessage = {
        from: mb?.address ?? "",
        to: to.map((a) => a.address),
        ...(cc.length ? { cc: cc.map((a) => a.address) } : {}),
        ...(bcc.length ? { bcc: bcc.map((a) => a.address) } : {}),
        subject: d.subject,
        text: d.body,
        ...(html ? { html } : {}),
        messageId: mintedMessageId,
        ...(inReplyTo ? { inReplyTo, references } : {}),
      };

      const now = ctx.now();
      await tx.update(drafts).set({ status: "sending", updatedAt: now })
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)));
      const seq = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });

      return { kind: "new", sendId: inserted[0]!.id, mintedMessageId, mailboxId: d.mailboxId, msg, seq: Number(seq) };
    });
  }

  /**
   * Branch on an already-reserved row (a same-key request):
   *  - `sent`       → replay the stored result, NO resend.
   *  - `unverified` → surface the terminal ambiguous state, NO resend.
   *  - `failed`     → surface the terminal failure, NO resend.
   *  - `pending`    → a STALE prior attempt (or concurrent in-flight): VERIFY by
   *                   Sent (recovery). Found ⇒ reconcile `sent`; not found ⇒
   *                   `unverified`. NEVER a blind resend.
   */
  private async resumeExisting(
    ctx: ServiceContext,
    row: typeof outboundSends.$inferSelect,
    mailboxId: string,
    deps: SendDeps,
  ): Promise<SendResult> {
    if (row.status === "sent") {
      return { status: "sent", providerMessageId: row.providerMessageId, draftId: row.draftId, seq: null };
    }
    if (row.status === "unverified") {
      return { status: "unverified", providerMessageId: null, draftId: row.draftId, seq: null };
    }
    if (row.status === "failed") {
      return { status: "failed", providerMessageId: null, draftId: row.draftId, seq: null };
    }

    // status === "pending" → is the first attempt STILL RUNNING, or is this the wreckage of
    // one that died?
    //
    // Every pending row used to be treated as wreckage and probed immediately, which is wrong
    // in the most ordinary case there is: a user double-taps Send, or a client retries because
    // the response was slow. The second request then probes Sent WHILE the first is still
    // mid-SMTP, finds nothing (the message has not landed yet), and writes `unverified` —
    // marking a send that is in fact succeeding as ambiguous, and telling the user to go check
    // their Sent folder. It also made the `in_flight` outcome this service DECLARES
    // unreachable.
    //
    // `SEND_STALE_AFTER_MS` is the cutoff, and it is deliberately far longer than any single
    // invocation can live (the hosted API's ceiling is 60 s): a row younger than that
    // may still have a live sender behind it, so the honest answer is `in_flight` (409, retry
    // later) and NOT a probe. Older than that, no invocation can still be running, so the row
    // is genuinely orphaned and verify-by-Sent is the correct recovery.
    //
    // NOTE the remaining gap, and it is recorded as such: this recovery only runs
    // when the USER retries with the same key. A stranded row that is never retried stays
    // `pending` forever, and the WORKER pass that reconciles it is not yet built.
    const ageMs = ctx.now().getTime() - row.createdAt.getTime();
    if (ageMs < SEND_STALE_AFTER_MS) {
      return { status: "in_flight", providerMessageId: null, draftId: row.draftId, seq: null };
    }

    // A genuinely STALE reservation → verify-by-Sent recovery. Open the adapter ONLY
    // to probe Sent; `send` is NEVER called on this path.
    const adapter = await deps.openSendAdapter(mailboxId);
    try {
      const inSent = await adapter.messageInSent(row.mintedMessageId);
      if (inSent) {
        const seq = await this.finalizeSent(ctx, row.id, row.mintedMessageId, row.draftId);
        return { status: "sent", providerMessageId: row.mintedMessageId, draftId: row.draftId, seq };
      }
      const seq = await this.finalizeUnverified(ctx, row.id, row.draftId);
      return { status: "unverified", providerMessageId: null, draftId: row.draftId, seq };
    } finally {
      await adapter.close();
    }
  }

  /** FINALIZE-sent tx: mark the reservation + draft `sent`, emit a `draft` change. */
  private async finalizeSent(
    ctx: ServiceContext, sendId: string, providerMessageId: string, draftId: string,
  ): Promise<number> {
    const now = ctx.now();
    const seq = await asTx(ctx).transaction(async (tx) => {
      await tx.update(outboundSends).set({ status: "sent", providerMessageId, sentAt: now })
        .where(eq(outboundSends.id, sendId));
      await tx.update(drafts).set({ status: "sent", updatedAt: now })
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)));
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });
    });
    return Number(seq);
  }

  /** FINALIZE-unverified tx: the ambiguous terminal state; the draft surfaces `unverified`. */
  private async finalizeUnverified(ctx: ServiceContext, sendId: string, draftId: string): Promise<number> {
    const now = ctx.now();
    const seq = await asTx(ctx).transaction(async (tx) => {
      await tx.update(outboundSends).set({ status: "unverified" }).where(eq(outboundSends.id, sendId));
      await tx.update(drafts).set({ status: "unverified", updatedAt: now })
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)));
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });
    });
    return Number(seq);
  }
}

export const sendService = new SendService();
