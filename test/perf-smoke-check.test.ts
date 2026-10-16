import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
// @ts-expect-error — a .mjs script with no declarations; the exports are the verdict under test.
import * as check from "../scripts/perf-smoke-check.mjs";
import { publicPath, publicRel } from "./support/public-root.mjs";

/**
 * THE PERF SMOKE'S OWN GUARD.
 *
 * The check exists because a build matrix that proves the app opens a window proves nothing about
 * what the app costs, and a released build was measured taking a machine to the edge of its memory with
 * nothing watching. A check nobody has watched refuse is decoration, so every arm here is driven
 * BOTH ways: the shape it exists to refuse, and the shape it must admit.
 *
 * The positive control is a REAL recording, not a fixture: the project's design notes records the
 * 0.16.2 baseline's renderer peak and its engine's, and the two arms
 * read exactly those two numbers out of the recorded sample and the recorded log below.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));

const OK_LOG = check.SAMPLE_LOG_OK as string;
const verdict = (out: { text: string }) =>
  out.text.split("\n").filter((l) => l.startsWith("PERF_SMOKE:")).pop() ?? "<no verdict line>";

function run(over: Record<string, unknown> = {}) {
  const result = check.collect({
    samples: check.withinBudgetSample(),
    log: OK_LOG,
    uiInBundle: false,
    expectMessages: 10000,
    fixtureMessages: 10000,
    ...over,
  });
  return { result, ...check.render(result) };
}

/**
 * One `ui_vitals` line, composed the way `apps/desktop/src-tauri/src/vitals.rs` composes it: every
 * name in its own vocabulary, in its own order, a number or `null` — never a subset. The fixture
 * is written this way on purpose, because the defect these cases exist for was a fixture that
 * carried names the app has never written and therefore agreed with the reader about nothing.
 */
/* The rig's own lines for the worst of five empty-install starts of each build, taken in the same
 * minutes (the base, and the build that makes a new store in memory), numbers only. */
const BASE_BOOT_LINE = '{"ts":"2026-09-28T06:55:14.527Z","level":"info","service":"sidecar","event":"boot_phases","pgliteOpenMs":13051,"adoptBaselineMs":20,"migrateMs":489,"compactMs":6,"searchSetupMs":102,"migrationsPending":135,"migrationsApplied":135,"slowestMigration":null,"slowestMs":null,"worldMs":58,"totalReadyMs":13814}';
const BASE_UI_LINE = '{"service":"ui","event":"ui_vitals","shellPaintedMs":14038,"listUsableMs":14728,"engineReadyMs":14044,"openP50Ms":null,"openP95Ms":null,"openCount":0,"openTimeouts":0,"switchP50Ms":null,"switchP95Ms":null,"switchCount":0,"switchTimeouts":0,"searchP50Ms":null,"searchP95Ms":null,"searchCount":0,"longFrames":0,"longTasks":0,"deriveMs":1,"deriveP50Ms":0,"deriveP95Ms":1,"deriveCount":4,"notifiesPer5min":5,"mirrorMessages":9,"uptimeMin":0,"reason":null}';
const TIP_BOOT_LINE = '{"ts":"2026-09-28T06:55:22.848Z","level":"info","service":"sidecar","event":"boot_phases","pgliteOpenMs":1927,"adoptBaselineMs":76,"migrateMs":1075,"compactMs":10,"searchSetupMs":173,"migrationsPending":135,"migrationsApplied":135,"slowestMigration":null,"slowestMs":null,"worldMs":74,"totalReadyMs":3456}';
const TIP_UI_LINE = '{"service":"ui","event":"ui_vitals","shellPaintedMs":3943,"listUsableMs":4800,"engineReadyMs":3951,"openP50Ms":null,"openP95Ms":null,"openCount":0,"openTimeouts":0,"switchP50Ms":null,"switchP95Ms":null,"switchCount":0,"switchTimeouts":0,"searchP50Ms":null,"searchP95Ms":null,"searchCount":0,"longFrames":3,"longTasks":0,"deriveMs":1,"deriveP50Ms":0,"deriveP95Ms":1,"deriveCount":4,"notifiesPer5min":7,"mirrorMessages":0,"uptimeMin":0,"reason":null}';

function uiLine(over: Record<string, number | null> = {}): string {
  const fields: Record<string, number | null> = {
    shellPaintedMs: 320, listUsableMs: 1400, engineReadyMs: 1800,
    openP50Ms: 70, openP95Ms: 120, openCount: 40,
    switchP50Ms: 30, switchP95Ms: 60, switchCount: 12,
    searchP50Ms: 90, searchP95Ms: 140, searchCount: 3,
    longFrames: 2, longTasks: 0,
    deriveMs: 180, deriveP50Ms: 60, deriveP95Ms: 170, deriveCount: 210,
    notifiesPer5min: 44, uptimeMin: 7,
    ...over,
  };
  const parts = Object.entries(fields).map(([k, v]) => `"${k}":${v === null ? "null" : v}`);
  return `{"service":"ui","event":"ui_vitals",${parts.join(",")}}`;
}

describe("the arms that can turn a build red", () => {
  it("admits a build inside every budget", () => {
    const out = run();
    expect(out.code, verdict(out)).toBe(0);
    expect(verdict(out)).toContain("GREEN");
  });

  it("refuses a renderer over its budget, and says by how much", () => {
    /* The arm reads the webview GROUP — the render, GPU and network processes together — because
     * that is what a machine pays. The renderer beside the fixture's 40 MB network process
     * is their sum, and the reading says that and not the renderer alone. */
    const heavy = check.withinBudgetSample().replace(/renderer=\d+/g, "renderer=1500000");
    const out = run({ samples: heavy });
    expect(out.code).toBe(1);
    expect(verdict(out)).toContain("renderer_peak");
    expect(out.text).toContain("1540000 kB peak against 1433600 kB");
  });

  it("prints a renderer over its goal and under its ceiling, and reddens nothing", () => {
    /* The released 0.24.0's shape on a first sync: over this check's own 400 MB goal, under the
     * table's ruled first-sync ceiling. The goal is a reading, never the verdict. */
    const heavy = check.withinBudgetSample().replace(/renderer=\d+/g, "renderer=512000");
    const out = run({ samples: heavy });
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toMatch(/renderer_goal +RECORDED +FAIL +552000 kB peak against a 409600 kB goal/);
  });

  it("refuses an engine over its budget", () => {
    const fat = OK_LOG.replace('"rss":314572800', '"rss":629145600');
    const out = run({ log: fat });
    expect(out.code).toBe(1);
    expect(verdict(out)).toContain("engine_rss");
  });

  it("refuses an engine slower to get ready than its measured ceiling, and admits one at it", () => {
    /* engine-ready decides on the ceiling measured for this step's own shape (the file's header
     * says where it came from). One millisecond over is red and the ceiling itself is not. */
    const at = (ms: number) => run({ log: OK_LOG.replace('"totalReadyMs":1850', `"totalReadyMs":${ms}`) });
    const over = at(check.BUDGETS.engineReadyMs + 1);
    expect(over.code, verdict(over)).toBe(1);
    expect(verdict(over)).toContain("engine_ready");
    const level = at(check.BUDGETS.engineReadyMs);
    expect(level.code, verdict(level)).toBe(0);
    expect(level.text).toMatch(/engine_ready +DECIDES +PASS/);
  });

  it("reddens a first start that makes its store on the disk and admits one made in memory", () => {
    /* REAL LINES, read off the rig that measured the ceilings: the worst of five empty-install
     * starts of each build, numbers only. The base wrote its new store to the disk page by page. */
    const base = [BASE_BOOT_LINE, BASE_UI_LINE].join("\n");
    const tip = [TIP_BOOT_LINE, TIP_UI_LINE].join("\n");
    const vitals = OK_LOG.split("\n").filter((l) => !l.includes('"boot_phases"')).join("\n");
    const red = run({ log: `${vitals}\n${base}`, uiInBundle: true });
    expect(red.code, verdict(red)).toBe(1);
    expect(verdict(red)).toContain("engine_ready");
    expect(verdict(red)).toContain("start_to_list");
    const green = run({ log: `${vitals}\n${tip}`, uiInBundle: true });
    expect(green.code, verdict(green)).toBe(0);
  });

  it("names every failing arm, not the first one", () => {
    const out = run({ samples: check.releasedShapeSample(), log: check.SAMPLE_LOG_SLOW });
    expect(out.code).toBe(1);
    for (const arm of ["renderer_peak", "engine_rss", "engine_ready"]) {
      expect(verdict(out)).toContain(arm);
    }
  });
});

