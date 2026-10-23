import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { publicPath, ROOT } from "./support/public-root.mjs";

/**
 * A RETRY IS FOR A NAMED INFRASTRUCTURE FAULT OF A NON-TEST STEP, AND A TEST IS NEVER RETRIED.
 *
 * A single, visible retry on a named infrastructure class of a non-test step is allowed, and a test is
 * never retried. `.github/scripts/retry-infra.sh` is the one way the workflows retry anything (its own
 * test holds what it does), but for one inline copy of its hdiutil-busy class in build.yml's macos-sign,
 * which holds the signing identity and so has no checkout to run the script from. This file holds where
 * each may stand:
 *
 *   · every npm install line in ci, build and android goes through the npm-network class;
 *   · each wrapper call names a known class and wraps only that class's command: npm ci / npm install,
 *     `cargo test --locked … --no-run` (a compile, never a run), `hdiutil detach`, and in
 *     build-engine-app.mjs the tauri build alone, verbose, on macOS when a dmg is built;
 *   · the inline retry is one function in macos-sign and nowhere else: `hdiutil detach`, again once
 *     after the exit status 16 alone, announced as the wrapper announces one; every detach in that job
 *     goes through it;
 *   · the macOS job compiles its Rust tests (the default configuration) through the wrapper BEFORE its
 *     unwrapped test step;
 *   · every "Note how long the build step took" leaves the reading empty after a retry, so a retried
 *     build never widens a timing ceiling.
 */
