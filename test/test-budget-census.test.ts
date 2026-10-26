import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  caseBudgets, configBudgets, joinTimings, readJobLog, readReport, testFiles, verdict, type Row, type Timing,
} from "../scripts/test-budget-census.mjs";

/**
 * THE CENSUS READS THE BUDGET VITEST APPLIES. The oracle is vitest itself: a fixture tree whose every
 * test sleeps past its budget is run by the repo's own vitest, and each "Test timed out in N ms" must be
 * the budget the census read from the source, for every test, under every rule the census claims (a
 * number or options as the second or third argument, split over lines; describe options passed down;
 * `vi.setConfig` as collected, above a describe and leaking out of one; none from a hook; the config).
 */

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(REPO, "scripts", "test-budget-census.mjs");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const FILE = "test/x/budgets.test.ts";

const BUDGETS = `const sleep = () => new Promise((r) => setTimeout(r, 1500));
import { SHARED } from "../support/budgets";
const BASE = 1_00;
it("top-before", async () => { await sleep(); });
describe("d1", () => { it("inherits-setConfig", async () => { await sleep(); }); });
vi.setConfig({ testTimeout: 500 });
it("top-after", async () => { await sleep(); });
describe("d2", { timeout: 200 }, () => {
  describe("d3", () => {
    it("nested-inherits", async () => { await sleep(); });
    it("own", async () => { await sleep(); }, 300);
  });
});
describe("d4", () => {
  it(
    "multi-line",
    async () => {
      await sleep();
    },
    250,
  );
  it("options-second", { timeout: 350 }, async () => { await sleep(); });
  it("options-third", async () => { await sleep(); }, { timeout: 375 });
  it("const-math", async () => { await sleep(); }, BASE * 2 + 70);
  it("imported", async () => { await sleep(); }, SHARED);
  it("max", async () => { await sleep(); }, Math.max(120, 140));
  it("conditional", async () => { await sleep(); }, process.env.CENSUS_FIXTURE_UNSET ? 900 : 180);
  it.each(["a", "b"])("each %s", async () => { await sleep(); }, 230);
  it(\`tpl \${String(1)}\`, async () => { await sleep(); }, 220);
});
function suiteOf(label: string, ms: number) {
  describe(label, () => { it("helper-case", async () => { await sleep(); }, ms); });
}
suiteOf("h1", 260);
const maybe = process.env.CENSUS_FIXTURE_UNSET ? it.skip : it;
maybe("alias-case", async () => { await sleep(); }, 290);
const fx = it.extend({});
fx("extended", async () => { await sleep(); }, 310);
describe.skipIf(false)("skipif", { timeout: 340 }, () => { it("in-skipif", async () => { await sleep(); }); });
describe("hooked", () => {
  beforeEach(() => {});
  it("hooked-case", async () => { await sleep(); }, 210);
});
describe.skip("skipped", () => { it("never", async () => { await sleep(); }); });
describe("d5", () => {
  vi.setConfig({ testTimeout: 650 });
  it("setConfig-in-factory", async () => { await sleep(); });
});
describe("d6", () => {
  beforeAll(() => { vi.setConfig({ testTimeout: 900 }); });
  it("setConfig-in-hook-has-no-effect", async () => { await sleep(); });
});
`;

/** A fixture tree: the config's own budget, the file above, and its relative import. */
function fixture(text = BUDGETS): string {
  const root = mkdtempSync(join(tmpdir(), "ohmail-budget-census-"));
  mkdirSync(join(root, "test", "x"), { recursive: true });
  mkdirSync(join(root, "test", "support"), { recursive: true });
  writeFileSync(join(root, "vitest.config.ts"),
    `export default { test: { globals: true, include: ["test/**/*.test.ts"], testTimeout: 400, fileParallelism: false } };\n`);
  writeFileSync(join(root, "test", "support", "budgets.ts"), "export const SHARED = 330;\n");
  writeFileSync(join(root, FILE), text);
  return root;
}

/** The fixture run by vitest, outside this run's environment. */
function runVitest(root: string): string {
  const out = join(root, "out.json");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(VITEST|TEST$|NODE_OPTIONS)/.test(k)) env[k] = v;
  const r = spawnSync(process.execPath, [VITEST, "run", "--root", root, "--reporter=json", `--outputFile=${out}`], {
    cwd: root, env, encoding: "utf8",
  });
  expect(r.error, String(r.error)).toBeUndefined();
  return out;
}