describe("the shapes that are refused rather than passed", () => {
  it("refuses a window too short to read, naming the count", () => {
    const short = check.withinBudgetSample().split("\n").slice(0, 5).join("\n");
    const out = run({ samples: short });
    expect(out.code).toBe(3);
    expect(verdict(out)).toContain("only 5 samples");
  });

  it("refuses a window that is long enough in samples and too short in time", () => {
    /* TWO mechanisms cover the short window — the sample count and the span — and only an
     * assertion on the refusal's own wording tells them apart. Twenty samples one second apart. */
    const dense = check.withinBudgetSample().split("\n")
      .map((l: string, i: number) => l.replace(/^\d+/, String(1789160000 + i)))
      .join("\n");
    const out = run({ samples: dense });
    expect(out.code).toBe(3);
    expect(verdict(out)).toContain("span");
  });

  it('refuses "no renderer" as exactly that, never as "no sample"', () => {
    // How the failure actually arrives: a sampler keyed on the kernel's truncated process name
    // loses every WebKit process at once, and the file is full of samples of the wrong processes.
    const blind = check.withinBudgetSample().replace(/\trenderer=\d+/g, "").replace(/\tnet=\d+/g, "");
    const out = run({ samples: blind });
    expect(out.code).toBe(3);
    expect(verdict(out)).toContain("NO RENDERER SAMPLE");
    expect(verdict(out)).not.toMatch(/-- no samples?$/);
    expect(out.text).toContain("engine, shell");
  });

  it("refuses a run whose mailbox never finished importing", () => {
    const out = run({ log: OK_LOG.replace('"event":"first_sync_finished"', '"event":"first_sync_started"') });
    expect(out.code).toBe(3);
    expect(verdict(out)).toContain("never finished importing");
  });

  it("refuses an engine that never started as that, never as an unfinished import", () => {
    /* The log a rehearsal of the CI step wrote on 2026-09-24, with the shell's own line every
     * runner wrote from 2026-09-13 on — beside a refusal that blamed the import instead. */
    const log = [
      "ohmail engine: not started \u2014 this computer's keystore could not be opened (No default store has been set, so cannot search or create entries)",
      '{"service":"updater","event":"updater_offer","offered":"none","found":"installKind","installKind":"unpackaged"}',
      '{"service":"shell","event":"renderer_vitals","measured":false,"reason":"no_children_classified","totalRssKb":null,"budgetKb":1433600,"uptimeMin":0,"children":[]}',
    ].join("\n");
    const out = run({ log });
    expect(out.code).toBe(3);
    expect(verdict(out)).toContain("the engine never started");
    expect(verdict(out)).toContain("keystore could not be opened");
    expect(verdict(out)).not.toContain("never finished importing");
    // And the ordinary log carries no such line, so a started engine is read as one.
    expect(check.engineNotStarted(OK_LOG)).toBeNull();
    expect(run().code).toBe(0);
  });

  it("states the budget row it held the run to, on a line the verdict reader skips", () => {
    const line = check.budgetLine({ fixtureMessages: 5000, windowS: 480 }) as string;
    expect(line).toBe("PERF_SMOKE_BUDGET: 5000" + " messages, 480 s window, renderer peak 1400 MB (goal 400 MB), engine 450 MB");
    expect(line.startsWith("PERF_SMOKE:")).toBe(false);
  });

  it("runs when it is reached through a symlink, rather than exiting 0 having run nothing", () => {
    /* A rehearsal of the CI step reached this file through a symlinked directory: the entry check
     * compared the resolved module URL with the unresolved path, ran nothing and exited 0. */
    const dir = mkdtempSync(join(tmpdir(), "perf-smoke-link-"));
    const link = join(dir, "perf-smoke-check.mjs");
    symlinkSync(resolve(HERE, "../scripts/perf-smoke-check.mjs"), link);
    const r = spawnSync(process.execPath, [link, "--perf-smoke-only"], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    expect(r.stdout).toContain("PERF_SMOKE_SELFTEST: GREEN");
    expect(r.status).toBe(0);
  });

  it("refuses a partial import with the count it got", () => {
    const out = run({ log: OK_LOG.replace('"messages":10000', '"messages":2200') });
    expect(out.code).toBe(3);
    expect(verdict(out)).toContain("imported 2200" + " messages of the 10000");
  });

  it("still decides on the renderer when the app wrote no log at all", () => {
    /* Written as the reachable half of what was briefly an "every arm unread" refusal. It cannot
     * fire: the sampler in this same file is the renderer arm's instrument, so past the sample
     * refusals above there is always one arm deciding. The case is kept pointing the other way,
     * as the proof that a log-less run is still a real reading of the renderer. */
    const out = run({ log: "", expectMessages: 0 });
    expect(out.code).toBe(0);
    expect(out.text).toContain("renderer_peak");
    expect(out.text).toContain("<the log carries no boot_phases line>");
  });
});

describe("the unit the engine reports its memory in", () => {
  /* The engine's `rss` is BYTES and the sampler's figures are kB. Read as kB, a 300 MB engine
   * would be 300 GB and every build would redden; read as bytes, a kB figure would be a third of
   * a megabyte and nothing would ever redden. The conversion is one function with a magnitude
   * bound on each side, so a unit error names itself. */
  it("converts bytes to kB and reads the recorded figure", () => {
    expect(check.engineRssKbFromBytes(684519424).kb).toBe(668476);
  });

  it("refuses a figure that has already been converted, rather than passing it", () => {
    const wrong = check.engineRssKbFromBytes(668476);
    expect(wrong.kb).toBeNull();
    expect(wrong.why).toContain("BYTES");
  });

  it("refuses a figure converted the other way", () => {
    expect(check.engineRssKbFromBytes(684519424 * 1024).kb).toBeNull();
  });
});

describe("the frame instrument arms itself from the build, never from a flag", () => {
  /* Two conditions measured independently, so the arm turns itself on when the instrument lands
   * instead of when somebody remembers a switch — and so "the instrument is missing" and "the
   * instrument broke" are different answers rather than one silence. */
  it("is unread, and reddens nothing, when the build carries no instrument", () => {
    const state = check.uiVitalsState({ inBundle: false, lineCount: 0 });
    expect(state.armed).toBe(false);
    expect(state.state).toBe("absent");
    const out = run({ uiInBundle: false });
    expect(out.code).toBe(0);
    expect(out.text).toContain("UNREAD");
  });

  it("reddens when the instrument shipped and this run's log has none of its lines", () => {
    expect(check.uiVitalsState({ inBundle: true, lineCount: 0 }).state).toBe("broken");
    const out = run({ uiInBundle: true });
    expect(out.code).toBe(1);
    expect(verdict(out)).toContain("ui_vitals");
  });

  it("reddens on a line the artifact cannot have written", () => {
    expect(check.uiVitalsState({ inBundle: false, lineCount: 4 }).state).toBe("impossible");
  });


  it("reads the instrument out of the artifact's own bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-smoke-"));
    const withIt = join(dir, "with"); const without = join(dir, "without");
    writeFileSync(withIt, `padding\u0000${check.UI_VITALS_EVENT}\u0000more`);
    writeFileSync(without, "padding\u0000nothing of the sort\u0000more");
    expect(check.bundleCarriesUiVitals(withIt)).toBe(true);
    expect(check.bundleCarriesUiVitals(without)).toBe(false);
    expect(check.bundleCarriesUiVitals(join(dir, "absent"))).toBeNull();
  });

  it("arms an arm only when the artifact carries THAT arm's field name", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-smoke-fields-"));
    const half = join(dir, "half");
    // The event and one of the four names: the half of the vocabulary that has landed.
    writeFileSync(half, `x\u0000${check.UI_VITALS_EVENT}\u0000listUsableMs\u0000x`);
    const vocabulary = check.bundleVocabulary(half);
    expect(vocabulary.event).toBe(true);
    expect(vocabulary.fields.start_to_list).toBe(true);
    expect(vocabulary.fields.open_p95).toBe(false);
    expect(check.bundleVocabulary(join(dir, "absent"))).toBeNull();

    const out = run({
      log: `${OK_LOG}\n${uiLine()}`,
      uiInBundle: vocabulary.event,
      uiFields: vocabulary.fields,
    });
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toContain(`<this build carries no "openP95Ms">`);
    expect(out.text).toContain(`1400 ms against ${check.BUDGETS.startToListMs} ms`);
  });
});

