/**
 * THE FOLDER-NAME VALIDATOR, on its own browser-safe subpath.
 *
 * `folderNameError` lives in `types.ts` — a module with NO imports, which is its contract (see
 * the header of `DESTINATIONS`). The webapp needs the SAME validator for the honest sentence
 * BEFORE the wire (FOLDERS-SPEC.md stage 2), and it cannot reach `@trafficflow/core/mail`: the
 * mail barrel carries mailparser and `node:crypto` (the note in `MessageBody.tsx` is the
 * measurement). This leaf re-exports exactly the name rules and nothing else — the `/ics`
 * subpath's precedent, for the same reason.
 */
export {
  FOLDER_PATH_MAX,
  RESERVED_FOLDER_LEAF,
  folderNameError,
  type FolderNameError,
} from "./types.js";
