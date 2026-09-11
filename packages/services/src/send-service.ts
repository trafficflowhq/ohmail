import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  attachments, drafts, mailboxes, messageBodies, messages, outboundSends,
  outboundSendFingerprints, recordChange, threads, type Tx,
} from "@trafficflow/db";
import {
  createLogger, isMessageGone, mintMessageId, normalizeMessageId, recordSentMessage,
  type AppendedSent, type EmailAddress, type Logger, type NativeLocator, type OutboundMessage,
  type OpenSendAdapter, type RepoPort, type RoutingPort, type SendAdapter, type StorageCap,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ServiceContext } from "./context.js";
import type { AttachmentAdapter, OpenAdapter } from "./attachments-service.js";
import { ServiceError, SettleFailed, TransientDialRefusal } from "./errors.js";
import { sanitizeOutboundHtml } from "./outbound-html.js";
import { carryDialect, dialect } from "@trafficflow/db/dialect";

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
 * THE QUOTED ORIGINAL of a forward — a text block always, an html block for a rich send. The
 * header is the conventional forwarded-message banner (From / Date / Subject). The original's
 * stored html is RE-SANITIZED before quoting (attacker-authored, and this is the last touch
 * before the wire); a plain original is escaped into `<br>`-joined text. The html half is folded
 * in only when the draft is itself rich. THE BLOCK CARRIES NO SEPARATOR — `forwardJoin` owns
 * that: a forward may be sent with NO note, and a baked-in gap became the first thing in the mail
 * (two blank lines above the banner, a rule floating over nothing). A separator between two
 * things belongs to the join; the block starts on the banner.
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
 * THE AUTHOR'S NOTE ABOVE A QUOTED ORIGINAL — the separator only where there are two things.
 * `note` is the draft's own body (or its sanitized html); `quote` is `forwardedQuote`'s
 * separator-free block; `gap` stands between them in this part's syntax. A BLANK note — absent,
 * empty, or whitespace — yields the quote alone: the forwarded mail, opening on its own banner.
 * Blankness is judged on the PLAIN note in both arms, so the two parts of a multipart forward
 * cannot disagree about whether a note exists — the same `trim()` emptiness the client's Send
 * lock exempts (`mail-send.ts#canSend`).
 */
function forwardJoin(note: string, quote: string, gap: string, blankNote: boolean): string {
  return blankNote ? quote : note + gap + quote;
}

