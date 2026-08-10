import { and, eq, sql } from "drizzle-orm";
import {
  attachments, drafts, mailboxes, messageBodies, messages, outboundSends, recordChange, threads, type Tx,
} from "@trafficflow/db";
import {
  mintMessageId,
  type EmailAddress, type NativeLocator, type OutboundMessage, type OpenSendAdapter,
} from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import type { OpenAdapter } from "./attachments-service.js";
import { ServiceError } from "./errors.js";
import { sanitizeOutboundHtml } from "./outbound-html.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/** The domain of an email identity (`user@host` → `host`), for minting the id. */
function domainOf(address: string | null | undefined): string {
  const at = (address ?? "").lastIndexOf("@");
  return at >= 0 ? address!.slice(at + 1).trim() : "";
}

/** Escape the five characters that would let a header value break out of an html quote. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * THE QUOTED ORIGINAL of a forward — a text block always, and an html block for a rich send.
 *
 * The header is the conventional forwarded-message banner (From / Date / Subject). The original's
 * stored html is RE-SANITIZED before it is quoted (it is attacker-authored, and this is the last
 * place it is touched before the wire); a plain original is escaped into `<br>`-joined text so an
 * html recipient still sees it. The html half is folded into the outgoing message only when the
 * draft is itself rich — a plain forward carries the quote in text alone.
 */
function forwardedQuote(
  orig: { from: string; date: Date | null; subject: string },
  originalText: string,
  originalHtml: string | null,
): { text: string; html: string } {
  const dateStr = orig.date ? orig.date.toISOString() : "";
  const headerLines = [
    "---------- Forwarded message ----------",
    `From: ${orig.from}`,
    ...(dateStr ? [`Date: ${dateStr}`] : []),
    `Subject: ${orig.subject}`,
  ];
  const text = `\n\n${headerLines.join("\n")}\n\n${originalText}`;
  const bodyHtml = originalHtml
    ? sanitizeOutboundHtml(originalHtml)
    : escapeHtml(originalText).replace(/\n/g, "<br>");
  const html =
    `<br><br><hr>` +
    `<div>---------- Forwarded message ----------</div>` +
    `<div>From: ${escapeHtml(orig.from)}</div>` +
    (dateStr ? `<div>Date: ${escapeHtml(dateStr)}</div>` : "") +
    `<div>Subject: ${escapeHtml(orig.subject)}</div>` +
    `<blockquote>${bodyHtml}</blockquote>`;
  return { text, html };
}

/** Per-call send deps: the INJECTED adapter factory (prod = makeSendAdapter; tests = a fake/GreenMail spy). */
export interface SendDeps {
  openSendAdapter: OpenSendAdapter;
  /**
   * Opens a per-mailbox handle to STREAM a forwarded message's original attachments from IMAP at
   * send time — the same `AttachmentAdapter` the byte routes use (`makeOpenAdapter`). Optional: a
   * plain send never touches it, and a caller that supplies none simply forwards no original files.
   */
  openFetchAdapter?: OpenAdapter;
}

/** The decoded attachment shape carried on the SEND REQUEST — bytes only, never persisted. */
export type SendAttachment = NonNullable<OutboundMessage["attachments"]>[number];

/**
 * WHAT RIDES THE SEND REQUEST BODY BEYOND THE DRAFT — and why none of it is stored.
 *
 * The draft row is the message as it was composed; these are the parts that exist only for the
 * one delivery and are DELIBERATELY not persisted (§13.2/§14): the files the sender attached, whose
 * bytes arrive with the send and are handed straight to the transport. Absent for an ordinary
 * send, which builds exactly the `OutboundMessage` it always did.
 */
export interface SendInput {
  /** Uploaded files — decoded bytes. Never written to any table; see {@link OutboundMessage}. */
  attachments?: SendAttachment[];
  /**
   * FORWARD THIS ORIGINAL — the id of the message being forwarded, or absent for a normal send.
   *
   * The server, not the client, turns this into mail: it refuses a `no_forward` original (the
   * sensitive-leak gate), appends the quoted original to the body, and streams the original's
   * attachments from IMAP. The id is all the client is trusted with, because a client-assembled
   * quote is exactly the seam a redacted body would escape through.
   */
  forwardOf?: string | null;
}

/** How many original parts a forward may re-attach, and their combined byte ceiling. */
export const FORWARD_MAX_PARTS = 100;
export const FORWARD_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** One original part to re-stream on a forward — metadata only; the bytes are fetched at send. */
interface ForwardPart {
  partId: string | null;
  filename: string;
  contentType: string;
  contentId: string | null;
  inline: boolean;
}

