import fs, { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MAIL_JOURNAL, TransitionFailed, TransitionRefused, readJournalOf, type Decrypts } from "@trafficflow/db/journal";
import { journalThrough } from "../../../packages/db/src/testing-journal.js";
import {
  LOCAL_STORE_EXTENSIONS, LocalStoreOpenError, PGDATA_SUBDIR, STORE_COPY_ROOM_FACTOR, StoreUpdateRefusedError, openLocalDb,
} from "../src/db.js";
import { forgetStoreCopies } from "../src/store-copies.js";
import { tellFolderFlushes } from "./_cut-disk.js";
import { NEW_HEAD, OLD_HEAD, OLD_STORE, folderAtOldHead, readAsOneOh, ring, treeOf } from "./_old-head-store.js";

/**
 * A DESKTOP'S 1.0 STORE IS COPIED BEFORE 2.0 MOVES IT. The six entries that move a store take
 * columns a 1.0 engine reads, so the only way back is the store as it stood. At the open that
 * finds such a store, a whole copy of it is taken first, with the store closed, and the move
 * runs only beside that copy. The copy is what 1.0 can open: same head, same letter, same sealed
 * password. A copy that cannot be taken refuses the update by name, and the store is what it was.
 */

const COPY = "store-before-2.0";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function oldFolder(): Promise<string> {
  const dir = await folderAtOldHead("ohmail-store-copy-");
  dirs.push(dir);
  return dir;
}

interface Opened { head: number; lines: Array<{ event: string; detail: Record<string, unknown> }> }

/** One start of the engine's store over `dir`, naming the copy as the way; closed again before it answers. */
async function start(
  dir: string,
  o: { openSealed?: Decrypts; before?: () => Promise<void>; onLine?: (event: string) => void } = {},
): Promise<Opened> {
  const lines: Opened["lines"] = [];
  const opened = await openLocalDb(dir, {
    log: (event, detail) => { lines.push({ event, detail }); o.onLine?.(event); },
    transition: { way: "copy", openSealed: o.openSealed ?? ring(), ...(o.before ? { before: o.before } : {}) },
  });
  try {
    const r = await opened.db.execute(sql`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`);
    return { head: Number((r as unknown as { rows: Array<{ head: string }> }).rows[0]!.head), lines };
  } finally {
    await opened.close();
  }
}

const refusal = (p: Promise<unknown>): Promise<StoreUpdateRefusedError> =>
  p.then(() => { throw new Error("the open was not refused"); }, (err: unknown) => err as StoreUpdateRefusedError);

/** The copy as 1.0 would read it, from a copy of it: opening a store writes to it. */
async function copyAsOneOh(dir: string): ReturnType<typeof readAsOneOh> {
  const aside = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-store-copy-read-"));
  dirs.push(aside);
  cpSync(join(dir, COPY, PGDATA_SUBDIR), join(aside, PGDATA_SUBDIR), { recursive: true });
  return readAsOneOh(join(aside, PGDATA_SUBDIR));
}

/** The data folder's own entries, without the lock a running or ended engine leaves. */
const entriesOf = (dir: string): string[] => readdirSync(dir).filter((n) => !n.startsWith("sidecar.")).sort();

