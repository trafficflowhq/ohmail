/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  `net` — the platform's TCP socket, wrapped in the STREAM the mail clients are written against
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The IMAP and SMTP clients do not merely read and write their socket, they PIPE it: the IMAP
 * client pipes the socket into its parser and pipes a literal back out, in four places. The
 * platform's socket is an event emitter with `write`, `pause`, `resume` and `destroy` and NO
 * `pipe`, so this is not a convenience shim standing in for a missing convenience — it is the
 * stream the client's own code requires in order to run at all.
 *
 * ── WHAT A BRIDGE HAS TO GET RIGHT, AND WHY EACH ONE IS HERE ──────────────────────────────
 *
 *  · **Backpressure both ways.** `push()` returning false must pause the native socket, and
 *    `_read()` must resume it. Without it a fast server fills the readable buffer of a Duplex that
 *    never applies pressure, and a large mailbox's first sync is where that shows up — the one
 *    place a phone has least memory to spare.
 *  · **`_write`'s callback is the native write's callback.** The Duplex's own `drain` semantics are
 *    derived from it. Calling back early makes the writable side claim capacity it has not got;
 *    never calling back stalls the client after one command.
 *  · **The socket's INFORMATIONAL surface.** `setKeepAlive`, `setNoDelay`, `setTimeout`, `address`,
 *    `ref`/`unref`, `remoteAddress`/`remotePort`/`localAddress`/`localPort`, `connecting`,
 *    `destroyed`. The clients read these for logging and for idle handling; a missing one is a
 *    `TypeError` deep inside a library, at a moment that has nothing to do with the property.
 *  · **`ref`/`unref` are no-ops and that is correct.** They exist to hold a Node event loop open.
 *    There is no such loop here, and a thrower would fail an idle-keeping call that means nothing
 *    on this platform.
 *
 * ── WHAT IS NOT VERIFIED IN THIS PACKAGE, STATED PLAINLY ──────────────────────────────────
 *
 * Nothing here can be exercised without a device: the module below is the only import in the engine
 * bundle that resolves to a native module, and the harness has no TCP stack behind it. The bundle
 * census proves this file is what `net` resolves to and that nothing else reaches a Node builtin.
 * It does NOT prove a byte moved. The transport criteria — a real mailbox synced, TLS refused
 * against a certificate that does not name the host, an upgrade from plaintext, a connection held
 * open — are device criteria and are measured on a build, not here.
 */
"use strict";

const TcpSocket = require("react-native-tcp-socket");
const { Duplex } = require("readable-stream");

/**
 * One native socket, as a Duplex.
 *
 * Exported so `tls.js` can wrap an upgraded socket in the same bridge rather than writing a second
 * one — the upgrade produces a socket of the same shape, and two bridges would be two chances to
 * get backpressure wrong.
 */
class NativeSocketBridge extends Duplex {
  constructor(native) {
    super({ allowHalfOpen: false });
    /** The platform socket. Named `native` rather than `socket` so a reader is never in doubt. */
    this.native = native;
    this.connecting = true;
    /** Set when `_read` is waiting for the consumer rather than for the server. */
    this._paused = false;

    native.on("data", (chunk) => {
      // `push` returning false means the consumer is behind. Pausing the NATIVE side is the only
      // thing that applies real pressure — a Duplex's own buffer would otherwise grow without
      // bound while the server keeps sending.
      if (!this.push(chunk)) {
        this._paused = true;
        try { native.pause(); } catch { /* already gone; `close` will follow */ }
      }
    });
    native.on("connect", () => {
      this.connecting = false;
      this.emit("connect");
    });
    native.on("error", (err) => { this.emit("error", err); });
    native.on("timeout", () => { this.emit("timeout"); });
    native.on("close", (hadError) => {
      this.connecting = false;
      // END THE READABLE SIDE, or a consumer awaiting the end of the stream waits for ever after
      // the server has hung up. `push(null)` is the end-of-stream signal a `pipe` is waiting for.
      this.push(null);
      this.emit("close", hadError);
    });
  }

  _read() {
    if (!this._paused) return;
    this._paused = false;
    try { this.native.resume(); } catch { /* gone */ }
  }

  _write(chunk, encoding, callback) {
    try {
      // The native write's own callback IS this callback: the writable side's capacity, and
      // therefore every `drain` the client waits on, is derived from when the platform says the
      // bytes left.
      this.native.write(chunk, null, callback);
    } catch (err) {
      callback(err);
    }
  }

  _final(callback) {
    try { this.native.end(); } catch { /* gone */ }
    callback();
  }

  _destroy(err, callback) {
    try { this.native.destroy(); } catch { /* gone */ }
    callback(err);
  }

  // ── THE INFORMATIONAL SURFACE, delegated ────────────────────────────────────────────────
  setKeepAlive(enable, initialDelay) { this.native.setKeepAlive(enable, initialDelay); return this; }
  setNoDelay(noDelay) { this.native.setNoDelay(noDelay); return this; }
  setTimeout(timeout, callback) { this.native.setTimeout(timeout, callback); return this; }
  address() { return this.native.address(); }
  /** No event loop to hold open here. See the banner: a thrower would fail a meaningless call. */
  ref() { return this; }
  unref() { return this; }

  get remoteAddress() { return this.native.remoteAddress; }
  get remotePort() { return this.native.remotePort; }
  get localAddress() { return this.native.localAddress; }
  get localPort() { return this.native.localPort; }
  get remoteFamily() { return this.native.remoteFamily; }
}

/**
 * `net.connect(options[, listener])` / `net.createConnection(...)`.
 *
 * The listener is attached to the bridge's `connect` rather than passed to the platform, so that a
 * caller which also listens for `connect` sees one consistent ordering.
 */
function connect(options, listener) {
  const native = TcpSocket.createConnection(options, () => undefined);
  const bridge = new NativeSocketBridge(native);
  if (typeof listener === "function") bridge.once("connect", listener);
  return bridge;
}

function isIP(value) { return TcpSocket.isIP(value); }
function isIPv4(value) { return TcpSocket.isIPv4(value); }
function isIPv6(value) { return TcpSocket.isIPv6(value); }

function unsupported(name) {
  return () => {
    throw new Error(
      `net.${name}() is not available in this app: it LISTENS, and this app serves no door to ` +
        "another device. Only outgoing connections to a mail server exist here.",
    );
  };
}

module.exports = {
  connect,
  createConnection: connect,
  Socket: NativeSocketBridge,
  NativeSocketBridge,
  isIP,
  isIPv4,
  isIPv6,
  /* A server is not merely unimplemented, it is refused: the phone is never a host, and that is an
     invariant rather than a missing feature. */
  createServer: unsupported("createServer"),
  Server: unsupported("Server"),
};
