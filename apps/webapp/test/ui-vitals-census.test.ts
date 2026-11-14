import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellFrameOf, sliceOfDeclaration } from "./source-anchor";
import {
  INTERACTION_TIMEOUT_MS,
  LONG_FRAME_MS,
  LONG_TASK_MS,
  REPORT_EVERY_MS,
  REPORT_MAX_MS,
  REPORT_MIN_MS,
  takeUiVitals,
} from "@ohmail/app-logic/session/ui-vitals";
import * as check from "../../../scripts/perf-smoke-check.mjs";

/**
 * ═══ THE INSTRUMENT IS WIRED TO THE THINGS IT MEASURES ═══════════════════════════════════════
 *
 * `ui-vitals.test.ts` proves the rings, the percentiles and the frame rule by driving them. What
 * it cannot show is that anything CALLS them: a ring nothing writes into reports `null` for ever,
 * which is indistinguishable from a quiet app — the exact failure mode this whole instrument
 * exists because of (`engine_vitals` stayed flat through a heavy session because it was pointed
 * at the wrong process).
 *
 * So this census reads the call sites as source and asserts the CALL, inside the declaration that
 * owns it — never a bare mention of the name, which a comment or an import satisfies.
 *
 * And the last case is the wire format's third home: the desktop shell composes the log line from
 * its OWN list of field names (`vitals.rs`), so a field added here and not there would be dropped
 * silently on the one door where the line is read.
 */

const ROOT = resolve(process.cwd());

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** The call, not the name: `beginSwitch()` and never `beginSwitch` in a comment or an import. */
function callsIn(body: string, fn: string): number {
  return [...body.matchAll(new RegExp(`(?<![\\w.])${fn}\\s*\\(`, "g"))].length;
}

