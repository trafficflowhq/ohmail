import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { MAIL_JOURNAL, readJournalOf } from "@trafficflow/db/journal";
import {
  LOCAL_STORE_EXTENSIONS, LocalStoreOpenError, PGDATA_SUBDIR, SET_ASIDE_PREFIX, STORE_UNFINISHED_FILE, openLocalDb,
  type OpenLocalDb,
} from "../../src/db.js";
import { freshDataDir } from "../_datadir.js";

vi.setConfig({ testTimeout: 180_000 });

/**
 * A FIRST START KILLED AT EACH STEP OF MAKING THE STORE, AND THE START AFTER IT. A child runs
 * `openLocalDb` on an empty directory and is SIGKILLed at a named step; the next start is
 * this process opening the same directory, and it must serve. A kill inside PGlite's `initdb`
 * left a catalog without `information_schema` that every later start "resumed" and failed on
 * with 42P01, for good. The last cases are the probe for stores made before the marker: one
 * holding nothing is rebuilt, one holding anything is never touched.
 */

const SIDECAR_DIR = fileURLToPath(new URL("../..", import.meta.url));
/* The child runs the source through tsx, in its own process, so a stale `dist` cannot measure old code. */
const SIDECAR_DB_ENTRY = fileURLToPath(new URL("../../src/db.ts", import.meta.url));

/* The child. No `finally`, no close: whatever it has written when the signal lands is the state. */
const CHILD = `
import { openLocalDb } from "__DB__";
const mode = "__MODE__";
const kill = () => process.kill(process.pid, "SIGKILL");
await openLocalDb("__DIR__", {
  onPhase: (p) => {
    process.stdout.write("phase " + p + "\\n");
    if (mode === "at-creating" && p === "creating_store") kill();
    if (mode === "at-migrating" && p === "migrating") kill();
  },
});
process.stdout.write("opened\\n");
if (mode === "after-open") kill();
setInterval(() => {}, 1000);
`;

type Mode = "at-creating" | "in-copy" | "written" | "at-migrating" | "in-migrating" | "after-open";

const dirs: string[] = [];
const open: OpenLocalDb[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close().catch(() => { /* already closed */ });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag: string): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), tag));
  dirs.push(d);
  return d;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the child on an empty directory, kill it where `mode` says, hand back what it printed. */
async function killFirstStart(mode: Mode): Promise<{ dir: string; out: string; err: string }> {
  const dir = tempDir(`ohmail-early-kill-${mode}-`);
  const file = join(tempDir("ohmail-early-kill-child-"), "child.mjs");
  writeFileSync(file, CHILD
    .replace("__DB__", pathToFileURL(SIDECAR_DB_ENTRY).href)
    .replace("__DIR__", dir)
    .replace("__MODE__", mode));
  const proc = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", file], {
    cwd: SIDECAR_DIR, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => { out += c; });
  proc.stderr.on("data", (c: string) => { err += c; });
  const exited = new Promise((r) => proc.on("exit", r));
  const until = async (done: () => boolean): Promise<void> => {
    const end = Date.now() + 90_000;
    while (!done() && Date.now() < end && proc.exitCode === null && proc.signalCode === null) await wait(10);
  };
  /* A new store is made in memory and its files written into `pgdata`, PG_VERSION last
     (`fresh-store.ts`): the directory appearing is the copy starting, the version its end. */
  if (mode === "in-copy") await until(() => existsSync(join(dir, PGDATA_SUBDIR)));
  if (mode === "written") await until(() => existsSync(join(dir, PGDATA_SUBDIR, "PG_VERSION")));
  if (mode === "in-migrating") { await until(() => out.includes("phase migrating")); await wait(300); }
  if (mode === "after-open") await until(() => out.includes("opened"));
  // The two that kill themselves at a phase are waited for, never killed from here at spawn.
  if (mode === "at-creating" || mode === "at-migrating") await until(() => false);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  await until(() => proc.signalCode !== null || proc.exitCode !== null);
  await exited;
  expect(proc.signalCode, `the child ended on its own rather than by the kill: ${err}`).toBe("SIGKILL");
  return { dir, out, err };
}

/** The next start: opens, migrates through the whole journal, and takes a write. */
async function nextStartServes(dir: string): Promise<{ h: OpenLocalDb; setAsideKinds: unknown[] }> {
  const setAsideKinds: unknown[] = [];
  const h = await openLocalDb(dir, {
    log: (event, detail) => { if (event === "store_set_aside") setAsideKinds.push(detail?.kind); },
  });
  open.push(h);
  const ledger = await h.db.execute(
    `select count(*)::int as n from "${MAIL_JOURNAL.migrationsSchema}"."__drizzle_migrations"`,
  ) as unknown as { rows: Array<{ n: number }> };
  expect(ledger.rows[0]!.n).toBe(readJournalOf(MAIL_JOURNAL).length);
  await h.db.execute("insert into accounts (id, name) values ('00000000-0000-4000-8000-00000000e41c', 'next start')");
  const read = await h.db.execute("select count(*)::int as n from accounts") as unknown as { rows: Array<{ n: number }> };
  expect(read.rows[0]!.n).toBe(1);
  expect(existsSync(join(dir, STORE_UNFINISHED_FILE)), "a served store still carries the marker").toBe(false);
  return { h, setAsideKinds };
}

