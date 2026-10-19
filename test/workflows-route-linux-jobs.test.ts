import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";
import { evalIf, evalValue, type IfContext } from "./support/workflow-if.js";

/**
 * THE LINUX TEST JOBS MAY RUN ON THE MAINTAINERS' OWN RUNNERS, AND A FORK'S PULL REQUEST NEVER DOES.
 *
 * The suite's jobs and the two engine jobs carry one `runs-on:` expression, byte for byte. It names the maintainers'
 * self-hosted runners (`self-hosted`, `ohmail-zorin`) only when the repository variable OHMAIL_LINUX_RUNNER reads
 * `zorin`, the run is this repository's own, no bot started it (neither `github.actor` nor `github.triggering_actor`
 * ends in `[bot]`), and it is the nightly schedule, a push to main, or a maintainer's pull request: its head a `pr/`
 * branch of this repository, opened by a User who is OWNER, MEMBER or COLLABORATOR — the door guard.yml keeps
 * (.github/scripts/assert-pr-guard.sh). Everything else runs on GitHub's `ubuntu-latest`, as before: a fork's pull
 * request (a maintainer's own fork too, and one whose head was deleted), Dependabot's and an app's pull requests, a
 * branch outside `pr/`, a tag, a merge group, a dispatch, `pull_request_target`, the variable unset or set to anything
 * else. Unset is the default, so this lands with no effect, and setting it to `hosted` is the way back. The runners'
 * own admission hook refuses the same set and ends its VM; it is written apart from this expression on purpose.
 *
 * What must hold, read off the files and evaluated as written:
 *   · exactly the ten jobs carry the expression, with their names (and so the required contexts) unchanged; no other
 *     job does, and no file under .github/ but ci.yml and build.yml names the runners or the variable;
 *   · a routed job reads no secret, takes no environment and uses no cache — the runner is a machine of ours;
 *   · the expression routes as above, and each of its guards is watched failing.
 */
export const ROUTE =
  "${{ vars.OHMAIL_LINUX_RUNNER == 'zorin' && github.repository == 'trafficflowhq/ohmail' && !endsWith(github.actor, '[bot]') && !endsWith(github.triggering_actor, '[bot]') && (github.event_name == 'schedule' || github.event_name == 'push' && github.ref == 'refs/heads/main' || github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.head_ref, 'pr/') && github.event.pull_request.user.type == 'User' && contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.pull_request.author_association)) && fromJSON('[\"self-hosted\",\"ohmail-zorin\"]') || 'ubuntu-latest' }}";
const SELF_HOSTED = ["self-hosted", "ohmail-zorin"];

/** The routed jobs by file, with the names they keep (five of them are required contexts). */
export const ROUTED: Record<string, Record<string, string>> = {
  "ci.yml": {
    plan: "suite · plan", suite: "suite (${{ matrix.shard }})", alone: "suite alone (${{ matrix.file }})",
    sqlite: "suite · sqlite (${{ matrix.shard }})", "proxy-e2e": "suite · proxy e2e", "webapp-build": "suite · webapp next build",
    typecheck: "typecheck", desktop: "suite · desktop",
  },
  "build.yml": { engine: "engine · typecheck · build", "engine-ui-smoke": "engine-bearing UI · scan · smoke" },
};
const NAMING = /self-hosted|ohmail-zorin|OHMAIL_LINUX_RUNNER/;
const ROUTING = /ohmail-zorin|OHMAIL_LINUX_RUNNER/;

