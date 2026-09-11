import { createHash } from "node:crypto";
import { simpleParser, type AddressObject, type Attachment } from "mailparser";
import { canonicalId } from "./identity.js";
import type { NormalizedMessage, EmailAddress, AttachmentMeta } from "./types.js";

/**
 * What a decoded U+0000 becomes: U+FFFD REPLACEMENT CHARACTER, the code point Unicode
 * reserves for "a character was here and it could not be represented".
 *
 * Not deletion, because a subject of `a<NUL>b` and a subject of `ab` are different messages
 * and the difference is visible in {@link canonicalId}'s body hash. Not rejection of the whole
 * message, because a NUL is not evidence of an attack — mail from a broken client carries them
 * too — and refusing the message means the user never sees mail their mailbox holds.
 */
export const NUL_REPLACEMENT = "�";

const NUL = "\u0000";
const NUL_GLOBAL = /\u0000/g;

/**
 * U+0000 is the one code point Postgres `text` cannot hold; jsonb refuses `\u0000` too. Every
 * string this module returns is attacker-controlled and every one can carry a NUL — verified
 * against mailparser 3.9.14 across subject, display name, bodies, filenames and literal wire
 * bytes. The scrub is applied to ALL of them HERE, at the parse, not at the writes: `canonicalId`
 * hashes `textBody`, and a post-hash scrub means the stored body no longer hashes to the stored
 * dedup key — the same message re-arrives as new on every sync. Only U+0000: unpaired surrogates
 * are replaced by node's own UTF-8 encoder (measured). `includes` before `replace`, so the common
 * path returns the SAME string rather than copying a multi-megabyte body.
 */
function scrubNul(s: string): string {
  return s.includes(NUL) ? s.replace(NUL_GLOBAL, NUL_REPLACEMENT) : s;
}

function toAddr(a: { name?: string; address?: string }): EmailAddress {
  return {
    name: scrubNul(a.name?.trim() ?? "") || null,
    address: scrubNul((a.address ?? "").toLowerCase()),
  };
}

/**
 * Map one mailparser attachment node to persisted metadata. `partId` is not in the @types but
 * mailparser sets it (the MIME part number IMAP fetch needs); read via a narrow cast and scrubbed
 * like the rest — "provably numeric" is a fact about mailparser's internals, not our contract.
 * NEVER carries `content` forward (§13.2/§14). `contentSha256` is computed here because here is
 * the only place it can be: `a.content` is the decoded bytes, already resident, thrown away two
 * lines below — free at this moment, unobtainable later, one reason the ruling prohibits
 * backfilling fingerprints. `sha256` and not the size: two different PDFs of the same length
 * would be one logical message, the second filed as a duplicate and never shown.
 */
function toAttachmentMeta(a: Attachment): AttachmentMeta {
  const contentLen = Buffer.isBuffer(a.content) ? a.content.length : undefined;
  const partId = (a as Attachment & { partId?: string | null }).partId ?? null;
  return {
    filename: scrubNul(a.filename?.trim() ?? "") || null,
    contentType: scrubNul(a.contentType || "application/octet-stream"),
    sizeBytes: contentLen ?? a.size ?? 0,
    partId: partId === null ? null : scrubNul(partId),
    contentId: a.contentId
      ? scrubNul(a.contentId.replace(/[<>]/g, "").trim())
      : a.cid
        ? scrubNul(a.cid)
        : null,
    inline: a.related === true,
    // NULL when mailparser produced no Buffer — a part it could not decode. Never `sha256("")`:
    // "we do not know these bytes" and "these bytes are empty" are different claims, and the
    // fingerprint encoder keeps them apart.
    contentSha256: Buffer.isBuffer(a.content)
      ? createHash("sha256").update(a.content).digest("hex")
      : null,
  };
}

