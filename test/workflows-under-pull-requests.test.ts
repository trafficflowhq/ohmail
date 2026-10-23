import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * THE PUBLIC MAIN TAKES PULL REQUESTS, AND THE WORKFLOWS FOLLOW.
 *
 * A required check that does not run on `merge_group` leaves a merge queue waiting until it gives up;
 * a concurrency group that cancels on a tag drops the run a release takes its installers from, while a
 * main run a newer push to main replaces only holds runners the pool is short of; a job that holds a
 * signing key outside the `release` environment can be made to run, key in hand, from any branch; and a
 * feeds recovery dispatched on the tag still takes main's tools. Nothing here runs GitHub Actions, so the
 * rules are read off the files, the expressions evaluated as written.
 */
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const WF = (n: string) => readFileSync(publicPath(`github/workflows/${n}.yml`, ROOT), "utf8");
const exec = (t: string) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** The trigger keys of the `on:` block. */
export function triggersOf(text: string): string[] {
  const block = /\non:\n([\s\S]*?)\n(?=[a-z])/.exec(`\n${exec(text)}`)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
}

/** The workflow-level concurrency, as written. */
export function concurrencyOf(text: string): { group: string | null; cancel: string | null } {
  const block = /\nconcurrency:\n((?: {2}.*\n?)+)/.exec(exec(text))?.[1] ?? "";
  return {
    group: /^ {2}group: (.+)$/m.exec(block)?.[1]?.trim() ?? null,
    cancel: /^ {2}cancel-in-progress: (.+)$/m.exec(block)?.[1]?.trim() ?? null,
  };
}

/** build.yml's and android.yml's concurrency: a pull request's run and a push to main's are superseded by
 * the next one; any other run is keyed by its commit and never cancelled. */
export const CANCEL = "${{ github.event_name == 'pull_request' || github.event_name == 'push' && github.ref == 'refs/heads/main' }}";
export const groupOf = (prefix: string) =>
  `${prefix}-\${{ github.ref }}-\${{ github.event_name == 'pull_request' && 'pr' || github.event_name == 'push' && github.ref == 'refs/heads/main' && 'main' || github.sha }}`;

/** Problems with the concurrency as written. */
export function concurrencyFindings(c: { group: string | null; cancel: string | null }, prefix: string): string[] {
  const out: string[] = [];
  if (c.cancel !== CANCEL) out.push(`cancels beyond a pull request and a push to main: ${c.cancel}`);
  /* A group shared by two runs that never cancel makes the second PENDING and drops any third: the commit keys it. */
  if (c.group !== groupOf(prefix)) out.push(`a run on a tag or a merge group can share its group: ${c.group}`);
  return out;
}

type Run = { label: string; event: string; ref: string; sha: string };
const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
/** Pairs where the second run supersedes the first: one group, and the second cancels. */
const SUPERSEDED: Array<[Run, Run]> = [
  [{ label: "a pull request", event: "pull_request", ref: "refs/pull/7/merge", sha: SHA_A },
    { label: "its next push", event: "pull_request", ref: "refs/pull/7/merge", sha: SHA_B }],
  [{ label: "a push to main", event: "push", ref: "refs/heads/main", sha: SHA_A },
    { label: "the next push to main", event: "push", ref: "refs/heads/main", sha: SHA_B }],
];
/** Runs that are never cancelled and share a group with no other commit's run. */
const KEPT: Run[] = [
  { label: "a v* tag", event: "push", ref: "refs/tags/v1.2.3", sha: SHA_A },
  { label: "an android-v* tag", event: "push", ref: "refs/tags/android-v1.2.3", sha: SHA_A },
  { label: "a merge group", event: "merge_group", ref: `refs/heads/gh-readonly-queue/main/pr-7-${SHA_A}`, sha: SHA_A },
  { label: "a dispatch on a tag", event: "workflow_dispatch", ref: "refs/tags/v1.2.3", sha: SHA_A },
  { label: "a dispatch on main", event: "workflow_dispatch", ref: "refs/heads/main", sha: SHA_A },
];

/** A workflow value as the runner reads it: a whole `${{ }}` is its value, a bare true or false that
 * boolean, and any other text has each `${{ }}` in it evaluated to a string. */
export function valueOf(raw: string, ctx: Record<string, string | null>): unknown {
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(raw.trim());
  if (whole && !whole[1].includes("}}")) return evaluate(whole[1].trim(), ctx);
  if (raw === "true" || raw === "false") return raw === "true";
  return raw.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, e: string) => String(evaluate(e.trim(), ctx) ?? ""));
}

