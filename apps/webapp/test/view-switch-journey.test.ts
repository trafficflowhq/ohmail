import { mkdtempSync, rmSync } from "node:fs";
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
  runArm: (o: { dist: string; engine?: string; reps?: number; q?: string; warm?: number; viewport?: string }) => Promise<{
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
