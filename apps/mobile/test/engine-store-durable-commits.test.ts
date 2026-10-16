/**
 * THE ENGINE STORE KEEPS AN ACKNOWLEDGED COMMIT THROUGH A POWER CUT.
 *
 * The phone's engine store (`ohmail-engine.db`) is the authority for a standalone mailbox, and
 * expo-sqlite opens it with SQLite's defaults: a rollback journal at synchronous FULL. That commit
 * is the journal's unlink with no directory sync after it, so a power cut just after it can bring
 * the journal back and the next open rolls the commit away. The mirror store already runs at EXTRA
 * (`sql-store.ts`); the engine store's one open path, `openLocalEnginePlatform`, now does too, and
 * reads it back.
 *
 * A power cut cannot be staged here, so these cases pin the setting on the connection the engine
 * receives — real SQLite on a real file, through the platform's API shape — and the refusal when
 * the setting does not take. The control is the same file opened without the platform: FULL.
 */
import { describe, expect, it } from "vitest";
import {
  ENGINE_DB_FILE,
  ENGINE_DURABLE_COMMITS,
  SYNCHRONOUS_EXTRA,
  expoEngineExecutor,
  openLocalEnginePlatform,
  type EngineStoreDatabase,
  type LocalEnginePlatformVerdict,
} from "../src/engine/local-engine";
import { KEK_KEY } from "../src/engine/kek";
import { StoreFault, type SecureKV } from "../src/state/servers";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";
import { engineStoreWorld } from "./helpers/expo-sqlite-shape";

function memoryKV(): SecureKV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => { map.set(k, v); },
    remove: async (k) => { map.delete(k); },
  };
}

const noRemoval = { recorded: async () => null, clear: async () => undefined };

describe("the engine store's commits are durable", () => {
  it("the connection the engine receives runs at synchronous EXTRA; a bare open of the same file does not", async () => {
    const w = engineStoreWorld();
    try {
      const platform: LocalEnginePlatformVerdict = await openLocalEnginePlatform({
        openDatabase: w.open, deleteDatabase: w.drop, kv: memoryKV(),
        randomKekHex: () => "a".repeat(64), removal: noRemoval,
      });
      expect(platform.kind).toBe("ready");
      if (platform.kind !== "ready") return;
      expect((await platform.exec.all("PRAGMA synchronous", [])).rows, "3 is EXTRA").toEqual([[SYNCHRONOUS_EXTRA]]);
      await platform.exec.close();

      /* CONTROL: the setting lives on the connection, not in the file — a connection the platform
         did not open reads SQLite's default, FULL. Without this the case above could be the
         fixture's default answering. */
      const bare = expoEngineExecutor(await w.open(ENGINE_DB_FILE));
      expect((await bare.all("PRAGMA synchronous", [])).rows, "SQLite's default, FULL").toEqual([[2]]);
      await bare.close();
    } finally { w.cleanup(); }
  });

  it("refuses LOUDLY, closes the store and mints no key when the setting does not take", async () => {
    const w = engineStoreWorld();
    const kv = memoryKV();
    let closed = 0;
    /* A driver that will not hold EXTRA (a fixed build-time level, say): the statement runs and
       the level stays FULL. Real SQL behind it, so the read-back is SQLite's own answer. */
    const stubborn = async (name: string): Promise<EngineStoreDatabase> => {
      const db = await w.open(name);
      return {
        prepareAsync: (source) =>
          db.prepareAsync(source === ENGINE_DURABLE_COMMITS ? "PRAGMA synchronous = FULL" : source),
        closeAsync: async () => { closed += 1; await db.closeAsync(); },
      };
    };
    try {
      const outcome = openLocalEnginePlatform({
        openDatabase: stubborn, deleteDatabase: w.drop, kv,
        randomKekHex: () => "a".repeat(64), removal: noRemoval,
      });
      await expect(outcome).rejects.toBeInstanceOf(StoreFault);
      await expect(outcome).rejects.toMatchObject({ code: "engine_store_not_durable" });
      expect(closed, "the store a refused engine will never use is closed").toBe(1);
      expect(kv.map.has(KEK_KEY), "no key minted for a store that will not start").toBe(false);
    } finally { w.cleanup(); }
  });

  it("the refusal has a sentence in both decks, never the bare code", () => {
    expect(EN.storeFault("engine_store_not_durable")).not.toBe("engine_store_not_durable");
    expect(DE.storeFault("engine_store_not_durable")).not.toBe("engine_store_not_durable");
  });
});
