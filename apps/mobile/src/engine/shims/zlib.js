/**
 * COMPRESSION, REFUSED — and the refusal is the safe answer rather than a gap.
 *
 * The IMAP client negotiates the COMPRESS extension only when the server advertises it AND the
 * caller has not turned it off, and this app's adapter passes `disableCompression: true`. So the
 * two compressors below are unreachable on a healthy path, and they THROW rather than pretending.
 *
 * ── WHY A PRETENDING STUB WOULD BE WORSE THAN A THROWING ONE ──────────────────────────────
 *
 * If the option ever stopped reaching the client, a stub that returned a pass-through stream would
 * let the connection agree to compression and then send uncompressed bytes down it. The server
 * would read a corrupt stream: every command after that point fails, mid-session, in a way that
 * looks like a network fault rather than a configuration one. Throwing fails the ONE operation
 * that should never have happened, with a sentence naming why.
 *
 * `apps/sidecar` has a test asserting `disableCompression: true` reaches `new ImapFlow`, which is
 * the guard for the option; this file is the guard for the option's absence.
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
