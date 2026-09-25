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
  filesystems: { MEMFS: { ops_table: { file: { node: EmNodeOps; stream: unknown } } | null } };
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

/**
 * PGlite's own NodeFS, with {@link keepTransportInMemory} applied in `initialSyncFs` — the one hook
 * that runs after the module has mounted the data directory and before Postgres starts. (A preRun
 * would depend on Emscripten running that array in reverse.)
 */
export class LocalStoreFs extends NodeFS {
  override async initialSyncFs(): Promise<void> {
    await super.initialSyncFs();
    if (!this.pg) throw new Error("the store's filesystem was synced before PGlite handed it a module");
    keepTransportInMemory(this.pg.Module.FS as unknown as EmFs, PGDATA);
  }
}