/** What the concurrency does to the runs above, evaluated as written. */
export function concurrencyRuns(c: { group: string | null; cancel: string | null }, prefix: string): string[] {
  const at = (r: Run) => ({ "github.event_name": r.event, "github.ref": r.ref, "github.sha": r.sha });
  const group = (r: Run) => String(valueOf(c.group ?? "", at(r)));
  const cancels = (r: Run) => Boolean(valueOf(c.cancel ?? "false", at(r)));
  const out: string[] = [];
  for (const [old, next] of SUPERSEDED) {
    if (group(old) !== group(next)) out.push(`${prefix}: ${old.label} and ${next.label} do not share a group`);
    if (!cancels(next)) out.push(`${prefix}: ${next.label} does not cancel ${old.label}`);
  }
  const pr = SUPERSEDED[0][0];
  if (group(pr) === group({ ...pr, ref: "refs/pull/8/merge" })) out.push(`${prefix}: two pull requests share a group`);
  for (const r of KEPT) {
    if (cancels(r)) out.push(`${prefix}: ${r.label} cancels the run before it`);
    if (group(r) === group({ ...r, sha: SHA_B })) out.push(`${prefix}: ${r.label} shares its group with another commit's run`);
  }
  return out;
}

type Job = { name: string; body: string };
export function jobsOf(text: string): Job[] {
  const from = text.indexOf("\njobs:\n");
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

const SIGNING = /\bsecrets\.([A-Z0-9_]*(?:KEY|KEYSTORE|CERTIFICATE|PASSWORD|SIGNING|APPLE)[A-Z0-9_]*)/;
const RELEASE_ENV = new Set(["release", "${{ startsWith(github.ref, 'refs/tags/v') && 'release' || '' }}"]);

/** Jobs that read a signing secret and do not run in the `release` environment. */
export function keysOutsideRelease(text: string): string[] {
  return jobsOf(text)
    .filter((j) => SIGNING.test(exec(j.body)))
    .filter((j) => !RELEASE_ENV.has(/^ {4}environment: (.+)$/m.exec(exec(j.body))?.[1]?.trim() ?? ""))
    .map((j) => j.name);
}

/** The `.tools` checkout's `ref:` in release-feeds.yml, as written, or null when it names none. */
export function toolsRefOf(text: string): string | null {
  const m = /\n {10}path: \.tools\n(?: {10}[a-z-]+: .*\n)*? {10}ref: \$\{\{ (.+) \}\}\n/.exec(text);
  return m ? m[1] : null;
}
/** A GitHub expression of contexts, string literals, `==`, `&&` and `||`, evaluated with the same
 * operand-returning semantics; anything else in it refuses. */
export function evaluate(expr: string, ctx: Record<string, string | null>): unknown {
  const js = expr.replace(/'([^']*)'/g, (_m, v) => JSON.stringify(v)).replace(/==/g, "===")
    .replace(/[a-z_]+(?:\.[a-z_]+)+/g, (k) => { if (!(k in ctx)) throw new Error(`unknown context ${k}`); return JSON.stringify(ctx[k]); });
  if (!/^[\s"a-zA-Z0-9_./=&|-]*$/.test(js)) throw new Error(`not an expression this reads: ${expr}`);
  return new Function(`return (${js});`)();
}

describe("the workflows of a main that takes pull requests", () => {
  const build = WF("build"), android = WF("android"), feeds = WF("release-feeds");

  it("build and android run on the merge queue's groups, beside their old triggers", () => {
    expect(triggersOf(build)).toEqual(["push", "pull_request", "merge_group", "workflow_dispatch"]);
    expect(triggersOf(android)).toEqual(["push", "pull_request", "merge_group", "workflow_dispatch"]);
  });

  it("concurrency cancels a pull request's and main's superseded run, never a tag's", () => {
    for (const [t, prefix] of [[build, "build"], [android, "android"]] as const) {
      expect(concurrencyFindings(concurrencyOf(t), prefix)).toEqual([]);
      expect(concurrencyRuns(concurrencyOf(t), prefix)).toEqual([]);
    }
    const group = concurrencyOf(build).group!;
    const at = (event: string, ref: string) => ({ "github.event_name": event, "github.ref": ref, "github.sha": SHA_A });
    expect(valueOf(group, at("pull_request", "refs/pull/7/merge"))).toBe("build-refs/pull/7/merge-pr");
    expect(valueOf(group, at("push", "refs/heads/main"))).toBe("build-refs/heads/main-main");
    expect(valueOf(group, at("push", "refs/tags/v1.2.3"))).toBe(`build-refs/tags/v1.2.3-${SHA_A}`);
    expect(valueOf(group, at("workflow_dispatch", "refs/heads/main"))).toBe(`build-refs/heads/main-${SHA_A}`);
  });

  it("every job holding a signing secret runs in the release environment", () => {
    const holders = [build, android, feeds].flatMap((t) => jobsOf(t).filter((j) => SIGNING.test(exec(j.body))).map((j) => j.name));
    expect(holders, "the census found no key-holding job").toEqual(["macos-sign", "sign", "sign"]);
    for (const t of [build, android, feeds]) expect(keysOutsideRelease(t)).toEqual([]);
  });

  it("a feeds recovery runs ON the tag and takes main's tools; a release event takes the tag's", () => {
    const expr = toolsRefOf(feeds);
    expect(expr, "the tools checkout names no ref").not.toBeNull();
    const at = (event: string, tools: string | null) =>
      evaluate(expr!, { "github.event_name": event, "inputs.tools": tools, "github.ref": "refs/tags/v1.2.3" });
    expect(at("release", null)).toBe("refs/tags/v1.2.3");
    expect(at("workflow_dispatch", "main")).toBe("main");
    expect(at("workflow_dispatch", "tag")).toBe("refs/tags/v1.2.3");
    expect(feeds).toMatch(/\n {6}tools:\n(?: {8}.*\n)*? {8}default: main\n {8}type: choice\n {8}options: \[main, tag\]\n/);
  });

  it("each reader is watched failing on the shape it guards", () => {
    expect(triggersOf(build.replace("  merge_group:\n", ""))).not.toContain("merge_group");
    /* Cancelling everywhere cancels the tag's run. */
    const always = concurrencyOf(build.replace(`cancel-in-progress: ${CANCEL}`, "cancel-in-progress: true"));
    expect(concurrencyFindings(always, "build")).toEqual(["cancels beyond a pull request and a push to main: true"]);
    expect(concurrencyRuns(always, "build")).toEqual(KEPT.map((r) => `build: ${r.label} cancels the run before it`));
    /* A group without the commit: two runs of one tag share it. */
    const noSha = concurrencyOf(build.replace(" || github.sha }}", " }}"));
    expect(noSha.group).not.toBe(groupOf("build"));
    expect(concurrencyRuns(noSha, "build")).toContain("build: a v* tag shares its group with another commit's run");
    expect(concurrencyFindings(concurrencyOf(build.replace(`group: ${groupOf("build")}`, "group: build-${{ github.ref }}")), "build"))
      .toEqual(["a run on a tag or a merge group can share its group: build-${{ github.ref }}"]);
    /* android.yml left on the block before main's runs were superseded. */
    const before = android
      .replace(`group: ${groupOf("android")}`, "group: android-${{ github.ref }}-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}")
      .replace(`cancel-in-progress: ${CANCEL}`, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(before).not.toBe(android);
    expect(concurrencyRuns(concurrencyOf(before), "android")).toEqual([
      "android: a push to main and the next push to main do not share a group",
      "android: the next push to main does not cancel a push to main",
    ]);
    /* A pull request's group without the pull request: every pull request shares one. */
    expect(concurrencyRuns(concurrencyOf(build.replace("-${{ github.ref }}-", "-")), "build")).toContain("build: two pull requests share a group");
    expect(valueOf("x-${{ github.ref }}-${{ github.sha }}", { "github.ref": "r", "github.sha": "s" })).toBe("x-r-s");
    expect(valueOf("${{ github.ref == 'r' }}", { "github.ref": "r" })).toBe(true);
    expect(keysOutsideRelease(android.replace("    environment: release\n", ""))).toEqual(["sign"]);
    expect(keysOutsideRelease(feeds.replace("    environment: release\n", ""))).toEqual(["sign"]);
    expect(keysOutsideRelease(build.replace(/^ {4}environment: .+\n/m, ""))).toEqual(["macos-sign"]);
    /* The tools checkout as it was, attempt and retry (no ref: the launching ref, which is the tag on a recovery). */
    expect(toolsRefOf(feeds.replace(/\n {10}ref: \$\{\{ github\.event_name == 'workflow_dispatch'[^\n]*\n/g, "\n"))).toBeNull();
    expect(() => evaluate("github.ref || runner.os", { "github.ref": "x" })).toThrow(/unknown context runner\.os/);
    /* A key named only in a comment is not read: the census reads executed lines. */
    expect(keysOutsideRelease("jobs:\n  x:\n    steps:\n      # ${{ secrets.ANDROID_KEYSTORE_B64 }}\n")).toEqual([]);
  });
});
