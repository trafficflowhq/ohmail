import { and, asc, eq, sql } from "drizzle-orm";
import {
  attachments, drafts, mailboxes, messageBodies, messages, outboundSends, recordChange, threads, type Tx,
} from "@trafficflow/db";
import {
  createLogger, isMessageGone, mintMessageId, recordSentMessage,
  type AppendedSent, type EmailAddress, type Logger, type NativeLocator, type OutboundMessage,
  type OpenSendAdapter, type RepoPort, type RoutingPort, type SendAdapter, type StorageCap,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ServiceContext } from "./context.js";
import type { AttachmentAdapter, OpenAdapter } from "./attachments-service.js";
import { ServiceError, TransientDialRefusal } from "./errors.js";
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

/**
 * Do two locators name the same physical message?
 *
 * Both halves, and the `ref` half is the one that carries the epoch (`${uidvalidity}:${uid}`), so
 * this is also what tells a re-adopted message from a merely re-read row. Used to decide whether a
 * re-read locator is worth a second fetch — see {@link SendService.streamForwardParts}.
 */
function sameLocator(a: NativeLocator, b: NativeLocator): boolean {
  return a.folder === b.folder && a.ref === b.ref;
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
 *
 * ── THE BLOCK CARRIES NO SEPARATOR. {@link forwardJoin} OWNS THAT ───────────────────────────
 *
 * This used to return `\n\n` + the banner in text and `<br><br><hr>` + the banner in html — the
 * gap between the author's note and the quote, baked into the quote. A forward may now be sent
 * with NO note (the forwarded message is the content; the note is the optional part), and then
 * there is nothing to separate FROM: the gap became the first thing in the mail — two blank lines
 * above the banner in text/plain, and a rule floating over nothing in html.
 *
 * A separator between two things belongs to the join, not to either thing, so it moved there.
 * The block returned here starts on the banner and can be sent as-is.
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
  const text = `${headerLines.join("\n")}\n\n${originalText}`;
  const bodyHtml = originalHtml
    ? sanitizeOutboundHtml(originalHtml)
    : escapeHtml(originalText).replace(/\n/g, "<br>");
  const html =
    `<div>---------- Forwarded message ----------</div>` +
    `<div>From: ${escapeHtml(orig.from)}</div>` +
    (dateStr ? `<div>Date: ${escapeHtml(dateStr)}</div>` : "") +
    `<div>Subject: ${escapeHtml(orig.subject)}</div>` +
    `<blockquote>${bodyHtml}</blockquote>`;
  return { text, html };
}

/**
 * THE AUTHOR'S NOTE ABOVE A QUOTED ORIGINAL — with the separator only where there are two things.
 *
 * `note` is the draft's own body (or its sanitized html); `quote` is {@link forwardedQuote}'s
 * separator-free block; `gap` is what stands between them in this part's syntax. A BLANK note —
 * absent, empty, or nothing but whitespace — yields the quote alone, which is what a forward sent
 * with no message of its own is: the forwarded mail, opening on its own banner.
 *
 * Blankness is judged on the PLAIN note in both arms (see the call site), so the two parts of a
 * multipart forward cannot disagree about whether a note exists — and it is the same `trim()`
 * emptiness the client's Send lock exempts (`mail-send.ts#canSend`), so a note the editor let
 * through as "nothing" is not printed here as a gap.
 */
function forwardJoin(note: string, quote: string, gap: string, blankNote: boolean): string {
  return blankNote ? quote : note + gap + quote;
}