function census(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const NAMES: Record<string, number> = {
  "top-before": 400, "d1 > inherits-setConfig": 500, "top-after": 500,
  "d2 > d3 > nested-inherits": 200, "d2 > d3 > own": 300,
  "d4 > multi-line": 250, "d4 > options-second": 350, "d4 > options-third": 375, "d4 > const-math": 270,
  "d4 > imported": 330, "d4 > max": 140, "d4 > conditional": 180, "d4 > each a": 230, "d4 > each b": 230,
  "d4 > tpl 1": 220, "h1 > helper-case": 260, "alias-case": 290, "extended": 310, "skipif > in-skipif": 340,
  "hooked > hooked-case": 210, "d5 > setConfig-in-factory": 650, "d6 > setConfig-in-hook-has-no-effect": 650,
};

describe("the census against vitest's own timeouts", () => {
  let root = "";
  let timed: Timing[] = [];
  let rows: Row[] = [];
  let measured = new Map<string, number>();
  let findings: ReturnType<typeof caseBudgets>["findings"] = [];

  beforeAll(() => {
    root = fixture();
    const report = runVitest(root);
    const raw = JSON.parse(readFileSync(report, "utf8")) as {
      testResults: Array<{ assertionResults: Array<{ ancestorTitles: string[]; title: string; status: string; failureMessages: string[] }> }>;
    };
    for (const f of raw.testResults) {
      for (const a of f.assertionResults) {
        if (a.status === "skipped" || a.status === "pending") continue;
        const m = /Test timed out in (\d+)ms/.exec(a.failureMessages.join("\n"));
        measured.set([...a.ancestorTitles, a.title].join(" > "), m ? Number(m[1]) : -1);
      }
    }
    timed = readReport(report);
    const cb = caseBudgets(root);
    findings = cb.findings;
    rows = joinTimings(cb.cases, timed, { files: new Set(testFiles(root)), suites: cb.suites, config: configBudgets(root) });
    // The nested run waits out 22 budgets (6.9 s) after a vitest start: 13 s under 10% of a CPU.
  }, 30_000);

  it("vitest timed every fixture test out at the budget written for it (the fixture holds)", () => {
    expect(Object.fromEntries(measured)).toEqual(NAMES);
  });

  it("the census reads the same budget for every test vitest ran", () => {
    expect(rows.filter((r) => r.matched === "none").map((r) => r.name), "a timing the census did not place").toEqual([]);
    const read = Object.fromEntries(rows.map((r) => [r.name, r.budgetMs]));
    expect(read).toEqual(Object.fromEntries(measured));
  });

  it("names each budget's source, its hooks and the conditional", () => {
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect(by("top-before").source).toBe("config");
    expect(by("top-after").source).toBe("setConfig");
    expect(by("d2 > d3 > nested-inherits").source).toBe("describe");
    expect(by("d2 > d3 > own").source).toBe("case");
    expect(by("hooked > hooked-case").hooks).toEqual(["beforeEach"]);
    expect(by("d4 > conditional").conditional).toBe(true);
    expect(by("h1 > helper-case").matched).toBe("exact");
    expect(by("d4 > each a").matched).toBe("pattern");
    expect(configBudgets(root).default.ms).toBe(400);
  });

  it("reports the setConfig in a hook as having no effect", () => {
    expect(findings.map((f) => `${f.kind}:${f.line}`)).toEqual([`setConfig-no-effect:${BUDGETS.split("\n").findIndex((l) => l.includes("testTimeout: 900")) + 1}`]);
  });
});

// The --check case starts the script four times (each loads typescript): 8 s under 10% of a CPU.
describe("timings from a report and from a job log", { timeout: 30_000 }, () => {
  const root = fixture("it(\"slow\", async () => {}, 1000);\nit(\"quick\", async () => {});\ndescribe(\"d\", () => { it(\"x\", async () => {}); });\n");
  const files = new Set(testFiles(root));
  const { cases, suites } = caseBudgets(root);
  const config = configBudgets(root);

  it("maps a runner's path to the tree's file, and a SQLite report to its own project", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-budget-report-"));
    const report = (name: string, ms: number) => JSON.stringify({ testResults: [{
      name: `/home/runner/_work/ohmail/ohmail/${FILE}`,
      assertionResults: [{ ancestorTitles: [], title: "quick", status: "passed", duration: ms, failureMessages: [] },
        { ancestorTitles: [], title: "gone", status: "skipped", duration: 0, failureMessages: [] }],
    }] });
    writeFileSync(join(dir, "ci-suite-3.json"), report("a", 120.4));
    writeFileSync(join(dir, "ci-sqlite-1.json"), report("b", 333));
    const t = [...readReport(join(dir, "ci-suite-3.json")), ...readReport(join(dir, "ci-sqlite-1.json"))];
    expect(t.map((x) => [x.project, x.ms])).toEqual([["default", 120], ["sqlite", 333]]);
    const rows = joinTimings(cases, t, { files, suites, config });
    expect(rows.map((r) => [r.file, r.name, r.project, r.budgetMs, r.matched])).toEqual([
      [FILE, "quick", "sqlite", 400, "exact"], [FILE, "quick", "default", 400, "exact"]]);
    // A run before the tree under census says nothing of a file changed since.
    const dropped = joinTimings(cases, t, { files, suites, config, drop: { from: new Set([join(dir, "ci-sqlite-1.json")]), files: new Set([FILE]) } });
    expect(dropped.map((r) => r.project)).toEqual(["default"]);
  });

  it("reads a gh run view log: ANSI, timestamps, the file line and the test lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-budget-log-"));
    const log = [
      "suite (3)\tRun the shard\t2026-10-20T10:00:00.1234567Z \x1b[32m✓\x1b[39m test/other.test.ts (2 tests) 5ms",
      `suite (3)\tRun the shard\t2026-10-20T10:00:01.1234567Z \x1b[31m❯\x1b[39m ${FILE} (3 tests | 1 failed) 9000ms`,
      "suite (3)\tRun the shard\t2026-10-20T10:00:01.2234567Z    \x1b[32m✓\x1b[39m slow 900ms",
      // gh prints the escape as caret notation.
      "suite (3)\tRun the shard\t2026-10-20T10:00:01.3234567Z    ^[[31m×^[[39m d^[[2m > ^[[22mx^[[33m 5004^[[2mms^[[22m^[[39m",
      "suite (3)\tRun the shard\t2026-10-20T10:00:01.4234567Z      → Test timed out in 5000ms.",
    ].join("\n");
    writeFileSync(join(dir, "job.log"), log);
    const t = readJobLog(join(dir, "job.log"));
    expect(t.map((x) => [x.file, x.chain.join(" > "), x.ms, x.status, x.timedOut])).toEqual([
      [FILE, "slow", 900, "passed", false], [FILE, "d > x", 5004, "failed", true]]);
    const v = verdict(joinTimings(cases, t, { files, suites, config }), { minMs: 2500 });
    expect(v.listA.map((r) => r.name)).toEqual(["d > x"]);
    expect(v.listB.map((r) => [r.name, r.ratio])).toEqual([["slow", 0.9]]);
    expect(v.fail).toHaveLength(2);
    expect(v.warn).toEqual([]);
  });

  it("--check: 0 when nothing is near its budget, 1 on a list-A row, 2 on input it cannot read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-budget-check-"));
    const at = (ms: number) => JSON.stringify({ testResults: [{ name: `/w/${FILE}`, assertionResults: [
      { ancestorTitles: [], title: "quick", status: "passed", duration: ms, failureMessages: [] }] }] });
    writeFileSync(join(dir, "ok.json"), at(100));
    writeFileSync(join(dir, "slow.json"), at(3000));
    writeFileSync(join(dir, "bad.json"), "{");
    const ok = census(["--root", root, "--report", join(dir, "ok.json"), "--check"]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).toContain("CENSUS_CHECK OK");
    const slow = census(["--root", root, "--report", join(dir, "slow.json"), "--check"]);
    expect(slow.code, slow.err).toBe(1);
    expect(slow.err).toContain(`LIST_A ${FILE}:2 3000ms on the 400ms default: quick`);
    expect(slow.out).toContain("### List A");
    const bad = census(["--root", root, "--report", join(dir, "bad.json"), "--check"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("CENSUS_INPUT");
    expect(census(["--root", root, "--check"]).code, "no timings at all").toBe(2);
  });
});

// A file's first case carries its cold import: 1.4-3.4 s alone, past vitest's 5 s on a loaded runner.
describe("the suite's own config budget", () => {
  it("lets a case outlast vitest's 5 s default", async () => {
    await new Promise((r) => setTimeout(r, 5_200));
  });
});