describe("a 1.0 store, opened by 2.0 with a copy named as the way", () => {
  it("is copied whole before its first statement moves, and the copy is what 1.0 opens", async () => {
    const dir = await oldFolder();
    // What sits beside a store in a real data folder and is no part of it.
    writeFileSync(join(dir, "lan-door.key.pem"), "a private key");
    writeFileSync(join(dir, "ai-provider.json"), "{}");
    // …and a store whose own files are readable by anybody: the copy's modes are its own, not the store's.
    const loosen = (at: string): void => {
      for (const e of readdirSync(at, { withFileTypes: true })) {
        if (e.isDirectory()) { chmodSync(join(at, e.name), 0o755); loosen(join(at, e.name)); } else chmodSync(join(at, e.name), 0o644);
      }
    };
    loosen(join(dir, PGDATA_SUBDIR));
    let atTheGate: { entries: string[]; record: Record<string, unknown>; tree: Record<string, string> } | null = null;
    const before = process.umask(0);
    let out: Opened;
    try {
      out = await start(dir, {
        before: async () => {
          atTheGate = {
            entries: readdirSync(join(dir, COPY)).sort(),
            record: JSON.parse(readFileSync(join(dir, COPY, "copy.json"), "utf8")) as Record<string, unknown>,
            tree: treeOf(join(dir, COPY, PGDATA_SUBDIR)),
          };
        },
      });
    } finally {
      process.umask(before);
    }
    expect(out.head).toBe(NEW_HEAD);
    // Whole before the move's first statement: the store inside it, its record, a generation of its own.
    expect(atTheGate!.entries).toEqual(["copy.json", PGDATA_SUBDIR, "store-generation.json"]);
    expect(atTheGate!.record).toMatchObject({ v: 1, head: OLD_HEAD, files: Object.keys(atTheGate!.tree).length });
    expect(existsSync(join(dir, `${COPY}.partial`))).toBe(false);
    // Not a byte of it changed while the store beside it moved, and no file is shared with the store.
    expect(treeOf(join(dir, COPY, PGDATA_SUBDIR))).toEqual(atTheGate!.tree);
    for (const rel of Object.keys(atTheGate!.tree)) {
      const st = statSync(join(dir, COPY, PGDATA_SUBDIR, rel));
      expect(st.nlink, rel).toBe(1);
      if (existsSync(join(dir, PGDATA_SUBDIR, rel))) expect(st.ino, rel).not.toBe(statSync(join(dir, PGDATA_SUBDIR, rel)).ino);
    }
    // Private whatever the process's mask: folders for their owner alone, files too.
    if (process.platform !== "win32") {
      const modes = new Set<string>();
      const walk = (at: string): void => {
        const st = statSync(at);
        modes.add(`${st.isDirectory() ? "d" : "f"}${(st.mode & 0o777).toString(8)}`);
        if (st.isDirectory()) for (const n of readdirSync(at)) walk(join(at, n));
      };
      walk(join(dir, COPY));
      expect([...modes].sort()).toEqual(["d700", "f600"]);
    }
    // What 1.0 reads in it: its own head, the letter, and the password opening under the install's key.
    expect(await copyAsOneOh(dir)).toEqual({ head: OLD_HEAD, subject: OLD_STORE.subject, words: OLD_STORE.words, password: OLD_STORE.password });
    expect(out.lines.filter((l) => l.event === "store_copied").map((l) => l.detail.count)).toEqual([Object.keys(atTheGate!.tree).length]);
    expect(JSON.stringify(out.lines)).not.toContain(dir);
  }, 240_000);

  it("replaces an older copy, whole or half, with the store as it stands now", async () => {
    const dir = await oldFolder();
    // An older whole copy, as a start ended between its copy and its move leaves one: the store as it stood then.
    cpSync(join(dir, PGDATA_SUBDIR), join(dir, COPY, PGDATA_SUBDIR), { recursive: true });
    // A session of 1.0 since then writes one more letter: the store no longer is what that copy holds.
    const session = new PGlite(join(dir, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
    await session.query(`update messages set subject = 'written after the first copy' where id = $1`, [OLD_STORE.letterId]);
    await session.close();
    // …and half a copy of some other attempt stands too.
    mkdirSync(join(dir, `${COPY}.partial`, PGDATA_SUBDIR), { recursive: true });
    writeFileSync(join(dir, `${COPY}.partial`, PGDATA_SUBDIR, "PG_VERSION"), "16\n");

    expect((await start(dir)).head).toBe(NEW_HEAD);
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR, COPY, "store-generation.json"]);
    expect((await copyAsOneOh(dir)).subject).toBe("written after the first copy");
  }, 240_000);

  it("takes its copy away again when the update is refused with nothing of it applied: the store stands alone, as 1.0 left it", async () => {
    const dir = await oldFolder();
    const taken: boolean[] = [];
    const sawCopy = (event: string): void => { if (event === "store_copied") taken.push(existsSync(join(dir, COPY, PGDATA_SUBDIR, "PG_VERSION"))); };
    // Refused at the gate by the caller's own answer, before the move's first statement.
    const asked = await refusal(start(dir, { onLine: sawCopy, before: async () => { throw new TransitionRefused([{ what: "the caller's own refusal", n: 1 }]); } }));
    expect(asked).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_refused" });
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR]);

    // Then the move itself rolled back whole: the store's sealed values do not open. What the removal does is told as it goes.
    const said: string[] = [];
    const undo = tellFolderFlushes((path) => (path === dir ? "the data folder" : null), (what) => said.push(what));
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === join(dir, `${COPY}.removing`)) said.push("the copy renamed out of its name");
    });
    const rmdir = fs.rmdirSync;
    vi.spyOn(fs, "rmdirSync").mockImplementation((path, options) => {
      rmdir(path, options);
      if (String(path) === join(dir, `${COPY}.removing`)) said.push("the copy gone");
    });
    let failed: StoreUpdateRefusedError;
    try {
      failed = await refusal(start(dir, { onLine: sawCopy, openSealed: { decrypt: async () => { throw new Error("no key"); } } }));
    } finally {
      vi.restoreAllMocks();
      undo();
    }
    expect(failed).toBeInstanceOf(StoreUpdateRefusedError);
    expect(failed).not.toBeInstanceOf(LocalStoreOpenError);
    expect(failed).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_failed" });
    expect(failed.cause).toBeInstanceOf(TransitionFailed);

    // Each start took a whole copy before it asked or moved anything…
    expect(taken).toEqual([true, true]);
    /* …and neither left it. The release that made this store never names such a folder: left here, every
       letter and the sealed passwords would outlive that release's sign-out and its removal of a mailbox. */
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR]);
    expect(await readAsOneOh(join(dir, PGDATA_SUBDIR))).toEqual({ head: OLD_HEAD, subject: OLD_STORE.subject, words: OLD_STORE.words, password: OLD_STORE.password });
    // The removal is on the disk like any other: the data folder flushed after the rename that commits it, and after the copy is gone.
    if (process.platform !== "win32") {
      const renamed = said.indexOf("the copy renamed out of its name");
      const gone = said.indexOf("the copy gone");
      expect([renamed > -1, gone > renamed]).toEqual([true, true]);
      expect(said.slice(renamed + 1, gone)).toContain("the data folder flushed");
      expect(said.slice(gone + 1)).toContain("the data folder flushed");
    }

    // The next start takes a copy of its own and moves the store.
    expect((await start(dir)).head).toBe(NEW_HEAD);
    expect(existsSync(join(dir, COPY, "copy.json"))).toBe(true);
  }, 240_000);

  it("says so on its log when the copy it took cannot be taken away again, and the next start removes it before it takes its own", async () => {
    const dir = await oldFolder();
    // The disk refuses the rename that commits the copy's removal, once (a file held open, say).
    const rename = fs.renameSync;
    let refusedOnce = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!refusedOnce && String(to) === join(dir, `${COPY}.removing`)) {
        refusedOnce = true;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      }
      rename(from, to);
    });
    const lines: string[] = [];
    let asked: StoreUpdateRefusedError;
    try {
      asked = await refusal(start(dir, {
        before: async () => { throw new TransitionRefused([{ what: "the caller's own refusal", n: 1 }]); },
        onLine: (event) => lines.push(event),
      }));
    } finally {
      vi.restoreAllMocks();
    }
    // The refusal is the update's, as before; the copy it could not remove stands, and the log says so.
    expect(refusedOnce).toBe(true);
    expect(asked).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_refused" });
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR, COPY]);
    expect(lines.filter((e) => e === "store_copy_failed")).toEqual(["store_copy_failed"]);
    expect(await readAsOneOh(join(dir, PGDATA_SUBDIR))).toMatchObject({ head: OLD_HEAD, subject: OLD_STORE.subject });

    // The next start removes that copy before it takes its own, and moves the store.
    writeFileSync(join(dir, COPY, "left-by-the-refused-start"), "");
    expect((await start(dir)).head).toBe(NEW_HEAD);
    expect(existsSync(join(dir, COPY, "left-by-the-refused-start"))).toBe(false);
    expect(existsSync(join(dir, COPY, "copy.json"))).toBe(true);
  }, 240_000);

  it("refuses the update one byte short of room with nothing changed, and proceeds at the figure", async () => {
    const dir = await oldFolder();
    /* The disk answers from the store itself, read when it is asked (the store is closed then):
       the figure the update needs, or one byte less. */
    const sizeOf = (at: string): number => readdirSync(at, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? sizeOf(join(at, e.name)) : statSync(join(at, e.name)).size), 0);
    const disk = { short: true, figure: 0 };
    vi.spyOn(fs, "statfsSync").mockImplementation((() => {
      disk.figure = Math.ceil(sizeOf(join(dir, PGDATA_SUBDIR)) * STORE_COPY_ROOM_FACTOR);
      return { bavail: disk.short ? disk.figure - 1 : disk.figure, bsize: 1 };
    }) as never);
    const lines: string[] = [];
    const short = await refusal(openLocalDb(dir, {
      log: (event, detail) => lines.push(JSON.stringify({ event, ...detail })), transition: { way: "copy", openSealed: ring() },
    }));
    expect(short).toMatchObject({ name: "StoreUpdateRefusedError", code: "store_copy_no_room" });
    expect(disk.figure).toBeGreaterThan(1024 * 1024);
    expect([short.neededBytes, short.freeBytes]).toEqual([disk.figure, disk.figure - 1]);
    expect(short.message).toMatch(/\d+ MB/);
    expect(short.message).not.toContain(dir);
    // Nothing was written: no copy, no half of one, no record of a run; and the store is 1.0's.
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR]);
    expect(await readAsOneOh(join(dir, PGDATA_SUBDIR))).toMatchObject({ head: OLD_HEAD, subject: OLD_STORE.subject });
    expect(lines.join("\n")).toContain('"kind":"no_room"');
    expect(lines.join("\n")).not.toContain(dir);

    disk.short = false;
    expect((await start(dir)).head).toBe(NEW_HEAD);
  }, 240_000);

  it("is not refused by a disk that cannot say how much room it has", async () => {
    const dir = await oldFolder();
    vi.spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("ENOSYS"); });
    expect((await start(dir)).head).toBe(NEW_HEAD);
    expect(existsSync(join(dir, COPY, "copy.json"))).toBe(true);
  }, 240_000);

  it("refuses by name when the copy fails half way, leaves no half copy, and the next start begins again", async () => {
    const dir = await oldFolder();
    const real = fs.copyFileSync;
    let copied = 0;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      copied += 1;
      if (copied > 20) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return real(from, to, mode);
    });
    const failed = await refusal(start(dir));
    expect(failed).toMatchObject({ name: "StoreUpdateRefusedError", code: "store_copy_failed" });
    expect(failed.message).not.toContain(dir);
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR]);
    expect((await readAsOneOh(join(dir, PGDATA_SUBDIR))).head).toBe(OLD_HEAD);
    vi.restoreAllMocks();
    expect((await start(dir)).head).toBe(NEW_HEAD);
  }, 240_000);

  it("does not run the move's first statement when the copy is gone by then", async () => {
    const dir = await oldFolder();
    // The copy is taken, and removed under the open before the move begins.
    const gone = await refusal(start(dir, {
      onLine: (event) => { if (event === "store_copied") rmSync(join(dir, COPY), { recursive: true, force: true }); },
    }));
    expect(gone).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_refused" });
    expect(gone.cause).toBeInstanceOf(TransitionRefused);
    expect((await readAsOneOh(join(dir, PGDATA_SUBDIR))).head).toBe(OLD_HEAD);
  }, 240_000);
});

