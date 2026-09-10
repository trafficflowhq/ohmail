/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ENGINE'S PLATFORM HALF — expo-sqlite behind the executor contract, and the key ring
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The mail engine runs inside this app over its own SQLite file. This module supplies the two
 * things the engine cannot get for itself on a phone: the store's platform binding, and the key
 * that opens the mailbox password.
 *
 * ── AND IT IMPORTS NO NATIVE MODULE, WHICH THIS APP ALREADY HAD A RULE FOR ────────────────
 *
 * The expo bindings live in `local-engine-native.ts`, exactly as the pairing store's do in
 * `servers-native.ts` — whose header states the reason as a fact: the node-side suite drives the
 * logic through the seams and never loads that file. It is not only a tidiness rule. Written with
 * the bindings in here, this module could not be imported by a test AT ALL: the expo packages carry
 * Flow-typed JavaScript, and the suite's transform refuses it with `Expected 'from', got 'typeOf'`
 * — a parse error naming neither the package nor the import that reached it.
 *
 * So the seams below are not conveniences for testing. They are what makes this module loadable.
 *
 * It does NOT supply the install identity or start the engine. The identity comes from the app's
 * install marker, which rotates when a device is restored from a backup — the property that keeps a
 * restored copy from being read as the same install and becoming a second organizer nobody can see.
 * Naming that here rather than owning it, because a module that answered "who is this install"
 * from anything but the marker would be the defect.
 *
 * ── THE ENGINE STORE IS A SECOND FILE, AND THAT IS AN INVARIANT ───────────────────────────
 *
 * The app already has a SQLite database: the UI's mirror, a delta client of the local sync. This
 * opens a DIFFERENT file. Merging them was considered and ruled out — the mirror is a projection
 * that can be thrown away and rebuilt, the engine store is the authority for everything not yet in
 * the mailbox, and a single file would make "forget this server" and "stop organizing" the same
 * destructive act.
 *
 ── AND IT DOES NOT IMPORT THE ENGINE, WHICH IS THE POINT ────────────────────────────────
 *
 * `startPhoneEngine` lives in the engine, and the engine reaches this app as a PRE-BUNDLED file:
 * every specifier in it already resolved, its Node builtins already substituted, its contents
 * already censused. Importing the engine's SOURCE from here would undo all of that — the app's own
 * bundler would resolve the whole graph again, with its own rules and none of the substitutions,
 * which is exactly the artifact the census exists to prevent.
 *
 * So this module hands the engine a PLATFORM and nothing else: {@link openLocalEnginePlatform}
 * returns the store binding and the key ring, and whoever composes the app passes them to the
 * factory it loaded from the bundle. How the released app obtains that bundle is a packaging
 * question and is deliberately not decided here.
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
 * expo-sqlite behind {@link PhoneSqlExecutor} — ONE handle, every call serialized.
 *
 * ── THE ROWS COME BACK POSITIONAL FROM THE DRIVER, WHICH THE HARNESS CANNOT DO ────────────
 *
 * `executeForRawResultAsync` returns each row as an ARRAY of its values, and
 * `getColumnNamesAsync` names the statement's columns. That pair is exactly the contract, and it
 * means the duplicate-column hazard never arises here: two columns of one name are two positions in
 * the array, where a driver returning row OBJECTS would collapse them to a single key and fill both
 * positions from one value — a full-length row carrying the wrong data, which nothing errors on.
 *
 * The `node:sqlite` harness has no such API and has to zip names to values itself. So the two
 * halves of this seam differ, and the CONTRACT is what keeps them honest rather than a shared
 * implementation. Worth knowing when reading a green harness: the device path is the simpler of the
 * two here, not the harder one.
 *
 * ── SERIALIZED, AND WHY THAT IS NOT AN OPTIMISATION ───────────────────────────────────────
 *
 * This driver is asynchronous, so two overlapping read-modify-writes lose one. The queue is what
 * the engine's whole store binding rests on, and it is INERT in the harness — `node:sqlite` is
 * synchronous, so removing this queue changes nothing there while breaking the device. A future
 * edit that deletes it would be green everywhere it could be run.
 *
 * ── AND `batch` DRIVES ITS TRANSACTION ON THIS HANDLE, NEVER ON A SECOND CONNECTION ───────
 *
 * `withExclusiveTransactionAsync` opens a SECOND connection to the same file. That has already cost
 * this app twice: two overlapping calls became two writers and the loser aborted with "database is
 * locked", and the second connection never received `PRAGMA foreign_keys = ON`, so the schema's
 * references went unenforced for every write made through it. So the transaction is `BEGIN` /
 * statements / `COMMIT` on THIS handle, inside one queue slot.
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
 * OPEN THE ENGINE'S STORE AND RESOLVE ITS KEY — the two things that must both succeed.
 *
 * Ordered store-then-key on purpose. Both can fail, and the key's failure is the one that must not
 * leave a half-built install behind: if the key is unreadable, the store is CLOSED again before the
 * refusal leaves this function, so nothing is holding a file handle for an engine that will not
 * start.
 *
 * The random source and the keystore arrive through seams so the node-side suite drives this
 * without a native module; production binds the app's existing keystore — one keystore seam in this
 * app, not a second one for the engine.
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
