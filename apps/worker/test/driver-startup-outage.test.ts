import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * A DATABASE OUTAGE WHILE A CONNECTION IS BEING OPENED NEITHER STOPS THE WORKER NOR STORMS THE DATABASE.
 * postgres.js sends its own array-types query (or, with `target_session_attrs`, its state check) on every
 * connect, holding the waiting statement aside. Before patches/postgres@3.4.9.patch's startup hunks a close
 * in that window kept the dead socket's query: a refused redial rejected it with nobody listening (the
 * crash contract exited 1, twice in driver-write-race.pg.test.ts on CI), a "starting up" answer redialled
 * hundreds of times a second, and a FATAL's error failed the next statement on a healthy connection.
 * The same window redialled at once, with no backoff: a database or pooler that closed every attempt
 * there was dialled hundreds of times a second, and a FATAL sent to the driver's own query before the
 * close never reached the waiting statement. `_startupoutagechild.ts` mounts the contract with no
 * exemption against a fake Postgres on loopback, on both builds the package ships.
 */

const CHILD = fileURLToPath(new URL("_startupoutagechild.ts", import.meta.url));
const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));

interface Run { code: number | null; lines: Array<Record<string, unknown>>; raw: string }

async function runChild(scenario: string): Promise<Run> {
  const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx/esm", CHILD, scenario], {
    cwd: WORKER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  const code = await new Promise<number | null>((resolve) => { child.on("exit", (c) => resolve(c)); });
  const lines: Array<Record<string, unknown>> = [];
  for (const l of out.split("\n")) {
    if (!l.trim().startsWith("{")) continue;
    try { lines.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not ours */ }
  }
  return { code, lines, raw: out + err };
}

const results = (run: Run): Array<Record<string, unknown>> => run.lines.filter((l) => l.event === "scenario_result");
const arms = (run: Run): string[] => results(run).map((r) => `${String(r.build)}/${String(r.sock)}`);
const ALL_ARMS = ["esm/pg", "cjs/pg", "esm/plain", "cjs/plain"];

/** The process stayed up, nothing escaped to the contract, and every arm reported. */
function survived(run: Run, expected: string[]): void {
  expect(run.lines.filter((l) => l.event === "unhandled_rejection" || l.event === "uncaught_exception"),
    `a rejection escaped to the crash contract\n${run.raw.slice(-2000)}`).toHaveLength(0);
  expect(run.code, `the child should have finished cleanly\n${run.raw.slice(-2000)}`).toBe(0);
  expect(arms(run)).toEqual(expected);
}

