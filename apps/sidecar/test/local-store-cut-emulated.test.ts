import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PGDATA_SUBDIR, openLocalDb, type OpenLocalDb } from "../src/db.js";
import { forWindow, inStoreLane } from "../src/store-lanes.js";
import { freshDataDir } from "./_datadir.js";
import { Disk, withNodeShape } from "./_cut-disk.js";

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
async function cut(shape: "linux" | "windows", kind: "open" | "checkpoint" | "deferred"): Promise<string> {
  const dir = await freshDataDir(`ohmail-cut-${shape}-${kind}-`);
  dirs.push(dir);
  const made = await openLocalDb(dir);
  const acct = String(rowsOf(await made.db.execute(sql.raw("INSERT INTO accounts (name) VALUES ('cut') RETURNING id::text AS id")))[0]!.id);
  const mbx = String(rowsOf(await made.db.execute(sql`INSERT INTO mailboxes (account_id, provider, address) VALUES (${acct}::uuid, 'imap', 'cut@rig.invalid') RETURNING id::text AS id`))[0]!.id);
  await made.close();
  const disk = new Disk(join(dir, PGDATA_SUBDIR));
  const ids: string[] = [];
  let h: OpenLocalDb | null = null;
  /* "deferred": a person's request is open, so the checkpoint asked after the log grew is still
     waiting for the window (`db.ts`) when the power goes. */
  let release = (): void => {};
  let checkpointed = false;
  disk.install();
  try {
    h = await withNodeShape(shape, () => openLocalDb(dir));
    await acknowledged(h, "A", 10, acct, mbx, ids);
    if (kind === "checkpoint") { await h.checkpoint(); await fill(h, 3); await h.checkpoint(); }
    if (kind === "deferred") {
      await fill(h, 3);
      void forWindow(() => new Promise<void>((r) => { release = r; }));
      void h.checkpoint().then(() => { checkpointed = true; });
    }
    await acknowledged(h, "D", 10, acct, mbx, ids);
  } finally {
    disk.restore();
  }
  const image = disk.image(dir);
  dirs.push(image);
  release();
  await h?.close();
  if (kind === "deferred" && checkpointed) return "THE CHECKPOINT RAN BEFORE THE CUT";
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

  it("keeps every acknowledged row cut while a checkpoint waits for the window, with Windows' fs constants", async () => {
    expect(await cut("windows", "deferred")).toBe("KEPT 40/40");
  }, 180_000);

  /* The control: the ordinary shape keeps them too, so a red above is the shape's and not the emulator's. */
  it("keeps every acknowledged row with Linux's fs constants", async () => {
    expect(await cut("linux", "open")).toBe("KEPT 40/40");
  }, 180_000);
});
