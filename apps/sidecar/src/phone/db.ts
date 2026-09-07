/**
 * THE DESKTOP'S STORE, ABSENT — substituted for `../db.js` in the phone's engine bundle.
 *
 * `../db.js` is the desktop's PGlite door: it creates a data directory, takes an exclusive lock on
 * it, instantiates a WASM Postgres, adopts the SERVER's migration journal and runs the server's
 * migrator. Every one of those is either impossible on a phone or the wrong thing there, and the
 * module's own imports (`node:fs`, `node:os`, `node:path`, PGlite) are the largest single reason
 * the phone's bundle would otherwise carry a filesystem.
 *
 * ── TWO MECHANISMS, AND THEY ANSWER DIFFERENT QUESTIONS ───────────────────────────────────
 *
 * `SidecarConfig.store` is the SEAM: the phone's composition root opens its own SQLite store and
 * hands it over, so `openLocalDb` is never called. That is what makes the composition correct.
 *
 * This substitution is what makes the absence a FACT ABOUT THE ARTIFACT rather than a promise about
 * which branch runs — PGlite, the lock and `node:fs` are not in the file at all. The metafile
 * census asserts it, and removing this alias turns the census red.
 *
 * So the thrower below is unreachable twice over, and it is still a thrower rather than a stub that
 * returns something: a store that answered would be a phone quietly running on a database nobody
 * composed, which is worse than a refusal naming the seam.
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
