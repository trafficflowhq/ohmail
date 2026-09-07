/**
 * THE MODULES THAT ARE NOT THERE — `fs`, `fs/promises`, `os`, `path`, `http`, `https`,
 * `child_process`.
 *
 * Reached only by dependencies that carry code paths this app does not use: the mail sender's
 * attachment-from-disk helpers, the MIME splitter's temporary files, and a proxy dialler. Nothing
 * on the phone's own path touches any of them, which is what makes a refusal the right answer
 * rather than an implementation.
 *
 * ── IT THROWS WHEN CALLED, NOT WHEN READ, AND THAT IS DELIBERATE ──────────────────────────
 *
 * Libraries read properties off these modules at module scope — `const join = path.join` at the top
 * of a file that may never call it. A stub that threw on property ACCESS would therefore fail while
 * the bundle was still initialising, before anything had asked for a file, and the stack would name
 * the import rather than the caller. Answering a function for every property moves the failure to
 * the line that actually needed a filesystem, and names both the module and the member.
 *
 * The one property that must NOT throw is `default`: bundler interop reads it while wiring a
 * CommonJS module into an ES import, and throwing there would break the graph at load.
 */
"use strict";

function absent(moduleName) {
  const refuse = (member) => () => {
    throw new Error(
      `${moduleName}.${member}() is not available in this app. The mail engine runs inside the ` +
        "app rather than in a Node process, so there is no filesystem, no HTTP client and no " +
        "child process here. Reaching this means a code path that was believed unused on a phone " +
        "was taken.",
    );
  };
  const target = {};
  return new Proxy(target, {
    get(_t, member) {
      if (member === "default") return undefined;
      if (member === "__esModule") return false;
      // A symbol member (e.g. `Symbol.toStringTag`, or a `util.inspect` probe) must answer a value
      // rather than a function, or logging a reference to this object throws.
      if (typeof member === "symbol") return undefined;
      return refuse(String(member));
    },
    has() { return true; },
  });
}

module.exports = absent;
module.exports.absent = absent;
