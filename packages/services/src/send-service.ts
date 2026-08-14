import { and, eq, sql } from "drizzle-orm";
import {
  attachments, drafts, mailboxes, messageBodies, messages, outboundSends, recordChange, threads, type Tx,
} from "@trafficflow/db";
import {
  createLogger, mintMessageId, recordSentMessage,
  type AppendedSent, type EmailAddress, type Logger, type NativeLocator, type OutboundMessage,
  type OpenSendAdapter, type RepoPort, type RoutingPort,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ServiceContext } from "./context.js";
import type { OpenAdapter } from "./attachments-service.js";
import { ServiceError } from "./errors.js";
import { sanitizeOutboundHtml } from "./outbound-html.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * The default sink for the ONE thing on this path that is reported and never raised — a
 * record-at-send projection that failed. See {@link SendService.projectSentCopy}.
 *
 * Module scope because it is three closures and an object, and overridable through
 * {@link SendDeps.log} so a test can read the line rather than watch stdout.
 */
const defaultLog = createLogger({ service: "send" });

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
   * THE PLATFORM CEILING OF THE HOST SERVING THIS SEND, in raw attachment bytes — or `null` for a
   * host that has none. **Three values, and `undefined` is not a fourth spelling of `null`.**
   *
   *  · a NUMBER — this host's request pipeline refuses a body above it, so the send must stay under
   *    it whatever the mail server would have accepted. The hosted API passes
   *    {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES}; see that constant for where ~4.5 MB becomes 3 MB.
   *  · `null` — this host has NO platform ceiling. That is the local engine: it runs this same
   *    service in its own process and hands the message straight to SMTP, so there is no request
   *    body anywhere in the path and the only limit that exists is the mail server's own.
   *  · ABSENT (`undefined`) — nobody said. Resolved to {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES}, the
   *    STRICTER of the two branches, deliberately: a host that forgets to declare itself must not
   *    thereby acquire an unbounded one. See {@link effectiveAttachmentCap}.
   */
  surfaceMaxTotalBytes?: number | null;
  /**
   * Opens a per-mailbox handle to STREAM a forwarded message's original attachments from IMAP at
   * send time — the same `AttachmentAdapter` the byte routes use (`makeOpenAdapter`). Optional: a
   * plain send never touches it, and a caller that supplies none simply forwards no original files.
   */
  openFetchAdapter?: OpenAdapter;
  /**
   * THE STAGED-BYTES SOURCE — present only on a host that has object storage behind it.
   *
   * ABSENT is the local engine and every test that does not exercise staging, and a request that
   * names staged references on such a host is REFUSED rather than silently sent without its files.
   * That refusal is the whole reason this is an injected capability and not a module import: "the
   * standalone door never stages" is then a fact about what the host composed, provable from the
   * absence, instead of a rule somebody has to keep obeying.
   */
  stagedAttachments?: StagedAttachmentSource;
  /**
   * Where a RECORD-AT-SEND failure is reported. Absent ⇒ {@link defaultLog}, i.e. stdout, which is
   * the drain an operator reads on both hosts.
   *
   * It exists so the guard for that failure can assert the line rather than the absence of a
   * throw: "the send still succeeded" and "somebody can find out why the row is late" are two
   * different claims and a swallowed exception only makes the first one.
   */
  log?: Logger;
}

/**
 * WHERE STAGED ATTACHMENT BYTES COME FROM, in two phases, and the split is the point.
 *
 * `declare` is metadata: it answers what the caller's own tickets say they weigh, at the cost of
 * one query, so the send can be REFUSED for exceeding the cap before anything is transferred. A
 * one-phase port would have to download in order to find out, which hands an authenticated caller
 * a way to make this process pull an arbitrary number of bytes it is then going to throw away.
 *
 * `fetch` is the bytes, and it runs outside the reservation transaction for the same reason
 * `streamForwardParts` does. It re-measures every object against the size its ticket declared:
 * `declare` reports what a CLIENT asserted at mint time, so the cap would otherwise be enforced
 * against a number the client chose.
 */
