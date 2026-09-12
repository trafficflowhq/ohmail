/**
 * The desktop's store, absent — substituted for `../db.js` in the phone's engine bundle. `../db.js`
 * is the desktop's PGlite door (a data directory, an exclusive lock, a WASM Postgres, the server's
 * migrator), every part impossible or wrong on a phone, and its imports (`node:fs`, `node:os`,
 * `node:path`, PGlite) are the largest reason the bundle would otherwise carry a filesystem.
 * `SidecarConfig.store` is the SEAM — the phone hands its own SQLite store over, so `openLocalDb` is
 * never called — and this substitution makes the absence a FACT ABOUT THE ARTIFACT (PGlite, the lock
 * and `node:fs` are not in the file), asserted by the metafile census. The thrower below is
 * unreachable twice over and still a thrower: a store that answered would be a phone on a database nobody composed.
 */
import type { OpenLocalDb } from "../db.js";

export type { LocalDb, LocalDbOpenPhase, OpenLocalDb } from "../db.js";

export async function openLocalDb(
  _dataDir: string,
  _opts: { log?: unknown; onPhase?: unknown } = {},
): Promise<OpenLocalDb> {
  throw new Error(
    "openLocalDb was reached on the phone's engine bundle. The phone composes its store itself " +
      "and passes it as `SidecarConfig.store`; this module exists so that the desktop's PGlite " +
      "door, its lock and its filesystem imports are absent from the artifact. Reaching it means " +
      "a composition did not pass a store.",
  );
}
