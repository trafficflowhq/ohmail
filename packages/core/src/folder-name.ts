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
  /**
   * "IS THIS PATH THE MAILBOX'S SENT FOLDER" — the client mirrors' half of the folder vocabulary.
   *
   * Here for this leaf's whole reason: `packages/client-engine` has to tell the account's OWN
   * SENT MAIL from a message that merely lives in some folder of the mailbox, and the only other
   * home of that question is `@trafficflow/core/adapters/imap-types`, which the browser/phone
   * bundle cannot reach. The alternative was a second copy of the regex in the engine — the drift
   * `RESERVED_FOLDER_LEAF` is re-exported here rather than copied to avoid.
   */
  isSentFolderPath,
} from "./types.js";
