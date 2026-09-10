/**
 * THE REAL PLATFORM BINDINGS FOR THE ENGINE'S STORE AND KEY — the one file that imports expo here.
 *
 * `local-engine.ts` holds the logic and imports nothing native, for the reason its own banner gives
 * and `servers-native.ts` established before it: the expo packages carry Flow-typed JavaScript, so
 * a module that imports them cannot be loaded by the node-side suite at all — the transform refuses
 * with a parse error that names neither the package nor the import that reached it. This file is
 * the other half of that split, and the suite never loads it.
 *
 * Three bindings, and nothing else belongs here:
 *
 *  · the database opener — the engine's OWN file, never the UI mirror's;
 *  · the keystore, which is the app's existing seam rather than a second one for the engine;
 *  · the random source, which is the platform's CSPRNG. Not `Math.random` and not a hash of
 *    anything: this is the key that opens a mailbox password, and a predictable one is the same as
 *    no key at all.
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
