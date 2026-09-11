/**
 * The globals the bundler binds at build time — `Buffer` and a `process` stand-in. Injected rather than
 * imported, and the distinction is the whole file: aliasing the `buffer` module serves code that imports it,
 * while mail parsing writes `Buffer.from` against the GLOBAL, which no alias reaches — the runtime then dies
 * inside a drain, nowhere near anything naming a polyfill. Binding at bundle time cannot depend on load
 * order. A third global (`crypto.randomUUID`) was rejected: the answer was to stop reading a global. The
 * `process` stand-in is deliberately thin: `env` is empty and stays empty (a library finding `NODE_DEBUG`
 * would start logging, and an engine that logs mail content on a device is a privacy failure); `nextTick` is
 * a microtask (a timer would reorder work the streams depend on); `platform` says what this is.
 */
/* ESM, and that is not a style choice: the bundler's `inject` binds the NAMES a module exports, so
   the exports have to be statically visible. A CommonJS `module.exports = { … }` relies on the
   bundler lifting an object literal into named exports, which is a behaviour to depend on rather
   than a contract. `.mjs` states the module kind as a fact instead of inheriting it from a
   `package.json` two directories up. */
/* THE WRAPPED CLASS, not the raw package. The global bound here and the `Buffer` any module
   imports have to be ONE class: mail parsing writes `Buffer.from` against the global, and binding
   the unpatched polyfill here would leave exactly that code without `base64url` while every module
   that imports `buffer` had it — the same defect one indirection further away. */
import { Buffer as BufferPolyfill } from "./buffer.js";

const Buffer = BufferPolyfill;

const processShim = {
  env: {},
  platform: "android",
  version: "",
  versions: {},
  argv: [],
  nextTick: (fn, ...args) => { Promise.resolve().then(() => fn(...args)); },
  /* Read by stream implementations for high-resolution timing. Monotonic and cheap. */
  hrtime: Object.assign(
    (previous) => {
      const now = Date.now() * 1e6;
      const ns = previous ? now - (previous[0] * 1e9 + previous[1]) : now;
      return [Math.floor(ns / 1e9), Math.floor(ns % 1e9)];
    },
    { bigint: () => BigInt(Date.now()) * 1000000n },
  ),
  emitWarning: () => undefined,
  /**
   * `emit` is Node's default for an unwatched rejection, and it is the one member here that may not
   * answer quietly. `lie` — the promise implementation inside the zip library — announces an unhandled
   * rejection by calling `process.emit("unhandledRejection", …)` from a deferred callback; with no such
   * member a phone got `processShim.emit is not a function` out of a timer, carrying no trace of the
   * failure it was announcing. Rethrown, not swallowed: Node with no listener terminates on the
   * rejection itself, and the throw is the only shape in which the cause survives. A non-`Error` reason
   * is wrapped (a thrown string arrives with `errorClass: "String"` and no message). Every other event
   * answers `false` — what `EventEmitter#emit` returns when nothing is listening, and nothing is.
   */
  emit: (event, ...args) => {
    if (event === "unhandledRejection" || event === "uncaughtException") {
      const reason = args[0];
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
    return false;
  },
  on: () => processShim,
  once: () => processShim,
  off: () => processShim,
  removeListener: () => processShim,
  listeners: () => [],
  cwd: () => "/",
  exit: () => undefined,
};

export { Buffer };
export { processShim as process };
