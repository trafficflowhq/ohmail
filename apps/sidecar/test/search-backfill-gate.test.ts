import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAttentionClock, isPersonRequest, PERSON_QUIET_MS } from "../src/attention.js";
import { createHostPower, readPowerSupplies, HOST_POWER_READ_EVERY_MS, type PowerVerdict } from "../src/host-power.js";
import {
  startHtmlWordsBackfill, startSearchIndexBackfill, type BackfillRound, type SearchBackfill,
} from "../src/search-backfill.js";
import { COMPOSITION_STORE_PASSES, runsStorePass } from "../src/composition-passes.js";
import { maskSource } from "./_mask.js";

/**
 * THE DESKTOP'S SEARCH BACKFILL RUNS ONLY WHILE NOBODY IS USING THE APP, NO DRAIN IS TAKING MAIL IN,
 * AND THE MACHINE IS ON POWER — one round per tick, ended by the account's marker. Driven on a
 * clock the test owns; the gate's three inputs are the real modules (the attention clock, the power
 * reading over a fixture directory laid out as Linux lays it out), and the round is a counter.
 */

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function gate(opts: { ingesting?: () => boolean; power?: () => PowerVerdict; rounds?: BackfillRound[] } = {}) {
  let t = 1_000_000;
  const now = (): number => t;
  const attention = createAttentionClock(now);
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const script = [...(opts.rounds ?? [])];
  let calls = 0;
  const bf: SearchBackfill = startSearchIndexBackfill({
    round: async () => { calls += 1; return script.shift() ?? { ran: true, written: 500, marked: false }; },
    quietForMs: () => attention.quietForMs(),
    ingesting: opts.ingesting ?? (() => false),
    power: opts.power ?? (() => ({ onPower: true, state: "ac" })),
    log: (event, fields) => { lines.push({ event, fields }); },
    now,
    waitMs: 3_600_000,
  });
  cleanups.push(() => bf.stop());
  return { bf, attention, lines, advance: (ms: number) => { t += ms; }, calls: () => calls };
}

describe("the idle gate", () => {
  it("runs a round once nobody has asked for anything for a minute, and none after a request arrives", async () => {
    const g = gate();
    g.attention.note("GET", "/search");
    expect(await g.bf.tick()).toBe("person");
    g.advance(PERSON_QUIET_MS);
    expect(await g.bf.tick()).toBe("ran");
    expect(g.calls()).toBe(1);
    g.attention.note("GET", "/messages");
    expect(await g.bf.tick()).toBe("person");
    expect(g.calls()).toBe(1);
  });

  it("a fresh launch with no request yet is idle, and the window's own drain never makes it busy", async () => {
    const g = gate();
    expect(await g.bf.tick()).toBe("ran");
    for (let i = 0; i < 20; i++) {
      g.attention.note("GET", "/sync");
      g.attention.note("GET", "/messages/bodies");
      g.attention.note("GET", "/local/mailboxes/connections");
      g.attention.note("POST", "/local/window/sync-failed");
      g.advance(8_000);
      expect(await g.bf.tick()).toBe("ran");
    }
  });

  it("no round while a drain is taking mail in", async () => {
    let ingesting = true;
    const g = gate({ ingesting: () => ingesting });
    expect(await g.bf.tick()).toBe("draining");
    ingesting = false;
    expect(await g.bf.tick()).toBe("ran");
  });

  it("no round on battery; a machine with no battery, and one that cannot say, run", async () => {
    let verdict: PowerVerdict = { onPower: false, state: "battery" };
    const g = gate({ power: () => verdict });
    expect(await g.bf.tick()).toBe("battery");
    expect(g.calls()).toBe(0);
    verdict = { onPower: true, state: "no-battery" };
    expect(await g.bf.tick()).toBe("ran");
    verdict = { onPower: true, state: "unknown" };
    expect(await g.bf.tick()).toBe("ran");
  });

  it("the marker ends it with one line, and a marker already written reads nothing further", async () => {
    const g = gate({ rounds: [{ ran: true, written: 500, marked: false }, { ran: true, written: 120, marked: true }] });
    expect(await g.bf.tick()).toBe("ran");
    expect(await g.bf.tick()).toBe("ran");
    expect(g.bf.done()).toBe(true);
    expect(await g.bf.tick()).toBe("done");
    expect(g.calls()).toBe(2);
    const done = g.lines.filter((l) => l.event === "search_index_backfill_finished");
    expect(done).toHaveLength(1);
    expect(done[0]!.fields).toMatchObject({ written: 620, rounds: 2 });

    const already = gate({ rounds: [{ ran: false, written: 0, marked: false }] });
    expect(await already.bf.tick()).toBe("done");
    expect(already.lines).toHaveLength(0);
  });

  it("a failed round is logged, writes nothing further, and the next idle tick tries again", async () => {
    let fail = true;
    const g = gate();
    const bf = startSearchIndexBackfill({
      round: async () => { if (fail) throw new Error("boom"); return { ran: true, written: 1, marked: true }; },
      quietForMs: () => Number.POSITIVE_INFINITY, ingesting: () => false,
      power: () => ({ onPower: true, state: "ac" }),
      log: (event, fields) => { g.lines.push({ event, fields }); }, waitMs: 3_600_000,
    });
    cleanups.push(() => bf.stop());
    expect(await bf.tick()).toBe("failed");
    expect(g.lines.map((l) => l.event)).toEqual(["search_index_backfill_failed"]);
    fail = false;
    expect(await bf.tick()).toBe("ran");
    expect(bf.done()).toBe(true);
  });
});

