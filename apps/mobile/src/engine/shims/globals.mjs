/**
 * THE GLOBALS THE BUNDLER BINDS AT BUILD TIME — `Buffer` and a `process` stand-in.
 *
 * A THIRD global was considered and rejected. `crypto.randomUUID()` was read as a free global by
 * two modules and Hermes has no such global, so a phone died on it; the answer was to stop reading
 * a global, not to bind one. Injecting it here would have meant importing a native package into
 * the one shim the node-side suite loads directly, which its transform cannot parse.
 *
 * Injected rather than imported, and the distinction is the whole file. Aliasing the `buffer`
 * MODULE serves code that imports it; mail parsing is full of `Buffer.from` and `Buffer.concat`
 * written against the GLOBAL, which no alias reaches. The runtime then answers
 * `ReferenceError: Property 'Buffer' doesn't exist` from inside a drain — after a successful
 * launch, a successful connection and a successful fetch, which is the worst place for a module
 * error to surface and nowhere near anything that names a polyfill.
 *
 * Binding it at BUNDLE time means it cannot depend on load order: every module in the artifact sees
 * it, including the ones that run while the bundle is still initialising.
 *
 * ── THE `process` STAND-IN IS DELIBERATELY THIN ───────────────────────────────────────────
 *
 * Libraries read `process.env.SOMETHING`, `process.nextTick` and `process.platform` at module
 * scope. Each is answered with the least surprising thing rather than the most complete one:
 *
 *  · `env` is EMPTY and stays empty. A phone has no environment, and the one thing this must never
 *    do is invent values — a library reading `process.env.NODE_DEBUG` and finding something would
 *    start logging, and an engine that logs mail content on a device is a privacy failure rather
 *    than a noisy one.
 *  · `nextTick` is a microtask, which is what it is. Using a timer instead would reorder work
 *    relative to promise resolution, and the stream implementations here depend on that order.
 *  · `platform` says what this is. Claiming a desktop platform would take library code down
 *    branches written for one.
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
   * `emit` IS NODE'S DEFAULT FOR AN UNWATCHED REJECTION, AND IT IS THE ONE MEMBER HERE THAT MAY
   * NOT ANSWER QUIETLY.
   *
   * `lie` — the promise implementation inside the zip library — announces a rejection nobody
   * handled by calling `process.emit("unhandledRejection", error, promise)` from a deferred
   * callback (`lie/lib/index.js:148`). The stand-in had no such member, so what a phone got was
   * `processShim.emit is not a function` thrown out of a timer: a TypeError about this file,
   * carrying no trace of the failure it was announcing.
   *
   * RETHROWN, not swallowed. Node with no `unhandledRejection` listener terminates on the
   * rejection itself, so the throw is the platform's own behaviour and, more usefully, it is the
   * only shape in which the CAUSE survives — a no-op would turn "the archive could not be read"
   * into a silence, which is the class of defect this whole shim directory exists to stop being
   * discovered on a device. A non-`Error` reason is wrapped rather than thrown raw, because a
   * thrown string arrives at a catch with `errorClass: "String"` and no message at all.
   *
   * Every OTHER event answers `false`, which is what Node's `EventEmitter#emit` returns when
   * nothing is listening — and nothing is, because `on`/`once` above register nothing. A `true`
   * here would tell a caller its notice had been delivered somewhere.
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
