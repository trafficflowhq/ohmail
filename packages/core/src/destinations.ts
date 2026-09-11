/**
 * The organized destinations, on their own browser-safe subpath. `DESTINATIONS` and
 * `isOrganizedFolder` live in `types.ts`, a module with no imports; this leaf makes that
 * reachable from a graph that cannot load the barrel. Two reasons: the barrel resolves to
 * `dist/`, a build output — the webapp typechecks with a bare `tsc --noEmit`, so a barrel import
 * fails as "Cannot find module" depending on whether somebody built earlier. And the barrel
 * carries `mailparser` and `node:crypto`, so it must stay unreachable from the browser graph —
 * making it resolve to fix a type error would remove the wall, for a six-string list with no
 * dependencies.
 */
export { DESTINATIONS, isOrganizedFolder, type Destination } from "./types.js";