/**
 * What "this message has an attachment" means: a part the user could DOWNLOAD, not "a part
 * exists" — the difference was over 40% of flagged messages: logos, signature images, tracking
 * pixels. `!inline` and not a new predicate: `inline = false` is ALREADY the server's definition
 * of a real file (the `GET /files` and download-all queries select on it). It does NOT mean "no
 * image here": a `cid:` part keeps its reference and row. What sets `inline`: mailparser's
 * `related` — a Content-ID under a `multipart/related` ancestor, NOT the Content-Disposition
 * (Apple Mail ships real PDFs as inline). The `mixed`-nested residual is closed by a second
 * signal: a part the html actually names is promoted; an unreferenced part stays a FILE.
 */
export function isRealFile(a: AttachmentMeta): boolean {
  return !a.inline;
}

/**
 * Does this html body reference the part carrying this `Content-ID`, as a `cid:` URL? A SUBSTRING
 * check, exact and case-sensitive, on purpose: `cid:<contentId>` is the literal token a renderer
 * resolves, so the substring IS the reference. Case-sensitive because RFC 5322 makes `id-left`
 * case-significant and the two error directions are not symmetric: a missed match leaves a logo
 * listed as a file beside a blank box — cosmetic, the long-standing status quo; a false match
 * reclassifies a REAL file as inline, dropping it from the Files list and download-all — data
 * loss. The comparison only ever errs toward the cosmetic direction. `contentId` arrives with its
 * angle brackets already stripped.
 */
export function referencesCid(html: string | null, contentId: string | null): boolean {
  if (!html || !contentId) return false;
  return html.includes(`cid:${contentId}`);
}

/** How many of `attachments` the user could download. See {@link isRealFile}. */
export function countRealFiles(attachments: readonly AttachmentMeta[]): number {
  return attachments.reduce((n, a) => (isRealFile(a) ? n + 1 : n), 0);
}

function addrList(field: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  return objs.flatMap((o) => o.value).map(toAddr);
}

/**
 * The hard per-message byte ceiling, and why it is 64 MiB. Measured: raw 85.3 MB → +298.7 MB of
 * external Buffer memory, ≈3.5x the raw bytes — and the crash-loop that forced this happened just
 * under the worker container's limit. 64 MiB: 2x `DEFAULT_SYNC_BATCH_MAX_BYTES`, so it fires only
 * on a message the batch budget already treats as exceptional; above what mainstream providers
 * accept inbound; parse peak at the ceiling is under a quarter of the container limit. Defence in
 * depth — the raw bytes are already resident when this runs; the pre-fetch RFC822.SIZE ceiling is
 * the primary fix. Part-count and depth guards are absent: measured non-amplifiers, and an
 * unmeasured heuristic's false positive wedges a real mailbox.
 */
export const MAX_RAW_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * The ceiling on the html mailparser will convert to text, in UTF-16 code units. The CPU bound,
 * which the size ceiling cannot see: `htmlToText` is superlinear in nesting depth — measured, a
 * 4.4 MB `<div>` nest cost 98 seconds of the SHARED worker; at 1 MiB the same class is refused in
 * milliseconds. mailparser EMITS an error at the limit and drops the html, so the option alone
 * turns a slow message into a lost one — {@link normalizeMime} treats the rejection as a retry
 * signal and re-parses once with `skipHtmlToText: true`, keeping the html and giving up only the
 * derived text. 1 MiB sits above every html this system has measured. Residual: maximally-nested
 * html just under the limit still costs ~5.5 s. Owed.
 */
export const MAX_HTML_TO_TEXT_CHARS = 1024 * 1024;

/** A message whose raw source exceeds {@link MAX_RAW_MESSAGE_BYTES}. Deterministic per message. */
export class MimeTooLargeError extends Error {
  readonly name = "MimeTooLargeError";
  constructor(
    readonly bytes: number,
    readonly limit: number = MAX_RAW_MESSAGE_BYTES,
  ) {
    super(`raw message is ${bytes} bytes, over the ${limit} byte parse ceiling`);
  }
}

