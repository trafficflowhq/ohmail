import fs from "node:fs";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { PGDATA } from "@electric-sql/pglite/basefs";

/**
 * PGLITE'S PROTOCOL TRANSPORT, KEPT OUT OF THE DATA DIRECTORY.
 *
 * Every protocol round trip (six per parameterised statement) makes the WASM probe `.in` and
 * create-and-truncate `.lock.out` in the PGDATA root, and NodeFS mounts that root on disk: 654 of
 * the 757 file operations an imported message cost on Linux. The names are compiled into
 * `postgres.wasm`, carry no committed byte and live one round trip, so they are served from memory.
 * Every other path is the disk exactly as before — the log, the relations, the control file.
 */
export const PGLITE_TRANSPORT_NAMES: ReadonlySet<string> = new Set([
  ".s.PGSQL.5432.in",
  ".s.PGSQL.5432.out",
  ".s.PGSQL.5432.lock.out",
]);

/* The Emscripten FS surface this reaches, typed only as far as it is used. */
interface EmNode {
  name: string;
  mode: number;
  parent: EmNode;
  node_ops: EmNodeOps;
  stream_ops: unknown;
  usedBytes?: number;
  contents?: unknown;
  atime?: number;
  mtime?: number;
  ctime?: number;
}
interface EmNodeOps {
  lookup(parent: EmNode, name: string): EmNode;
  mknod(parent: EmNode, name: string, mode: number, dev: number): EmNode;
  unlink(parent: EmNode, name: string): void;
  rename(node: EmNode, newDir: EmNode, newName: string): void;
  [op: string]: unknown;
}
interface EmFs {
  lookupPath(path: string): { node: EmNode };
  lookupNode(parent: EmNode, name: string): EmNode;
  createNode(parent: EmNode, name: string, mode: number, dev: number): EmNode;
  destroyNode(node: EmNode): void;
  isFile(mode: number): boolean;
  ErrnoError: new (errno: number) => Error;
  filesystems: {
    MEMFS: { ops_table: { file: { node: EmNodeOps; stream: unknown } } | null };
    NODEFS?: EmNodeFs;
  };
}
/* An open file on the NODEFS mount: `nfd` is the host descriptor, absent for a directory. */
interface EmStream {
  nfd?: number;
  node: EmNode;
}
export type StoreFsyncOp = (stream: EmStream) => number;
interface EmNodeFs {
  stream_ops: { fsync?: StoreFsyncOp };
  realPath(node: EmNode): string;
  tryFSOperation<T>(op: () => T): T;
}

const ENOENT = 44, EPERM = 63, EXDEV = 75;

/**
 * Route the transport names of the mount root to memory: a name nobody created here does not exist,
 * a created one is a MEMFS file (its reads, writes and truncation never leave the heap), an unlink
 * forgets it, a listing leaves the names out (a store an older build ran still holds an empty
 * `.lock.out`). Only the root's own ops are replaced; a rename across the boundary refuses (EXDEV).
 */
function keepTransportInMemory(FS: EmFs, pgdata: string, names: ReadonlySet<string> = PGLITE_TRANSPORT_NAMES): void {
  const root = FS.lookupPath(pgdata).node;
  const disk = root.node_ops;
  const file = FS.filesystems.MEMFS.ops_table?.file;
  if (!file) throw new Error("the in-memory filesystem is not initialised, so the protocol transport has nowhere to live");
  root.node_ops = {
    ...disk,
    lookup(parent, name) {
      if (names.has(name)) throw new FS.ErrnoError(ENOENT);
      return disk.lookup(parent, name);
    },
    mknod(parent, name, mode, dev) {
      if (!names.has(name)) return disk.mknod(parent, name, mode, dev);
      if (!FS.isFile(mode)) throw new FS.ErrnoError(EPERM);
      const node = FS.createNode(parent, name, mode, dev);
      node.node_ops = file.node;
      node.stream_ops = file.stream;
      node.usedBytes = 0;
      node.contents = null;
      node.atime = node.mtime = node.ctime = Date.now();
      return node;
    },
    unlink(parent, name) {
      if (!names.has(name)) disk.unlink(parent, name);
    },
    readdir(node: EmNode) {
      return (disk.readdir as (n: EmNode) => string[])(node).filter((name) => !names.has(name));
    },
    rename(node, newDir, newName) {
      const from = names.has(node.name), to = newDir === root && names.has(newName);
      if (from !== to) throw new FS.ErrnoError(EXDEV);
      if (!from) return disk.rename(node, newDir, newName);
      try { FS.destroyNode(FS.lookupNode(newDir, newName)); } catch { /* no target: a plain move */ }
      node.name = newName;
    },
  };
}

/** The syncs the store's fsync has made since its filesystem was mounted. The open's guard reads it. */
export interface StoreSyncCount {
  files: number;
  directories: number;
}

/* What a platform answers when it cannot sync a directory at all — Windows refuses one opened for
   reading. Postgres skips these for a directory, and so does this; anything else is a failure. */
