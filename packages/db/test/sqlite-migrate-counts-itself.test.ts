import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SQLITE_JOURNAL, type SqliteJournalEntry } from "@ohmail/db-mail/sqlite-journal";
import { migrateSqlite, SQLITE_MIGRATIONS_TABLE } from "../src/sqlite-migrate.js";

/**
 * THE DEVICE STORE'S UPGRADE COUNTS ITSELF (FIX-026 row 95). The phone's relaunch runs this
 * migrator and shows "3 of 12" from its hooks, so the hooks must count THIS open's owed entries
 * (never the journal's length), say whether the store is fresh, announce BEFORE each entry, and
 * never announce an entry that failed as applied. Mutations: `owed` → `journal.length`, `fresh`
 * read after the CREATE, `onApplied` moved above the COMMIT.
 */

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...a: unknown[]): unknown[] };
  };
};
type Store = InstanceType<typeof DatabaseSync>;

const targetFor = (db: Store) => ({
  run: async (statement: string): Promise<void> => { db.exec(statement); },
  all: async <T,>(statement: string): Promise<T[]> => db.prepare(statement).all() as T[],
});

interface Heard { entries: [number, number, string, boolean][]; applied: string[] }
const listen = (): Heard & { hooks: Parameters<typeof migrateSqlite>[2] } => {
  const heard: Heard = { entries: [], applied: [] };
  return {
    ...heard,
    hooks: {
      onEntry: (a, p, n, f) => { heard.entries.push([a, p, n, f]); },
      onApplied: (n) => { heard.applied.push(n); },
    },
  };
};

describe("the device store's upgrade counts itself", () => {
  it("a fresh store is said to be fresh, and every entry is owed", async () => {
    const db = new DatabaseSync(":memory:");
    const h = listen();
    const applied = await migrateSqlite(targetFor(db), SQLITE_JOURNAL, h.hooks);
    expect(applied).toHaveLength(SQLITE_JOURNAL.length);
    expect(h.entries.every(([, , , fresh]) => fresh), "a first launch was not called fresh").toBe(true);
    expect(h.entries[0]).toEqual([0, SQLITE_JOURNAL.length, SQLITE_JOURNAL[0]!.name, true]);
  });

  it("an upgrade counts the entries THIS open owed, before each one, and is not fresh", async () => {
    const db = new DatabaseSync(":memory:");
    const owed = 3;
    await migrateSqlite(targetFor(db), SQLITE_JOURNAL.slice(0, SQLITE_JOURNAL.length - owed));
    const h = listen();
    const applied = await migrateSqlite(targetFor(db), SQLITE_JOURNAL, h.hooks);
    expect(SQLITE_JOURNAL.length, "control: the journal holds more than the owed entries").toBeGreaterThan(owed);
    const tail = SQLITE_JOURNAL.slice(-owed).map((e) => e.name);
    expect(applied).toEqual(tail);
    expect(h.entries).toEqual(tail.map((name, i) => [i, owed, name, false]));
    expect(h.applied).toEqual(tail);
    /* An ordinary launch owes nothing and announces nothing. */
    const quiet = listen();
    expect(await migrateSqlite(targetFor(db), SQLITE_JOURNAL, quiet.hooks)).toEqual([]);
    expect(quiet.entries).toEqual([]);
  });

  it("a failing entry is refused BY NAME and is never announced as applied", async () => {
    const db = new DatabaseSync(":memory:");
    await migrateSqlite(targetFor(db), SQLITE_JOURNAL);
    const bad: SqliteJournalEntry = { ...SQLITE_JOURNAL[0]!, name: "9999_fix026_planted", statements: ["SELECT nope FROM nowhere"] };
    const h = listen();
    await expect(migrateSqlite(targetFor(db), [...SQLITE_JOURNAL, bad], h.hooks))
      .rejects.toThrow("the SQLite journal stopped at 9999_fix026_planted");
    expect(h.entries.map(([, , n]) => n)).toEqual(["9999_fix026_planted"]);
    expect(h.applied, "a refused entry was reported as applied").toEqual([]);
    const ledger = db.prepare(`SELECT name FROM ${SQLITE_MIGRATIONS_TABLE} WHERE name = '9999_fix026_planted'`).all();
    expect(ledger).toEqual([]);
  });
});