const setAside = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(SET_ASIDE_PREFIX));

describe("a first start killed while the store is being made", () => {
  it.each([
    ["in-copy", "while the new store's files were being written"],
    ["written", "right after the last of them, PG_VERSION, was written"],
  ] as const)("killed %s (%s): the next start sets the half store aside and serves", async (mode, _where) => {
    const { dir, out } = await killFirstStart(mode);
    expect(out, "the kill landed after the store was made, not while it was").not.toContain("phase migrating");
    const { setAsideKinds } = await nextStartServes(dir);
    expect(setAsideKinds).toEqual(["unfinished"]);
    expect(setAside(dir), "the interrupted store is kept, not deleted").toHaveLength(1);
    if (mode === "written") expect(existsSync(join(dir, setAside(dir)[0]!, PGDATA_SUBDIR, "PG_VERSION"))).toBe(true);
  });

  /* `null`: where inside the pass the kill lands is a clock's answer, so only "it serves" is. */
  it.each([
    ["at-creating", "before initdb began", 0],
    ["at-migrating", "after initdb, before the first migration pass", 1],
    ["in-migrating", "inside the first migration pass", null],
    ["after-open", "after the store opened", 0],
  ] as const)("killed %s (%s): the next start serves", async (mode, _where, setAsideCount) => {
    const { dir, out } = await killFirstStart(mode);
    const reached = mode === "at-creating" ? "phase creating_store" : "phase migrating";
    if (mode !== "after-open") expect(out, "the child never reached the step it is killed at").toContain(reached);
    if (mode === "in-migrating") {
      expect(out, "the kill landed after the open finished, not inside the pass").not.toContain("opened");
    }
    await nextStartServes(dir);
    if (setAsideCount !== null) expect(setAside(dir)).toHaveLength(setAsideCount);
  });
});

/**
 * A store made before the marker existed, in the one shape the kill left: a catalog with no
 * `information_schema` and nothing of ours in it. Built from the test template by taking the
 * mail schema away, so the only difference from the tester's copy is how far `initdb` got.
 */
async function preMarkerStore(keep: { tables: boolean; ledger: boolean }): Promise<string> {
  const dir = await freshDataDir("ohmail-early-kill-legacy-");
  dirs.push(dir);
  const pg = new PGlite({ dataDir: join(dir, PGDATA_SUBDIR), extensions: LOCAL_STORE_EXTENSIONS });
  await pg.waitReady;
  if (!keep.tables) await pg.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  if (!keep.ledger) await pg.exec(`DROP SCHEMA "${MAIL_JOURNAL.migrationsSchema}" CASCADE;`);
  await pg.exec("DROP SCHEMA information_schema CASCADE;");
  await pg.close();
  return dir;
}

describe("a store made before the marker existed", () => {
  it("killed before initdb wrote PG_VERSION (files, no version, no marker): set aside and made", async () => {
    // initdb refuses a directory holding anything: PGlite exits(1) on this at every start.
    const dir = tempDir("ohmail-early-kill-noversion-");
    for (const sub of ["global", "pg_wal", "base"]) mkdirSync(join(dir, PGDATA_SUBDIR, sub), { recursive: true });
    writeFileSync(join(dir, PGDATA_SUBDIR, "postgresql.conf"), "");
    const { setAsideKinds } = await nextStartServes(dir);
    expect(setAsideKinds).toEqual(["unfinished"]);
    expect(setAside(dir)).toHaveLength(1);
  });

  it("holding nothing and missing information_schema: set aside and rebuilt", async () => {
    const dir = await preMarkerStore({ tables: false, ledger: false });
    const { setAsideKinds } = await nextStartServes(dir);
    expect(setAsideKinds).toEqual(["holds-nothing"]);
    expect(setAside(dir)).toHaveLength(1);
  });

  /* Each keeps ONE of the two facts that say a store holds something, so each fact is watched alone. */
  it.each([
    ["its tables, with no ledger", { tables: true, ledger: false }],
    ["its ledger rows, with no tables", { tables: false, ledger: true }],
  ] as const)("holding %s: never set aside, and the start fails by name", async (_what, keep) => {
    const dir = await preMarkerStore(keep);
    const refused = await openLocalDb(dir).then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(LocalStoreOpenError);
    expect(refused).toMatchObject({ code: "42P01" });
    expect(setAside(dir)).toHaveLength(0);
    expect(existsSync(join(dir, PGDATA_SUBDIR, "PG_VERSION"))).toBe(true);
  });
});
