/**
 * `net` — the platform's TCP socket, wrapped in the stream the mail clients are written against. The clients PIPE
 * their socket (parser in, literal out), and the platform socket has no `pipe`, so this is the stream the client's
 * code requires in order to run at all. What a bridge has to get right: backpressure both ways (`push()` false pauses
 * the native socket, `_read()` resumes — a large mailbox's first sync is where its absence shows); `_write`'s
 * callback is the native write's callback (early claims capacity, never stalls the client); the informational surface
 * (`setKeepAlive` … `localPort` — a missing one is a `TypeError` deep inside a library); `ref`/`unref` as no-ops (no
 * Node event loop to hold). Nothing here runs without a device: the bundle census proves `net` resolves here and no
 * Node builtin is reached; the transport criteria are measured on a build.
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
