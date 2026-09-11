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
import { secureKV } from "../state/servers-native";
import {
  ENGINE_DB_FILE,
  openLocalEnginePlatform,
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

/** What the connect screen hands to the engine factory it loaded from the bundle. */
export function nativeEnginePlatform(): Promise<LocalEnginePlatformVerdict> {
  return openLocalEnginePlatform({
    openDatabase: openEngineDatabase,
    kv: secureKV(),
    randomKekHex: expoRandomKekHex,
  });
}