describe("the store's upkeep", () => {
  it("runs after every round, and once the marker is written at most once per interval, when idle", async () => {
    let t = 0; let upkeep = 0; let quiet = Number.POSITIVE_INFINITY;
    const script: BackfillRound[] = [{ ran: true, written: 5, marked: false }, { ran: true, written: 2, marked: true }];
    const bf = startSearchIndexBackfill({
      round: async () => script.shift() ?? { ran: false, written: 0, marked: false },
      quietForMs: () => quiet, ingesting: () => false, power: () => ({ onPower: true, state: "ac" }),
      log: () => undefined, maintain: async () => { upkeep += 1; }, maintainEveryMs: 600_000,
      now: () => t, waitMs: 3_600_000,
    });
    cleanups.push(() => bf.stop());
    expect(await bf.tick()).toBe("ran");
    expect(await bf.tick()).toBe("ran");
    expect(upkeep, "after each round").toBe(2);
    expect(await bf.tick()).toBe("done");
    expect(upkeep, "the interval has not passed").toBe(2);
    t += 600_000;
    quiet = 0;
    expect(await bf.tick()).toBe("person");
    expect(upkeep, "never while somebody is using the app").toBe(2);
    quiet = Number.POSITIVE_INFINITY;
    expect(await bf.tick()).toBe("done");
    expect(upkeep).toBe(3);
  });
});

/* THE UPKEEP CADENCE ACROSS A SUSPEND AND A CLOCK STEPPED BACK: after the marker, upkeep once the
   ten minutes have passed on EITHER clock, and at once for a run stamped ahead of the wall clock. */
async function upkeepAfter(monoMs: number, wallMs: number): Promise<number> {
  let mono = 1_000; let wall = 1_000_000_000; let upkeep = 0;
  const script: BackfillRound[] = [{ ran: true, written: 2, marked: true }];
  const bf = startSearchIndexBackfill({
    round: async () => script.shift() ?? { ran: false, written: 0, marked: false },
    quietForMs: () => Number.POSITIVE_INFINITY, ingesting: () => false, power: () => ({ onPower: true, state: "ac" }),
    log: () => undefined, maintain: async () => { upkeep += 1; }, maintainEveryMs: 600_000,
    now: () => mono, wall: () => wall, waitMs: 3_600_000,
  });
  cleanups.push(() => bf.stop());
  expect(await bf.tick()).toBe("ran");
  expect(await bf.tick()).toBe("done");
  expect(upkeep, "the round's own upkeep, and no second").toBe(1);
  mono += monoMs; wall += wallMs;
  expect(await bf.tick()).toBe("done");
  return upkeep;
}

describe("the store's upkeep under a suspend and a clock step", () => {
  it("after eight hours asleep (wall +8 h, monotonic +1 min) the upkeep is due", async () => {
    expect(await upkeepAfter(60_000, 8 * 3_600_000), "the upkeep waited ten awake minutes after the sleep").toBe(2);
  });
  it("ten minutes on, with the wall clock stepped back an hour, the upkeep is due", async () => {
    expect(await upkeepAfter(600_001, 600_001 - 3_600_000)).toBe(2);
  });
  it("CONTROL: inside the ten minutes on both clocks there is no upkeep", async () => {
    expect(await upkeepAfter(60_000, 60_000)).toBe(1);
  });
});

