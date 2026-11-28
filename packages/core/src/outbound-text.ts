/**
 * Plain text → the two halves of one outbound message. A drafter answers with prose; the send
 * path puts `body` and `html` on the wire as `multipart/alternative` when the second is present —
 * until this module, a generated draft never wrote it, so a model-written reply went out
 * `text/plain`. The SERVER promotes, not the model: two independent answers could disagree. The
 * grammar is the smallest that survives the round trip — `<p>` and `<br />`; `&`, `<`,
 * `>` escaped — inside the outbound sanitizer's allow-list, asserted as a fixed point. Both
 * halves return together: the text half is the NORMALIZED source, what every renderer of the html
 * shows. In `core` because both generated-draft writers live in different packages.
 */

/** Paragraph presentation shared by the draft serializer and phone editor. */
export const AUTHORED_PARAGRAPH_STYLE = "margin:0";

/** Inline code-block presentation shared by the draft serializer and editor. */
export const AUTHORED_CODE_STYLE =
  "font-family:monospace;font-size:0.9em;color:#12100e;background-color:#f0ebe3;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;padding:8px 12px";

/** A draft-only editor boundary for a quote the sender changed. */
export const QUOTED_HISTORY_ATTRIBUTE = "data-quoted-history";

export const hasEditedQuotedHistory = (html: unknown): boolean =>
  typeof html === "string" && html.includes(`<blockquote ${QUOTED_HISTORY_ATTRIBUTE}="edited">`);

type DraftForwardSource = { id: string; filename: string; sender: string; subject: string; sha256?: string };

/** Object key order is not stable across databases. The attachment order is. */
export function draftForwardSourceTuples(sources: readonly DraftForwardSource[]): string[][] {
  return sources.map(({ id, filename, sender, subject, sha256 }) => [id, filename, sender, subject, sha256 ?? ""]);
}

/** The authored fields covered by a draft revision, in their stable order. */
export function draftRevisionInput(row: {
  mailboxId: string;
  inReplyToMessageId: string | null;
  forwardOfMessageId?: string | null;
  forwardParts?: readonly string[] | null;
  forwardSources?: readonly DraftForwardSource[] | null;
  subject: string;
  body: string;
  html: string | null;
  to: unknown;
  cc: unknown;
  bcc: unknown;
}): string {
  // Tuples preserve the digest even when a database changes the key order of stored addresses.
  const addrs = (xs: unknown): Array<[string, string | null]> =>
    (Array.isArray(xs) ? (xs as Array<{ address?: string; name?: string | null }>) : [])
      .map((a) => [a?.address ?? "", a?.name ?? null]);
  return JSON.stringify([
    row.mailboxId, row.inReplyToMessageId ?? null, row.subject, row.body, row.html ?? null,
    addrs(row.to), addrs(row.cc), addrs(row.bcc),
    // Omitting fields when unset preserves the revision of drafts with no forward.
    ...(row.forwardOfMessageId ? [["forwardOf", row.forwardOfMessageId]] : []),
    ...(row.forwardOfMessageId && row.forwardParts ? [["forwardParts", [...new Set(row.forwardParts)].sort()]] : []),
    ...(row.forwardSources?.length ? [["forwardSources", draftForwardSourceTuples(row.forwardSources)]] : []),
  ]);
}

/** The two halves of one message, derived together and never separately. */
export interface PromotedBody {
  /** The markup half. `""` when the source has no words in it — then there is nothing to promote. */
  html: string;
  /** The text/plain half: the normalized source the markup above was built from. */
  text: string;
}

/**
 * The three characters that are markup rather than punctuation.
 *
 * `"` and `'` are deliberately absent: nothing here emits an attribute, so a quote in a
 * sentence is a quote in a sentence. It is also what the sanitizer's own text escaper does, and
 * the two must agree or the fixed-point property below fails on ordinary prose.
 */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Promote a plain-text body to `{html, text}`.
 *
 * Empty in, empty out — a whitespace-only body promotes to `{html: "", text: ""}` rather than to
 * an empty paragraph, so a caller can tell an absent body from a blank one and store no html at
 * all. (Said without quoted phrases on purpose: this leaf is admitted into the client bundle only
 * while it imports nothing, and the guard that proves that reads text, not syntax.)
 */
