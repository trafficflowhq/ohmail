// @services: none — reads test source as text
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE HOOK THAT FAILS INSTEAD OF THE ASSERTION — BUILDING AND REMOVING A DATABASE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A census, because the failure it forbids is invisible where it is read. A setup hook that
 * CREATES a database and migrates it pays for the whole schema at once, and a teardown that
 * DROPS one waits for the connections the run is still letting go of. vitest's default
 * `hookTimeout` is 10 s; a hook that crosses it fails as `Hook timed out in 10000ms` with no
 * test name attached, which reads as a defect in the code under test and is not one. Which side
 * of the default a file lands on is decided by machine load, and the setup cost grows with every
 * migration this repository adds — so the margin shrinks on its own until somebody declares it.
 *
 * Two halves are held here together: every hook that BUILDS a database from empty and every hook
 * that DROPS one names a budget, and no budget may be so small that it is the default in
 * disguise. Neither is observable from a passing suite, which is why a census is the only thing
 * that can hold them.
 */

const REPO = join(import.meta.dirname, "..");

/**
 * THE FLOOR, and it is deliberately not the helper's own number. `MIGRATED_DB_SETUP_BUDGET_MS`
 * is what a file gets for free by going through the helper; this is the smallest budget any file
 * in the class may declare at all. Three times vitest's default, and ten times the 3.1 s a
 * from-empty build of both journals measured on a developer machine — its job is to catch a
 * budget that is the default wearing a number, not to make every file adopt one figure.
 */
const FLOOR_MS = 30_000;

/** Hooks that may pay to build a database, and hooks that may pay to remove one. */
const SETUP_HOOKS = ["beforeAll", "beforeEach"] as const;
const TEARDOWN_HOOKS = ["afterAll", "afterEach"] as const;

/**
 * What puts a hook in the class. `runMigrations` alone is deliberately NOT here: replayed against
 * a database that is already this tree's schema it applies nothing, and 54 hooks do exactly that
 * against the lane or shared database. The cost is the BUILD — a database that did not exist a
 * moment ago, and therefore the whole of both journals — or an index build over the rows earlier
 * files left in a shared database.
 */
