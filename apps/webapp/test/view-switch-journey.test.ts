import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * THE VIEW-SWITCH JOURNEY, IN A REAL ENGINE — keys 1, 2 and 3, and the rail's clicks, over a fixture
 * mailbox, through the page `scripts/perf/view-switch.mjs` measures (the real AppShell over a
 * FixturesAdapter, heavy newsletters in the streams). What it asserts is what the presses DID —
 * the pile's rows painted, the stream behind them, no sanitize pass and no request on a revisit,
 * no more framed documents at entry than one screen of cards — and never how long they took: a
 * wall-clock budget here would redden CI on a busy runner. The numbers are the harness's, read on
 * one host, back to back (`test/contracts/perf-budgets.json`, `latency.view-switch-*`).
 */
const ROOT = resolve(__dirname, "../../..");
type Harness = {
  build: (out: string, tree?: string) => Promise<string>;
  runArm: (o: { dist: string; engine?: string; reps?: number; q?: string; warm?: number; viewport?: string; scenario?: string }) => Promise<{
    errors: string[];
    presses: Array<{ how: string; view: string; phase: string; paintMs: number; rowsMs: number; streamMs: number | null;
      iframes: number; cards: number; sanitize: number; requests: number }>;
  }>;
};

let harness: Harness;
let dist = "";

beforeAll(async () => {
  harness = (await import(join(ROOT, "scripts/perf/view-switch.mjs"))) as Harness;
  dist = mkdtempSync(join(tmpdir(), "ohmail-view-switch-"));
  await harness.build(dist);
}, 180_000);

afterAll(() => {
  if (dist) rmSync(dist, { recursive: true, force: true });
});

describe("switching between the piles, in Chromium", () => {
  it("every press paints its pile's rows; a revisit sanitizes nothing and asks for nothing", async () => {
    const run = await harness.runArm({
      dist, engine: "chromium", reps: 2, warm: 60, viewport: "1440x900",
      q: "n=300&nr=200&nc=120&demo=0&heavy=1",
    });
    expect(run.errors, "the page logged an error").toEqual([]);
    const presses = run.presses;
    expect(presses.length, "control: the journey pressed").toBeGreaterThanOrEqual(12);
    const oneScreen = Math.ceil(900 / 220) + 2;
    for (const p of presses) {
      const what = `${p.how} ${p.view} (${p.phase})`;
      expect(Number.isFinite(p.paintMs), `${what}: the pile's rows never painted`).toBe(true);
      expect(p.requests, `${what}: a switch asked for something`).toBe(0);
      if (p.view === "1") continue;
      expect(p.streamMs, `${what}: the stream never followed the rows`).not.toBeNull();
      expect(p.iframes, `${what}: more framed documents at entry than one screen of cards`).toBeLessThanOrEqual(oneScreen);
      if (p.phase !== "first") expect(p.sanitize, `${what}: a revisit sanitized a body again`).toBe(0);
    }
    expect(presses.some((p) => p.how === "click"), "control: the rail was clicked").toBe(true);
    expect(presses.some((p) => p.phase === "rapid"), "control: the fast run ran").toBe(true);
  }, 240_000);
});

describe("the Screener's segments, in Chromium", () => {
  it("each tab click, cold and warm, paints its own segment's rows and asks for nothing", async () => {
    const run = await harness.runArm({
      dist, engine: "chromium", reps: 2, warm: 0, viewport: "1440x900", scenario: "screener",
      q: "n=100&nr=20&nc=20&demo=0&ns=6&nsh=8&np=4&nph=8",
    });
    expect(run.errors, "the page logged an error").toEqual([]);
    const presses = run.presses;
    for (const phase of ["screener", "first", "other", "warm"]) {
      expect(presses.some((p) => p.phase === phase), `control: no ${phase} press`).toBe(true);
    }
    expect(new Set(presses.filter((p) => p.phase === "first").map((p) => p.view)), "both tabs came first once")
      .toEqual(new Set(["screened", "spam"]));
    for (const p of presses) {
      expect(Number.isFinite(p.paintMs), `${p.view} (${p.phase}): its rows never painted`).toBe(true);
      expect(p.requests, `${p.view} (${p.phase}): a tab click asked for something`).toBe(0);
    }
  }, 240_000);

  it("a tree built on this checkout's install runs on its own packages (the base arm of an A/B)", async () => {
    const tree = mkdtempSync(join(tmpdir(), "ohmail-view-switch-tree-"));
    const out = mkdtempSync(join(tmpdir(), "ohmail-view-switch-arm-"));
    try {
      const skip = (p: string) => !/\/(node_modules|dist|\.next|test)$/.test(p);
      for (const d of ["apps/webapp", "apps/desktop/src", "packages"]) cpSync(join(ROOT, d), join(tree, d), { recursive: true, filter: skip });
      for (const f of ["package.json", "tsconfig.base.json"]) cpSync(join(ROOT, f), join(tree, f));
      symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
      await harness.build(out, tree);
      const run = await harness.runArm({
        dist: out, engine: "chromium", reps: 1, warm: 0, scenario: "screener", q: "n=40&nr=10&nc=10&demo=0&ns=2&nsh=4&np=2&nph=4",
      });
      expect(run.errors, "the tree's page logged an error").toEqual([]);
      expect(run.presses.some((p) => p.phase === "first"), "control: the tree's tabs were clicked").toBe(true);
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  }, 240_000);
});