/**
 * THE CHECK AND THE APP SHARE ONE VOCABULARY.
 *
 * These arms read four names out of a line the desktop shell composes from its own list, so one
 * wire format lives in four places. They did not agree: this file read `startToListMs`, `openMs`,
 * `frameGapMs` and `longTaskMs` under `"service":"shell"` and the window has never written any of
 * them, so a build inside every budget answered RED on three arms and PASS on a fourth that had
 * counted nothing. The cases below drive the line the app actually writes and the line this check
 * used to look for; `apps/webapp/test/ui-vitals-census.test.ts` is what keeps the four in step.
 */
describe("the latency arms read the line the app writes", () => {
  it("reads the real line and judges it against the budgets", () => {
    const out = run({ log: `${OK_LOG}\n${uiLine()}`, uiInBundle: true });
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toContain(`1400 ms against ${check.BUDGETS.startToListMs} ms`);
    expect(out.text).toContain("p95 120 ms against 150 ms");
    expect(out.text).toContain("2 frames over 50 ms");
  });

  /* THE STATE THIS CHECK WAS IN, exactly: a line under this window's own service and event
     carrying the four names the check used to read, and every real name missing. */
  it("refuses by name when the log carries none of the names it reads", () => {
    const drifted = '{"service":"ui","event":"ui_vitals",'
      + '"startToListMs":1400,"openMs":90,"frameGapMs":18,"longTaskMs":0}';
    const out = run({ log: `${OK_LOG}\n${drifted}`, uiInBundle: true });
    expect(out.code).toBe(1);
    for (const arm of ["start_to_list", "open_p95", "long_frames", "long_tasks"]) {
      expect(verdict(out)).toContain(arm);
    }
    expect(out.text).toContain(`the window wrote no "listUsableMs"`);
    expect(out.text).toContain("no longer share one vocabulary");
    // And never a zero wearing a pass: the count arms refused with the rest.
    expect(out.text).not.toContain("0 tasks over 200 ms against 0");
  });

  it("a line under another service is not this window's", () => {
    const foreign = uiLine().replace('"service":"ui"', '"service":"shell"');
    const out = run({ log: `${OK_LOG}\n${foreign}`, uiInBundle: true });
    // The instrument shipped and this run's log has none of ITS lines.
    expect(out.code).toBe(1);
    expect(verdict(out)).toContain("ui_vitals");
  });

  it("a null value reads NOT MEASURED and reddens nothing", () => {
    // Nobody opens a message during the CI run, so this is the ordinary shape there.
    const out = run({ log: `${OK_LOG}\n${uiLine({ openP95Ms: null })}`, uiInBundle: true });
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toContain("NOT MEASURED");
    expect(out.text).toContain(`"openP95Ms" was null in all 1 of its lines`);
    expect(out.text).not.toContain("p95 0 ms");
  });

  it("prints an open that took too long, says by how much, and reddens nothing", () => {
    /* open-message is `records` in the perf table, with no ceiling ruled at all. */
    const out = run({ log: `${OK_LOG}\n${uiLine({ openP95Ms: 600 })}`, uiInBundle: true });
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toMatch(/open_p95 +RECORDED +FAIL +p95 600 ms against 150 ms/);
  });

  it("refuses a start slower to a usable list than its measured ceiling, and prints the goal", () => {
    /* start-to-list decides on its measured ceiling; the plan's 2 000 ms is the goal beside it. */
    const { startToListMs: ceiling, startToListGoalMs: goal } = check.BUDGETS;
    const at = (ms: number) => run({ log: `${OK_LOG}\n${uiLine({ listUsableMs: ms })}`, uiInBundle: true });
    const over = at(ceiling + 1);
    expect(over.code, verdict(over)).toBe(1);
    expect(verdict(over)).toContain("start_to_list");
    const pastGoal = at(goal + 1);
    expect(pastGoal.code, verdict(pastGoal)).toBe(0);
    expect(pastGoal.text).toContain(`${goal + 1} ms against ${ceiling} ms (goal ${goal} ms)`);
  });

  it("takes the worst report of the run and sums the counts", () => {
    /* The percentiles are the WINDOW's, taken over its own ring, so a run's reading is the worst
       report it made and never a percentile of percentiles. The counters are per report window,
       so they add. */
    const log = [OK_LOG, uiLine({ openP95Ms: 120, longFrames: 2 }),
      uiLine({ openP95Ms: 600, longFrames: 3 })].join("\n");
    const out = run({ log, uiInBundle: true });
    expect(out.text).toContain("p95 600 ms against 150 ms");
    expect(out.text).toContain("5 frames over 50 ms");
  });
});

/**
 * THE DERIVATION FIGURES, ON THE SAME LINE.
 *
 * The window reports four numbers for the whole-mirror rebuild — the worst pass, its p50 and p95,
 * and the count — beside the latency marks. This check prints all four and budgets the p95 against
 * `test/contracts/perf-budgets.json`'s `latency` block: a ruled ceiling DECIDES, and until one is
 * ruled the p95 is printed against the goal and reddens nothing. The three silences are the same
 * chain as the latency arms — an older emitter's absent field is UNREAD, a shipped field the log
 * never wrote is REFUSED by name, a present-but-null field is NOT MEASURED — never a zero wearing a
 * pass.
 */
describe("the derivation figures the window reports on that line", () => {
  const REAL_TABLE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test/contracts/perf-budgets.json");

  it("prints all four when the line carries them, and budgets nothing while no ceiling is ruled", () => {
    // The real table's derive-p95 has no ruled ceiling, so the p95 is RECORDED against its goal.
    const budget = check.readDeriveP95Budget(REAL_TABLE);
    const out = run({ log: `${OK_LOG}\n${uiLine()}`, uiInBundle: true, deriveBudget: budget });
    expect(out.code, verdict(out)).toBe(0);
    for (const arm of ["derive_ms", "derive_p50", "derive_p95", "derive_count"]) {
      expect(out.text, arm).toContain(arm);
    }
    expect(out.text).toContain("210 derivations");
    expect(out.text).toContain("UNBUDGETED");
    expect(out.text).toContain("p95 170 ms against a 50 ms goal");
    expect(verdict(out)).toContain("GREEN");
  });

  it("REFUSES by name when the emitter carries a derivation field this run's log never wrote", () => {
    /* The one shape a zero must never wear: the bundle (the emitter version) carries `deriveP95Ms`
       and the log has none of it — the two no longer share a vocabulary, so it is refused rather
       than read as a fast pass of zero milliseconds. */
    const dropped = uiLine().replace(/,"deriveP95Ms":\d+/, "");
    const out = run({ log: `${OK_LOG}\n${dropped}`, uiInBundle: true, uiFields: { derive_p95: true } });
    expect(out.code).toBe(3);
    expect(verdict(out)).toContain("deriveP95Ms");
    expect(verdict(out)).toContain("no longer share one vocabulary");
  });

  it("is UNREAD, not refused, when an older emitter never carried the field", () => {
    const dropped = uiLine().replace(/,"deriveP95Ms":\d+/, "");
    const out = run({ log: `${OK_LOG}\n${dropped}`, uiInBundle: true, uiFields: { derive_p95: false } });
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toContain(`<this build's emitter carries no "deriveP95Ms">`);
  });

  it("FAILS a p95 over a ruled ceiling and passes one under it", () => {
    const ruled = { present: true, ceilingMs: 150, goalMs: 50, origin: "a ruled ceiling for the test", status: "ruled" };
    const over = run({ log: `${OK_LOG}\n${uiLine({ deriveP95Ms: 600 })}`, uiInBundle: true, deriveBudget: ruled });
    expect(over.code).toBe(1);
    expect(verdict(over)).toContain("derive_p95");
    expect(over.text).toContain("p95 600 ms against 150 ms");
    const under = run({ log: `${OK_LOG}\n${uiLine({ deriveP95Ms: 120 })}`, uiInBundle: true, deriveBudget: ruled });
    expect(under.code, verdict(under)).toBe(0);
    expect(under.text).toContain("p95 120 ms against 150 ms");
  });

  it("reads the derivation budget out of the table, and its origin is NULL because it has none", () => {
    /* A budget is a number with an origin, and this one has no origin — which is the whole content
       of the row it is filed under. Until 2026-09-16 the reader answered with the name of the
       READINGS here, so the row that exists because the budget has no origin reported one. The
       budget's origin is null; the GOAL's origin is a separate fact and comes back beside it. */
    const budget = check.readDeriveP95Budget(REAL_TABLE);
    expect(budget.present).toBe(true);
    expect(budget.ceilingMs).toBeNull();
    expect(budget.status).toBe("unmeasured");
    expect(budget.goalMs).toBe(50);
    expect(budget.origin, "a budget with no origin reported one").toBeNull();
    expect(budget.goalOrigin, "the goal's own origin is not read").toMatch(/one frame at 60 Hz/);
  });

  it("a null derivation reads NOT MEASURED and reddens nothing", () => {
    // Nobody's mail moves during the CI run, so a window that derived nothing is the ordinary shape.
    const out = run({
      log: `${OK_LOG}\n${uiLine({ deriveMs: null, deriveP50Ms: null, deriveP95Ms: null, deriveCount: 0 })}`,
      uiInBundle: true,
      deriveBudget: check.readDeriveP95Budget(REAL_TABLE),
    });
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toContain("NOT MEASURED");
    expect(out.text).toContain(`"deriveP95Ms" was null in all 1 of its lines`);
    expect(out.text).toContain("0 derivations");
    expect(out.text).not.toContain("p95 0 ms");
  });
});

