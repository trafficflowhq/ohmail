import fs, { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wt from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PGDATA_SUBDIR, STORE_UNFINISHED_FILE, openLocalDb, type OpenLocalDb } from "../src/db.js";
import { Disk, withNodeShape } from "./_cut-disk.js";

/**
 * LOCAL-STORE-CATALOG-NOT-FSYNCED-BEFORE-THE-MARKER-CLEARS, as a power cut on a FIRST start.
 *
 * A new store's catalog is written out by `fresh-store.ts` (or `initdb` on the disk) and nothing
 * synced those files, while the start marker cleared once the first migration pass committed. A
 * cut after that left a store no start sets aside and none can open: every row acknowledged since
 * was gone with it. The emulator is the one `local-store-cut-emulated.test.ts` cuts with; the
 * store syncer's threads run their own code here, at its seam (the maker's thread does not, so
 * what it writes counts as lost until something syncs it — which is the defect).
 */

const require = createRequire(import.meta.url);
const RealWorker = wt.Worker;

/** A syncer thread (`workerData.paths`) runs its code in this thread, at the seam; others are real. */
class SeamWorker extends EventEmitter {
  private readonly real: InstanceType<typeof RealWorker> | null = null;
  constructor(code: string, opts: { workerData?: { paths?: unknown } } & Record<string, unknown>) {
    super();
    if (!Array.isArray(opts.workerData?.paths)) {
      this.real = new RealWorker(code, opts as never);
      return this.real as unknown as SeamWorker;
    }
    const port = { postMessage: (m: unknown) => this.emit("message", m) };
    const shim = (m: string): unknown => m === "node:fs" ? fs
      : m === "node:worker_threads" ? { parentPort: port, workerData: opts.workerData } : require(m);
    setImmediate(() => { new Function("require", code)(shim); this.emit("exit", 0); });
  }
  terminate(): Promise<number> { return Promise.resolve(0); }
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  ((r as { rows?: Array<Record<string, unknown>> }).rows ?? (r as Array<Record<string, unknown>>));

async function firstStartCut(shape: "linux" | "windows"): Promise<string> {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `ohmail-first-cut-${shape}-`));
  dirs.push(dir);
  const disk = new Disk(join(dir, PGDATA_SUBDIR));
  const ids: string[] = [];
  let h: OpenLocalDb | null = null;
  disk.install();
  (wt as unknown as { Worker: unknown }).Worker = SeamWorker;
  try {
    h = await withNodeShape(shape, () => openLocalDb(dir));
    const acct = String(rowsOf(await h.db.execute(sql.raw("INSERT INTO accounts (name) VALUES ('first') RETURNING id::text AS id")))[0]!.id);
    for (let i = 0; i < 10; i += 1) {
      const r = rowsOf(await h.db.execute(sql`INSERT INTO rules (account_id, kind, match, destination) VALUES (${acct}::uuid, 'sender', ${`first-${i}@rig.invalid`}, 'Archive') RETURNING id::text AS id`))[0]!;
      ids.push(String(r.id));
    }
  } finally {
    (wt as unknown as { Worker: unknown }).Worker = RealWorker;
    disk.restore();
  }
  /* The marker cleared on this start: the image is a store the next start will open as finished. */
  if (existsSync(join(dir, STORE_UNFINISHED_FILE))) return "THE MARKER DID NOT CLEAR";
  const image = disk.image(dir);
  dirs.push(image);
  await h?.close();
  let after: OpenLocalDb;
  try {
    after = await openLocalDb(image);
  } catch (err) {
    return `UNOPENABLE ${(err as Error).name}`;
  }
  let kept = 0;
  for (const id of ids) {
    kept += Number(rowsOf(await after.db.execute(sql.raw(`SELECT count(*)::int AS c FROM rules WHERE id = '${id}'::uuid`)))[0]!.c);
  }
  await after.close();
  return `KEPT ${kept}/${ids.length}`;
}

describe("a power cut on a store's first start, after the marker cleared", () => {
  it("keeps the store and every acknowledged row, with Linux's fs constants", async () => {
    expect(await firstStartCut("linux")).toBe("KEPT 10/10");
  }, 180_000);

  it("keeps the store and every acknowledged row, with Windows' fs constants", async () => {
    expect(await firstStartCut("windows")).toBe("KEPT 10/10");
  }, 180_000);
});
