/**
 * `tls` — the same bridge as `net`, over the platform's TLS socket, with both ways in: implicit TLS (dial
 * 993/465, handshake first) and STARTTLS (dial plaintext, upgrade THE SAME connection in place — the client
 * passes its existing socket as `options.socket`, and a second connection would negotiate TLS with a server
 * still waiting on the first). The floor is the caller's and is not weakened here: the adapter passes its own
 * TLS floor and this file passes options straight through — `rejectUnauthorized` is never defaulted, because
 * a permissive default would be a mail client with no hostname verification and no way to see it. Nothing
 * here runs without a device: enforcement is a device criterion under the transport's guard script; the
 * bundle census sees only that `tls` resolves here.
 */
"use strict";

const TcpSocket = require("react-native-tcp-socket");
const { NativeSocketBridge } = require("./net.js");

/**
 * `tls.connect(options[, listener])`. `options.socket` present ⇒ the STARTTLS upgrade: take the
 * bridge's underlying native socket and hand it to the platform's TLS socket, which begins the
 * handshake on that same connection; absent ⇒ a fresh TLS dial. The returned bridge emits
 * `secureConnect` from the platform's own `secureConnect`, never from the TCP `connect` —
 * different moments, and treating the first as the second would report a plaintext connection as
 * a secured one.
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
