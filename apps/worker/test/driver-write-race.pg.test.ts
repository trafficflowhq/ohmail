import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareIsolatedDb } from "./_isolateddb.js";

/**
 * A DATABASE OUTAGE MID-TRANSACTION NEITHER CRASHES THE WORKER NOR STOPS IT COMMITTING. Unpatched
 * postgres@3.4.9 sends sql.begin's rollback down a connection that just closed: it throws from
 * setImmediate(nextWrite) (the crash contract exited 1), or the statement never leaves and hangs the next
 * transaction on that connection (packages/db/test/phantom-rollback.pg.test.ts). patches/postgres@3.4.9.patch
 * refuses it; driver-write-race.ts stays as the belt for an unpatched install. The child mounts the contract
 * on a real process WITHOUT the exemption, so one driver throw exits it 1, and cuts the transport under six
 * transactional tasks on the worker's socket each round. Unpatched, it threw in the first round of all 160 local runs.
 */

const CHILD = fileURLToPath(new URL("_writeracechild.ts", import.meta.url));
const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));

interface ChildRun {
  code: number | null;
  lines: Array<Record<string, unknown>>;
  raw: string;
}

/** Run the child in one mode and collect its NDJSON. */
async function runChild(mode: "guarded" | "bare", rounds: number, dbUrl: string): Promise<ChildRun> {
  const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx/esm", CHILD, mode], {
    cwd: WORKER_DIR,
    env: { ...process.env, TF_CHILD_DB_URL: dbUrl, TF_CHILD_ROUNDS: String(rounds) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", (c) => resolve(c));
  });
  const lines: Array<Record<string, unknown>> = [];
  for (const l of out.split("\n")) {
    if (!l.trim().startsWith("{")) continue;
    try { lines.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not ours */ }
  }
  return { code, lines, raw: out + err };
}

const eventsNamed = (run: ChildRun, event: string): Array<Record<string, unknown>> =>
  run.lines.filter((l) => l.event === event);

let DB = "";

describe("a database outage mid-transaction, with no exemption in the crash contract", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_writerace"); }, 120_000);

  it("the driver never throws, the process stays up, resumes committing, and every transaction settles", async () => {
    const run = await runChild("bare", 20, DB);

    // 1. Nothing reached the contract: no throw to survive, none to die of.
    expect(eventsNamed(run, "uncaught_exception"), `the driver threw\n${run.raw.slice(-2000)}`).toHaveLength(0);
    expect(eventsNamed(run, "uncaught_exception_survived")).toHaveLength(0);
    expect(run.code, `the child should have finished cleanly\n${run.raw.slice(-2000)}`).toBe(0);

    const [summary] = eventsNamed(run, "child_summary");
    expect(summary, "the child never reported").toBeDefined();
    expect(summary!.rounds).toBe(20);

    // 2. Survival means WORKING. The budget is postgres.js's reconnect backoff (capped at twenty
    //    randomised seconds on a pool-shared counter), so a red here reads as a wedged pool.
    const before = Number(summary!.committedAtRestore);
    const after = Number(summary!.committedAfterRestore);
    expect(after, `transactions did not resume after the transport returned (${before} → ${after} ` +
      `in ${String(summary!.resumeMs)}ms)`).toBeGreaterThan(before);

    // 3. And no transaction waits for ever on a connection the outage left behind.
    expect(summary!.settled, "a transaction never settled after the outage (the phantom-rollback hang)").toBe(true);
  }, 240_000);
});
