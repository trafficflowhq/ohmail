/**
 * The modules that are not there — `fs`, `fs/promises`, `os`, `path`, `http`, `https`, `child_process`. Reached only
 * by dependency code paths this app does not use (attachments from disk, temp files, a proxy dialler), so a refusal
 * is the right answer. It throws when CALLED, not when read: libraries do `const join = path.join` at module scope,
 * and throwing on access would fail while the bundle initialises, naming the import rather than the caller (`default`
 * must not throw either — interop reads it). Answering on read is not enough, because the bundler copies rather than
 * reads: esbuild walks the module's own property names, and a Proxy over an empty target has none, so the namespace
 * came out empty. So the stub declares what it would have exported: `ownKeys` lists the real module's members
 * (measured — see `node-absent-members.js`) and every copied member is a refusal that names itself.
 */
"use strict";

const TABLE = require("./node-absent-members.js");

/**
 * @param {string} moduleName the module this stands in for, as the failure should name it
 * @param {string[]} [members] its export names. Defaults to the measured list for `moduleName`.
 */
function absent(moduleName, members) {
  /* A NAME WITH NO MEASURED LIST IS A LOUD FAILURE, not an empty one. Falling back to `[]` would
     restore precisely the defect this file was changed to fix, for the one module nobody added to
     the table — and it would do it silently. This throws while the artifact is loading, which the
     bundle-loading guard catches on the first run. */
  if (members === undefined && !Object.hasOwn(TABLE, moduleName)) {
    throw new Error(
      `no export list is recorded for the absent module "${moduleName}". Add it to ` +
        "node-absent-members.js — without one, an ES import of this stub produces a namespace " +
        "with no members and every call fails as `undefined is not a function`, naming neither " +
        "the module nor the member.",
    );
  }
  const names = members ?? TABLE[moduleName].members;
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
    /* THE TWO TRAPS THE BUNDLER'S INTEROP READS. See the banner: without them the namespace it
       builds is empty and the refusal never happens. */
    ownKeys() { return [...names]; },
    getOwnPropertyDescriptor(_t, member) {
      if (typeof member === "symbol" || !names.includes(member)) return undefined;
      return { value: refuse(member), writable: true, enumerable: true, configurable: true };
    },
  });
}

module.exports = absent;
module.exports.absent = absent;