const DIRECTORY_SYNC_REFUSED: ReadonlySet<string> = new Set(["EISDIR", "EACCES", "EPERM", "EBADF", "EINVAL", "ENOTSUP"]);

function refusedForDirectory(err: unknown): boolean {
  return DIRECTORY_SYNC_REFUSED.has(String((err as NodeJS.ErrnoException | null)?.code));
}

/** Sync a directory's entries; `false` where the platform cannot. */
export function syncDirectory(path: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(path, "r");
  } catch (err) {
    if (refusedForDirectory(err)) return false;
    throw err;
  }
  try {
    fs.fsyncSync(fd);
    return true;
  } catch (err) {
    if (refusedForDirectory(err)) return false;
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * THE STORE'S FSYNC, WHICH PGLITE'S NODE FILESYSTEM DOES NOT HAVE. Emscripten's NODEFS defines
 * none, so every `pg_fsync` answered 0 having synced nothing: the control file at each open and
 * checkpoint, the relations a checkpoint wrote, the log's recycling renames. A power cut inside
 * the writeback window then left a store that would not open, or one that opened without the rows
 * committed since its open. With this, Postgres' own durability reaches the disk; a failed sync
 * reaches Postgres as its errno. A directory's stream holds no descriptor, so it is opened here.
 */
function installStoreFsync(FS: EmFs, count: StoreSyncCount, held: () => boolean): StoreFsyncOp {
  const nodefs = FS.filesystems.NODEFS;
  if (!nodefs) throw new StoreFsyncMissingError("PGlite's node filesystem is not registered");
  const fsync: StoreFsyncOp = (stream) => nodefs.tryFSOperation(() => {
    /* Held for a new store's tree sync (`holdSyncs`): touches nothing and counts nothing, so a
       hold placed before the open's commit proof makes the open refuse. */
    if (held()) return 0;
    if (typeof stream.nfd === "number") {
      fs.fsyncSync(stream.nfd);
      count.files += 1;
    } else if (syncDirectory(nodefs.realPath(stream.node))) {
      count.directories += 1;
    }
    return 0;
  });
  nodefs.stream_ops.fsync = fsync;
  return fsync;
}

/** The open refuses a store whose start did not sync through {@link installStoreFsync}'s fsync. */
export class StoreFsyncMissingError extends Error {
  constructor(readonly reading: string) {
    super(
      `the local store's filesystem cannot vouch for its fsync: ${reading}. Without it the control `
      + "file and the relations reach the disk only when the system gets round to it, so a power "
      + "cut could lose a rule or a draft, or leave the store unopenable",
    );
    this.name = "StoreFsyncMissingError";
  }
}

/**
 * Why a started store's fsync cannot be vouched for, or `null`: it must be the one this filesystem
 * installed, still in place, and the start's own control-file write must have gone through it —
 * which a hook that moved past Postgres' start would not see, nor a store running with fsync off.
 */
export function storeFsyncFault(installed: unknown, current: unknown, files: number): string | null {
  if (typeof installed !== "function") return "the start hook that installs it never ran";
  if (current !== installed) return "another fsync replaced it after it was installed";
  if (files < 1) return "the start synced nothing through it";
  return null;
}

/**
 * PGlite's own NodeFS, with {@link keepTransportInMemory} and {@link installStoreFsync} applied in
 * `initialSyncFs` — the one hook that runs after the module has mounted the data directory and
 * before Postgres starts. (A preRun would depend on Emscripten running that array in reverse.)
 */
export class LocalStoreFs extends NodeFS {
  readonly synced: StoreSyncCount = { files: 0, directories: 0 };
  #fsync: StoreFsyncOp | undefined;
  #held = false;

  override async initialSyncFs(): Promise<void> {
    await super.initialSyncFs();
    if (!this.pg) throw new Error("the store's filesystem was synced before PGlite handed it a module");
    const FS = this.pg.Module.FS as unknown as EmFs;
    keepTransportInMemory(FS, PGDATA);
    this.#fsync = installStoreFsync(FS, this.synced, () => this.#held);
  }

  /**
   * Hold every sync Postgres asks for until the returned release (idempotent). ONLY for a store
   * this start is making, between its commit proof and `syncStoreTree`: the start marker stands
   * until that tree sync has put every file on the disk, so a cut in between sets the store aside,
   * and each held sync would have bought nothing but a device flush (241 on a first start's schema
   * pass; F_FULLFSYNC on macOS, FlushFileBuffers on Windows).
   */
  holdSyncs(): () => void {
    this.#held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held = false;
    };
  }

  /** After `waitReady`: throw {@link StoreFsyncMissingError} unless the start synced through this fsync. */
  assertSynced(): void {
    const FS = this.pg?.Module?.FS as unknown as EmFs | undefined;
    const fault = storeFsyncFault(this.#fsync, FS?.filesystems.NODEFS?.stream_ops.fsync, this.synced.files);
    if (fault !== null) throw new StoreFsyncMissingError(fault);
  }
}
