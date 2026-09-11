/**
 * `url` — the platform's own WHATWG `URL`, not a reimplementation. `URL` and `URLSearchParams`
 * are globals on this runtime, so the correct shim hands the platform's implementation to code
 * that expected to import it; a dedicated package would ship a second URL parser beside the one
 * the runtime has, and two parsers that disagree about a mail server's address is a class of bug
 * with no upside. `parse`, `format` and `resolve` are Node's legacy API, shaped differently from
 * `URL` — refused rather than approximated: a plausible-looking legacy shim is how a caller gets
 * a subtly wrong address with no error, and nothing in this engine uses them.
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
