/**
 * The engine's platform half — expo-sqlite behind the executor contract, and the key ring:
 * the two things the engine cannot get for itself on a phone. It imports no native module
 * (the expo bindings live in `local-engine-native.ts`): expo packages carry Flow-typed JS the
 * suite's transform refuses, so the seams are what makes this module loadable. The engine
 * store is a second SQLite file — the mirror is a throwaway projection, the
 * engine store is the authority, and one file would make "forget this server" and "stop
 * organizing" the same destructive act. It does not import the engine: the engine arrives
 * pre-bundled; importing its source would re-resolve the graph the census prevents.
 */
import { ensureKek, kekRing, type RandomKekHex } from "./kek";
import type { Refusal } from "../refusal";
import type { SecureKV } from "../state/servers";

/**
 * The engine store's own file. Named apart from the mirror's databases so the two can never be
 * confused by a wipe: `forgetMirror` deletes by the mirror's own naming scheme and cannot reach
 * this one, and the door's take-back deletes this one by name.
 */
export const ENGINE_DB_FILE = "ohmail-engine.db";

/** Rows as arrays with the statement's own column names — the engine's store contract. */
export interface PhoneSqlRows {
  readonly columns: readonly string[];
  readonly rows: readonly unknown[][];
}

/** What the engine's composition root needs from a platform. Mirrors the engine's own type. */
export interface PhoneSqlExecutor {
  all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows>;
  run(sql: string, params: readonly unknown[]): Promise<void>;
  batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void>;
  close(): Promise<void>;
}

/** The minimum this module needs of an expo-sqlite database, so a test can supply one. */
export interface EngineStoreDatabase {
  prepareAsync(source: string): Promise<{
    executeForRawResultAsync(params: readonly unknown[]): Promise<{ getAllAsync(): Promise<unknown[]> }>;
    executeAsync(params: readonly unknown[]): Promise<unknown>;
    getColumnNamesAsync(): Promise<string[]>;
    finalizeAsync(): Promise<void>;
  }>;
  closeAsync(): Promise<void>;
}

/**
 * expo-sqlite behind {@link PhoneSqlExecutor} — one handle, every call serialized. Rows come
 * back positional (`executeForRawResultAsync` + `getColumnNamesAsync`), exactly the contract:
 * two columns of one name are two positions, where an object-row driver would collapse them.
 * The `node:sqlite` harness zips names itself; the contract keeps the halves honest.
 * Serialized because this driver is asynchronous — two overlapping read-modify-writes lose
 * one — and the queue is inert in the synchronous harness, so deleting it would be green
 * everywhere it runs while breaking the device. `batch` drives `BEGIN`/`COMMIT` on
 * THIS handle: `withExclusiveTransactionAsync`'s second connection cost "database is locked" and unenforced foreign keys.
 */
export function expoEngineExecutor(db: EngineStoreDatabase): PhoneSqlExecutor {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    // Swallowed on the CHAIN only: one statement's failure must not reject the next caller's turn.
    tail = next.catch(() => undefined);
    return next;
  };

  /** Prepare, use, finalize — a statement left unfinalized holds a cursor open on the file. */
  const withStatement = async <T>(
    sql: string,
    use: (s: Awaited<ReturnType<EngineStoreDatabase["prepareAsync"]>>) => Promise<T>,
  ): Promise<T> => {
    const statement = await db.prepareAsync(sql);
    try {
      return await use(statement);
    } finally {
      await statement.finalizeAsync().catch(() => undefined);
    }
  };

  return {
    all(sql, params) {
      return serial(async () => withStatement(sql, async (statement) => {
        // The NAMES first, then the values: both describe the same prepared statement, and reading
        // them from one statement is what makes the pairing positional rather than hopeful.
        const columns = await statement.getColumnNamesAsync();
        const result = await statement.executeForRawResultAsync(params);
        const raw = await result.getAllAsync();
        const rows = raw.map((row) => (Array.isArray(row) ? (row as unknown[]) : [row]));
        return { columns, rows };
      }));
    },
    run(sql, params) {
      return serial(async () => {
        await withStatement(sql, async (statement) => { await statement.executeAsync(params); });
      });
    },
    batch(statements) {
      return serial(async () => {
        await withStatement("BEGIN IMMEDIATE", async (s) => { await s.executeAsync([]); });
        try {
          for (const { sql, params = [] } of statements) {
            await withStatement(sql, async (s) => { await s.executeAsync(params); });
          }
          await withStatement("COMMIT", async (s) => { await s.executeAsync([]); });
        } catch (err) {
          /* The rollback must not mask the original failure: its own error is swallowed and the
             caller sees what actually went wrong. A store left inside a transaction is the worse
             outcome, so it is attempted unconditionally. */
          await withStatement("ROLLBACK", async (s) => { await s.executeAsync([]); }).catch(() => undefined);
          throw err;
        }
      });
    },
    async close() {
      await db.closeAsync();
    },
  };
}

/** Everything the engine needs from this platform, resolved. */
export interface LocalEnginePlatform {
  exec: PhoneSqlExecutor;
  /** `version -> 64 hex characters`, the desktop's key-ring contract as a value. */
  keks: Record<number, string>;
}

/**
 * WHAT OPENING THE PLATFORM ANSWERS — the pair, or a refusal a screen can render.
 *
 * `EngineBoot`'s shape, deliberately: a refusal is a value carrying a deck key, and `gate.ts`
 * sends one to the Servers surface whatever the pairing count. So the door that starts a
 * standalone install reads ONE verdict shape for both halves of its start-up.
 */
export type LocalEnginePlatformVerdict =
  | ({ kind: "ready" } & LocalEnginePlatform)
  | { kind: "refused"; reason: Refusal };

/**
 * Open the engine's store and resolve its key — the two things that must both succeed.
 * Ordered store-then-key on purpose: the key's failure is the one that must not leave a
 * half-built install behind, so an unreadable key closes the store again before the refusal
 * leaves this function — nothing holds a file handle for an engine that will not start. The
 * random source and keystore arrive through seams so the node suite drives this without a
 * native module; production binds the app's existing `secureKV()` — one keystore seam, not a
 * second one for the engine.
 */
export async function openLocalEnginePlatform(deps: {
  /** REQUIRED: the platform's own opener. See the banner — nothing native is imported here. */
  openDatabase: (name: string) => Promise<EngineStoreDatabase>;
  kv: SecureKV;
  randomKekHex: RandomKekHex;
}): Promise<LocalEnginePlatformVerdict> {
  const exec = expoEngineExecutor(await deps.openDatabase(ENGINE_DB_FILE));
  try {
    const kek = await ensureKek(deps.kv, deps.randomKekHex);
    if (kek.kind === "refused") {
      await exec.close().catch(() => undefined);
      return { kind: "refused", reason: kek.reason };
    }
    return { kind: "ready", exec, keks: kekRing(kek.hex) };
  } catch (err) {
    /* Not one of ours: a keystore or a driver raising its own exception. Re-thrown rather than
       worded, so it reaches the door as the platform's own words — the diagnostic rule. */
    await exec.close().catch(() => undefined);
    throw err;
  }
}
