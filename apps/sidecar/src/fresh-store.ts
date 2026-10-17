import fs from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import wt, { Worker } from "node:worker_threads";
import { PGDATA } from "@electric-sql/pglite/basefs";
import { PGLITE_TRANSPORT_NAMES, syncDirectory } from "./pglite-transport.js";

/**
 * A NEW STORE IS MADE IN MEMORY AND WRITTEN TO ITS DIRECTORY ONCE.
 *
 * `initdb` on the store's own disk writes its log a page at a time through an `O_DSYNC` descriptor
 * (its default, before the store's settings exist): about 3 400 synchronous writes, 5.4 s of a
 * first start on a Linux desktop, where the same `initdb` in memory takes 0.35 s. So a worker makes
 * the cluster in memory, shuts it down cleanly and writes its files out, `PG_VERSION` last: until
 * that file exists a kill leaves what `storeUnfinished` already sets aside. A worker rather than
 * this thread, so the second PGlite's memory leaves with it.
 */
const MAKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
(async () => {
  const { PGlite } = await import(workerData.pglite);
  const pg = new PGlite();
  await pg.waitReady;
  await pg.close();
  const FS = pg.Module.FS;
  let version = null;
  let files = 0;
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of FS.readdir(from)) {
      if (name === "." || name === ".." || workerData.skip.includes(name)) continue;
      const path = from + "/" + name;
      const mode = FS.lstat(path).mode;
      if (FS.isDir(mode)) { copy(path, join(to, name)); continue; }
      if (!FS.isFile(mode)) throw new Error("the made store holds an entry that is neither a file nor a directory");
      const bytes = FS.readFile(path);
      if (from === workerData.pgdata && name === "PG_VERSION") { version = bytes; continue; }
      writeFileSync(join(to, name), bytes, { mode: 0o600 });
      files += 1;
    }
  };
  copy(workerData.pgdata, workerData.to);
  if (version === null) throw new Error("the made store has no PG_VERSION");
  writeFileSync(join(workerData.to, "PG_VERSION"), version, { mode: 0o600 });
  parentPort.postMessage({ files: files + 1 });
})().catch((err) => parentPort.postMessage({ error: String((err && err.message) || err) }));
`;

/** How long a first start waits for the worker before making the store on disk as it used to. */
export const FRESH_STORE_BOUND_MS = 60_000;

/**
 * PGlite's ES module, beside the one this process loaded: the CommonJS entry the resolver names,
 * with its `.js` twin. The worker imports it by URL, so it runs the same build as the store.
 */
function pgliteModuleUrl(): string {
  const entry = createRequire(import.meta.url).resolve("@electric-sql/pglite");
  return pathToFileURL(entry.replace(/\.cjs$/, ".js")).href;
}

/**
 * Write a fresh cluster into `pgDataDir`, which must be absent or empty. Resolves with the number
 * of files written; rejects on any failure or past `boundMs`, with the worker stopped either way,
 * so the caller can remove what was written and fall back.
 */
export async function makeStoreInMemory(pgDataDir: string, boundMs: number = FRESH_STORE_BOUND_MS): Promise<number> {
  const worker = new Worker(MAKER, {
    eval: true,
    workerData: { pglite: pgliteModuleUrl(), pgdata: PGDATA, to: pgDataDir, skip: [...PGLITE_TRANSPORT_NAMES] },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`the store was not made in memory within ${boundMs} ms`)), boundMs);
      worker.once("message", (m: { files?: unknown; error?: unknown }) => {
        if (typeof m?.files === "number") resolve(m.files);
        else reject(new Error(typeof m?.error === "string" ? m.error : "the store maker answered nothing"));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`the store maker exited ${code} before answering`)));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

/**
 * ONE SLICE OF THE CATALOG, SYNCED. Its own thread because a sync waits for the disk's journal:
 * 1 300 files one after another took 6.6 s on a Linux desktop, sixteen threads 1.0 s.
 */
const SYNCER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
try {
  for (const p of workerData.paths) {
    const fd = fs.openSync(p, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  parentPort.postMessage({ synced: workerData.paths.length });
} catch (err) {
  parentPort.postMessage({ error: String((err && err.message) || err) });
}
`;

/** How many threads sync a new store's files. */
export const STORE_SYNC_THREADS = 16;

function syncSlice(paths: readonly string[]): Promise<number> {
  /* `wt.Worker`, read at the call, so the cut emulator can run this slice at its seam. */
  const worker = new wt.Worker(SYNCER, { eval: true, workerData: { paths } });
  return new Promise<number>((resolve, reject) => {
    worker.once("message", (m: { synced?: unknown; error?: unknown }) => {
      if (typeof m?.synced === "number") resolve(m.synced);
      else reject(new Error(typeof m?.error === "string" ? m.error : "the store syncer answered nothing"));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`the store syncer exited ${code} before answering`)));
  }).finally(() => { void worker.terminate(); });
}

/**
 * PUT A NEW STORE'S CATALOG ON THE DISK before the start marks it finished. The maker above writes
 * it with `writeFileSync`, and `initdb` on the disk (the fallback) through a filesystem that syncs
 * only what Postgres asks: neither syncs the files, so a power cut after the marker cleared could
 * leave a half catalog no later start sets aside. Every file (`r+`: Windows flushes only through
 * a handle that may write), then each directory after its entries, `dir` last.
 */
export async function syncStoreTree(dir: string, threads: number = STORE_SYNC_THREADS): Promise<number> {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
    dirs.push(at);
  };
  walk(dir);
  const k = Math.max(1, Math.min(threads, files.length));
  const slices = Array.from({ length: k }, (_, i) => files.filter((_, j) => j % k === i));
  const synced = (await Promise.all(slices.map(syncSlice))).reduce((a, b) => a + b, 0);
  for (const at of dirs) syncDirectory(at);
  return synced;
}