/**
 * Anything mailparser refused. Wrapped, because the caller's job is to CLASSIFY the failure.
 * `normalizeMime`'s contract is a usable {@link NormalizedMessage} or one of this module's two
 * typed errors — never a bare `TypeError`/`RangeError`: the worker cannot tell those from a bug
 * in our own code, and `sync.ts` advances the folder cursor only once a whole batch commits, so
 * an unclassifiable throw is not a lost message, it is a permanently stopped mailbox. Both errors
 * are DETERMINISTIC in the raw bytes — the same source fails the same way every time — which is
 * what makes them safe for a quarantine record to treat as permanent, and the property to
 * preserve if this wrapping is ever widened.
 */
export class MimeParseError extends Error {
  readonly name = "MimeParseError";
  constructor(cause: unknown) {
    super(`mailparser refused the message: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/**
 * The two mailparser errors that mean "the html defeated `htmlToText`", not "the message is
 * unparseable". Matched on message text because mailparser constructs bare `Error`s with no code
 * — `lib/mail-parser.js` emits `HTML too long for parsing N bytes` for the configured limit and
 * `Failed to parse HTML` when `htmlToText` itself throws. If a mailparser upgrade renames these,
 * the fallback stops firing and the messages start rejecting. A test pins both strings by
 * driving real input through the real parser, so that shows up as a red test, not as a
 * production wedge.
 */
function isHtmlToTextRefusal(err: unknown): boolean {
  const m = err instanceof Error ? err.message : "";
  return m.startsWith("HTML too long for parsing") || m === "Failed to parse HTML";
}

const PARSE_OPTIONS = {
  keepCidLinks: true,
  maxHtmlLengthToParse: MAX_HTML_TO_TEXT_CHARS,
} as const;

/**
 * How big `raw` is in BYTES — not `raw.length`, which on a string counts UTF-16 code units, a 2x
 * undercount on emoji and astral text. `Buffer.byteLength` on a Buffer is just `.length`, so one
 * call covers both inputs. The type guard is not defensive noise: this is called from a sync loop
 * that hands over whatever an IMAP server returned, and `Buffer.byteLength(undefined)` throws a
 * bare `TypeError` — the one shape {@link MimeParseError} exists to keep out of the worker's lap.
 */
function rawByteLength(raw: Buffer | string): number {
  if (Buffer.isBuffer(raw)) return raw.length;
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  throw new MimeParseError(
    new TypeError(`normalizeMime needs a Buffer or a string, got ${raw === null ? "null" : typeof raw}`),
  );
}

/**
 * `keepCidLinks: true` is the fix for the storage outage. Do not remove it. With the option
 * absent, `simpleParser` rewrites every `cid:` reference into a `data:` URI holding the whole
 * attachment base64-expanded, pasted into `message_bodies.html` — a half-gigabyte database from
 * one mailbox. A store-no-bytes violation before a sizing problem: inlining stored the very bytes
 * the on-demand design refuses to store. The option makes `simpleParser` return BEFORE the
 * rewrite: the html keeps its `cid:` references, `contentId`/`inline` populated as before. A
 * sender's own `data:` URI is {@link prepareHtmlForStorage}'s job. `raw` is attacker-controlled;
 * this resolves with a usable message or rejects with one of the two typed errors — nothing else.
 */
export async function normalizeMime(raw: Buffer | string): Promise<NormalizedMessage> {
  const bytes = rawByteLength(raw);
  if (bytes > MAX_RAW_MESSAGE_BYTES) throw new MimeTooLargeError(bytes);

  // ── ONE RETRY, ONLY FOR THE HTML-TO-TEXT REFUSAL ──────────────────────────────────────────
  //
  // `maxHtmlLengthToParse` and a `htmlToText` crash are both reported by mailparser as an
  // emitted error, which `simpleParser` turns into a rejection that DISCARDS the whole parse —
  // including the html it had already decoded. Left alone, bounding the CPU would therefore
  // convert a slow message into an unreadable one, so the refusal is caught and the message is
  // re-parsed with the conversion switched off (measured 4 ms; the expensive work is what the
  // limit just refused to do). The user gets the html; only the derived text is given up.
  let parsed: Awaited<ReturnType<typeof simpleParser>>;
  let htmlToTextRefused = false;
  try {
    parsed = await simpleParser(raw, PARSE_OPTIONS);
  } catch (err) {
    if (!isHtmlToTextRefusal(err)) throw new MimeParseError(err);
    htmlToTextRefused = true;
    try {
      parsed = await simpleParser(raw, { ...PARSE_OPTIONS, skipHtmlToText: true });
    } catch (err2) {
      throw new MimeParseError(err2);
    }
  }

  // A lowercased header-name → raw-values map from the raw header lines (parsed.headers folds
  // `List-*` into a structured object, dropping the literal key). `Object.create(null)` is a
  // SECURITY FIX: `__proto__` is a valid extension header name, mailparser preserves it, and on a
  // plain `{}` the lookup finds the inherited prototype, `??=` installs nothing, `.push` throws —
  // and `sync.ts` has no per-message catch, so a five-byte header stops ALL later mail for that
  // mailbox. `Object.hasOwn` belt-and-braces was written, mutation-tested and REMOVED: on a plain
  // `{}` it degrades to silent prototype pollution — the SETTER fires, the header vanishes from
  // what is persisted, attacker values answer unrelated lookups. The null prototype stands alone;
  // a test pins the prototype itself. Scope: it holds for the map this function BUILDS — it does
  // not survive a database round trip; that residue is tracked separately.
  const headers: Record<string, string[]> = Object.create(null);
  for (const { key, line } of parsed.headerLines) {
    // Both halves are scrubbed: a literal 0x00 on the wire survives into `headerLines[].line`
    // (measured), and this map becomes `message_bodies.headers` — jsonb, which refuses U+0000
    // in a KEY as firmly as in a value.
    const name = scrubNul(key.toLowerCase());
    const colon = line.indexOf(":");
    const value = scrubNul(colon >= 0 ? line.slice(colon + 1).trim() : line.trim());
    (headers[name] ??= []).push(value);
  }

  // `text` is scrubbed HERE, on the way in, and nowhere later — see {@link scrubNul}. Every
  // derivation below reads this binding: the canonical body hash, the stored body, and (through
  // `pipeline.ts`) the snippet and the search vector. One representation, so they cannot disagree.
  const text = scrubNul(parsed.text ?? "");
  const html = typeof parsed.html === "string" ? scrubNul(parsed.html) : null;
  const fromObj = parsed.from?.value?.[0];
  const attachments = (parsed.attachments ?? []).map(toAttachmentMeta);

  // A part the html paints is inline, wherever it sits in the MIME tree. mailparser's `related`
  // only marks a cid part under `multipart/related`; a signature logo nested under
  // `multipart/mixed` arrived `inline: false` and was listed as a downloadable file beside a body
  // that draws the same picture. The body's own `cid:` reference is the second signal ({@link
  // referencesCid}), and it runs HERE because this is the one moment both sides are in hand: the
  // decoded, scrubbed html — the exact string the renderer resolves against — and the parts.
  // Promotion only: a `related` part never loses its flag for going unreferenced, because
  // `related` is already the tree saying "embedded", and demoting on a failed text scan would
  // move real newsletters' logos into the Files list on a formatting quirk.
  for (const a of attachments) {
    if (!a.inline && referencesCid(html, a.contentId)) a.inline = true;
  }

  // What the fallback parse hashes, and why it is not `text`: `skipHtmlToText` leaves
  // `parsed.text` empty, so on that path `canonicalId` would hash "" for EVERY such message — and
  // `dedupKey` falls back to `body:<hash>` when a message carries no Message-ID, so a shared hash
  // means the second such message is filed as a duplicate of the first: real mail silently
  // dropped, worse than the CPU burn the limit stops. So this path hashes the html, which is real
  // content and stable — the same raw bytes always take the same branch, so a message dedups
  // against itself on every later sync. `textBody` stays honestly empty rather than being filled
  // with an invented rendition: a second text extraction would show up in the snippet and the
  // search vector, and belongs in a change that can measure it.
  const bodyForCanonical = htmlToTextRefused ? (html ?? text) : text;
  return {
    canonical: canonicalId(parsed.messageId ? scrubNul(parsed.messageId) : null, bodyForCanonical),
    subject: scrubNul(parsed.subject ?? ""),
    from: fromObj ? toAddr(fromObj) : { name: null, address: "" },
    to: addrList(parsed.to),
    // `Cc:` is parsed for {@link messageFingerprint} and read by nothing else. It is a field the
    // sender chooses, so leaving it out of the logical identity would be the UNSAFE direction: two
    // messages differing only in Cc would be one row and the second would never be shown.
    cc: addrList(parsed.cc),
    date: parsed.date ?? null,
    headers,
    textBody: text,
    htmlBody: html,
    // NOT `attachments.length > 0` — see {@link isRealFile} for what that over-reports.
    hasAttachments: attachments.some(isRealFile),
    attachments,
  };
}

/**
 * The three address headers as {@link normalizeMime} stored them — the values, not the names.
 * Each is the array `message_bodies.headers` holds under that key: one entry per header LINE, so
 * a message with two `To:` lines has two, and the parse below reproduces both.
 */
export interface StoredAddressHeaders {
  from?: readonly string[] | null | undefined;
  to?: readonly string[] | null | undefined;
  cc?: readonly string[] | null | undefined;
}

/** What {@link parseStoredAddressHeaders} recovers. `from` is null ⇔ no From address was found. */
export interface ParsedAddressHeaders {
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
}

/**
 * Re-reading who a stored message is from and to, from its stored headers — the address columns
 * were added after the rows that need them, and every row still holds the raw header line. The
 * INGEST parse, not a second one: a backfill disagreeing with ingest leaves two populations whose
 * names came from different rules — so this shares every deciding piece (`simpleParser` under the
 * same options, the same `toAddr`/`addrList`), pinned by a round-trip test. `from` is `null`
 * where ingest yields the anonymous sentinel. Values are re-folded before going back in: a stored
 * value can carry a raw newline, and written back verbatim it would start a NEW header —
 * injection into our own re-parse. Decoded, never raw: an encoded-word must not reach the column.
 */
export async function parseStoredAddressHeaders(
  stored: StoredAddressHeaders,
): Promise<ParsedAddressHeaders> {
  const lines: string[] = [];
  const emit = (name: string, values: readonly string[] | null | undefined) => {
    for (const v of values ?? []) {
      if (typeof v !== "string") continue;
      lines.push(`${name}: ${v.replace(UNFOLDED_NEWLINE, "\r\n ")}`);
    }
  };
  emit("From", stored.from);
  emit("To", stored.to);
  emit("Cc", stored.cc);
  // No headers at all still parses — mailparser answers an empty message and every field is
  // absent, which is the honest result for a row whose body row holds no address header.
  if (lines.length === 0) return { from: null, to: [], cc: [] };

  let parsed: Awaited<ReturnType<typeof simpleParser>>;
  try {
    // A header-only message: the blank line closes the block and there is no body to decode, so
    // none of the html/attachment machinery `normalizeMime` guards against can run at all.
    parsed = await simpleParser(`${lines.join("\r\n")}\r\n\r\n`, PARSE_OPTIONS);
  } catch (err) {
    throw new MimeParseError(err);
  }
  const fromObj = parsed.from?.value?.[0];
  return {
    from: fromObj ? toAddr(fromObj) : null,
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
  };
}

/** A newline that is NOT a fold — see {@link parseStoredAddressHeaders}. */
const UNFOLDED_NEWLINE = /\r?\n(?![ \t])/g;
