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
 *
 * ── AND ANSWERING ON READ IS NOT ENOUGH, BECAUSE THE BUNDLER COPIES RATHER THAN READS ─────
 *
 * That was the whole of this file, and it did not work for the import form almost every consumer
 * writes. esbuild wires an ES import of a CommonJS module by walking the module's OWN PROPERTY
 * NAMES and defining one accessor per name on a fresh namespace object. A Proxy over an empty
 * target has no own property names, so the namespace came out EMPTY: `import { join } from
 * "node:path"` was `undefined`, and the call failed as `(0, import_node_path.join) is not a
 * function` — naming neither the module nor the member, which is the exact failure the paragraph
 * above claims to prevent. It was true only of `import path from "node:path"`, the form the
 * engine's own code mostly does not use.
 *
 * So the stub declares what it would have exported. `ownKeys` lists the real module's member
 * names and `getOwnPropertyDescriptor` answers a configurable, enumerable descriptor for each, so
 * the copy finds them and every copied member is a refusal that names itself. The names are a
 * MEASUREMENT of the real module rather than a list somebody curated — see
 * `node-absent-members.js`, and the interop test that recomputes it.
 *
 * The Proxy invariants this rests on: the target stays extensible and every descriptor handed back
 * is `configurable`, which is what makes it legal to report a property the target does not have.
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
