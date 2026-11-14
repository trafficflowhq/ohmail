// `@trafficflow/core/ics` maps to a dependency-free SOURCE module (see its header) — the ONE
// core entry point browser bundles may import. Never the barrel or `./mail` from here: both
// carry mailparser and `node:crypto`, which no consumer of this engine can load.
import { CALENDAR_FALLBACK_FILENAME, isCalendarBodyPart, isCalendarMime } from "@trafficflow/core/ics";
import type { AttachmentWire } from "../adapters/adapter.js";

// ── attachments ────────────────────────────────────────────────────────────
//
// ohmail STORES NO ATTACHMENT BYTES, anywhere, ever. Metadata is synced at ingest; the bytes live
// only in the user's own IMAP mailbox and are pulled from it at the moment somebody asks. What the
// types below model is therefore a CACHE WITH NO BACKING STORE: everything here dies with the tab,
// and that is the feature, not a limitation to be engineered away later.

/**
 * One attachment as a surface renders it. `mimeType` (not the wire's `contentType`) and a non-null `filename` — the
 * shape the strip is built against. {@link toAttachmentItem} is the ONE place the wire becomes this, so the fallback
 * name and the rename cannot drift into two answers. `state` is per ITEM because that is how it behaves: a message's
 * strip is a list where one file is open, one is still arriving and one failed, all at once. `objectUrl` is present
 * only in `ready`, and only until {@link OhmailEngine.releaseAttachments} revokes it.
 */
export interface AttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  state: "idle" | "loading" | "ready" | "failed" | "too_large";
  /**
   * Is this part one the html body REFERENCES (`cid:`) rather than one the sender attached as a
   * file — a signature logo, an embedded screenshot, a newsletter's header image.
   *
   * Carried rather than filtered away: a caller asking "does this message carry an attachment"
   * wants files only (the default), while a reader's strip lists EVERY part — the body may paint
   * an inline picture, but it stays downloadable, and the strip says which rows are the body's
   * own pictures by reading this flag. `includeInlineParts` on
   * {@link OhmailEngine.attachmentsOf} is the widened read.
   */
  inline: boolean;
  /**
   * The part's `Content-ID` (brackets stripped at ingest), or `null` for a part carrying none.
   * It is the join key between the html body's `cid:<contentId>` references and this part —
   * what {@link OhmailEngine.loadInlineImages} matches on to draw an embedded image in place.
   */
  contentId: string | null;
  /**
   * The invitation's own calendar body, not a file: a nameless, un-embedded calendar part, the
   * `text/calendar` alternative beside the text and html bodies (core `isCalendarBodyPart`). Kept
   * in the list, because the event card reads it; a strip leaves it out while a listed calendar file
   * carries its event (`withoutCalendarBodies`), so a Google invitation lists its invite.ics once and
   * an Outlook one, whose alternative is the only copy, keeps it as its one tile. Absent: false.
   */
  calendarBody?: boolean;
  /**
   * A `blob:` URL for the fetched bytes, valid ONLY in the document that minted it.
   *
   * SAFE FOR `<img src>` AND `<a download>`. NOT safe to navigate to top-level: a `blob:` URL
   * inherits the app's origin, so a document type the browser will RENDER (SVG, HTML) executes
   * sender-controlled script as ohmail, with the session cookie in scope. The engine defends this
   * at the point the Blob is built — see {@link RENDERABLE_MIME} — rather than trusting every call
   * site to remember.
   */
  objectUrl?: string;
  /**
   * The fetched bytes, as the type-DOWNGRADED Blob the {@link objectUrl} was minted from. Present exactly when
   * `objectUrl` is, held only in memory, and dropped with the list. A preview surface reads this to parse a PDF or a
   * text part rather than re-fetching the object URL: `fetch(blob:…)` is governed by `connect-src`, and `'self'` does
   * NOT match the `blob:` scheme, so a re-fetch that passes every jsdom test dies on the deployed host. The Blob
   * already pins these bytes for the URL's lifetime, so carrying it costs nothing new. It is the POST-DOWNGRADE blob
   * (see {@link RENDERABLE_MIME}): an `image/svg+xml` part is `application/octet-stream` here, so a consumer that
   * minted its own URL from it could not reopen the document-execution hole the downgrade closes.
   */
  blob?: Blob;
  /**
   * A desktop text preview the shell refused to hand over inline: the file is over its preview cap
   * ({@link StagedPreview}). The file itself is fine — the overlay offers the save instead.
   */
  previewTooLarge?: boolean;
  /**
   * A desktop save of this `ready` part is running ({@link OhmailEngine.deliverAttachment}): `state`
   * and the bytes stay as they are, so a preview showing them stays too; a control may read busy.
   */
  saving?: boolean;
  /** A `failed` embedded picture the engine will ask for again on its own, on a timer now armed. */
  reasking?: true;
  /** The server's own sentence when `state` is `failed` or `too_large`. */
  error?: string;
  /**
   * The refusal's own facts when `state` is `failed`, read as the list's failed arm reads them:
   * `code` (null for a throw nobody classified), `retryable` (whether asking again can help; true
   * for a throw that never established a refusal) and `status` (null without an HTTP answer). A
   * reader picks its sentence through `attachmentFaultClass` and offers Try again on `retryable` only.
   */
  code?: string | null;
  retryable?: boolean;
  status?: number | null;
}

