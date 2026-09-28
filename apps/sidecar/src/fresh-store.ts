import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { PGDATA } from "@electric-sql/pglite/basefs";
import { PGLITE_TRANSPORT_NAMES } from "./pglite-transport.js";

/**
 * A NEW STORE IS MADE IN MEMORY AND WRITTEN TO ITS DIRECTORY ONCE.
 *
 * `initdb` on the store's own disk writes its log a page at a time through the `O_DSYNC` descriptor
 * this store's durability rests on: about 3 400 synchronous writes, 5.4 s of a first start on a
 * Linux desktop, where the same `initdb` in memory takes 0.35 s. So a worker makes the cluster in
 * memory, shuts it down cleanly and writes its files out, `PG_VERSION` last: until that file exists
 * a kill leaves what `storeUnfinished` already sets aside. A worker rather than this thread, so the
 * second PGlite's memory leaves with it.
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