/** Per-call send deps: the INJECTED adapter factory (prod = makeSendAdapter; tests = a fake/GreenMail spy). */
export interface SendDeps {
  openSendAdapter: OpenSendAdapter;
  /**
   * THE ACCOUNT'S MANAGED STORAGE CAP, for the sent-copy projection — resolved lazily (per send,
   * inside the projection's own try): the cap is per-account and this bag is built per request.
   * The hosted API resolves it from the subscription row; the local engine and self-host server
   * type `UNMETERED_STORAGE_CAP` — a value somebody WROTE. ABSENT means REFUSAL, never unmetered:
   * `projectSentCopy` substitutes a resolver that throws, which costs exactly the projection
   * (swallowed and logged; the send answered `sent` long before), and the worker's Sent-folder
   * pass writes the row on its next cycle. A host nobody read gets a loud log line per send — and
   * can never get uncapped storage.
   */
  resolveStorageCap?: (ctx: ServiceContext) => Promise<StorageCap>;
  /**
   * THE PLATFORM CEILING OF THE HOST SERVING THIS SEND, in raw attachment bytes — and `undefined`
   * is not a fourth spelling of `null`. A NUMBER: this host's pipeline refuses a body above it,
   * so the send must stay under it (the hosted API passes `SEND_ATTACHMENT_MAX_TOTAL_BYTES`).
   * `null`: this host has NO platform ceiling — the local engine hands the message straight to
   * SMTP, so the only limit is the mail server's own. ABSENT: nobody said — resolved to
   * `SEND_ATTACHMENT_MAX_TOTAL_BYTES`, the STRICTER branch, deliberately: a host that forgets to
   * declare itself must not thereby acquire an unbounded one. See `effectiveAttachmentCap`.
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
 * WHERE STAGED ATTACHMENT BYTES COME FROM, in two phases — the split is the point. `declare` is
 * metadata: what the caller's tickets say they weigh, one query, so the send can be REFUSED for
 * exceeding the cap before anything is transferred; a one-phase port would have to download to
 * find out, handing an authenticated caller a way to make this process pull arbitrary bytes it
 * then throws away. `fetch` is the bytes, outside the reservation transaction for
 * `streamForwardParts`' reason; it re-measures every object against its ticket, because `declare`
 * reports what a CLIENT asserted at mint time.
 */
export interface StagedAttachmentSource {
  /**
   * The caller's own tickets. Ids that name nothing, or another account's row, are simply absent.
   * `filename` and `contentType` ride beside the size — METADATA the mint stored, never content.
   * `sendContentFingerprint` folds a staged file by `(filename, contentType, sizeBytes)` and
   * cannot use the ticket ID: a re-send under a fresh key RE-STAGES, minting new ids for the same
   * files, so an id-keyed manifest would differ for an identical message and the duplicate guard
   * would miss every attachment-carrying send. Digesting the BYTES is not on the table: they live
   * in object storage, and reaching for them would put a network call inside the reserve
   * transaction.
   */
  declare(
    accountId: string, ids: readonly string[],
  ): Promise<Array<{ id: string; sizeBytes: number; expiresAt: Date; filename: string; contentType: string }>>;
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
 * WHAT RIDES THE SEND REQUEST BODY BEYOND THE DRAFT — and why none of it is stored. The draft row
 * is the message as composed; these parts exist only for the one delivery and are DELIBERATELY
 * not persisted (§13.2/§14): the attached files are handed straight to the transport and written
 * to no table. Absent for an ordinary send. "Not persisted" is a statement about THIS DATABASE
 * and stays exactly true: staged bytes reached this process from object storage, at rest for a
 * bounded window (24 hours at most, private bucket, swept either way) — a fact about the
 * TRANSPORT, stated in the privacy copy; from here the bytes go to the one `OutboundMessage`, and
 * no row.
 */
export interface SendInput {
  /**
   * UPLOADED FILES — decoded bytes, on the request itself. Never written to any table; see
   * `OutboundMessage`. THE PRIMARY TRANSPORT, not a legacy one — the field a future "can we drop
   * it yet" lands on. Every shipping client still emits it: the browser stages only ABOVE the
   * inline ceiling, so every send at or under 3 MB arrives here, and the desktop never stages on
   * either door. Update uptake does not bear on that and cannot be measured — no client-version
   * signal reaches the hosted service. The inline form can only be reconsidered once the
   * desktop's Cloud door stages and the browser stages unconditionally.
   */
  attachments?: SendAttachment[];
  /**
   * STAGED FILES — upload-ticket ids whose bytes are in object storage, not in this request. The
   * second accepted shape of one thing, and the narrower: it exists for the sends the request
   * body cannot carry at all. A send may carry either or both — the lists are concatenated,
   * inline first, and the cap applies to the total. The bytes reach exactly the same place an
   * inline attachment's do: the one `OutboundMessage`, and no table. The difference is a bounded
   * window in a bucket on the way here, which is why the privacy copy says so.
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
 * HOW MANY ATTACHMENT PARTS ONE SEND REQUEST MAY NAME — per list, inline or staged. The byte cap
 * does not bound either list's LENGTH: an inline entry with no `contentBase64` decodes to zero
 * bytes, so any number clears every byte cap; a staged ticket may declare ONE byte, so 3 MB still
 * admits millions of references. 100 is `FORWARD_MAX_PARTS`, deliberately the same number —
 * pinning over picking, the `MARK_SEEN_MAX_IDS` rule. Refused on the RAW array (413),
 * deduplicated after. Not a limit legitimate use meets: the staged transport engages above 3 MB
 * and the mailbox's own `SIZE` binds first. PER LIST — a mixed send bounds at 200 parts, a mixed
 * forward at 300.
 */
export const SEND_MAX_ATTACHMENT_PARTS = 100;

/**
 * HOW MANY ADDRESSES ONE SENT MESSAGE MAY REACH — `to` + `cc` + `bcc`, together. The per-MESSAGE
 * ceiling lives here because here the count becomes network: one `RCPT TO` per address. 500 — the
 * LARGEST per-message ceiling among connected providers (Outlook and iCloud allow 500, Gmail
 * 100); a Gmail-derived 100 would refuse an Outlook send that provider delivers. The bound stops
 * the UNBOUNDED case; a stricter provider answers with its own refusal. Checked INSIDE the
 * reserve transaction so a throw rolls the reservation back. It guards the STORED ROW:
 * `DRAFT_MAX_RECIPIENTS` bounds each field at 100, so a `DraftsService` draft holds at most 300 —
 * this catches older rows, because a row outlives the validator that wrote it.
 */
export const SEND_MAX_RECIPIENTS = 500;

/**
 * The longest `filename` and `contentType` one attachment entry may carry.
 * `SEND_MAX_ATTACHMENT_PARTS` bounds how MANY entries, `SEND_ATTACHMENT_MAX_TOTAL_BYTES` their
 * CONTENT — and each entry's two strings were bounded by neither. They are not content: they
 * become MIME header parameters and a stored column on the staged ticket, so a hundred entries
 * carrying a megabyte filename each is a megabyte-per-header message the transport has to build.
 * 255 is the practical filename ceiling every mainstream filesystem shares, and a content type is
 * far shorter — one number for both, because a caller exceeding either has not sent a filename or
 * a media type.
 */
export const SEND_ATTACHMENT_FIELD_MAX_CHARS = 255;

/**
 * THE STAGED LIST, WITH EACH TICKET NAMED ONCE — first occurrence wins, order preserved. A REPEAT
 * IS A SKIP, NOT A REFUSAL: `ComposeAttach` answers a re-picked file with a collapse and a muted
 * sentence, and erroring here would contradict the form directly above it, spending a composed
 * message on what is at worst a client bug. THE INLINE LIST IS NOT DEDUPED, and the asymmetry is
 * the point: a staged id is a REFERENCE — naming it twice buys a second download of bytes the
 * caller did not send (the amplification); an inline entry CARRIES its bytes — naming it twice
 * costs the caller twice and is counted twice. This does not decide the count ceiling:
 * `SEND_MAX_ATTACHMENT_PARTS` is refused against the list AS SENT, ahead of this.
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
 * WHAT THE MESSAGE COSTS BEFORE A SINGLE ATTACHMENT BYTE — headers, MIME boundaries, and the body
 * somebody typed. `SIZE` bounds the whole document, and `attachmentBudgetFor` converts it into a
 * budget for attachment bytes only; everything else must come out of the announcement first or
 * the conversion is optimistic by exactly the size of the letter. 64 KiB is generous for headers
 * and boundaries and covers an ordinary body. It is not a bound on the body — a megabyte of typed
 * text can still be refused by the server — and erring high costs the user 64 KiB of attachment
 * they never notice, while erring low costs a bounced send.
 */
export const SEND_MIME_ENVELOPE_BYTES = 64 * 1024;

/**
 * THE PER-OBJECT CEILING OF THE STAGING BUCKET, and therefore of the transport that uses it.
 * Uploading straight to object storage removes the request-body limit, not every limit: the
 * bucket refuses an oversize object in the BROWSER's PUT — after the mint answered 201 and after
 * the person waited — and the client can only say "try again", a retry that can never succeed. So
 * the number is stated here, applied by the mint, and declared by the hosted window as its
 * surface. It MIRRORS the bucket's `file_size_limit` and cannot verify it: a bucket configured
 * LARGER goes unused above this line; one configured SMALLER reintroduces the failure. Raising
 * this means raising the bucket first.
 */
export const SEND_STAGED_OBJECT_MAX_BYTES = 40 * 1024 * 1024;

/**
 * AN ANNOUNCED `SIZE` IS ABOUT THE ENCODED MESSAGE; this converts it into a budget for RAW
 * attachment bytes. RFC 1870's `SIZE` bounds the MIME document: attachments are base64 (4 chars
 * per 3 bytes) wrapped at 76 with CRLF, so the expansion is (4/3)·(78/76) and the inverse is
 * exactly 19/26 — 25 MB of files is about 34 MB of message. Reading the announcement as a raw
 * budget overshoots by a third: the user's own provider bounces the send after the wait.
 * Invisible while every mailbox fell back to the 3 MB constant. FLOORED AT ONE BYTE: zero and
 * negative read as "not a ceiling" in `effectiveAttachmentCap`, which would make the stingiest
 * server the most permissive.
 */
export function attachmentBudgetFor(announcedMessageBytes: number): number {
  const forAttachments = announcedMessageBytes - SEND_MIME_ENVELOPE_BYTES;
  if (forAttachments <= 0) return 1;
  return Math.max(1, Math.floor((forAttachments * 19) / 26));
}

/**
 * THE CAP THAT APPLIES TO ONE SEND — the smaller of what the HOST can carry (`surfaceMax`, the
 * request pipeline) and what the MAIL SERVER accepts (`mailboxMax`, the per-mailbox RFC 1870
 * `SIZE` probe, mail 0055). THE `min` IS THE POINT: a provider announcing 2 MB binds a hosted
 * compose to 2 MB — without it the product accepts the send and the user's own server bounces it.
 * AN UNKNOWN CEILING IS THE STRICT ONE, both sides: `undefined` surface resolves to the product
 * constant, and a never-probed mailbox does too — it used to contribute NOTHING, a real widening
 * the day a host declared a 32 MB surface. Non-positive values are ignored: `SIZE 0` means "no
 * fixed maximum" (RFC 1870 §6), so the surface alone binds.
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
 * WHICH SURFACE CEILING THIS SEND RIDES — a property of the TRANSPORT THE BYTES TOOK, not of the
 * host. `surfaceMaxTotalBytes` describes the REQUEST PIPELINE; staged bytes went browser → object
 * storage on a signed URL, so no request-body limit stands between compose and transport. A send
 * carrying ONLY staged references resolves the surface to `null` — explicitly uncapped, the local
 * engine's value — leaving the mailbox's own `SIZE` as the ceiling. A send carrying ANY inline
 * attachment keeps the host's declaration, MIXED included: the inline half really did ride the
 * request body, and lifting the limit lets through a request the platform refuses first, with an
 * opaque error. No attachments keeps the declaration too — one fewer branch.
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
 * HOW LONG AN ACCOUNT'S CLAIM ON ONE MESSAGE'S CONTENT STANDS. Inside it, a second send of the
 * identical message from the same mailbox is REFUSED, whatever key it carries; outside, the claim
 * is reclaimed. One hour: the failure defended is a person pressing Send again after an outcome
 * they could not read (seconds to minutes); the cost falls on a DELIBERATE identical re-send
 * (hours to days). NOT coupled to `IDEMPOTENCY_TTL_MS` (a key's replay) or `SEND_LOCK_TTL_MS` (a
 * client's resume). ENFORCED AT THE DECISION, NEVER BY THE PRUNE — the standalone engine has NO
 * maintenance pass, so prune-based expiry would be infinite on every desktop. A client that lost
 * its key is protected by the draft-status refusal.
 */
export const SEND_DUPLICATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * WHAT THE SERVER SAYS WHEN IT REFUSES A DUPLICATE — one sentence per state the FIRST send is in:
 * `sent` — a copy is provably out there; `unverified` — the fate is unknown, the reader has
 * somewhere to look; `pending` — happening right now. WHO READS IT: not the web shell (it renders
 * its own copy from `details.firstSend`); this is for an API consumer, an older client, and the
 * Drafts row of a SCHEDULED send (`send_error`). ISO-8601 — none of those readers has a locale
 * this process knows. WHICH INSTANT: for `sent`, `outbound_sends.sent_at` — the delivery's clock
 * — never the claim's `created_at`, restamped on every re-point, which named a time nothing
 * happened at. For `unverified`, the claim's stamp; `pending` carries no time.
 */
export function duplicateSendSentence(firstSendStatus: string, at: Date): string {
  const when = at.toISOString();
  if (firstSendStatus === "sent") {
    return `This exact message was already sent from this mailbox at ${when}. `
      + "Nothing was sent now — change the message to send it again.";
  }
  if (firstSendStatus === "unverified") {
    return `An identical message was sent from this mailbox at ${when} and could not be confirmed. `
      + "Check your Sent folder; nothing was sent now.";
  }
  // Deliberately does not promise an ending. The first attempt may still fail before it reaches the
  // mail server, in which case this message has NOT been sent and the retry that follows will send
  // it — so a sentence claiming the message is on its way would be a state the product cannot vouch
  // for. The caller retries rather than settling on this.
  return "This exact message is already being sent from this mailbox. Nothing was sent again; "
    + "ohmail is still waiting to hear how the first attempt ended.";
}

/**
 * WHAT MAKES TWO SENDS THE SAME MESSAGE — the digest the content claim is keyed on. Every member
 * is something a RECIPIENT can perceive; the exclusions are load-bearing: `draftId` (the field
 * the defect moves), `mailboxId` (already a KEY COLUMN), the minted Message-ID, the idempotency
 * key, the thread id, the From display name. `forwardOf` IS in it: two forwards of DIFFERENT
 * originals with no note agree on everything else. Addresses compare as the delivery sees them.
 * Attachments fold by `(filename, contentType, sizeBytes)` in ONE sorted list. `JSON.stringify`
 * over an ARRAY, never a delimiter join (the safe-looking separator is a control byte). SHA-256:
 * a collision HERE suppresses a message somebody wrote.
 */
export function sendContentFingerprint(input: {
  to: readonly EmailAddress[];
  cc: readonly EmailAddress[];
  bcc: readonly EmailAddress[];
  subject: string;
  /**
   * BOTH HALVES, SEPARATELY — never `html ?? body` collapsed into one member.
   *
   * Collapsing them made two genuinely different messages hash alike: a PLAIN draft whose body is
   * the literal text `<p>Approved</p>` and a RICH draft whose markup is `<p>Approved</p>` produce
   * the same string, so the second was refused as a copy of the first. One arrives as visible
   * angle brackets and the other as a formatted line — different to the recipient, which is the
   * only test that matters here.
   */
  html: string | null;
  body: string;
  inReplyToMessageId: string | null;
  forwardOf: string | null;
  sendAt: Date | null;
  /**
   * Inline files, digested by CONTENT. Staged files never reach here — a send carrying them is
   * excluded from the content claim entirely (see `reserve`): metadata is not an identity. The
   * metadata fold was wrong for inline files, and the counter-example is ordinary: attach
   * `invoice.csv`, correct one figure, send the correction — same name, type, byte length; the
   * digests collided and the CORRECTION never left while the screen said sent. Silently not
   * sending is worse than sending twice. The bytes were available all along: an inline attachment
   * arrives decoded. Staged files were measured refusing a corrected 5 MiB file the same way, so
   * they are excluded outright rather than covered by an identity that is not one.
   */
  attachments: ReadonlyArray<{
    filename: string; contentType: string; sizeBytes: number; contentSha256: string | null;
  }>;
}): string {
  const addrs = (xs: readonly EmailAddress[]): string[] =>
    [...new Set(xs.map((a) => a.address.trim().toLowerCase()))].sort();
  const files = input.attachments
    .map((a) => [a.filename, a.contentType, a.sizeBytes, a.contentSha256] as const)
    .map((t) => JSON.stringify(t))
    .sort();
  const canonical = JSON.stringify([
    addrs(input.to), addrs(input.cc), addrs(input.bcc),
    input.subject,
    input.html,
    input.body,
    input.inReplyToMessageId ?? null,
    input.forwardOf ?? null,
    input.sendAt ? input.sendAt.toISOString() : null,
    files,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The Drafts-row sentence for a definite non-delivery whose cause has no sentence of its own. A
 * `ServiceError` carries one and is quoted verbatim (`finalizeFailed`); this is for everything
 * else — a socket reset during login, a storage read that threw, any unexpected fault inside the
 * pre-SMTP window. Those messages are diagnostics, not sentences: they name hosts, ports and
 * library internals, and belong in the log. It states the one certain fact and the one action
 * that works. It deliberately does NOT say "check your Sent folder" — that sentence is reserved
 * for `unverified`, where the fate really is unknown; saying it here is the exact lie the
 * pre-SMTP window was built to stop.
 */
export const SEND_FAILED_SENTENCE =
  "This was not sent — the message never reached your mail server. Send it again.";

/**
 * HOW LONG ONE SEND ATTEMPT MAY HOLD THE PRESS. Not a network deadline — `DEFAULT_NET_TIMEOUTS`
 * bounds each socket operation; a send is a SEQUENCE of them, each able to sit just under its own
 * deadline, so the sequence had no ceiling but the platform kill. The clock starts once the
 * RESERVATION HAS COMMITTED; `reserve` stays outside — a breach there has no reservation to
 * finalize and no key to answer under (`resumeExisting` resolves that state). The number sits far
 * above every healthy attempt and far below the 60-second invocation kill, which has no `finally`
 * and no response. A BREACH means: before `adapter.send` — DEFINITE non-delivery (`failed`); at
 * or after — UNKNOWN fate, answered `queued`, nothing resent.
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
 * The outcome the route maps: `sent` → 200 (+ X-Sync-Seq); `unverified` → 200, ambiguous,
 * surfaced; `failed` → 409, a definitively-undelivered prior attempt under this key; `in_flight`
 * → 409, a concurrent attempt mid-flight; `queued` → 202 — THIS request reserved the send and
 * stopped waiting at `SEND_ATTEMPT_CEILING_MS`: `unverified`'s unknown fate, caught while the
 * attempt is alive. `in_flight` is told to a SECOND request about someone else's attempt;
 * `queued` to the OWNING request about its own — the one a first press can produce. NOTHING IS
 * EVER RESENT ON `queued`: the reservation stays `pending` with its key, exactly what
 * `resumeExisting` reads. One press stays one delivery.
 */
export interface SendResult {
  status: "sent" | "unverified" | "failed" | "in_flight" | "queued";
  providerMessageId: string | null;
  draftId: string;
  seq: number | null;
}

/**
 * HOW a stale reservation was decided — the half of `ResolveStaleOutcome` the reconciling pass
 * counts and the client path discards. `mirror` — the account's own `messages` mirror holds the
 * minted id; no dial. `probe` — the Sent folder was searched over a live connection and answered.
 * `undialable` — no dial was possible or permitted and the caller asked for a decision anyway (a
 * `disabled` mailbox, credentials gone, a give-up). `elsewhere` — the compare-and-swap matched
 * nothing: another resolver already wrote a terminal state, and `status` is THEIRS, re-read.
 * `deferred` — nothing was written and nothing is claimed; try again next cycle.
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
 * The ceiling as a thing that can be raced — one timer per attempt, shared by both phases. ONE
 * clock for the whole attempt rather than one per phase, because the budget being spent is the
 * reader's patience and it does not reset when the dial finishes — a per-phase timer would let a
 * slow open and a slow submission add up to twice the ceiling, the unbounded sequence this exists
 * to end. `reached` NEVER rejects: it is a race arm, and an arm that can reject turns "we ran out
 * of time" into a throw the caller has to distinguish from a real fault.
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
 * Race a phase against the attempt ceiling. The losing promise is NOT cancelled and must not be —
 * there is no way to un-send an envelope. On a host whose process outlives the response (the
 * desktop's local engine) the abandoned submission runs to its own finalizer: the row flips to
 * `sent` on its own and the client learns it from `/sync` — exactly the recovery this design
 * wants. On a serverless host the invocation ends and the reservation is resolved by the same
 * verify-by-Sent recovery a crashed attempt uses. Neither host resends. The caller owns what
 * happens to an abandoned promise — see the two call sites in `send`: one closes a leaked socket,
 * the other lets the submission finish.
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
 * SendService (POST /drafts/:id/send) — the gated idempotent send; the route 400s without
 * `Idempotency-Key`. The invariant is NO double-send, even across a crash between the SMTP call
 * and its finalize: 1. RESERVE (short tx, NO network) — `(accountId, idempotencyKey)` via INSERT
 * … ON CONFLICT DO NOTHING, Message-ID minted UP FRONT, draft marked `sending`; a conflict
 * branches on the stored status. 2. SMTP OUTSIDE the tx. 3. FINALIZE (short tx) — `sent` +
 * providerMessageId. 4. RECOVERY (verify-by-Sent) — a same-key request finding a STALE `pending`
 * row searches Sent for the minted id: FOUND ⇒ `sent`, NOT FOUND ⇒ `unverified`; NEVER resend on
 * ambiguity. Every transition emits a `draft` change; a cross-account draft id is a 404.
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

    // THE PRE-SMTP WINDOW: EVERY FAILURE IN HERE IS A DEFINITE NON-DELIVERY, AND IS RECORDED AS
    // ONE. The reservation has COMMITTED and the draft says `sending`; no socket exists and no
    // envelope has been offered. A throw here used to leave the reservation `pending` — read as
    // AMBIGUOUS: `in_flight` for ten minutes, then verify-by-Sent finalizes `unverified`, "check
    // your Sent folder" for mail that never left. Closed as a WINDOW because every step in it has
    // the identical property: `finalizeFailed` records the definite outcome, the draft returns to
    // `draft`. OPENING THE TRANSPORT IS INSIDE IT — credential decrypt, dial and login all
    // precede any envelope. `adapter.send` stays OUTSIDE: its failure is genuinely ambiguous. The
    // ceiling splits on this same boundary: a timeout in here is `failed`; below, `queued`.
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
       * It owns `adapter.close()` in its own `finally`: once the ceiling is reached this function
       * has returned and there is no caller left to run one — and closing the adapter under a
       * live SMTP session is the one thing that could turn a slow send into a failed one. On a
       * host whose process outlives the response this promise runs to completion and calls the
       * real finalizer, so a send that beat the clock by a second still lands `sent` and the
       * client learns it from `/sync`. On a serverless host the invocation ends and the
       * reservation is left for verify-by-Sent. Neither host resends.
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
   * Extracted from `send` so the window has one boundary rather than two call sites the next
   * person has to notice are related. Both steps are network, both run outside the reservation
   * transaction, and neither persists a byte: the files land on the one `OutboundMessage` that
   * both goes out and is appended to Sent. A failure is never swallowed and never partially
   * applied — a send that quietly dropped an attachment the composer showed is a WRONG send, the
   * ruling the forward path made first and the staged path inherited.
   */
  private async assemble(
    ctx: ServiceContext,
    reservation: Extract<Reservation, { kind: "new" }>,
    deps: SendDeps,
    input: SendInput,
  ): Promise<void> {
    const { msg } = reservation;

    // STAGED: PULL THE BYTES FROM OBJECT STORAGE onto the outgoing message — outside the
    // reservation tx (network), BEFORE `send`, where the forward's IMAP stream runs and for the
    // same reasons: the files must be on the one `OutboundMessage`, never persisted. A failure is
    // NOT swallowed: `fetch` throws when an object is gone or bigger than its ticket declared,
    // ending the send as a DEFINITE non-delivery (`finalizeFailed`) — nothing has been offered to
    // any server. This used to read "the user retries under the same key", which is how a
    // definite failure came to be recovered as an ambiguous one. The bytes were refused against
    // the cap BY DECLARATION in `reserve`; `fetch` re-measures, so what lands can only be
    // smaller. DEDUPED, the same list `reserve` weighed: one ticket named twice is one file —
    // before this, a repeat was a second download AND a second copy on the message.
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
   * PROJECT THE SENT COPY INTO THE DATABASE NOW, instead of waiting for the mailbox re-read.
   * `ImapAdapter.send` has APPENDed to Sent, so the master holds it; until this, the `messages`
   * row waited a whole poll interval. A SEPARATE TRANSACTION, AFTER the finalize: folding it in
   * would put a MIME parse and five writes inside the transaction holding the seq lock — and a
   * projection failure would roll the finalize back, leaving `pending` for a message ALREADY
   * DELIVERED. A FAILURE IS LOGGED, NEVER THROWN: the mail is gone, and a 500 for a successful
   * send is worse than a row the worker writes next cycle anyway. `seq` stays the FINALIZE's: the
   * client drains after this response, so the row is in the next drain either way.
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
          // Carried from `ctx.db`: the transaction object has no dialect brand of its own, and the
          // routing writes this repository performs all compose locking statements.
          (tx) => run(makeDrizzleRepo(carryDialect(ctx.db, tx) as never) as RepoPort & RoutingPort),
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
    // STAGED REFERENCES: WHAT THEY WEIGH, BEFORE ANYTHING IS TRANSFERRED. Outside the
    // transaction, deliberately: it is a second query and the reserve tx holds `FOR UPDATE` on
    // the draft row — and it is the ONLY place the total can be refused cheaply; after the
    // reservation the bytes must be pulled to be measured, and a caller that can make this
    // process download an arbitrary amount it then throws away is a cost hole. The numbers are
    // the client's own mint-time declarations and are treated as such: they bound what we are
    // WILLING to fetch; `fetch` re-measures, and a body larger than its ticket never reaches the
    // transport. DEDUPED HERE TOO — it must be the same list `send` will fetch, or the refused
    // total is not the pulled total; summing per OCCURRENCE would let a repeated one-byte ticket
    // inflate the total until the cap fired on bytes nobody transfers twice.
    const stagedIds = dedupeStagedIds(input.stagedAttachmentIds);
    let stagedTotal = 0;
    /**
     * THE STAGED HALF OF THE FINGERPRINT MANIFEST, collected here because this is the only place
     * the facts exist — `declare` runs once, outside the transaction, and nothing downstream
     * re-reads it. Metadata only: see {@link StagedAttachmentSource.declare} for why the ticket ID
     * cannot be the identity and why the bytes are not reachable from inside the reserve tx.
     */
    const stagedManifest: Array<{ filename: string; contentType: string; sizeBytes: number }> = [];
    /**
     * A STAGED-REFERENCE PROBLEM, HELD RATHER THAN THROWN — an idempotent REPLAY must not be
     * turned into an error by it. The refusals are about the tickets a client named, and a
     * same-key retry that reaches the CONFLICT branch is not asking to send anything: it is
     * asking what happened last time. Thrown here, an expired ticket would answer "your upload
     * expired" to a replay of a send that SUCCEEDED — the worst ending on this path. So the fault
     * is carried into the transaction and raised beside the disabled-mailbox check, AFTER the
     * conflict branch has returned. `stagedTotal` stays 0 when a fault is held, so the cap check
     * cannot fire a spurious 413 off a partial sum and mask the real answer.
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
          stagedManifest.push({ filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes });
        }
        // Both are cleared together: a held fault means this list is INCOMPLETE, and an incomplete
        // manifest must never become a fingerprint. It cannot anyway — `stagedFault` is thrown
        // above the claim — but a half-filled list left lying around is the kind of thing a later
        // reader moves a line past.
        if (stagedFault) { stagedTotal = 0; stagedManifest.length = 0; }
      }
    }
    const attachTotal = inlineTotal + stagedTotal;
    return asTx(ctx).transaction(async (tx): Promise<Reservation> => {
      // `FOR UPDATE`, because this read decides the SENDING IDENTITY. The draft's `mailboxId` is
      // PATCHable while the row is a draft, and a plain read-committed SELECT does not wait for a
      // concurrent move's row lock — it reads the pre-move snapshot, so the envelope, the minted
      // Message-ID and the SMTP dial would all be the OLD identity's while the row commits the
      // new one. The lock serializes the two writers: reserve waits and reads what the move
      // committed, or wins and flips to `sending`, at which point the move's own status predicate
      // refuses. Measured — `draft-move-race.pg.test.ts` watched the plain SELECT dial the
      // pre-move mailbox. Safe to WAIT on here (unlike the finalize's doorbell): nothing has been
      // sent yet and every other holder is a short CRUD transaction.
      const [d] = await dialect(ctx.db).forUpdate(tx.select().from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.accountId, ctx.accountId)))
        .limit(1));
      if (!d) throw new ServiceError("not_found", 404, "draft not found");

      const [mb] = await tx.select({
        address: mailboxes.address, status: mailboxes.status,
        smtpMaxSizeBytes: mailboxes.smtpMaxSizeBytes,
      }).from(mailboxes)
        .where(eq(mailboxes.id, d.mailboxId)).limit(1);

      // THE ATTACHMENT CAP, refused BEFORE the reservation commits. Enforced on the decoded bytes
      // (the route already rejected an oversize body); this is the product rule the compose
      // surface states. It throws INSIDE the transaction, rolling it back — nothing is reserved
      // and no draft leaves `draft`. It reads the mailbox row, which is why it sits here rather
      // than ahead of the transaction: the ceiling is per-mailbox now (`effectiveAttachmentCap`),
      // the SMALLER of the host's limit and what this mailbox's submission server announced. The
      // reorder costs one thing worth naming: a send over the cap on a nonexistent draft answers
      // 404 rather than 413 — the more truthful answer. The surface is `sendSurfaceFor`'s, not
      // `deps`' directly: staged bytes did not ride this host's request body.
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
        const [existing] = await dialect(ctx.db).forUpdate(tx.select().from(outboundSends)
          .where(and(eq(outboundSends.accountId, ctx.accountId), eq(outboundSends.idempotencyKey, idempotencyKey)))
          .limit(1));
        if (!existing) throw new ServiceError("internal", 500, "reservation vanished");
        return { kind: "existing", row: existing, mailboxId: d.mailboxId };
      }

      // A DISABLED MAILBOX REFUSES HERE, AND THE ROLLBACK IS THE POINT. It used to be refused by
      // accident: `MailboxService.delete` also deletes credentials, so `makeSendAdapter` threw —
      // AFTER the reservation committed, leaving the draft stuck and a same-key retry walking to
      // `unverified`. The other three disable paths (billing downgrade, the organizer lease, a
      // plain PATCH) LEAVE CREDENTIALS IN PLACE, so the mail was genuinely sent from a mailbox
      // the account no longer holds — for those this is the only refusal. AFTER THE INSERT: above
      // it, the CONFLICT branch — idempotent REPLAY — would be told `mailbox_disabled` instead of
      // its stored `sent` result; a throw here rolls the INSERT back too. ONLY `'disabled'`:
      // `'error'` is the worker's IMAP verdict, SMTP a different transport. THE HELD STAGED FAULT
      // is raised here for the identical reason.
      if (stagedFault) throw stagedFault;

      // THE RECIPIENT CAP, with the other NEW-RESERVATION preconditions. The three lists are on
      // the row this transaction already locked, so the total costs nothing — and this is the
      // first moment all three exist together: a partial update names one field and cannot know
      // the other two. See `SEND_MAX_RECIPIENTS` for why the per-message total lives here and the
      // per-field one at the draft write. BELOW THE INSERT, for the reason the two checks above
      // give in full: the CONFLICT branch returns before reaching here, and that branch is
      // idempotent REPLAY — placed above, this would answer 413 to a client retrying its key
      // after a send that SUCCEEDED. The position matches the disabled-mailbox check's and costs
      // nothing: a throw anywhere in this callback rolls the INSERT back.
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

      // RFC 5322 §3.6.4: References is a CHAIN, not a pointer. This used to send `references:
      // inReplyTo` — the parent's Message-ID alone; a recipient whose client threads on the
      // LEFTMOST reference then anchors our reply mid-chain and mints a SECOND conversation. Our
      // own ingest keys on the leftmost entry (`threads.rootMessageIdHeader`), so we were sending
      // mail we would have mis-threaded ourselves. ROOT+PARENT, not the full chain: the arriving
      // `References` header is not stored (`messages` has no column), so the chain is not
      // reconstructable — the root anchors the conversation, the parent places the reply; middle
      // ancestors are informational, and losing them degrades order, not threading. The complete
      // fix is to persist `References` at ingest; until then this is an approximation, stated as
      // one.
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
       * THE LAST GATE BEFORE THE BYTES LEAVE THE BUILDING. `DraftsService` already sanitized this
       * html, so this pass is normally a no-op — `sanitizeOutboundHtml` is idempotent, asserted
       * rather than assumed. It is here because "DraftsService is the only writer" is a claim
       * about today: the AI workflow code already inserts into `drafts` directly, and the next
       * writer will not remember to ask; sanitizing where the envelope is assembled closes every
       * writer at once. Promoted markup is a FIXED POINT of this pass, asserted. `text` stays
       * `d.body` untouched: for a rich draft, `body` IS the alternative derived from this html at
       * write time — deriving it again could differ from the stored one.
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

      // THE ACCOUNT'S CLAIM ON THIS CONTENT — LAST, IMMEDIATELY BEFORE THE FLIP; the duplicate
      // defence that does not depend on the client keeping its key. Here for two reasons: the
      // digest is computed from a FULLY VALIDATED row, so a refused draft never leaves a claim
      // behind; and the row lock is held for the shortest span. BELOW THE CONFLICT BRANCH: that
      // branch is idempotent REPLAY — a client retrying its key after a success is handed the
      // stored result. A SEND CARRYING STAGED FILES IS NOT COVERED: staged bytes cannot be seen
      // from this transaction, metadata is not an identity (measured: a one-byte correction kept
      // name/type/size and never left), and ticket ids always differ on a re-stage — a claim
      // keyed on them never matches. Excluded, explicitly; the durable key and the draft-status
      // refusal remain.
      if (stagedIds.length > 0) {
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
      }

      const fingerprint = sendContentFingerprint({
        to, cc, bcc,
        subject: d.subject,
        // The STORED text, not the assembled `msg.text`: a forward's quoted original is covered by
        // `forwardOf` below, and folding the quote in as well would make the digest depend on how
        // the original renders today.
        // BOTH halves, never collapsed — see the member's own note.
        html: d.html ?? null,
        body: d.body,
        inReplyToMessageId: d.inReplyToMessageId ?? null,
        forwardOf: input.forwardOf ?? null,
        sendAt: d.sendAt ?? null,
        attachments: [
          // INLINE: the bytes are right here, decoded on the request, so they are digested. No
          // network, no transaction cost worth naming — a hash over what the sender attached.
          ...(input.attachments ?? []).map((a) => ({
            filename: a.filename, contentType: a.contentType, sizeBytes: a.content.byteLength,
            contentSha256: createHash("sha256").update(a.content).digest("hex"),
          })),
          // No staged entries here BY CONSTRUCTION: a send carrying staged files returns above,
          // before this digest is computed. `stagedManifest` is still collected for the size cap,
          // which is a different question and does not pretend to be an identity.
        ],
      });
      const claimNow = ctx.now();
      const claimed = await tx.insert(outboundSendFingerprints).values({
        accountId: ctx.accountId, mailboxId: d.mailboxId, fingerprint,
        sendId: inserted[0]!.id, createdAt: claimNow,
      })
        .onConflictDoNothing({
          target: [
            outboundSendFingerprints.accountId,
            outboundSendFingerprints.mailboxId,
            outboundSendFingerprints.fingerprint,
          ],
        })
        .returning({ id: outboundSendFingerprints.id });

      if (claimed.length === 0) {
        // A CLAIM ALREADY STANDS, AND THIS IS WHERE THE RACE IS ARBITRATED BY THE DATABASE.
        //
        // `ON CONFLICT DO NOTHING` does not fail fast against an UNCOMMITTED conflicting row: it
        // BLOCKS on the index until that transaction ends, and then does nothing if it committed
        // or inserts if it aborted. So reaching this line means a committed claim exists — two
        // simultaneous sends of one message cannot both get here, and the loser is decided by
        // Postgres rather than by a read-then-write nothing serializes.
        const [held] = await dialect(ctx.db).forUpdate(
          tx.select().from(outboundSendFingerprints)
            .where(and(
              eq(outboundSendFingerprints.accountId, ctx.accountId),
              eq(outboundSendFingerprints.mailboxId, d.mailboxId),
              eq(outboundSendFingerprints.fingerprint, fingerprint),
            ))
            .limit(1));
        if (!held) {
          // The claim was deleted between the blocked INSERT and this read. The maintenance prune
          // is the only thing that deletes one, so this is the 24-hour sweep landing in the
          // microseconds between two statements. Take the claim now rather than refusing a send
          // over a row that no longer exists.
          const retook = await tx.insert(outboundSendFingerprints).values({
            accountId: ctx.accountId, mailboxId: d.mailboxId, fingerprint,
            sendId: inserted[0]!.id, createdAt: claimNow,
          })
            .onConflictDoNothing({
              target: [
                outboundSendFingerprints.accountId,
                outboundSendFingerprints.mailboxId,
                outboundSendFingerprints.fingerprint,
              ],
            })
            .returning({ id: outboundSendFingerprints.id });
          if (retook.length === 0) {
            throw new ServiceError("internal", 500, "the content claim could not be taken");
          }
        } else {
          // `sent_at` rides this SAME read, in the same statement and the same transaction: the
          // refusal below has to name an instant, and this is the only column that holds one. See
          // the block at the throw for why the claim's own stamp is not that instant.
          const [prior] = await tx.select({
            status: outboundSends.status, sentAt: outboundSends.sentAt,
          })
            .from(outboundSends).where(eq(outboundSends.id, held.sendId)).limit(1);
          const priorStatus = prior?.status ?? "pending";
          // TWO WAYS A STANDING CLAIM IS RECLAIMED, AND THE SECOND IS NOT AN OPTIMISATION. AGE —
          // the window has passed, so these are two intents rather than one; compared against the
          // REQUEST CLOCK and never left to the prune (the standalone engine has no maintenance
          // pass, so prune-based expiry would be infinite on every desktop). FAILED — the
          // reservation this claim names ended in a DEFINITE NON-DELIVERY: the draft is back at
          // `draft` and the person must be able to press Send again on the same unedited text;
          // without this arm the ordinary "the mail server was down, try again" retry would be
          // broken by the guard meant to protect it. Terminal `sent` and `unverified` do NOT
          // reclaim: something may be in the recipient's inbox.
          const stale = claimNow.getTime() - held.createdAt.getTime() >= SEND_DUPLICATE_WINDOW_MS;
          if (!stale && priorStatus !== "failed") {
            // RETRYABLE ONLY WHILE THE FIRST ATTEMPT IS UNSETTLED. `sent`/`unverified` are
            // terminal — something may be in the recipient's inbox; `pending` is NOT an outcome,
            // and treating it as terminal loses a message: A stalls, B retries and is refused
            // with `pending`, B stops asking, A then fails BEFORE submission — nothing delivered.
            // Retryable under the same key: A `failed` ⇒ the claim reclaims and B SENDS; A
            // terminal ⇒ terminal refusal; A running ⇒ pending again. A WAIT IS ONLY HONEST WHILE
            // THE FIRST ATTEMPT COULD STILL BE RUNNING — bounded by `SEND_STALE_AFTER_MS`: a
            // queued wait outliving the window is admitted after the reclaim and delivers twice
            // with nobody pressing Send. A person pressing again after the hour is a fresh key;
            // this closes the automatic path only.
            const claimAgeMs = claimNow.getTime() - held.createdAt.getTime();
            const stillRunning = priorStatus === "pending" && claimAgeMs < SEND_STALE_AFTER_MS;
            // WHICH INSTANT THIS REFUSAL NAMES, AND WHY IT IS NOT THE CLAIM'S. The time is the
            // one thing a person can act on — they go look in Sent — so it must be the delivery's
            // instant. `held.createdAt` is the WINDOW's clock, restamped at every re-point: the
            // age of an intent. `outbound_sends.sent_at` is the delivery's. They come apart on an
            // ordinary ending: `adapter.send` throws, the reservation stays `pending`,
            // verify-by-Sent settles it later — a press reserved at 09:00 and confirmed at 09:50
            // answered "already sent at 09:00". The gap is bounded by the window. BOTH HALVES
            // MOVE TOGETHER — the sentence and `firstSend.at`. A NULL `sent_at` on a `sent` row
            // should not happen (`finalizeSent` writes both in one statement); if one appears,
            // the claim's stamp is the fallback.
            const firstSendAt = priorStatus === "sent"
              ? (prior?.sentAt ?? held.createdAt)
              : held.createdAt;
            throw new ServiceError(
              "duplicate_send", 409,
              duplicateSendSentence(priorStatus, firstSendAt),
              { firstSend: { status: priorStatus, at: firstSendAt.toISOString() } },
              stillRunning,
            );
          }
          // RE-POINT rather than insert a second row: one claim per piece of content, carried
          // forward to whichever reservation owns it now. `createdAt` is restamped because it is
          // the window's clock and not the row's birthday.
          await tx.update(outboundSendFingerprints)
            .set({ sendId: inserted[0]!.id, createdAt: claimNow })
            .where(eq(outboundSendFingerprints.id, held.id));
        }
      }

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
   * FETCH A FORWARD'S ORIGINAL ATTACHMENTS from IMAP onto the outgoing message. Outside any
   * transaction, on its OWN adapter, closed in `finally`; parts share the original's locator and
   * differ by `partId`; an inline part keeps its `cid`. A part over the byte budget stops the
   * fetch: silently dropping files is a wrong send. A STALE LOCATOR IS RE-RESOLVED ONCE, THEN
   * REFUSED HONESTLY: the original can move between the reservation's read and this fetch; the
   * adapter refuses with `MessageGoneError` rather than handing back whatever now wears that UID.
   * Re-reading `messages.native_locator` is the witness — tried EXACTLY ONCE. If the re-read has
   * not caught up, the send is refused with what is TRUE — never the ambiguous recovery.
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
   * THE SENTENCE FOR A FORWARD WHOSE ORIGINAL HAS MOVED — three facts, in the order needed. 1.
   * Nothing was sent — known with certainty (`adapter.send` was not reached). 2. What went wrong,
   * in terms of the mailbox: the message being forwarded moved — not "MessageGoneError", not a
   * UIDVALIDITY lecture. 3. What makes it work, CONDITIONALLY: press Send again once the mailbox
   * has caught up — conditional because `MessageGoneError` also covers a permanent DELETE, where
   * no waiting helps. 409 rather than 410: our state conflicts with the server's, and 410 asserts
   * a permanence that is usually false. The client shows this sentence verbatim with Send live
   * again.
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
    /**
     * THE KEY'S MESSAGE WAS DISCARDED, SO THERE IS NOTHING TO REPLAY (mail 0095: `draft_id` is
     * `ON DELETE SET NULL`). This read is keyed on `(account_id, idempotency_key)` ALONE, so the
     * row need not be about the message the caller holds — replying with the CALLER's `draftId`
     * would claim their open draft was already sent, and `draftId: null` pushes the question into
     * a client with no branch for it. A named refusal instead, mapped to a terminal rollback. A
     * live client cannot produce the sequence — the durable key is released on EVERY terminal
     * outcome — so this arm means a stale client replaying a key for a message that no longer
     * exists.
     */
    if (row.draftId === null && (row.status === "sent" || row.status === "failed")) {
      throw new ServiceError(
        "send_key_draft_discarded", 409,
        "the message this send belonged to was discarded; a new send makes a new key",
      );
    }
    if (row.status === "sent") {
      return {
        status: "sent", providerMessageId: row.providerMessageId,
        draftId: draftOfTerminalAttempt(row), seq: null,
      };
    }
    if (row.status === "unverified") {
      return { status: "unverified", providerMessageId: null, draftId: draftOfOpenAttempt(row), seq: null };
    }
    if (row.status === "failed") {
      return { status: "failed", providerMessageId: null, draftId: draftOfTerminalAttempt(row), seq: null };
    }

    // status === "pending" → is the first attempt STILL RUNNING, or the wreckage of one that
    // died? Every pending row used to be probed immediately, wrong in the most ordinary case: a
    // double-tap or slow-response retry probes Sent WHILE the first attempt is mid-SMTP, finds
    // nothing, and writes `unverified` — marking a succeeding send ambiguous and telling the user
    // to go check Sent. It also made the declared `in_flight` outcome unreachable.
    // `SEND_STALE_AFTER_MS` is the cutoff, deliberately far longer than any invocation can live:
    // younger rows may have a live sender behind them, so the honest answer is `in_flight` (409,
    // retry later); older rows are genuinely orphaned and verify-by-Sent is correct. No longer
    // the ONLY recovery: `runSendReconcilePass` runs the identical resolution on a clock — both
    // through `resolveStale`, the single writer.
    const ageMs = ctx.now().getTime() - row.createdAt.getTime();
    if (ageMs < SEND_STALE_AFTER_MS) {
      return { status: "in_flight", providerMessageId: null, draftId: draftOfOpenAttempt(row), seq: null };
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
   * RESOLVE ONE STALE RESERVATION — the single implementation shared by the same-key retry
   * (`resumeExisting`) and the reconciling pass; both write the SAME terminal states from the
   * SAME evidence: never resend on ambiguity. TWO ARMS, ORDER LOAD-BEARING: 1. MIRROR — an
   * indexed lookup on the minted id, no LOGIN; A MISS SAYS NOTHING (the mirror lags), so only the
   * IMAP arm may write `unverified`. 2. IMAP — found ⇒ `sent`; not found ⇒ `unverified`; a THROW
   * propagates, row untouched. `openAdapter` is `null` for a caller that may NOT dial; `onMiss`
   * says what a miss MEANS. A factory `ServiceError` (credentials gone) resolves `unverified` —
   * no adapter can ever be built again. THE CAS LOSER ANSWERS THE WINNER'S STATE.
   */
  async resolveStale(
    ctx: ServiceContext,
    row: typeof outboundSends.$inferSelect,
    mailboxId: string,
    openAdapter: OpenSendAdapter | null,
    onMiss: "unverified" | "defer" = "unverified",
  ): Promise<ResolveStaleOutcome> {
    // 1. The mirror arm. Account-scoped like every read in this service. NORMALIZED, and this is
    // the whole arm: `mintedMessageId` is `<uuid@domain>` WITH angle brackets (`mintMessageId`),
    // while `messages.message_id_header` is written through `normalizeMessageId`, which STRIPS
    // them (`record-at-send.pg.test.ts` pins the column). Comparing the two spellings matches
    // zero rows for every real send, so the arm silently never fired: every row paid a LOGIN, and
    // — far worse — on the no-dial branches the mirror is the ONLY evidence, so a `disabled`
    // mailbox or a give-up would write terminal `unverified` over a message the mirror was
    // holding all along. It shipped green because the first version of the test seeded the header
    // WITH brackets, which no writer in this codebase does.
    const mintedKey = normalizeMessageId(row.mintedMessageId);
    const mirrored = mintedKey === null ? [] : await ctx.db.select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.accountId, ctx.accountId),
        eq(messages.messageIdHeader, mintedKey),
      ))
      .limit(1);
    if (mirrored.length > 0) return this.settleSent(ctx, row, mailboxId, "mirror");

    // ── 2. The IMAP arm, when this caller may dial at all.
    if (openAdapter === null) {
      if (onMiss === "defer") {
        return {
          status: "pending", providerMessageId: null, draftId: draftOfOpenAttempt(row), seq: null, by: "deferred",
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
      // SWALLOWED, and it is not defensive tidying. This `finally` REPLACES whatever the try
      // produced, so a close that rejects on an already-broken socket would (a) throw away the
      // `SettleFailed` tag the reconciling pass uses to decide never to give up on a row whose
      // probe had already answered, and (b) on the client door — where this is a real connection,
      // not the pass's no-op wrapper — turn a send that was just committed as `sent` into a 500.
      // The send path's own abandoned-submission close (`send`'s `finally`) is guarded the same
      // way. NOT every close in this file is: the forward-attachment fetch above still awaits a
      // bare `adapter.close()` in its `finally`, where a rejection would fail a forward whose
      // attachments had already been read. Outside this lane's scope, and named rather than
      // implied by a sentence claiming they all are.
      await adapter.close().catch(() => { /* the connection is already broken */ });
    }
  }

  /** `finalizeSent`, plus the CAS-loser re-read. See {@link SendService.resolveStale}. */
  private async settleSent(
    ctx: ServiceContext, row: typeof outboundSends.$inferSelect, mailboxId: string,
    by: ResolveStaleBy,
  ): Promise<ResolveStaleOutcome> {
    // A THROW HERE IS A WRITE FAILURE, NOT A PROBE FAILURE — tagged so the reconciling pass
    // cannot apply its give-up to it and record `unverified` for a message the Sent folder had
    // just confirmed. See {@link SettleFailed}.
    // `answerWinner` IS INSIDE THE TRY, not after it. Its re-read is part of settling: a pool
    // fault there is still "the mailbox answered and the database could not record it", and
    // leaving it untagged would let the reconciling pass apply its give-up to a row whose probe
    // had already spoken.
    try {
      const seq = await this.finalizeSent(ctx, row.id, row.mintedMessageId, draftOfOpenAttempt(row), mailboxId);
      if (seq === null) return await this.answerWinner(ctx, row);
      return { status: "sent", providerMessageId: row.mintedMessageId, draftId: draftOfOpenAttempt(row), seq, by };
    } catch (err) {
      throw new SettleFailed("sent", err);
    }
  }

  /** `finalizeUnverified`, plus the CAS-loser re-read. See {@link SendService.resolveStale}. */
  private async settleUnverified(
    ctx: ServiceContext, row: typeof outboundSends.$inferSelect, by: ResolveStaleBy,
  ): Promise<ResolveStaleOutcome> {
    // See {@link SettleFailed} — the evidence was in; only the write failed.
    // `answerWinner` inside the try, for `settleSent`'s reason.
    try {
      const seq = await this.finalizeUnverified(ctx, row.id, draftOfOpenAttempt(row));
      if (seq === null) return await this.answerWinner(ctx, row);
      return { status: "unverified", providerMessageId: null, draftId: draftOfOpenAttempt(row), seq, by };
    } catch (err) {
      throw new SettleFailed("unverified", err);
    }
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
        status: "pending", providerMessageId: null, draftId: draftOfOpenAttempt(row), seq: null, by: "deferred",
      };
    }
    return {
      status,
      providerMessageId: status === "sent" ? (now?.providerMessageId ?? row.mintedMessageId) : null,
      draftId: draftOfOpenAttempt(row),
      seq: null,
      by: "elsewhere",
    };
  }

  /**
   * FINALIZE-sent tx: mark reservation + draft `sent`, emit the `draft` change — AND stamp the
   * mailbox for an ENFORCED SYNC (`sync_requested_at`), so the Sent copy shows in seconds. A
   * doorbell, not state; stamped only on the DEFINITE-sent finalize. IT MAY NEVER WAIT FOR A LOCK
   * — `SKIP LOCKED`: by now THE MESSAGE HAS LEFT, and an UPDATE waiting on the disabler's `FOR
   * UPDATE` stalls the finalize — the reservation stays `in_flight`, the invocation killed
   * mid-transaction (`send-disabled-mailbox.pg.test.ts` timed out). A held row is simply not
   * stamped; the ordinary poll covers that send. INSIDE this transaction: a stamp outliving a
   * rolled-back finalize would reconcile a send that did not happen.
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
      // See the note above: the doorbell is skipped rather than waited on, because waiting
      // strands a message already sent. `SKIP LOCKED` needs the row selected, so the update is
      // driven by a subquery rather than `where id = ...` directly. REVERTED TO THE STATEMENT'S
      // OWN TEXT, measured rather than argued: `inArray(mailboxes.id, d.skipLocked(subquery))`
      // compiles and runs — and against real Postgres it turned twelve of fifteen send-suite
      // cases red where three were red before; whatever drizzle renders for a locked builder
      // embedded as a subquery, it is not this statement. The clause stays INLINE, emitted by the
      // seam: `lockClause` renders exactly this text on the server and nothing on the device
      // store, where one serialized writer means nobody to exclude.
      await tx.update(mailboxes).set({ syncRequestedAt: now }).where(sql`${mailboxes.id} in (
        select ${mailboxes.id} from ${mailboxes} where ${mailboxes.id} = ${mailboxId}
        ${dialect(ctx.db).lockClause({ mode: "update", skipLocked: true })}
      )`);
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "draft", entityId: draftId, op: "update", meta: null,
      });
    });
    return seq === null ? null : Number(seq);
  }

  /**
   * FINALIZE-failed tx: the message definitively did not go out, and the code KNOWS it. `failed`
   * was declared and handled from day one — and NOTHING EVER WROTE IT: a pre-SMTP failure left a
   * `pending` row, finalized `unverified` — "check your Sent folder" for mail that never left.
   * `failed` is terminal for this KEY, does not brick the draft (the client releases the key on
   * any terminal outcome), and returns the draft to `draft`. `sendAt`/`sendKey` are cleared — an
   * appointment outliving a definite non-delivery would be replayed. IT CARRIES THE SENTENCE: on
   * a schedule, `send_error` is the only channel. GATED ON `send_at` STANDING: `send_error` means
   * "the appointment could not be kept".
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

/**
 * THE DRAFT A STILL-OPEN ATTEMPT IS ABOUT, which cannot be absent — and a 500 if it ever is.
 * `draft_id` became nullable `ON DELETE SET NULL` (mail 0095) so a settled send's draft can be
 * discarded while the attempt's record survives. Every caller here is on a `pending` or
 * `unverified` row, and neither can have lost its draft: `DraftsService.sendOnRecord` refuses the
 * discard under a `FOR UPDATE` serialized against the reservation's `FOR KEY SHARE`; the
 * reconcile pass joins `drafts`. A THROW rather than a silent fallback or an `if` nobody can
 * watch fail: null a `pending` row's `draft_id` by hand and the recovery answers 500 instead of
 * finalizing the wrong thing.
 */
/**
 * The draft of a TERMINAL attempt, past the refusal that owns its absent case.
 *
 * Separate from {@link draftOfOpenAttempt} on purpose: there, a missing draft is unreachable and a
 * throw records an invariant. Here it is perfectly reachable — somebody discarded the message —
 * and `resumeExisting` answers it with a named 409 several lines above every call of this. This
 * function therefore narrows a state that has ALREADY been refused, and says which refusal, so
 * that deleting that arm turns this into a 500 rather than a fabricated `draftId`.
 */
function draftOfTerminalAttempt(row: { id: string; draftId: string | null }): string {
  if (row.draftId === null) {
    throw new ServiceError(
      "internal", 500,
      `send reservation ${row.id} has no draft and was not refused as discarded`,
    );
  }
  return row.draftId;
}

function draftOfOpenAttempt(row: { id: string; draftId: string | null }): string {
  if (row.draftId === null) {
    throw new ServiceError(
      "internal", 500,
      `send reservation ${row.id} is still open but names no draft`,
    );
  }
  return row.draftId;
}

export const sendService = new SendService();
