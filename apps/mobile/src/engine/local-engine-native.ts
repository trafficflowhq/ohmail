/**
 * The real platform bindings for the engine's store and key — the one file that imports expo
 * here. `local-engine.ts` holds the logic and imports nothing native (`servers-native.ts`
 * established the split: expo packages carry Flow-typed JavaScript the node suite's transform
 * refuses with a parse error naming neither the package nor the import). The suite never loads
 * this file. Three bindings, nothing else: the database opener — the engine's own file, never
 * the UI mirror's; the keystore — the app's existing seam, not a second one; and the random
 * source — the platform's CSPRNG, not `Math.random` and not a hash of anything: this is the key
 * that opens a mailbox password, and a predictable one is no key at all.
 */
import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import { nativeServerProfiles, secureKV } from "../state/servers-native";
import {
  ENGINE_DB_FILE,
  openLocalEnginePlatform,
  removeStandaloneEngine,
  type EngineRemovalRecord,
  type EngineStoreDatabase,
  type LocalEnginePlatformVerdict,
} from "./local-engine";
import type { RandomKekHex } from "./kek";

/** 32 bytes of platform randomness as lower-case hex — the desktop's key spelling. */
export const expoRandomKekHex: RandomKekHex = () =>
  Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");

/** The engine's own database file. Distinct from every mirror name by construction. */
export async function openEngineDatabase(name: string = ENGINE_DB_FILE): Promise<EngineStoreDatabase> {
  return (await SQLite.openDatabaseAsync(name)) as unknown as EngineStoreDatabase;
}

/**
 * REMOVE that same file — the deleter named against the OPENER above, and the pairing is the
 * whole of whether a removal removes anything. The mirror's deleter wraps its argument in
 * `dbFileName` because the mirror's opener does; this file is opened by its own bare name, so
 * wrapping it here would delete `ohmail-engine.db.db` — a database nothing ever wrote to — and
 * report a completed removal over a mailbox still on the phone. `test/forget.test.ts` reads this
 * module as text and refuses the pair drifting.
 *
 * Swallowed, on `nativeEngineDeps().deleteDatabase`'s rule: `deleteDatabaseAsync` rejects on a
 * name that is not there, and the caller's own read-back is the only thing that decides whether
 * the removal landed — a deleter that silently did nothing is caught by the probe, not by a catch.
 */
export async function deleteEngineDatabase(name: string = ENGINE_DB_FILE): Promise<void> {
  try {
    await SQLite.deleteDatabaseAsync(name);
  } catch {
    /* absent, or held: the caller's read-back is the judge */
  }
}

/** The durable removal record, as the bootstrap's port. One store for the app's lifetime. */
function engineRemovalRecord(): EngineRemovalRecord {
  const profiles = nativeServerProfiles();
  return {
    recorded: () => profiles.engineRemoval(),
    clear: () => profiles.clearEngineRemoval(),
  };
}

/** What the connect screen hands to the engine factory it loaded from the bundle. */
export function nativeEnginePlatform(): Promise<LocalEnginePlatformVerdict> {
  return openLocalEnginePlatform({
    openDatabase: openEngineDatabase,
    deleteDatabase: deleteEngineDatabase,
    kv: secureKV(),
    randomKekHex: expoRandomKekHex,
    removal: engineRemovalRecord(),
  });
}

/** The take-back's engine half, bound to this platform — `PairingEnv.standalone.removeEngine`. */
export function nativeRemoveStandaloneEngine(): Promise<void> {
  return removeStandaloneEngine({
    openDatabase: openEngineDatabase,
    deleteDatabase: deleteEngineDatabase,
    kv: secureKV(),
  });
}
