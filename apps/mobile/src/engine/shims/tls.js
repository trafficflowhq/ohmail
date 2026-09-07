/**
 * `tls` — the same bridge as `net`, over the platform's TLS socket, with BOTH ways in.
 *
 * A mail client reaches TLS by two routes and they are not variations of one thing:
 *
 *  · **implicit TLS** — dial port 993 or 465 and the handshake is the first thing that happens.
 *  · **STARTTLS** — dial plaintext, exchange a command, then upgrade THE SAME CONNECTION in place.
 *    The client passes its existing socket as `options.socket`, and the upgrade has to happen on
 *    the socket that already carries the session; opening a second connection would negotiate TLS
 *    with a server that is still waiting on the first one.
 *
 * Both are supported by the platform module, and the in-place upgrade is why: its TLS socket takes
 * an EXISTING socket and starts the handshake on it.
 *
 * ── THE FLOOR IS THE CALLER'S AND IS NOT WEAKENED HERE ────────────────────────────────────
 *
 * The engine's adapter passes its own TLS floor — certificate verification on, a minimum protocol
 * version — and this file passes the options straight through. It adds nothing and, more
 * importantly, removes nothing: there is no default here that could quietly turn verification off,
 * and `rejectUnauthorized` is never defaulted, because a shim that supplied a permissive default
 * would be a mail client with no hostname verification and no way for a reader to see it.
 *
 * ── WHAT IS NOT VERIFIED IN THIS PACKAGE ──────────────────────────────────────────────────
 *
 * As with `net`: nothing here runs without a device. That the floor is ENFORCED — a dial by address
 * to a server whose certificate names no address being refused, and an upgrade completing — is a
 * device criterion measured against a real provider on a real build, and the transport's own guard
 * script re-runs all three. This file's correctness here is limited to what the bundle census can
 * see: that `tls` resolves to it, and that it reaches no Node builtin.
 */
"use strict";

const TcpSocket = require("react-native-tcp-socket");
const { NativeSocketBridge } = require("./net.js");

/**
 * `tls.connect(options[, listener])`.
 *
 * `options.socket` present ⇒ the STARTTLS upgrade: take the bridge's underlying native socket and
 * hand it to the platform's TLS socket, which begins the handshake on that same connection. Absent
 * ⇒ a fresh TLS dial.
 *
 * The returned bridge emits `secureConnect`, which is the event a client waits on before it trusts
 * the connection. It is emitted from the platform's own `secureConnect`, never from the TCP
 * `connect` — those are different moments, and treating the first as the second would report a
 * plaintext connection as a secured one.
 */
function connect(options, listener) {
  const existing = options && options.socket;
  let native;

  if (existing) {
    /* THE UPGRADE. `existing` is one of our bridges, so the socket to upgrade is its `native`; a
       caller passing a raw platform socket also works, which is why this reads either shape rather
       than asserting one. */
    const underlying = existing instanceof NativeSocketBridge ? existing.native : existing;
    const { socket: _dropped, ...tlsOptions } = options;
    native = new TcpSocket.TLSSocket(underlying, tlsOptions);
  } else {
    native = TcpSocket.connectTLS(options, () => undefined);
  }

  const bridge = new NativeSocketBridge(native);
  /* FORWARDED SEPARATELY from `connect`: the handshake finishing is a different fact from the
     connection opening, and only this one means the bytes after it are protected. */
  native.on("secureConnect", () => { bridge.emit("secureConnect"); });
  if (typeof listener === "function") bridge.once("secureConnect", listener);
  return bridge;
}

function unsupported(name) {
  return () => {
    throw new Error(
      `tls.${name}() is not available in this app: it LISTENS, and this app serves no door to ` +
        "another device.",
    );
  };
}

module.exports = {
  connect,
  TLSSocket: NativeSocketBridge,
  /* `connect` handles both routes, so there is no second entry point to keep in step. */
  createServer: unsupported("createServer"),
  Server: unsupported("Server"),
  /* Read by libraries that print what they negotiated. An empty list is honest: this shim chooses
     no ciphers, the platform does. */
  getCiphers: () => [],
  DEFAULT_MIN_VERSION: "TLSv1.2",
};
