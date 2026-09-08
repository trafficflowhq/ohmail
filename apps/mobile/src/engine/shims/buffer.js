/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE `buffer` POLYFILL, PLUS THE ONE ENCODING IT HAS NEVER HEARD OF — `base64url`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A phone has no `buffer` builtin, so the engine is built against the `buffer` package. That
 * package implements every encoding Node had when it was written, and `base64url` is not one of
 * them — it arrived in Node 15. Sealing a mailbox credential writes one, so a phone failed with
 * `TypeError: Unknown encoding: base64url` from inside the launch, after a successful load and a
 * successful store migration.
 *
 * ── AN ALIAS OF THE NAME IS NOT THE FIX, AND WHAT IS ACTUALLY WRONG IS NARROWER THAN IT LOOKS ─
 *
 * Measured against `buffer@6.0.3` rather than assumed, because the assumption on record was wrong
 * in a way that matters. The note this file was written from said the package's base64 cleaner
 * STRIPS `-` and `_`, so decoding through `base64` would silently produce different bytes. It does
 * not: its cleaning pattern keeps both characters and the decoder underneath maps them to 62 and
 * 63, so `from(urlString, "base64")` agrees with Node on 200 random vectors. Had that been left
 * unchecked, the fix would have carried a paragraph claiming to prevent a corruption that cannot
 * happen — and the reader after it would have believed the paragraph.
 *
 * What IS wrong, measured on each member:
 *
 *   · `Buffer.from(s, "base64url")`      throws `Unknown encoding: base64url`
 *   · `buf.toString("base64url")`        throws `Unknown encoding: base64url`
 *   · `buf.write(s, o, l, "base64url")`  throws `Unknown encoding: base64url`
 *   · `Buffer.isEncoding("base64url")`   answers `false` where Node answers `true`
 *   · `Buffer.byteLength(s, "base64url")` answers the STRING LENGTH — 4 for a string Node measures
 *     as 3 bytes. It does not throw. That one is the dangerous member: a caller sizing a buffer
 *     from it allocates the wrong length and nothing reports anything.
 *
 * ── SO THE DECODE PATHS TRANSLATE NOTHING, AND THAT IS THE MEASUREMENT, NOT A SHORTCUT ────
 *
 * This file used to hand the decoders an explicit RFC 4648 §5→§4 translation (`-`→`+`, `_`→`/`,
 * re-pad), justified as insurance against "an undocumented property of a dependency". The property
 * is neither undocumented nor incidental: `base64-js/index.js:17-20` sets `revLookup['-'] = 62`
 * and `revLookup['_'] = 63` under the comment *"Support decoding URL-safe base64 strings, as
 * Node.js does."*, and `base64clean` in `buffer/index.js` keeps both characters and pads a short
 * string to a whole group. So a second implementation of the same rule bought nothing and had to
 * be kept in step with the first.
 *
 * What each decode path does now is name the encoding the polyfill understands and pass the STRING
 * through untouched. Measured across every remainder (0, 2, 3), padded and unpadded, and on
 * vectors containing both URL-safe characters: `from` returns the same bytes and `byteLength` the
 * same number as Node, with no translation at all. The members still have to EXIST, because what
 * the polyfill refuses is the NAME.
 *
 * ── PATCHED IN PLACE, WHICH IS WHY THE GLOBAL AND THE MODULE CANNOT DISAGREE ──────────────
 *
 * The members are replaced on the polyfill's own class rather than on a subclass, and this module
 * re-exports the polyfill. So the `Buffer` bound as a GLOBAL at bundle time (`globals.mjs` imports
 * it from here) and the `Buffer` any module IMPORTS are one class. A wrapper subclass would have
 * left mail parsing — which writes `Buffer.from` against the global — on the unpatched one, which
 * is the same defect one indirection further away.
 *
 * `buffer/` with the trailing slash is the package's own documented spelling for "the package, not
 * the builtin". The alias table matches the bare name `buffer` exactly, so this specifier passes
 * through it and resolves to the package — which is what keeps exactly one copy in the artifact.
 */
"use strict";

const polyfill = require("buffer/");

const Buffer = polyfill.Buffer;

/** §4 → §5: the standard alphabet translated to the URL-safe one, unpadded. */
function toUrlAlphabet(value) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const isBase64Url = (encoding) =>
  typeof encoding === "string" && encoding.toLowerCase() === "base64url";

const originalFrom = Buffer.from;
const originalByteLength = Buffer.byteLength;
const originalIsEncoding = Buffer.isEncoding;
const originalToString = Buffer.prototype.toString;
const originalWrite = Buffer.prototype.write;

Buffer.from = function from(value, encodingOrOffset, length) {
  /* THIS ARM IS REDUNDANT TODAY AND IS KEPT DELIBERATELY — do not delete it as dead code.
     Measured: removing it leaves all nine cases in `buffer-base64url.test.ts` green, because
     `isEncoding` below answers `true` for the name, which is exactly what stops the polyfill's own
     `fromString` refusing it — and `byteLength` and `write` then do the decode between them. Traced
     against the raw package: `from(s, "base64url")` throws `Unknown encoding: base64url`, and with
     only those three patched it returns the right bytes.
     So what this line buys is that `from` NORMALIZES THE NAME ONCE, at the entry point, instead of
     `from`'s correctness resting on three other overrides recognising it further down. A case pins
     that: nothing below this line ever sees the string "base64url". */
  if (typeof value === "string" && isBase64Url(encodingOrOffset)) {
    return originalFrom.call(this, value, "base64");
  }
  return originalFrom.call(this, value, encodingOrOffset, length);
};

Buffer.byteLength = function byteLength(value, encoding) {
  /* The member that answered a wrong number instead of refusing. Measured through the polyfill's
     own decode so it cannot drift from what `from` produces — a length computed from the string's
     arithmetic here would be a second implementation of the same rule. */
  if (typeof value === "string" && isBase64Url(encoding)) {
    return originalByteLength.call(this, value, "base64");
  }
  return originalByteLength.call(this, value, encoding);
};

Buffer.isEncoding = function isEncoding(encoding) {
  if (isBase64Url(encoding)) return true;
  return originalIsEncoding.call(this, encoding);
};

Buffer.prototype.toString = function toString(encoding, start, end) {
  if (isBase64Url(encoding)) {
    return toUrlAlphabet(originalToString.call(this, "base64", start, end));
  }
  return originalToString.call(this, encoding, start, end);
};

Buffer.prototype.write = function write(string, offset, length, encoding) {
  /* `write` carries three optional-argument shapes — (string), (string, encoding),
     (string, offset, encoding) and (string, offset, length, encoding) — so the encoding is
     whichever of the three trailing arguments is the URL-safe name. Renaming it to `base64` in the
     same position keeps the polyfill's own argument handling in charge of the rest. */
  if (isBase64Url(encoding)) {
    return originalWrite.call(this, string, offset, length, "base64");
  }
  if (isBase64Url(length)) {
    return originalWrite.call(this, string, offset, "base64");
  }
  if (isBase64Url(offset)) {
    return originalWrite.call(this, string, "base64");
  }
  return originalWrite.call(this, string, offset, length, encoding);
};

/* The polyfill itself, patched. Everything else it exports — `Blob`, `constants`, `kMaxLength`,
   `SlowBuffer`, `atob`, `btoa` — passes through untouched. */
module.exports = polyfill;
/* The ENCODE half only. Its §5→§4 twin is gone with the decode translation above; the decoders
   read the URL-safe alphabet themselves and there is nothing left for a caller to translate. */
module.exports.toUrlAlphabet = toUrlAlphabet;