describe("it reads the recorded run, which is what makes it a control", () => {
  /* A log captured while the process was stopped ends in a line cut mid-string. A parser needing
   * whole JSON throws away the last real reading; a field extractor does not, and the recorded
   * baseline's last `engine_vitals` line is truncated exactly that way. */
  const TRUNCATED =
    '{"ts":"2026-09-11T22:27:26.936Z","level":"info","service":"sidecar","event":"engine_vitals",' +
    '"rss":684519424,"heapUsed":89227552,"external":213258303,"memoryReading":"process",' +
    '"storeBytes":201850880,"uptimeMs":5401711,"reason":"the engine\'s ';

  it("reads a figure out of a line that was cut mid-write", () => {
    expect(check.lastField(TRUNCATED, "engine_vitals", "rss")).toBe(684519424);
  });

  it("reads the recorded kernel process names, so a real run can be the control", () => {
    for (const [spelling, role] of [
      ["WebKitWebProcess", "renderer"], ["WebKitWebProces", "renderer"],
      ["WebKitNetworkPr", "net"], ["node", "engine"], ["ohmail", "shell"],
    ] as const) {
      expect(check.canonRole(spelling), spelling).toBe(role);
    }
  });

  it("classifies a process by its arguments and not by a truncated name", () => {
    expect(check.roleOfArgv("/usr/libexec/webkit2gtk-4.1/WebKitWebProcess 12 8", 44, 1)).toBe("renderer");
    expect(check.roleOfArgv("node /tmp/.mount_x/ohmail-engine.mjs", 45, 1)).toBe("engine");
    // A Node process that is not this app's engine is not counted at all — a bare `node` key
    // would collect anything else running on the machine.
    expect(check.roleOfArgv("node /usr/local/bin/something-else", 46, 1)).toBeNull();
  });

  it("reads memory as the kernel's own kB and refuses any other unit", () => {
    expect(check.parseVmRssKb("Name:\tohmail\nVmRSS:\t  315944 kB\nThreads:\t9\n")).toBe(315944);
    // `statm` counts PAGES; a reader that accepted a pageless unit here would be four times low
    // on a 16 kB-page machine.
    expect(check.parseVmRssKb("VmRSS:\t  315944 pages\n")).toBeNull();
    expect(check.parseVmRssKb("Name:\tohmail\n")).toBeNull();
  });

  it("walks a process tree out of a /proc-shaped directory", () => {
    const root = mkdtempSync(join(tmpdir(), "perf-proc-"));
    const write = (pid: number, ppid: number, comm: string, rss: number, argv: string) => {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) S ${ppid} 1 1 0 -1 4194560 0`);
      writeFileSync(join(root, String(pid), "status"), `Name:\t${comm}\nVmRSS:\t ${rss} kB\n`);
      writeFileSync(join(root, String(pid), "cmdline"), argv.replace(/ /g, "\u0000"));
    };
    write(100, 1, "ohmail", 300000, "/tmp/.mount_q/ohmail");
    write(101, 100, "WebKitWebProces", 220000, "/usr/libexec/webkit2gtk-4.1/WebKitWebProcess 4 7");
    write(102, 101, "WebKitNetworkPr", 40000, "/usr/libexec/webkit2gtk-4.1/WebKitNetworkProcess 5");
    write(103, 100, "node", 280000, "node /tmp/.mount_q/ohmail-engine.mjs");
    // Another application's webview, and another Node process. Neither is in this tree.
    write(200, 1, "WebKitWebProces", 900000, "/usr/libexec/webkit2gtk-4.1/WebKitWebProcess 9 9");
    write(201, 1, "node", 700000, "node /usr/local/bin/something-else");

    expect([...check.treeOf(root, 100)].sort()).toEqual([100, 101, 102, 103]);
    const line = check.sampleOnce(root, 100, 1789160000);
    expect(line).toContain("renderer=220000");
    expect(line).toContain("net=40000");
    expect(line).toContain("engine=280000");
    expect(line).toContain("shell=300000");
    // A grandchild is in the group, and the neighbour's 900 MB renderer is not.
    expect(line).not.toContain("900000");
    expect(line.startsWith("1789160000\t840000\t")).toBe(true);
  });
});

describe("the workflow runs it on the artifact it just built", () => {
  const wf = readFileSync(publicPath("github/workflows/build.yml"), "utf8");

  it("serves a mailbox and measures the app against it, once", () => {
    // The CALLS, counted through the invocation and not through the bare path: the comment above
    // the steps names the script too, and a loose count of it is a pin that moves when somebody
    // explains the check.
    /* Four: the sampler and the verdict here, and the boot-only reading on macOS and Windows. */
    expect(wf.split("node scripts/perf-smoke-check.mjs").length - 1).toBe(4);
    expect(wf.split("node scripts/perf-smoke-check.mjs --boot --platform macos").length - 1).toBe(1);
    expect(wf.split("node scripts/perf-smoke-check.mjs --boot --platform windows").length - 1).toBe(1);
    expect(wf).toContain("--samples perf-smoke/samples.tsv");
    // The extracted binary: the AppImage's payload is compressed and carries none of the names.
    expect(wf).toContain("--bundle perf-smoke/squashfs-root/usr/bin/ohmail");
    /* The x86_64 job only, and deliberately: the arm64 job builds on a second runner for a second
     * architecture, and one measurement of the app's cost is the subject here. A copy into that
     * job is a decision somebody takes, not a paste that happens. */
    expect(wf.split("name: Serve a five-thousand-message mailbox").length - 1).toBe(1);
  });

  it("asserts its tools by name before it starts anything", () => {
    const lines = wf.split("\n");
    const guards = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes("for t in Xvfb xwininfo docker node; do") || l.includes("for t in docker node; do"));
    expect(guards, "the perf smoke starts something without asserting its tools").toHaveLength(2);
    for (const { i } of guards) {
      expect(lines.slice(i, i + 3).join("\n")).toMatch(/command -v "\$t".*is not installed/s);
    }
  });

  it("reports the check's own status rather than the shell's", () => {
    /* The same rule as the launch check beside it: under `set -e` a red exits the step before its
     * status is read. `tee` puts the verdict in an artifact, which makes the status the PIPE's —
     * so it is taken from PIPESTATUS on the line after, never from `$?`. */
    const lines = wf.split("\n");
    const call = lines.findIndex((l) => l.includes("--fixture-messages") && l.includes("tee perf-smoke/verdict.txt"));
    expect(call, "no piped call to the perf check").toBeGreaterThan(0);
    expect(lines[call + 1]).toMatch(/RC="\$\{PIPESTATUS\[0\]\}"/);
    // The nearest toggle above the call is `set +e`, however long the setup between them grows.
    const toggle = lines.slice(0, call).reverse().find((l) => /^\s*set [+-]e$/.test(l));
    expect(toggle?.trim()).toBe("set +e");
    expect(lines.slice(call, call + 6).join("\n")).toMatch(/^\s*set -e$/m);
  });

  it("fails the build on a RED whatever else is set, and only gates the refusal", () => {
    /* A claims guard for a half-landed rig: the two conditions are independent, and the day a run
     * produces a verdict the second one moves in a commit of its own. A RED is never gated.
     * The two now sit in the step's `case` over the codes it admits — the shape that stops every
     * OTHER code finishing the job green — so they are read as the branches they became. */
    expect(wf).toMatch(/\n\s*1\) exit 1 ;;/);
    expect(wf).toMatch(/\n\s*3\)[\s\S]{0,120}?if \[ "\$PERF_SMOKE_REQUIRED" = "1" \]; then exit 1; fi/);
    const declared = /PERF_SMOKE_REQUIRED: "(\d)"/.exec(wf);
    expect(declared, "PERF_SMOKE_REQUIRED is not declared in the workflow").not.toBeNull();
    /* THE PIN, moved to "1" on 2026-09-24 in the commit that gave the engine its key on a runner:
     * at "0" every refusal was forgiven, and eleven days of green runs measured an engine that
     * never started. A refusal now fails the step like a RED. */
    expect(declared?.[1]).toBe("1");
  });

  it("extracts the artifact rather than assuming the runner can mount it", () => {
    // The same reason the launch check gives: an AppImage self-mounts through FUSE, and a runner
    // image without it could not start the artifact at all.
    expect(wf.split("APPIMAGE_EXTRACT_AND_RUN=1").length - 1).toBe(3);
  });

  /** The two perf steps' own `run:` bodies, dedented, GitHub expressions neutralised. */
  function perfRunBlocks(): Array<{ step: string; body: string }> {
    const lines = wf.split("\n");
    const out: Array<{ step: string; body: string }> = [];
    let step = "(before any step)";
    for (let i = 0; i < lines.length; i++) {
      const nameM = /^\s*-?\s*name:\s*(.+)$/.exec(lines[i]!);
      if (nameM) step = nameM[1]!.trim();
      const runM = /^(\s*)run:\s*\|\s*$/.exec(lines[i]!);
      if (!runM || !/mailbox/.test(step)) continue;
      const indent = runM[1]!.length + 2;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() !== "" && l.length - l.trimStart().length < indent) break;
        body.push(l.length >= indent ? l.slice(indent) : "");
      }
      out.push({ step, body: body.join("\n").replace(/\$\{\{[^}]*\}\}/g, "X") });
      i = j - 1;
    }
    return out;
  }

  it("parses as shell, which a block scalar's indentation alone does not prove", () => {
    /* These two bodies are hand-indented inside a YAML block scalar and carry a nested heredoc, a
     * `sed` over their own indentation and several `|| { …; }` guards. A syntax error in either is
     * a step that fails for a reason that is not the app — so both are parsed here, the same way
     * the promotion workflow's gate parses its own. */
    const blocks = perfRunBlocks();
    expect(blocks, "the two perf steps' run blocks were not found").toHaveLength(2);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-perf-wf-"));
    const broken: string[] = [];
    for (const [n, b] of blocks.entries()) {
      const f = join(dir, `block-${n}.sh`);
      writeFileSync(f, b.body);
      try {
        execFileSync("bash", ["-n", f], { stdio: "pipe" });
      } catch (err) {
        broken.push(`${b.step}: ${String((err as { stderr?: Buffer }).stderr ?? "").trim()}`);
      }
    }
    expect(broken, broken.join("\n")).toHaveLength(0);
  });

  it("asserts the artifact and the display, not only the tools", () => {
    /* Three inputs start nothing when they are absent, and only one of them was named. Without the
     * bundle or without a display the app never opens, and the check downstream then refuses with
     * "the app wrote no log" — which reads as a verdict about the APP for a failure of the rig. */
    expect(wf).toContain('[ -f build/ohmail-linux-x86_64.AppImage ] || { echo "perf smoke: no artifact');
    expect(wf).toContain('[ "$X_UP" = "1" ] || { echo "perf smoke: no X display on :98');
  });

  it("takes a display the launch check cannot be holding, and pins the app's own data root", () => {
    /* :99 is the launch check's, and it kills its server as that step's last line — a step boundary
     * does not wait for the kill, so a second server there is a race this step cannot see. And the
     * app resolves BOTH `config.json` and the log through XDG_DATA_HOME: left to the runner, the
     * step would write the door in one place and the app would look in another. */
    const from = wf.indexOf("name: The packaged app's start and memory on that mailbox");
    const to = wf.indexOf("name: Keep the perf smoke's own files", from);
    expect(from, "the measuring step was not found").toBeGreaterThan(0);
    expect(to, "the artifact step after it was not found").toBeGreaterThan(from);
    const step = wf.slice(from, to);
    /* The SHELL only. The comment above the display says ":99" to explain why this step does not
     * use it, and a guard that read the prose would refuse the explanation of its own rule. */
    const shell = step.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(shell, "the measuring step shares :99 with the launch check").not.toMatch(/:99\b/);
    expect(shell).toMatch(/DISPLAY=:98\b/);
    expect(shell).toContain('XDG_DATA_HOME="$HOME_DIR/.local/share"');
  });

  it("reaches the mail server over the loopback, which is what lets it be plain", () => {
    /* The app's transport floor exempts the loopback range and nothing else, so a fixture server
     * on 127.0.0.1 needs no certificate — and a fixture on any other address would be refused
     * before authentication, which is a rig failure wearing a product refusal's clothes. */
    expect(wf).toContain('"host":"127.0.0.1"');
    expect(wf).toContain("-p 127.0.0.1:11143:143");
    expect(wf).not.toMatch(/insecureConsent|allowInsecure/);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE STEP THAT RUNS THIS CHECKER MUST FAIL WHEN THE CHECKER FAILS TO RUN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The workflow step read the checker's exit code and acted on 1 and 3 — then `exit 0`. Every other
 * code finished the job GREEN: a usage error (2), a missing checker (127), a crash. That is the
 * "a step whose failure does not fail the job" class, and the build ships with no measurement
 * behind it while the page says the smoke ran.
 *
 * The DECISION is read out of the workflow's own text and driven here for each code, so a step that
 * goes back to swallowing them is red without a CI run.
 */
describe("the workflow step admits the checker's codes by name", () => {
  const WORKFLOW = resolve(dirname(fileURLToPath(import.meta.url)), "..",
    publicRel("github/workflows/build.yml"));

  /** The step's decision block, dedented out of the YAML: from the admitted-codes comment to its `exit 0`. */
  function decisionBlock(): string {
    const text = readFileSync(WORKFLOW, "utf8");
    const start = text.indexOf("          # EVERY CODE THIS STEP ADMITS");
    expect(start, "the step no longer names the codes it admits").toBeGreaterThan(0);
    const end = text.indexOf("\n          exit 0", start);
    expect(end, "the decision block has no closing exit 0").toBeGreaterThan(start);
    return `${text.slice(start, end)}\n          exit 0\n`
      .split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  }

  const runWith = (rc: string, required = "0") => {
    const W = mkdtempSync(join(tmpdir(), "perf-step-"));
    const f = join(W, "decide.sh");
    writeFileSync(f, `#!/bin/bash\nset -u\nRC="${rc}"\nPERF_SMOKE_REQUIRED="${required}"\n${decisionBlock()}`);
    const r = spawnSync("bash", [f], { encoding: "utf8" });
    rmSync(W, { recursive: true, force: true });
    return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  it("passes a verdict inside every budget", () => {
    expect(runWith("0").rc).toBe(0);
  });

  it("admits a CLASSIFY-ASK RUNNER as a warning, never a silent green and never a bare red", () => {
    const ask = runWith("5", "1");
    expect(ask.rc, ask.out).toBe(0);
    expect(ask.out).toContain("::warning title=perf smoke CLASSIFY-ASK RUNNER::");
  });

  it("fails a verdict over a budget", () => {
    expect(runWith("1").rc).toBe(1);
  });

  it("admits a refusal while the rig is not yet required, and fails it once it is", () => {
    const soft = runWith("3");
    expect(soft.rc).toBe(0);
    expect(soft.out).toContain("PERF_SMOKE_REQUIRED");
    expect(runWith("3", "1").rc).toBe(1);
  });

  /**
   * THE MEASURED CLASS. A checker that exits 2 — a usage error, the shape a renamed flag produces —
   * used to finish the job green. So did 127, which is the checker not being there at all.
   */
  it("fails on a code it does not admit, naming it", () => {
    for (const rc of ["2", "4", "127"]) {
      const r = runWith(rc);
      expect(r.rc, `exit ${rc} finished the job green`).toBe(1);
      expect(r.out).toContain(`the checker exited ${rc}`);
    }
  });
});


/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE TIMING CEILINGS COME FROM A DISTRIBUTION, AND A SLOW RUNNER IS A QUESTION
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The 4 000 ms engine line was set from one reading and sat under the release runs' own median, so
 * two hotfixes went red on runner speed alone. The ceilings are now derived from the readings the
 * published build logged; over a ceiling on a slower runner, inside the band, is CLASSIFY-ASK
 * RUNNER (rc 5), and outside it RED. On Linux the runner is the store's own open time.
 */
/* Run 241 attempt 1 (the 0.25.7 candidate's first red), its boot line as the runner logged it. */
const RUN_241_BOOT = '{"ts":"2026-10-01T09:22:31.000Z","level":"info","service":"sidecar","event":"boot_phases","pgliteOpenMs":3603,"adoptBaselineMs":277,"migrateMs":1996,"compactMs":10,"searchSetupMs":146,"migrationsPending":140,"migrationsApplied":140,"slowestMigration":null,"slowestMs":null,"worldMs":40,"totalReadyMs":6127}';

describe("the timing ceilings are derived from the readings, never typed", () => {
  const T = check.TIMING_READINGS as Record<string, { columns: string[]; rows: number[][] }>;
  const P = check.PLATFORM_TIMING as Record<string, any>;
  /* The rule restated here by hand, so a change to the derivation is a change to this file too. */
  const byHand = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const i = (s.length - 1) * 0.95;
    const p95 = s[Math.floor(i)]! + (s[Math.ceil(i)]! - s[Math.floor(i)]!) * (i - Math.floor(i));
    return Math.ceil((p95 * 1.1) / 100) * 100;
  };
  const col = (platform: string, name: string) =>
    T[platform]!.rows.map((r) => r[T[platform]!.columns.indexOf(name)]!);

  it("holds every row to its columns, inside the release window it names", () => {
    for (const [platform, t] of Object.entries(T)) {
      for (const row of t.rows) {
        expect(row, `${platform} row ${row.join(",")}`).toHaveLength(t.columns.length);
        expect(row[0]!, `${platform} run ${row[0]} is outside runs 231-242 (0.25.0-0.25.8)`).toBeGreaterThanOrEqual(231);
        expect(row[0]!).toBeLessThanOrEqual(242);
      }
    }
    expect(T.linux_x64!.rows.length).toBeGreaterThanOrEqual(5);
    const later = (T.linux_x64 as unknown as { laterRows: number[][] }).laterRows;
    expect(later.map((r) => r[0])).toEqual([243, 244, 245]);
    for (const row of later) expect(row).toHaveLength(T.linux_x64!.columns.length);
    expect(T.macos!.rows.length).toBeGreaterThanOrEqual(5);
  });

  it("derives each ceiling as the p95 plus ten per cent, rounded up to 100 ms", () => {
    expect(check.BUDGETS.engineReadyMs).toBe(byHand(col("linux_x64", "totalReadyMs")));
    expect(check.BUDGETS.startToListMs).toBe(byHand(col("linux_x64", "listUsableMs")));
    expect(P.macos.engine_ready.ceilingMs).toBe(byHand(col("macos", "totalReadyMs")));
    /* The readings measured on 2026-10-02, so a silent change of rule or data is seen. */
    expect([check.BUDGETS.engineReadyMs, check.BUDGETS.startToListMs, P.macos.engine_ready.ceilingMs]).toEqual([5900, 9900, 3900]);
    expect(P.linux_x64.runnerReferenceS).toBe(594);
  });

  it("gives the store's open its own ceiling over all 18 readings, and its median over the 15", () => {
    const later = (T.linux_x64 as unknown as { laterRows: number[][] }).laterRows;
    const at = T.linux_x64!.columns.indexOf("pgliteOpenMs");
    expect(P.linux_x64.pglite_open.ceilingMs).toBe(byHand([...col("linux_x64", "pgliteOpenMs"), ...later.map((r) => r[at]!)]));
    expect(P.linux_x64.pglite_open.n).toBe(18);
    expect([P.linux_x64.pglite_open.ceilingMs, P.linux_x64.pgliteReferenceMs]).toEqual([3700, 2456]);
    expect(P.linux_x64.store).toEqual({ pglite: "0.2.17", extensions: ["btree_gin", "pg_trgm"] });
  });

  it("gives a platform with too few readings no ceiling at all, rather than a guess", () => {
    expect(P.windows.engine_ready.ceilingMs).toBeNull();
    expect(P.windows.engine_ready.why).toContain("0 of the 5 readings");
    expect(check.ceilingFrom([1000, 2000, 3000, 4000]).ceilingMs).toBeNull();
    expect(check.ceilingFrom([1000, 2000, 3000, 4000, 5000]).ceilingMs).toBe(5300);
  });
});

describe("a timing reading over its ceiling is judged against the runner band", () => {
  const ceiling = 5900;
  const ref = 594;
  const v = (readingMs: number, runnerS: number | null) =>
    check.timingVerdict({ readingMs, ceilingMs: ceiling, runnerS, runnerReferenceS: ref });

  it("passes at the ceiling and fails one over it when the runner is unread", () => {
    expect(v(ceiling, null).status).toBe("PASS");
    expect(v(ceiling + 1, null).status).toBe("FAIL");
  });

  it("asks when a slower runner accounts for it, and fails past the band", () => {
    const slow = Math.round(ref * 1.2);
    expect(v(ceiling + 1, slow).status).toBe("CLASSIFY");
    expect(v(Math.ceil(ceiling * slow / ref), slow).status).toBe("CLASSIFY");
    expect(v(Math.ceil(ceiling * slow / ref) + 1, slow).status).toBe("FAIL");
  });

  it("fails on a runner at or faster than its median: a slow product on a fast machine", () => {
    expect(v(ceiling + 1, ref).status).toBe("FAIL");
    expect(v(ceiling + 1, ref - 100).status).toBe("FAIL");
    /* Named as that, not as "over the band": the band is never asked of a runner this fast. */
    expect(v(ceiling + 1, ref).why).toBe("the runner was not slower than its median");
  });

  it("caps the band, so a broken runner cannot hide a doubled boot", () => {
    expect(v(Math.ceil(ceiling * 1.5), ref * 3).status).toBe("CLASSIFY");
    expect(v(Math.ceil(ceiling * 1.5) + 1, ref * 3).status).toBe("FAIL");
  });
});

describe("the verdict over planted runs", () => {
  const L = check.PLATFORM_TIMING.linux_x64 as Record<string, any>;
  const pg = L.pgliteReferenceMs as number;
  const at = (ms: number, pgliteMs: number, over: Record<string, unknown> = {}) =>
    run({ log: check.bootLog(ms, pgliteMs), runnerS: L.runnerReferenceS, storeIdentity: L.store, ...over });

  it("reads a normal run GREEN, and prints the runner beside it", () => {
    const out = at(check.BUDGETS.engineReadyMs - 500, pg);
    expect(out.code, verdict(out)).toBe(0);
    expect(verdict(out)).toMatch(/^PERF_SMOKE: GREEN -- .* · runner: pglite open 2456 ms against its median 2456 ms \(x1\.00\) · build step 594 s against its median 594 s \(x1\.00\), recorded$/);
  });

  it("reads a planted slow runner CLASSIFY-ASK RUNNER, with the numbers", () => {
    const out = at(check.BUDGETS.engineReadyMs + 300, Math.round(pg * 1.2));
    expect(out.code, verdict(out)).toBe(5);
    expect(verdict(out)).toContain("PERF_SMOKE: CLASSIFY-ASK RUNNER -- engine_ready 6200 ms against 5900 ms, inside the runner band of 7080 ms (pglite open x1.20)");
    expect(verdict(out)).toContain("runner: pglite open 2947 ms against its median 2456 ms (x1.20)");
  });

  it("reads a planted product regression RED, on a median runner and on a slow one", () => {
    for (const pgliteMs of [pg, Math.round(pg * 1.2)]) {
      const out = at(check.BUDGETS.engineReadyMs * 2, pgliteMs);
      expect(out.code, verdict(out)).toBe(1);
      expect(verdict(out)).toMatch(/^PERF_SMOKE: RED -- engine_ready /);
    }
  });

  it("leaves the memory arms alone: a slow runner never softens them", () => {
    const fat = check.bootLog(1850, Math.round(pg * 1.4)).replace('"rss":314572800', '"rss":629145600');
    const out = run({ log: fat, storeIdentity: L.store });
    expect(out.code, verdict(out)).toBe(1);
    expect(verdict(out)).toContain("engine_rss");
    const heavy = check.withinBudgetSample().replace(/renderer=\d+/g, "renderer=1500000");
    const both = at(check.BUDGETS.engineReadyMs + 300, Math.round(pg * 1.4), { samples: heavy });
    expect(both.code, verdict(both)).toBe(1);
    expect(verdict(both)).toContain("renderer_peak");
  });

  it("reads start_to_list through the same band", () => {
    const list = uiLine({ listUsableMs: check.BUDGETS.startToListMs + 200 });
    expect(run({ log: `${check.bootLog(1850, Math.round(pg * 1.2))}\n${list}`, uiInBundle: true, storeIdentity: L.store }).code).toBe(5);
    expect(run({ log: `${check.bootLog(1850, pg)}\n${list}`, uiInBundle: true, storeIdentity: L.store }).code).toBe(1);
  });

  it("widens nothing for a store it did not read, and says why", () => {
    const out = at(check.BUDGETS.engineReadyMs + 300, Math.round(pg * 1.2), { storeIdentity: null });
    expect(out.code, verdict(out)).toBe(1);
    expect(out.text).toContain("the shipped store was not read (no --engine-dir and no --bundle)");
    expect(out.text).toMatch(/pglite_open +RECORDED +READ +2947 ms against 3700 ms, the shipped store unread/);
  });

  it("names the phase over its own p95 when the boot is over its ceiling", () => {
    const log = OK_LOG.split("\n").filter((l) => !l.includes('"boot_phases"')).concat(RUN_241_BOOT).join("\n");
    const text = run({ log, runnerS: 617 }).text;
    expect(text).toContain("phases ms: pgliteOpen 3603 (p95 3361) · adoptBaseline 277 (p95 222) · migrate 1996 (p95 1673)");
    expect(text).toContain("unattributed 55 — over their p95: pgliteOpen, adoptBaseline, migrate");
    /* Inside the ceiling the phases are printed and nothing is judged. */
    expect(run().text).toMatch(/phases ms: pgliteOpen 120 · migrate 40 · unattributed 1690\n/);
  });
});

/*
 * THE RULED CONTROLS, over the recorded readings:
 * pglite's bytes were identical across 0.25.9-0.25.11 while its open rose markedly with the
 * boot, so the store's open is the runner's reading and the build step's seconds are not.
 */
describe("the store's open time is the Linux runner's reading", () => {
  const L = check.PLATFORM_TIMING.linux_x64 as Record<string, any>;
  const recorded = (runNo: number, attempt: number, over: Record<string, unknown> = {}) => {
    const r = check.recordedLog(runNo, attempt);
    return run({ log: r.log, uiInBundle: true, runnerS: r.runnerS, storeIdentity: L.store, ...over });
  };

  it("reads 0.25.7's first red (run 241/1) CLASSIFY-ASK RUNNER", () => {
    const out = recorded(241, 1);
    expect(out.code, verdict(out)).toBe(5);
    expect(verdict(out)).toContain("engine_ready 6127 ms against 5900 ms, inside the runner band of 8656 ms (pglite open x1.47)");
  });

  it("reads 0.25.11 (run 245/1) GREEN", () => {
    const out = recorded(245, 1);
    expect(out.code, verdict(out)).toBe(0);
    expect(out.text).toMatch(/start_to_list +DECIDES +PASS +9546 ms/);
  });

  it("reads a planted x1.5 start_to_list at the median store open RED", () => {
    const r = check.recordedLog(245, 1);
    const log = r.log.replace('"pgliteOpenMs":2954', `"pgliteOpenMs":${L.pgliteReferenceMs}`)
      .replace('"listUsableMs":9546', `"listUsableMs":${Math.round(9546 * 1.5)}`);
    const out = run({ log, uiInBundle: true, runnerS: r.runnerS, storeIdentity: L.store });
    expect(out.code, verdict(out)).toBe(1);
    expect(verdict(out)).toMatch(/^PERF_SMOKE: RED -- start_to_list /);
  });

  it("reads a planted slower store open RED through its own ceiling, where the band alone would ask", () => {
    const r = check.recordedLog(241, 1);
    const pgliteMs = L.pglite_open.ceilingMs + 1200;
    const log = r.log.replace('"pgliteOpenMs":3603', `"pgliteOpenMs":${pgliteMs}`)
      .replace('"totalReadyMs":6127', `"totalReadyMs":${6127 - 3603 + pgliteMs}`);
    const out = run({ log, uiInBundle: true, runnerS: r.runnerS, storeIdentity: L.store });
    expect(out.code, verdict(out)).toBe(1);
    expect(verdict(out)).toMatch(/^PERF_SMOKE: RED -- pglite_open ·/);
    expect(out.text).toMatch(/engine_ready +DECIDES +CLASSIFY/);
  });

  it("refuses the comparison by name for another pglite or another extension set", () => {
    for (const store of [{ ...L.store, pglite: "0.3.0" }, { ...L.store, extensions: ["btree_gin", "pg_trgm", "vector"] }]) {
      const out = recorded(241, 1, { storeIdentity: store });
      expect(out.code, verdict(out)).toBe(1);
      expect(verdict(out)).toMatch(/^PERF_SMOKE: RED -- engine_ready pglite_open ·/);
      expect(out.text).toContain(`the readings were taken on pglite 0.2.17 with btree_gin, pg_trgm; retake TIMING_READINGS`);
    }
  });

  it("keeps the build step as the arm that gets 0.25.10 against 0.25.11 wrong", () => {
    const r10 = check.recordedLog(244, 1).row, r11 = check.recordedLog(245, 1).row;
    expect(r11.listUsableMs).toBeGreaterThan(r10.listUsableMs);
    expect(r11.totalReadyMs).toBeGreaterThan(r10.totalReadyMs);
    const step = (row: Record<string, number>) => row.buildStepS! / L.runnerReferenceS;
    const store = (row: Record<string, number>) => check.storeAllowance(row.pgliteOpenMs, L.store, L).factor as number;
    /* The slower run had the slower runner: the store says so, the build step says the opposite. */
    expect(store(r11)).toBeGreaterThan(store(r10));
    expect(step(r11)).toBeLessThan(step(r10));
  });
});

describe("the shipped store is read from the engine beside the app", () => {
  const script = resolve(HERE, "..", "scripts/perf-smoke-check.mjs");
  const engine = (dir: string, version: string | null, specifiers: string[]) => {
    const bin = join(dir, "usr", "lib", "ohmail", "engine", "bin");
    mkdirSync(join(bin, "node_modules", "@electric-sql", "pglite"), { recursive: true });
    mkdirSync(join(dir, "usr", "bin"), { recursive: true });
    if (version !== null) writeFileSync(join(bin, "node_modules", "@electric-sql", "pglite", "package.json"), JSON.stringify({ version }));
    writeFileSync(join(bin, "ohmail-engine.mjs"), specifiers.map((x) => `import "${x}";`).join("\n"));
    return bin;
  };

  it("reads the version and the contrib set, and names what it could not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-store-"));
    const bin = engine(dir, "0.2.17", ["@electric-sql/pglite", "@electric-sql/pglite/contrib/pg_trgm", "@electric-sql/pglite/contrib/btree_gin", "@electric-sql/pglite/contrib/pg_trgm"]);
    const read = check.readStoreIdentity(bin);
    const bare = check.readStoreIdentity(engine(mkdtempSync(join(tmpdir(), "perf-store-")), null, []));
    rmSync(dir, { recursive: true, force: true });
    expect(read).toEqual({ pglite: "0.2.17", extensions: ["btree_gin", "pg_trgm"] });
    expect(check.storeRefusal(read, check.PLATFORM_TIMING.linux_x64.store)).toBeNull();
    expect(bare.unread).toContain("no pglite package at");
  });

  it("finds the engine from the AppImage's --bundle on the command line, and reddens on another pglite", () => {
    const cli = (version: string) => {
      const dir = mkdtempSync(join(tmpdir(), "perf-store-cli-"));
      engine(dir, version, ["@electric-sql/pglite/contrib/btree_gin", "@electric-sql/pglite/contrib/pg_trgm"]);
      writeFileSync(join(dir, "usr", "bin", "ohmail"), "");
      const r = check.recordedLog(241, 1);
      writeFileSync(join(dir, "samples.tsv"), check.withinBudgetSample());
      writeFileSync(join(dir, "engine.log"), r.log);
      const out = spawnSync(process.execPath, [script, "--samples", join(dir, "samples.tsv"), "--engine-log", join(dir, "engine.log"),
        "--bundle", join(dir, "usr", "bin", "ohmail"), "--expect-messages", "10000", "--runner-s", String(r.runnerS)], { encoding: "utf8" });
      rmSync(dir, { recursive: true, force: true });
      return out;
    };
    const same = cli("0.2.17");
    expect(same.stdout).toContain("pglite open 3603 ms against its median 2456 ms (x1.47)");
    const other = cli("0.2.18");
    expect(other.status, other.stdout).toBe(1);
    expect(other.stdout).toContain("the shipped store is pglite 0.2.18 with btree_gin, pg_trgm and the readings were taken on pglite 0.2.17");
  });

  it("is handed that --bundle by the workflow, so the engine sits where the check looks", () => {
    const wf = readFileSync(publicPath("github/workflows/build.yml"), "utf8");
    expect(wf).toContain("--bundle perf-smoke/squashfs-root/usr/bin/ohmail \\");
  });

  it("extracts the whole AppImage beside that binary and reads the store there, so the store-open arm is never blind", () => {
    /* 0.25.13's first CI run extracted usr/bin/ohmail alone: the engine dir the arm derives did not exist, the
     * arm read "the shipped store is unread", the Linux job went red and its installers were not uploaded. */
    const wf = readFileSync(publicPath("github/workflows/build.yml"), "utf8");
    const step = wf.slice(wf.indexOf("name: The packaged app's start and memory on that mailbox"));
    const before = step.slice(0, step.indexOf("--bundle perf-smoke/squashfs-root/usr/bin/ohmail"));
    expect(before).toContain("../build/ohmail-linux-x86_64.AppImage --appimage-extract > /dev/null)");
    expect(before).not.toContain("--appimage-extract usr/bin/ohmail");
    expect(before).toContain("perf-smoke/squashfs-root/usr/lib/ohmail/engine/bin/node_modules/@electric-sql/pglite/package.json");
    expect(before).toContain('readStoreIdentity("perf-smoke/squashfs-root/usr/lib/ohmail/engine/bin")');
    expect(before).toContain("if (s.unread) process.exit(1)");
  });
});

