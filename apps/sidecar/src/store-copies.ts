import fs from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "./log.js";

/**
 * THE SECOND COPIES OF A STORE IN THE DATA FOLDER, AND WHAT REMOVES THEM.
 *
 * The update to 2.0 keeps the store 1.0 made: a desktop that organizes on its own gets a copy
 * (`store-before-2.0/`), a desktop paired to a server gets its old mirror moved aside whole
 * (`set-aside-refill-<stamp>/`). Either holds every letter the store held, and the first also the
 * mailbox passwords, sealed, with the key beside them. So each leaves by a stated rule, and this
 * file is the one place that removes one.
 *
 * It reads NAMES and its own marks, never a byte of a copied store, and every path is the data
 * folder plus one of the names below. It imports nothing of the store: `db.ts` makes the copies,
 * this only names, marks and removes them.
 */

/** The copy a desktop that organizes on its own takes before its store is moved: `<dataDir>/store-before-2.0/pgdata`. */
export const STORE_COPY_DIR = "store-before-2.0";
/** Where a store is moved rather than deleted: `<dataDir>/set-aside-<UTC stamp>/pgdata`. */
export const SET_ASIDE_PREFIX = "set-aside-" as const;
/** A paired desktop's 1.0 mirror, moved aside whole at its first start of 2.0. */
export const REFILL_SET_ASIDE_PREFIX = "set-aside-refill-";
/** A copy still being made. Never a copy: removed at the next open. */
export const PARTIAL_SUFFIX = ".partial";
/** A copy being removed: the rename to this name is the removal's commit. */
export const REMOVING_SUFFIX = ".removing";
/** An empty file inside a copy: what it was kept for is done, and the next open removes it. */
export const PROVEN_MARK = "proven";
/** A removal somebody asked for, written before it starts and cleared when nothing is left. */
export const OWED_LATCH = "store-copies.owed";

/** Why every copy goes at once. A closed set: it is the `kind` of the removal's log line. */
export type CopyWhy = "signed_out" | "mailbox_removed" | "taken_back" | "start_cleanup"
  | "owner_changed" | "started_over" | "session_revoked" | "account_erased" | "mailbox_erased";

const WHYS: ReadonlySet<string> = new Set<CopyWhy>([
  "signed_out", "mailbox_removed", "taken_back", "start_cleanup",
  "owner_changed", "started_over", "session_revoked", "account_erased", "mailbox_erased",
]);

/** An asked removal left a copy standing. No path and no name: the code says what, the count how many. */
export class StoreCopiesLeftError extends Error {
  readonly code = "store_copy_not_removed";
  constructor(readonly left: number) {
    super(`${left} earlier ${left === 1 ? "copy" : "copies"} of the mail store could not be removed from this computer`);
    this.name = "StoreCopiesLeftError";
  }
}

/** A copy being made or removed, by its name. */
function isLeftover(name: string): boolean {
  for (const suffix of [PARTIAL_SUFFIX, REMOVING_SUFFIX]) {
    if (name.endsWith(suffix) && isCopyBase(name.slice(0, -suffix.length))) return true;
  }
  return false;
}

function isCopyBase(name: string): boolean {
  return name === STORE_COPY_DIR || name.startsWith(SET_ASIDE_PREFIX);
}

/** The copy, or a set-aside of any kind: by name alone. */
function isCopy(name: string): boolean {
  return isCopyBase(name) && !isLeftover(name);
}

