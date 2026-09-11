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
 * THE ENGINE'S OWN DIAGNOSTIC, when the composition has handed one over.
 *
 * A no-op until then, because this module is loaded while the artifact is still initialising and a
 * socket can be refused before anything has been wired. One sink, set once, through the same
 * hardened logger every other line goes through — a second logger here would sit outside that
 * logger's field allowlist and its redaction, which is the one thing a socket module must not do.
 */
let socketLog = () => undefined;

/** Called once by the phone composition (`apps/sidecar/src/mobile.ts`) with the engine's `log`. */
function setSocketLog(log) {
  if (typeof log === "function") socketLog = log;
}

/**
 * One native socket, as a Duplex.
 *
 * Exported so `tls.js` can wrap an upgraded socket in the same bridge rather than writing a second
 * one — the upgrade produces a socket of the same shape, and two bridges would be two chances to
 * get backpressure wrong. It is also why the write-after-close refusal below covers BOTH shims:
 * there is one writable door, not one per transport.
 */
class NativeSocketBridge extends Duplex {
  constructor(native) {
    /* `emitClose: false` — this bridge emits its own `close`, from the native socket's, so the
       stream layer must not emit a second one. Before it did, and a consumer-initiated
       `destroy()` produced two closes for one connection. */
    super({ allowHalfOpen: false, emitClose: false });
    /** The platform socket. Named `native` rather than `socket` so a reader is never in doubt. */
    this.native = native;
    this.connecting = true;
    /** Set when `_read` is waiting for the consumer rather than for the server. */
    this._paused = false;
    /**
     * THE CONNECTION IS GONE. Read by `_write`, and the field the bridge used not to have.
     *
     * The native socket's death was mirrored into the READABLE side only (`push(null)`), so the
     * writable side stayed open over a dead connection: `destroyed` answered false, the stream
     * layer's own write-after-destroy guard never fired, and the next queued command was handed
     * to a socket that was not there. See `_write`.
     */
    this._connectionGone = false;

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
      this._connectionGone = true;
      // END THE READABLE SIDE, or a consumer awaiting the end of the stream waits for ever after
      // the server has hung up. `push(null)` is the end-of-stream signal a `pipe` is waiting for.
      this.push(null);
      this.emit("close", hadError);
      /* AND END THE WRITABLE SIDE, which is the half this handler used to leave open. Once the
         stream is destroyed the layer above refuses every later write itself: the caller's
         callback gets `ERR_STREAM_DESTROYED`, `_write` is never reached, and nothing is emitted
         at a socket whose last `error` listener was a spent `once`. Measured safe for the
         readable side — bytes already pushed still reach a consumer that reads after this. */
      if (!this.destroyed) this.destroy();
    });
  }

  _read() {
    if (!this._paused) return;
    this._paused = false;
    try { this.native.resume(); } catch { /* gone */ }
  }

  /**
   * REFUSED AT THIS DOOR WHEN THE CONNECTION IS GONE — never handed to the platform.
   *
   * The mail client's own queue writes in a microtask (`trySend` → `send`, which awaits its
   * compiler twice), so a connection can die between a command being dequeued and its bytes
   * being written. Handing that chunk on threw into the process from both platforms: the phone's
   * socket throws `Socket is closed.` synchronously, Node's answers `ERR_STREAM_DESTROYED`, and
   * either way the stream layer then emitted `error` at a socket with no listener left. The
   * refusal reports through the pending write's callback instead, and destroys FIRST so that
   * report cannot become a second unlistened emit.
   */
  _write(chunk, encoding, callback) {
    if (this._connectionGone || this.native.destroyed === true) {
      const err = new Error("the mail server connection was closed before these bytes were written");
      err.code = "ERR_STREAM_DESTROYED";
      socketLog("socket_write_after_close", {
        bytes: chunk.length,
        reason: "a command was written to a connection that had already closed; the bytes were " +
          "refused at the socket bridge and the write's caller told, rather than the platform's " +
          "own error reaching the top of a runtime that has no handler for one",
      });
      if (!this.destroyed) this.destroy();
      callback(err);
      return;
    }
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
    this._connectionGone = true;
    try { this.native.end(); } catch { /* gone */ }
    callback();
  }

  _destroy(err, callback) {
    this._connectionGone = true;
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
  setSocketLog,
  isIP,
  isIPv4,
  isIPv6,
  /* A server is not merely unimplemented, it is refused: the phone is never a host, and that is an
     invariant rather than a missing feature. */
  createServer: unsupported("createServer"),
  Server: unsupported("Server"),
};
