/**
 * `url` — the platform's own WHATWG `URL`, not a reimplementation of it.
 *
 * The engine and its dependencies use `URL` and `URLSearchParams` for parsing and composing
 * addresses. Both are GLOBALS on this runtime, so there is nothing to polyfill: the correct shim is
 * one that hands the platform's implementation to code that expected to import it.
 *
 * A dedicated package would be worse than this file rather than more thorough — it would ship a
 * second URL parser beside the one the runtime already has, and two parsers that disagree about a
 * mail server's address is a class of bug with no upside.
 *
 * `parse`, `format` and `resolve` are Node's LEGACY API, deprecated for a decade and shaped
 * differently from `URL` (`parse` returns a loose object, tolerates nonsense, and its
 * `pathname`/`query` split differs). They are refused rather than approximated: a plausible-looking
 * legacy shim is how a caller gets a subtly wrong address with no error at all, and nothing in this
 * engine's own code uses them.
 */
"use strict";

const refuse = (member) => () => {
  throw new Error(
    `url.${member}() is not available in this app. It is Node's legacy URL API, whose shape ` +
      "differs from the standard `URL` this runtime provides; approximating it would answer a " +
      "subtly wrong address rather than fail. Use `new URL(...)`.",
  );
};

module.exports = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath: refuse("fileURLToPath"),
  pathToFileURL: refuse("pathToFileURL"),
  parse: refuse("parse"),
  format: refuse("format"),
  resolve: refuse("resolve"),
  default: { URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams },
};
