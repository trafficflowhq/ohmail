/**
 * Compression, refused — and the refusal is the safe answer. The IMAP client negotiates COMPRESS
 * only when the server advertises it and the caller has not turned it off, and this app's
 * adapter passes `disableCompression: true` — so the two compressors are unreachable on a
 * healthy path and throw rather than pretending. A pass-through stub would let the connection
 * agree to compression and then send uncompressed bytes: the server reads a corrupt stream and
 * every later command fails mid-session, looking like a network fault. Throwing fails the one
 * operation that should never have happened, with a sentence naming why. `apps/sidecar` guards
 * the option reaching `new ImapFlow`; this file guards its absence.
 */
"use strict";

const refuse = (member) => () => {
  throw new Error(
    `zlib.${member}() is not available in this app. The mail client is configured never to ` +
      "negotiate compression, so this is only reachable if that option stopped being passed — " +
      "and agreeing to compress while sending plain bytes would corrupt the connection rather " +
      "than fail one operation.",
  );
};

module.exports = {
  createDeflateRaw: refuse("createDeflateRaw"),
  createInflateRaw: refuse("createInflateRaw"),
  createDeflate: refuse("createDeflate"),
  createInflate: refuse("createInflate"),
  createGzip: refuse("createGzip"),
  createGunzip: refuse("createGunzip"),
  deflateRawSync: refuse("deflateRawSync"),
  inflateRawSync: refuse("inflateRawSync"),
  gunzipSync: refuse("gunzipSync"),
  gzipSync: refuse("gzipSync"),
  constants: {},
};
