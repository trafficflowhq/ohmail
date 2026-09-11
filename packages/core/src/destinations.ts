/**
 * THE ORGANIZED DESTINATIONS, on their own browser-safe subpath.
 *
 * `DESTINATIONS` and `isOrganizedFolder` live in `types.ts` — a module with NO imports, which is
 * its contract (see the header of `DESTINATIONS`). This leaf is what makes that reachable from a
 * graph that cannot load this package's barrel.
 *
 * ── WHY A LEAF AND NOT THE BARREL ────────────────────────────────────────────────────────────
 *
 * `@trafficflow/core`'s `.` entry resolves to `dist/`, which is a BUILD OUTPUT: it exists only
 * after `tsc -b`, and it is not in the tree. Every consumer that reaches the barrel therefore
 * needs a build ordered ahead of it — a project reference, or a build step. The webapp has
 * neither: it typechecks with a bare `tsc --noEmit` and nothing builds this package for it, so a
 * bare-barrel import there resolves or fails according to whether somebody happened to have built
 * `dist` earlier, and the failure reads as "Cannot find module", not as "run a build first".
 *
 * The source subpaths — this one, `./ics`, `./folder-name`, `./drain-policy`, `./reply-subject`,
 * `./search-rank` — point at `src/` and are therefore always resolvable, with no build and no
 * ordering. That is the first reason.
 *
 * That still holds for every bundler AND for every typecheck. The one consumer it does not hold
 * for is plain NODE, which cannot follow a relative import out of a `.ts` it resolved from an
 * exports map — and this leaf and `./folder-name` both re-export from `./types.js`. So those two
 * subpaths carry a `node` condition naming their compiled twin, with `types` ahead of it so no
 * typecheck reads a build output. See `//node-condition` in the manifest.
 *
 * The second is the one `folder-name.ts` was written for and matters more: the barrel carries
 * `mailparser` and `node:crypto`, so it must stay UNREACHABLE from the browser graph. Making it
 * resolve from the webapp to fix a type error would remove the wall that makes such an import
 * fail loudly, for the sake of a six-string list that has no dependencies at all.
 */
export { DESTINATIONS, isOrganizedFolder, type Destination } from "./types.js";