export interface StagedAttachmentSource {
  /** The caller's own tickets. Ids that name nothing, or another account's row, are simply absent. */
  declare(
    accountId: string, ids: readonly string[],
  ): Promise<Array<{ id: string; sizeBytes: number; expiresAt: Date }>>;
  /**
   * The bytes, in the order `ids` names them, ONE ENTRY PER DISTINCT ID. A repeated id is one
   * file and one download — see `resolveStagedAttachments`, which holds that invariant for every
   * caller rather than trusting each one to deduplicate first.
   *
   * Throws a {@link ServiceError} when an object is gone or larger than its ticket declared — a
   * send that silently dropped an attachment is a wrong send, exactly as a forward that dropped
   * the original's files would be.
   */
  fetch(accountId: string, ids: readonly string[], now: Date): Promise<SendAttachment[]>;
}

/** The decoded attachment shape carried on the SEND REQUEST — bytes only, never persisted. */
export type SendAttachment = NonNullable<OutboundMessage["attachments"]>[number];

/**
 * WHAT RIDES THE SEND REQUEST BODY BEYOND THE DRAFT — and why none of it is stored.
 *
 * The draft row is the message as it was composed; these are the parts that exist only for the
 * one delivery and are DELIBERATELY not persisted (§13.2/§14): the files the sender attached, whose
 * bytes are handed straight to the transport and written to no table. Absent for an ordinary send,
 * which builds exactly the `OutboundMessage` it always did.
 *
 * "Not persisted" is a statement about THIS DATABASE and it stays exactly true. Staged bytes
 * (`stagedAttachmentIds`) reached this process from object storage rather than from the request
 * body, so they were at rest for a bounded window before arriving — 24 hours at most, in a private
 * bucket, swept whether the send happened or not. That is a fact about the TRANSPORT, it is stated
 * in the privacy copy, and it changes nothing about where the bytes go from here: the one
 * `OutboundMessage`, and no row.
 */