type Job = { name: string; body: string };
/** The jobs of a workflow, each with its block's text. */
export function jobsOf(text: string): Job[] {
  const from = text.indexOf("\njobs:\n");
  if (from < 0) return [];
  const out: Job[] = [];
  let cur: Job | null = null;
  for (const line of text.slice(from + 7).split("\n")) {
    const key = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (key) { if (cur) out.push(cur); cur = { name: key[1], body: "" }; continue; }
    if (cur) cur.body += `${line}\n`;
  }
  if (cur) out.push(cur);
  return out;
}
const executed = (t: string) => t.split("\n").filter((l) => !/^\s*#/.test(l));
const field = (body: string, key: string) => new RegExp(`^ {4}${key}: (.+)$`, "m").exec(body)?.[1] ?? null;

/** Every way the files depart from the routing above, one line each; [] when they hold. */
export function routeFindings(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const routed = ROUTED[file] ?? {};
    const jobs = jobsOf(text);
    for (const want of Object.keys(routed)) if (!jobs.some((j) => j.name === want)) out.push(`${file}: the routed job ${want} is gone`);
    for (const j of jobs) {
      const runsOn = field(j.body, "runs-on");
      if (j.name in routed) {
        if (runsOn !== ROUTE) out.push(`${file}: ${j.name} does not carry the routing expression byte for byte`);
        if (field(j.body, "name") !== routed[j.name]) out.push(`${file}: ${j.name} is renamed (${field(j.body, "name")}), and its check with it`);
        const body = executed(j.body).join("\n");
        if (/\bsecrets\./.test(body)) out.push(`${file}: ${j.name} reads a secret on a self-hosted runner`);
        if (/^ {4}environment:/m.test(body)) out.push(`${file}: ${j.name} takes an environment on a self-hosted runner`);
        if (/uses: actions\/cache[@/]/.test(body)) out.push(`${file}: ${j.name} uses actions/cache on a self-hosted runner`);
      } else if (runsOn !== null && NAMING.test(runsOn)) {
        out.push(`${file}: ${j.name} routes to the self-hosted runners`);
      }
    }
    /* Outside the ten runs-on lines, ci.yml and build.yml name the runners in comments only; any other file not at all. */
    const routedLines = new Set(Object.keys(routed).length ? [`    runs-on: ${ROUTE}`] : []);
    const pattern = file in ROUTED ? ROUTING : NAMING;
    executed(text).forEach((l) => {
      if (pattern.test(l) && !routedLines.has(l)) out.push(`${file}: names the self-hosted runners outside a routed job's runs-on: ${l.trim().slice(0, 80)}`);
    });
  }
  return out;
}

/** Every file under .github/, workflows and scripts, by its name. */
function githubFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of ["workflows", "scripts"]) {
    for (const f of readdirSync(publicPath(`github/${dir}`))) out[f] = readFileSync(publicPath(`github/${dir}/${f}`), "utf8");
  }
  return out;
}

/**
 * A run as the expression sees it: the switch, the repository, who started it, the event, the ref and, for a pull
 * request, its head, its branch and its opener. By default a maintainer started it and, for a pull request, opened it
 * from a `pr/` branch as the repository's OWNER.
 */
