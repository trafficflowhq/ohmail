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
const { NativeSocketBridge, socketLogLine } = require("./net.js");

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
 * A CERTIFICATE THE PLATFORM REFUSED, said as one — `tlsFailed` and `certificateRefused`.
 *
 * The platform socket reports a failed handshake as a bare message (a string on both native
 * halves), so imapflow's implicit-TLS dial rejected with no flag and the engine read the refusal as
 * an outage: "Reconnecting…" for ever over a certificate nothing would accept. Only the certificate
 * class is stamped — a refused or timed-out TCP connect before the handshake is still an outage.
 * Android names the Java exception; iOS names the Secure Transport code; node (the suite's stand-in)
 * says "certificate".
 */
const CERTIFICATE_REFUSAL =
  /certificat|CertPath|trust anchor|SSLPeerUnverified|Hostname \S+ not verified|kCFStreamErrorDomainSSL error -98(?:07|08|12|13|14|15|43)\b|errSSL(?:XCertChainInvalid|NoRootCert|UnknownRootCert|CertExpired|CertNotYetValid|HostNameMismatch)/i;
const CERTIFICATE_CODE = /CERT|SELF_SIGNED|UNABLE_TO_(?:GET_ISSUER|VERIFY)/;

function handshakeRefusal(err) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && typeof err.code === "string" ? err.code : "";
  if (!CERTIFICATE_REFUSAL.test(message) && !CERTIFICATE_CODE.test(code)) return err;
  const e = err instanceof Error ? err : new Error(message);
  e.tlsFailed = true;
  e.certificateRefused = true;
  return e;
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
    detachPlainSide(existing, underlying);
    const { socket: _dropped, ...tlsOptions } = options;
    native = new TcpSocket.TLSSocket(underlying, withNameOrNoSni(tlsOptions));
  } else {
    native = TcpSocket.connectTLS(withNameOrNoSni(options), () => undefined);
  }

  /* Until the handshake is confirmed, an error may be the platform refusing the certificate. */
  let secured = false;
  const bridge = new NativeSocketBridge(native, (err) => (secured ? err : handshakeRefusal(err)));
  bridge.once("secureConnect", () => { secured = true; });
  /* FORWARDED SEPARATELY from `connect`: the handshake finishing is a different fact from the
     connection opening, and only this one means the bytes after it are protected. */
  native.on("secureConnect", () => { bridge.emit("secureConnect"); });
  if (typeof listener === "function") bridge.once("secureConnect", listener);
  if (existing) superviseUpgrade(native, bridge);
  return bridge;
}

/**
 * AFTER STARTTLS THE PLAIN SOCKET HEARS NOTHING, as on node.
 *
 * The platform keeps ONE receiver per connection and hands every decrypted byte to both of its
 * JavaScript sockets, the plain one included. imapflow unpipes the plain bridge and never reads it
 * again, so it filled to its high-water mark and paused that shared receiver: an upgraded mailbox
 * stalled after 16 KiB with the connection open. Measured on a device over IMAP 143. A pause the
 * plain side already took is lifted, or the session would start paused.
 */
function detachPlainSide(existing, underlying) {
  if (underlying && typeof underlying.removeAllListeners === "function") underlying.removeAllListeners("data");
  if (existing instanceof NativeSocketBridge) existing._handedToTls = true;
  if (existing instanceof NativeSocketBridge && existing._paused) {
    existing._paused = false;
    try { underlying.resume(); } catch { /* gone; its close follows */ }
  }
}

/**
 * THE UPGRADE ENDS ONE WAY, WITHIN A BOUND, AND SAYS WHICH. Every error before the handshake is
 * confirmed carries `tlsFailed` (imapflow's own flag), so a send can tell "never secured, nothing
 * offered" from an unknown fate; a handshake still open at the bound is refused by name rather than
 * left to the caller's idle timer. One line per upgrade records how it ended.
 */
function superviseUpgrade(native, bridge, deadlineMs = UPGRADE_DEADLINE_MS) {
  const started = Date.now();
  let settled = false;
  let timer = null;
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socketLogLine("tls_upgrade_settled", { outcome, connectMs: Date.now() - started });
  };
  const emit = bridge.emit.bind(bridge);
  bridge.emit = (event, ...args) => {
    if (event === "secureConnect") settle("secured");
    else if (event === "error" && !settled) {
      const err = args[0] instanceof Error ? args[0] : new Error(String(args[0]));
      err.tlsFailed = true;
      args[0] = err;
      settle("refused");
    } else if (event === "close") settle("closed");
    return emit(event, ...args);
  };
  timer = setTimeout(() => {
    if (settled) return;
    bridge.emit("error", new Error(`the TLS upgrade did not finish within ${deadlineMs} ms`));
    bridge.destroy();
  }, deadlineMs);
  confirmUpgrade(native, bridge);
}

/** How long a STARTTLS handshake may take: imapflow's own upgrade bound, applied to SMTP too. */
const UPGRADE_DEADLINE_MS = 10_000;

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
  superviseUpgrade,
  detachPlainSide,
  /* Exported for the guards that drive them with the shapes the platform produces. */
  withNameOrNoSni,
  confirmUpgrade,
  handshakeRefusal,
  TLSSocket: NativeSocketBridge,
  /* `connect` handles both routes, so there is no second entry point to keep in step. */
  createServer: unsupported("createServer"),
  Server: unsupported("Server"),
  /* Read by libraries that print what they negotiated. An empty list is honest: this shim chooses
     no ciphers, the platform does. */
  getCiphers: () => [],
  DEFAULT_MIN_VERSION: "TLSv1.2",
};