/**
 * THE CEILING ON TOTAL ATTACHMENT BYTES in one send.
 *
 * The hosted API runs behind a serverless request-body limit (~4.5 MB on Vercel). Attachment bytes
 * ride the send request, so their total has to leave headroom for the JSON envelope AND for the
 * base64 inflation of transporting them as text (~1.33×). 3 MB of raw bytes encodes to ~4 MB, which
 * clears the limit with room to spare; a larger cap would let a send our own rule accepts be
 * rejected by the platform before this handler ever runs, with an opaque error the user cannot act
 * on. The compose surface states this number rather than discovering it at send time.
 */
export const SEND_ATTACHMENT_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

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
  | {
      kind: "new"; sendId: string; mintedMessageId: string; mailboxId: string;
      msg: OutboundMessage; seq: number;
      /** A forward's original parts to stream + the mailbox they live in — resolved outside the tx. */
      forward?: { parts: ForwardPart[]; mailboxId: string; locator: NativeLocator };
    }
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
    input: SendInput = {},
  ): Promise<SendResult> {
    // ── 1. RESERVE (short tx, NO network) ────────────────────────────────────
    const reservation = await this.reserve(ctx, draftId, idempotencyKey, input);

    // A same-key request that hit the UNIQUE reservation: branch on stored status.
    if (reservation.kind === "existing") {
      return this.resumeExisting(ctx, reservation.row, reservation.mailboxId, deps);
    }

    // ── 2. SMTP OUTSIDE the tx. Always close() in finally. ───────────────
    const { sendId, mintedMessageId, mailboxId, msg } = reservation;

    // ── FORWARD: STREAM THE ORIGINAL'S ATTACHMENTS, then send them with the message ──────────
    //
    // Done here, outside the reservation tx (it is IMAP network) and BEFORE `send`, so the
    // forwarded files are on the one `OutboundMessage` that goes out and is appended to Sent —
    // never persisted. A fetch failure is not swallowed: a forward that silently dropped the
    // original's files would be a wrong send, so it fails the whole send (the reservation is
    // `pending` and the user retries). Bounded by count and total bytes against a serverless OOM.
    if (reservation.forward && deps.openFetchAdapter) {
      await this.streamForwardParts(reservation.forward, msg, deps.openFetchAdapter);
    }

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
          const seq = await this.finalizeSent(ctx, sendId, mintedMessageId, draftId, mailboxId);
          return { status: "sent", providerMessageId: mintedMessageId, draftId, seq };
        }
        const seq = await this.finalizeUnverified(ctx, sendId, draftId);
        return { status: "unverified", providerMessageId: null, draftId, seq };
      }

      // ── 3. FINALIZE (short tx) ──────────────────────────────────────────────
      const seq = await this.finalizeSent(ctx, sendId, providerMessageId, draftId, mailboxId);
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
  private async reserve(
    ctx: ServiceContext, draftId: string, idempotencyKey: string, input: SendInput,
  ): Promise<Reservation> {
    // THE ATTACHMENT CAP, refused BEFORE the reservation commits. Enforced on the decoded bytes
    // (the route already rejected a body over the platform limit); this is the product rule and the
    // number the compose surface states. Over it, nothing is reserved and no draft leaves `draft`.
    const attachTotal = (input.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0);
    if (attachTotal > SEND_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new ServiceError(
        "payload_too_large", 413,
        `attachments total ${attachTotal} bytes; the limit is ${SEND_ATTACHMENT_MAX_TOTAL_BYTES}`,
      );
    }
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

      // ── FORWARD: THE ORIGINAL IS QUOTED SERVER-SIDE, AND A no_forward ONE IS REFUSED ────────
      //
      // The client sent only `forwardOf`. Here — where the body is assembled and nothing the
      // browser said is trusted — the original is read, the `no_forward` gate is enforced (a
      // sensitive body must never leave through a quote block), and the quoted original is folded
      // into the outgoing text/html. Its attachments are collected as metadata and STREAMED later,
      // outside this tx, because fetching bytes is IMAP network and a reservation tx opens none.
      let forward: { parts: ForwardPart[]; mailboxId: string; locator: NativeLocator } | undefined;
      let fwdText = "";
      let fwdHtml = "";
      if (input.forwardOf) {
        const [orig] = await tx.select({
          id: messages.id, mailboxId: messages.mailboxId, noForward: messages.noForward,
          subject: messages.subject, fromAddress: messages.fromAddress, date: messages.date,
          locator: messages.nativeLocator,
        }).from(messages)
          .where(and(eq(messages.id, input.forwardOf), eq(messages.accountId, ctx.accountId)))
          .limit(1);
        if (!orig) throw new ServiceError("not_found", 404, "the message to forward was not found");
        // THE SENSITIVE-LEAK GATE. A `no_forward` message (an OTP, a reset link) has its body kept
        // out of AI and out of a quote — forwarding it would carry the very bytes the flag protects
        // to a recipient the sender chose. The client hides the entry too, but this is the check
        // that is authoritative, because the client's absence is not a guarantee.
        if (orig.noForward) {
          throw new ServiceError("forbidden", 403, "This message can't be forwarded — it contains sensitive content.");
        }
        const [body] = await tx.select({ text: messageBodies.text, html: messageBodies.html })
          .from(messageBodies).where(eq(messageBodies.messageId, orig.id)).limit(1);
        const quoted = forwardedQuote(
          { from: orig.fromAddress, date: orig.date, subject: orig.subject },
          body?.text ?? "", body?.html ?? null,
        );
        fwdText = quoted.text;
        fwdHtml = quoted.html;
        // The original's attachment parts — metadata only; bytes stream at send. Capped so a huge
        // forward cannot OOM the serverless function (the same bound `download-all` needs).
        const attRows = await tx.select({
          filename: attachments.filename, contentType: attachments.contentType,
          partId: attachments.partId, contentId: attachments.contentId, inline: attachments.inline,
        }).from(attachments).where(eq(attachments.messageId, orig.id)).limit(FORWARD_MAX_PARTS);
        forward = {
          mailboxId: orig.mailboxId,
          locator: orig.locator as NativeLocator,
          parts: attRows.map((a) => ({
            partId: a.partId,
            filename: a.filename ?? "attachment",
            contentType: a.contentType,
            contentId: a.contentId,
            inline: a.inline,
          })),
        };
      }

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
        // The user's text, then the quoted original on a forward (`fwdText`/`fwdHtml` are "" for a
        // normal send). The html half is appended ONLY when the draft is itself rich; a plain
        // forward carries the quote in text alone.
        text: d.body + fwdText,
        ...(html ? { html: html + fwdHtml } : {}),
        messageId: mintedMessageId,
        ...(inReplyTo ? { inReplyTo, references } : {}),
        // ── ATTACHMENTS RIDE THE REQUEST, NOT THE ROW ──────────────────────────────────────
        //
        // The bytes are the send request's, decoded by the route. They go onto the `OutboundMessage`
        // and no further: `outboundToMail` builds the multipart AND the Sent-folder append from this
        // one object, so both copies carry the files and neither this transaction nor any other
        // writes a byte of them to disk. Empty ⇒ omitted, so a plain send is unchanged.
        ...(input.attachments && input.attachments.length ? { attachments: input.attachments } : {}),
      };

      const now = ctx.now();
      await tx.update(drafts).set({ status: "sending", updatedAt: now })
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)));
      const seq = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });

      return {
        kind: "new", sendId: inserted[0]!.id, mintedMessageId, mailboxId: d.mailboxId, msg,
        seq: Number(seq), ...(forward ? { forward } : {}),
      };
    });
  }

  /**
   * FETCH A FORWARD'S ORIGINAL ATTACHMENTS from IMAP and append them to the outgoing message.
   *
   * Runs outside any transaction (IMAP network), on its OWN adapter, closed in `finally`. Every
   * part shares the original message's locator and differs by `partId` (the ingest-time MIME
   * body-part key). An inline part keeps its `cid`, so the quoted html's `cid:` references still
   * resolve. The bytes land only on `msg.attachments` — the same zero-at-rest path an uploaded
   * file takes — and a part over the running byte budget stops the fetch: a forward that silently
   * dropped files is a wrong send, and the total is bounded so it cannot OOM the function.
   */
  private async streamForwardParts(
    forward: { parts: ForwardPart[]; mailboxId: string; locator: NativeLocator },
    msg: OutboundMessage,
    openFetchAdapter: OpenAdapter,
  ): Promise<void> {
    if (forward.parts.length === 0) return;
    const adapter = await openFetchAdapter(forward.mailboxId);
    try {
      const fetched: NonNullable<OutboundMessage["attachments"]> = [];
      let total = 0;
      for (const part of forward.parts) {
        const bytes = await adapter.fetchPart(forward.locator, part.partId);
        total += bytes.body.byteLength;
        if (total > FORWARD_MAX_TOTAL_BYTES) {
          throw new ServiceError(
            "payload_too_large", 413,
            `the forwarded attachments exceed ${FORWARD_MAX_TOTAL_BYTES} bytes`,
          );
        }
        fetched.push({
          filename: bytes.filename ?? part.filename,
          contentType: bytes.contentType || part.contentType,
          content: bytes.body,
          ...(part.inline && part.contentId ? { cid: part.contentId.replace(/[<>]/g, "") } : {}),
        });
      }
      msg.attachments = [...(msg.attachments ?? []), ...fetched];
    } finally {
      await adapter.close();
    }
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
        const seq = await this.finalizeSent(ctx, row.id, row.mintedMessageId, row.draftId, mailboxId);
        return { status: "sent", providerMessageId: row.mintedMessageId, draftId: row.draftId, seq };
      }
      const seq = await this.finalizeUnverified(ctx, row.id, row.draftId);
      return { status: "unverified", providerMessageId: null, draftId: row.draftId, seq };
    } finally {
      await adapter.close();
    }
  }

  /**
   * FINALIZE-sent tx: mark the reservation + draft `sent`, emit a `draft` change — AND stamp the
   * sending mailbox for an ENFORCED SYNC (`mailboxes.sync_requested_at`).
   *
   * The send just appended a copy to the user's Sent folder, and that copy is invisible in their
   * own mirror until the worker's next cycle picks it up — up to a poll interval away. Stamping the
   * mailbox `now()` in the SAME transaction that records the send lets the worker's short kick scan
   * reconcile it within seconds, so a message the user just sent shows in their Sent view promptly
   * rather than a minute later. It is a doorbell, not state: the stamp is best-effort convergence,
   * the worker clears it compare-and-clear, and a mailbox nobody stamps behaves exactly as before.
   *
   * Stamped only on the DEFINITE-sent finalize — never on `unverified`, where no Sent copy is known
   * to exist and a kick would reconcile nothing new.
   *
   * ── AND IT MAY NEVER WAIT FOR A LOCK. `SKIP LOCKED`, NOT A PLAIN UPDATE ──────────────────
   *
   * This is the sharpest edge on the whole send path, and a plain `update mailboxes set
   * sync_requested_at` had it. By the time this function runs, THE MESSAGE HAS ALREADY LEFT: SMTP
   * accepted it and the copy is in the user's Sent folder. An `UPDATE` of the mailbox row must wait
   * for any transaction holding that row — `MailboxService.delete` takes a genuine `FOR UPDATE`, and
   * so does the disabler — and a lock wait does not throw, so the `catch`-and-log the migration note
   * describes never fires. The finalize transaction simply stops.
   *
   * What that costs is not a slow request. It is the one outcome the whole reservation design exists
   * to prevent: the reservation stays `in_flight` and the draft never reaches `sent`, so a message
   * that DID go out is recorded as neither sent nor failed, and the serverless invocation is killed
   * mid-transaction rather than reaching even the `unverified` arm. Disconnecting a mailbox while a
   * send finalizes was enough to produce it — measured by `send-disabled-mailbox.pg.test.ts`, whose
   * "reserve's read does NOT block on the disabler's row lock" case timed out at five seconds.
   *
   * `FOR UPDATE SKIP LOCKED` is the fix and it costs nothing real, because this column is a
   * DOORBELL: the migration's own contract says the stamp is best-effort convergence and that "a
   * mailbox nobody stamps behaves exactly as before". So a row somebody else is holding is simply
   * not stamped, zero rows update, and the worker's ordinary poll picks the Sent copy up on its next
   * cycle — the pre-doorbell behaviour, for that one send. Trading a few seconds of Sent-folder
   * latency against a send recorded in no terminal state is not a close call.
   *
   * It stays INSIDE this transaction rather than moving after it: a stamp that outlived a rolled-back
   * finalize would ask the worker to reconcile a send that did not happen.
   */
  private async finalizeSent(
    ctx: ServiceContext, sendId: string, providerMessageId: string, draftId: string, mailboxId: string,
  ): Promise<number> {
    const now = ctx.now();
    const seq = await asTx(ctx).transaction(async (tx) => {
      await tx.update(outboundSends).set({ status: "sent", providerMessageId, sentAt: now })
        .where(eq(outboundSends.id, sendId));
      await tx.update(drafts).set({ status: "sent", updatedAt: now })
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)));
      // See the note above: the doorbell is skipped rather than waited on, because waiting here
      // strands a message that has already been sent. `SKIP LOCKED` needs the row to be selected,
      // so the update is driven by a subquery rather than by `where id = ...` directly.
      await tx.update(mailboxes).set({ syncRequestedAt: now }).where(sql`${mailboxes.id} in (
        select ${mailboxes.id} from ${mailboxes} where ${mailboxes.id} = ${mailboxId}
        for update skip locked
      )`);
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