function run(event: string, ref: string, head: string | null, extra: IfContext = {}): IfContext {
  const pr = event === "pull_request" || event === "pull_request_target";
  return {
    "vars.OHMAIL_LINUX_RUNNER": "zorin", "github.repository": "trafficflowhq/ohmail", "github.event_name": event, "github.ref": ref,
    "github.actor": "a-maintainer", "github.triggering_actor": "a-maintainer", "github.head_ref": pr ? "pr/lane-x" : "",
    "github.event.pull_request.head.repo.full_name": head,
    "github.event.pull_request.user.type": pr ? "User" : null, "github.event.pull_request.author_association": pr ? "OWNER" : null,
    ...extra,
  };
}
const SAME_PR = run("pull_request", "refs/pull/7/merge", "trafficflowhq/ohmail");
const OWN_FORK_PR = run("pull_request", "refs/pull/7/merge", "a-maintainer/ohmail");
const FORK_PR = run("pull_request", "refs/pull/7/merge", "someone/ohmail", {
  "github.actor": "someone", "github.triggering_actor": "someone", "github.event.pull_request.author_association": "CONTRIBUTOR",
});
const DEPENDABOT_PR = run("pull_request", "refs/pull/8/merge", "trafficflowhq/ohmail", {
  "github.actor": "dependabot[bot]", "github.triggering_actor": "dependabot[bot]", "github.head_ref": "dependabot/npm_and_yarn/vitest-9.9.9",
  "github.event.pull_request.user.type": "Bot", "github.event.pull_request.author_association": "NONE",
});
const APP_PR = run("pull_request", "refs/pull/9/merge", "trafficflowhq/ohmail", {
  "github.actor": "an-app[bot]", "github.triggering_actor": "an-app[bot]", "github.event.pull_request.user.type": "Bot",
  "github.event.pull_request.author_association": "NONE",
});
const TO_SELF: Array<[string, IfContext]> = [
  ["a pull request from a pr/ branch of this repository, opened by its OWNER", SAME_PR],
  ["the same, opened by a MEMBER", { ...SAME_PR, "github.event.pull_request.author_association": "MEMBER" }],
  ["the same, opened by a COLLABORATOR", { ...SAME_PR, "github.event.pull_request.author_association": "COLLABORATOR" }],
  ["a push to main", run("push", "refs/heads/main", null)],
  ["the nightly schedule", run("schedule", "refs/heads/main", null)],
];
const TO_HOSTED: Array<[string, IfContext]> = [
  ["a fork's pull request", FORK_PR],
  ["a maintainer's pull request from a fork of their own, on a pr/ branch", OWN_FORK_PR],
  ["a pull request whose head repository was deleted", run("pull_request", "refs/pull/7/merge", null)],
  ["Dependabot's pull request (a dependabot/ branch of this repository, a Bot, dependabot[bot])", DEPENDABOT_PR],
  ["an app's pull request from a pr/ branch of this repository", APP_PR],
  ["a maintainer's pull request from a branch outside pr/", { ...SAME_PR, "github.head_ref": "docs/x" }],
  ["a pull request from a pr/ branch opened by someone who is not the repository's (CONTRIBUTOR)", { ...SAME_PR, "github.event.pull_request.author_association": "CONTRIBUTOR" }],
  ["a maintainer's pull request whose run a bot started (github.actor)", { ...SAME_PR, "github.actor": "dependabot[bot]" }],
  ["a maintainer's pull request whose run a bot re-ran (github.triggering_actor)", { ...SAME_PR, "github.triggering_actor": "an-app[bot]" }],
  ["a push to main by an app", run("push", "refs/heads/main", null, { "github.actor": "an-app[bot]", "github.triggering_actor": "an-app[bot]" })],
  ["a v* tag", run("push", "refs/tags/v1.2.3", null)],
  ["an android-v* tag", run("push", "refs/tags/android-v1.2.3", null)],
  ["a push to another branch", run("push", "refs/heads/pr/x", null)],
  ["a merge group", run("merge_group", "refs/heads/gh-readonly-queue/main/pr-7-abc", null)],
  ["a dispatch on main", run("workflow_dispatch", "refs/heads/main", null)],
  ["pull_request_target", run("pull_request_target", "refs/heads/main", "trafficflowhq/ohmail")],
  ["the switch unset", run("pull_request", "refs/pull/7/merge", "trafficflowhq/ohmail", { "vars.OHMAIL_LINUX_RUNNER": "" })],
  ["the switch set to hosted", run("pull_request", "refs/pull/7/merge", "trafficflowhq/ohmail", { "vars.OHMAIL_LINUX_RUNNER": "hosted" })],
  ["a fork's own repository, its switch set", run("push", "refs/heads/main", null, { "github.repository": "someone/ohmail" })],
];

describe("the value evaluator (test/support/workflow-if.ts)", () => {
  it("reads startsWith, endsWith and contains as GitHub's do: without case, null as the empty string, contains over a list", () => {
    expect(evalValue("${{ endsWith(a.b, '[bot]') }}", { "a.b": "dependabot[bot]" })).toBe(true);
    expect(evalValue("${{ endsWith(a.b, '[BOT]') }}", { "a.b": "dependabot[bot]" })).toBe(true);
    expect(evalValue("${{ endsWith(a.b, '[bot]') }}", { "a.b": "a-maintainer" })).toBe(false);
    expect(evalValue("${{ !endsWith(a.b, '[bot]') }}", { "a.b": null })).toBe(true);
    expect(evalValue("${{ startsWith(a.b, 'pr/') }}", { "a.b": "PR/x" })).toBe(true);
    expect(evalValue("${{ startsWith(a.b, 'pr/') }}", { "a.b": null })).toBe(false);
    expect(evalValue("${{ contains(fromJSON('[\"OWNER\",\"MEMBER\"]'), a.b) }}", { "a.b": "member" })).toBe(true);
    expect(evalValue("${{ contains(fromJSON('[\"OWNER\",\"MEMBER\"]'), a.b) }}", { "a.b": "CONTRIBUTOR" })).toBe(false);
    expect(evalValue("${{ contains(fromJSON('[\"OWNER\"]'), a.b) }}", { "a.b": null })).toBe(false);
    expect(evalValue("${{ contains('refs/heads/main', 'HEADS') }}", {})).toBe(true);
  });
  it("returns the operand, as GitHub's && and || do, and reads fromJSON over a string literal", () => {
    expect(evalValue("${{ 'a' && 'b' }}", {})).toBe("b");
    expect(evalValue("${{ '' || 'x' }}", {})).toBe("x");
    expect(evalValue("${{ false && 'never' || 'fallback' }}", {})).toBe("fallback");
    expect(evalValue("${{ fromJSON('[\"a\",\"b\"]') }}", {})).toEqual(["a", "b"]);
    expect(evalValue("${{ fromJSON('{\"k\":1}') }}", {})).toEqual({ k: 1 });
    expect(evalValue("${{ github.ref == 'refs/heads/main' && fromJSON('[\"x\"]') || 'y' }}", { "github.ref": "refs/heads/main" })).toEqual(["x"]);
  });
  it("a null context compares unequal; a missing context, and fromJSON over anything but a literal, refuse", () => {
    expect(evalValue("${{ a.b == 'x' }}", { "a.b": null })).toBe(false);
    expect(evalValue("${{ a.b == c.d }}", { "a.b": null, "c.d": "x" })).toBe(false);
    expect(() => evalValue("${{ a.b }}", {})).toThrow(/no value given for the context a\.b/);
    expect(() => evalValue("${{ fromJSON(a.b) }}", { "a.b": "[]" })).toThrow(/fromJSON reads a string literal only/);
    expect(() => evalValue("${{ toJSON('x') }}", {})).toThrow(/no value given for the context toJSON/);
  });
  it("evalIf is the value read for truth", () => {
    for (const e of ["${{ 'a' && 'b' }}", "${{ '' }}", "${{ fromJSON('[]') }}", "${{ null }}", "${{ !cancelled() }}"]) {
      expect(evalIf(e, {})).toBe(Boolean(evalValue(e, {})));
    }
    expect(evalIf("${{ cancelled() }}", {}, { cancelled: true })).toBe(true);
  });
});