/** Per-call send deps: the INJECTED adapter factory (prod = makeSendAdapter; tests = a fake/GreenMail spy). */
export interface SendDeps {
  openSendAdapter: OpenSendAdapter;
  /**
   * THE ACCOUNT'S MANAGED STORAGE CAP, for the sent-copy projection — resolved lazily (per
   * send, inside the projection's own try) because the cap is per-account and this bag is built
   * per request before anything about the account's billing has been read.
   *
   * The hosted API resolves it from the subscription row (`ApiDeps.storageCapOf`); the local
   * engine and the self-host server type `UNMETERED_STORAGE_CAP` — a value somebody WROTE, the
   * declaration-not-inference rule. ABSENT means REFUSAL, never unmetered — the
   * mailbox-allowance registry's exact default: `projectSentCopy` substitutes a resolver that
   * throws, which costs exactly the projection (swallowed and logged; the send answered `sent`
   * long before), and the worker's Sent-folder pass — metered through its own REQUIRED cap —
   * writes the row on its next cycle. So a host nobody read gets a loud log line per send and a
   * row that arrives a poll interval late, and can never get uncapped storage.
   */
  resolveStorageCap?: (ctx: ServiceContext) => Promise<StorageCap>;
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
  /**
   * Override {@link SEND_ATTEMPT_CEILING_MS} for this attempt. A TEST SEAM, and it is the only
   * way the two ceiling outcomes can be driven: the alternative is a suite that waits twenty
   * real seconds per case, which is not a suite anybody runs.
   *
   * It is deliberately not a per-host configuration knob. The ceiling is a statement about how
   * long a person will watch a button, and that is the same number on every door.
   */
  attemptCeilingMs?: number;
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
 * HOW MANY ADDRESSES ONE SENT MESSAGE MAY REACH — `to` + `cc` + `bcc`, together.
 *
 * This is the per-MESSAGE ceiling, and it belongs here rather than beside `DRAFT_MAX_RECIPIENTS`
 * because here is where the count stops being three stored columns and becomes network: the
 * transport issues one `RCPT TO` command per address on a socket THIS process holds open, and
 * the recipient headers it writes grow with them.
 *
 * 500, which is the LARGEST of the per-message recipient ceilings among the providers whose
 * mailboxes this product connects to — Outlook/Microsoft 365 and iCloud both allow 500, Gmail
 * allows 100 — and that choice is a correction. It was briefly 100, "the tightest, so above it
 * the provider refuses anyway". The premise is false for two of the three: an Outlook or iCloud
 * user sending to 300 people is doing something their provider will deliver, and a ceiling
 * derived from Gmail's number would have refused it on Gmail's behalf.
 *
 * The bound's job here is to stop the UNBOUNDED case, not to enforce each provider's policy —
 * a provider stricter than this still answers with its own refusal, which is its to make. A
 * per-mailbox ceiling learned from the SMTP probe (as `smtp_max_size_bytes` already is for bytes)
 * would be better than one number and is the obvious next step; it is not this slice.
 *
 * Checked INSIDE the reserve transaction, beside the attachment cap and for its stated reason:
 * throwing there rolls the reservation back, so nothing is reserved and the draft never leaves
 * `draft`.
 *
 * ── WHAT IT ACTUALLY CATCHES, stated rather than implied ─────────────────────────────────
 *
 * `DRAFT_MAX_RECIPIENTS` is 100 per field and there are three fields, so a draft assembled
 * through `DraftsService` can hold at most 300 — under this ceiling by construction. **So this
 * bound is a guard on the STORED ROW, not on the compose path**: a draft written before either
 * ceiling existed, or by any later writer that reaches the column without going through
 * `validAddresses`, is still what the transport is handed. That is the same reasoning
 * `assertRunnable` applies to a stored `steps` array, and the same reason a write-time bound is
 * not enough on its own: the row outlives the validator that wrote it.
 *
 * The two numbers are deliberately not made to meet. Raising the per-field cap to make them
 * interact would loosen the compose path to justify a test, and lowering this one to 300 would
 * refuse an Outlook or iCloud send those providers would deliver.
 */
export const SEND_MAX_RECIPIENTS = 500;

/**
 * The longest `filename` and `contentType` one attachment entry may carry.
 *
 * `SEND_MAX_ATTACHMENT_PARTS` bounds how MANY entries a send names and
 * `SEND_ATTACHMENT_MAX_TOTAL_BYTES` bounds their CONTENT — and each entry's two strings were
 * bounded by neither. They are not content: they become MIME header parameters on the outgoing
 * message and a stored column on the staged ticket, so a hundred entries carrying a megabyte
 * filename each is a megabyte-per-header message the transport has to build.
 *
 * 255 is the practical filename ceiling every mainstream filesystem shares, and a content type is
 * far shorter than that — one number for both, because a caller who exceeds either has not sent a
 * filename or a media type.
 */
export const SEND_ATTACHMENT_FIELD_MAX_CHARS = 255;

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
 * WHAT THE MESSAGE COSTS BEFORE A SINGLE ATTACHMENT BYTE IS COUNTED — headers, the MIME
 * boundaries, and the body somebody typed.
 *
 * `SIZE` bounds the whole document, and {@link attachmentBudgetFor} converts it into a budget for
 * attachment bytes only; everything else in the message has to come out of the announcement first
 * or the conversion is optimistic by exactly the size of the letter. 64 KiB is generous for the
 * headers and boundaries and covers an ordinary body with room to spare. It is not a bound on the
 * body — a message with a megabyte of typed text can still be refused by the server — and it is
 * not pretending to be: the honest description is an allowance, and erring high here costs the
 * user 64 KiB of attachment they will never notice, while erring low costs them a bounced send.
 */
export const SEND_MIME_ENVELOPE_BYTES = 64 * 1024;

/**
 * THE PER-OBJECT CEILING OF THE STAGING BUCKET, and therefore of the transport that uses it.
 *
 * Uploading straight to object storage removes the request-body limit; it does not remove every
 * limit. The bucket refuses an object over its configured size, and it does so in the BROWSER's
 * PUT — after the mint answered 201 and after the person waited for the upload. The client can
 * only report that as "try again", which is a retry that can never succeed. So the number is
 * stated here, applied by the mint, and declared by the hosted window as its surface.
 *
 * It MIRRORS the bucket's own `file_size_limit` and cannot verify it from here: the bucket is
 * remote configuration. The direction of any drift is what matters — a bucket configured LARGER
 * than this simply goes unused above this line, while a bucket configured SMALLER reintroduces
 * exactly the failure above. Raising this number therefore means raising the bucket first.
 */
export const SEND_STAGED_OBJECT_MAX_BYTES = 40 * 1024 * 1024;

/**
 * AN ANNOUNCED `SIZE` IS ABOUT THE ENCODED MESSAGE. This converts it into a budget for RAW
 * attachment bytes, which is what every caller here actually counts.
 *
 * RFC 1870's `SIZE` is the largest MESSAGE a submission server will accept, and a message is the
 * MIME document: attachments are base64 — four characters per three bytes — and the transfer
 * encoding wraps at 76 characters with a CRLF. So the expansion is (4/3)·(78/76), and the inverse
 * is exactly 19/26. 25 MB of files is about 34 MB of message.
 *
 * Reading the announcement as a raw budget therefore overshoots by more than a third, and the cost
 * of that lands on the user: they attach 25 MB to a server that said 25 MB, wait for the send, and
 * their own provider bounces it. This is the one direction the rule may not err in — the same
 * reason an unknown ceiling is read as the strict one rather than as no ceiling.
 *
 * ── WHY THIS WAS INVISIBLE UNTIL NOW ────────────────────────────────────────────────────────
 *
 * While every mailbox fell back to {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES}, the announcement was
 * never the binding term: 3 MB of files is about 4 MB of message, and no provider announces
 * anything that small. The overshoot became reachable the moment real announcements started being
 * learned for mailboxes that were already connected.
 *
 * The result is FLOORED AT ONE BYTE rather than allowed to reach zero. A server announcing less
 * than the envelope allowance accepts no attachment at all, and that is the truth — but zero and
 * negative are read as "not a ceiling" by {@link effectiveAttachmentCap}, which would make the
 * stingiest server in the world the most permissive one.
 */
export function attachmentBudgetFor(announcedMessageBytes: number): number {
  const forAttachments = announcedMessageBytes - SEND_MIME_ENVELOPE_BYTES;
  if (forAttachments <= 0) return 1;
  return Math.max(1, Math.floor((forAttachments * 19) / 26));
}

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
 * ── AN UNKNOWN CEILING IS THE STRICT ONE — ON EITHER SIDE ────────────────────────────────────
 *
 * `undefined` for `surfaceMax` means the host did not declare itself, and it resolves to
 * {@link SEND_ATTACHMENT_MAX_TOTAL_BYTES} rather than to "unbounded" — a caller that forgets must
 * not acquire a bigger allowance by forgetting. A `null` MAILBOX ceiling means the submission
 * server has never been probed, and it resolves to the same product constant rather than
 * dropping out of the `min` — this used to contribute NOTHING, which was invisible while every
 * declared surface was the 3 MB constant itself, and became a real widening the day a
 * long-running host declared a 32 MB transport surface: every never-probed mailbox silently
 * acquired 32 MB and learned its provider's real limit from an SMTP bounce after the wait. The
 * reason is mail 0055's own header, applied to both sides: an unknown limit read as no limit
 * costs the user a message they composed and waited for.
 *
 * Non-positive and non-finite values are ignored (never strict-substituted) on both sides. A `0`
 * from the mailbox — a server announcing `SIZE 0`, which RFC 1870 §6 defines as "no fixed
 * maximum" — is a MEASUREMENT saying the server takes anything, so the surface alone binds; a
 * host declaring a cap of nothing must never become a ceiling no message can clear.
 */
export function effectiveAttachmentCap(
  surfaceMax: number | null | undefined,
  mailboxMax: number | null | undefined,
): number {
  const usable = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  const surface = surfaceMax === undefined ? SEND_ATTACHMENT_MAX_TOTAL_BYTES : surfaceMax;
  const bounds: number[] = [];
  if (usable(surface)) bounds.push(surface);
  if (mailboxMax === null || mailboxMax === undefined) {
    // UNPROBED. The strict constant, and NOT run through `attachmentBudgetFor`: that constant
    // already describes raw attachment bytes, so converting it would shrink an unprobed mailbox's
    // allowance for a reason that has nothing to do with the mailbox.
    bounds.push(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  } else if (usable(mailboxMax)) {
    // A REAL ANNOUNCEMENT, which is about the encoded message — see `attachmentBudgetFor`.
    bounds.push(attachmentBudgetFor(mailboxMax));
  }
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
 * The Drafts-row sentence for a definite non-delivery whose cause has no sentence of its own.
 *
 * A `ServiceError` carries one already and it is quoted verbatim ({@link SendService.finalizeFailed});
 * this is for everything else — a socket reset while logging in, a storage read that threw, any
 * unexpected fault inside the pre-SMTP window. Those errors' messages are diagnostics, not
 * sentences: they name hosts, ports and library internals, and they belong in the log this pass
 * already writes, not in a row a person reads.
 *
 * It states the one fact that is certain and the one action that works. It deliberately does NOT
 * say "check your Sent folder" — that sentence is reserved for `unverified`, where the fate really
 * is unknown, and saying it here is the exact lie the pre-SMTP window was built to stop telling.
 */
export const SEND_FAILED_SENTENCE =
  "This was not sent — the message never reached your mail server. Send it again.";

/**
 * HOW LONG ONE SEND ATTEMPT MAY HOLD THE PRESS BEFORE THE ANSWER STOPS WAITING FOR IT.
 *
 * Not a network deadline — {@link DEFAULT_NET_TIMEOUTS} already bounds each individual socket
 * operation (15 s to connect, 25 s of inactivity). The gap this closes is that a send is a
 * SEQUENCE of those: a cold IMAP dial + LOGIN + LIST, then a full SMTP session, then a second
 * LIST, then an APPEND of the whole message. Every one of them can sit just under its own
 * deadline without any of them tripping, so the sequence had no ceiling at all, and the press
 * that started it had nothing to wait on but the platform's own kill.
 *
 * ── WHAT IT COVERS, STATED EXACTLY, BECAUSE "THE WHOLE ATTEMPT" WAS TOO STRONG ─────────────
 *
 * The clock starts once the RESERVATION HAS COMMITTED and covers everything after it: assembly,
 * the dial, the submission, the finalize, the projection — every step that touches a network or
 * can hang. It does NOT cover `reserve` itself, and that is a real residual rather than an
 * oversight to gloss: `reserve` takes `FOR UPDATE` on the draft row and its `recordChange` takes
 * the account's seq lock, and a lock wait does not throw. It is left outside because a breach
 * there would have no reservation to finalize and no key to answer under, so bailing would risk
 * a transaction that commits afterwards — a reservation nobody told the client about. The state
 * that resolves is a same-key retry, which is what `resumeExisting` is for; a ceiling that
 * manufactured a second unresolvable state to bound a lock wait would be the worse trade.
 * `totalMs` on the phase line DOES include the reservation, so the number an operator reads is
 * the whole request even though the clock is not.
 *
 * The number is chosen against what the sequence actually costs, not guessed. A send opens a
 * FRESH adapter every time, so every press pays a full cold dial; on some providers that dial is
 * the largest phase of the attempt and swings by nearly an order of magnitude between consecutive
 * presses on one mailbox, while on others the whole attempt finishes in a fraction of a second.
 * A ceiling therefore has to sit far above every healthy attempt and far below the 60-second
 * serverless invocation limit that is otherwise the only thing that ends a hung one — being
 * killed BY the platform is the one failure with no error handling at all: no `finally`, no
 * `close()`, no response, and a reservation left `pending` with nobody told.
 *
 * WHAT A BREACH MEANS depends on where it lands, and the boundary is the one the pre-SMTP
 * window already draws — "has anything been offered to a server yet":
 *   before `adapter.send`   nothing was offered, so this is a DEFINITE non-delivery and is
 *                           recorded as one ({@link SEND_TIMEOUT_SENTENCE}, status `failed`).
 *   at or after it          the fate is genuinely UNKNOWN. The reservation is left `pending`
 *                           with its key intact and the answer is `queued`. Nothing is
 *                           resent — see {@link SendResult}.
 */
export const SEND_ATTEMPT_CEILING_MS = 20_000;

/**
 * The Drafts-row sentence for an attempt that ran out of time BEFORE anything was offered to a
 * server. A sibling of {@link SEND_FAILED_SENTENCE} and it makes the same promise — the message
 * did not go — because at this point in the sequence that is provable. It names the cause,
 * because "the server did not answer in time" is a fact the reader can act on (try again, or
 * check the mailbox) in a way that "this was not sent" alone is not.
 */
export const SEND_TIMEOUT_SENTENCE =
  "This was not sent — your mail server did not answer in time. Send it again.";

/**
 * The outcome the route maps to an HTTP response:
 *  - `sent`       → 200 { status, providerMessageId } (+ X-Sync-Seq)
 *  - `unverified` → 200 { status } — ambiguous, surfaced ("check Sent before retrying")
 *  - `failed`     → 409 — a definitively-undelivered prior attempt under this key
 *  - `in_flight`  → 409 — a genuinely-concurrent attempt is mid-flight
 *  - `queued`     → 202 — THIS request reserved the send and then stopped waiting for the
 *                   submission at {@link SEND_ATTEMPT_CEILING_MS}. The envelope may or may not
 *                   have reached the server, so this is the SAME unknown fate `unverified`
 *                   describes, caught earlier and while the attempt is still alive.
 *
 * `queued` is distinct from `in_flight` on purpose, though both say "not settled yet". `in_flight`
 * is what a SECOND request is told about someone else's live attempt; `queued` is what the
 * OWNING request is told about its own. The reader-facing difference is that `queued` is the only
 * one of the two that can be produced by a first press, so it is the one the compose surface has
 * to be able to close on.
 *
 * NOTHING IS EVER RESENT ON `queued`. The reservation stays `pending` with its `send_key`
 * standing, which is precisely the state {@link SendService.resumeExisting} reads: a same-key
 * retry answers `in_flight` while the attempt could still be alive and runs verify-by-Sent once
 * it provably is not. One press stays one delivery.
 */
export interface SendResult {
  status: "sent" | "unverified" | "failed" | "in_flight" | "queued";
  providerMessageId: string | null;
  draftId: string;
  seq: number | null;
}

/**
 * HOW a stale reservation was decided — the half of {@link ResolveStaleOutcome} the reconciling
 * pass counts and the client path discards.
 *
 *  · `mirror`      the account's own `messages` mirror already holds the minted id. No dial.
 *  · `probe`       the Sent folder was searched over a live connection and answered.
 *  · `undialable`  no dial was possible or permitted and the caller asked for a decision anyway
 *                  (a `disabled` mailbox, a mailbox whose credentials are gone, a give-up).
 *  · `elsewhere`   the compare-and-swap matched nothing: another resolver had already written a
 *                  terminal state, and `status` is THEIRS, re-read.
 *  · `deferred`    nothing was written and nothing is claimed — try again next cycle.
 */
export type ResolveStaleBy = "mirror" | "probe" | "undialable" | "elsewhere" | "deferred";

/**
 * What became of one stale reservation. `status` is `pending` only alongside `by: "deferred"`,
 * which is the one outcome that wrote nothing.
 */
export interface ResolveStaleOutcome {
  status: "sent" | "unverified" | "failed" | "pending";
  providerMessageId: string | null;
  draftId: string;
  /** The `change_log` seq this call emitted, or `null` when it emitted none. */
  seq: number | null;
  by: ResolveStaleBy;
}

/**
 * The ceiling as a thing that can be raced — one timer per attempt, shared by both phases.
 *
 * ONE clock for the whole attempt rather than one per phase, because the budget being spent is
 * the reader's patience and it does not reset when the dial finishes. A per-phase timer would
 * let a slow open and a slow submission add up to twice the ceiling, which is the shape of the
 * unbounded sequence this exists to end.
 *
 * `reached` NEVER rejects: it is a race arm, and an arm that can reject would turn "we ran out of
 * time" into a throw the caller has to distinguish from a real fault.
 */
const CEILING_REACHED = Symbol("send-attempt-ceiling");

interface AttemptCeiling {
  readonly reached: Promise<typeof CEILING_REACHED>;
  /** Stop the timer. Idempotent, and REQUIRED — a live timer keeps a Node process awake. */
  cancel(): void;
}

function startAttemptCeiling(ms: number): AttemptCeiling {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<typeof CEILING_REACHED>((resolve) => {
    timer = setTimeout(() => resolve(CEILING_REACHED), ms);
  });
  return {
    reached,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Race a phase against the attempt ceiling.
 *
 * The losing promise is NOT cancelled and must not be — there is no way to un-send an envelope,
 * and on a host whose process outlives the response (the desktop's local engine) the abandoned
 * submission goes on to its own finalizer, which is exactly the recovery this design wants: the
 * row flips to `sent` on its own and the client learns it from the next `/sync`. On a serverless
 * host the invocation ends instead and the reservation is resolved by the same verify-by-Sent
 * recovery a crashed attempt has always used. Neither host resends.
 *
 * The caller is therefore responsible for what happens to an abandoned promise — see the two
 * call sites in {@link SendService.send}, which close a leaked socket in one case and let the
 * submission finish in the other.
 */
async function raceCeiling<T>(work: Promise<T>, ceiling: AttemptCeiling): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  const outcome = await Promise.race([
    work.then((value) => ({ timedOut: false as const, value })),
    ceiling.reached.then(() => ({ timedOut: true as const })),
  ]);
  return outcome;
}

/**
 * The per-phase millisecond costs of ONE attempt, logged once when it settles.
 *
 * It exists because "sending is slow" was, for the whole life of this path, a claim nobody could
 * decompose: the request awaits a reservation transaction, an object-storage read, a cold IMAP
 * dial, a full SMTP session, an IMAP APPEND and three more transactions, and the answer to WHICH
 * of them costs the seconds is different per provider — measured, the dial dominates on one
 * provider and is a rounding error on another. A log line that names the phases turns the next
 * report of a slow send into a reading rather than an investigation.
 */
interface SendPhaseTimings {
  reserveMs: number;
  /** Staged-attachment fetch + a forward's IMAP part streaming. 0 when the send carries neither. */
  assembleMs: number;
  /** `openSendAdapter` — credential decrypt, DNS, TCP, TLS, LOGIN, LIST. */
  openMs: number;
  /** `adapter.send` — the SMTP session plus the Sent-folder APPEND. */
  submitMs: number;
  finalizeMs: number;
  /** The sent-copy projection. 0 when the adapter reported no append. */
  projectMs: number;
  totalMs: number;
}

/** What the RESERVE tx resolves to: a fresh reservation, or an already-existing row to branch on. */
type Reservation =
  | {
      kind: "new"; sendId: string; mintedMessageId: string; mailboxId: string;
      msg: OutboundMessage; seq: number;
      /** A forward's original parts to stream + the mailbox they live in — resolved outside the tx. */
      forward?: { parts: ForwardPart[]; mailboxId: string; locator: NativeLocator; messageId: string };
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
    const started = Date.now();
    const phases: SendPhaseTimings = {
      reserveMs: 0, assembleMs: 0, openMs: 0, submitMs: 0, finalizeMs: 0, projectMs: 0, totalMs: 0,
    };

    // ── 1. RESERVE (short tx, NO network) ────────────────────────────────────
    const reservation = await this.reserve(ctx, draftId, idempotencyKey, deps, input);
    phases.reserveMs = Date.now() - started;

    // A same-key request that hit the UNIQUE reservation: branch on stored status.
    //
    // NOT under the ceiling. This arm is a read of a settled row plus, for a provably-stale one,
    // a verify-by-Sent probe; there is no envelope in it and nothing for a ceiling to protect
    // against beyond the socket deadlines the probe already carries. Putting it under one would
    // also mean a timed-out RECOVERY answered `queued`, which is a claim about a submission this
    // request never made.
    if (reservation.kind === "existing") {
      return this.resumeExisting(ctx, reservation.row, reservation.mailboxId, deps);
    }

    // ── 2. SMTP OUTSIDE the tx. Always close() in finally. ───────────────
    const { sendId, mintedMessageId, mailboxId, msg } = reservation;

    // ══════════════════════════════════════════════════════════════════════════════════════════
    //  THE PRE-SMTP WINDOW. EVERY FAILURE IN HERE IS A DEFINITE NON-DELIVERY, AND IS RECORDED
    //  AS ONE.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    //
    // The reservation has COMMITTED and the draft says `sending`. What has not happened is any
    // part of a delivery: `openSendAdapter` has not been called, no socket exists, no envelope has
    // been offered to anybody. So the two assembly steps below — pulling staged bytes from object
    // storage, and streaming a forward's original parts from IMAP — can only fail in one way, and
    // this service knows exactly what that way means.
    //
    // It did not act on that knowledge. A throw left the invocation with the reservation still
    // `pending`, and this service reads a stale `pending` row as an AMBIGUOUS send: `in_flight`
    // for ten minutes, then verify-by-Sent, which finds nothing because nothing was ever sent, and
    // finalizes `unverified` — "check your Sent folder before retrying". The docblock on the staged
    // arm below described that as "the user retries under the same key", which is true and is not
    // the same thing as harmless: the same key is precisely what routes them into the ambiguous
    // recovery instead of a new send.
    //
    // The window is closed as a WINDOW rather than at the one call that raised the row, because
    // every step in it has the identical property. `finalizeFailed` records the definite outcome,
    // the draft comes back to `draft`, and the reader is told the truth — including, for a stale
    // forward source, what it was and what fixes it.
    // ── OPENING THE TRANSPORT IS INSIDE THIS WINDOW, AND THAT WAS A REVIEW FINDING ────────────
    //
    // The window first covered the two assembly steps only, and `openSendAdapter` sat one line
    // below it. That is the same defect the window exists to close, one call later: decrypting the
    // stored credential, dialling, and authenticating all happen before any envelope is offered,
    // so a failure in any of them is a DEFINITE non-delivery — and it was leaving the reservation
    // `pending`, which is the state that becomes `unverified` ten minutes later. Drawing the
    // boundary at "assembly" rather than at "before anything was offered to a server" was an
    // arbitrary line, and the arbitrary line is what the finding pointed at.
    //
    // `adapter.send` is deliberately still OUTSIDE it. That call is where the envelope goes to the
    // server, so its failure is genuinely ambiguous — SMTP may have accepted before the error —
    // and it keeps the verify-by-Sent recovery it has always had. The boundary is now exactly
    // "has anything been offered to a server yet", which is the only line that makes `failed`
    // honest.
    //
    // ── AND THE CEILING RUNS OVER BOTH HALVES, SPLIT ON EXACTLY THIS BOUNDARY ────────────────
    //
    // {@link SEND_ATTEMPT_CEILING_MS} bounds the attempt as a whole, and the window is what gives
    // a breach its meaning. Running out of time in HERE is a definite non-delivery for the same
    // reason a throw in here is: no envelope has been offered. Running out of time BELOW is the
    // unknown fate, and is answered `queued` rather than finalized.
    const ceiling = startAttemptCeiling(deps.attemptCeilingMs ?? SEND_ATTEMPT_CEILING_MS);
    try {
      let adapter: Awaited<ReturnType<OpenSendAdapter>>;
      const tWindow = Date.now();
      // The two phases are timed SEPARATELY, not sliced out of one running total, because the
      // whole value of the line is telling them apart: assembly is object storage and IMAP part
      // streaming and is zero on an ordinary send, the dial is the phase that dominates on some
      // providers. A single `Date.now() - tWindow` read after both would report the dial as
      // assembly + dial, which is exactly the kind of number that sends the next reader looking
      // in the wrong place.
      let tDial = tWindow;
      // ONE promise for the whole window, so the ceiling races the window and not one call in it.
      const opening = (async () => {
        await this.assemble(ctx, reservation, deps, input);
        tDial = Date.now();
        phases.assembleMs = tDial - tWindow;
        return deps.openSendAdapter(mailboxId);
      })();
      let opened: { timedOut: true } | { timedOut: false; value: Awaited<ReturnType<OpenSendAdapter>> };
      try {
        opened = await raceCeiling(opening, ceiling);
      } catch (err) {
        // The sentence goes in with the terminal write, because on the scheduled path this row IS
        // the only channel — see `finalizeFailed`. A typed refusal is written to be read; anything
        // else is a diagnostic and gets the standing sentence instead.
        await this.finalizeFailed(ctx, sendId, draftId,
          err instanceof ServiceError ? err.message : SEND_FAILED_SENTENCE);
        // The line is owed here too. This arm is the ONE class of failure the pre-SMTP window
        // exists for, and it was the one attempt that settled without saying what it cost —
        // "one line per settled attempt" was false for exactly the case somebody investigating
        // a broken send would look for first.
        this.logPhases(deps, ctx, draftId, "failed", phases, started);
        throw err;
      }
      // `tDial` is still `tWindow` when the ceiling fired inside ASSEMBLY, so a breach there is
      // reported as the whole window spent in `openMs` with `assembleMs` at zero. That is the
      // honest reading of a window that never reached its second half — the alternative would be
      // a zero for a phase that was running when the clock ran out.
      phases.openMs = Date.now() - tDial;
      if (opened.timedOut) {
        // NOTHING WAS OFFERED, so this is the window's own outcome and is recorded as one.
        //
        // The abandoned `opening` is not cancelled — nothing can cancel a dial in flight — so it
        // is followed to close whatever socket it eventually produces. A LOGIN that lands after
        // this answer would otherwise leave an authenticated connection open with no handle to it,
        // which on a long-lived host accumulates one per timed-out send. Its own rejection is
        // swallowed: the send is already finalized and the error has nowhere truthful to go.
        void opening.then(
          (a) => a.close().catch(() => { /* the connection is already broken */ }),
          () => { /* the dial that timed out also failed; nothing was opened */ },
        );
        await this.finalizeFailed(ctx, sendId, draftId, SEND_TIMEOUT_SENTENCE);
        this.logPhases(deps, ctx, draftId, "failed", phases, started);
        // NOT retryable, and the line above is why: `finalizeFailed` has just committed this
        // reservation as `failed`, so the key is SPENT and a retry under it can only ever be
        // answered 409 `failed`. Marking it retryable put the client in `queued` — "Not sent yet,
        // ohmail is still trying" — over a non-delivery the server had already recorded and
        // explained, and threw away `SEND_TIMEOUT_SENTENCE`, which exists to be read. Terminal
        // here means the sentence renders and Send is the retry, which is the truth.
        throw new ServiceError("send_timeout", 504, SEND_TIMEOUT_SENTENCE, undefined, false);
      }
      adapter = opened.value;

      /**
       * THE SUBMISSION — one promise, so the ceiling can stop waiting for it WITHOUT stopping it.
       *
       * It owns `adapter.close()` in its own `finally` rather than the caller's, and that is the
       * whole reason it is a closure: once the ceiling has been reached this function has returned
       * and there is no caller left to run a `finally`. Closing the adapter out from under a live
       * SMTP session would also be the one thing that could turn a slow send into a failed one.
       *
       * ON A HOST WHOSE PROCESS OUTLIVES THE RESPONSE this promise runs to completion and calls
       * the real finalizer, so a send that beat the clock by a second still lands as `sent`, the
       * draft's own change is emitted, and the client learns it from the next `/sync` — the
       * standalone door's "the submission continues in its own loop", with no loop to write.
       * On a serverless host the invocation ends here instead and the reservation is left for
       * verify-by-Sent, exactly as a crashed attempt always was. Neither host resends.
       */
      const submitting = (async (): Promise<SendResult> => {
        try {
          let providerMessageId: string;
          /**
           * THE COPY THE SEND PATH JUST PUT IN THE USER'S SENT FOLDER — locator + the exact bytes.
           *
           * Absent for a spy, and for any adapter that files sent mail some other way; the projection
           * below is then skipped and the Sent-folder watch is the only path, exactly as before.
           */
          let appended: AppendedSent | undefined;
          const tSubmit = Date.now();
          try {
            const res = await adapter.send(msg);
            providerMessageId = res.providerMessageId;
            appended = res.appended;
          } catch {
            // SMTP threw → the delivery is AMBIGUOUS (it may have reached the server
            // before the failure). VERIFY by Sent rather than assume either way; NEVER
            // blindly resend. Reuse the still-open adapter for the probe.
            const inSent = await adapter.messageInSent(mintedMessageId);
            phases.submitMs = Date.now() - tSubmit;
            if (inSent) {
              const seq = await this.finalizeSent(ctx, sendId, mintedMessageId, draftId, mailboxId);
              return { status: "sent", providerMessageId: mintedMessageId, draftId, seq };
            }
            const seq = await this.finalizeUnverified(ctx, sendId, draftId);
            return { status: "unverified", providerMessageId: null, draftId, seq };
          }
          phases.submitMs = Date.now() - tSubmit;

          // ── 3. FINALIZE (short tx) ──────────────────────────────────────────────
          const tFinalize = Date.now();
          const seq = await this.finalizeSent(ctx, sendId, providerMessageId, draftId, mailboxId);
          phases.finalizeMs = Date.now() - tFinalize;

          // ── 4. RECORD-AT-SEND (a SEPARATE short tx, best-effort) ────────────────
          //
          // AFTER the finalize and outside its transaction, both deliberately. See
          // `projectSentCopy` for why a failure here may never reach the caller.
          const tProject = Date.now();
          await this.projectSentCopy(ctx, mailboxId, appended, deps);
          phases.projectMs = Date.now() - tProject;
          return { status: "sent", providerMessageId, draftId, seq };
        } finally {
          await adapter.close().catch(() => { /* the connection is already broken */ });
        }
      })();

      const settled = await raceCeiling(submitting, ceiling);
      if (settled.timedOut) {
        // UNKNOWN FATE, and the reservation says so by staying exactly as it is: `pending`, with
        // its `send_key` standing. That is the state `resumeExisting` already knows how to read,
        // so the recovery this answer hands over to is the one that has always existed.
        //
        // The abandoned submission keeps its own error handler for the serverless case, where
        // nothing is listening any more and an unhandled rejection would take the process with it.
        void submitting.catch((err: unknown) => {
          (deps.log ?? defaultLog).warn("send_abandoned_after_ceiling", {
            draftId, sendId, err,
            reason: "the attempt passed the ceiling and the caller was answered `queued`; this "
              + "reservation stays `pending` with its key, and verify-by-Sent resolves it",
          });
        });
        this.logPhases(deps, ctx, draftId, "queued", phases, started);
        return { status: "queued", providerMessageId: null, draftId, seq: reservation.seq };
      }
      this.logPhases(deps, ctx, draftId, settled.value.status, phases, started);
      return settled.value;
    } finally {
      ceiling.cancel();
    }
  }

  /**
   * One line per settled attempt, naming what each phase cost. See {@link SendPhaseTimings}.
   *
   * `info`, not `debug`: this is the only record of how long a person waited, and it is the
   * evidence any future "sending is slow" report gets read against. It carries no address, no
   * subject and no recipient — the draft id and the outcome are enough to join it to everything
   * else, and a log line about a message may not quote the message.
   */
  private logPhases(
    deps: SendDeps, ctx: ServiceContext, draftId: string,
    status: SendResult["status"], phases: SendPhaseTimings, started: number,
  ): void {
    // SNAPSHOT, because two abandoned closures still hold a reference to `phases` and go on
    // writing to it after the ceiling has answered. Spreading into a fresh object at read time is
    // what keeps a logged line a statement about the moment it was made; today the object is read
    // exactly once so nothing is wrong, and that is a property of the call sites rather than of
    // this function.
    const settled = { ...phases, totalMs: Date.now() - started };
    (deps.log ?? defaultLog).info("send_phases", { draftId, accountId: ctx.accountId, status, ...settled });
  }

  /**
   * Put the attachment bytes on the outgoing message — the whole of the pre-SMTP window.
   *
   * Extracted from {@link send} so the window has one boundary rather than two call sites the
   * next person has to notice are related. Both steps are network, both run outside the
   * reservation transaction, and neither persists a byte: the files land on the one
   * `OutboundMessage` that both goes out and is appended to Sent.
   *
   * A failure is never swallowed and never partially applied. A send that quietly dropped an
   * attachment the composer showed is a WRONG send, which is the ruling the forward path made
   * first and the staged path inherited.
   */
  private async assemble(
    ctx: ServiceContext,
    reservation: Extract<Reservation, { kind: "new" }>,
    deps: SendDeps,
    input: SendInput,
  ): Promise<void> {
    const { msg } = reservation;

    // ── STAGED: PULL THE BYTES FROM OBJECT STORAGE onto the outgoing message ────────────────
    //
    // Here, outside the reservation tx (it is network) and BEFORE `send`, exactly where the
    // forward's IMAP stream runs and for the same reasons: the files must be on the one
    // `OutboundMessage` that both goes out and is appended to Sent, and they are never persisted.
    //
    // A failure is NOT swallowed. `fetch` throws when an object is gone or is bigger than its
    // ticket declared, and that ends the send — as a DEFINITE non-delivery, recorded by the
    // window's own handler in `send` (`finalizeFailed`), because nothing has been offered to any
    // server at this point. This used to read "the reservation is `pending` — the user retries
    // under the same key", which is how a definite failure came to be recovered as an ambiguous
    // one. A send that quietly dropped an attachment the composer showed is a wrong send, which
    // is the same ruling the forward path already made.
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
    // original's files would be a wrong send, so it fails the whole send — definitively, and
    // recorded as such by the window's handler. Bounded by count and total bytes against a
    // serverless OOM.
    if (reservation.forward && deps.openFetchAdapter) {
      await this.streamForwardParts(ctx, reservation.forward, msg, deps.openFetchAdapter);
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
      // Resolved INSIDE the try: a cap read that fails costs this projection and nothing else —
      // the mail is delivered, the failure is the log line below, and the worker's Sent-folder
      // pass (metered through its own cap) writes the row on its next cycle. An undeclared host
      // REFUSES here rather than defaulting to unmetered — see `SendDeps.resolveStorageCap`.
      const resolve = deps.resolveStorageCap ?? (async () => {
        throw new ServiceError("server_error", 500, "no storage-cap policy is configured for this host");
      });
      const storageCap = await resolve(ctx);
      await recordSentMessage(appended, {
        accountId: ctx.accountId,
        mailboxId,
        storageCap,
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

      // ── THE RECIPIENT CAP, with the other NEW-RESERVATION preconditions ─────────────────
      //
      // The three lists are on the row this transaction has already locked, so the total costs
      // nothing extra to compute — and this is the first moment all three exist together: a
      // partial update names one field and cannot know the other two. See
      // {@link SEND_MAX_RECIPIENTS} for why the per-message total lives here and the per-field
      // one lives at the draft write.
      //
      // BELOW THE INSERT, for the reason the two checks above it give in full: the CONFLICT
      // branch returns before reaching here, and that branch is idempotent REPLAY. Placed above,
      // this would answer 413 to a client retrying its key after a send that SUCCEEDED — a draft
      // written before this ceiling existed would have its stored `sent` result replaced by a
      // refusal, which is the no-lie contract broken by the guard meant to protect it. A review
      // round caught it there; the position is now the same as the disabled-mailbox check's, and
      // costs nothing, since a throw anywhere in this callback rolls the INSERT back too.
      const recipientCount = ((d.to as EmailAddress[] | null) ?? []).length
        + ((d.cc as EmailAddress[] | null) ?? []).length
        + ((d.bcc as EmailAddress[] | null) ?? []).length;
      if (recipientCount > SEND_MAX_RECIPIENTS) {
        throw new ServiceError(
          "payload_too_large", 413,
          `this message names ${recipientCount} recipients across To, Cc and Bcc; ` +
            `the limit is ${SEND_MAX_RECIPIENTS} — send it in batches`,
        );
      }


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
      // `messageId` rides along so the fetch can re-read this row's locator if the one captured
      // here goes stale before the bytes are pulled — see `streamForwardParts`.
      let forward:
        | { parts: ForwardPart[]; mailboxId: string; locator: NativeLocator; messageId: string }
        | undefined;
      let fwdText = "";
      let fwdHtml = "";
      /**
       * IS THERE A NOTE ABOVE THE QUOTE? — one answer, used by both parts.
       *
       * A forward may be sent with no message of its own, so this decides whether the outgoing
       * mail has TWO things in it or one. Judged on the plain body in both arms deliberately: the
       * html half of a rich draft is derived from this same text at write time
       * (`DraftsService.richBody`), and asking the markup separately is how the text part and the
       * html part come to disagree about whether the reader wrote anything.
       */
      const blankNote = d.body.trim().length === 0;
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
        // forward cannot OOM the serverless function (the same bound `download-all` needs), and
        // ORDERED BY ID, which is load-bearing beyond determinism: `AttachmentsService
        // .listForMessage` orders the same way, and the client's optimistic sent copy projects a
        // forward's inherited parts as the first `FORWARD_MAX_PARTS` of that list — a capped
        // SELECT with no ORDER BY is free to pick a different subset, and the projection would
        // then name a file the recipient never got while omitting one they did.
        const attRows = await tx.select({
          filename: attachments.filename, contentType: attachments.contentType,
          partId: attachments.partId, contentId: attachments.contentId, inline: attachments.inline,
        }).from(attachments).where(eq(attachments.messageId, orig.id))
          .orderBy(asc(attachments.id)).limit(FORWARD_MAX_PARTS);
        forward = {
          mailboxId: orig.mailboxId,
          messageId: orig.id,
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
        // The user's text, then the quoted original on a forward — with the separator between
        // them, and ONLY where there are two things to separate (`forwardJoin`). `fwdText`/
        // `fwdHtml` are "" for a normal send, and `forwardJoin` is then the identity on the body:
        // a blank-bodied NON-forward joins "" to "" and is byte-identical to what it always was.
        // The html half is appended ONLY when the draft is itself rich; a plain forward carries
        // the quote in text alone.
        text: fwdText ? forwardJoin(d.body, fwdText, "\n\n", blankNote) : d.body,
        ...(html
          ? { html: fwdHtml ? forwardJoin(html, fwdHtml, "<br><br><hr>", blankNote) : html }
          : {}),
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
   *
   * ── A STALE SOURCE LOCATOR IS RE-RESOLVED ONCE, THEN REFUSED HONESTLY ───────────────────────
   *
   * The locator came off the `messages` row inside the reservation transaction. Between that read
   * and this fetch the original can move — another client files it, or its folder is recycled and
   * re-enumerated under a new UIDVALIDITY — and the adapter then refuses with `MessageGoneError`
   * rather than handing back part *n* of whatever now wears that UID.
   *
   * **A READ MAY RE-RESOLVE, so this one does.** `messages.native_locator` is a mirror of what the
   * organizer last observed, and adoption repoints it by Message-ID and fingerprint, so re-reading
   * that column is the witness — no new IMAP surface, no search this code has to bound against a
   * hostile server, and no possibility of acting on a message whose identity was never proved. It
   * is tried EXACTLY ONCE and only when the row now names a DIFFERENT locator: a second attempt
   * against the same value would be a retry loop dressed as a repair. Re-fetching is safe in a way
   * re-moving is not — the worst case is one wasted read, which is why `gone.ts` grants this to
   * reads and withholds it from mutations.
   *
   * When the re-read has not caught up, the send is refused with what is TRUE: nothing was sent,
   * here is why, and here is what makes it work. It must never reach the ambiguous-send recovery,
   * which would tell the reader to check Sent for a message that was never offered to any server —
   * the window handler in {@link send} is what guarantees that, and this sentence is what makes
   * the refusal actionable rather than merely accurate.
   */
  private async streamForwardParts(
    ctx: ServiceContext,
    forward: { parts: ForwardPart[]; mailboxId: string; locator: NativeLocator; messageId: string },
    msg: OutboundMessage,
    openFetchAdapter: OpenAdapter,
  ): Promise<void> {
    if (forward.parts.length === 0) return;
    const adapter = await openFetchAdapter(forward.mailboxId);
    try {
      let locator = forward.locator;
      let reResolved = false;
      const fetched: NonNullable<OutboundMessage["attachments"]> = [];
      let total = 0;
      for (const part of forward.parts) {
        let bytes: Awaited<ReturnType<AttachmentAdapter["fetchPart"]>>;
        try {
          bytes = await adapter.fetchPart(locator, part.partId);
        } catch (err) {
          if (!isMessageGone(err) || reResolved) throw this.forwardSourceGone(err);
          reResolved = true;
          const fresh = await this.currentLocatorOf(ctx, forward.messageId);
          // A row that still names the locator we just tried has nothing new to say, and neither
          // does one whose locator has been cleared. Only a genuinely different locator earns the
          // second attempt.
          if (!fresh || sameLocator(fresh, locator)) throw this.forwardSourceGone(err);
          locator = fresh;
          // THE RETRY IS TRANSLATED TOO. Without this arm a re-resolved locator that is ALSO
          // stale — the mirror repointed, and the message moved again, or it was repointed to
          // something the server has since renumbered — threw the raw adapter error straight out
          // of here. The window handler above would still have recorded the send `failed`, so
          // nothing would have been mis-sent; but the route maps `ServiceError` and turns
          // everything else into a 500, so the reader would have got "something went wrong"
          // instead of the sentence that tells them nothing was sent and what to do. The honest
          // outcome must not depend on how many times the locator moved.
          try {
            bytes = await adapter.fetchPart(locator, part.partId);
          } catch (retryErr) {
            throw this.forwardSourceGone(retryErr);
          }
        }
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
   * THE SENTENCE A READER SEES WHEN A FORWARD'S ORIGINAL HAS MOVED — three facts, in the order
   * they need them.
   *
   * 1. *Nothing was sent.* First, because it is the thing they are actually worried about and the
   *    thing the old behaviour got wrong. This service knows it with certainty: `adapter.send` had
   *    not been reached.
   * 2. *What went wrong*, in terms of the mailbox rather than of this code — the message being
   *    forwarded moved, so its attachments could not be read. Not "MessageGoneError", not "the
   *    mail server is having trouble" (it is not), and not a UIDVALIDITY lecture.
   * 3. *What makes it work, CONDITIONALLY* — press Send again once the mailbox has caught up. The
   *    condition is not decoration and review was right to require it: `MessageGoneError` also
   *    covers a message that was permanently DELETED, and for that one no amount of waiting will
   *    ever make the forward work. The sentence first read "Try again once your mailbox has caught
   *    up" flatly, which promised a recovery in exactly the case where the reader needs to be told
   *    the original is gone. It now offers the retry for the move case and names the other.
   *
   * 409 rather than 410: the state we held conflicts with the server's, which is exactly what 409
   * means, and 410 would assert a permanence that is usually false — the message has almost always
   * simply moved. The route maps `ServiceError`, and the client engine puts this sentence in front
   * of the reader verbatim with Send live again (`mail-send.ts#phaseFor`).
   */
  private forwardSourceGone(err: unknown): unknown {
    if (!isMessageGone(err)) return err;
    return new ServiceError(
      "forward_source_moved", 409,
      "Nothing was sent. The message you're forwarding is no longer where your mail server said "
        + "it was, so its attachments couldn't be read. If it has moved, trying again once your "
        + "mailbox has caught up will work; it may also have been deleted.",
    );
  }

  /**
   * The forward source's locator AS THE MIRROR NOW HAS IT — the re-resolution witness.
   *
   * Account-scoped, like every read in this service: a cross-account message id must resolve to
   * nothing rather than to somebody else's locator. Returns `null` when the row is gone or its
   * locator has been cleared, both of which mean "no better answer than the one that just failed".
   */
  private async currentLocatorOf(ctx: ServiceContext, messageId: string): Promise<NativeLocator | null> {
    const [row] = await ctx.db.select({ locator: messages.nativeLocator })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId)))
      .limit(1);
    return (row?.locator as NativeLocator | null) ?? null;
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
    // This recovery is no longer the ONLY one. It runs when the USER retries with the same key,
    // and `runSendReconcilePass` runs the identical resolution on a clock for a row nobody
    // retries — both through {@link SendService.resolveStale}, which is the single writer.
    const ageMs = ctx.now().getTime() - row.createdAt.getTime();
    if (ageMs < SEND_STALE_AFTER_MS) {
      return { status: "in_flight", providerMessageId: null, draftId: row.draftId, seq: null };
    }

    // A genuinely STALE reservation → verify-by-Sent recovery. `send` is NEVER called on this
    // path; the client door may always dial, so the factory goes through unwrapped.
    const out = await this.resolveStale(ctx, row, mailboxId, deps.openSendAdapter);
    // `pending` comes back only from a re-read that still saw no terminal state, which on this
    // door means somebody owns the row right now — the same answer a young reservation gets, and
    // the only one that neither claims an outcome nor invites a resend.
    if (out.status === "pending") {
      return { status: "in_flight", providerMessageId: null, draftId: out.draftId, seq: null };
    }
    return {
      status: out.status, providerMessageId: out.providerMessageId, draftId: out.draftId, seq: out.seq,
    };
  }

  /**
   * RESOLVE ONE STALE RESERVATION — the single implementation of "decide what became of a
   * `pending` row that no live invocation owns", shared by the client's same-key retry
   * ({@link SendService.resumeExisting}) and the reconciling pass (`send-reconcile-pass.ts`).
   *
   * It exists as one function because the two callers write the SAME terminal states from the
   * SAME evidence, and a second copy of that decision is the fork the one-implementation rule
   * forbids — the more so here, where the states are terminal and what they encode is the rule
   * this whole path exists for: never resend on ambiguity.
   *
   * ── TWO ARMS, AND THE ORDER IS LOAD-BEARING ────────────────────────────────────────────────
   *
   * 1. **The MIRROR arm, which costs no dial.** `ImapAdapter.send` APPENDs our own copy to Sent
   *    and the worker's Sent-folder watch ingests it like any other message, so a delivered send
   *    usually has a `messages` row carrying the very `message_id_header` this reservation
   *    minted. Reading that row settles the question with an indexed lookup
   *    (`messages_account_message_id_header_idx`) instead of a LOGIN.
   *
   *    **A MISS SAYS NOTHING.** The mirror lags the mailbox by up to a poll interval, and on the
   *    reconciling pass the row being examined is minutes old by construction — so "not in the
   *    mirror" is indistinguishable from "not synced yet". Only the IMAP arm may write
   *    `unverified`; a mirror miss falls through to it and, where no dial is permitted, to the
   *    caller's stated `onMiss`.
   *
   * 2. **The IMAP arm** — `messageInSent`, the probe this service has always used. Found ⇒
   *    `sent`. Not found ⇒ `unverified`: the adapter answered, so the Sent folder genuinely does
   *    not hold the id. A THROW (including {@link ImapBoundExceeded}) is neither: it propagates
   *    with the row untouched, because writing a terminal state off a connection that failed is
   *    exactly the ambiguity this path exists to avoid.
   *
   * `openAdapter` is `null` for a caller that may NOT dial (the pass's `disabled`/`error`
   * mailboxes — see the pass), and `onMiss` then says what a mirror miss MEANS: `"unverified"`
   * writes the ambiguous terminal state now, `"defer"` leaves the row exactly as found for a
   * later cycle. A caller that hands a factory always gets a probe.
   *
   * A **factory `ServiceError`** — a mailbox whose credential rows are gone
   * (`send-adapter.ts:36`) — is resolved as `unverified` rather than raised, and that is a
   * decision about EVIDENCE and not a swallowed error: no adapter can ever be built for that
   * mailbox again, so no later cycle can decide the row, and leaving it `pending` forever is the
   * permanently-unresolvable state this whole path exists to remove. A probe that throws is the
   * opposite case (the next cycle may well succeed) and is not caught here.
   *
   * ── AND THE CAS LOSER ANSWERS THE WINNER'S STATE ───────────────────────────────────────────
   *
   * All three finalizers are compare-and-swap on `status='pending'`, so exactly one resolver ever
   * writes a terminal state. When this call's CAS matches zero rows somebody else resolved the
   * row while we probed: the answer is the state THEY wrote, re-read from the reservation and
   * returned as `by: "elsewhere"` — never `queued`, never `in_flight`, and never a second probe.
   * Overlapping resolvers therefore cost a duplicate read, never a wrong write.
   */
  async resolveStale(
    ctx: ServiceContext,
    row: typeof outboundSends.$inferSelect,
    mailboxId: string,
    openAdapter: OpenSendAdapter | null,
    onMiss: "unverified" | "defer" = "unverified",
  ): Promise<ResolveStaleOutcome> {
    // ── 1. The mirror arm. Account-scoped like every read in this service.
    const mirrored = await ctx.db.select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.accountId, ctx.accountId),
        eq(messages.messageIdHeader, row.mintedMessageId),
      ))
      .limit(1);
    if (mirrored.length > 0) return this.settleSent(ctx, row, mailboxId, "mirror");

    // ── 2. The IMAP arm, when this caller may dial at all.
    if (openAdapter === null) {
      if (onMiss === "defer") {
        return {
          status: "pending", providerMessageId: null, draftId: row.draftId, seq: null, by: "deferred",
        };
      }
      return this.settleUnverified(ctx, row, "undialable");
    }

    let adapter: SendAdapter;
    try {
      adapter = await openAdapter(mailboxId);
    } catch (err) {
      // A REFUSAL THE FACTORY CALLS TRANSIENT IS NOT EVIDENCE ABOUT THE MESSAGE. It propagates
      // untouched, so the caller defers this row and asks again next cycle. Checked FIRST and
      // kept a distinct class rather than folded into the branch below, because the two are
      // opposite conclusions from a superficially identical event — see {@link
      // TransientDialRefusal}, which records what treating a busy mailbox as a permanent one
      // would write.
      if (err instanceof TransientDialRefusal) throw err;
      // See the docblock: a mailbox that can never be dialled again is decided now, not left to
      // page for ever. Anything that is not a typed refusal is a fault, and propagates.
      if (err instanceof ServiceError) return this.settleUnverified(ctx, row, "undialable");
      throw err;
    }
    try {
      const inSent = await adapter.messageInSent(row.mintedMessageId);
      return inSent
        ? await this.settleSent(ctx, row, mailboxId, "probe")
        : await this.settleUnverified(ctx, row, "probe");
    } finally {
      await adapter.close();
    }
  }

  /** `finalizeSent`, plus the CAS-loser re-read. See {@link SendService.resolveStale}. */
  private async settleSent(
    ctx: ServiceContext, row: typeof outboundSends.$inferSelect, mailboxId: string,
    by: ResolveStaleBy,
  ): Promise<ResolveStaleOutcome> {
    const seq = await this.finalizeSent(ctx, row.id, row.mintedMessageId, row.draftId, mailboxId);
    if (seq === null) return this.answerWinner(ctx, row);
    return { status: "sent", providerMessageId: row.mintedMessageId, draftId: row.draftId, seq, by };
  }

  /** `finalizeUnverified`, plus the CAS-loser re-read. See {@link SendService.resolveStale}. */
  private async settleUnverified(
    ctx: ServiceContext, row: typeof outboundSends.$inferSelect, by: ResolveStaleBy,
  ): Promise<ResolveStaleOutcome> {
    const seq = await this.finalizeUnverified(ctx, row.id, row.draftId);
    if (seq === null) return this.answerWinner(ctx, row);
    return { status: "unverified", providerMessageId: null, draftId: row.draftId, seq, by };
  }

  /**
   * THE STATE THE WINNER WROTE, read back after a lost CAS.
   *
   * `sent` and `unverified` are the only states a resolver can have written; `failed` is
   * reachable too (the pre-SMTP window finalizes it) and is answered honestly rather than
   * flattened, because a caller told "unverified" about a row that definitively never left would
   * be sent to look in a Sent folder for a message that provably is not there. A row that somehow
   * reads `pending` again is answered as a defer: nothing was written and nothing is claimed.
   */
  private async answerWinner(
    ctx: ServiceContext, row: typeof outboundSends.$inferSelect,
  ): Promise<ResolveStaleOutcome> {
    const [now] = await ctx.db.select({
      status: outboundSends.status, providerMessageId: outboundSends.providerMessageId,
    }).from(outboundSends)
      .where(and(eq(outboundSends.id, row.id), eq(outboundSends.accountId, ctx.accountId)))
      .limit(1);
    const status = (now?.status ?? "pending") as ResolveStaleOutcome["status"];
    if (status === "pending") {
      return {
        status: "pending", providerMessageId: null, draftId: row.draftId, seq: null, by: "deferred",
      };
    }
    return {
      status,
      providerMessageId: status === "sent" ? (now?.providerMessageId ?? row.mintedMessageId) : null,
      draftId: row.draftId,
      seq: null,
      by: "elsewhere",
    };
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
  ): Promise<number | null> {
    const now = ctx.now();
    const seq = await asTx(ctx).transaction(async (tx) => {
      const won = await tx.update(outboundSends)
        .set({ status: "sent", providerMessageId, sentAt: now })
        .where(and(eq(outboundSends.id, sendId), eq(outboundSends.status, "pending")))
        .returning({ id: outboundSends.id });
      // THE CAS LOST — see {@link SendService.resolveStale}. Nothing else in this transaction may
      // run: the draft belongs to whoever won, and a `recordChange` here would publish a `draft`
      // update announcing a state this call did not write.
      if (won.length === 0) return null;
      // `sendAt`/`sendKey` cleared IN THE SAME transaction that records the terminal outcome
      // (mail 0077): they are the scheduled-send recovery predicate, and an appointment that
      // outlived its delivery would be re-claimed by the sweep and replayed forever. A manual
      // send carries NULLs here anyway, so this is byte-identical for it.
      //
      // `status='sending'` is the draft's OWN compare-and-swap, and it is a separate question
      // from the reservation's: a draft a person has already recovered by hand, or one a
      // different terminal path returned to `draft`, must not be dragged back out of the state
      // it is in by a finalize that arrives afterwards. Winning the reservation says what became
      // of the SEND; this says the composer is still waiting to be told.
      await tx.update(drafts).set({ status: "sent", sendAt: null, sendKey: null, updatedAt: now })
        .where(and(
          eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId), eq(drafts.status, "sending"),
        ));
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
    return seq === null ? null : Number(seq);
  }

  /**
   * FINALIZE-failed tx: **the message definitively did not go out, and the code KNOWS it.**
   *
   * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────────
   *
   * `failed` was declared by this service, mapped by the route (409) and handled by the client
   * engine (`send_failed`, non-retryable) from the day the state machine was written — and NOTHING
   * EVER WROTE IT. The `pending` reservation was the only thing a pre-SMTP failure left behind, and
   * a `pending` row is, by this service's own recovery rules, an AMBIGUOUS one: a same-key retry
   * answers `in_flight` for {@link SEND_STALE_AFTER_MS}, and after that it probes the Sent folder,
   * finds nothing, and finalizes `unverified` — *"We couldn't confirm this send. Check your Sent
   * folder before retrying."*
   *
   * That sentence is false for every failure that happens BEFORE `adapter.send` is called. No
   * socket was opened, no envelope was offered, nothing can be in Sent, and telling somebody to go
   * and look for mail that provably never left is the worst kind of wrong answer: it is
   * unfalsifiable from where they are standing, and the honest action it hides — press Send again —
   * is the one it talks them out of.
   *
   * ── AND WHY `failed` IS SAFE HERE SPECIFICALLY ──────────────────────────────────────────────
   *
   * `failed` is terminal for this KEY, which is the whole point: a same-key replay must never
   * resend, and it does not — it replays this refusal. It does not brick the draft, because the
   * client releases the durable send key on any terminal outcome (`mail-send.ts#absorb`), so the
   * reader's next press is a genuinely new send with a new key. The draft is returned to `draft`
   * rather than left at `sending` for the same reason `schedule-send-pass.ts` returns it: a
   * composer stuck on "Sending…" for a message that was never sent is the same lie one surface
   * over.
   *
   * `sendAt`/`sendKey` are cleared on the terminal outcome — {@link finalizeSent}'s rule, and it
   * matters more here than there: an appointment that outlived a definite non-delivery would be
   * re-claimed by the scheduled-send sweep and replayed.
   *
   * ── AND IT CARRIES THE SENTENCE, BECAUSE ON A SCHEDULE THERE IS NOBODY TO THROW TO ─────────
   *
   * This write is the ONLY channel a scheduled send has. An interactive send reaches a person
   * through the thrown error the route maps, so returning the draft to `draft` is enough there.
   * A scheduled one is run by `schedule-send-pass.ts` on a timer: the throw is caught by a loop,
   * and the only thing the reader ever sees is the Drafts row. `send_error` is that row's
   * sentence.
   *
   * It did not used to be written here, and the seam that used to write it CANNOT any more:
   * `closeAppointment` is guarded on `send_key`, and this transaction has just set that key to
   * NULL — so the close matches nothing and the sentence was silently dropped. Measured, not
   * argued: a factory refusal on the scheduled path left `status='draft'`, `send_at`/`send_key`
   * NULL, the reservation `failed`, and **`send_error` NULL** — an appointment that vanished
   * from "Sending…" back to an ordinary draft with no explanation anywhere. That is the same
   * defect this whole window exists to close, one surface over: the state was recorded honestly
   * and the person was told nothing.
   *
   * A `ServiceError`'s own message is the sentence (it is written to be read — `closeAppointment`
   * has always quoted it). Anything else gets {@link SEND_FAILED_SENTENCE}: an unexpected throw's
   * message is an internal detail, not a sentence, and may name a host or a socket.
   *
   * ── AND ONLY FOR A SEND THAT HAD AN APPOINTMENT. `send_error` IS SCHEDULE-ONLY ─────────────
   *
   * The write is gated on `send_at` still standing, read in this same statement, because
   * `send_error` is not a generic "last send failed" field — it means "the appointment could not
   * be kept", and both clients read it that way:
   *
   *   `apps/webapp/messages/en.json#scheduleFailedNote`  "This message wasn't sent at its
   *                                                       SCHEDULED TIME: {reason}"
   *   `apps/mobile/src/state/live.ts#liveScheduled`      lists every `draft` row with a non-empty
   *                                                       `send_error` on the SCHEDULED screen,
   *                                                       because that app has no Drafts screen
   *
   * So an unconditional write would put a failed interactive send onto the phone's Scheduled
   * list and tell the reader on the web that a message they had just pressed Send on missed a
   * scheduled time that never existed. The interactive path needs none of it: its caller gets
   * the throw and the route maps it, which is the whole reason this field was schedule-only to
   * begin with. `dto/types.ts#DraftDTO.sendError` states that contract.
   *
   * `send_at` is the honest discriminator rather than a flag threaded from the caller: a
   * scheduled send keeps its appointment through the claim window and through `sending`, and
   * only a terminal finalize clears it — so at this moment it is exactly "was this an
   * appointment". Done as one statement so there is no read to race.
   */
  private async finalizeFailed(
    ctx: ServiceContext, sendId: string, draftId: string, sentence: string,
  ): Promise<void> {
    const now = ctx.now();
    await asTx(ctx).transaction(async (tx) => {
      // Compare-and-swap, for {@link SendService.finalizeSent}'s reason: exactly one resolver
      // writes a terminal state. This one is reachable only from the pre-SMTP window, which owns
      // the reservation it is finalizing — but "the only writer today" is not a property a
      // predicate-free UPDATE preserves, and a `failed` written over a `sent` would be the one
      // thing this whole path exists to prevent, one direction reversed.
      const won = await tx.update(outboundSends).set({ status: "failed" })
        .where(and(eq(outboundSends.id, sendId), eq(outboundSends.status, "pending")))
        .returning({ id: outboundSends.id });
      if (won.length === 0) return;
      await tx.update(drafts)
        .set({
          status: "draft", sendAt: null, sendKey: null, updatedAt: now,
          sendError: sql`case when ${drafts.sendAt} is not null then ${sentence}
                              else ${drafts.sendError} end`,
        })
        .where(and(
          eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId), eq(drafts.status, "sending"),
        ));
      await recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });
    });
  }

  /**
   * FINALIZE-unverified tx: the ambiguous terminal state; the draft surfaces `unverified`.
   * Compare-and-swap on the reservation, and on the draft, for {@link SendService.finalizeSent}'s
   * reasons — `null` when the CAS matched nothing, which means somebody else resolved this row.
   */
  private async finalizeUnverified(
    ctx: ServiceContext, sendId: string, draftId: string,
  ): Promise<number | null> {
    const now = ctx.now();
    const seq = await asTx(ctx).transaction(async (tx) => {
      const won = await tx.update(outboundSends).set({ status: "unverified" })
        .where(and(eq(outboundSends.id, sendId), eq(outboundSends.status, "pending")))
        .returning({ id: outboundSends.id });
      // THE SHARPEST OF THE THREE. Without this predicate a reconciling pass that probed while a
      // late `finalizeSent` committed would overwrite `sent` with `unverified` — turning a
      // message the user demonstrably sent into "we couldn't confirm this", and sending them to
      // look for it in a folder it is already in.
      if (won.length === 0) return null;
      // The appointment bookkeeping ends with the terminal outcome — `finalizeSent`'s rule.
      await tx.update(drafts).set({ status: "unverified", sendAt: null, sendKey: null, updatedAt: now })
        .where(and(
          eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId), eq(drafts.status, "sending"),
        ));
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });
    });
    return seq === null ? null : Number(seq);
  }
}

export const sendService = new SendService();