function entries(dataDir: string): string[] {
  try {
    return fs.readdirSync(dataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Make a folder's entries durable. Windows cannot open a folder for this; its rename stands alone. */
function flushDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* EISDIR or EPERM on Windows, or a filesystem with no folder flush: nothing more to give. */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Delete what stands at `path`, whatever it is, and say what went. `lstat` and never `stat`: a
 * link is unlinked, never followed, so nothing outside the data folder is ever reached. A folder
 * is made listable first: a copy's own modes must not be what keeps it.
 */
function deleteTree(path: string, tally: { bytes: number; count: number }): void {
  const st = fs.lstatSync(path);
  if (!st.isDirectory()) {
    fs.unlinkSync(path);
    if (st.isFile()) { tally.bytes += st.size; tally.count += 1; }
    return;
  }
  try { fs.chmodSync(path, 0o700); } catch { /* the listing below says so if it mattered */ }
  for (const name of fs.readdirSync(path)) deleteTree(join(path, name), tally);
  fs.rmdirSync(path);
}

/**
 * Remove one entry of the data folder by its exact name. Renamed to `<name>.removing` first and
 * the folder flushed: the rename is the commit, so no half tree ever stands under a copy's name.
 */
function removeOne(dataDir: string, name: string, tally: { bytes: number; count: number }): void {
  const from = join(dataDir, name);
  if (isLeftover(name)) {
    deleteTree(from, tally);
    flushDir(dataDir);
    return;
  }
  const gone = `${from}${REMOVING_SUFFIX}`;
  if (fs.existsSync(gone) || isLink(gone)) deleteTree(gone, tally);
  fs.renameSync(from, gone);
  flushDir(dataDir);
  deleteTree(gone, tally);
  flushDir(dataDir);
}

function isLink(path: string): boolean {
  try {
    return fs.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove each named entry; one that fails is counted and the rest still go. */
function removeEach(dataDir: string, names: readonly string[]): { bytes: number; count: number; left: number } {
  const tally = { bytes: 0, count: 0 };
  let left = 0;
  for (const name of names) {
    try {
      removeOne(dataDir, name, tally);
    } catch {
      left += 1;
    }
  }
  return { ...tally, left };
}

function latchStands(dataDir: string): boolean {
  try {
    fs.lstatSync(join(dataDir, OWED_LATCH));
    return true;
  } catch {
    return false;
  }
}

/** The latch's own word, when it reads as one; an unreadable latch still owes. */
function latchedWhy(dataDir: string): CopyWhy {
  try {
    const word = fs.readFileSync(join(dataDir, OWED_LATCH), "utf8").trim();
    return WHYS.has(word) ? (word as CopyWhy) : "start_cleanup";
  } catch {
    return "start_cleanup";
  }
}

/** Written into the data folder itself: what stands at its name and is no file is unlinked first, and no link is opened. */
function writeLatch(dataDir: string, why: CopyWhy): void {
  const path = join(dataDir, OWED_LATCH);
  try {
    if (!fs.lstatSync(path).isFile()) fs.unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeSync(fd, `${why}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  flushDir(dataDir);
}

function clearLatch(dataDir: string): void {
  try {
    fs.unlinkSync(join(dataDir, OWED_LATCH));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  flushDir(dataDir);
}

/** Does any copy, or anything left of one, stand in the data folder? Names only. */
export function storeCopiesStand(dataDir: string): boolean {
  return entries(dataDir).some((n) => isCopy(n) || isLeftover(n));
}

/** Does a whole copy of the store stand? The folder and the store inside it, by name; a link is not one. */
export function storeCopyStands(dataDir: string): boolean {
  try {
    return fs.lstatSync(join(dataDir, STORE_COPY_DIR)).isDirectory()
      && fs.lstatSync(join(dataDir, STORE_COPY_DIR, "pgdata")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove the copy itself, whole or half, by its exact names: what stands before a new one is
 * taken is of an earlier attempt, and the copy of an update refused with nothing of it applied
 * holds nothing the store does not. Throws when one stays, so no new copy is made over an old one.
 */
export function removeStoreCopy(dataDir: string): void {
  const tally = { bytes: 0, count: 0 };
  for (const name of [`${STORE_COPY_DIR}${PARTIAL_SUFFIX}`, `${STORE_COPY_DIR}${REMOVING_SUFFIX}`, STORE_COPY_DIR]) {
    if (fs.existsSync(join(dataDir, name)) || isLink(join(dataDir, name))) removeOne(dataDir, name, tally);
  }
}

/**
 * WRITE THAT A REMOVAL IS OWED, and nothing more: for the one caller whose own act comes between
 * the latch and the removal (a device taken back). Nothing is written where no copy stands.
 */
export function oweStoreCopies(dataDir: string, why: CopyWhy): void {
  if (storeCopiesStand(dataDir)) writeLatch(dataDir, why);
}

/**
 * EVERY COPY GOES, NOW: the copy and every set-aside, whatever made it. The latch is written
 * first and cleared last, so a removal cut short is finished by the next open. Throws while one
 * is left; a caller that must not go on over a copy (a sign-out, a mailbox's removal) refuses on it.
 */
export function forgetStoreCopies(dataDir: string, why: CopyWhy, log?: Diagnostic): void {
  const names = entries(dataDir).filter((n) => isCopy(n) || isLeftover(n));
  if (names.length === 0 && !latchStands(dataDir)) return;
  writeLatch(dataDir, why);
  const out = removeEach(dataDir, names);
  if (out.left > 0) {
    log?.("store_copies_removal_failed", {
      kind: why, count: out.left, verdict: "left",
      reason: "an earlier copy of the mail store could not be removed; the removal stays owed and "
        + "the next start tries it again before the store opens",
    });
    throw new StoreCopiesLeftError(out.left);
  }
  clearLatch(dataDir);
  log?.("store_copies_removed", {
    kind: why, count: names.length, bytes: out.bytes, verdict: "removed",
    reason: "every earlier copy of the mail store on this computer was removed",
  });
}

/** At every open, under the data folder's lock: a removal an earlier run owed is finished. Never throws. */
export function finishOwedRemoval(dataDir: string, log?: Diagnostic): void {
  try {
    if (!latchStands(dataDir)) return;
    forgetStoreCopies(dataDir, latchedWhy(dataDir), log);
  } catch {
    /* Said by the removal's own line. The latch stands, and the next open tries again. */
  }
}

/** At every open, under the lock: what a kill left of a copy being made or removed. Never throws. */
export function removeCopyLeftovers(dataDir: string, log?: Diagnostic): void {
  try {
    const names = entries(dataDir).filter(isLeftover);
    if (names.length === 0) return;
    const out = removeEach(dataDir, names);
    if (out.left > 0) {
      log?.("store_copies_removal_failed", {
        kind: "leftover", count: out.left, verdict: "left",
        reason: "what an interrupted copy or removal left behind could not be removed; the next start tries again",
      });
    }
  } catch {
    /* an unreadable data folder fails the open by its own name, a line later */
  }
}

/** Is the mark there as it was written: an empty file inside a real folder, and nothing else under its name. */
function proven(dataDir: string, name: string): boolean {
  try {
    if (!fs.lstatSync(join(dataDir, name)).isDirectory()) return false;
    const st = fs.lstatSync(join(dataDir, name, PROVEN_MARK));
    return st.isFile() && st.size === 0;
  } catch {
    return false;
  }
}

/**
 * THE ORDINARY RULE, at every open under the lock: a copy that carries its mark has done what it
 * was kept for and goes. One without the mark, or with a mark that does not read as one, stays:
 * no clock removes a copy. Never throws.
 */
export function removeProvenCopies(dataDir: string, log?: Diagnostic): void {
  try {
    const names = entries(dataDir).filter((n) => isCopy(n) && proven(dataDir, n));
    if (names.length === 0) return;
    const out = removeEach(dataDir, names);
    if (out.left > 0) {
      log?.("store_copies_removal_failed", {
        kind: "proven", count: out.left, verdict: "left",
        reason: "an earlier copy of the mail store was no longer needed and could not be removed; the next start tries again",
      });
    }
    if (names.length > out.left) {
      log?.("store_copies_removed", {
        kind: "proven", count: names.length - out.left, bytes: out.bytes, verdict: "removed",
        reason: "the mail store was updated and has served since, so the copy kept from before the update was removed",
      });
    }
  } catch {
    /* as above */
  }
}

/**
 * Mark what a copy was kept for as done: the copy, or every folder of a paired desktop's old
 * mirror. Only inside a real folder of the data folder, never through a link. A mark that cannot
 * be written leaves the copy where it is. Never throws.
 */
export function markProven(dataDir: string, kind: "copy" | "refill"): void {
  let names: string[];
  try {
    names = kind === "copy" ? [STORE_COPY_DIR] : entries(dataDir).filter((n) => n.startsWith(REFILL_SET_ASIDE_PREFIX) && isCopy(n));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const dir = join(dataDir, name);
      if (!fs.lstatSync(dir).isDirectory()) continue;
      /* A link at the mark's name fails the open, and the copy stays. */
      const fd = fs.openSync(join(dir, PROVEN_MARK), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      flushDir(dir);
    } catch {
      /* absent, or not writable: the copy stays */
    }
  }
}
