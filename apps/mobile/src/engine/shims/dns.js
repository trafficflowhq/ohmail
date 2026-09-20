/**
 * Name resolution on a phone: the two record lookups the mail client makes before it dials are
 * ANSWERED with the hostname itself; every other member stays a refusal.
 *
 * nodemailer resolves a non-IP submission host BEFORE connecting (`shared/index.js` → `resolver`
 * → `dns.resolve4`, then `resolve6`) and dials whatever comes back, keeping the hostname as the
 * TLS `servername`. Refusing that call threw out of `SMTPConnection.connect` and killed the
 * process, so nothing sent from a phone organizing its own mailbox. Handing the HOSTNAME back as
 * the single "address" sends the dial to the name — which `react-native-tcp-socket` resolves
 * natively — and leaves SNI on the hostname. An IP never reaches here: `net.isIP` short-circuits.
 *
 * `lookup` STAYS a refusal, and that is the invariant rather than an oversight: its only other
 * caller in this bundle is the SSRF guard, which reads what it is given as an ADDRESS and fails
 * closed on a throw. `resolveMx`/`resolveTxt` need real records and have no honest answer here.
 */
"use strict";

const refuse = (member) => () => {
  throw new Error(
    `dns.${member}() is not available in this app. Name resolution belongs to the platform's own ` +
      "network stack here; only the mail client's pre-dial record lookup is answered, with the " +
      "hostname itself.",
  );
};

/**
 * The hostname, as its own single answer. Called back asynchronously because node's resolvers
 * always are, and a synchronous callback re-enters the caller before it has finished arming.
 */
const answerWithTheName = (member) => (hostname, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  if (typeof done !== "function") throw new Error(`dns.${member}() was called with no callback`);
  if (typeof hostname !== "string" || hostname === "") {
    setTimeout(() => done(Object.assign(new Error("hostname is empty"), { code: "EBADNAME" })), 0);
    return;
  }
  setTimeout(() => done(null, [hostname]), 0);
};

module.exports = {
  lookup: refuse("lookup"),
  resolve: refuse("resolve"),
  resolve4: answerWithTheName("resolve4"),
  resolve6: answerWithTheName("resolve6"),
  resolveMx: refuse("resolveMx"),
  resolveTxt: refuse("resolveTxt"),
  setServers: refuse("setServers"),
  promises: {
    lookup: refuse("promises.lookup"),
    resolve: refuse("promises.resolve"),
    resolve4: refuse("promises.resolve4"),
    resolve6: refuse("promises.resolve6"),
    resolveMx: refuse("promises.resolveMx"),
    resolveTxt: refuse("promises.resolveTxt"),
  },
};