export interface SendInput {
  /**
   * UPLOADED FILES — decoded bytes, on the request itself. Never written to any table; see
   * {@link OutboundMessage}.
   *
   * THE PRIMARY TRANSPORT, not a legacy one, and this is the field a future "can we drop it yet"
   * lands on. Every shipping client still emits it: the browser app stages only ABOVE the inline
   * ceiling, so every send at or under 3 MB arrives here, and the desktop app never stages on
   * either of its doors. Update uptake does not bear on that and could not be measured anyway —
   * no client-version signal reaches the hosted service. The inline form can only be reconsidered
   * once the desktop's Cloud door stages and the browser client stages unconditionally.
   */
  attachments?: SendAttachment[];
  /**
   * STAGED FILES — upload-ticket ids whose bytes are in object storage, not in this request.
   *
   * The second accepted shape of one thing, and the narrower of the two: it exists for the sends
   * the request body cannot carry at all. A send may carry either, or both — the two lists are
   * concatenated, inline first, and the cap is applied to the total.
   *
   * The bytes reach exactly the same place an inline attachment's do: the one `OutboundMessage`,
   * and no table. What is different is that they existed in a bucket for a bounded window on the
   * way here, which is why the privacy copy says so.
   */
  stagedAttachmentIds?: string[];
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

/**
 * HOW MANY ATTACHMENT PARTS ONE SEND REQUEST MAY NAME — per list, inline or staged.
 *
 * ── WHY A COUNT CEILING EXISTS AT ALL, GIVEN THE BYTE ONE ────────────────────────────────────
 *
 * Because {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES} does not bound either list's LENGTH, and the
 * reading that it does is the one that left both lists open:
 *
 *  · an INLINE entry carrying no `contentBase64` decodes to zero bytes, so any number of them sum
 *    to zero and clear every byte cap there is. For that list this constant is the ONLY bound.
 *  · a STAGED ticket may declare ONE byte (the mint's floor is a positive integer), so a 3 MB
 *    ceiling still admits millions of references — and before the dedupe below each one was a
 *    separate object-storage round trip for the same object.
 *
 * ── WHY 100 ─────────────────────────────────────────────────────────────────────────────────
 *
 * It is {@link FORWARD_MAX_PARTS}, and deliberately the same number: that is already the ceiling
 * on the OTHER list of attachment parts this same service assembles onto an outgoing message, and
 * two different answers to "how many parts may ride one message" would be a distinction with no
 * reason behind it.
 *
 * Pinning rather than picking is the house rule for this decision, not a preference — `MARK_SEEN_MAX_IDS`
 * takes its 200 from `DEFAULT_SYNC_BATCH_MAX_MESSAGES` and says why in the same words: *"a second,
 * different 'how many is too many' would be a number nobody could justify"*. That constant also
 * settles the two questions this one would otherwise have to answer alone — it refuses on the RAW
 * array with `payload_too_large`/413 and deduplicates what survives, which is exactly the order
 * the send route follows.
 *
 * It is not a limit legitimate use meets. The staged transport only engages above 3 MB of files,
 * and the ceiling that then binds is the mailbox's own announced `SIZE` — typically 25–35 MB, so
 * 100 files inside it average 250–350 KB each. A compose surface with no count field at all is not
 * a surface anyone assembles a hundred-file message on; the byte cap is what stops them long
 * before this does. This is the defence-in-depth term, and its job is to make the length of these
 * lists a number rather than whatever fits in a request body.
 *
 * Applied PER LIST rather than to the sum, so each reader owns its own boundary. A mixed send is
 * therefore bounded at 200 parts and a mixed forward at 300 — the same order of magnitude, and far
 * inside what MIME assembly on this host carries.
 */
export const SEND_MAX_ATTACHMENT_PARTS = 100;

/**
 * THE STAGED LIST, WITH EACH TICKET NAMED ONCE — first occurrence wins, order preserved.
 *
 * ── A REPEAT IS A SKIP, NOT A REFUSAL ───────────────────────────────────────────────────────
 *
 * The product already ruled on this one surface up, and this is that ruling carried to the wire.
 * `ComposeAttach` answers a re-picked file with *"THE SAME FILE TWICE IS A SKIP, NOT A SECOND
 * ROW"* — collapsed, and said in the muted register because nothing went wrong. Erroring here
 * would contradict the form directly above it, and would spend a composed message on what is at
 * worst a client bug.
 *
 * ── WHY THE INLINE LIST IS NOT DEDUPED, AND THE ASYMMETRY IS THE POINT ──────────────────────
 *
 * A staged id is a REFERENCE: naming it twice names one object, so the second naming buys the
 * caller a second download of bytes it did not have to send — that is the amplification. An inline
 * entry CARRIES its bytes: naming it twice costs the caller twice and is counted twice against the
 * cap, so there is nothing to amplify, and collapsing it would mean hashing every attachment's
 * bytes on the send path to undo something the compose form already did.
 *
 * ── WHAT THIS DOES NOT DECIDE ───────────────────────────────────────────────────────────────
 *
 * Not the count ceiling. {@link SEND_MAX_ATTACHMENT_PARTS} is refused against the list AS SENT,
 * ahead of this — the ceiling bounds how many references one request may name, and this decides
 * how many files those references are. `MARK_SEEN_MAX_IDS` orders its two the same way.
 */
export function dedupeStagedIds(ids: readonly string[] | undefined): string[] {
  return ids ? [...new Set(ids)] : [];
}

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
 * THE CAP THAT ACTUALLY APPLIES TO ONE SEND — the smaller of what the HOST can carry and what the
 * MAIL SERVER said it will accept.
 *
 * Two independent ceilings, and neither subsumes the other:
 *
 *  · `surfaceMax` is the host's request pipeline. The hosted API is behind a serverless body limit,
 *    so it declares {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES}. The local engine has no such limit at
 *    all — it is this same service in the same process as the SMTP dial — so it declares `null`.
 *  · `mailboxMax` is the submission server's own RFC 1870 `SIZE` announcement, recorded per mailbox
 *    by the connect-time SMTP probe (mail 0055), or `null` when it announced none.
 *
 * ── THE `min` IS THE POINT, NOT THE `null` HANDLING ──────────────────────────────────────────
 *
 * The interesting case is not a generous provider on the desktop; it is a STINGY one on the hosted
 * service. A provider that announces 2 MB binds a hosted compose to 2 MB even though the platform
 * would have carried 3 — and without the `min` the product would accept the send, spend the user's
 * wait on it, and let their own server bounce it. That is the acceptance check for this rule.
 *
 * ── AN UNKNOWN CEILING IS THE STRICT ONE ─────────────────────────────────────────────────────
 *
 * `undefined` for `surfaceMax` means the host did not declare itself, and it resolves to
 * {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES} rather than to "unbounded" — a caller that forgets must
 * not acquire a bigger allowance by forgetting. When BOTH are unknown (`null` surface, `null`
 * mailbox — a local install whose server has never been probed) there is no measured ceiling
 * anywhere, and the answer is again the product constant, for the reason mail 0055's own header
 * gives: an unknown limit read as no limit costs the user a message they composed and waited for.
 *
 * Non-positive and non-finite values are ignored on both sides. A `0` from either — a server
 * announcing `SIZE 0`, which RFC 1870 §6 defines as "no fixed maximum", or a host declaring a cap
 * of nothing — must never become a ceiling no message can clear.
 */
export function effectiveAttachmentCap(
  surfaceMax: number | null | undefined,
  mailboxMax: number | null | undefined,
): number {
  const usable = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  const surface = surfaceMax === undefined ? SEND_ATTACHMENT_MAX_TOTAL_BYTES : surfaceMax;
  const bounds = [surface, mailboxMax].filter(usable);
  return bounds.length > 0 ? Math.min(...bounds) : SEND_ATTACHMENT_MAX_TOTAL_BYTES;
}

/**
 * WHICH SURFACE CEILING THIS PARTICULAR SEND RIDES — and the answer is a property of the
 * TRANSPORT THE BYTES TOOK, not of the host.
 *
 * {@link SendDeps.surfaceMaxTotalBytes} describes the host's REQUEST PIPELINE, which is the right
 * description of a send whose attachment bytes are in the request body. Staged bytes are not: they
 * went from the browser to object storage on a signed URL and this process pulls them from there,
 * so no request-body limit stands between the compose form and the transport and the host's
 * declaration is simply not about them.
 *
 * So a send carrying ONLY staged references resolves the surface to `null` — explicitly uncapped,
 * the same value the local engine declares for the same underlying reason — and the mailbox's own
 * RFC 1870 `SIZE` announcement is then the only ceiling, with the usual "unknown is the strict
 * one" fallback when the mailbox has never been probed.
 *
 * A send carrying ANY inline attachment keeps the host's declaration, including a MIXED send. That
 * is the conservative direction and it is deliberate: the inline half of a mixed send really did
 * ride the request body, and a rule that read "some of these were staged, so lift the limit"
 * would let a request through that the platform in front of this handler refuses first — with an
 * opaque error the user cannot act on, which is the exact failure
 * {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES} exists to prevent.
 *
 * A send with no attachments at all keeps the host's declaration too, which is a distinction
 * without a difference (the total is zero) and one fewer branch to reason about.
 */
export function sendSurfaceFor(
  hostSurfaceMax: number | null | undefined,
  input: Pick<SendInput, "attachments" | "stagedAttachmentIds">,
): number | null | undefined {
  const staged = input.stagedAttachmentIds?.length ?? 0;
  const inline = input.attachments?.length ?? 0;
  return staged > 0 && inline === 0 ? null : hostSurfaceMax;
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
    const reservation = await this.reserve(ctx, draftId, idempotencyKey, deps, input);

    // A same-key request that hit the UNIQUE reservation: branch on stored status.
    if (reservation.kind === "existing") {
      return this.resumeExisting(ctx, reservation.row, reservation.mailboxId, deps);
    }

    // ── 2. SMTP OUTSIDE the tx. Always close() in finally. ───────────────
    const { sendId, mintedMessageId, mailboxId, msg } = reservation;

    // ── STAGED: PULL THE BYTES FROM OBJECT STORAGE onto the outgoing message ────────────────
    //
    // Here, outside the reservation tx (it is network) and BEFORE `send`, exactly where the
    // forward's IMAP stream runs and for the same reasons: the files must be on the one
    // `OutboundMessage` that both goes out and is appended to Sent, and they are never persisted.
    //
    // A failure is NOT swallowed. `fetch` throws when an object is gone or is bigger than its
    // ticket declared, and that ends the send with the reservation still `pending` — the user
    // retries under the same key. A send that quietly dropped an attachment the composer showed
    // is a wrong send, which is the same ruling the forward path already made.
    //
    // The bytes were already refused against the cap BY DECLARATION in `reserve`; `fetch`
    // re-measures each object against its own ticket, so what lands here can only be smaller.
    //
    // DEDUPED, and the same list `reserve` weighed. One ticket named twice is one file: the bytes
    // are pulled once and the recipient gets one copy. Both halves of that mattered — before it,
    // a repeated id was a second object-storage download AND a second copy of the file on the
    // message, so the amplification and a plain correctness bug sat on the same line.
    const stagedIds = dedupeStagedIds(input.stagedAttachmentIds);
    if (stagedIds.length > 0 && deps.stagedAttachments) {
      const staged = await deps.stagedAttachments.fetch(ctx.accountId, stagedIds, ctx.now());
      // INLINE FIRST, then staged — the order a mixed send's composer listed them in, and the
      // order the recipient sees. `msg.attachments` is absent for a staged-only send (the
      // reservation only sets it from `input.attachments`), so this is also where that key
      // appears at all.
      msg.attachments = [...(msg.attachments ?? []), ...staged];
    }

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
      /**
       * THE COPY THE SEND PATH JUST PUT IN THE USER'S SENT FOLDER — locator + the exact bytes.
       *
       * Absent for a spy, and for any adapter that files sent mail some other way; the projection
       * below is then skipped and the Sent-folder watch is the only path, exactly as before.
       */
      let appended: AppendedSent | undefined;
      try {
        const res = await adapter.send(msg);
        providerMessageId = res.providerMessageId;
        appended = res.appended;
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

      // ── 4. RECORD-AT-SEND (a SEPARATE short tx, best-effort) ────────────────
      //
      // AFTER the finalize and outside its transaction, both deliberately. See
      // `projectSentCopy` for why a failure here may never reach the caller.
      await this.projectSentCopy(ctx, mailboxId, appended, deps);
      return { status: "sent", providerMessageId, draftId, seq };
    } finally {
      await adapter.close();
    }
  }

