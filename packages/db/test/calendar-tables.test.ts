import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { migrateSqlite } from "../src/sqlite-migrate.js";
import { calendarCatalogSuite } from "./_calendar-family.js";

/**
 * THE CALENDAR'S TABLES ON THE STORE A DESKTOP'S ENGINE RUNS: PGlite, the mail journal whole. The
 * cases (`_calendar-family.ts`) read the store's own catalog and its own refusals; they run on
 * real Postgres in `calendar-tables.pg.test.ts`. A phone's own store holds none of the tables.
 */
calendarCatalogSuite("a desktop's store (PGlite)", async () => {
  const db = await makeTestDb();
  const client = (db as unknown as {
    $client: { query(t: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; close(): Promise<void> };
  }).$client;
  return { exec: async (text, params = []) => (await client.query(text, [...params])).rows, close: () => client.close() };
});

describe("a phone that organizes on its own", () => {
  it("has no calendar table: its journal carries none", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => { exec(s: string): void; prepare(s: string): { all(): unknown[] } };
    };
    const raw = new DatabaseSync(":memory:");
    await migrateSqlite({
      run: async (statement) => { raw.exec(statement); },
      all: async <T,>(statement: string) => raw.prepare(statement).all() as T[],
    });
    const tables = (raw.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables.filter((t) => t.startsWith("cal_"))).toEqual([]);
    // Not vacuous: the same read finds the mail's own tables there.
    expect(tables).toContain("messages");
  });
});
