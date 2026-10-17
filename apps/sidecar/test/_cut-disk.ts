import fs, { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PGDATA_SUBDIR } from "../src/db.js";

/**
 * THE POWER-CUT EMULATOR AT THE node:fs SEAM, shared by the cut tests. A byte under the root counts
 * as on the disk only once it was fsynced, or written through a descriptor opened `O_SYNC`; the
 * rest is the page cache, gone at the cut. Directory entries are taken as they stand, the generous
 * side. A root that does not exist yet (a first start) begins empty.
 */

type AnyFn = (...a: unknown[]) => unknown;
const F = fs as unknown as Record<string, AnyFn>;
const SEAM = ["openSync", "closeSync", "writeSync", "fsyncSync", "fdatasyncSync", "renameSync", "unlinkSync", "ftruncateSync", "writeFileSync"];
const O_SYNC = fs.constants.O_SYNC;

/** What the disk holds, by path under the root: each file's bytes as last made durable. */
export class Disk {
  readonly files = new Map<string, Buffer>();
  private readonly fds = new Map<number, { rel: string; sync: boolean }>();
  private readonly real = Object.fromEntries(SEAM.map((n) => [n, F[n]!])) as Record<string, AnyFn>;
  constructor(private readonly root: string) {
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const abs = join(dir, n);
        if (statSync(abs).isDirectory()) walk(abs); else this.files.set(abs.slice(root.length + 1), readFileSync(abs));
      }
    };
    if (existsSync(root)) walk(root);
  }
  private rel(p: unknown): string | null {
    const a = typeof p === "string" ? resolve(p) : "";
    return a.startsWith(this.root + sep) ? a.slice(this.root.length + 1) : null;
  }
  private put(rel: string, at: number, bytes: Buffer): void {
    const cur = this.files.get(rel) ?? Buffer.alloc(0);
    const next = Buffer.concat([cur, Buffer.alloc(Math.max(0, at + bytes.length - cur.length))]);
    bytes.copy(next, at);
    this.files.set(rel, next);
  }
  install(): void {
    const { real } = this;
    F.openSync = (p, flags, mode) => {
      const rel = this.rel(p), fresh = rel !== null && !existsSync(p as string);
      const fd = real.openSync!.call(fs, p, flags, mode) as number;
      if (rel !== null && fs.fstatSync(fd).isFile()) {
        const n = typeof flags === "number" ? flags : 0;
        this.fds.set(fd, { rel, sync: (n & O_SYNC) === O_SYNC });
        if (fresh || n & fs.constants.O_TRUNC) this.files.set(rel, Buffer.alloc(0));
      }
      return fd;
    };
    F.closeSync = (fd) => { this.fds.delete(fd as number); return real.closeSync!.call(fs, fd); };
    F.writeSync = (...a) => {
      const n = real.writeSync!.apply(fs, a) as number;
      const t = this.fds.get(a[0] as number);
      const [, buf, off, , pos] = a as [number, ArrayBufferView, number, number, number];
      if (t?.sync && typeof pos === "number") this.put(t.rel, pos, Buffer.from(buf.buffer, buf.byteOffset + Number(off ?? 0), n));
      return n;
    };
    const durable = (name: string): AnyFn => (fd) => {
      const r = real[name]!.call(fs, fd);
      const t = this.fds.get(fd as number);
      if (t) this.files.set(t.rel, readFileSync(join(this.root, t.rel)));
      return r;
    };
    F.fsyncSync = durable("fsyncSync");
    F.fdatasyncSync = durable("fdatasyncSync");
    F.renameSync = (a, b) => {
      const r = real.renameSync!.call(fs, a, b);
      const ra = this.rel(a), rb = this.rel(b);
      if (ra !== null && rb !== null) { this.files.set(rb, this.files.get(ra) ?? Buffer.alloc(0)); this.files.delete(ra); }
      return r;
    };
    F.unlinkSync = (p) => { const r = real.unlinkSync!.call(fs, p); const rp = this.rel(p); if (rp !== null) this.files.delete(rp); return r; };
    F.ftruncateSync = (fd, len) => {
      const r = real.ftruncateSync!.call(fs, fd, len);
      const t = this.fds.get(fd as number);
      if (t) this.files.set(t.rel, (this.files.get(t.rel) ?? Buffer.alloc(0)).subarray(0, Number(len ?? 0)));
      return r;
    };
    F.writeFileSync = (p, d, o) => { const r = real.writeFileSync!.call(fs, p, d, o); const rp = this.rel(p); if (rp !== null) this.files.set(rp, Buffer.alloc(0)); return r; };
  }
  restore(): void { for (const n of SEAM) F[n] = this.real[n]!; }
  /** The data directory after the cut: the entries as they stand, each file's bytes as last made durable. */
  image(dataDir: string): string {
    const dest = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-cut-image-"));
    cpSync(dataDir, dest, { recursive: true });
    rmSync(join(dest, "sidecar.lock"), { force: true });   // this process still holds the live store's
    const root = join(dest, PGDATA_SUBDIR);
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const abs = join(dir, n);
        if (statSync(abs).isDirectory()) walk(abs);
        else this.real.writeFileSync!.call(fs, abs, this.files.get(abs.slice(root.length + 1)) ?? Buffer.alloc(0));
      }
    };
    walk(root);
    return dest;
  }
}

/** Node on Windows: only O_APPEND O_CREAT O_EXCL O_RDONLY O_RDWR O_TRUNC O_WRONLY, so no sync flag. */
export async function withNodeShape<T>(shape: "linux" | "windows", fn: () => Promise<T>): Promise<T> {
  if (shape === "linux") return fn();
  const p = process as unknown as { binding: (n: string) => Record<string, unknown> };
  const orig = p.binding;
  p.binding = (name: string) => {
    const b = orig.call(process, name);
    if (name !== "constants") return b;
    const f = { ...(b.fs as Record<string, unknown>) };
    delete f.O_SYNC;
    delete f.O_DSYNC;
    return { ...b, fs: f };
  };
  try { return await fn(); } finally { p.binding = orig; }
}