const BUILDS = /\b(?:create\s+database|CREATE\s+DATABASE|prepareIsolatedDb\s*\(|setupProdDatabase\s*\(|ensureSearchExtensions\s*\(|ensureWordIndex\s*\(|ensureHotPathIndexes\s*\(|ensureConcurrentIndexes\s*\(|ensureWithheldProvenanceIndex\s*\()/;

/** The index builders that have a plain mode: a hook passes it, since a concurrent build waits on every older snapshot. */
const PLAIN_BUILDERS = ["ensureSearchExtensions", "ensureWordIndex", "ensureHotPathIndexes", "ensureConcurrentIndexes"] as const;
const REMOVES = /\b(?:drop\s+database|DROP\s+DATABASE)\b/;

/**
 * The helper hides the DDL, so the words above no longer appear in a file that went through it.
 * Its handles are read out of the file instead — a census that only knew the raw statements would
 * stop seeing every hook the helper fixed, which is the failure mode this pair exists to prevent.
 */
const HANDLES = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*throwawayDb\s*\(/g;

function probesFor(src: string): { builds: RegExp; removes: RegExp } {
  const names: string[] = [];
  for (const m of src.matchAll(HANDLES)) names.push(m[1]!);
  if (names.length === 0) return { builds: BUILDS, removes: REMOVES };
  const any = names.join("|");
  return {
    // A clone of the sealed template builds too: the first clone per key replays both journals.
    builds: new RegExp(`${BUILDS.source}|\\b(?:${any})\\.(?:create|createFromTemplate)\\s*\\(`),
    removes: new RegExp(`${REMOVES.source}|\\b(?:${any})\\.drop\\s*\\(`),
  };
}

/** Comment characters become spaces, so a comment that QUOTES the defect cannot be read as one — and `file:line` stays true. */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        const d = src[i]!;
        out += d;
        i++;
        if (d === "\\") { if (i < src.length) { out += src[i]; i++; } continue; }
        if (d === quote) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The span of every `name( … )` call, parentheses balanced, string and template bodies skipped. */
function callSpans(src: string, name: string): Array<{ start: number; open: number; close: number }> {
  const out: Array<{ start: number; open: number; close: number }> = [];
  const opener = new RegExp(`\\b${name}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) { out.push({ start: m.index, open, close: i }); break; }
      }
    }
  }
  return out;
}

/**
 * The call's arguments, split at TOP-LEVEL commas. Brackets of all three kinds are tracked, so an
 * arrow body's own commas stay inside argument one — which is the whole reason this is a parse
 * and not a regex over the tail.
 */
function topLevelArgs(src: string, open: number, close: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { args.push(src.slice(from, i)); from = i + 1; }
  }
  args.push(src.slice(from, close));
  return args.map((a) => a.trim()).filter((a, n) => n === 0 || a !== "");
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

const tracked = (): string[] =>
  execFileSync("git", ["-C", REPO, "ls-files", "*.ts"], { encoding: "utf8", maxBuffer: 32 << 20 })
    .split("\n")
    .filter(Boolean)
    // A documentation tree may carry PARKED COPIES of test files — resolution fixtures, not a suite.
    .filter((f) => !f.startsWith("docs/"));

/**
 * `NAME` → the number it is declared as, across the repository. A budget written as a named
 * constant is resolved from its own declaration rather than restated here, so this census cannot
 * drift from the helper it polices. A name declared twice with two different numbers resolves to
 * nothing and its hooks are refused as unreadable — an unresolvable premise is not a pass.
 */
function budgetConstants(files: string[]): Map<string, number | null> {
  const seen = new Map<string, Set<number>>();
  const decl = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*number\s*)?=\s*([0-9][0-9_]*)\s*;/g;
  for (const f of files) {
    const src = blankComments(readFileSync(join(REPO, f), "utf8"));
    let m: RegExpExecArray | null;
    while ((m = decl.exec(src)) !== null) {
      const value = Number(m[2]!.replaceAll("_", ""));
      if (!Number.isFinite(value)) continue;
      const set = seen.get(m[1]!) ?? new Set<number>();
      set.add(value);
      seen.set(m[1]!, set);
    }
  }
  const out = new Map<string, number | null>();
  for (const [name, values] of seen) out.set(name, values.size === 1 ? [...values][0]! : null);
  return out;
}

interface Row {
  file: string;
  line: number;
  hook: string;
  kind: "builds" | "removes";
  /** The second argument exactly as written, or `null` when the hook declared none. */
  declared: string | null;
  /** Its value, or `null` when it is written as something this census cannot read. */
  ms: number | null;
}

function census(files: string[] = tracked()): Row[] {
  const constants = budgetConstants(files);
  const rows: Row[] = [];
  for (const f of files) {
    if (!f.includes(".test.")) continue;
    const src = blankComments(readFileSync(join(REPO, f), "utf8"));
    const { builds, removes } = probesFor(src);
    if (!builds.test(src) && !removes.test(src)) continue;
    for (const [hooks, probe, kind] of [
      [SETUP_HOOKS, builds, "builds"],
      [TEARDOWN_HOOKS, removes, "removes"],
    ] as const) {
      for (const hook of hooks) {
        for (const { start, open, close } of callSpans(src, hook)) {
          const args = topLevelArgs(src, open, close);
          if (!probe.test(args[0] ?? "")) continue;
          const declared = args[1]?.trim() || null;
          const ms = declared === null
            ? null
            : /^[0-9][0-9_]*$/.test(declared)
              ? Number(declared.replaceAll("_", ""))
              : constants.get(declared) ?? null;
          rows.push({ file: f, line: lineOf(src, start), hook, kind, declared, ms });
        }
      }
    }
  }
  return rows;
}

describe("a hook that builds or removes a database names its budget", () => {
  /**
   * THE POSITIVE CONTROL, first. Every other assertion here is a refusal, and a refusal census
   * over an empty list passes while guarding nothing. If the scanner stops matching — a hook
   * renamed, the repository listing empty, the comment blanker eating the source — this is the
   * assertion that says so instead of the suite reporting a clean sweep of nothing.
   */
  it("the census finds the hooks it claims to police", () => {
    const rows = census();
    const builds = rows.filter((r) => r.kind === "builds");
    const removes = rows.filter((r) => r.kind === "removes");
    expect(builds.length, "the scanner matched NO build hooks — it is guarding nothing")
      .toBeGreaterThan(40);
    expect(removes.length, "the scanner matched NO teardown hooks — it is guarding nothing")
      .toBeGreaterThan(15);
    expect(new Set(rows.map((r) => r.file)).size,
      "the scanner found hooks in only a handful of files").toBeGreaterThan(40);
    // The three files this census was written for must be among them, both halves each.
    for (const subject of [
      "apps/server/test/boot-ceremony.pg.test.ts",
      "apps/server/test/setup-token.pg.test.ts",
      "packages/services/test/trash.pg.test.ts",
    ]) {
      expect(rows.filter((r) => r.file === subject && r.kind === "builds").length,
        `${subject}: no build hook found`).toBe(1);
      expect(rows.filter((r) => r.file === subject && r.kind === "removes").length,
        `${subject}: no teardown hook found`).toBe(1);
    }
  });

  it("every hook that builds a database from empty declares a budget", () => {
    const offenders = census()
      .filter((r) => r.kind === "builds" && r.declared === null)
      .map((r) => `${r.file}:${r.line} ${r.hook}(…)`);
    expect(offenders,
      "these hooks take vitest's 10 s default while creating a database and replaying both " +
      "journals into it, or building indexes over its rows. They will fail as \"Hook timed out in " +
      "10000ms\" under load and read as a defect in the code under test. Build the database through " +
      "`throwawayDb`, build indexes with `{ concurrently: false }`, and pass " +
      "`MIGRATED_DB_SETUP_BUDGET_MS` as the hook's last argument").toEqual([]);
  });

  /**
   * A concurrent index build waits for every snapshot older than it in the whole database, so a
   * setup hook that builds one waits on sessions it does not own. A test database has no live
   * writer to protect: hooks build plain. Tests whose subject is the concurrent build call it in `it`.
   */
  it("every setup hook that builds an index passes { concurrently: false }", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const f of tracked()) {
      if (!f.includes(".test.")) continue;
      const src = blankComments(readFileSync(join(REPO, f), "utf8"));
      if (!PLAIN_BUILDERS.some((b) => src.includes(`${b}(`))) continue;
      for (const hook of SETUP_HOOKS) {
        for (const { start, open, close } of callSpans(src, hook)) {
          const body = topLevelArgs(src, open, close)[0] ?? "";
          for (const builder of PLAIN_BUILDERS) {
            for (const call of callSpans(body, builder)) {
              seen++;
              const opts = topLevelArgs(body, call.open, call.close).slice(1).join(",");
              if (!/\bconcurrently\s*:\s*false\b/.test(opts))
                offenders.push(`${f}:${lineOf(src, start)} ${hook}(…) ${builder}(…)`);
            }
          }
        }
      }
    }
    expect(seen, "the scanner matched NO builder call in a setup hook — it is guarding nothing").toBeGreaterThan(15);
    expect(offenders,
      "these setup hooks build indexes CONCURRENTLY, which waits on every older snapshot in the " +
      "database and times the hook out on a loaded runner. Pass `{ concurrently: false }`").toEqual([]);
  });

  it("every hook that drops a database declares a budget", () => {
    const offenders = census()
      .filter((r) => r.kind === "removes" && r.declared === null)
      .map((r) => `${r.file}:${r.line} ${r.hook}(…)`);
    expect(offenders,
      "these hooks take vitest's 10 s default while dropping a database, which waits for the " +
      "connections the run is still letting go of. Pass `MIGRATED_DB_TEARDOWN_BUDGET_MS` as the " +
      "hook's last argument").toEqual([]);
  });

  it("no declared budget is the default wearing a number", () => {
    const offenders = census()
      .filter((r) => r.declared !== null && (r.ms === null || r.ms < FLOOR_MS))
      .map((r) => `${r.file}:${r.line} ${r.hook}(…, ${r.declared})`);
    expect(offenders,
      `a budget below ${FLOOR_MS} ms — or one this census cannot read a number out of — leaves ` +
      "the same margin the default does. Use the constants the testing helper exports")
      .toEqual([]);
  });
});