describe("stopping", () => {
  it("waits for the round in flight, and no round runs after it", async () => {
    let release!: () => void;
    let calls = 0;
    const bf = startSearchIndexBackfill({
      round: () => { calls += 1; return new Promise((r) => { release = () => r({ ran: true, written: 1, marked: false }); }); },
      quietForMs: () => Number.POSITIVE_INFINITY, ingesting: () => false,
      power: () => ({ onPower: true, state: "ac" }), log: () => undefined, waitMs: 3_600_000,
    });
    const running = bf.tick();
    let stopped = false;
    const stopping = bf.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped, "stop returned while a round was still writing").toBe(false);
    release();
    await running;
    await stopping;
    expect(stopped).toBe(true);
    expect(await bf.tick()).toBe("done");
    expect(calls).toBe(1);
  });
});

describe("what counts as a person", () => {
  it("writes and the reads a person asks for; never the drain, the prefetch or a poll", () => {
    for (const [m, p] of [["GET", "/search"], ["GET", "/messages"], ["GET", "/messages/timeline"],
      ["GET", "/messages/abc/body"], ["GET", "/threads/t1"], ["POST", "/messages/abc/move"],
      ["PUT", "/drafts/d1"], ["POST", "/sync/pull"]] as const) {
      expect(isPersonRequest(m, p), `${m} ${p}`).toBe(true);
    }
    for (const [m, p] of [["GET", "/sync"], ["GET", "/sync/snapshot"], ["GET", "/messages/bodies"],
      ["GET", "/mirror/freshness"], ["GET", "/local/mailboxes/connections"], ["GET", "/mailboxes"],
      ["POST", "/local/window/sync-failed"], ["GET", "/health"]] as const) {
      expect(isPersonRequest(m, p), `${m} ${p}`).toBe(false);
    }
  });
});

function supplies(layout: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "ohmail-psu-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, files] of Object.entries(layout)) {
    mkdirSync(join(root, name));
    for (const [f, v] of Object.entries(files)) writeFileSync(join(root, name, f), `${v}\n`);
  }
  return root;
}

describe("the power reading", () => {
  it("reads a laptop, a desktop, a peripheral battery and an unreadable directory", () => {
    expect(readPowerSupplies(supplies({ AC: { type: "Mains", online: "1" }, BAT0: { type: "Battery", status: "Charging" } }))).toBe("ac");
    expect(readPowerSupplies(supplies({ AC: { type: "Mains", online: "0" }, BAT0: { type: "Battery", status: "Discharging" } }))).toBe("battery");
    expect(readPowerSupplies(supplies({ ADP1: { type: "Mains", online: "0" }, BAT1: { type: "Battery", status: "Unknown" } }))).toBe("battery");
    expect(readPowerSupplies(supplies({ BAT0: { type: "Battery", status: "Full" } }))).toBe("ac");
    expect(readPowerSupplies(supplies({}))).toBe("no-battery");
    expect(readPowerSupplies(supplies({ hidpp_battery_0: { type: "Battery", scope: "Device", status: "Discharging" } }))).toBe("no-battery");
    expect(readPowerSupplies(join(tmpdir(), "ohmail-no-such-psu-dir"))).toBe("unknown");
  });

  it("re-reads at most once a minute", () => {
    let t = 0;
    let reads = 0;
    let state: "ac" | "battery" = "ac";
    const power = createHostPower({ now: () => t, readState: () => { reads += 1; return state; } });
    expect(power().onPower).toBe(true);
    state = "battery";
    t += HOST_POWER_READ_EVERY_MS - 1;
    expect(power().onPower).toBe(true);
    t += 1;
    expect(power()).toEqual({ onPower: false, state: "battery" });
    expect(reads).toBe(2);
  });
});

/**
 * THE READER IS THE DESKTOP ENTRY'S, AND THE PASS RUNS WITHOUT ONE. The shared engine is also the
 * phone's, so it names the reader by type only and `main.ts` hands `createHostPower` in; a
 * composition that supplies none runs on no reading, which power never refuses. Watched red: the
 * default made a battery, the entry's `hostPower` removed, a value import put back in `engine.ts`.
 */