export function plainTextToOutboundBody(source: string): PromotedBody {
  // Line endings first. A model answer is not guaranteed to use `\n`, and a stray `\r` left in
  // the text half would be a byte the html half cannot possibly carry.
  const normalized = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // `\s+`, not `[ \t]+`: a renderer collapses every kind of whitespace, non-breaking spaces
    // and form feeds included, and the text half has to say what the markup will show.
    .map((line) => line.replace(/\s+/g, " ").trim());

  // Blank runs collapse to ONE blank line and both ends lose theirs — again because that is
  // what the markup renders as, and a text half holding six trailing blank lines reads as a
  // mistake somebody made rather than as spacing somebody chose.
  const lines: string[] = [];
  for (const line of normalized) {
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { html: "", text: "" };

  // One hard break per newline matches the editor's line model. Two breaks draw a blank
  // line in both the composer and the delivered HTML, even with zero paragraph margins.
  const html = `<p>${lines.map(escapeText).join("<br />")}</p>`;
  return { html, text: lines.join("\n") };
}

/**
 * Older generated drafts stored blank lines as empty paragraphs. Repair only when every
 * paragraph and break matches the old encoding of the saved text. Request drafts carried
 * zero-margin paragraphs, while workflow drafts used bare paragraphs.
 */
export function repairLegacyDraftHtml(html: string, text: string): string {
  if (!text.includes("\n\n") || !html.startsWith("<p")) return html;

  const styled = `<p style="${AUTHORED_PARAGRAPH_STYLE}">`;
  const paragraph = html.startsWith(styled) ? styled : "<p>";
  const legacy = escapeText(text).split("\n\n")
    .map((part) => `${paragraph}${part.replaceAll("\n", "<br />")}</p>`)
    .join(`${paragraph}</p>`);
  if (html !== legacy) return html;

  const promoted = plainTextToOutboundBody(text);
  return promoted.text === text ? promoted.html.replace("<p>", paragraph) : html;
}

/**
 * Ceiling on one stored or sent PLAIN body, in bytes. 262144 = 256 KiB — `drafts.html`'s own
 * number (`0037_draft_html.sql`), for that migration's stated reason: two ceilings that differ are
 * a second number to keep true. A rich draft's `body` is DERIVED from html already held to it, so
 * plain-only was the one arm bounded by nothing but the 4 MiB request door.
 *
 * A tripwire, not a working part: 256 KiB of plain text is a quarter of a million characters, far
 * past anything a person types into a compose form.
 */
export const DRAFT_BODY_MAX_BYTES = 262144;

/**
 * UTF-8 length, counted the way Postgres `octet_length` counts it, without allocating.
 *
 * Not `TextEncoder`/`Buffer`: this runs in the compose editor's change handler, and encoding a
 * quarter-megabyte body on every keystroke is a quarter-megabyte of garbage per keystroke. A lone
 * surrogate encodes as U+FFFD, which is three bytes — the same answer both standard encoders give.
 * A test beside this file reconciles the count against `Buffer.byteLength`.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Is this body past {@link DRAFT_BODY_MAX_BYTES}? The fast paths are what let it be asked per
 * keystroke: one UTF-16 unit weighs one to three UTF-8 bytes, so only the band between those
 * bounds is walked.
 *
 * The whole client rule, and the repair path falls out of it: an oversized draft still opens and
 * still takes edits — only the SAVE is refused — so cutting it down brings it back under.
 */
export function draftBodyOverCeiling(text: string): boolean {
  if (text.length > DRAFT_BODY_MAX_BYTES) return true;
  if (text.length * 3 <= DRAFT_BODY_MAX_BYTES) return false;
  return utf8ByteLength(text) > DRAFT_BODY_MAX_BYTES;
}

/**
 * Is this DRAFT past the ceiling — whichever half of it will be stored?
 *
 * The effective body is the larger of the two halves, which is how the request door is priced
 * (`input-bounds-census.test.ts` takes the MAXIMUM of the two caps, never their sum: a request
 * carrying `body` alongside `html` is a 400). One predicate and one number, so the composer's
 * sentence cannot be true of one half and false of the other. The markup is measured as the editor
 * holds it; the server measures what it stores, and its 413 stays the authority for anything the
 * sanitizer grows.
 */
export function draftOverCeiling(body: string, html?: string | null): boolean {
  return draftBodyOverCeiling(body) || (html != null && draftBodyOverCeiling(html));
}
