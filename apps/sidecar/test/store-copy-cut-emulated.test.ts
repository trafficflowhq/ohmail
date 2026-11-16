import fs, { cpSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wt from "node:worker_threads";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PGDATA_SUBDIR, openLocalDb } from "../src/db.js";
import { Disk, imageOfFolder, tellFolderFlushes } from "./_cut-disk.js";
import { NEW_HEAD, OLD_HEAD, OLD_STORE, folderAtOldHead, readAsOneOh, ring } from "./_old-head-store.js";

/**
 * A POWER CUT AT EVERY STEP OF A STORE'S UPDATE. The start that finds a 1.0 store closes it,
 * copies it, starts it again and moves it. Cut at any of ten points, the disk holds either the
 * store on the 1.0 line or a whole copy of it that 1.0 opens, never a moved store without one and
 * never half a copy under a copy's name; and the next start ends with the store moved, one whole
 * copy and no half one. The emulator is `_cut-disk.ts`'s, rooted at the data folder: a byte counts
 * as on the disk only once it was synced. It takes a folder's entries as they stand, so the name
 * that commits the copy has a case of its own, which sees its folder flushed.
 */

const COPY = "store-before-2.0";
const require = createRequire(import.meta.url);
const RealWorker = wt.Worker;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

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

const POINTS = [
  "before the read", "after the close", "mid-copy", "after the last file", "after the tree sync",
  "after the manifest", "after the rename", "after the reopen", "inside the transaction", "after the commit",
] as const;
type Point = (typeof POINTS)[number];

/** One start over a 1.0 store, with the disk's image taken at each point as the start passes it. */
async function cutAtEveryPoint(): Promise<Map<Point, string>> {
  const dir = await folderAtOldHead("ohmail-store-copy-cut-");
  dirs.push(dir);
  const disk = new Disk(dir);
  const images = new Map<Point, string>();
  const cut = (point: Point): void => {
    if (images.has(point)) return;
    const image = imageOfFolder(disk, dir);
    dirs.push(image);
    images.set(point, image);
  };
  class CutBeforeTheTreeSync extends SeamWorker {
    constructor(code: string, opts: { workerData?: { paths?: unknown } } & Record<string, unknown>) {
      if (Array.isArray(opts.workerData?.paths)) cut("after the last file");
      super(code, opts);
    }
  }
  disk.install();
  (wt as unknown as { Worker: unknown }).Worker = CutBeforeTheTreeSync;
  /* The hooks stand on the emulator's own functions, so each cut sees what the emulator has seen. */
  const statfs = fs.statfsSync;
  const copyFile = fs.copyFileSync;
  const open = fs.openSync;
  const rename = fs.renameSync;
  let copiedFiles = 0;
  vi.spyOn(fs, "statfsSync").mockImplementation(((...a: Parameters<typeof statfs>) => { cut("after the close"); return statfs(...a); }) as never);
  vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
    copiedFiles += 1;
    if (copiedFiles === 40) cut("mid-copy");
    return copyFile(from, to, mode);
  });
  vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    if (String(path).endsWith(join(`${COPY}.partial`, "copy.json"))) cut("after the tree sync");
    return (open as (...a: unknown[]) => number)(path, ...rest);
  }) as never);
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    const commits = String(from).endsWith(`${COPY}.partial`);
    if (commits) cut("after the manifest");
    rename(from, to);
    if (commits) cut("after the rename");
  });
  try {
    const opened = await openLocalDb(dir, {
      onPhase: (phase, progress) => {
        cut("before the read");
        if (phase === "migrating" && progress !== undefined && progress.applied > 0) cut("after the commit");
      },
      transition: {
        way: "copy",
        before: async () => { cut("after the reopen"); },
        openSealed: { decrypt: (ciphertext, keyVersion) => { cut("inside the transaction"); return ring().decrypt(ciphertext, keyVersion); } },
      },
    });
    await opened.close();
  } finally {
    vi.restoreAllMocks();
    (wt as unknown as { Worker: unknown }).Worker = RealWorker;
    disk.restore();
  }
  expect(copiedFiles, "the copy was shorter than the point it is cut at").toBeGreaterThan(40);
  return images;
}

