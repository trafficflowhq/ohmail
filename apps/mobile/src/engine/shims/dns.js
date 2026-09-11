/**
 * Name resolution, refused — reached only by a proxy dialler this app never configures. The mail
 * client imports a SOCKS proxy connector at module scope, and that connector resolves names
 * itself; it is only called when a proxy URL is configured, which this app has no way to set.
 * The engine's own dial is by hostname and the platform's TCP module resolves it natively.
 * Throwing rather than answering keeps a silent behaviour change visible: a stub that resolved
 * nothing would look like an unreachable server.
 */
"use strict";

const refuse = (member) => () => {
  throw new Error(
    `dns.${member}() is not available in this app. Name resolution belongs to the platform's own ` +
      "network stack here; this module is only reachable through a proxy dialler that nothing " +
      "configures.",
  );
};

module.exports = {
  lookup: refuse("lookup"),
  resolve: refuse("resolve"),
  resolve4: refuse("resolve4"),
  resolve6: refuse("resolve6"),
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
