import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join, relative, sep } from "node:path";

/**
 * EVERY EXPORTED PASS HAS A PRODUCER, AND EVERY STATUS A PASS WRITES HAS A READER.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────────────────
 *
 * `bubbleUpPass` (`apps/worker/src/bubble-up-cron.ts`) had SEVEN GREEN TESTS and no
 * production caller. Meanwhile the webapp's Ohbox bound a keyboard shortcut to a `resurface`
 * action that set `state='bubbled_up'` with `bubbleUpAt: nextFridayNine(now)` and then showed
 * the user "Resurfaces {when}" — naming a real wall-clock date. Nothing in production ever
 * flipped the row back. A dated promise, made with confidence, that no deployed code could
 * keep; and the reason nobody noticed is that "built, tested, unreachable one level up" is
 * invisible to every test that calls the function directly.
 *
 * So this file asserts the LEVEL UP: who calls it, and whether that caller is reached by
 * anything. It is a source scan, deliberately — the property is about the shape of the
 * program, and no behavioural test of a pass can see it.
 *
 * ── NO TSCONFIG NEEDS TO READ THIS FILE. DO NOT "FIX" IT BY RELOCATING IT ─────────────────
 *
 * The sharp edge elsewhere is that a TYPE-LEVEL assertion in a test file which no `tsconfig` includes
 * is silently never compiled — the reason `packages/api/tsconfig.contract.json` exists. This
 * file contains no type-level assertions. It is a RUNTIME scan with real `expect`s, and
 * `vitest run` executes it whether or not `tsc` ever looks at it. Nothing here needs to move
 * into a package to become load-bearing.
 *
 * ── WHY ROOT `test/` ──────────────────────────────────────────────────────────────────────
 *
 * It is cross-app: it reads every `apps/<pkg>/src` and `packages/<pkg>/src`, every `vercel.json`,
 * `.github/workflows/*.yml` and `railway.toml` where a checkout has one. Its neighbours are
 * repository-level checks such as `test/ci-runs-the-gate.test.ts`, which would be unowned filed
 * under any one package.
 *
 * ── TWO SCANNING ERRORS THIS FILE IS BUILT NOT TO INHERIT ─────────────────────────────────
 *
 * The first audit scanned for producers by hand and got two answers wrong, in opposite
 * directions. Both are structural, so both are fixed structurally rather than remembered:
 *
 *  1. **A MENTION IS NOT A CALL.** `runProposalCron` appeared to have a caller in
 *     `apps/worker/src/cron-log.ts`, which is a COMMENT quoting the old CLI shape
 *     (`runProposalCron(loadConfig())`) in order to explain why it was wrong. Every scan below
 *     runs over {@link stripComments} output. Without it that one comment would classify
 *     `runProposalCron` as `inline` and this whole file would go vacuously green.
 *  2. **A VALUE USE IS A USE.** A pattern requiring `name(` reports zero usages for all four
 *     `run*Cron` functions, because each is handed to `runCronCli` as an ARGUMENT
 *     (`runCronCli("bubble_up", runBubbleUpCron, …)`) and never called by name. That is what
 *     makes a CLI entry point reachable, and it is the difference between a manual backstop
 *     and a function nothing on earth can invoke — see {@link reachingRefs}.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const p = (...parts: string[]): string => join(ROOT, ...parts);
/** A path relative to the root, in `/` form on every platform, so the names below compare on Windows too. */
const rel = (abs: string): string => relative(ROOT, abs).split(sep).join("/");

/** Where a pass may be DEFINED. Recursive; `apps/worker/src` is flat today and must not have to be. */
const DISCOVERY_ROOTS = ["apps/worker/src", "packages/core/src"];

/**
 * Where a CALLER may live. Recursive, and every one of these is a real directory on disk —
 * asserted below, because a scan root that has been renamed is a scan that finds nothing and
 * reports success. `deps.test.ts` earned that lesson for `apps/worker/src`.
 */
const CALLER_ROOT_GLOBS = ["apps", "packages"] as const;

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "build", "coverage", "test", "__tests__"]);

/** A pass is one of these two shapes, and the shape is the whole discovery rule. */
const PASS_NAME = /^(?:.*Pass|run[A-Z].*Cron)$/;

