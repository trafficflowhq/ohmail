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
/* THE SAME BRIDGE, AND THEREFORE THE SAME WRITABLE DOOR. A write into a closed connection is
   refused in `NativeSocketBridge._write` (see `net.js`), so this transport inherits the refusal
   rather than repeating it — a second copy here is how the two halves come to disagree. The
   seam test drives BOTH entry points for exactly that reason. */
const { NativeSocketBridge } = require("./net.js");

/**
 * SNI IS A NAME OR IT IS ABSENT — never `false`.
 *
 * `imapflow` sets `servername: false` when the host is an IP literal (RFC 6066 forbids an IP in
 * SNI). Node reads that falsy value as "no SNI"; the platform socket refuses it outright — `Value
 * for servername cannot be cast from Boolean to String` — so a mailbox given by IP address died on
 * a TypeError before the handshake. Dropped rather than stringified: "false" would go on the wire
 * AS the server's name. Measured on a phone dialling a server by IP.
 */
function withNameOrNoSni(options) {
  if (!options || !("servername" in options)) return options;
  const name = options.servername;
  if (typeof name === "string" && name.length > 0) return options;
  const { servername: _dropped, ...rest } = options;
  return rest;
}

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
    native = new TcpSocket.TLSSocket(underlying, withNameOrNoSni(tlsOptions));
  } else {
    native = TcpSocket.connectTLS(withNameOrNoSni(options), () => undefined);
  }

  const bridge = new NativeSocketBridge(native);
  /* FORWARDED SEPARATELY from `connect`: the handshake finishing is a different fact from the
     connection opening, and only this one means the bytes after it are protected. */
  native.on("secureConnect", () => { bridge.emit("secureConnect"); });
  if (typeof listener === "function") bridge.once("secureConnect", listener);
  if (existing) confirmUpgrade(native, bridge);
  return bridge;
}

/**
 * THE UPGRADE'S HANDSHAKE HAS NO EVENT OF ITS OWN.
 *
 * The platform emits `secureConnect` for a fresh TLS dial only; a STARTTLS upgrade emits nothing,
 * so a caller waiting for it waits until its own timeout and the dial dies as "closed" — every
 * mailbox on a STARTTLS port, measured on a device. The completion is therefore ASKED of the
 * platform: a peer certificate exists only once the handshake has finished. It is never inferred
 * from `connect`, which fires before the upgrade has happened and would call plaintext secure.
 */
function confirmUpgrade(native, bridge, attempts = UPGRADE_ATTEMPTS, waitMs = UPGRADE_WAIT_MS) {
  let left = attempts;
  const ask = () => {
    Promise.resolve()
      .then(() => native.getPeerCertificate())
      .then((cert) => {
        if (cert && typeof cert === "object" && Object.keys(cert).length > 0) {
          bridge.emit("secureConnect");
          return;
        }
        left -= 1;
        if (left <= 0) {
          bridge.emit("error", new Error("the TLS upgrade produced no peer certificate, so the connection is not secured"));
          return;
        }
        setTimeout(ask, waitMs);
      })
      .catch((err) => { bridge.emit("error", err instanceof Error ? err : new Error(String(err))); });
  };
  ask();
}

/** How long the upgrade may take before it is reported as not secured: 20 x 50 ms. */
const UPGRADE_ATTEMPTS = 20;
const UPGRADE_WAIT_MS = 50;

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
  /* Exported for the guards that drive them with the shapes the platform produces. */
  withNameOrNoSni,
  confirmUpgrade,
  TLSSocket: NativeSocketBridge,
  /* `connect` handles both routes, so there is no second entry point to keep in step. */
  createServer: unsupported("createServer"),
  Server: unsupported("Server"),
  /* Read by libraries that print what they negotiated. An empty list is honest: this shim chooses
     no ciphers, the platform does. */
  getCiphers: () => [],
  DEFAULT_MIN_VERSION: "TLSv1.2",
};