  /**
   * PROJECT THE SENT COPY INTO THE DATABASE NOW, instead of waiting for the mailbox to be re-read.
   *
   * `ImapAdapter.send` has already APPENDed this message to the user's own Sent folder, so the
   * master holds it before this function runs. Until this existed, the `messages` row was written
   * only by the sync worker's next pass over that folder — a whole poll interval between pressing
   * Send and the message existing anywhere the reader can see it.
   * `sent-record.ts#recordSentMessage` is the projection and its header carries the design; this
   * function is only the placement and the failure policy, and both are load-bearing.
   *
   * ── A SEPARATE TRANSACTION, AFTER THE FINALIZE, AND NEVER INSIDE IT ────────────────────────
   *
   * Folding this into `finalizeSent` would put a MIME parse, a thread resolution and five entity
   * writes inside the transaction that holds the account's seq row lock and issues the
   * mailbox doorbell — and, far worse, would make a failure to record roll the finalize back. The
   * reservation would stay `pending` and the draft would never reach `sent` for a message that HAS
   * ALREADY BEEN DELIVERED, which is the single outcome the whole reservation design exists to
   * prevent (the same argument `finalizeSent`'s `SKIP LOCKED` note makes about a lock wait).
   *
   * ── AND A FAILURE IS LOGGED, NEVER THROWN ─────────────────────────────────────────────────
   *
   * The mail is gone. Nothing this function can discover changes that, and a 500 answering a send
   * that succeeded is worse than a row that shows up on the worker's next cycle — which it will,
   * because the Sent-folder watch is untouched and remains the backstop for exactly this case. So
   * every fault is swallowed: a bad parse, an oversize body `normalizeMime` refuses, a serialization
   * failure, a locator the instance table rejects. The send answers `sent` either way.
   *
   * ── AND THE RESPONSE'S `seq` IS DELIBERATELY STILL THE FINALIZE'S ─────────────────────────
   *
   * `seq` becomes `X-Sync-Seq`, the mark the client drains past. It is NOT advanced to the
   * projection's rows, and it does not need to be: the client issues its drain AFTER this response
   * arrives, and a `/sync` request reads the log at request time, so this transaction has already
   * committed by the time that read happens. The message row is in the very next drain either way.
   * Leaving `seq` alone keeps a send's echo meaning exactly what it always meant — the draft's own
   * transition — and keeps a skipped projection indistinguishable from the pre-projection wire.
   */
  private async projectSentCopy(
    ctx: ServiceContext,
    mailboxId: string,
    appended: AppendedSent | undefined,
    deps: SendDeps,
  ): Promise<void> {
    // No append to project. Not a failure and not logged: a spy adapter is the ordinary case in
    // tests, and an adapter that cannot say what it appended is covered by the Sent-folder watch.
    if (!appended) return;
    try {
      await recordSentMessage(appended, {
        accountId: ctx.accountId,
        mailboxId,
        // The read phase runs on the request's own handle, outside a transaction — the same shape
        // the worker's plan phase has.
        repo: makeDrizzleRepo(ctx.db as never) as RepoPort,
        withTx: (run) => asTx(ctx).transaction(
          (tx) => run(makeDrizzleRepo(tx as never) as RepoPort & RoutingPort),
        ),
      });
    } catch (err) {
      (deps.log ?? defaultLog).warn("sent_record_failed", {
        accountId: ctx.accountId,
        mailboxId,
        err,
        reason: "the message WAS delivered and appended to the Sent folder; only the local row is " +
          "late. The sync worker's Sent-folder pass writes it on its next cycle",
      });
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
    ctx: ServiceContext, draftId: string, idempotencyKey: string, deps: SendDeps, input: SendInput,
  ): Promise<Reservation> {
    const inlineTotal = (input.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0);
    // ── STAGED REFERENCES: WHAT THEY WEIGH, BEFORE ANYTHING IS TRANSFERRED ──────────────────
    //
    // Outside the transaction, deliberately: this is a second query and the reserve tx holds a
    // `FOR UPDATE` lock on the draft row. It is also the ONLY place the total can be refused
    // cheaply — after the reservation the bytes have to be pulled to be measured, and an
    // authenticated caller that can make this process download an arbitrary amount it then throws
    // away is a cost hole an authenticated caller could open at will.
    //
    // The numbers are the client's own declarations from mint time and are treated as such: they
    // bound what we are WILLING to fetch. `fetch` re-measures, and a body larger than its ticket
    // declared never reaches the transport.
    //
    // DEDUPED HERE TOO, and it has to be the same list `send` will fetch, or the total refused
    // against the cap is not the total that gets pulled. Summing per OCCURRENCE would also let a
    // repeated one-byte ticket inflate the declared total until the cap fired on bytes nobody was
    // going to transfer twice — a 413 for a send that is under the limit.
    const stagedIds = dedupeStagedIds(input.stagedAttachmentIds);
    let stagedTotal = 0;
    /**
     * A STAGED-REFERENCE PROBLEM, HELD RATHER THAN THROWN — because an idempotent REPLAY must
     * not be turned into an error by it.
     *
     * The refusals below are about the tickets a client named, and a same-key retry that reaches
     * the CONFLICT branch is not asking to send anything: it is asking what happened last time.
     * Thrown here, an expired ticket would answer "your upload expired" to a replay of a send
     * that SUCCEEDED — telling the user their message failed when the mail is in their Sent
     * folder, which is the worst ending available on this path. So the fault is carried into the
     * transaction and raised beside the disabled-mailbox check, AFTER the conflict branch has
     * returned, on exactly the same reasoning that check's own header sets out.
     *
     * `stagedTotal` is left at 0 when a fault is held, so the cap check (which runs before the
     * INSERT) cannot fire a spurious 413 off a partial sum and mask the real answer.
     */
    let stagedFault: ServiceError | null = null;
    if (stagedIds.length > 0) {
      if (!deps.stagedAttachments) {
        // A host with no staging capability was handed staged references. Refuse — sending the
        // message without its attachments would be a wrong send, and this is the shape the
        // standalone door would take if anything ever asked it to stage.
        stagedFault = new ServiceError(
          "validation_failed", 400,
          "this server does not accept staged attachments",
        );
      } else {
        const facts = await deps.stagedAttachments.declare(ctx.accountId, stagedIds);
        const byId = new Map(facts.map((f) => [f.id, f]));
        const now = ctx.now();
        for (const id of stagedIds) {
          const f = byId.get(id);
          // ONE ANSWER for "not yours" and "never existed" — the lookup is account-scoped, so a
          // foreign id is simply absent, and distinguishing the two would make this an oracle for
          // whether an id exists in another account.
          if (!f) {
            stagedFault = new ServiceError("not_found", 404, "an uploaded attachment was not found");
            break;
          }
          if (f.expiresAt.getTime() <= now.getTime()) {
            stagedFault = new ServiceError(
              "conflict", 409,
              "an uploaded attachment has expired. Attach the file again and resend.",
            );
            break;
          }
          stagedTotal += f.sizeBytes;
        }
        if (stagedFault) stagedTotal = 0;
      }
    }
    const attachTotal = inlineTotal + stagedTotal;
    return asTx(ctx).transaction(async (tx): Promise<Reservation> => {
      // `FOR UPDATE`, because this read decides the SENDING IDENTITY. The draft's `mailboxId`
      // is PATCHable while the row is a draft (`DraftsService.update`), and a plain read-
      // committed SELECT does not wait for a concurrent move's row lock — it reads the
      // pre-move snapshot, so the envelope, the minted Message-ID and the SMTP dial would all
      // be the OLD identity's while the row (and every screen) commits the new one. Locking
      // the row serializes the two writers: reserve either waits and reads what the move
      // committed, or wins and flips the row to `sending`, at which point the move's own
      // status predicate refuses it. Measured, not reasoned — `draft-move-race.pg.test.ts`
      // watched the plain SELECT dial the pre-move mailbox across two real connections.
      // The lock is safe to WAIT on here (unlike the finalize's mailbox doorbell, which must
      // `SKIP LOCKED`): nothing has been sent yet, every other holder of a drafts row lock is
      // a short CRUD transaction, and a reserve that waits a few milliseconds is a reserve
      // that tells the truth.
      const [d] = await tx.select().from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)))
        .for("update").limit(1);
      if (!d) throw new ServiceError("not_found", 404, "draft not found");

      const [mb] = await tx.select({
        address: mailboxes.address, status: mailboxes.status,
        smtpMaxSizeBytes: mailboxes.smtpMaxSizeBytes,
      }).from(mailboxes)
        .where(eq(mailboxes.id, d.mailboxId)).limit(1);

      // ── THE ATTACHMENT CAP, refused BEFORE the reservation commits ────────────────────────
      //
      // Enforced on the decoded bytes (the route already rejected a body over the platform limit);
      // this is the product rule and the number the compose surface states. It throws INSIDE the
      // transaction and therefore rolls it back, so nothing is reserved and no draft leaves
      // `draft` — the property this check has always had.
      //
      // It reads the mailbox row, which is why it is here rather than ahead of the transaction as
      // it used to be: the ceiling is per-mailbox now ({@link effectiveAttachmentCap}), the
      // SMALLER of the host's platform limit and what this mailbox's own submission server
      // announced. The reordering costs one thing worth naming — a send over the cap on a draft
      // that does not exist now answers 404 rather than 413, because the draft is loaded first.
      // That is the more truthful of the two answers to a request naming nothing.
      // The surface is `sendSurfaceFor`'s and not `deps`' directly — see that function: staged
      // bytes did not ride this host's request body, so the host's declaration about that body is
      // not a statement about them.
      const cap = effectiveAttachmentCap(
        sendSurfaceFor(deps.surfaceMaxTotalBytes, input),
        mb?.smtpMaxSizeBytes ?? null,
      );
      if (attachTotal > cap) {
        throw new ServiceError(
          "payload_too_large", 413,
          `attachments total ${attachTotal} bytes; the limit is ${cap}`,
        );
      }

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
      // THE HELD STAGED FAULT, raised here and not where it was found — see `stagedFault`. It
      // sits with the disabled-mailbox check for the identical reason that check gives: above the
      // INSERT it would also catch the CONFLICT branch, which returns before reaching here, and
      // that branch is idempotent REPLAY. Throwing anywhere in this callback rolls the whole
      // transaction back, the INSERT above included, so a NEW reservation refuses exactly as it
      // would have and no `outbound_sends` row survives.
      if (stagedFault) throw stagedFault;

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
