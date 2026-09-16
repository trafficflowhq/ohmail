/**
 * The organized destinations and the retro-move question, on their own browser-safe subpath.
 * `DESTINATIONS`, `isOrganizedFolder` and `retroPassWouldMove` live in `types.ts`, a module with
 * no imports; this leaf makes them reachable from a graph that cannot load the barrel. Two
 * reasons: the barrel resolves to
 * `dist/`, a build output — the webapp typechecks with a bare `tsc --noEmit`, so a barrel import
 * fails as "Cannot find module" depending on whether somebody built earlier. And the barrel
 * carries `mailparser` and `node:crypto`, so it must stay unreachable from the browser graph —
 * making it resolve to fix a type error would remove the wall, for a six-string list with no
 * dependencies.
 */
export {
  DESTINATIONS, isOrganizedFolder, retroPassWouldMove,
  type Destination, type RetroCandidateRow,
} from "./types.js";