/** A data folder whose store an earlier 1.0 release made: `entries` entries below 1.0.11's head, holding what `rows` writes. */
async function folderBelowOldHead(entries: number, rows: string): Promise<{ dir: string; head: number }> {
  const head = readJournalOf(MAIL_JOURNAL).filter((e) => e.when < OLD_HEAD).at(-entries)!.when;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-store-copy-road-"));
  dirs.push(dir);
  const client = new PGlite(join(dir, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
  const cut = journalThrough(MAIL_JOURNAL, head);
  try {
    await migrate(drizzle(client), { migrationsFolder: cut.spec.dir, migrationsSchema: cut.spec.migrationsSchema });
  } finally { cut.dispose(); }
  await client.exec(rows);
  await client.close();
  return { dir, head };
}

describe("a store an earlier 1.0 release left, whose own next step fails", () => {
  it("is refused as an update that did not happen, never as a store to set aside, and its copy stands", async () => {
    // One entry below 1.0.11's head, holding a row the check of that last entry refuses.
    const { dir, head: below } = await folderBelowOldHead(1, `
      alter table mailboxes drop constraint mailboxes_sync_blocked_reason_closed;
      insert into accounts (id, name) values ('${OLD_STORE.accountId}', 'desk');
      insert into mailboxes (id, account_id, provider, address, sync_blocked_reason)
        values ('${OLD_STORE.mailboxId}', '${OLD_STORE.accountId}', 'imap', '${OLD_STORE.address}', 'a reason no release wrote');`);

    const failed = await refusal(start(dir));
    expect(failed).toBeInstanceOf(StoreUpdateRefusedError);
    expect(failed).not.toBeInstanceOf(LocalStoreOpenError);
    expect(failed).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_failed" });
    // The database's own words are not handed on.
    expect(failed.cause).toBeUndefined();
    expect(failed.message).not.toMatch(/constraint|mailboxes/);
    // Closed, with no record of a run; the copy whole beside it, both as that release left the store.
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR, COPY]);
    expect(existsSync(join(dir, COPY, "copy.json"))).toBe(true);
    expect((await copyAsOneOh(dir)).head).toBe(below);
    expect((await readAsOneOh(join(dir, PGDATA_SUBDIR))).head).toBe(below);
  }, 480_000);
});