describe("the Linux test jobs and the switch to the self-hosted runners", () => {
  const files = githubFiles();

  it("exactly the ten jobs carry the routing expression byte for byte, their names kept; no other job or file names the runners", () => {
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["ci.yml", "build.yml", "android.yml", "guard.yml", "dco.yml", "assert-pr-guard.sh"]));
    expect(routeFindings(files)).toEqual([]);
    const carrying = Object.entries(files).flatMap(([f, t]) => jobsOf(t).filter((j) => field(j.body, "runs-on") === ROUTE).map((j) => `${f}:${j.name}`));
    expect(carrying.sort()).toEqual(Object.entries(ROUTED).flatMap(([f, js]) => Object.keys(js).map((j) => `${f}:${j}`)).sort());
  });

  it("a routed job reads no secret, takes no environment and uses no cache", () => {
    for (const f of Object.keys(ROUTED)) {
      for (const j of jobsOf(files[f]).filter((x) => x.name in ROUTED[f])) {
        expect(executed(j.body).join("\n"), `${f}: ${j.name}`).not.toMatch(/\bsecrets\.|^ {4}environment:|uses: actions\/cache[@/]/m);
      }
    }
  });

  it("routes to the self-hosted runners only when the switch reads zorin, for this repository's maintainers' runs", () => {
    for (const [label, ctx] of TO_SELF) expect(evalValue(ROUTE, ctx), label).toEqual(SELF_HOSTED);
  });

  it("routes everything else to GitHub's ubuntu-latest", () => {
    for (const [label, ctx] of TO_HOSTED) expect(evalValue(ROUTE, ctx), label).toBe("ubuntu-latest");
  });

  it("each guard is watched failing", () => {
    /* The head clause replaced by true: a maintainer's pull request from a fork would run here (a fork's code). */
    const noHead = ROUTE.replace("github.event.pull_request.head.repo.full_name == github.repository", "true");
    expect(noHead).not.toBe(ROUTE);
    expect(evalValue(noHead, OWN_FORK_PR)).toEqual(SELF_HOSTED);
    /* Each clause of the maintainer door, and each bot clause, dropped: the one run it alone turns away comes here. */
    const door: Array<[string, string, IfContext]> = [
      ["startsWith(github.head_ref, 'pr/') && ", "", { ...SAME_PR, "github.head_ref": "docs/x" }],
      ["github.event.pull_request.user.type == 'User' && ", "", { ...SAME_PR, "github.event.pull_request.user.type": "Bot" }],
      ["contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.pull_request.author_association)", "true",
        { ...SAME_PR, "github.event.pull_request.author_association": "CONTRIBUTOR" }],
      ["!endsWith(github.actor, '[bot]') && ", "", { ...SAME_PR, "github.actor": "dependabot[bot]" }],
      ["!endsWith(github.triggering_actor, '[bot]') && ", "", { ...SAME_PR, "github.triggering_actor": "an-app[bot]" }],
    ];
    for (const [clause, by, ctx] of door) {
      const mutated = ROUTE.replace(clause, by);
      expect(mutated, clause).not.toBe(ROUTE);
      expect(evalValue(ROUTE, ctx), clause).toBe("ubuntu-latest");
      expect(evalValue(mutated, ctx), clause).toEqual(SELF_HOSTED);
    }
    /* The switch dropped: unset no longer means GitHub's runners. */
    const noSwitch = ROUTE.replace("vars.OHMAIL_LINUX_RUNNER == 'zorin' && ", "");
    expect(noSwitch).not.toBe(ROUTE);
    expect(evalValue(noSwitch, { ...SAME_PR, "vars.OHMAIL_LINUX_RUNNER": "" })).toEqual(SELF_HOSTED);
    /* The repository clause dropped: a fork's own repository, its switch set, would ask for runners it does not have. */
    const noRepo = ROUTE.replace("github.repository == 'trafficflowhq/ohmail' && ", "");
    expect(evalValue(noRepo, run("push", "refs/heads/main", null, { "github.repository": "someone/ohmail" }))).toEqual(SELF_HOSTED);
    /* The expression on android's sign job, or on guard: named. */
    const sign = files["android.yml"].replace(/(\n {2}sign:\n(?: {4}.*\n)*? {4}runs-on: )ubuntu-latest/, `$1${ROUTE}`);
    expect(sign).not.toBe(files["android.yml"]);
    expect(routeFindings({ ...files, "android.yml": sign })).toContain("android.yml: sign routes to the self-hosted runners");
    const guard = files["guard.yml"].replace("    runs-on: ubuntu-latest", `    runs-on: ${ROUTE}`);
    expect(guard).not.toBe(files["guard.yml"]);
    expect(routeFindings({ ...files, "guard.yml": guard })).toContain("guard.yml: guard routes to the self-hosted runners");
    /* One routed job respelled: named, by file and job. */
    const desktop = files["ci.yml"].replace(/(\n {2}desktop:\n(?: {4}.*\n)*? {4}runs-on: \$\{\{ vars\.OHMAIL_LINUX_RUNNER == )'zorin'/, "$1'zorn'");
    expect(desktop).not.toBe(files["ci.yml"]);
    expect(routeFindings({ ...files, "ci.yml": desktop })).toContain("ci.yml: desktop does not carry the routing expression byte for byte");
    /* A routed job renamed, given a secret, an environment or a cache: named. */
    const renamed = files["ci.yml"].replace("    name: typecheck\n", "    name: types\n");
    expect(routeFindings({ ...files, "ci.yml": renamed })).toContain("ci.yml: typecheck is renamed (types), and its check with it");
    const secret = files["build.yml"].replace(/(\n {2}engine:\n {4}name: .*\n)/, "$1    env:\n      T: ${{ secrets.X }}\n");
    expect(routeFindings({ ...files, "build.yml": secret })).toContain("build.yml: engine reads a secret on a self-hosted runner");
    const env = files["build.yml"].replace(/(\n {2}engine-ui-smoke:\n {4}name: .*\n)/, "$1    environment: release\n");
    expect(routeFindings({ ...files, "build.yml": env })).toContain("build.yml: engine-ui-smoke takes an environment on a self-hosted runner");
    const cache = files["ci.yml"].replace(/(\n {2}plan:\n(?:.*\n)*? {6}- uses: actions\/checkout@[^\n]*\n)/, "$1\n      - uses: actions/cache@0123456789012345678901234567890123456789 # v4\n");
    expect(cache).not.toBe(files["ci.yml"]);
    expect(routeFindings({ ...files, "ci.yml": cache })).toContain("ci.yml: plan uses actions/cache on a self-hosted runner");
    /* Another workflow naming the variable, even outside a runs-on: named. */
    const dco = files["dco.yml"].replace("\njobs:\n", "\nenv:\n  R: ${{ vars.OHMAIL_LINUX_RUNNER }}\njobs:\n");
    expect(routeFindings({ ...files, "dco.yml": dco }).some((f) => f.startsWith("dco.yml: names the self-hosted runners"))).toBe(true);
    /* A routed job gone: named. */
    const gone = files["build.yml"].replace(/\n {2}engine-ui-smoke:\n/, "\n  engine-ui-smoke-old:\n");
    expect(routeFindings({ ...files, "build.yml": gone })).toContain("build.yml: the routed job engine-ui-smoke is gone");
  });
});
