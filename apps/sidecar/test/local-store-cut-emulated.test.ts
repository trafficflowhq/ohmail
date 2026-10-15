import fs, { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PGDATA_SUBDIR, openLocalDb, type OpenLocalDb } from "../src/db.js";
import { inStoreLane } from "../src/store-lanes.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ═══ A POWER CUT, EMULATED AT THE node:fs SEAM, IN BOTH SHAPES OF NODE ══════════════════════
 *
 * A byte under `pgdata/` counts as on the disk only once it was fsynced, or written through a
 * descriptor opened `O_SYNC`; the rest is the page cache, gone at the cut. Directory entries are
 * taken as they stand, the generous side. The image is opened by the shipped `openLocalDb` and
 * every acknowledged row is asked for. "windows" gives PGlite's NODEFS the fs constants Node has
 * there — no `O_SYNC` — the shape in which the log used to stay in the cache. The method is the
 * store's security review's; real cuts on a Linux guest read the same two classes.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type AnyFn = (...a: unknown[]) => unknown;
const F = fs as unknown as Record<string, AnyFn>;
const SEAM = ["openSync", "closeSync", "writeSync", "fsyncSync", "fdatasyncSync", "renameSync", "unlinkSync", "ftruncateSync", "writeFileSync"];
const O_SYNC = fs.constants.O_SYNC;

/** What the disk holds, by path under the root: each file's bytes as last made durable. */
class Disk {
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
    walk(root);
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
async function withNodeShape<T>(shape: "linux" | "windows", fn: () => Promise<T>): Promise<T> {
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

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  ((r as { rows?: Array<Record<string, unknown>> }).rows ?? (r as Array<Record<string, unknown>>));

/** Rules and drafts, each acknowledged by its own synchronous commit; their ids are what is owed. */
async function acknowledged(h: OpenLocalDb, phase: string, n: number, acct: string, mbx: string, ids: string[]): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const r = rowsOf(await h.db.execute(sql`INSERT INTO rules (account_id, kind, match, destination) VALUES (${acct}::uuid, 'sender', ${`cut-${phase}-${i}@rig.invalid`}, 'Archive') RETURNING id::text AS id`))[0]!;
    ids.push(`rules ${String(r.id)}`);
    const d = rowsOf(await h.db.execute(sql`INSERT INTO drafts (account_id, mailbox_id, subject, body) VALUES (${acct}::uuid, ${mbx}::uuid, ${`cut ${phase} ${i}`}, ${"x".repeat(1200)}) RETURNING id::text AS id`))[0]!;
    ids.push(`drafts ${String(d.id)}`);
  }
}

/** Log through the ingest lane until it grew `mb`, so the next checkpoint recycles the redo segment. */
async function fill(h: OpenLocalDb, mb: number): Promise<void> {
  await h.db.execute(sql.raw("CREATE TABLE cut_fill (id serial PRIMARY KEY, pad text NOT NULL)"));
  await h.db.execute(sql.raw("ALTER TABLE cut_fill ALTER COLUMN pad SET STORAGE EXTERNAL"));
  const start = String(rowsOf(await h.db.execute(sql.raw("SELECT pg_current_wal_insert_lsn()::text AS l")))[0]!.l);
  for (let grew = 0; grew < mb * 1024 * 1024;) {
    await inStoreLane("ingest", () => h.db.transaction(async (tx) => {
      for (let k = 0; k < 8; k += 1) await tx.execute(sql`INSERT INTO cut_fill (pad) VALUES (${Buffer.alloc(36 * 1024, k + 65).toString("base64")})`);
    }));
    grew = Number(rowsOf(await h.db.execute(sql`SELECT (pg_current_wal_insert_lsn() - ${start}::pg_lsn)::bigint AS g`))[0]!.g);
  }
}

/** One cut: a store that has existed a while, a session in `shape`, the cut, and what the image keeps. */
async function cut(shape: "linux" | "windows", kind: "open" | "checkpoint"): Promise<string> {
  const dir = await freshDataDir(`ohmail-cut-${shape}-${kind}-`);
  dirs.push(dir);
  const made = await openLocalDb(dir);
  const acct = String(rowsOf(await made.db.execute(sql.raw("INSERT INTO accounts (name) VALUES ('cut') RETURNING id::text AS id")))[0]!.id);
  const mbx = String(rowsOf(await made.db.execute(sql`INSERT INTO mailboxes (account_id, provider, address) VALUES (${acct}::uuid, 'imap', 'cut@rig.invalid') RETURNING id::text AS id`))[0]!.id);
  await made.close();
  const disk = new Disk(join(dir, PGDATA_SUBDIR));
  const ids: string[] = [];
  let h: OpenLocalDb | null = null;
  disk.install();
  try {
    h = await withNodeShape(shape, () => openLocalDb(dir));
    await acknowledged(h, "A", 10, acct, mbx, ids);
    if (kind === "checkpoint") { await h.checkpoint(); await fill(h, 3); await h.checkpoint(); }
    await acknowledged(h, "D", 10, acct, mbx, ids);
  } finally {
    disk.restore();
  }
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
  for (const line of ids) {
    const [table, id] = line.split(" ");
    kept += Number(rowsOf(await after.db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${table} WHERE id = '${id}'::uuid`)))[0]!.c);
  }
  await after.close();
  return `KEPT ${kept}/${ids.length}`;
}

describe("a power cut emulated at the node:fs seam", () => {
  it("keeps every acknowledged row of a session cut soon after its open, with Windows' fs constants", async () => {
    expect(await cut("windows", "open")).toBe("KEPT 40/40");
  }, 180_000);

  it("keeps the store and every row cut after a checkpoint that recycled the log, with Windows' fs constants", async () => {
    expect(await cut("windows", "checkpoint")).toBe("KEPT 40/40");
  }, 180_000);

  /* The control: the ordinary shape keeps them too, so a red above is the shape's and not the emulator's. */
  it("keeps every acknowledged row with Linux's fs constants", async () => {
    expect(await cut("linux", "open")).toBe("KEPT 40/40");
  }, 180_000);
});
