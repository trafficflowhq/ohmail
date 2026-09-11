/**
 * The logger the mail client loads whether or not it logs — and the reason this file is CommonJS.
 * `imapflow/lib/logger.js` calls the export at module load, before anything decides whether logging is
 * on; the adapter passes `logger: false`, but the call has already happened and the real package needs
 * worker threads and a filesystem sink. CommonJS on purpose, the measured case: an ES module handed to
 * `require` arrives as a namespace object, so calling it throws "pino is not a function" inside the
 * client's own init. It discards rather than refusing — the opposite of the other stubs — because it is
 * reached on every launch by design, and discarding is also correct: the engine has its own redacting
 * logger, and a second, unredacted log must never write mail content or a credential anywhere.
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
