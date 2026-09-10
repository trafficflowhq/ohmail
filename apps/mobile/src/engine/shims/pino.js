/**
 * THE LOGGER THE MAIL CLIENT LOADS WHETHER OR NOT IT LOGS — and the reason this file is CommonJS.
 *
 * `imapflow/lib/logger.js` loads this module and CALLS the export AT MODULE LOAD, before anything
 * has decided
 * whether logging is on. The adapter passes `logger: false` and the client then never uses the
 * result, but the call has already happened — and the real package needs worker threads and a
 * filesystem sink, neither of which exists here.
 *
 * ── THIS FILE IS COMMONJS ON PURPOSE, AND IT IS THE MEASURED CASE ─────────────────────────
 *
 * A stub consumed by `require` must itself be CommonJS. An ES module handed to `require` arrives as
 * a NAMESPACE OBJECT, so calling the loaded value throws "pino is not a function" — inside the client's
 * own module initialisation, with a stack that names the logger and nothing that names a polyfill.
 * `module.exports = fn` is what makes the call work.
 *
 * ── IT DISCARDS RATHER THAN REFUSING, WHICH IS THE OPPOSITE OF THE OTHER STUBS HERE ───────
 *
 * The other shims throw, because reaching them means a path nobody expected was taken. This one is
 * reached on EVERY launch by design, so throwing would stop the app from starting. Discarding is
 * also the correct behaviour rather than a compromise: the engine has its own redacting logger, and
 * the one thing a second, unredacted log must never do on a device is write mail content or a
 * credential anywhere. A logger that keeps nothing cannot leak anything.
 */
"use strict";

const NOOP = () => undefined;

function makeLogger() {
  const logger = {
    level: "silent",
    trace: NOOP,
    debug: NOOP,
    info: NOOP,
    warn: NOOP,
    error: NOOP,
    fatal: NOOP,
    silent: NOOP,
    /* The client builds per-connection children. Returning THIS rather than a fresh object keeps
       the shape stable however deeply it nests, and there is no state to keep apart. */
    child() { return logger; },
    bindings() { return {}; },
    flush: NOOP,
    isLevelEnabled() { return false; },
  };
  return logger;
}

/** Callable, because the loader calls the value it gets straight back. */
function pino() {
  return makeLogger();
}

pino.destination = () => ({ write: NOOP });
pino.transport = () => ({ write: NOOP });
pino.stdSerializers = { err: (e) => e, req: (r) => r, res: (r) => r };
pino.stdTimeFunctions = { isoTime: () => "" };
pino.levels = { values: {}, labels: {} };
pino.pino = pino;
pino.default = pino;

module.exports = pino;