/**
 * The outcome of one message's metadata read. Never rejects, for the reason {@link ServerSearchOutcome} does not: the
 * caller is a React effect. `unavailable` is a first-class answer — the demo and the desktop tier have no server to
 * ask — and `ready` with an EMPTY `items` is a different, also-true answer that the surface must render differently.
 * The second one is COMMON rather than an edge case, and structurally so: a great many messages carry `inline` parts
 * and nothing else — an embedded logo in an HTML mail is one — and {@link OhmailEngine.attachmentsOf} withholds those
 * from a caller that did not ask for them. The paperclip is painted from `hasAttachments`, which COUNTS them. So a
 * paperclip over an empty strip is not a rare inconsistency to be tidied away; it is a state the UI has to be able to
 * say something honest about.
 */
export type AttachmentsOutcome =
  | { state: "unavailable" }
  /**
   * `retrying` is set ONLY when a human pressed the list's own retry over a held `failed`.
   * A surface renders the first ask as nothing — the read is one indexed row and a
   * skeleton on every message open would be noise — but it must NOT go silent again the moment
   * somebody presses "Try again": the row they pressed would vanish for the whole round-trip
   * and come back, which reads as "it worked" followed by "no it didn't". The flag is what lets
   * the failure row stay put and say it is asking again.
   */
  | { state: "loading"; retrying?: boolean }
  | { state: "ready"; items: AttachmentItem[] }
  /**
   * `code` and `retryable` are the SERVER'S own classification, carried through rather than re-derived from the
   * sentence — before that, only `error` survived the catch and the surface could not tell "you are offline" from
   * "that message is not yours". What can actually land here, because copy written for the wrong failure is a lie:
   * this route is `cost: "read"` and opens no IMAP adapter, so the 429 `mailbox_busy` refusal cannot reach it — what
   * does is `code: "network"` (the fetch itself rejected), a 5xx from ohmail's own API, or a definite 4xx (401 after
   * a session ends, 404 for a message this account cannot see). `retryable` is TRUE for anything the client could not
   * classify: an unclassified throw never established that the server refused, and re-asking costs one indexed row.
   */

  /**
   * `code: "timeout"` is the third arrival — a request the server accepted and never answered used to produce no
   * outcome at all; it now arrives bounded and aborted from `HttpAdapter.withDeadline`, retryable for the strongest
   * version of the reason above: nothing refused us, nothing even spoke.
   */
  | { state: "failed"; error: string; code: string | null; retryable: boolean };

/**
 * What the desktop shell answers for a preview it staged on disk ({@link OhmailEngine.stageAttachment}):
 * a URL on its own preview scheme for an image (the bytes never enter this document; `release`
 * removes the staged file), the text itself under the shell's cap, or that the text is over it.
 */
