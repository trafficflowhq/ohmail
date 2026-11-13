import { afterEach, describe, expect, it } from "vitest";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { ClockRow } from "../src/clocks.js";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { PLAIN_ENV, PROCESS_DOOR, env, processInput, recordingLogger } from "./_envs.js";

/**
 * A PASS RUNS ONCE WHEN TWO COPIES ARE ALIVE. Two programs built from one configuration against one
 * real Postgres, as a deploy leaves them for a while: both start their clocks, one leads, and a row
 * is driven by that copy alone. The row counted here names a route neither table serves, so every
 * run of it is one refusal line in the log of the copy that ran it, and nothing else is touched.
 */
const PG_UP = await realPgAvailable();

const COUNTED: ClockRow = {
  target: "counted", route: "/internal/counted-by-this-test", everyMs: 40, firstDelayMs: 5, jitterMs: 0,
  needs: "both", hold: null,
};
/** A key of this file's own: the lock under test is the clocks', on a key no other file takes. */
const KEY = 4207278950n;
const RETRY_MS = 150;

interface Copy { program: Program; runs: () => number }
const open: Program[] = [];
const handles: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const p of open.splice(0)) await p.close();
});

function copy(): Copy {
  const { logger, lines } = recordingLogger();
  const settings = loadSettings(env(PLAIN_ENV, {
    DATABASE_URL: PG_TEST_URL, OHMAIL_ORIGIN: "http://localhost", TF_API_CLOCKS: "1", TF_ALERT_SECRET: "s".repeat(32),
  }), PROCESS_DOOR);
  const program = buildProgram(settings, processInput(logger));
  open.push(program);
  return { program, runs: () => lines.filter((l) => l.event === "api_clock_pass_refused" && l.fields.route === COUNTED.route).length };
}

const start = (c: Copy) => {
  const handle = c.program.startClocks({ rows: [COUNTED], retryMs: RETRY_MS, lockKey: KEY })!;
  handles.push(handle);
  return handle;
};
const until = async (what: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!what() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

describe.skipIf(!PG_UP)("two copies of the program, one Postgres", () => {
  it("one copy drives the row; the other runs it not once", async () => {
    const a = copy();
    const b = copy();
    const first = start(a);
    const second = start(b);
    await until(() => a.runs() + b.runs() >= 8, 5_000);
    expect(a.runs() + b.runs()).toBeGreaterThanOrEqual(8);
    expect([first.leading(), second.leading()].filter(Boolean), "two copies lead at once").toHaveLength(1);
    const [leader, standby] = first.leading() ? [a, b] : [b, a];
    expect(leader.runs()).toBeGreaterThanOrEqual(8);
    expect(standby.runs(), "the row ran on both copies: a pass ran twice").toBe(0);
  }, 20_000);

  it("the leader stops; the standby drives within one retry, and the stopped copy drives no more", async () => {
    const a = copy();
    const b = copy();
    const first = start(a);
    await until(() => first.leading(), 5_000);
    const second = start(b);
    await until(() => a.runs() >= 3, 5_000);
    expect(second.leading()).toBe(false);
    await first.stop();
    const ranBefore = a.runs();
    await until(() => second.leading() && b.runs() >= 3, RETRY_MS * 4 + 2_000);
    expect(second.leading()).toBe(true);
    expect(b.runs()).toBeGreaterThanOrEqual(3);
    expect(a.runs()).toBe(ranBefore);
  }, 20_000);
});
