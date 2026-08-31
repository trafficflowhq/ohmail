/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE INSTALL GENERATION — what makes "I deleted the app" a real take-back on iOS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE ASYMMETRY THIS EXISTS FOR ─────────────────────────────────────────────────────────
 *
 * The pairings live in the platform keystore (`servers-native.ts`, expo-secure-store under
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`), and that choice is right: it is what keeps a refresh
 * token out of every cloud and OS backup. It has one consequence the posture never stated.
 * **iOS Keychain items survive deleting the app** and are readable again by the same bundle
 * id; Android's Keystore-backed preferences go with the app data. So on an iPhone, deleting
 * ohmail and installing it again used to reopen the mailbox with no ceremony at all — the
 * launch effect reads the active profile and connects it — against a refresh family the
 * shipped configuration keeps alive for 400 rolling days.
 *
 * "I deleted the app" is a take-back gesture people believe in. It has to be one.
 *
 * ── THE MARKER IS THE ONE THING iOS DOES REMOVE ───────────────────────────────────────────
 *
 * The app CONTAINER goes with an uninstall on both platforms, and this app already has a
 * store that lives in it: SQLite, behind {@link InstallMarkerHost.openExecutor}. So the
 * generation marker is a two-column table in a database of its own ({@link INSTALL_MARKER_DB})
 * — no new dependency, no new platform seam, and the node suite drives it through the same
 * double it drives every mirror through.
 *
 * A marker that is ABSENT (uninstalled, or never installed) or DIFFERENT from the one this
 * launch expects means the keystore's contents belong to an install that no longer exists, and
 * every pairing in it is purged before a single profile is read.
 *
 * ── THE ORDER, AND WHAT A KILL IN THE MIDDLE COSTS ────────────────────────────────────────
 *
 * Purge FIRST, stamp SECOND. A kill between them repeats the purge on the next launch, which
 * is a no-op on an already-empty keystore; the reverse order would stamp an install whose
 * credentials were still there and never look again.
 *
 * ── AND THE HONEST COST, STATED RATHER THAN HIDDEN ────────────────────────────────────────
 *
 * The FIRST launch of a build carrying this file finds no marker, because no earlier build
 * ever wrote one — so it purges, and everyone who had already paired re-pairs once. That is
 * indistinguishable from a reinstall by construction: there is no evidence on the device that
 * separates "upgraded" from "reinstalled", and a scheme that guessed would be a scheme that
 * guessed wrong on the security-relevant half. One QR scan is the app's own stated recovery
 * ceremony, and it is the price of the property being real from the second launch onward.
 *
 * ── A STORE THAT WILL NOT OPEN IS "UNKNOWN", NEVER "FRESH" ────────────────────────────────
 *
 * Treating an unreadable marker store as a fresh install would let a transient SQLite failure
 * delete every pairing on the phone — a far worse outcome than the residue this closes, and one
 * an ordinary user would meet by unlucky timing rather than by uninstalling. So the failure
 * arm proceeds with the pairings intact and says so; the case that matters (a genuine
 * reinstall) has a working SQLite by definition, because the app just launched.
 */
import type { ServerProfileStore } from "./servers";

/**
 * The two calls this module makes on a database — declared HERE, importing nothing.
 *
 * `SqlExecutor` from the engine package satisfies it structurally, so the connection layer
 * hands its real deps straight in. It is not IMPORTED for two reasons that point the same way:
 * the privacy census (`test/privacy.test.ts`) confines both `engine/boot` and the engine package
 * itself to a named allow-list, and widening that list so a state module can borrow two method
 * signatures would be paying in blast radius for a type. And the narrower port is the better
 * shape anyway — this file opens one tiny local table and has no business with mirrors,
 * adapters or transports.
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
  /** No marker: the container is new, so every stored pairing belongs to a dead install. */
  | { kind: "fresh-install"; generation: string; purged: true }
  /** The marker store could not be read. Nothing was purged; the reason is for the log. */
  | { kind: "unknown"; reason: string }
  /**
   * The container is new, and the keystore REFUSED to give the old install's pairings up.
   *
   * Its own verdict rather than `unknown`, because the two say opposite things: `unknown` means
   * we could not ask, and this means we asked, acted, and a live credential is still on the
   * phone. The generation is deliberately NOT stamped, so every later launch tries again —
   * a purge that reported itself done over a surviving refresh token would be the take-back
   * class's own defect inside its own fix.
   */
  | { kind: "purge-refused"; reason: string };

/**
 * Settle whether this launch belongs to the install that stored the pairings, purging them
 * when it does not. Called ONCE, at the top of the launch, before any profile is read.
 */
export async function settleInstallGeneration(
  deps: InstallMarkerHost,
  profiles: ServerProfileStore,
): Promise<InstallVerdict> {
  let db;
  try {
    db = await deps.openExecutor(INSTALL_MARKER_DB);
  } catch (err) {
    return { kind: "unknown", reason: `the install marker could not be opened: ${String(err)}` };
  }
  try {
    await db.batch([
      { sql: "CREATE TABLE IF NOT EXISTS install (key TEXT PRIMARY KEY, value TEXT NOT NULL)" },
    ]);
    const rows = await db.all("SELECT value FROM install WHERE key = ?", [GENERATION_KEY]);
    const held = rows[0]?.value;
    if (typeof held === "string" && held !== "") return { kind: "same-install", generation: held };

    // No marker ⇒ this container is new ⇒ anything the keystore holds outlived its install.
    // The purge runs BEFORE the stamp, so a kill here is retried rather than skipped — and a
    // purge that could not complete THROWS, which lands on the arm below with the generation
    // still unwritten. Retried at every launch until it lands.
    try {
      await profiles.purgeAll();
    } catch (err) {
      return { kind: "purge-refused", reason: `the old install's pairings could not be purged: ${String(err)}` };
    }
    const generation = deps.uuid();
    await db.batch([
      { sql: "INSERT OR REPLACE INTO install (key, value) VALUES (?, ?)", params: [GENERATION_KEY, generation] },
    ]);
    return { kind: "fresh-install", generation, purged: true };
  } catch (err) {
    return { kind: "unknown", reason: `the install marker could not be read: ${String(err)}` };
  } finally {
    await db.close?.();
  }
}