/**
 * COMMENTS OUT, STRING BODIES KEPT.
 *
 * A character scanner and not a pair of regexes, because `"https://x"` inside a string would
 * let a naive `//` rule eat the rest of a real line of code. String and template bodies are
 * KEPT: part B's whole subject is the status literals inside `.set({ status: "running" })`, and
 * an earlier revision of this file blanked them — which emptied both scans and was caught by the
 * anti-vacuity assertion at the bottom rather than by shipping green. {@link blankStrings} is
 * the separate, narrower pass part A uses.
 *
 * KNOWN LIMIT, stated rather than hidden: a regex literal is not tracked, so a regex whose
 * body contains `//` would swallow the remainder of its line. Nothing under the scan roots has
 * one, and a line holding such a regex holding a pass call is not a shape this repository
 * writes. If that ever becomes untrue the failure direction is a false RED, not a false green.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";                    // keep line numbering usable
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") { out += src[i]!; i++; }
        if (i < n) { out += src[i]!; i++; }
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Quoted string BODIES emptied — part A only.
 *
 * A pass name is an identifier, so an occurrence inside a quoted string is prose however it got
 * there: an error message like `"runBubbleUpCron() failed"` is not a call and must not classify
 * a pass as produced. Applied on top of {@link stripComments}, never instead of it.
 */
export function blankStrings(src: string): string {
  return src.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `<root>/<pkg>/src` that exists — the caller index's real extent. */
function callerRoots(): string[] {
  const roots: string[] = [];
  for (const glob of CALLER_ROOT_GLOBS) {
    const base = p(glob);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(base, entry.name, "src");
      if (existsSync(src) && statSync(src).isDirectory()) roots.push(src);
    }
  }
  return roots;
}

interface Source {
  rel: string;
  /** Comments gone, string bodies intact — part B reads status literals out of this. */
  code: string;
  /** …and string bodies emptied too, for part A's identifier scans. */
  ident: string;
}

const SOURCES: Source[] = callerRoots()
  .flatMap((r) => tsFiles(r))
  .map((f) => {
    const code = stripComments(readFileSync(f, "utf8"));
    return { rel: rel(f), code, ident: blankStrings(code) };
  });

/** A pass, and where it is defined. */
interface Pass { name: string; rel: string }