/**
 * EVERYTHING A STORE OWES IS ONE TRANSACTION. 2.0's entries take columns a 1.0 engine reads, so a
 * store stopped between two of them opens on neither release: the owed entries are in the ledger
 * together or not at all, and `beforeApply` is where an open may be refused with the store untouched.
 */
describe("the device store takes everything it owes in one transaction", () => {
  const entry = (name: string, statements: string[]): SqliteJournalEntry => ({ ...SQLITE_JOURNAL[0]!, name, statements });
  const THREE = [
    entry("9001_first", ["CREATE TABLE planted_first (id INTEGER PRIMARY KEY)", "INSERT INTO planted_first VALUES (1)"]),
    entry("9002_second", ["CREATE TABLE planted_second (id INTEGER PRIMARY KEY)"]),
    entry("9003_third", ["SELECT nope FROM nowhere"]),
  ];
  const tables = (db: Store): string[] =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'planted_%' ORDER BY 1").all() as { name: string }[]).map((r) => r.name);
  const recorded = (db: Store): string[] =>
    (db.prepare(`SELECT name FROM ${SQLITE_MIGRATIONS_TABLE} WHERE name LIKE '9%' ORDER BY 1`).all() as { name: string }[]).map((r) => r.name);
  const foreignKeys = (db: Store): unknown => (db.prepare("PRAGMA foreign_keys").all() as { foreign_keys: number }[])[0]!.foreign_keys;

  it("three owed entries of which the third fails leave no table of the first and no row in the ledger", async () => {
    const db = new DatabaseSync(":memory:");
    await migrateSqlite(targetFor(db), SQLITE_JOURNAL);
    const h = listen();
    await expect(migrateSqlite(targetFor(db), [...SQLITE_JOURNAL, ...THREE], h.hooks))
      .rejects.toThrow("the SQLite journal stopped at 9003_third and none of the 3 entries this open owed was applied");
    expect(tables(db)).toEqual([]);
    expect(recorded(db)).toEqual([]);
    expect(h.applied, "an entry of a rolled-back upgrade was reported as applied").toEqual([]);
    expect(foreignKeys(db), "a failed upgrade left the keys off").toBe(1);
    // Without the fault the same three land together, and each is told once, after the commit.
    const ok = listen();
    expect(await migrateSqlite(targetFor(db), [...SQLITE_JOURNAL, ...THREE.slice(0, 2)], ok.hooks)).toEqual(["9001_first", "9002_second"]);
    expect([tables(db), recorded(db), ok.applied]).toEqual([["planted_first", "planted_second"], ["9001_first", "9002_second"], ["9001_first", "9002_second"]]);
  });

  it("is told what it owes before anything is written, and a refusal there leaves the store as it was", async () => {
    const db = new DatabaseSync(":memory:");
    await migrateSqlite(targetFor(db), SQLITE_JOURNAL);
    const before = db.prepare("SELECT count(*) AS n FROM sqlite_master").all();
    const asked: unknown[] = [];
    await expect(migrateSqlite(targetFor(db), [...SQLITE_JOURNAL, ...THREE.slice(0, 2)], {
      beforeApply: async (o) => { asked.push(o); throw new Error("no room for the upgrade"); },
    })).rejects.toThrow("no room for the upgrade");
    expect(asked).toEqual([{ owed: ["9001_first", "9002_second"], fresh: false }]);
    expect([tables(db), recorded(db)]).toEqual([[], []]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master").all()).toEqual(before);
    expect(foreignKeys(db)).toBe(1);
    // A store that owes nothing is asked nothing; a new one is asked once, and is said to be fresh.
    let calls = 0;
    await migrateSqlite(targetFor(db), SQLITE_JOURNAL, { beforeApply: async () => { calls += 1; } });
    expect(calls).toBe(0);
    const fresh = new DatabaseSync(":memory:");
    const heard: { fresh: boolean; owed: number }[] = [];
    await migrateSqlite(targetFor(fresh), SQLITE_JOURNAL, { beforeApply: async (o) => { heard.push({ fresh: o.fresh, owed: o.owed.length }); } });
    expect(heard).toEqual([{ fresh: true, owed: SQLITE_JOURNAL.length }]);
  });

  it("a new store refused before its first entry holds nothing, not even the ledger", async () => {
    const db = new DatabaseSync(":memory:");
    await expect(migrateSqlite(targetFor(db), SQLITE_JOURNAL, { beforeApply: async () => { throw new Error("refused"); } })).rejects.toThrow("refused");
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master").all()).toEqual([{ n: 0 }]);
  });
});
