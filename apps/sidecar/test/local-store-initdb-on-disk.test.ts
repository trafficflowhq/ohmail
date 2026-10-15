import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";

/*
 * A NEW STORE MADE ON THE DISK, the path a first start takes when the in-memory maker fails:
 * PGlite's own `initdb` makes the cluster on this very start, so Postgres read none of the store's
 * settings. The open writes the log's method and starts once more; without that a store made this
 * way would be refused at every open, and every Start over would make another one the same way.
 */
vi.mock("../src/fresh-store.js", async (original) => ({
  ...(await original<typeof import("../src/fresh-store.js")>()),
  makeStoreInMemory: async (): Promise<number> => { throw new Error("planted: the in-memory maker failed"); },
}));

const dirs: string[] = [];
const open: OpenLocalDb[] = [];
afterAll(async () => {
  for (const h of open) await h.close().catch(() => { /* a closed handle is fine */ });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("a new store PGlite makes on the disk", () => {
  it("opens with the log synced by fsync, after one more start", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-initdb-on-disk-"));
    dirs.push(dir);
    const lines: string[] = [];
    const h = await openLocalDb(dir, { log: (event) => { lines.push(event); } });
    open.push(h);
    expect(lines, "the in-memory maker did not fail, so this measured the ordinary path").toContain("fresh_store_copy_failed");
    const shown = await h.db.execute(sql.raw("show wal_sync_method")) as unknown as { rows?: Array<Record<string, string>> };
    expect(Object.values(shown.rows?.[0] ?? {})[0], "a store made on the disk kept initdb's method").toBe("fsync");
  }, 180_000);
});