function discover(): Pass[] {
  const found: Pass[] = [];
  for (const root of DISCOVERY_ROOTS) {
    for (const file of tsFiles(p(root))) {
      const code = blankStrings(stripComments(readFileSync(file, "utf8")));
      const re = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        const name = m[1]!;
        if (PASS_NAME.test(name)) found.push({ name, rel: rel(file) });
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const PASSES = discover();

/** A cron file is the CLI-entry half of the codebase; a caller here is not a production loop. */
const isCronFile = (rel: string): boolean => basename(rel).endsWith("-cron.ts");

/** Files that CALL `name` — call-shaped, comment-free, excluding the file that defines it. */
function callers(pass: Pass): string[] {
  const re = new RegExp(`\\b${pass.name}\\s*\\(`);
  return SOURCES.filter((s) => s.rel !== pass.rel && re.test(s.ident)).map((s) => s.rel).sort();
}

/**
 * Files that REACH `name` at all — a call OR a value reference (`runCronCli(…, runBubbleUpCron,
 * …)`), anywhere including its own file, minus the definition itself. This is the check that
 * stops {@link SCHEDULE_MANIFEST} from certifying a function nothing can invoke: a manual
 * backstop is reachable through its CLI entry, and a truly dead export is reachable by nothing.
 */
function reachingRefs(pass: Pass): string[] {
  const ref = new RegExp(`\\b${pass.name}\\b`, "g");
  const def = new RegExp(`export\\s+(?:async\\s+)?function\\s+${pass.name}\\b`);
  return SOURCES.filter((s) => {
    const code = s.rel === pass.rel ? s.ident.replace(def, "") : s.ident;
    ref.lastIndex = 0;
    return ref.test(code);
  }).map((s) => s.rel).sort();
}

type Kind = "inline" | "entry-only" | "unreachable";

function classify(pass: Pass): { kind: Kind; callers: string[]; refs: string[] } {
  const cs = callers(pass);
  const refs = reachingRefs(pass);
  if (cs.some((c) => !isCronFile(c))) return { kind: "inline", callers: cs, refs };
  return { kind: refs.length > 0 ? "entry-only" : "unreachable", callers: cs, refs };
}

const RESOLVED = new Map(PASSES.map((x) => [x.name, { pass: x, ...classify(x) }]));

// ══════════════════════════════════════════════════════════════════════════════════════════
//  THE MANIFEST — what invokes each pass that no production loop calls
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// Checked in, so adding a pass with no producer costs a diff a reviewer sees rather than
// silence. Every entry whose invoker names a SCHEDULER is cross-checked against the file on
// disk (see `corroborate`): without that the manifest is a self-certifying allowlist, a check
// that prints a live violation and exits 0.

type Invoker =
  | { kind: "railway"; service: string }
  | { kind: "vercel"; path: string }
  | { kind: "github"; workflow: string }
  | { kind: "MANUAL_BACKSTOP"; why: string };

const BACKSTOP_WHY =
  "takes acquireLeaderLock(leaderLockKeyFor(shardIndex)) — the SAME lock the always-on worker " +
  "holds — so a scheduled process would only ever start, fail to acquire and exit. It exists " +
  "for an operator to run when the worker is DEAD.";

const SCHEDULE_MANIFEST: Record<string, Invoker> = {
  // The four CLI backstops. None is on a timer and none can be, for the one reason above.
  runBubbleUpCron: { kind: "MANUAL_BACKSTOP", why: BACKSTOP_WHY },
  runWorkflowCron: { kind: "MANUAL_BACKSTOP", why: BACKSTOP_WHY },
  runReconcileCron: { kind: "MANUAL_BACKSTOP", why: BACKSTOP_WHY },
  runProposalCron: { kind: "MANUAL_BACKSTOP", why: BACKSTOP_WHY },
  // DELIBERATELY UNWIRED, not overlooked. `config.proposer` is live wherever an Anthropic
  // key is set, so a timer would charge every served account for proposals nothing shows
  // (PROPOSAL-PASS-UNSCHEDULED, PROPOSALS-HAVE-NO-SURFACE), and the operator console says so.
  // Its only reach is `runProposalCron` above.
  proposalGeneratePass: {
    kind: "MANUAL_BACKSTOP",
    why: "nothing shows a proposal and nothing can run one yet, so a schedule would bill for nothing; " +
      "reachable only through runProposalCron, which is itself a manual backstop.",
  },
};

/** `railway.toml`, or null: this repository declares no Railway service, so a railway claim is refused. */
const RAILWAY: string | null = existsSync(p("railway.toml")) ? readFileSync(p("railway.toml"), "utf8") : null;

function vercelCronPaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "vercel.json") {
        const json = JSON.parse(readFileSync(full, "utf8")) as { crons?: Array<{ path?: string }> };
        for (const c of json.crons ?? []) if (c.path) out.push(c.path);
      }
    }
  };
  walk(ROOT);
  return out;
}

const VERCEL_CRON_PATHS = vercelCronPaths();
const WORKFLOW_DIR = p(".github/workflows");

