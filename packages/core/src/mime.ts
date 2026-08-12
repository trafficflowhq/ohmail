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
 * ── U+0000 IS THE ONE CODE POINT POSTGRES `text` CANNOT HOLD ─────────────────────────────────
 *
 * PostgreSQL stores `text`/`varchar` as UTF-8 with no length prefix, so the zero byte is the one
 * value it must reserve; a parameter containing it is refused, and jsonb refuses `\u0000` inside
 * a string as well. There is no encoding, column type, or driver setting that admits it.
 *
 * Every string this module returns is attacker-controlled and every one of them can carry a NUL.
 * Verified against the installed mailparser 3.9.14 — all of these came back with the NUL intact:
 *
 *   · `subject` from the encoded word `=?utf-8?B?YQBi?=`   (base64 of `a<NUL>b`)
 *   · `from.value[0].name` from the same encoded word in a display name
 *   · `text` and `html` from a base64-encoded body part
 *   · the html→text conversion of that body
 *   · `attachments[].filename` from an encoded word in `Content-Disposition`
 *   · `subject`, `headerLines[].line` and `text` from a LITERAL 0x00 byte on the wire
 *
 * So the scrub is applied to ALL of them, HERE, at the parse — not at the writes. Late
 * normalisation is its own bug: {@link canonicalId} hashes `textBody` to derive the dedup key,
 * `pipeline.ts` slices the snippet out of the same string, and `prepareHtmlForStorage` truncates
 * the html. Scrub after any of those and the stored body no longer hashes to the stored dedup
 * key — the same message re-arrives as a new one on every sync (a convergence break),
 * which is worse than the INSERT failure this prevents.
 *
 * Only U+0000. Unpaired surrogates are the other class Postgres cannot encode, and they need no
 * handling here: node's own UTF-8 encoder replaces them on the way out —
 * `Buffer.from("a\uD800b", "utf8")` is measured as `61 ef bf bd 62` — so the driver cannot emit
 * an invalid sequence. `Buffer.from("a\u0000b", "utf8")` is `61 00 62`; the NUL goes to the wire.
 *
 * `includes` before `replace` so the overwhelmingly common path returns the SAME string rather
 * than allocating a copy of a multi-megabyte html body.
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
 * Map one mailparser attachment node to our persisted metadata. `partId` is not in
 * the @types but mailparser sets it on the node (the MIME body-part number IMAP
 * fetch needs); we read it via a narrow cast. `sizeBytes` prefers the decoded
 * content length, falling back to the declared size. NEVER carries `content`
 * (the bytes) forward — only metadata is stored (§13.2/§14).
 *
 * All four strings go through {@link scrubNul}, `partId` included. That one is provably numeric
 * today — mailparser builds it from boundary counters — but "provably numeric" is a fact about
 * mailparser's internals, not a term of our contract, and a trust boundary that scrubs three of
 * four fields is a boundary someone has to re-audit. `sizeBytes` and `inline` are not strings.
 *
 * ── `contentSha256` IS COMPUTED HERE BECAUSE HERE IS THE ONLY PLACE IT CAN BE ─────────────────
 *
 * `a.content` is the DECODED bytes, already resident: `simpleParser` accumulates every attachment
 * chunk and `Buffer.concat`s it, which is the 3.5× memory cost {@link MAX_RAW_MESSAGE_BYTES}
 * exists to bound. Two lines below, that Buffer's `.length` is read and the bytes are thrown
 * away, because §13.2/§14 forbid persisting them. So the digest is free at this exact moment and
 * unobtainable at any later one — a batch job over the `attachments` table has no content column
 * to hash, which is one of the four reasons the ruling prohibits backfilling fingerprints.
 *
 * `sha256` and not the size: `sizeBytes` was already in play and it is trivially collidable —
 * two different PDFs of the same length, same name, same type are one logical message under a
 * size-only tuple, and the second is filed as a duplicate and never shown.
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
 * ── WHAT "THIS MESSAGE HAS AN ATTACHMENT" HAS TO MEAN, AND WHY IT IS `!inline` ───────────────
 *
 * A part the user could DOWNLOAD — not "a part exists". The two are different claims, and on a
 * large mailbox the difference was over 40% of the messages a naive check would flag: many
 * carried a part with `inline = false` (a real file), while the rest were **newsletter logos,
 * signature images and tracking pixels** — mail with nothing whatsoever to download.
 *
 * `!inline` and not a new predicate of this function's own, because `inline = false` is ALREADY
 * the server's definition of a real file: `attachments-service.ts:322` (`GET /files`) and `:359`
 * and `:370` (download-all) all select `eq(attachments.inline, false)`. Deriving the flag from
 * anything else would put a second definition of "file" in the codebase and guarantee that the
 * badge and the download eventually disagree again — which is precisely the defect. This is the
 * one predicate, exported, and both writers of the pair go through it.
 *
 * ── AND WHAT IT DOES NOT MEAN: "THERE IS NO IMAGE HERE" ──────────────────────────────────────
 *
 * A `cid:` part is not nothing. `keepCidLinks` keeps its reference in the html and its row keeps
 * `content_id` precisely so a client can resolve it through `GET /attachments/:id` (see
 * {@link normalizeMime}'s header, and a test pins that behaviour). The mail renderer resolves
 * those references from the part's own bytes and draws them in place. So this flag going false
 * for a newsletter is the CORRECT answer to "is there a file to download" and says nothing at
 * all about whether the message has pictures in it.
 *
 * ── WHAT SETS `inline`, STATED HERE BECAUSE IT IS NOT WHAT MOST READERS ASSUME ────────────────
 *
 * `toAttachmentMeta` maps it from mailparser's `related`, and mailparser 3.9.14
 * (`lib/mail-parser.js:903-913`) sets that iff the part carries a **Content-ID header** AND some
 * ancestor node is **`multipart/related`**. It is NOT the Content-Disposition, and it is NOT a
 * scan of the html for a matching `cid:`.
 *
 * Ignoring the disposition is deliberate and is the RIGHT rule: an embedded image referenced by
 * the body is embedded even when it declares `Content-Disposition: attachment`, and mailparser
 * does surface `contentDisposition` for anyone tempted to reach for it.
 *
 * The `related` signal alone had a residual: a cid part under `multipart/mixed` rather than
 * `multipart/related` was NOT marked inline, so a signature logo from a sender who nests it
 * that way still counted as a file. {@link normalizeMime} closes it with a second signal —
 * a part whose `Content-ID` the html body actually names in a `cid:` reference is promoted to
 * inline (see {@link referencesCid}) — which is the same principle as ignoring the disposition,
 * read off the body instead of the tree: WHAT THE HTML PAINTS IS EMBEDDED, wherever it sits.
 *
 * What deliberately stays a FILE: a part carrying a `Content-ID` that nothing references. An
 * unreferenced part is painted by no rendering, so classifying it inline would leave it
 * reachable from nowhere — a photo a sender attached with a gratuitous Content-ID would simply
 * vanish from the product. Unreferenced and standalone means downloadable, whatever its headers
 * hint. And a `Content-Disposition: inline` on its own reclassifies NOTHING, in either
 * direction: Apple Mail ships real PDFs as `inline; filename=…`, so a disposition-based rule
 * hides exactly the files people mean to send.
 */
export function isRealFile(a: AttachmentMeta): boolean {
  return !a.inline;
}

/**
 * Does this html body reference the part carrying this `Content-ID`, as a `cid:` URL?
 *
 * A SUBSTRING check, exact and case-sensitive, on purpose:
 *
 *   · `cid:<contentId>` is the literal token a renderer resolves — `src="cid:logo@corp"`,
 *     `url(cid:logo@corp)` — so the substring IS the reference, not a heuristic for one.
 *   · Case-sensitive because RFC 5322 makes a msg-id's `id-left` case-significant, and the two
 *     error directions are not symmetric. A missed match leaves a logo listed as a file beside
 *     a blank box — the long-standing status quo, cosmetic. A false match reclassifies a REAL
 *     file as inline, which drops it from the Files list and download-all: data loss. So the
 *     comparison only ever errs toward the cosmetic direction.
 *
 * `contentId` arrives with its angle brackets already stripped ({@link toAttachmentMeta}).
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
 * ── THE HARD PER-MESSAGE BYTE CEILING, AND WHY IT IS 64 MiB ──────────────────────────────────
 *
 * Measured here against mailparser 3.9.14, one message with one base64 attachment:
 *
 *   raw 85.3 MB  →  521 ms, +298.7 MB of EXTERNAL (Buffer) memory, +170.8 MB RSS
 *
 * ≈3.5× the raw bytes, because `simpleParser` accumulates every decoded attachment chunk and
 * then `Buffer.concat`s it into `attachment.content` — which {@link toAttachmentMeta} reads a
 * length off and throws away. The worker container's limit is 1 000 000 000 B and the crash-loop
 * that forced this ceiling happened just under it, so ~3.5× is the number that matters.
 *
 * 64 MiB, for three reasons that each stand alone:
 *
 *   · It is 2× {@link DEFAULT_SYNC_BATCH_MAX_BYTES} (32 MiB). Nothing this large reaches us
 *     except through the adapter's documented anti-stall rule — "the first message is always
 *     admitted, however large" — so the ceiling can only ever fire on a message the batch
 *     budget already treats as exceptional.
 *   · It is above what mainstream providers accept inbound (Gmail ~50 MB, Exchange Online 36 MB
 *     by default, iCloud/Yahoo ≤ 25 MB attachments ⇒ ~34 MB on the wire once base64'd), so it
 *     does not refuse mail a user's own mailbox would hold.
 *   · At the ceiling the measured parse peak is ≈235 MB, under a quarter of the container limit.
 *
 * Above it, the alternative to refusing ONE message is risking a SIGKILL of the shared worker,
 * which stops every mailbox rather than one. That is the trade, stated so it can be argued with.
 *
 * What this is NOT: it is defence in depth, not the primary fix. The raw bytes are already
 * resident by the time this runs — `ImapAdapter.fetchCapped` pulled `source: true` before
 * `normalizeMime` was called. The primary fix is an RFC822.SIZE ceiling BEFORE that fetch, in
 * `packages/core/src/adapters/imap.ts`, and it is owed.
 *
 * Two amplifiers this ceiling is deliberately NOT aimed at, because measurement said they are
 * not amplifiers: 200 000 flat MIME parts (11.1 MB raw) parse in 108 ms for +38.5 MB RSS, and
 * 5 000 levels of multipart nesting parse without a stack overflow. A part-count or depth guard
 * would be an unmeasured heuristic whose false positive wedges a real mailbox — see
 * {@link MimeTooLargeError} on why any rejection is currently expensive.
 */
export const MAX_RAW_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * The ceiling on the html mailparser will convert to text, in UTF-16 CODE UNITS — mailparser
 * compares `node.textContent.length`, so code units is what the option means, and CPU tracks
 * code units more closely than bytes anyway.
 *
 * ── THIS IS THE CPU BOUND, AND THE SIZE CEILING DOES NOTHING FOR IT ──────────────────────────
 *
 * `htmlToText` is superlinear in nesting depth. Measured, html-only messages of `<div>` nests:
 *
 *   depth   1 000  ·  11 KB html  →  resolves, 17 ms
 *   depth  20 000  · 220 KB html  →  `Error: Failed to parse HTML`, 365 ms
 *   depth 100 000  · 1.1 MB html  →  `Error: Failed to parse HTML`, 6 179 ms
 *   depth 400 000  · 4.4 MB html  →  `Error: Failed to parse HTML`, 98 514 ms
 *
 * 4.4 MB of attacker bytes for 98 seconds of the SHARED worker, and every one of those is far
 * under {@link MAX_RAW_MESSAGE_BYTES} — a byte ceiling cannot see this attack. With the option
 * set to 1 MiB the same 1.1 MB message is refused in 4 ms instead of 6 179: a 1 500× reduction.
 *
 * Note what mailparser does when the limit is hit, because it decides the design: it EMITS an
 * error, which `simpleParser` turns into a rejected promise, and it drops the html. So the
 * option alone converts a slow message into a lost one. {@link normalizeMime} therefore treats
 * that rejection as a retry signal and re-parses once with `skipHtmlToText: true` (measured
 * 4 ms), which keeps the html and gives up only the derived text.
 *
 * 1 MiB and not less: production's largest html body after `data:` stripping was 441 692 bytes
 * (`html-storage.ts`), so 1 MiB sits above every html this system has ever measured and no real
 * message loses its text rendition. A normal — unnested — 1 MB html body converts in 32 ms.
 *
 * The residual, stated plainly: maximally-nested html just UNDER the limit still costs ~5.5 s.
 * Bounding that needs a depth or wall-clock budget, and mailparser exposes neither. Owed.
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
 *
 * `normalizeMime`'s contract is: a usable {@link NormalizedMessage}, or one of this module's two
 * typed errors. Never a bare `TypeError`/`RangeError`/`Error("Failed to parse HTML")` — the
 * worker cannot tell those apart from a bug in our own code, and `apps/worker/src/sync.ts`
 * advances the folder cursor only once a whole batch commits, so an unclassifiable throw is not
 * a lost message, it is a permanently stopped mailbox.
 *
 * Both of these errors are DETERMINISTIC in the raw bytes: the same source fails the same way
 * every time. That is what makes them safe for a quarantine record to treat as permanent, and it
 * is the property to preserve if this wrapping is ever widened.
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
 * How big `raw` is in BYTES.
 *
 * Bytes and not `raw.length`, which on a string counts UTF-16 code units — a 2× undercount on
 * emoji and astral text, the same "a char-based cap is a 4x lie" mistake `html-storage.ts`
 * documents. `Buffer.byteLength` on a Buffer is just `.length`, so one call covers both inputs.
 *
 * The type guard is not defensive noise: the signature says `Buffer | string`, but this is called
 * from a sync loop that hands over whatever an IMAP server returned (`m.source`), and
 * `Buffer.byteLength(undefined)` throws a bare `TypeError` — the one shape
 * {@link MimeParseError} exists to keep out of the worker's lap.
 */
function rawByteLength(raw: Buffer | string): number {
  if (Buffer.isBuffer(raw)) return raw.length;
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  throw new MimeParseError(
    new TypeError(`normalizeMime needs a Buffer or a string, got ${raw === null ? "null" : typeof raw}`),
  );
}

/**
 * ── `keepCidLinks: true` IS THE FIX FOR THE STORAGE OUTAGE. DO NOT REMOVE IT. ──
 *
 * With this option absent (the default), `simpleParser` calls `updateImageLinks` and rewrites
 * every `cid:` reference in the html into `'data:' + contentType + ';base64,' +
 * content.toString('base64')` — mailparser 3.9.14, `lib/simple-parser.js:95-98`. That is the
 * WHOLE ATTACHMENT, base64-expanded by 33%, pasted into `message_bodies.html`.
 *
 * It filled a half-gigabyte database from ONE ordinary mailbox. The shape before the fix, from a
 * representative mailbox: the inline attachment parts were together comparable in size to the
 * whole of `message_bodies.html`, because each one had been pasted into a body as well as
 * stored as a part. A small minority of html rows — those containing `;base64,` — held the
 * overwhelming majority of all html bytes. And the bytes barely compressed, because base64 of an
 * already-compressed JPEG or PNG is incompressible, so pglz gave up and stored hundreds of rows
 * verbatim.
 *
 * It is a store-no-bytes violation before it is a sizing problem. That invariant says on-demand
 * attachment fetch and gated send "store no bytes", and
 * `packages/api/src/routes/attachments.ts` implements exactly that — bytes are fetched from
 * IMAP when asked for and never persisted. Inlining them into the body was storing the very
 * bytes the design refuses to store, through a side door.
 *
 * What the option changes and what it does NOT: `keepCidLinks` makes `simpleParser` return
 * BEFORE `updateImageLinks`, so the html keeps its original `cid:` references and the
 * `attachments` array is untouched — `contentId` and `inline` are still populated exactly as
 * before (see {@link toAttachmentMeta}), which is what lets a client resolve a `cid:` through
 * `GET /attachments/:id`. `packages/core/src/privacy/tracker-blocker.ts` already leaves `cid:`
 * URIs alone, deliberately, because an embedded part cannot phone home.
 *
 * This stops us MANUFACTURING the bloat. It says nothing about a sender who writes a `data:`
 * URI into their own html, which is why {@link prepareHtmlForStorage} exists as the second
 * line and why the `message_bodies_html_cap` CHECK constraint exists as the third.
 *
 * ── THE CONTRACT, WHICH IS WHAT MAKES THIS SAFE TO CALL ON HOSTILE BYTES ─────────────────────
 *
 * `raw` is entirely attacker-controlled: anyone who knows the address can choose every byte.
 * This function resolves with a usable {@link NormalizedMessage}, or rejects with
 * {@link MimeTooLargeError} or {@link MimeParseError} — nothing else. No `TypeError`, no
 * `RangeError`, no bare `Error` from a dependency. See {@link MimeParseError} for why the
 * distinction is load-bearing rather than tidy.
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

  // Build a lowercased header-name -> raw-values map from the raw header lines.
  // (parsed.headers folds `List-*` into a structured `list` object, dropping the
  // literal `list-unsubscribe` key we rely on, so we read the raw lines instead.)
  //
  // ── `Object.create(null)` IS A SECURITY FIX, NOT A STYLE PREFERENCE ───────────────────────
  //
  // `__proto__` and `constructor` are valid RFC 5322 extension header names, mailparser 3.9.14
  // preserves both in `parsed.headerLines` (verified against the installed version), and every
  // byte here arrives from whoever knows the user's address. On a plain `{}` the sequence is:
  //
  //   headers["__proto__"]  →  the INHERITED Object.prototype  →  not nullish  →  `??=` does
  //   not install an array  →  `.push(value)` throws
  //   `TypeError: headers[name].push is not a function`
  //
  // That exception leaves `normalizeMime`, and `apps/worker/src/sync.ts` has no per-message
  // catch and only advances the folder cursor once a whole batch commits — so a five-byte
  // header stops ALL later mail for that mailbox, forever, with no user interaction.
  //
  // ── AND WHY `Object.hasOwn` IS DELIBERATELY *NOT* ALSO USED HERE ──────────────────────────
  //
  // The obvious belt-and-braces spelling is `if (!Object.hasOwn(headers, name)) headers[name] =
  // []` on top of the null prototype. It was written, mutation-tested, and REMOVED, because on
  // a plain `{}` it does not degrade to the throw — it degrades to silent prototype pollution.
  // Measured on node 23.6.1: `h["__proto__"] = []` invokes the `__proto__` SETTER, so the
  // object's prototype becomes the attacker's array and
  //
  //   JSON.stringify(h) === "{}"      the header VANISHES from what we persist to jsonb
  //   Object.keys(h)    === []        …and from anything that enumerates
  //   h["length"] === 1, h["0"] === "attacker"   attacker values answer unrelated lookups
  //
  // A rule of kind `header` matching `length` or `0` would then be truthy for that message
  // (`packages/core/src/rules.ts:109` decides with `Boolean(msg.headers[r.match]`)). Keeping a
  // line that converts a loud crash into quiet corruption is worse than not having it, so the
  // null prototype stands alone and a test pins the prototype itself — writing `{}` here is red
  // on that test whatever the append looks like.
  //
  // Scope of the guarantee, so nobody assumes more: it holds for the map this function BUILDS.
  // It does not survive a database round trip — `packages/core/src/adapters/drizzle-repo.ts`
  // rebuilds `message_bodies.headers` with `JSON.parse`, which inherits from Object.prototype
  // again, and the worker's kickstart pass feeds that map back into `evaluateRules`. That
  // residue is tracked separately, not closed here.
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

  // ── A PART THE HTML PAINTS IS INLINE, WHEREVER IT SITS IN THE MIME TREE ────────────────────
  //
  // mailparser's `related` only marks a cid part under `multipart/related`; a signature logo
  // nested under `multipart/mixed` arrived with `inline: false` and was listed as a file the
  // reader could download — beside a body that draws that same picture. The body's own `cid:`
  // reference is the second signal ({@link referencesCid}), and it runs HERE because this is the
  // one moment both sides of the question are in hand: the decoded html (scrubbed, the exact
  // string the renderer will resolve against) and the parts. Promotion only — a `related` part
  // never loses its flag for going unreferenced, because `related` is already the tree saying
  // "embedded" and demoting on a failed text scan would move real newsletters' logos into the
  // Files list on a formatting quirk.
  for (const a of attachments) {
    if (!a.inline && referencesCid(html, a.contentId)) a.inline = true;
  }

  // ── WHAT THE FALLBACK PARSE HASHES, AND WHY IT IS NOT `text` ──────────────────────────────
  //
  // `skipHtmlToText` leaves `parsed.text` as the empty string, so on that path `canonicalId`
  // would hash "" for EVERY such message. `dedupKey` falls back to `body:<hash>` when a message
  // carries no Message-ID, and a shared hash there means the second such message is filed as a
  // duplicate of the first — real mail silently dropped, which is worse than the CPU burn the
  // limit exists to stop. So this path hashes the html, which is real content and is stable:
  // the same raw bytes always take the same branch, so a message dedups against itself on every
  // later sync. `textBody` stays honestly empty rather than being filled with an invented
  // rendition — a second text extraction, differing from mailparser's, would show up in the
  // snippet and the search vector and belongs in a slice that can measure it.
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