describe("the boot alone, on the jobs that start the engine without the app", () => {
  const P = check.PLATFORM_TIMING as Record<string, any>;
  const boot = (platform: string, ms: number, runnerS: number | null = null) =>
    check.render(check.collectBoot({ log: check.bootLog(ms), platform, runnerS }));
  const last = (out: { text: string }) => out.text.split("\n").filter((l) => l.startsWith("PERF_SMOKE_BOOT:")).pop();

  it("holds macOS to its own distribution both ways", () => {
    const c = P.macos.engine_ready.ceilingMs;
    expect(boot("macos", c, P.macos.runnerReferenceS).code).toBe(0);
    const red = boot("macos", c * 2, P.macos.runnerReferenceS);
    expect(red.code).toBe(1);
    expect(last(red)).toMatch(/^PERF_SMOKE_BOOT: RED -- engine_ready/);
    expect(boot("macos", c + 100, Math.round(P.macos.runnerReferenceS * 1.3)).code).toBe(5);
  });

  it("records Windows, which has no distribution yet, and says so", () => {
    const out = boot("windows", 9000);
    expect(out.code).toBe(0);
    expect(last(out)).toContain("PERF_SMOKE_BOOT: RECORDED -- engine_ready 9000 ms on windows, no ceiling yet");
  });

  it("refuses a log with no boot line, and a platform it does not know", () => {
    const none = check.render(check.collectBoot({ log: OK_LOG.replace(/.*boot_phases.*\n/, ""), platform: "macos" }));
    expect(none.code).toBe(3);
    expect(check.render(check.collectBoot({ log: OK_LOG, platform: "plan9" })).code).toBe(3);
  });

  it("runs from the command line, and an empty --runner-s is an unread runner", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-boot-"));
    const f = join(dir, "err");
    writeFileSync(f, check.bootLog(P.macos.engine_ready.ceilingMs + 100));
    const script = resolve(HERE, "..", "scripts/perf-smoke-check.mjs");
    const cli = (runner: string) =>
      spawnSync(process.execPath, [script, "--boot", "--platform", "macos", "--engine-log", f, "--runner-s", runner], { encoding: "utf8" });
    const empty = cli("");
    const slow = cli(String(Math.round(P.macos.runnerReferenceS * 1.3)));
    rmSync(dir, { recursive: true, force: true });
    expect(empty.status, empty.stdout).toBe(1);
    expect(empty.stdout).toContain("runner: build step unread");
    expect(slow.status, slow.stdout).toBe(5);
  });
});

