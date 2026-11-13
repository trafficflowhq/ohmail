import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * THE TWO SPEED CHECKS, IN A REAL ENGINE — `scripts/perf/open-letter.mjs` and `search-first.mjs`
 * over a small planted mailbox. As above, what is asserted is what the presses DID (each letter's
 * first lines came on screen, each question drew its rows) and what a check may say about a run it
 * could not read; never how long anything took.
 */
type Read = { ms: number | null; why?: string };
type Budget = { key: string; goalField: string; goalMs: number; arm: string; state: string };
type Checks = {
  lib: {
    buildPage: (out: string) => Promise<string>;
    budgetOf: (key: string, goalField: string, file?: string) => Budget;
    sizeClassOf: (name: string, file?: string) => { name: string; messages: number };
    percentile: (values: number[], p: number) => number | null;
    verdictOf: (o: { tag: string; budget: Budget; readingMs: number | null; what: string; surface: string; size?: string; goalSize?: string }) => { rc: number; line: string };
  };
  open: {
    runOpens: (o: { dist: string; engine: string; viewport: string; messages: number; reps: number }) => Promise<{
      errors: string[]; opens: Array<Read & { kind: string; id: string | null }> }>;
    summarizeOpens: (run: { opens: Array<Read & { kind: string }>; bootMs: number; uiVitals: null }) => { readingMs: number | null; what: string };
  };
  search: {
    runSearches: (o: { dist: string; engine: string; viewport: string; messages: number; reps: number }) => Promise<{
      errors: string[]; searches: Array<Read & { phase: string; q: string; rows: number }> }>;
    summarizeSearches: (run: { searches: Array<Read & { phase: string }>; bootMs: number; uiVitals: null }) => { readingMs: number | null; what: string };
  };
};