export type StagedPreview =
  | { kind: "url"; url: string; release: () => void }
  | { kind: "text"; text: Blob }
  | { kind: "too_large" };

/**
 * How many staged preview images one window holds at once (at 40 MiB each, 320 MiB on disk). The
 * shell's backstop (`attachment_preview.rs` PREVIEWS_KEPT, 16, and 512 MiB) is larger, so the
 * shell never evicts a URL this window still shows; `desktop-shell.test.ts` holds the pair apart.
 */
export const STAGED_PREVIEWS_KEPT = 8;

/**
 * The MIME types whose bytes may keep their real content type on a client-minted Blob. Everything else is minted
 * `application/octet-stream`, which makes a browser DOWNLOAD it rather than render it. This closes the one hole the
 * server's own defences cannot: `GET /attachments/:id` sets `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff`, but an object URL created here from the response body carries NEITHER — the
 * headers described the response, and the Blob is a new thing with only a type. An `image/svg+xml` attachment opened
 * in a tab would then run its own `<script>` on ohmail's origin. The list is what a strip actually renders inline,
 * and nothing more. SVG is deliberately absent despite being an image: it is a document format that executes script.
 * 18 such attachments exist in the live corpus, so this is a real case and not a hypothetical one.
 */
const RENDERABLE_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
]);

/**
 * Wire → surface, in one place (the mapper the whole strip is rendered from).
 *
 * The filename fallbacks are the SERVER'S own stems for a nameless part (`attachments-service.ts`
 * `uniqueName`): `invite.ics` for a calendar part — the COMMON nameless case, because Google and
 * Outlook nest the invitation as an unnamed `text/calendar` alternative — and
 * `attachment-${id}.bin` for everything else. Matching them deliberately: the name in the strip
 * is then the same name that appears in a download-all zip entry, so a user reading both sees
 * one file, not two.
 */
function toAttachmentItem(wire: AttachmentWire): AttachmentItem {
  return {
    id: wire.id,
    filename:
      wire.filename?.trim() ||
      (isCalendarMime(wire.contentType || "") ? CALENDAR_FALLBACK_FILENAME : `attachment-${wire.id}.bin`),
    mimeType: wire.contentType || "application/octet-stream",
    sizeBytes: wire.sizeBytes,
    state: "idle",
    inline: wire.inline === true,
    contentId: typeof wire.contentId === "string" && wire.contentId !== "" ? wire.contentId : null,
    ...(isCalendarBodyPart({
      filename: wire.filename, contentType: wire.contentType || "", inline: wire.inline === true, contentId: wire.contentId,
    }) ? { calendarBody: true } : {}),
  };
}

/**
 * The MIME types an embedded (`cid:`) image may be drawn from in the mail
 * document, by object URL or `data:` URI — a strict subset of {@link RENDERABLE_MIME}:
 * the four raster types, nothing else. SVG is a document format that
 * executes script; "the sandbox would have caught it" is not a reason to
 * open the first gate. Checked twice per part, deliberately: against the
 * declared type before bytes are paid for, and against the fetched Blob's
 * OWN type before the URI is minted — the declaration is the sender's
 * claim; the post-downgrade Blob type is what a browser will honour.
 */
const INLINE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The per-part ceiling on an automatically fetched embedded image — 4 MiB.
 * Covers both real populations (signature logos and newsletter art at tens
 * to hundreds of KB; pasted screenshots up to a few MB). The cost is not
 * just the fetch: on the phone the image lands in the frame as base64 (+33%),
 * ~5.6 MB at this ceiling. A part over it stays a blanked box — what every message
 * showed before this existed — and remains reachable through the strip's
 * explicit-press fetch, which allows the server's 40 MiB.
 */
export const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The per-message ceilings on the same automatic fetch: at most 12 parts,
 * at most 16 MiB of DECLARED payload, taken in document-reference order so
 * the images a reader sees first win the budget. The trigger is opening a
 * message and each fetch is the most expensive read in the product (one
 * short-lived IMAP connection, {@link OhmailEngine.openAttachment}); a
 * hostile message can reference any number of `cid:` parts, and a bound
 * chosen by the sender is not a bound. Twelve covers every legitimate
 * shape measured while capping what one open can spend.
 */
