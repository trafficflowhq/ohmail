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

/** The same sink for the TLS shim, so both transports write through one logger. */
function socketLogLine(event, fields) {
  socketLog(event, fields);
}

/**
 * THE PLATFORM'S ERROR IS A STRING. Both natives emit a socket failure as its message alone
 * (Android `putString("error", e.getMessage())`, iOS `@"error" : msg`), so a classifier that reads
 * a code read nothing, and imapflow's strict-mode `err._connId = …` threw on the primitive. Every
 * error leaves this bridge an `Error`, with the errno its message carries: the token Android
 * prints (`ECONNREFUSED (Connection refused)`), else the sentence iOS prints. An `Error` passes.
 */
const ERRNO_IN_MESSAGE = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT)\b/;
const ERRNO_BY_SENTENCE = [
  [/connection refused/i, "ECONNREFUSED"],
  [/unable to resolve host|no address associated with hostname|nodename nor servname|name or service not known/i, "ENOTFOUND"],
  [/no route to host/i, "EHOSTUNREACH"],
  [/network is unreachable/i, "ENETUNREACH"],
  [/connection reset|reset by peer/i, "ECONNRESET"],
  [/connection abort/i, "ECONNABORTED"],
  [/broken pipe/i, "EPIPE"],
  [/timed out|failed to connect to .* after \d+ ?ms/i, "ETIMEDOUT"],
];

function nativeError(err) {
  if (err instanceof Error) return err;
  const message = typeof err === "string" && err !== "" ? err : "the connection failed and the platform gave no reason";
  const e = new Error(message);
  const token = ERRNO_IN_MESSAGE.exec(message);
  const code = token ? token[1] : ERRNO_BY_SENTENCE.find(([re]) => re.test(message))?.[1];
  if (code) e.code = code;
  return e;
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
  /* `mapError` lets the TLS shim name a refused handshake before any listener sees it; absent,
     the platform's error travels unchanged. */
  constructor(native, mapError) {
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
    this._handedToTls = false;

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
    native.on("error", (raw) => {
      /* HANDED TO TLS, the plain side carries nothing: the platform's TLS socket forwards every
         error here AND to its own listeners, so the TLS bridge already has this one. By flag,
         never by unlistening the native socket (its emitter is not ours to edit). */
      if (this._handedToTls) return;
      const err = nativeError(raw);
      this.emit("error", typeof mapError === "function" ? mapError(err) : err);
    });
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

  /**
   * AN ERROR NOBODY LISTENS FOR IS SAID, NEVER THROWN. This Duplex is node `events`, which
   * throws an unlistened `error`, and the mail client drops its listeners at an upgrade and at a
   * close: a write failing after a reset closed the app on 0.25.8 (TCP reset, 3 of 3). The one
   * door every bridge `error` goes through; a bridge WITH a listener gets the error unchanged.
   */
  emit(event, ...args) {
    if (event === "error" && this.listenerCount("error") === 0) {
      socketLog("socket_error_unlistened", {
        err: args[0],
        reason: "the mail server connection failed after nothing was listening for it; the " +
          "connection was closed rather than the error reaching the top of the app",
      });
      if (!this.destroyed) this.destroy();
      return false;
    }
    return super.emit(event, ...args);
  }

  _read() {
    if (!this._paused) return;
    this._paused = false;
    try { this.native.resume(); } catch { /* gone */ }
  }

  /** The connection is closed as far as this bridge or its platform socket can tell. */
  get _closedForWriting() {
    return this._connectionGone || this.destroyed || this.native.destroyed === true;
  }

  /**
   * THE ONE DOOR EVERY REFUSED WRITE PASSES, so the refusal is never silent.
   *
   * The mail client's queue writes in a microtask (`trySend` → `send`, which awaits its compiler
   * twice), so a connection can die between a command being dequeued and its bytes being
   * written. The stream layer's own refusal is what keeps that from throwing, and it does not
   * come back here to say it happened — so the LINE is written here, above it, and the refusal
   * itself is still the layer's. A dropped command with no record is the shape a person meets as
   * a mailbox that silently stopped.
   */
  write(chunk, encoding, callback) {
    if (this._closedForWriting) {
      socketLog("socket_write_after_close", {
        bytes: typeof chunk === "string" ? chunk.length : (chunk?.length ?? 0),
        reason: "a command was written to a connection that had already closed; the bytes were " +
          "refused and the write's caller told, rather than the platform's own error reaching " +
          "the top of a runtime that has no handler for one",
      });
    }
    return super.write(chunk, encoding, callback);
  }

  /**
   * AND THE SAME REFUSAL WHERE THE LAYER ABOVE CANNOT MAKE IT — the native is gone and no `close`
   * event said so, which is the shape the packaged artifact met. Destroyed FIRST so the report
   * cannot become an `error` emitted at a socket whose last listener was a spent `once`; the
   * pending write's callback is then the one thing told. No line here: `write` above already
   * wrote it for this chunk.
   */
  _write(chunk, encoding, callback) {
    if (this._connectionGone || this.native.destroyed === true) {
      const err = new Error("the mail server connection was closed before these bytes were written");
      err.code = "ERR_STREAM_DESTROYED";
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
  nativeError,
  setSocketLog,
  socketLogLine,
  isIP,
  isIPv4,
  isIPv6,
  /* A server is not merely unimplemented, it is refused: the phone is never a host, and that is an
     invariant rather than a missing feature. */
  createServer: unsupported("createServer"),
  Server: unsupported("Server"),
};
