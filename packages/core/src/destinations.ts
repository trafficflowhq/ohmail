/**
 * The organized destinations and the retro-move question, on their own browser-safe subpath.
 * `DESTINATIONS`, `isOrganizedFolder` and `retroPassWouldMove` live in `types.ts`, a module with
 * no imports; this leaf makes them reachable from a graph that cannot load the barrel. Two
 * reasons: the barrel resolves to `dist/`, a build output the webapp's bare `tsc --noEmit` cannot
 * know anybody built, so importing it fails as "Cannot find module" depending on history. And the
 * barrel carries `mailparser` and `node:crypto`, which must stay unreachable from the browser
 * graph — making it resolve to fix a type error would remove that wall, for a six-string list and
 * one function with no dependencies at all.
 */
export {
  DESTINATIONS, isOrganizedFolder, retroPassWouldMove,
  // The News pile's resolver family (0.22) — same leaf, same reason: mirrors and views classify
  // folder strings that predate the rename and cannot load the barrel.
  NEWS_FOLDER, LEGACY_NEWS_FOLDER, canonicalDestination, isNewsFolder, pileFolder,
  type Destination, type RetroCandidateRow,
} from "./types.js";