describe("every navigation starts the switch mark", () => {
  const routing = read("apps/webapp/app/shell/routing.ts");

  /* The six verbs the shell navigates through. A seventh added without its mark is a view whose
     switch is never timed — and the p95 would go on looking healthy because the slow view is the
     one missing from the ring. */
  for (const verb of ["go", "goTag", "goFolder", "goAddress", "goScreener", "goTriage"]) {
    it(`${verb} starts one`, () => {
      expect(callsIn(sliceOfDeclaration(routing, verb), "beginSwitch")).toBe(1);
    });

    /* The mark carries the view it is waiting FOR, spelled by the one derivation the shell ends
       it with. A verb that started a bare mark, or one keyed on a hash of its own, would leave a
       switch pending until the next press — recorded against the wrong view or not at all. */
    it(`${verb} names the view it is asking for`, () => {
      expect(sliceOfDeclaration(routing, verb)).toMatch(/beginSwitch\(switchKeyForHash\(/);
    });
  }

  it("reflectMessage starts the open mark, and closing a reading starts nothing", () => {
    const body = sliceOfDeclaration(routing, "reflectMessage");
    expect(callsIn(body, "beginOpen")).toBe(1);
    // The guard is what keeps a CLOSE (`messageId === null`) from opening a mark nothing ends.
    expect(body).toMatch(/messageId !== null && messageId !== route\.messageId/);
    // …and a close abandons the open in flight, which would otherwise expire as a timeout.
    expect(callsIn(body, "abandonOpen")).toBe(1);
    expect(body).toMatch(/else if \(messageId === null\) abandonOpen\(\)/);
  });
});

describe("the marks that end", () => {
  /**
   * THE SWITCH ENDS AT THE VIEW THE PRESS ASKED FOR. One call site, because the mark has one
   * owner: the shell knows both the route and whether the view it renders has anything of its own
   * on screen yet. The pair is what the reading IS — the key without the readiness ends a switch
   * on a spinner, the readiness without the key ends it on whatever committed last.
   */
  it("the shell ends the switch mark once, at the route it rendered", () => {
    /* The mark and its readiness table left `AppShell.tsx` for `shell-keys.tsx` (ARCH-022 L6),
       asked of the frame that declares `viewOnScreen` rather than of a path. ONCE still means
       once in the shell as a whole: a second call in the composition root would be a second
       owner, so both frames are counted. */
    const shell = shellFrameOf("viewOnScreen").source;
    const root = read("apps/webapp/app/shell/AppShell.tsx");
    expect(callsIn(shell, "useSwitchEnd") + callsIn(root, "useSwitchEnd")).toBe(1);
    expect(shell).toMatch(/useSwitchEnd\(viewOnScreen \? switchKeyOf\(route\) : null\)/);
  });

  /**
   * EVERY VIEW THE SHELL RENDERS ANSWERS THE READINESS QUESTION, or is one of the four whose
   * content arrives with the view itself. A list view added without an arm would fall through to
   * `true` and report its switch as over before its rows existed — the defect this lane corrected,
   * one view at a time.
   */
  it("every view the shell renders is named in the readiness table, or is pinned as its own content", () => {
    /* TWO FRAMES, and that is the point of the question since ARCH-022 L6: the table is in
       `shell-keys.tsx` with `viewOnScreen`, the view branches it must cover are the JSX that
       stayed in `AppShell.tsx`. While both were one file a branch and its arm matched out of the
       same text; now the claim really is that one file's table covers another file's renders. */
    const shell = shellFrameOf("viewOnScreen").source;
    const from = shell.indexOf("const viewOnScreen =");
    expect(from, "the readiness table could not be found").toBeGreaterThan(-1);
    const table = shell.slice(from, shell.indexOf("useSwitchEnd(", from));
    const rendered = new Set(
      [...read("apps/webapp/app/shell/AppShell.tsx").matchAll(/effectiveView === "([a-z]+)"/g)]
        .map((m) => m[1]!),
    );
    const answered = new Set([...table.matchAll(/effectiveView === "([a-z]+)"/g)].map((m) => m[1]!));
    const unanswered = [...rendered].filter((v) => !answered.has(v)).sort();
    /* Search's results are the SEARCH mark's subject; the other three have no list of their own.
       A fifth name here is a view whose switch ends before it has anything to show. */
    expect(unanswered).toEqual(["address", "compose", "search", "settings"]);
  });

  it("the message pane ends the open mark on a terminal body state", () => {
    const pane = read("apps/webapp/app/shell/MessagePane.tsx");
    expect(callsIn(pane, "endOpen")).toBe(1);
    // Not on `loading`/`snippet`: ending there would report the spinner as the mail.
    expect(pane).toMatch(/body\.state !== "snippet" && body\.state !== "loading"/);
  });

  it("the search view ends the search mark when its first results exist", () => {
    const view = read("apps/webapp/app/views/SearchView.tsx");
    expect(callsIn(view, "endSearch")).toBe(1);
  });
});

describe("the startup marks", () => {
  it("the shell mounts the instrument and marks a usable list", () => {
    const shell = read("apps/webapp/app/shell/AppShell.tsx");
    expect(callsIn(shell, "useUiVitals")).toBe(1);
    expect(shell).toMatch(/markStartup\("listUsable"\)/);
    expect(callsIn(shell, "beginSearch")).toBe(1);
  });

  /**
   * THE MARK IS MAIL ON SCREEN, NOT A COMPLETED DRAIN. Keyed on `syncStatus.bootstrapping` it read
   * seconds on a settled large mailbox whose rows were up far sooner, and seconds again on
   * the 0.19.0 runs with an import still in flight — the server's pace reported as the reader's
   * wait. The needle is the CONDITION, not a comment: reword the docblock and this still holds.
   */
  it("marks a usable list from the mirror's own rows and not from the sync posture", () => {
    const shell = read("apps/webapp/app/shell/AppShell.tsx");
    const at = shell.indexOf('markStartup("listUsable")');
    expect(at, "the mark must exist to be judged").toBeGreaterThan(-1);
    const line = shell.slice(shell.lastIndexOf("\n", at) + 1, shell.indexOf("\n", at));
    expect(line).toMatch(/pulled > 0/);
    expect(line).toMatch(/settled/);
    expect(line, "a drain is the server's pace, not the wait a reader sits through")
      .not.toMatch(/bootstrapping/);
  });

  it("the engine provider marks the engine ready", () => {
    expect(read("apps/webapp/app/shell/engine.tsx")).toMatch(/markStartup\("engineReady"\)/);
  });

  it("the desktop sends its reports to the shell process, armed before the first render", () => {
    const main = read("apps/desktop/src/main.tsx");
    expect(main).toMatch(/setUiVitalsSink\(/);
    expect(main).toMatch(/reportUiVitals\(report\)/);
    // …and takes the cadence back off the same call: the knob lives in the shell, which is the
    // only half of this app with an environment to read.
    expect(main).toMatch(/\.then\(setUiVitalsInterval\)/);
  });
});

describe("the report's vocabulary has the same four homes", () => {
  /**
   * The keys the shell composes, the names the desktop's Rust reads, the log line it writes — and
   * the CI performance check that reads that line back. A field on one side and not the other is a
   * number measured and thrown away, and the fourth home is where it was measured going wrong: the
   * check read `startToListMs`, `openMs`, `frameGapMs` and `longTaskMs` under `"service":"shell"`,
   * none of which this report has ever carried, so a build inside every budget went red on three
   * arms and passed a fourth that had counted nothing.
   */
  const rust = read("apps/desktop/src-tauri/src/vitals.rs");

  function rustFields(): string[] {
    const list = /pub const UI_VITALS_FIELDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
    return [...list.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
  }

  it("every field the shell reports is one the desktop shell knows how to write", () => {
    const declared = rustFields();
    expect(declared.length, "the Rust vocabulary could not be read at all").toBeGreaterThan(0);
    expect(declared.slice().sort()).toEqual(Object.keys(takeUiVitals()).sort());
  });

  it("every name the performance check reads is one both other homes carry", () => {
    const reads = Object.values(check.UI_VITALS_READS);
    expect(reads.length, "the check reads no ui_vitals field at all").toBeGreaterThan(0);
    const rustNames = rustFields();
    const reported = Object.keys(takeUiVitals());
    for (const name of reads) {
      expect(rustNames, `the desktop shell writes no "${name}"`).toContain(name);
      expect(reported, `the window reports no "${name}"`).toContain(name);
    }
  });

  it("the check reads the line under the service the shell stamps on it", () => {
    // The tag is part of the vocabulary: a check filtering on another service reads no lines at
    // all, which arrives as "the instrument shipped and wrote nothing" — a red for a rig cause.
    expect(rust).toContain(`\\"service\\":\\"${check.UI_VITALS_SERVICE}\\",\\"event\\":\\"ui_vitals\\"`);
  });

  /**
   * THE FIFTH HOME IS OUTSIDE THIS REPOSITORY. The performance kit's five readers take their
   * latency from this line — the frames and opens, the start-to-list, the search and switch,
   * and the derivation arm — and the kit lives in its own repo ("the 0.19.2 performance kit, its
   * repo home and its rows", 2026-09-16). A field it reads that this line stops carrying is a
   * cell that refuses rather than a number that changes, so the list is written down on this side
   * too and the Rust half asserts it parses out of a composed line.
   */
  const PERF_KIT_READS = [
    "shellPaintedMs", "listUsableMs", "engineReadyMs",
    "openP95Ms", "openCount", "switchP95Ms", "switchCount", "searchP95Ms", "searchCount",
    "longFrames", "deriveMs", "deriveP50Ms", "deriveP95Ms", "deriveCount",
  ];

  it("every field the performance kit reads is one both homes carry", () => {
    const rustNames = rustFields();
    const reported = Object.keys(takeUiVitals());
    for (const name of PERF_KIT_READS) {
      expect(rustNames, `the desktop shell writes no "${name}"`).toContain(name);
      expect(reported, `the window reports no "${name}"`).toContain(name);
    }
  });

  /**
   * THE CADENCE AND ITS BOUNDS ARE ONE RULE IN TWO LANGUAGES. The shell answers `ui_vitals` with
   * the interval it wants and the window refuses one outside the range; both sides' numbers are
   * read out of source here, so a range widened on one side alone fails rather than letting a
   * shell talk this window into reporting every millisecond.
   */
  it("the report's shipped cadence and its knob range are the same on both sides", () => {
    /* `60 * 60_000` is how Rust spells an hour here, so the reader multiplies the factors rather
       than evaluating the text — a literal parser would have to be kept in step with the spelling. */
    const product = (text: string): number =>
      text.split("*").reduce((n, part) => n * Number(part.replace(/_/g, "").trim()), 1);
    const constant = (name: string): number => {
      const hit = new RegExp(`${name}: u64 = ([0-9_ *]+);`).exec(rust)?.[1];
      expect(hit, `${name} could not be read out of vitals.rs`).toBeTruthy();
      return product(hit!);
    };
    expect(constant("VITALS_INTERVAL_MIN_MS")).toBe(REPORT_MIN_MS);
    expect(constant("VITALS_INTERVAL_MAX_MS")).toBe(REPORT_MAX_MS);
    const secs = /pub const UI_VITALS_EVERY: std::time::Duration =\s*std::time::Duration::from_secs\(([0-9_ *]+)\);/
      .exec(rust)?.[1];
    expect(secs, "the shell's copy of the window's cadence could not be read").toBeTruthy();
    expect(product(secs!) * 1_000).toBe(REPORT_EVERY_MS);
  });

  /**
   * THE TIMEOUT IS ONE BOUND IN TWO LANGUAGES. The window counts an open or a switch past it as a
   * timeout; the shell refuses a percentile above it from a window older than that rule. A bound
   * moved on one side alone lets a stale mark through on the other.
   */
  it("the interaction timeout and the percentiles it bounds are the same on both sides", () => {
    const hit = /pub const INTERACTION_TIMEOUT_MS: u64 = ([0-9_]+);/.exec(rust)?.[1];
    expect(hit, "INTERACTION_TIMEOUT_MS could not be read out of vitals.rs").toBeTruthy();
    expect(Number(hit!.replace(/_/g, ""))).toBe(INTERACTION_TIMEOUT_MS);
    const list = /pub const BOUNDED_UI_FIELDS: &\[&str\] = &\[([^\]]*)\];/.exec(rust)?.[1] ?? "";
    const bounded = [...list.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
    expect(bounded.sort()).toEqual(["openP50Ms", "openP95Ms", "switchP50Ms", "switchP95Ms"]);
    // …and each bounded kind has the count its timeouts go to, in both homes.
    for (const name of ["openTimeouts", "switchTimeouts"]) {
      expect(rustFields()).toContain(name);
      expect(Object.keys(takeUiVitals())).toContain(name);
    }
  });

  it("the check's two count thresholds are the ones the window counted at", () => {
    /* `longFrames` and `longTasks` are COUNTS the window took at its own thresholds, so the
       budgets the check prints them against have to be those thresholds — otherwise the verdict
       says "over 50 ms" about a number counted at something else. */
    expect(check.BUDGETS.frameGapMs).toBe(LONG_FRAME_MS);
    expect(check.BUDGETS.longTaskMs).toBe(LONG_TASK_MS);
  });
});