describe("the speed checks: opening a letter and the first search results, in Chromium", () => {
  let checks: Checks;
  let page = "";

  beforeAll(async () => {
    checks = {
      lib: await import(join(ROOT, "scripts/perf/speed-check.mjs")),
      open: await import(join(ROOT, "scripts/perf/open-letter.mjs")),
      search: await import(join(ROOT, "scripts/perf/search-first.mjs")),
    } as Checks;
    page = mkdtempSync(join(tmpdir(), "ohmail-speed-check-"));
    await checks.lib.buildPage(page);
  }, 180_000);

  afterAll(() => {
    if (page) rmSync(page, { recursive: true, force: true });
  });

  for (const viewport of ["1440x900", "390x844"]) {
    it(`at ${viewport} every press on a row shows that letter's first lines, four of each kind, none twice`, async () => {
      const run = await checks.open.runOpens({ dist: page, engine: "chromium", viewport, messages: 600, reps: 1 });
      expect(run.errors, "the page logged an error").toEqual([]);
      expect(run.opens.map((o) => o.kind).sort(), "control: twelve opens, four of each kind")
        .toEqual([...Array(4).fill("designed"), ...Array(4).fill("plain"), ...Array(4).fill("prose")]);
      for (const o of run.opens) expect(typeof o.ms === "number" && o.ms > 0, `${o.kind} ${o.id}: ${o.why ?? "no reading"}`).toBe(true);
      expect(new Set(run.opens.map((o) => o.id)).size, "a letter was opened twice").toBe(run.opens.length);
      expect(checks.open.summarizeOpens({ ...run, bootMs: 0, uiVitals: null }).readingMs, "a run read whole has a reading").not.toBeNull();
    }, 240_000);
  }

  it("the first question of a session and the four after it each draw result rows", async () => {
    const run = await checks.search.runSearches({ dist: page, engine: "chromium", viewport: "1440x900", messages: 600, reps: 1 });
    expect(run.errors, "the page logged an error").toEqual([]);
    expect(run.searches.map((s) => s.phase), "control: one first question, four later").toEqual(["first", "later", "later", "later", "later"]);
    for (const s of run.searches) {
      expect(typeof s.ms === "number" && s.ms > 0, `"${s.q}": ${s.why ?? "no reading"}`).toBe(true);
      expect(s.rows, `"${s.q}" drew no row`).toBeGreaterThan(0);
    }
    expect(checks.search.summarizeSearches({ ...run, bootMs: 0, uiVitals: null }).readingMs, "a run read whole has a reading").not.toBeNull();
  }, 240_000);

  it("a run with one press unread has no reading, and no reading is a refusal, never a pass", () => {
    const opens = [{ kind: "plain", ms: 40 }, { kind: "prose", ms: null, why: "the letter's first lines never came on screen" }];
    const read = checks.open.summarizeOpens({ opens, bootMs: 0, uiVitals: null });
    expect(read.readingMs).toBeNull();
    const searches = [{ phase: "first", ms: 30 }, { phase: "later", ms: null, why: "no result row" }];
    expect(checks.search.summarizeSearches({ searches, bootMs: 0, uiVitals: null }).readingMs).toBeNull();
    const budget = checks.lib.budgetOf("open-message", "p95Ms");
    const said = checks.lib.verdictOf({ tag: "OPEN_LETTER", budget, readingMs: read.readingMs, what: read.what, surface: "5k" });
    expect(said.rc).toBe(3);
    expect(said.line).toMatch(/^OPEN_LETTER: REFUSED -- no reading: 1 of 2 opens were not read/);
  });

  it("a row that records reddens nothing over its goal; a row that decides is red over it and green at it", () => {
    const records: Budget = { key: "k", goalField: "p95Ms", goalMs: 150, arm: "records", state: "no-origin-yet" };
    const over = checks.lib.verdictOf({ tag: "T", budget: records, readingMs: 600, what: "p95 600 ms", surface: "5k" });
    expect([over.rc, over.line.startsWith("T: RECORDED -- p95 600 ms against the goal p95 150 ms (x4.00)")]).toEqual([0, true]);
    const decides = { ...records, arm: "decides" };
    expect(checks.lib.verdictOf({ tag: "T", budget: decides, readingMs: 151, what: "w", surface: "s" }).rc).toBe(1);
    expect(checks.lib.verdictOf({ tag: "T", budget: decides, readingMs: 150, what: "w", surface: "s" }).rc).toBe(0);
  });

  it("a goal defined over one size class is asked only of a run over that class", () => {
    const records: Budget = { key: "k", goalField: "ceilingMs", goalMs: 500, arm: "records", state: "no-origin-yet" };
    const run = { tag: "T", readingMs: 40, what: "w", surface: "s", goalSize: "large" };
    const at = checks.lib.verdictOf({ ...run, budget: records, size: "large" });
    expect([at.rc, at.line]).toEqual([0, "T: RECORDED -- w against the goal 500 ms (x0.08) · s; the row records, nothing reddens"]);
    // A small mailbox answers fast: its reading stands on the line, with no distance to a goal it was not asked of.
    const small = checks.lib.verdictOf({ ...run, budget: records, size: "5k" });
    expect(small.rc).toBe(0);
    expect(small.line).toMatch(/^T: RECORDED -- w · s; the goal 500 ms is asked only of the large class/);
    expect(small.line).not.toMatch(/\(x\d/);
    // A row that decides: under its goal over a smaller class is no pass, and over it no red.
    const decides = { ...records, arm: "decides" };
    for (const readingMs of [40, 4000]) {
      const said = checks.lib.verdictOf({ ...run, readingMs, budget: decides, size: "5k" });
      expect([said.rc, said.line.startsWith("T: REFUSED -- the goal 500 ms is asked only of the large class")]).toEqual([3, true]);
    }
    expect(checks.lib.verdictOf({ ...run, readingMs: 501, budget: decides, size: "large" }).rc).toBe(1);
    expect(checks.lib.verdictOf({ ...run, readingMs: 500, budget: decides, size: "large" }).rc).toBe(0);
  });

  it("the search command reads the class its goal names unless told another, and says which it read", () => {
    // The same budgets file with small classes, so that the command runs whole in seconds.
    const table = join(page, "budgets-small.json");
    const budgets = JSON.parse(readFileSync(join(ROOT, "test/contracts/perf-budgets.json"), "utf8"));
    const planted = { large: 600, small: 300 };
    budgets.sizeClasses.large.messages = planted.large;
    budgets.sizeClasses["5k"].messages = planted.small;
    writeFileSync(table, JSON.stringify(budgets));
    const search = (...more: string[]) => {
      const ran = spawnSync(process.execPath, [join(ROOT, "scripts/perf/search-first.mjs"), "--dist", page, "--reps", "1", "--budget-table", table, ...more],
        { encoding: "utf8", timeout: 200_000 });
      return { status: ran.status, last: ran.stdout.trim().split("\n").at(-1) ?? "", all: `${ran.stdout}${ran.stderr}` };
    };
    const byDefault = search();
    expect(byDefault.status, byDefault.all).toBe(0);
    expect(byDefault.last).toMatch(/^SEARCH_FIRST: RECORDED -- first search p95 \d+ ms .* against the goal 500 ms \(x\d+\.\d\d\) · large /);
    expect(byDefault.last).toContain(` · large (${planted.large} messages) · chromium 1440x900 `);
    const small = search("--size", "5k");
    expect(small.status, small.all).toBe(0);
    expect(small.last).toMatch(/^SEARCH_FIRST: RECORDED -- first search p95 \d+ ms .*; the goal 500 ms is asked only of the large class/);
    expect(small.last).toContain(` · 5k (${planted.small} messages) · chromium 1440x900 `);
    expect(small.last).not.toMatch(/\(x\d/);
    // A budgets file without the class the goal names: refused before any browser starts.
    delete budgets.sizeClasses.large;
    writeFileSync(table, JSON.stringify(budgets));
    const none = search("--size", "5k");
    expect([none.status, none.last]).toEqual([3, 'SEARCH_FIRST: REFUSED -- "large" is not a size class of the budgets file (5k, 25k)']);
  }, 480_000);

  it("the checks read their goal and their size classes from the budgets file, and refuse what it does not hold", () => {
    expect(checks.lib.budgetOf("open-message", "p95Ms").goalMs).toBe(150);
    expect(checks.lib.budgetOf("search-first", "ceilingMs").goalMs).toBe(500);
    expect(checks.lib.sizeClassOf("large").messages).toBe(80000);
    expect(() => checks.lib.budgetOf("no-such-row", "p95Ms")).toThrow(/no latency row/);
    expect(() => checks.lib.budgetOf("open-message", "ceilingMs")).toThrow(/has no ceilingMs/);
    expect(() => checks.lib.sizeClassOf("huge")).toThrow(/not a size class/);
    expect(() => checks.lib.budgetOf("open-message", "p95Ms", join(page, "absent.json"))).toThrow(/no budgets file/);
    // Nearest rank: a value that was measured, the slowest of three at p95.
    expect([checks.lib.percentile([30, 10, 20], 95), checks.lib.percentile([30, 10, 20], 50), checks.lib.percentile([], 95)]).toEqual([30, 20, null]);
  });

  it("the command refuses a folder with no bundle in it: exit 3, and the verdict line says why", () => {
    const empty = mkdtempSync(join(tmpdir(), "ohmail-speed-check-empty-"));
    try {
      for (const [script, tag] of [["open-letter.mjs", "OPEN_LETTER"], ["search-first.mjs", "SEARCH_FIRST"]]) {
        const ran = spawnSync(process.execPath, [join(ROOT, "scripts/perf", script!), "--dist", empty], { encoding: "utf8" });
        expect(ran.status, `${script}: ${ran.stdout}${ran.stderr}`).toBe(3);
        expect(ran.stdout.trim().split("\n").at(-1)).toMatch(new RegExp(`^${tag}: REFUSED -- no bundle in `));
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
