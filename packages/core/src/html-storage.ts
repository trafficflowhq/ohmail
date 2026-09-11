/**
 * Bounding what `message_bodies.html` may cost, shaped by the outage that forced it: one mailbox
 * filled a half-gigabyte database — `html` was most of the table, barely compressing, and under
 * one percent of rows held roughly half the database: a tail from mailparser base64-inlining
 * image attachments. `mime.ts` now passes `keepCidLinks: true`; this is the second line: a sender
 * can author a `data:` URI themselves. STRIP FIRST, TRUNCATE SECOND — truncate-first would cost
 * every word after a first-paragraph image. Post-strip p99 is ~100 KB, so 256 KiB is a tripwire;
 * the 512-char floor keeps small icons. The `message_bodies_html_cap` CHECK is pinned by a test;
 * if it fires, `sync.ts` quarantines that mailbox — the intended failure.
 */

/**
 * The hard ceiling on a stored html body, in BYTES — the same literal the
 * `message_bodies_html_cap` CHECK constraint asserts. 256 KiB.
 *
 * Bytes and not characters, because that is what storage costs and what `octet_length()`
 * measures. A char-based cap is a 4x lie on a body of astral-plane text.
 */
export const STORED_HTML_CAP_BYTES = 262_144;

/**
 * The shortest base64 `data:` payload worth stripping, in characters.
 *
 * Below this a `data:` URI is an icon or a spacer, not the reason a database filled up. See the
 * module header: the target is bloat, and a threshold is what keeps this from mangling small
 * legitimate inline art.
 */
export const STRIP_DATA_URI_MIN_CHARS = 512;

/**
 * What a stripped inline payload is replaced by. A `cid:` reference rather than an empty `src` or
 * a removed tag, because `cid:` is the shape the rest of the system understands — the tracker
 * blocker leaves `cid:` alone (embedded, cannot phone home), and the `attachments` row still
 * carries `contentId` and `inline` for a client to resolve. Deliberately a DISTINCT, greppable
 * marker rather than a plausible-looking cid: the original is unrecoverable once mailparser has
 * overwritten it, and inventing one by correlating against `attachments.content_id` is the guess
 * the ambiguous-data rule forbids. A stripped row is found with `WHERE html LIKE
 * '%ohmail-stripped%'`; the honest repair is a re-fetch from IMAP — the mailbox is the master.
 */
export const STRIPPED_DATA_URI = "cid:ohmail-stripped";

/** Appended to a body that hit {@link STORED_HTML_CAP_BYTES}, so the truncation is not silent. */
export const HTML_TRUNCATION_MARKER =
  "\n<!-- ohmail: body truncated at the storage cap; the full message is in your mailbox -->";

/**
 * Any base64 `data:` URI. The SIZE test is applied in the replacer, not here. The payload class
 * has NO whitespace: base64 from `Buffer.toString` contains none, and admitting `\s` over-eats in
 * an unquoted `src=` context. Why `+` and a replacer, not `{512,}`: the regex engine compiles a
 * min-count quantifier recursively — measured, RangeError at 19,000,000 payload characters — and
 * a body with inlined attachments reaches tens of megabytes; the throw would propagate out of
 * `normalizeMime` into a sync cycle with no per-message catch and quarantine the mailbox. A plain
 * `+` compiles as a loop (~11 ms); the minimum is enforced on the matched string, where it costs
 * nothing.
 */
const DATA_URI = /data:[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** The literal that separates a `data:` URI's declared type from its payload. */
const BASE64_SEP = ";base64,";

/**
 * Replace every OVERSIZED base64 `data:` payload with {@link STRIPPED_DATA_URI}, leaving small
 * ones (icons, spacers) exactly as they were.
 *
 * Idempotent: the replacement contains no `data:…;base64,` sequence, so running it twice is the
 * same as running it once.
 */
export function stripInlineDataUris(html: string): string {
  return html.replace(DATA_URI, (match) => {
    const payloadStart = match.indexOf(BASE64_SEP) + BASE64_SEP.length;
    return match.length - payloadStart >= STRIP_DATA_URI_MIN_CHARS ? STRIPPED_DATA_URI : match;
  });
}

/**
 * Cut `s` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, which is neither characters nor bytes; a
 * 60,000-"character" slice of CJK or emoji is up to 240,000 bytes. So the cut is made on the
 * byte buffer and then walked BACK over any UTF-8 continuation bytes (`10xxxxxx`) so the last
 * character is either wholly kept or wholly dropped — never half-decoded into U+FFFD.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * The only thing that should ever be written to `message_bodies.html`. Strips oversized inline
 * base64 payloads, then — if what remains is still over the cap — truncates on a character
 * boundary and appends {@link HTML_TRUNCATION_MARKER}. `null` in, `null` out: a body with no
 * html, and a sensitive message whose html is deliberately never stored, both pass unchanged. The
 * result is guaranteed to satisfy `octet_length(html) <= STORED_HTML_CAP_BYTES`, exactly what the
 * `message_bodies_html_cap` CHECK asserts.
 */
export function prepareHtmlForStorage(html: string | null): string | null {
  if (html === null) return null;
  const stripped = stripInlineDataUris(html);
  if (Buffer.byteLength(stripped, "utf8") <= STORED_HTML_CAP_BYTES) return stripped;
  const budget = STORED_HTML_CAP_BYTES - Buffer.byteLength(HTML_TRUNCATION_MARKER, "utf8");
  return truncateToBytes(stripped, budget) + HTML_TRUNCATION_MARKER;
}