export const INLINE_IMAGE_MAX_PARTS = 12;
export const INLINE_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** The stable empty answer of {@link OhmailEngine.inlineImagesOf} — one identity, never mutated. */
const NO_INLINE_IMAGES: ReadonlyMap<string, string> = new Map();
/** A pass that re-asks no failed part — every pass but a drain's. */
const NO_RETRY: ReadonlySet<string> = new Set();

/**
 * When an embedded picture the mail server could not serve (busy past the wait, no answer) is due
 * to be asked again: one step per re-ask, within the per-part {@link REASK_MAX}.
 */
export const PART_REASK_DELAYS_MS: readonly number[] = [15_000, 60_000, 240_000];

/**
 * The per-part ceiling on an AUTOMATICALLY fetched calendar part, in bytes — 256 KiB.
 *
 * Real invites are 1–4 KB (the live corpus's 646 calendar parts top out at 4 035 bytes), so this
 * is two orders of magnitude of headroom, and it is an order of magnitude UNDER the inline-image
 * ceiling because the payload is a text file, not a photograph. A part over it is not fetched by
 * the automatic pass and stays an ordinary tile — the reader can still press it.
 */
export const CALENDAR_TEXT_MAX_BYTES = 256 * 1024;

/**
 * At most this many calendar parts fetched automatically per message. Real meeting mail carries
 * exactly one; a hostile message can declare hundreds, and each fetch is an IMAP connection.
 */
export const CALENDAR_TEXT_MAX_PARTS = 3;

/** The stable empty answer of {@link OhmailEngine.calendarTextsOf} — one identity, never mutated. */
const NO_CALENDAR_TEXTS: ReadonlyMap<string, string> = new Map();

/**
 * The parts the automatic calendar pass may consider: every part declared as calendar data,
 * embedded ones too (a calendar part with a Content-ID under multipart/related is stored inline).
 */
function isCalendarItem(item: AttachmentItem): boolean {
  return isCalendarMime(item.mimeType);
}

/**
 * May these fetched bytes be drawn as an embedded image at all, by either carrier? Both refusals
 * are the enforcement (the declared-type pre-filter is the optimisation): `blob.type` must be in
 * {@link INLINE_IMAGE_MIME} — the post-downgrade type, so an SVG arrives as
 * `application/octet-stream` and is never drawn, and nothing sender-controlled is spliced into a
 * scheme; and `blob.size` is the real byte count against {@link INLINE_IMAGE_MAX_BYTES} — the
 * metadata size the pre-filter read is only the sender's claim.
 */
function inlineImageBytesAdmitted(blob: Blob): boolean {
  if (!INLINE_IMAGE_MIME.has(blob.type.toLowerCase())) return false;
  return blob.size > 0 && blob.size <= INLINE_IMAGE_MAX_BYTES;
}

/** The fetched bytes of one embedded image as a `data:` URI (the phone's carrier), or `null`. */
async function mintInlineDataUrl(blob: Blob): Promise<string | null> {
  if (!inlineImageBytesAdmitted(blob)) return null;
  const type = blob.type.toLowerCase();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // String.fromCharCode is applied per-chunk: one call over MBs overflows the arg limit.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * The inverse codec of {@link mintInlineDataUrl}'s encode half, for the sent-copy attachment seed:
 * the compose surface read the picked bytes INTO base64 (`ComposeAttachment.contentBase64`), and
 * the seed reads them back out to hold the same Blob a real fetch would have minted. `atob` for the
 * same reason `btoa` above — present in every browser and in node ≥ 16, so the engine stays free of
 * `Buffer`. `null` for anything undecodable rather than a throw: the caller degrades to a
 * metadata-only item, never to a failed send overlay.
 */
function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export {
  base64ToBytes, INLINE_IMAGE_MIME, inlineImageBytesAdmitted, isCalendarItem, mintInlineDataUrl, NO_CALENDAR_TEXTS,
  NO_INLINE_IMAGES, NO_RETRY, RENDERABLE_MIME, toAttachmentItem,
};