/** Is the claimed scheduler actually on disk? Returns null when it is, a reason when it is not. */
function corroborate(name: string, inv: Invoker): string | null {
  if (inv.kind === "MANUAL_BACKSTOP") {
    return inv.why.trim().length > 20 ? null : `${name}: MANUAL_BACKSTOP with no reason given`;
  }
  if (inv.kind === "railway") {
    // A railway claim has to point at a service section that exists; with no railway.toml at all
    // there is none to point at, and the claim fails closed.
    if (RAILWAY === null) return `${name}: this repository declares no Railway service ("${inv.service}")`;
    const declared = new RegExp(`\\[\\[?\\s*(?:services\\.)?${inv.service}\\b`).test(RAILWAY)
      || new RegExp(`name\\s*=\\s*"${inv.service}"`).test(RAILWAY);
    return declared ? null : `${name}: railway.toml declares no service "${inv.service}"`;
  }
  if (inv.kind === "vercel") {
    return VERCEL_CRON_PATHS.includes(inv.path)
      ? null
      : `${name}: no vercel.json cron has path "${inv.path}" (present: ${VERCEL_CRON_PATHS.join(", ") || "none"})`;
  }
  const file = join(WORKFLOW_DIR, inv.workflow);
  if (!existsSync(file)) return `${name}: .github/workflows/${inv.workflow} does not exist`;
  return /^\s*schedule:/m.test(readFileSync(file, "utf8"))
    ? null
    : `${name}: .github/workflows/${inv.workflow} has no schedule: key`;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
//  PART A — every exported pass has a producer
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("every exported pass has a producer", () => {
  it("scans roots that exist, over a non-trivial number of files", () => {
    for (const root of DISCOVERY_ROOTS) {
      expect(existsSync(p(root)), `discovery root ${root} is missing`).toBe(true);
    }
    const roots = callerRoots().map(rel);
    // Named, not counted: a rename that empties the index must fail here and not silently.
    expect(roots).toContain("apps/worker/src");
    expect(roots).toContain("packages/core/src");
    expect(roots).toContain("packages/services/src");
    expect(roots).toContain("packages/api/src");
    expect(roots).toContain("packages/db/src");
    expect(roots.length).toBeGreaterThan(8);
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(existsSync(WORKFLOW_DIR)).toBe(true);
    expect(VERCEL_CRON_PATHS.length).toBeGreaterThan(0);
  });

  it("discovers every pass this repository has, by SHAPE and not by list", () => {
    // Anti-vacuity 1. A discovery regex that stops matching finds nothing and reports success,
    // so the eight names the first audit enumerated are pinned here.
    const names = PASSES.map((x) => x.name);
    for (const want of [
      "bubbleUpPass", "workflowDrainPass", "workflowTimeScanPass", "proposalGeneratePass",
      "runBubbleUpCron", "runWorkflowCron", "runProposalCron", "runReconcileCron",
    ]) {
      expect(names, `discovery missed ${want}`).toContain(want);
    }
  });

  it("resolves the KNOWN-GOOD cases positively, so a broken scanner fails here first", () => {
    // Anti-vacuity 2. `workflowDrainPass` is called from the worker's own `cycle()`; if the
    // scanner cannot see that, every interesting assertion below is vacuous.
    const drain = RESOLVED.get("workflowDrainPass")!;
    expect(drain.kind).toBe("inline");
    expect(drain.callers).toContain("apps/worker/src/index.ts");

    // …and the fix itself. Deleting the `bubbleUpPass` call from `cycle()` turns the
    // product defect back on, and this is the line that says so by name.
    const bubble = RESOLVED.get("bubbleUpPass")!;
    expect(bubble.kind, "bubbleUpPass has no production caller — the unfired-resurface defect is back").toBe("inline");
    expect(bubble.callers).toContain("apps/worker/src/index.ts");
    /* ONE CALLER PER DOOR, AND ONE `kind: "inline"` HIDES THE MISSING ONE ─────────────────────
     *
     * The fix wired the HOSTED door and the assertion above went green, which is precisely why the
     * same defect stayed live on the standalone desktop for as long as it did: `kind` is a
     * property of the pass, not of a host, so one caller satisfies it and the second door's
     * silence looks identical to success. A free-tier install runs no worker at all — its store
     * is the local database and `apps/sidecar/src/engine.ts`'s drain is the only thing that can
     * flip a due row there — so that caller is named here in its own right.
     *
     * The Cloud DOOR of the desktop is deliberately absent from this list and must stay absent:
     * `cloud-engine.ts` reads a mirror the hosted worker owns and learns the flip as a
     * `message_state` delta (`cloud-mirror.ts`). A caller there would be a second writer. */
    expect(
      bubble.callers,
      "the standalone desktop door has no resurfacing producer — a scheduled resurface never fires " +
        "on a free-tier install, the defect this caller closed",
    ).toContain("apps/sidecar/src/engine.ts");

    // The comment-stripping half, asserted rather than trusted: `cron-log.ts` contains
    // `runProposalCron(loadConfig())` INSIDE A COMMENT. A scanner that counted it would call
    // `runProposalCron` inline and take the manifest entry below for a stale allowlist row.
    const proposal = RESOLVED.get("runProposalCron")!;
    expect(proposal.callers, "a comment was counted as a caller").not.toContain("apps/worker/src/cron-log.ts");
    expect(proposal.kind).toBe("entry-only");
    // The VALUE-use half: its only reach is the `runCronCli(…, runProposalCron, …)` argument.
    expect(proposal.refs).toContain("apps/worker/src/proposal-cron.ts");
  });

  it("has a producer for every pass: an inline caller, or a manifest entry", () => {
    const unproduced: string[] = [];
    for (const [name, r] of RESOLVED) {
      if (r.kind === "inline") continue;
      if (!(name in SCHEDULE_MANIFEST)) {
        unproduced.push(
          `${name} (${r.pass.rel}) is ${r.kind}: ` +
          (r.callers.length > 0
            ? `its only callers outside its own file are cron entry points [${r.callers.join(", ")}]`
            : `nothing outside ${r.pass.rel} calls it (reached by [${r.refs.join(", ") || "nothing"}])`) +
          " and it has no SCHEDULE_MANIFEST entry",
        );
      }
    }
    expect(unproduced).toEqual([]);
  });

  it("does not let the manifest certify a pass nothing reaches, or one already inline", () => {
    const bad: string[] = [];
    for (const [name, inv] of Object.entries(SCHEDULE_MANIFEST)) {
      const r = RESOLVED.get(name);
      if (!r) { bad.push(`${name}: manifest names a pass that no scan root defines`); continue; }
      if (r.kind === "inline") {
        bad.push(`${name}: already called inline by [${r.callers.join(", ")}] — the entry is dead weight`);
      }
      if (r.refs.length === 0) {
        bad.push(`${name}: NOTHING in the repository references it — a manifest entry cannot invoke it`);
      }
      void inv;
    }
    expect(bad).toEqual([]);
  });

  it("cross-checks every manifest entry that names a scheduler against the file on disk", () => {
    const uncorroborated = Object.entries(SCHEDULE_MANIFEST)
      .map(([name, inv]) => corroborate(name, inv))
      .filter((x): x is string => x !== null);
    expect(uncorroborated).toEqual([]);
  });

  it("refuses a planted entry whose scheduler is not on disk, of every kind", () => {
    // The control for the case above: a corroborator that admitted everything would pass it too.
    const planted: Array<[string, Invoker]> = [
      ["plantedRailwayPass", { kind: "railway", service: "no-such-service" }],
      ["plantedVercelPass", { kind: "vercel", path: "/internal/no-such-cron" }],
      ["plantedGithubPass", { kind: "github", workflow: "no-such-workflow.yml" }],
      ["plantedBackstopPass", { kind: "MANUAL_BACKSTOP", why: "" }],
    ];
    for (const [name, inv] of planted) {
      expect(corroborate(name, inv), `${name} (${inv.kind}) was admitted`).toMatch(new RegExp(`^${name}: `));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
//  PART B — every NON-TERMINAL status a pass writes is selected by something
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// ── THIS BLOCK WAS WRITTEN RED, ON PURPOSE ───────────────────────────────────────────────────
//
// `"running"` is written by `workflowDrainPass` (`workflow-cron.ts`). A run claimed by a drain
// that then dies — a deploy, a SIGKILL, a lost lock — sat at `running` for ever while the drain
// selected `status='pending'` only, so no later drain looked at it again, and the promise that
// "a re-drained run re-executes its steps idempotently" had no producer. The block went green
// when the drain began reclaiming stale `running` runs (`workflow-cron.ts`), which is itself a
// `status='running'` selection.
//
// DO NOT keep it green by adding a read that nothing acts on. The honest ways out of a red here
// are a selection that acts on the rows it finds, or deleting the status.
//
// ── WHY "NON-TERMINAL" AND HOW IT IS DECIDED FROM THE SQL ─────────────────────────────────
//
// `succeeded`, `failed` and `undone` are also written and also selected by no literal, and
// that is CORRECT: a run in one of them is finished, and nothing needs to find it again. The
// difference is not a hand-kept list — it is in the UPDATE itself. Every terminal write stamps
// `finishedAt` in the same `.set({…})`; `pending` and `running` do not. So the rule reads: a
// status a row can SIT in must be findable. Written without `finishedAt`, selected by nobody
// ⇒ rows enter a state no code will ever look at again.

const STATUS_SOURCES = SOURCES;

interface StatusWrite { status: string; rel: string; terminal: boolean }

/**
 * `.update(workflowRuns).set({…})` / `.insert(workflowRuns).values({…})`, and the status
 * literals inside. Lazy up to the first `}`+`)`, which is the real closer for every shape in
 * this repository — a nested `[{ … }])` ends `}])` and does not match.
 */
function statusWrites(): StatusWrite[] {
  const out: StatusWrite[] = [];
  const re = /\.(?:update|insert)\(\s*workflowRuns\s*\)\s*\.(?:set|values)\(\{([\s\S]*?)\}\s*\)/g;
  for (const s of STATUS_SOURCES) {
    for (let m = re.exec(s.code); m; m = re.exec(s.code)) {
      const body = m[1]!;
      const terminal = /\bfinishedAt\b/.test(body);
      const lit = /\bstatus\s*:\s*"([a-z_]+)"/g;
      for (let g = lit.exec(body); g; g = lit.exec(body)) {
        out.push({ status: g[1]!, rel: s.rel, terminal });
      }
    }
    re.lastIndex = 0;
  }
  return out;
}

/** Status literals used in a real selection predicate on `workflow_runs.status`. */
function statusReads(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (status: string, rel: string): void => {
    const at = out.get(status) ?? [];
    if (!at.includes(rel)) at.push(rel);
    out.set(status, at);
  };
  for (const s of STATUS_SOURCES) {
    const re = /\b(?:eq|ne|inArray|notInArray)\(\s*workflowRuns\.status\s*,\s*([^)]*)\)/g;
    for (let m = re.exec(s.code); m; m = re.exec(s.code)) {
      const arg = m[1]!;
      const lit = /"([a-z_]+)"/g;
      for (let g = lit.exec(arg); g; g = lit.exec(arg)) add(g[1]!, s.rel);
    }
    // The raw-SQL form, in case a predicate is ever hand-written:
    // sql`${workflowRuns.status} = 'running'`
    const raw = /workflowRuns\.status\}\s*(?:=|<>|!=|IN)\s*\(?\s*'([a-z_]+)'/g;
    for (let m = raw.exec(s.code); m; m = raw.exec(s.code)) add(m[1]!, s.rel);
  }
  return out;
}

const WRITES = statusWrites();
const READS = statusReads();

describe("every non-terminal workflow_runs status is selected by something", () => {
  it("finds the writes at all — a regex that stops matching must go red, not quiet", () => {
    // Anti-vacuity for part B. These five are what the code writes today; if the scan below
    // silently degrades to zero matches, the assertion after it would pass on an empty set.
    const written = new Set(WRITES.map((w) => w.status));
    for (const want of ["pending", "running", "succeeded", "failed", "undone"]) {
      expect([...written], `no write of status "${want}" was found — the write scan is broken`)
        .toContain(want);
    }
    // And the terminal/non-terminal split comes from the SQL, so pin both sides of it.
    const terminalOf = (s: string): boolean[] => WRITES.filter((w) => w.status === s).map((w) => w.terminal);
    expect(terminalOf("running")).toEqual([false]);
    expect(terminalOf("succeeded")).toEqual([true]);
    expect(terminalOf("undone")).toEqual([true]);
    expect(terminalOf("pending").some((t) => t)).toBe(false);
  });

  it("reads the literal selections at all — `pending` is the known-good case", () => {
    expect([...READS.keys()]).toContain("pending");
    expect(READS.get("pending")).toContain("apps/worker/src/workflow-cron.ts");
  });

  it("KNOWN RED — a status a row can sit in must be selectable", () => {
    const stranded = [...new Set(WRITES.filter((w) => !w.terminal).map((w) => w.status))]
      .filter((s) => !READS.has(s))
      .map((s) => {
        const at = WRITES.filter((w) => w.status === s).map((w) => w.rel);
        return `"${s}" is written at [${[...new Set(at)].join(", ")}] with no finishedAt and ` +
          "selected by no predicate anywhere — a row that enters it is never looked at again";
      });
    expect(stranded).toEqual([]);
  });
});
