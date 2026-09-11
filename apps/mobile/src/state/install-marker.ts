/**
 * The install generation — what makes "I deleted the app" a real take-back on iOS. Pairings
 * live in the platform keystore, and iOS Keychain items survive deleting the app, so a
 * reinstall used to reopen the mailbox with no ceremony. The app container does go with an
 * uninstall, so the marker is a table in its own SQLite database ({@link INSTALL_MARKER_DB}):
 * a marker absent or different means the keystore belongs to a gone install, and every
 * pairing is purged before a profile is read. Purge first, stamp second — a kill between them
 * repeats a no-op purge. An upgrade is not a reinstall: the mirrors live in the container too,
 * so a missing marker purges only when no named mirror exists. Unreadable = "unknown", never "fresh".
 */
import type { ServerProfileStore } from "./servers";
import { faultDetail, refuse, type Refusal } from "../refusal";
/* These `reason` fields reach the Servers screen through `Copy.serversInstallUnknown` and
   `serversPurgeRefused`, so they are copy. */
import { Copy } from "../copy";

/**
 * The two calls this module makes on a database — declared here, importing nothing.
 * `SqlExecutor` from the engine package satisfies it structurally, so the connection layer
 * hands its real deps straight in. Not imported, for two reasons pointing the same way: the
 * privacy census (`test/privacy.test.ts`) confines `engine/boot` and the engine package to a
 * named allow-list, and widening it to borrow two method signatures would pay in blast radius
 * for a type; and the narrower port is the better shape — this file opens one tiny local
 * table and has no business with mirrors, adapters or transports.
 */
export interface MarkerDb {
  all(sql: string, params?: ReadonlyArray<string>): Promise<ReadonlyArray<Record<string, unknown>>>;
  batch(statements: ReadonlyArray<{ sql: string; params?: ReadonlyArray<string> }>): Promise<void>;
  close?(): void | Promise<void>;
}

/** The platform capabilities this needs. `MobileEngineDeps` satisfies it structurally. */
export interface InstallMarkerHost {
  openExecutor: (dbName: string) => MarkerDb | Promise<MarkerDb>;
  uuid: () => string;
}

/**
 * The marker's own database, in the app container beside the mirrors. Deliberately NOT a
 * mirror name — `mirrorDbName` prefixes those, and a forget deletes by that name.
 */
export const INSTALL_MARKER_DB = "ohmail-install";

/** The single row. */
const GENERATION_KEY = "generation";

export type InstallVerdict =
  /** The marker this install wrote is still there — the keystore is ours. */
  | { kind: "same-install"; generation: string }
  /**
   * No marker, but the container still holds a MIRROR for a pairing the keystore names — so the
   * app was updated, not reinstalled. The marker is stamped and nothing is purged. See the
   * header for why a mirror is a sentinel a reinstall cannot forge.
   */
  | { kind: "upgrade"; generation: string }
  /** No marker: the container is new, so every stored pairing belongs to a dead install. */
  | { kind: "fresh-install"; generation: string; purged: true }
  /** The marker store could not be read. Nothing was purged; the reason is for the log. */
  | { kind: "unknown"; reason: Refusal }
  /**
   * The container is new, and the keystore REFUSED to give the old install's pairings up.
   *
   * Its own verdict rather than `unknown`, because the two say opposite things: `unknown` means
   * we could not ask, and this means we asked, acted, and a live credential is still on the
   * phone. The generation is deliberately NOT stamped, so every later launch tries again —
   * a purge that reported itself done over a surviving refresh token would be the take-back
   * class's own defect inside its own fix.
   */
  | { kind: "purge-refused"; reason: Refusal };

/**
 * Settle whether this launch belongs to the install that stored the pairings, purging them
 * when it does not. Called ONCE, at the top of the launch, before any profile is read.
 */
export async function settleInstallGeneration(
  deps: InstallMarkerHost,
  profiles: ServerProfileStore,
  /**
   * Does the app container still hold this pairing's mirror? Supplied by the caller — the engine
   * composition owns mirror names, and this module deliberately imports nothing from it (see
   * {@link MarkerDb}). Absent, every missing marker reads as a fresh install, which is the
   * conservative answer and the one this had before the sentinel existed.
   */
  hasMirror?: (profile: { origin: string; accountId: string }) => Promise<boolean>,
): Promise<InstallVerdict> {
  let db;
  try {
    db = await deps.openExecutor(INSTALL_MARKER_DB);
  } catch (err) {
    return { kind: "unknown", reason: refuse("installMarkerUnopenable", faultDetail(err)) };
  }
  try {
    await db.batch([
      { sql: "CREATE TABLE IF NOT EXISTS install (key TEXT PRIMARY KEY, value TEXT NOT NULL)" },
    ]);
    const rows = await db.all("SELECT value FROM install WHERE key = ?", [GENERATION_KEY]);
    const held = rows[0]?.value;
    if (typeof held === "string" && held !== "") return { kind: "same-install", generation: held };

    // NO MARKER — so either the container is new, or this is the first launch of the build that
    // introduced the marker. The mirrors tell them apart: a reinstall has none.
    const generation = deps.uuid();
    const stamp = async (): Promise<void> => {
      await db.batch([
        { sql: "INSERT OR REPLACE INTO install (key, value) VALUES (?, ?)", params: [GENERATION_KEY, generation] },
      ]);
    };
    if (hasMirror) {
      for (const profile of await profiles.list()) {
        if (await hasMirror(profile)) {
          await stamp();
          return { kind: "upgrade", generation };
        }
      }
    }

    // Nothing the keystore names has ever synced here, so anything it holds outlived its install.
    // The purge runs BEFORE the stamp, so a kill here is retried rather than skipped — and a
    // purge that could not complete THROWS, which lands on the arm below with the generation
    // still unwritten. Retried at every launch until it lands.
    try {
      await profiles.purgeAll();
    } catch (err) {
      return { kind: "purge-refused", reason: refuse("installPurgeFailed", faultDetail(err)) };
    }
    await stamp();
    return { kind: "fresh-install", generation, purged: true };
  } catch (err) {
    return { kind: "unknown", reason: refuse("installMarkerUnreadable", faultDetail(err)) };
  } finally {
    await db.close?.();
  }
}

/**
 * The stamped generation, read back — this install's durable id, and the only one.
 * `settleInstallGeneration` writes this row at launch and discards the value, so anything
 * needing the id later had nowhere to ask. The standalone door needs it: the organizer claim
 * is written against an install id, and a claim stamped with a second id is how one install
 * reads its own claim as somebody else's. So this reads the same row that function writes —
 * never a fresh uuid. `null` means the marker has not been settled (or could not be read):
 * a refusal for the caller to make, not a value to invent.
 */
export async function installGeneration(deps: InstallMarkerHost): Promise<string | null> {
  try {
    const db = await deps.openExecutor(INSTALL_MARKER_DB);
    const rows = await db.all("SELECT value FROM install WHERE key = ?", [GENERATION_KEY]);
    const held = rows[0]?.value;
    return typeof held === "string" && held !== "" ? held : null;
  } catch {
    return null;
  }
}
