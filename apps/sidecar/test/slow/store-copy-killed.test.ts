import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PGDATA_SUBDIR, openLocalDb } from "../../src/db.js";
import { NEW_HEAD, OLD_HEAD, folderAtOldHead, readAsOneOh, ring } from "../_old-head-store.js";

vi.setConfig({ testTimeout: 240_000 });

/**
 * A STORE'S UPDATE, KILLED FOR REAL, AND THE START AFTER IT. A child process opens a 1.0 data
 * folder the way the desktop's engine does and is ended with SIGKILL: while the copy is being
 * written, and inside the transaction that moves the store. Whatever it had written when the
 * signal landed is the state. The next start is this process opening the same folder: the store
 * was still 1.0's, and it ends moved with one whole copy and no half one. The emulated cut
 * (`store-copy-cut-emulated.test.ts`) walks every step; this is the one a real kill makes.
 */

const COPY = "store-before-2.0";
const SIDECAR_DIR = fileURLToPath(new URL("../..", import.meta.url));
const DB_ENTRY = fileURLToPath(new URL("../../src/db.ts", import.meta.url));

/* The child. No `finally`, no close. It ends itself inside the move; the parent ends it inside the copy. */
const CHILD = `
import { openLocalDb } from "__DB__";
const mode = "__MODE__";
await openLocalDb("__DIR__", {
  onPhase: (p) => { process.stdout.write("phase " + p + "\\n"); },
  transition: {
    way: "copy",
    openSealed: {
      // Every sealed value opens: what is under test is the kill, not the key.
      decrypt: async () => {
        process.stdout.write("inside the move\\n");
        if (mode === "in-the-move") process.kill(process.pid, "SIGKILL");
        return "opened";
      },
    },
  },
});
process.stdout.write("opened\\n");
setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function killed(mode: "in-the-copy" | "in-the-move"): Promise<{ dir: string; out: string }> {
  const dir = await folderAtOldHead(`ohmail-copy-killed-${mode}-`);
  dirs.push(dir);
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-copy-killed-child-"));
  dirs.push(scratch);
  const file = join(scratch, "child.mjs");
  writeFileSync(file, CHILD.replace("__DB__", pathToFileURL(DB_ENTRY).href).replace("__DIR__", dir).replace("__MODE__", mode));
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
    const end = Date.now() + 120_000;
    while (!done() && Date.now() < end && proc.exitCode === null && proc.signalCode === null) await wait(2);
  };
  if (mode === "in-the-copy") {
    // The copy's folder has appeared and holds some of the store: the signal lands while it is written.
    const partial = join(dir, `${COPY}.partial`, PGDATA_SUBDIR);
    await until(() => existsSync(partial) && readdirSync(partial).length > 3);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
  await until(() => false);
  await exited;
  expect(proc.signalCode, `the child ended on its own rather than by the kill: ${err}`).toBe("SIGKILL");
  expect(out, "the child finished its start before the kill").not.toContain("opened");
  return { dir, out };
}

/** The start after the kill: moved, one whole copy that 1.0 opens, no half one. */
async function nextStart(dir: string): Promise<{ head: number; copies: string[] }> {
  const opened = await openLocalDb(dir, { transition: { way: "copy", openSealed: ring() } });
  try {
    const r = await opened.db.execute(sql`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`);
    return {
      head: Number((r as unknown as { rows: Array<{ head: string }> }).rows[0]!.head),
      copies: readdirSync(dir).filter((n) => n.startsWith(COPY)).sort(),
    };
  } finally {
    await opened.close();
  }
}

describe("a store's update killed by a real SIGKILL", () => {
  it("while the copy is written: nothing stands under a copy's name, the store is 1.0's, the next start finishes", async () => {
    const { dir, out } = await killed("in-the-copy");
    expect(out).toContain("phase copying_store");
    expect(out).not.toContain("inside the move");
    expect(existsSync(join(dir, COPY)), "a copy stands whose writing was killed").toBe(false);
    expect(await nextStart(dir)).toEqual({ head: NEW_HEAD, copies: [COPY] });
  });

  it("inside the move: a whole copy stands, the store is 1.0's, the next start finishes", async () => {
    const { dir, out } = await killed("in-the-move");
    expect(out).toContain("phase updating_store");
    expect(existsSync(join(dir, COPY, "copy.json"))).toBe(true);
    expect(existsSync(join(dir, `${COPY}.partial`))).toBe(false);
    // The move had begun and committed nothing: what stands is the store 1.0 left, behind a log it replays.
    const aside = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-copy-killed-read-"));
    dirs.push(aside);
    cpSync(join(dir, PGDATA_SUBDIR), join(aside, PGDATA_SUBDIR), { recursive: true });
    expect((await readAsOneOh(join(aside, PGDATA_SUBDIR))).head).toBe(OLD_HEAD);
    expect(await nextStart(dir)).toEqual({ head: NEW_HEAD, copies: [COPY] });
  });
});