/** A store read the way 1.0 reads it, from a copy of its files: opening a store writes to it. */
async function readCopyOf(pgdata: string): Promise<Awaited<ReturnType<typeof readAsOneOh>> | "UNOPENABLE"> {
  const aside = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-store-copy-cut-read-"));
  try {
    cpSync(pgdata, join(aside, PGDATA_SUBDIR), { recursive: true });
    return await readAsOneOh(join(aside, PGDATA_SUBDIR)).catch(() => "UNOPENABLE" as const);
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
}

describe("a power cut during a store's update", () => {
  it("leaves the 1.0 store or a whole copy of it at every one of ten points, and the next start finishes", async () => {
    const images = await cutAtEveryPoint();
    expect([...images.keys()]).toEqual([...POINTS]);
    const readings: string[] = [];
    for (const point of POINTS) {
      const image = images.get(point)!;
      const store = await readCopyOf(join(image, PGDATA_SUBDIR));
      // Past 1.0.11's head the window's six entries have committed together: the store is on the 2.0 line.
      const head = store === "UNOPENABLE" ? "UNOPENABLE" : store.head === OLD_HEAD ? "1.0" : store.head > OLD_HEAD ? "2.0" : `head ${store.head}`;
      // Under a copy's name there is a whole copy 1.0 opens, with the letter, or nothing at all.
      let copy = "none";
      if (existsSync(join(image, COPY))) {
        const held = await readCopyOf(join(image, COPY, PGDATA_SUBDIR));
        copy = held !== "UNOPENABLE" && held.head === OLD_HEAD && held.words === OLD_STORE.words && held.password === OLD_STORE.password
          && existsSync(join(image, COPY, "copy.json")) ? "whole" : "HALF A COPY UNDER A COPY'S NAME";
      }
      // The start after the cut: the store moved, one whole copy, no half one.
      const next = await openLocalDb(image, { transition: { way: "copy", openSealed: ring() } });
      const r = await next.db.execute(sql`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`);
      const moved = Number((r as unknown as { rows: Array<{ head: string }> }).rows[0]!.head) === NEW_HEAD;
      await next.close();
      const after = readdirSync(image).filter((n) => n.startsWith(COPY)).join(",");
      readings.push(`${point}: store ${head}, copy ${copy}; next start: ${moved ? "moved" : "NOT MOVED"}, ${after}`);
      rmSync(image, { recursive: true, force: true });
    }
    expect(readings).toEqual([
      `before the read: store 1.0, copy none; next start: moved, ${COPY}`,
      `after the close: store 1.0, copy none; next start: moved, ${COPY}`,
      `mid-copy: store 1.0, copy none; next start: moved, ${COPY}`,
      `after the last file: store 1.0, copy none; next start: moved, ${COPY}`,
      `after the tree sync: store 1.0, copy none; next start: moved, ${COPY}`,
      `after the manifest: store 1.0, copy none; next start: moved, ${COPY}`,
      `after the rename: store 1.0, copy whole; next start: moved, ${COPY}`,
      `after the reopen: store 1.0, copy whole; next start: moved, ${COPY}`,
      `inside the transaction: store 1.0, copy whole; next start: moved, ${COPY}`,
      `after the commit: store 2.0, copy whole; next start: moved, ${COPY}`,
    ]);
  }, 900_000);

  // Windows cannot open a folder to flush it; there the rename stands alone.
  it.skipIf(process.platform === "win32")("has the copy's name flushed into the data folder before the store's update begins", async () => {
    const dir = await folderAtOldHead("ohmail-store-copy-flush-");
    dirs.push(dir);
    const said: string[] = [];
    const undo = tellFolderFlushes((path) => (path === dir ? "the data folder" : null), (what) => said.push(what));
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(from).endsWith(`${COPY}.partial`)) said.push("the copy renamed into place");
    });
    try {
      const opened = await openLocalDb(dir, {
        onPhase: (phase) => { if (phase === "updating_store") said.push(phase); },
        transition: { way: "copy", openSealed: ring() },
      });
      await opened.close();
    } finally {
      vi.restoreAllMocks();
      undo();
    }
    // Lost in a power cut after the move's commit, the name would leave a moved store and half a copy the next open removes.
    expect(said).toEqual(expect.arrayContaining(["the copy renamed into place", "updating_store"]));
    expect(said.slice(said.indexOf("the copy renamed into place") + 1, said.indexOf("updating_store"))).toContain("the data folder flushed");
  }, 240_000);
});