describe("the power reader is injected", () => {
  // @reads: apps/sidecar/src/engine.ts apps/sidecar/src/main.ts
  const code = (file: string): string =>
    maskSource(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).code;

  it("with no reader supplied, power never refuses a round", async () => {
    let calls = 0;
    const bf = startSearchIndexBackfill({
      round: async () => { calls += 1; return { ran: true, written: 1, marked: false }; },
      quietForMs: () => Number.POSITIVE_INFINITY, ingesting: () => false,
      log: () => undefined, waitMs: 3_600_000,
    });
    cleanups.push(() => bf.stop());
    expect(await bf.tick()).toBe("ran");
    expect(await bf.tick()).toBe("ran");
    expect(calls).toBe(2);
  });

  it("the shared engine names it by type only, and the desktop entry supplies it", () => {
    const engine = code("engine.ts");
    const named = engine.match(/["']\.\/host-power\.js["']/g) ?? [];
    const typeOnly = engine.match(/\bimport\s+type\s*\{[^}]*\}\s*from\s*["']\.\/host-power\.js["']/g) ?? [];
    expect(named.length, "every naming of host-power.js in engine.ts is a type import").toBe(typeOnly.length);
    expect(typeOnly.length, "the type import is read, so the census is reading the file").toBeGreaterThan(0);
    expect(engine).not.toMatch(/\bcreateHostPower\b/);
    expect(code("main.ts")).toMatch(/createSidecar\s*\(\s*\{[^}]*\bhostPower\s*:\s*createHostPower\s*\(/);
  });
});

describe("which composition schedules it", () => {
  it("the desktop's local door alone", () => {
    expect(runsStorePass("local", "search-index-backfill")).toBe(true);
    expect(runsStorePass("cloud", "search-index-backfill")).toBe(false);
    expect(runsStorePass("mobile", "search-index-backfill")).toBe(false);
    expect(Object.keys(COMPOSITION_STORE_PASSES).sort()).toEqual(["cloud", "local", "mobile"]);
  });

  it("the html-words backfill: the desktop and the phone, never a Cloud mirror", () => {
    expect(runsStorePass("local", "html-words-backfill")).toBe(true);
    expect(runsStorePass("mobile", "html-words-backfill")).toBe(true);
    expect(runsStorePass("cloud", "html-words-backfill")).toBe(false);
  });
});

describe("the html-words backfill's round", () => {
  it("waits for a person, a drain and the battery like the search backfill, and ends on its marker with its own line", async () => {
    let quiet = 0; let ingesting = false; let verdict: PowerVerdict = { onPower: true, state: "ac" };
    const lines: string[] = [];
    const script: BackfillRound[] = [{ ran: true, written: 3, marked: false }, { ran: true, written: 1, marked: true }];
    let calls = 0;
    const bf = startHtmlWordsBackfill({
      round: async () => { calls += 1; return script.shift() ?? { ran: false, written: 0, marked: false }; },
      quietForMs: () => quiet, ingesting: () => ingesting, power: () => verdict,
      log: (event) => { lines.push(event); }, waitMs: 3_600_000,
    });
    cleanups.push(() => bf.stop());
    expect(await bf.tick()).toBe("person");
    quiet = PERSON_QUIET_MS; ingesting = true;
    expect(await bf.tick()).toBe("draining");
    ingesting = false; verdict = { onPower: false, state: "battery" };
    expect(await bf.tick()).toBe("battery");
    expect(calls).toBe(0);
    verdict = { onPower: true, state: "ac" };
    expect(await bf.tick()).toBe("ran");
    expect(await bf.tick()).toBe("ran");
    expect(await bf.tick()).toBe("done");
    expect(calls).toBe(2);
    expect(lines).toEqual(["html_words_backfill_finished"]);
  });

  it("a failed round says so under its own name and is tried again", async () => {
    let fail = true;
    const lines: string[] = [];
    const bf = startHtmlWordsBackfill({
      round: async () => { if (fail) throw new Error("boom"); return { ran: true, written: 1, marked: true }; },
      quietForMs: () => Number.POSITIVE_INFINITY, ingesting: () => false,
      log: (event) => { lines.push(event); }, waitMs: 3_600_000,
    });
    cleanups.push(() => bf.stop());
    expect(await bf.tick()).toBe("failed");
    fail = false;
    expect(await bf.tick()).toBe("ran");
    expect(lines).toEqual(["html_words_backfill_failed", "html_words_backfill_finished"]);
  });
});