describe("a store whose update is refused, and the store is not, or cannot be shown to be, what its copy holds", () => {
  it("keeps its copy when the update stopped part-way: the store walked on to 1.0.11's head, and only the copy is what that release left", async () => {
    // Two entries below 1.0.11's head and nothing in its way: both steps of its road commit. Then the move is refused.
    const { dir, head: copiedAt } = await folderBelowOldHead(2, `
      insert into accounts (id, name) values ('${OLD_STORE.accountId}', 'desk');
      insert into mailboxes (id, account_id, provider, address) values ('${OLD_STORE.mailboxId}', '${OLD_STORE.accountId}', 'imap', '${OLD_STORE.address}');`);
    const refused = await refusal(start(dir, { before: async () => { throw new TransitionRefused([{ what: "the caller's own refusal", n: 1 }]); } }));
    expect(refused).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_refused" });
    // The store reads at 1.0.11's head now, which the release that made it never knew: the copy alone is the store as that release left it.
    expect((await readAsOneOh(join(dir, PGDATA_SUBDIR))).head).toBe(OLD_HEAD);
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR, COPY]);
    expect(readdirSync(join(dir, COPY)).sort()).toEqual(["copy.json", PGDATA_SUBDIR, "store-generation.json"]);
    expect((await copyAsOneOh(dir)).head).toBe(copiedAt);
  }, 480_000);

  it("keeps its copy when the refusal arrives after the move had committed: the store no longer reads at 1.0.11's head", async () => {
    const dir = await oldFolder();
    // The move commits; what is told next fails as the move's own failure is told.
    let moved = false;
    const failed = await refusal(openLocalDb(dir, {
      onPhase: (phase) => {
        if (phase === "updating_store") moved = true;
        else if (moved && phase === "migrating") throw new TransitionFailed({ stage: "lost" });
      },
      transition: { way: "copy", openSealed: ring() },
    }));
    expect(failed).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_failed" });
    // The store is 2.0's now, and the copy is the only store 1.0 opens: whole, with the letter and the password.
    const client = new PGlite(join(dir, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
    const head = Number((await client.query<{ head: string }>(`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`)).rows[0]!.head);
    await client.close();
    expect(head).toBeGreaterThan(OLD_HEAD);
    expect(readdirSync(join(dir, COPY)).sort()).toEqual(["copy.json", PGDATA_SUBDIR, "store-generation.json"]);
    expect(await copyAsOneOh(dir)).toEqual({ head: OLD_HEAD, subject: OLD_STORE.subject, words: OLD_STORE.words, password: OLD_STORE.password });
  }, 240_000);

  it("keeps its copy when the move's commit could not be put on the disk: the store's head cannot be read back", async () => {
    const dir = await oldFolder();
    // The disk refuses one sync, the first after the move's last check: its commit's.
    const f = fs as unknown as Record<string, unknown>;
    const real = f.fsyncSync;
    const failing = { armed: false, failed: 0 };
    f.fsyncSync = (...args: unknown[]) => {
      if (failing.armed && failing.failed === 0) {
        failing.failed += 1;
        throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", errno: -5, syscall: "fsync" });
      }
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    let failed: StoreUpdateRefusedError;
    try {
      failed = await refusal(start(dir, {
        openSealed: { decrypt: (ciphertext, keyVersion) => { failing.armed = true; return ring().decrypt(ciphertext, keyVersion); } },
      }));
    } finally {
      f.fsyncSync = real;
    }
    expect(failing.failed, "no sync was refused: the move never reached its commit").toBe(1);
    expect(failed).toMatchObject({ name: "StoreUpdateRefusedError", code: "transition_failed" });
    // Whether that commit is on the disk nobody can say. The copy is whole, and it is what 1.0 opens.
    expect(readdirSync(join(dir, COPY)).sort()).toEqual(["copy.json", PGDATA_SUBDIR, "store-generation.json"]);
    expect(await copyAsOneOh(dir)).toEqual({ head: OLD_HEAD, subject: OLD_STORE.subject, words: OLD_STORE.words, password: OLD_STORE.password });
  }, 240_000);
});

describe("an install beside another install", () => {
  it("copies, moves and removes inside its own data folder: a 1.0 store in the folder beside it is byte-equal after", async () => {
    // Two installs side by side, as a preview build beside a released one: each has its own data folder.
    const released = await oldFolder();
    const preview = await oldFolder();
    writeFileSync(join(released, "store-copies.owed"), "signed_out\n");
    mkdirSync(join(released, "set-aside-20260926T101323Z", PGDATA_SUBDIR), { recursive: true });
    writeFileSync(join(released, "set-aside-20260926T101323Z", PGDATA_SUBDIR, "PG_VERSION"), "16\n");
    const before = treeOf(released);
    expect((await start(preview)).head).toBe(NEW_HEAD);
    forgetStoreCopies(preview, "signed_out");
    expect(existsSync(join(preview, COPY))).toBe(false);
    expect(treeOf(released)).toEqual(before);
  }, 240_000);
});

describe("a store already on 2.0", () => {
  it("is opened with no copy taken, whatever way is named", async () => {
    const dir = await oldFolder();
    await start(dir);
    rmSync(join(dir, COPY), { recursive: true, force: true });
    const again = await start(dir);
    expect(again.head).toBe(NEW_HEAD);
    expect(again.lines.filter((l) => l.event === "store_copied")).toEqual([]);
    expect(existsSync(join(dir, COPY))).toBe(false);
  }, 240_000);
});