// Each case is one child; its start-up under tsx is the cost (7.8 s at most under 10% of a CPU, 15 s on
// a busier host). The child's own waits are 0.4 s when it passes; a statement that never settles costs
// its guard, 5 s, or 10 s where a starved child once needed more than the 1 s it had. The four window
// cases run their arms side by side: one 1 s window each, and for the bare closes up to 2.4 s more
// while the driver's backoff runs out after the database is back (default backoff, as every pool here).
describe("a connection that dies while postgres.js opens it", { timeout: 60_000 }, () => {
  it("the harness catches an escape: an unhandled rejection exits the child 1", async () => {
    const run = await runChild("probe");
    expect(run.code).toBe(1);
    expect(run.lines.filter((l) => l.event === "unhandled_rejection").map((l) => l.errorCode)).toEqual(["EPROBE"]);
  });

  it("a refused redial after the types query is cut fails the waiting statement, and the process stays up", async () => {
    const run = await runChild("refused");
    survived(run, ["esm/pg", "cjs/pg", "esm/plain", "cjs/plain"]);
    for (const r of results(run)) expect(r.first, JSON.stringify(r)).toBe("ECONNREFUSED");
  });

  it("a database that answers 'starting up' is not redialled in a loop, and the next statement answers once it is back", async () => {
    const run = await runChild("starting-up");
    survived(run, ["esm/pg", "cjs/pg"]);
    for (const r of results(run)) {
      expect(r.first, JSON.stringify(r)).toBe("57P03");
      expect(Number(r.dials), JSON.stringify(r)).toBeLessThanOrEqual(3);
      expect(r.second, JSON.stringify(r)).toBe("1");
    }
  });

  it("a FATAL and a close fail only their own statement, not the next one on a healthy connection", async () => {
    const run = await runChild("fatal-close");
    survived(run, ["esm/pg", "cjs/pg"]);
    for (const r of results(run)) {
      expect(r.first, JSON.stringify(r)).not.toBe("1");
      expect(r.second, JSON.stringify(r)).toBe("1");
    }
  });

  it("with target_session_attrs, a refused redial after the state check is cut keeps the process up", async () => {
    const run = await runChild("state-probe");
    survived(run, ["esm/pg", "cjs/pg"]);
    for (const r of results(run)) expect(r.first, JSON.stringify(r)).toBe("ECONNREFUSED");
  });

  it("with target_session_attrs, after the state check is cut a healthy database answers the waiting statement on the second dial", async () => {
    const run = await runChild("state-control");
    survived(run, ["esm/pg", "cjs/pg"]);
    for (const r of results(run)) {
      expect(r.first, JSON.stringify(r)).toBe("1");
      expect(r.dials, JSON.stringify(r)).toBe(2);
    }
  });

  it("control: after the cut a healthy database answers the waiting statement on the second dial", async () => {
    const run = await runChild("control");
    survived(run, ["esm/pg", "cjs/pg"]);
    for (const r of results(run)) {
      expect(r.first, JSON.stringify(r)).toBe("1");
      expect(r.dials, JSON.stringify(r)).toBe(2);
    }
  });

  it("a FATAL and a close on the driver's types query fail the waiting statement with the server's code, with no redial loop", async () => {
    const run = await runChild("fatal-types");
    survived(run, ALL_ARMS);
    for (const r of results(run)) {
      expect(r.first, JSON.stringify(r)).toBe("57P01");
      expect(Number(r.firstDials), JSON.stringify(r)).toBeLessThanOrEqual(2);
      expect(r.second, JSON.stringify(r)).toBe("08P01");
      expect(Number(r.dials), JSON.stringify(r)).toBeLessThanOrEqual(4);
      expect(r.third, JSON.stringify(r)).toBe("1");
    }
  });

  it("a pooler that answers every connection's first statement with a FATAL and a close is not redialled in a loop", async () => {
    const run = await runChild("pooler-down");
    survived(run, ALL_ARMS);
    for (const r of results(run)) {
      expect(r.healthy, JSON.stringify(r)).toBe("1");
      // The open connection's statement: the driver's own close error, or the server's code.
      expect(["CONNECTION_CLOSED", "08P01"], JSON.stringify(r)).toContain(r.first);
      expect(r.second, JSON.stringify(r)).toBe("08P01");
      expect(Number(r.dials), JSON.stringify(r)).toBeLessThanOrEqual(10);
      expect(r.third, JSON.stringify(r)).toBe("1");
    }
  });

  it("a database that closes every connection on its startup packet is redialled with backoff, and the waiting statement answers once it is back", async () => {
    const run = await runChild("close-startup");
    survived(run, ALL_ARMS);
    for (const r of results(run)) {
      expect(Number(r.dials), JSON.stringify(r)).toBeLessThanOrEqual(10);
      expect(Number(r.redials), JSON.stringify(r)).toBeGreaterThanOrEqual(1);
      expect(r.during, JSON.stringify(r)).toBe("pending");
      expect(r.first, JSON.stringify(r)).toBe("1");
    }
  });

  it("a database that closes every connection on the driver's types query is redialled with backoff, and the waiting statement answers once it is back", async () => {
    const run = await runChild("close-types");
    survived(run, ALL_ARMS);
    for (const r of results(run)) {
      expect(Number(r.dials), JSON.stringify(r)).toBeLessThanOrEqual(10);
      expect(Number(r.redials), JSON.stringify(r)).toBeGreaterThanOrEqual(1);
      expect(r.during, JSON.stringify(r)).toBe("pending");
      expect(r.first, JSON.stringify(r)).toBe("1");
    }
  });
});
