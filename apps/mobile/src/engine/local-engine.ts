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
import { ensureKek, forgetKek, kekRing, type RandomKekHex } from "./kek";
import { faultDetail, refuse, type Refusal } from "../refusal";
import { StoreFault, type SecureKV } from "../state/servers";

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
 * ── WHAT A REMOVAL TAKES, AND THE ORDER IT TAKES IT IN ──────────────────────────────────────
 *
 * The four tables that make the store a mailbox rather than a file: the ACCOUNT the next
 * bootstrap reuses, the MAILBOX row the roster attaches, the SEALED CREDENTIAL that dials, and
 * the MAIL. The read-back below asks the store's own catalog for these by name, because
 * awaiting a deleter proves only that a function returned — which is the evidence the defect
 * this closes already had.
 */
export const ENGINE_STORE_TABLES = ["accounts", "mailbox_credentials", "mailboxes", "messages"];

/** What removing this phone's mailbox needs of the platform: the store's two verbs, and the keystore. */
export interface EngineStoreSeams {
  /** The engine's own file — the SAME name the opener opens, never a mirror's. */
  openDatabase: (name: string) => Promise<EngineStoreDatabase>;
  /**
   * Remove that file. REQUIRED, on `MobileEngineDeps.deleteDatabase`'s argument: a platform half
   * that can only create a mailbox is not complete. It must name the file the opener names —
   * the mirror's deleter wraps its argument and this one may not, or the removal deletes a
   * database nothing ever wrote to and the read-back is the only thing that notices.
   */
  deleteDatabase: (name: string) => Promise<void>;
  kv: SecureKV;
}

/** Which of {@link ENGINE_STORE_TABLES} the store still holds. Creates nothing it does not drop. */
async function engineStoreSurvivors(deps: EngineStoreSeams): Promise<string[]> {
  const probe = expoEngineExecutor(await deps.openDatabase(ENGINE_DB_FILE));
  try {
    const held = await probe.all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${
        ENGINE_STORE_TABLES.map(() => "?").join(", ")})`,
      ENGINE_STORE_TABLES,
    );
    return held.rows.map((row) => String(row[0])).sort();
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/**
 * ── REMOVING THE MAILBOX ON THIS PHONE: THE KEY, THEN THE STORE, EACH READ BACK ─────────────
 *
 * "Stop and remove" used to delete the client mirror and stop — the engine's own store and the
 * key ring that opens the password sealed in it both outlived it, so connecting a DIFFERENT
 * mailbox afterwards booted an engine over the survivor, `ensureLocalWorld` found the existing
 * account, and the removed mailbox was attached beside the new one. A person who removed a
 * mailbox read its mail under the next one's session.
 *
 * KEY FIRST. A kill between the two leaves a store whose sealed password nothing can open,
 * where the other order leaves the key to mail that is still here. Neither is meant to survive:
 * the caller records the removal before this runs, and {@link openLocalEnginePlatform} finishes
 * whatever this did not on the next launch.
 *
 * The probe's second delete is its own litter — opening a deleted name creates it, and leaving
 * that stub would make the next launch read an empty file as a store. It runs ONLY where the
 * probe found nothing, and that condition is not tidiness: unconditional, it deletes the store
 * on the very path where the first delete did not, so either call alone satisfies this function
 * and neither can be watched fail. A guard nobody has watched fail is not evidence, and a second
 * mechanism covering the first measures the pair.
 */
export async function removeStandaloneEngine(deps: EngineStoreSeams): Promise<void> {
  await forgetKek(deps.kv);
  await deps.deleteDatabase(ENGINE_DB_FILE);
  const survivors = await engineStoreSurvivors(deps);
  if (survivors.length === 0) await deps.deleteDatabase(ENGINE_DB_FILE).catch(() => undefined);
  if (survivors.length > 0) {
    /* A CODE, never a sentence: `forgetProfile` hands this to `faultDetail`, which words our own
       failures and quotes everybody else's — an English message here would freeze inside a
       German refusal. Table names, never an address. */
    throw new StoreFault(
      "engine_store_not_deleted",
      `this phone still holds the removed mailbox's own store — "${ENGINE_DB_FILE}" survived ` +
        `being deleted (${survivors.join(", ")})`,
    );
  }
}

/**
 * THE DURABLE RECORD OF A REMOVAL IN FLIGHT — written before the first deletion, cleared after
 * the last. `ServerProfileStore` owns it; this is the two calls the bootstrap makes on it, as a
 * port, so this module keeps importing nothing but a type from the keystore layer.
 */
export interface EngineRemovalRecord {
  /** The account whose removal is recorded and unfinished, or `null`. */
  recorded(): Promise<string | null>;
  clear(): Promise<void>;
}

/**
 * Open the engine's store and resolve its key — the two things that must both succeed.
 * Ordered store-then-key on purpose: the key's failure is the one that must not leave a
 * half-built install behind, so an unreadable key closes the store again before the refusal
 * leaves this function — nothing holds a file handle for an engine that will not start. The
 * random source and keystore arrive through seams so the node suite drives this without a
 * native module; production binds the app's existing `secureKV()` — one keystore seam, not a
 * second one for the engine.
 *
 * ── AND BEFORE EITHER, THE REMOVAL BELT ────────────────────────────────────────────────────
 *
 * This is the ONE gate in front of the engine's store: the door press and the relaunch both
 * arrive here. A removal that was interrupted — killed after the record was written and before
 * the deletions landed — leaves a store holding the removed mailbox, and opening it is exactly
 * the attach the removal existed to prevent. So a recorded removal is FINISHED here and the
 * launch is refused by name; the next press opens a store that no longer exists, which is a
 * fresh one. A deletion that still cannot land leaves the record standing and refuses again.
 */
export async function openLocalEnginePlatform(deps: EngineStoreSeams & {
  randomKekHex: RandomKekHex;
  /** REQUIRED: without it this gate cannot tell a removed mailbox from a held one. */
  removal: EngineRemovalRecord;
}): Promise<LocalEnginePlatformVerdict> {
  if ((await deps.removal.recorded()) !== null) {
    try {
      await removeStandaloneEngine(deps);
      /* LAST, and its own read-back is in the store: a record that survives being cleared would
         refuse every later launch of a door the person has already taken again. */
      await deps.removal.clear();
    } catch (err) {
      return { kind: "refused", reason: refuse("standaloneRemovalUnfinished", faultDetail(err)) };
    }
    return { kind: "refused", reason: refuse("standaloneMailboxRemoved") };
  }
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