describe("the workflow takes the runner's reading where the ceilings were measured", () => {
  const wf = readFileSync(publicPath("github/workflows/build.yml"), "utf8");
  const START = 'run: echo "OHMAIL_BUILD_STEP_T0=$(date +%s)" >> "$GITHUB_ENV"';

  it("notes the build step's seconds around each measured platform's build", () => {
    for (const bundles of ["--bundles app,dmg", "--bundles nsis", "--bundles appimage,deb,rpm -- -- --locked\n\n      - name: Note"]) {
      const at = wf.indexOf(`npm run app:build:engine -- ${bundles}`);
      expect(at, `no build step for ${bundles}`).toBeGreaterThan(0);
      const before = wf.lastIndexOf(START, at);
      expect(before, `no start noted before ${bundles}`).toBeGreaterThan(wf.lastIndexOf("run: npm run app:build:engine", at - "run: ".length - 1));
      expect(wf.indexOf("OHMAIL_BUILD_STEP_S=", at) - at, `no end noted after ${bundles}`).toBeLessThan(400);
    }
    expect(wf).toContain('--runner-s "${OHMAIL_BUILD_STEP_S:-}" \\\n            --fixture-messages');
  });

  it("writes Windows' boot line where its check reads it", () => {
    expect(wf).toContain("OHMAIL_BOOT_LOG: ${{ runner.temp }}/engine-boot.log");
    expect(wf).toContain('--engine-log "${{ runner.temp }}/engine-boot.log"');
  });

  /** A boot check's decision, out of the step, driven per code. */
  const bootDecision = (platform: string, rc: string) => {
    const call = wf.indexOf(`node scripts/perf-smoke-check.mjs --boot --platform ${platform}`);
    const a = wf.indexOf("          set -e\n", call);
    const b = wf.indexOf("          esac\n", a) + "          esac\n".length;
    const body = wf.slice(a, b).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
    const dir = mkdtempSync(join(tmpdir(), "perf-boot-step-"));
    const f = join(dir, "d.sh");
    writeFileSync(f, `#!/bin/bash\nRC=${rc}\n${body}\nexit 0\n`);
    const r = spawnSync("bash", [f], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    return { rc: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("fails a boot red or refusal, warns on a question, and passes a green", () => {
    for (const platform of ["macos", "windows"]) {
      expect(bootDecision(platform, "0").rc).toBe(0);
      const ask = bootDecision(platform, "5");
      expect(ask.rc).toBe(0);
      expect(ask.out).toContain("::warning title=engine boot CLASSIFY-ASK RUNNER::");
      for (const rc of ["1", "3", "2", "127"]) expect(bootDecision(platform, rc).rc, `${platform} rc ${rc}`).toBe(1);
    }
  });
});
