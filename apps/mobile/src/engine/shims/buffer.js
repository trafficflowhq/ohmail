/**
 * The `buffer` polyfill, plus the one encoding it has never heard of — `base64url` (Node 15;
 * the package predates it). Sealing a mailbox credential writes one, so a phone failed with
 * `Unknown encoding: base64url` mid-launch. Measured against `buffer@6.0.3`: the decoders
 * already map `-` and `_` ("as Node.js does"), so the decode paths translate nothing — what is
 * broken is the NAME: `from`, `toString`, `write` and `isEncoding` refuse it, and `byteLength`
 * answers the string length — the dangerous member: a caller sizing a buffer allocates wrong.
 * Patched in place on the polyfill's own class and re-exported, so the global bound at bundle
 * time and the imported module are one class; `buffer/` keeps one copy in the artifact.
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
