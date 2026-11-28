import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_JOURNAL, readJournalOf } from "@trafficflow/db/journal";
import { PGDATA_SUBDIR, SET_ASIDE_PREFIX, STORE_UNFINISHED_FILE, openLocalDb, type OpenLocalDb } from "../../src/db.js";

vi.setConfig({ testTimeout: 180_000 });

/**
 * A FIRST START WHOSE IN-MEMORY STORE FAILS STILL OPENS. A new store is made in a worker and
 * written into `pgdata` (`fresh-store.ts`); a worker that stops half way leaves files there, and
 * `initdb` refuses a directory holding anything with a WASM abort, so a start that fell back over
 * them could never finish. The failing maker below writes the shape a half copy leaves.
 */
const maker = vi.hoisted(() => ({ fail: false }));
vi.mock("../../src/fresh-store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/fresh-store.js")>();
  return {
    ...real,
    makeStoreInMemory: async (pgDataDir: string, boundMs?: number): Promise<WebAssembly.Module> => {
      if (!maker.fail) return real.makeStoreInMemory(pgDataDir, boundMs);
      mkdirSync(join(pgDataDir, "global"), { recursive: true });
      writeFileSync(join(pgDataDir, "postgresql.conf"), "");
      throw new Error("the worker stopped half way through the copy");
    },
  };
});

const dirs: string[] = [];
const open: OpenLocalDb[] = [];
afterEach(async () => {
  maker.fail = false;
  for (const h of open.splice(0)) await h.close().catch(() => { /* already closed */ });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function firstStart(): Promise<{ dir: string; events: string[] }> {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-fresh-store-"));
  dirs.push(dir);
  const events: string[] = [];
  const h = await openLocalDb(dir, { log: (event) => { events.push(event); } });
  open.push(h);
  const ledger = await h.db.execute(
    `select count(*)::int as n from "${MAIL_JOURNAL.migrationsSchema}"."__drizzle_migrations"`,
  ) as unknown as { rows: Array<{ n: number }> };
  expect(ledger.rows[0]!.n).toBe(readJournalOf(MAIL_JOURNAL).length);
  await h.db.execute("insert into accounts (id, name) values ('00000000-0000-4000-8000-00000000f5e1', 'first start')");
  expect(existsSync(join(dir, STORE_UNFINISHED_FILE)), "a served store still carries the marker").toBe(false);
  expect(existsSync(join(dir, PGDATA_SUBDIR, "PG_VERSION"))).toBe(true);
  return { dir, events };
}

describe("a new store", () => {
  it("is made in memory on an ordinary first start, and serves", async () => {
    const { events } = await firstStart();
    expect(events).not.toContain("fresh_store_copy_failed");
  });

  it("is made on disk when the in-memory one fails half way, over nothing the worker left", async () => {
    maker.fail = true;
    const { dir, events } = await firstStart();
    expect(events).toContain("fresh_store_copy_failed");
    expect(readdirSync(dir).filter((n) => n.startsWith(SET_ASIDE_PREFIX)), "a template copy is not a store to keep").toHaveLength(0);
  });
});
