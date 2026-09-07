/**
 * THE GLOBALS THE BUNDLER BINDS AT BUILD TIME — `Buffer` and a `process` stand-in.
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
import { Buffer as BufferPolyfill } from "buffer";

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