const yaml = createRequire(join(ROOT, "package.json"))("js-yaml") as { load(text: string): unknown };
type Step = { name?: string; run?: string; "working-directory"?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const WORKFLOWS = ["ci", "build", "android"] as const;
const read = (n: string) => readFileSync(publicPath(`github/workflows/${n}.yml`), "utf8");
const TEXT = Object.fromEntries(WORKFLOWS.map((n) => [n, read(n)])) as Record<(typeof WORKFLOWS)[number], string>;
const ENGINE_APP = readFileSync(join(ROOT, "apps/desktop/scripts/build-engine-app.mjs"), "utf8");

const WRAP = 'bash "$GITHUB_WORKSPACE/.github/scripts/retry-infra.sh"';
const code = (text: string) => text.split("\n").filter((l) => !/^\s*#/.test(l));

/** npm install lines not run through the npm-network class, and how many install lines there are. */
export function npmInstalls(text: string): { all: string[]; bare: string[] } {
  const all = code(text).filter((l) => /\bnpm (ci|install)\b/.test(l));
  const wrapped = new RegExp(`(^|\\s|&& )${WRAP.replace(/[$.*+?()[\]{}|\\/]/g, "\\$&")} npm-network -- npm (ci|install) `);
  return { all, bare: all.filter((l) => !wrapped.test(l)) };
}

/** A wrapper call's class and command, read off its line. */
const TEST_WORDS = /\b(vitest|tsc|smoke|perf-smoke-check|verify-report|playwright|npm (run )?test)\b/;
export function wrapperProblems(text: string): string[] {
  const out: string[] = [];
  for (const l of code(text).filter((x) => x.includes("retry-infra.sh"))) {
    const m = /retry-infra\.sh"? (\S+) -- (.*)$/.exec(l);
    if (!m) { out.push(`unread: ${l.trim()}`); continue; }
    const [, cls, cmd] = m as unknown as [string, string, string];
    const ok =
      cls === "npm-network" ? /^npm (ci|install) /.test(cmd)
      : cls === "cargo-exec-126" ? /^cargo test --locked\b.*\s--no-run\s*$/.test(cmd)
      : cls === "hdiutil-busy" ? /^hdiutil detach /.test(cmd)
      : false;
    if (!ok) out.push(`${cls} may not wrap: ${cmd}`);
    if (TEST_WORDS.test(cmd) || (/\bcargo test\b/.test(cmd) && !/--no-run/.test(cmd))) out.push(`a test is wrapped: ${cmd}`);
  }
  return out;
}

/** The macOS job: its Rust tests compiled through the wrapper, then run unwrapped, in that order. */
export function macCompileProblems(text: string): string[] {
  const steps = (yaml.load(text) as Workflow).jobs.macos?.steps ?? [];
  const compile = steps.findIndex((s) => s.name === "Compile the Rust tests (default configuration)");
  const test = steps.findIndex((s) => s.name === "cargo test (both configurations)");
  const out: string[] = [];
  if (compile < 0) return ["no compile step"];
  if (test < 0) return ["no cargo test step"];
  if (compile > test) out.push("the compile step comes after the tests");
  const run = String(steps[compile]!.run ?? "");
  // The default configuration alone: compiling local-engine too made the test step relink the default.
  if (run !== `${WRAP} cargo-exec-126 -- cargo test --locked --no-run`) out.push("the compile step is not the default configuration's compile alone");
  if (steps[compile]!["working-directory"] !== steps[test]!["working-directory"]) out.push("the compile step builds another directory");
  if (String(steps[test]!.run ?? "").includes("retry-infra")) out.push("the test step is wrapped");
  return out;
}

/** Every note step: no reading after a retry inside the build step. */
export function noteProblems(text: string): string[] {
  const steps = Object.values((yaml.load(text) as Workflow).jobs).flatMap((j) => j.steps ?? []);
  const notes = steps.filter((s) => s.name === "Note how long the build step took");
  if (notes.length < 3) return [`${notes.length} note steps, not 3`];
  return notes.flatMap((s, i) => {
    const run = String(s.run ?? "");
    return /if \[ "\$\{OHMAIL_RETRIED_AT:-0\}" -ge "\$\{OHMAIL_BUILD_STEP_T0:\?[^}]*\}" \]; then\n\s*echo "OHMAIL_BUILD_STEP_S=" >> "\$GITHUB_ENV"\n/.test(run)
      ? []
      : [`note step ${i + 1} keeps its reading after a retry`];
  });
}

/** The jobs of a workflow as lines, by id. */
function jobLines(text: string): Array<{ job: string; lines: string[] }> {
  const out: Array<{ job: string; lines: string[] }> = [];
  for (const l of text.slice(Math.max(0, text.indexOf("\njobs:\n"))).split("\n")) {
    const key = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(l);
    if (key) out.push({ job: key[1]!, lines: [] });
    else out.at(-1)?.lines.push(l);
  }
  return out;
}

/**
 * Where a workflow retries inline, and what is wrong with each: a function that announces a retry the way the
 * wrapper does, or runs `hdiutil detach` more than once (a silent one), and a `Retried once` outside any function.
 */
export function inlineRetries(file: string, text: string): { sites: string[]; problems: string[] } {
  const sites: string[] = [];
  const problems: string[] = [];
  const marked = (l: string) => /Retried once/.test(l) && !l.includes("retry-infra.sh");
  /* `hdiutil detach` run, never named in an echo. */
  const detaches = (l: string) => (/^\s*(?:echo|printf)\b/.test(l) ? 0 : (l.match(/\bhdiutil detach\b/g) ?? []).length);
  for (const { job, lines } of jobLines(text)) {
    const exec = code(lines.join("\n"));
    const where = `${file} ${job}`;
    const inside = new Set<number>();
    for (let from = 0; from < exec.length; from++) {
      const head = /^(\s*)([A-Za-z_]\w*)\(\) \{\s*$/.exec(exec[from]!);
      if (!head) continue;
      const to = exec.findIndex((l, i) => i > from && l.trim() === "}" && l.search(/\S/) === head[1]!.length);
      const end = to < 0 ? exec.length : to;
      const body = exec.slice(from + 1, end);
      for (let i = from; i <= end; i++) inside.add(i);
      const runs = body.reduce((n, l) => n + detaches(l), 0);
      if (!body.some(marked) && runs < 2) continue;
      const name = head[2]!;
      sites.push(where);
      if (runs !== 2) problems.push(`${where}: ${name} runs hdiutil detach ${runs} times, not once and once again`);
      const codes = body.flatMap((l) => [...l.matchAll(/(?:-eq|-ne|==?|!=)\s*"?(\d+)"?\s*\]/g)].map((m) => m[1]));
      if (codes.length === 0 || codes.some((c) => c !== "16")) problems.push(`${where}: ${name} retries on ${codes.length ? codes.join(", ") : "any status"}, not 16 alone`);
      if (body.some((l) => /^\s*(?:for|while|until)\b/.test(l))) problems.push(`${where}: ${name} retries in a loop`);
      const warn = body.findIndex((l) => l.includes("::warning title=Retried once%3A hdiutil-busy::"));
      const retry = body.map((l, i) => (detaches(l) ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1;
      if (runs === 2 && (warn < 0 || warn > retry)) problems.push(`${where}: ${name} does not announce its retry as hdiutil-busy before it runs`);
      for (const l of exec.filter((x, i) => (i < from || i > end) && detaches(x))) problems.push(`${where}: a detach that does not go through ${name}: ${l.trim()}`);
    }
    exec.forEach((l, i) => { if (marked(l) && !inside.has(i)) { sites.push(where); problems.push(`${where}: an inline retry outside a function`); } });
  }
  return { sites, problems };
}

/** build-engine-app.mjs: the wrapper around the tauri build only, verbose, on macOS with a dmg. */
export function engineAppProblems(text: string): string[] {
  const out: string[] = [];
  const uses = text.split("\n").filter((l) => /retry-infra\.sh/.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l));
  if (uses.length !== 1) out.push(`${uses.length} places name the wrapper, not 1`);
  const at = text.indexOf('say(`4/4');
  const wrapAt = text.indexOf("retry-infra.sh");
  if (at < 0 || wrapAt < at) out.push("the wrapper stands before stage 4");
  if (!/process\.platform === "darwin" && \(bundles \?\? ""\)\.split\(","\)\.includes\("dmg"\)/.test(text)) out.push("no darwin + dmg condition");
  if (!/"hdiutil-busy", "--", process\.execPath, cli, "build", "--verbose"/.test(text)) out.push("the wrapped call is not the verbose tauri build");
  return out;
}

describe("a retry wraps a named infrastructure class of a non-test step", () => {
  it("every npm install line in ci, build and android goes through npm-network", () => {
    const all = WORKFLOWS.flatMap((n) => npmInstalls(TEXT[n]).all);
    expect(all.length, "the census read no npm install line").toBeGreaterThanOrEqual(22);
    expect(WORKFLOWS.flatMap((n) => npmInstalls(TEXT[n]).bare.map((l) => `${n}: ${l.trim()}`))).toEqual([]);
  });

  it("each wrapper call names a known class and wraps no test", () => {
    const calls = WORKFLOWS.flatMap((n) => code(TEXT[n]).filter((l) => l.includes("retry-infra.sh")));
    expect(calls.length).toBeGreaterThanOrEqual(24);
    expect(WORKFLOWS.flatMap((n) => wrapperProblems(TEXT[n]))).toEqual([]);
  });

  it("the one inline retry is macos-sign's detach: exit 16 alone, once, announced, and every detach there goes through it", () => {
    const all = WORKFLOWS.map((n) => inlineRetries(`${n}.yml`, TEXT[n]));
    expect(all.flatMap((r) => r.sites)).toEqual(["build.yml macos-sign"]);
    expect(all.flatMap((r) => r.problems)).toEqual([]);
  });

  it("macOS compiles its Rust tests through the wrapper, then runs them unwrapped", () => {
    expect(macCompileProblems(TEXT.build)).toEqual([]);
  });

  it("every build-time note leaves the reading empty after a retry", () => {
    expect(noteProblems(TEXT.build)).toEqual([]);
  });

  it("build-engine-app.mjs wraps the macOS dmg build and nothing else", () => {
    expect(engineAppProblems(ENGINE_APP)).toEqual([]);
  });

  it("each reader refuses a wrong line and admits a right one", () => {
    const npm = "        run: npm ci --ignore-scripts --no-audit --no-fund\n";
    expect(npmInstalls(npm).bare).toHaveLength(1);
    expect(npmInstalls(`        run: ${WRAP} npm-network -- npm ci --ignore-scripts\n`).bare).toEqual([]);
    expect(npmInstalls(`        run: cd apps/desktop && ${WRAP} npm-network -- npm ci --ignore-scripts\n`).bare).toEqual([]);
    expect(npmInstalls(`        run: ${WRAP} hdiutil-busy -- npm ci --ignore-scripts\n`).bare).toHaveLength(1);

    expect(wrapperProblems(`          ${WRAP} npm-network -- npx vitest run x\n`)).toHaveLength(2);
    expect(wrapperProblems(`          ${WRAP} cargo-exec-126 -- cargo test --locked\n`)).toHaveLength(2);
    expect(wrapperProblems(`          ${WRAP} cargo-exec-126 -- cargo test --no-run\n`)).toHaveLength(1);
    expect(wrapperProblems(`          ${WRAP} hdiutil-busy -- hdiutil attach x\n`)).toHaveLength(1);
    expect(wrapperProblems(`          ${WRAP} npm-anything -- npm ci x\n`)).toHaveLength(1);
    expect(wrapperProblems(`          ${WRAP} npm-network -- npm run test\n`)).not.toEqual([]);
    expect(wrapperProblems(`          ${WRAP} cargo-exec-126 -- cargo test --locked --features local-engine --no-run\n`)).toEqual([]);
    expect(wrapperProblems(`          ${WRAP} hdiutil-busy -- hdiutil detach "$MNT"\n`)).toEqual([]);

    const swapped = TEXT.build.replace(
      /( {6}- name: Compile the Rust tests \(default configuration\)\n(?: {8}.*\n| {10}.*\n)*)\n( {6}- name: cargo test \(both configurations\)\n(?: {8}.*\n| {10}.*\n)*)/,
      "$2\n$1",
    );
    expect(swapped, "the swap planted nothing").not.toBe(TEXT.build);
    expect(macCompileProblems(swapped)).toContain("the compile step comes after the tests");
    expect(macCompileProblems(TEXT.build.replace(/cargo test --locked\n/, `${WRAP} cargo-exec-126 -- cargo test --locked\n`))).toContain("the test step is wrapped");
    const both = TEXT.build.replace(
      "cargo-exec-126 -- cargo test --locked --no-run\n",
      "cargo-exec-126 -- cargo test --locked --no-run && cargo test --locked --features local-engine --no-run\n",
    );
    expect(both).not.toBe(TEXT.build);
    expect(macCompileProblems(both)).toEqual(["the compile step is not the default configuration's compile alone"]);

    const kept = TEXT.build.replace('echo "OHMAIL_BUILD_STEP_S=" >> "$GITHUB_ENV"', 'echo "kept"');
    expect(noteProblems(kept)).toEqual(["note step 1 keeps its reading after a retry"]);

    expect(engineAppProblems(ENGINE_APP.replace('"build", "--verbose"', '"build"'))).toEqual(["the wrapped call is not the verbose tauri build"]);
    expect(engineAppProblems(ENGINE_APP.replace('process.platform === "darwin" && ', ""))).toEqual(["no darwin + dmg condition"]);
  });

  it("the inline retry reader refuses another status, a second retry, another command, a loop, a bare detach and another job", () => {
    const fn = [
      "detach() {", "  rc=0", '  hdiutil detach "$1" || rc=$?', '  if [ "$rc" -eq 16 ]; then',
      '    echo "::warning title=Retried once%3A hdiutil-busy::busy; running it once more"', "    sleep 5", '    hdiutil detach "$1"',
      "  else", '    return "$rc"', "  fi", "}", 'detach "$MNT"',
    ].join("\n");
    const wf = (job: string, run: string) => `jobs:\n  ${job}:\n    steps:\n      - name: s\n        run: |\n${run.split("\n").map((l) => `          ${l}`).join("\n")}\n`;
    expect(inlineRetries("x.yml", wf("macos-sign", fn)), "the positive control").toEqual({ sites: ["x.yml macos-sign"], problems: [] });
    const planted: Array<[string, string]> = [
      ["another status", fn.replace('"$rc" -eq 16', '"$rc" -eq 1')],
      ["a second retry", fn.replace('    hdiutil detach "$1"\n', '    hdiutil detach "$1" || hdiutil detach "$1"\n')],
      ["another command", fn.replace('    hdiutil detach "$1"\n', '    hdiutil attach "$1"\n')],
      ["a loop", fn.replace('    sleep 5\n', '    for _ in 1 2 3; do sleep 5; done\n')],
      ["the announcement without its class", fn.replace("title=Retried once%3A hdiutil-busy::", "title=Retried once::")],
      ["a silent retry", fn.replace('    echo "::warning title=Retried once%3A hdiutil-busy::busy; running it once more"\n', "")],
      ["a bare detach beside it", `${fn}\nhdiutil detach "$OTHER"`],
      ["an announcement outside a function", `${fn}\necho "::warning title=Retried once%3A hdiutil-busy::x"`],
    ];
    for (const [what, run] of planted) expect(inlineRetries("x.yml", wf("macos-sign", run)).problems, what).toHaveLength(1);
    /* The same function in a job that can reach the wrapper is a second site, which the census refuses. */
    const twice = `${wf("macos-sign", fn)}  macos:\n    steps:\n      - name: s\n        run: |\n${fn.split("\n").map((l) => `          ${l}`).join("\n")}\n`;
    expect(inlineRetries("x.yml", twice).sites).toEqual(["x.yml macos-sign", "x.yml macos"]);
  });
});
