/**
 * THE SOCKS CLIENT, REFUSED — imported at module scope by the mail client, never constructed here.
 *
 * `imapflow`'s proxy connector does `require('socks')` when its own module loads, which is why this
 * has to exist at all; it reaches `SocksClient` only for a connection whose configuration names a
 * proxy. This app has no such setting, so the class below is a refusal rather than an omission —
 * and if a proxy ever is configured, this names the missing capability instead of failing the dial
 * with something that reads like a server problem.
 */
"use strict";

class SocksClient {
  constructor() {
    throw new Error(
      "SOCKS proxying is not available in this app. The mail engine dials the server directly; " +
        "nothing here can configure a proxy, so a connection that reached this was composed wrong.",
    );
  }
  static createConnection() {
    return Promise.reject(new Error("SOCKS proxying is not available in this app"));
  }
  static createConnectionChain() {
    return Promise.reject(new Error("SOCKS proxying is not available in this app"));
  }
}

module.exports = { SocksClient, SocksClientError: Error };
