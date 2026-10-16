import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareIsolatedDb } from "./_isolateddb.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A DRIVER DEFECT MUST NOT CRASH-LOOP THE WORKER THROUGH THE OUTAGE SURVIVED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An earlier review fix taught `cycle()` to ride out a database outage without quarantining the mailboxes it
 * interrupts, and closed naming the residual it could not fix: `postgres@3.4.9` throws a
 * `TypeError` from `setImmediate(nextWrite)` when a connection dies with a write still buffered.
 * There is no promise to attach it to, so it lands in `uncaughtException` — and the crash contract
 * answered that with `exit(1)`. The result was a worker that restart-loops during precisely the
 * outage it had just been taught to survive. `apps/worker/src/driver-write-race.ts` carries the
 * path through the driver, the measurement, and why an upgrade (there is no newer version) and a
 * vendor patch (an install-time mechanism across two deploy paths) were both declined.
 *
 * ── WHY THIS FILE SPAWNS PROCESSES ────────────────────────────────────────────────────────────
 *
 * Because the claim is "the process is still running", and no in-process test can make it. Vitest
 * installs its own `uncaughtException` listeners and would intercept the throw before the contract
 * saw it; a fake `CrashHost` (which `crash-handlers.test.ts` uses, correctly, for the reporting
 * half) can only observe that `exit` was CALLED. Survival has to be read off a real process's exit
 * code, so the contract is mounted on a real `process` in `_writeracechild.ts` and driven against
 * real Postgres through a TCP proxy that yanks the transport mid-transaction.
 *
 * ── THE TWO ARMS ARE ONE ASSERTION ────────────────────────────────────────────────────────────
 *
 * `guarded` is what `index.ts` installs. `bare` is the contract as it stood before this slice —
 * same child, same fixture, same database, `survivable` simply not passed. A guarded child that
 * survives proves nothing on its own (it might just never have met the race); a bare child that
 * dies with `errorClass: "TypeError"` is what makes the first one evidence. THE CONTROL IS
 * PERMANENT rather than a one-off mutation: deleting the exemption cannot make this file green,
 * because the two arms would then agree.
 *
 * ── WHY A PROBABILISTIC RACE STILL PRODUCES A DETERMINISTIC TEST ──────────────────────────────
 *
 * The race is roughly one in three outages, so each child LOOPS cut/restore rounds until it has
 * met the race and only then reports. Neither arm can pass by never meeting it: the guarded child
 * reports `survived` and the assertion requires it to be ≥ 1, so a run in which the race never
 * fired FAILS loudly rather than going green on an untested path.
 *
 * The transaction path is not a detail of the fixture either — it is the reachability condition.
 * Measured while this was written: tens of thousands of plain statements across 20 cut rounds produced ZERO
 * occurrences; thousands of transactions across 15 rounds produced four. `sql.begin` captures the
 * connection by reference and writes to it directly, which is why the worker (all of whose ingest
 * is transactional) meets this and a naive reproduction does not.
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

describe("the crash contract survives postgres.js's timer throw, and nothing else", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_writerace"); }, 120_000);

  /**
   * THE CONTROL, RUN FIRST — because if it does not die, the arm below proves nothing and the
   * honest report is "this environment did not reproduce the race", not a green tick.
   */
  it("WITHOUT the exemption the same outage kills the process — exit 1, on a TypeError", async () => {
    const run = await runChild("bare", 60, DB);

    // It died, and it died the way a production worker would: through the crash contract's own
    // reporting path, not by a stack trace on stderr.
    expect(run.code, `the bare child should have exited 1; it exited ${run.code}\n${run.raw.slice(-2000)}`).toBe(1);

    const crashes = eventsNamed(run, "uncaught_exception");
    expect(crashes.length, "nothing was reported before the exit").toBeGreaterThanOrEqual(1);
    // `errorClass` is the whole point: this exit is the DRIVER's TypeError and not some other
    // failure that happens to also exit 1.
    expect(crashes[0]!.errorClass).toBe("TypeError");
    // …and it never reached its summary, i.e. it was killed mid-run rather than finishing.
    expect(eventsNamed(run, "child_summary")).toHaveLength(0);
  }, 240_000);

  it("WITH it the process survives the outage, says so, and resumes committing when the DB returns", async () => {
    const run = await runChild("guarded", 60, DB);

    expect(run.code, `the guarded child should have finished cleanly\n${run.raw.slice(-2000)}`).toBe(0);

    // 1. It actually met the race. Without this the rest is satisfied by an outage that never
    //    triggered the defect, which is the way this file could quietly stop testing anything.
    const [summary] = eventsNamed(run, "child_summary");
    expect(summary, "the child never reported").toBeDefined();
    expect(summary!.survived, "the driver race never fired, so nothing here was exercised")
      .toBeGreaterThanOrEqual(1);

    // 2. It was reported LOUDLY and with the reason, not swallowed. An operator reading the drain
    //    during an outage has to be able to see this happened.
    const survivedLines = eventsNamed(run, "uncaught_exception_survived");
    expect(survivedLines.length).toBeGreaterThanOrEqual(1);
    expect(survivedLines[0]!.level).toBe("error");
    expect(survivedLines[0]!.errorClass).toBe("TypeError");
    expect(String(survivedLines[0]!.reason)).toContain("nextWrite");
    expect(survivedLines[0]!.survived).toBe(1);

    // 3. THE HARM IS GONE: no exit was reported at all, under any name.
    expect(eventsNamed(run, "uncaught_exception"), "the contract still crashed the process")
      .toHaveLength(0);

    // 4. And survival means WORKING, not merely alive. A process that stayed up but stopped
    //    talking to Postgres has not ridden out the outage; it has failed quietly, which is worse
    //    than crashing because nothing restarts it.
    //    The child polls for this with a 60 s budget, because the wait is postgres.js's own
    //    reconnect backoff (capped at twenty randomised seconds on a pool-shared counter) rather
    //    than anything this fix controls. `resumeMs` is on the line so a red here says whether the
    //    pool was wedged or merely waiting.
    const before = Number(summary!.committedAtRestore);
    const after = Number(summary!.committedAfterRestore);
    expect(after, `transactions did not resume after the transport returned (${before} → ${after} ` +
      `in ${String(summary!.resumeMs)}ms)`).toBeGreaterThan(before);
  }, 240_000);
});
