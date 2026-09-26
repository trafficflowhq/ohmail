import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";

/**
 * STAGE AND RENAME — the one atomic write this process has, in one place.
 *
 * A file written in place is torn by any interruption, and every file here is one the next launch
 * depends on: a sealed credential, the door's private key, the provider store. Rename is atomic
 * within a directory, so a reader sees the previous complete file or the new complete file and
 * never a prefix of either. The mode goes on the TEMPORARY file rather than after the rename: a
 * private key must not exist at the final path in a readable mode, not even for a moment.
 */

/** The staging name. Per-process, so two launches writing one path cannot share a temp file. */
function tempFor(path: string): string {
  return `${path}.${process.pid}.tmp`;
}

/** The synchronous form — the seal and the LAN door's identity. Throws what the write throws. */
export function writeAtomic(path: string, contents: string, mode: number): void {
  const tmp = tempFor(path);
  writeFileSync(tmp, contents, { encoding: "utf8", mode });
  try {
    renameSync(tmp, path);
  } catch (err) {
    // The target is untouched — a refused rename is the whole point — so all that is owed is the
    // staging file, removed here rather than left in the data directory for every failed write.
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/** The same, on the promises API, for a caller already inside an async write path. */
export async function writeAtomicFile(path: string, contents: string, mode: number): Promise<void> {
  const tmp = tempFor(path);
  await writeFile(tmp, contents, { encoding: "utf8", mode });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * The same, with the staged bytes flushed to the disk BEFORE the rename — for a file whose loss
 * on a power cut is a person's lost work (the window's queued changes), not a re-derivable cache.
 * Without the flush a rename can reach the disk ahead of the data it names.
 */
export async function writeAtomicFileSynced(path: string, contents: string, mode: number): Promise<void> {
  const tmp = tempFor(path);
  try {
    const fh = await open(tmp, "w", mode);
    try {
      await fh.writeFile(contents, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
