import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * THE PUBLIC MAIN TAKES PULL REQUESTS, AND THE WORKFLOWS FOLLOW.
 *
 * A required check that does not run on `merge_group` leaves a merge queue waiting until it gives up;
 * a concurrency group that cancels on main or on a tag drops the run a release takes its installers
 * from; a job that holds a signing key outside the `release` environment can be made to run, key in
 * hand, from any branch; and a feeds recovery dispatched on the tag still takes main's tools. Nothing
 * here runs GitHub Actions, so the rules are read off the files, the tools ref evaluated as written.
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

/** Problems with a concurrency that must never cancel, nor replace, a run on main or a tag. */
export function concurrencyFindings(c: { group: string | null; cancel: string | null }, prefix: string): string[] {
  const out: string[] = [];
  if (c.cancel !== "${{ github.event_name == 'pull_request' }}") out.push(`cancels off a pull request: ${c.cancel}`);
  /* A group shared by two runs on main makes the second PENDING and drops any third: the commit keys it. */
  if (c.group !== `${prefix}-\${{ github.ref }}-\${{ github.event_name == 'pull_request' && 'pr' || github.sha }}`) {
    out.push(`a run on main or a tag can share its group: ${c.group}`);
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

  it("concurrency cancels only a pull request's superseded run", () => {
    expect(concurrencyFindings(concurrencyOf(build), "build")).toEqual([]);
    expect(concurrencyFindings(concurrencyOf(android), "android")).toEqual([]);
  });

  it("every job holding a signing secret runs in the release environment", () => {
    const holders = [build, android, feeds].flatMap((t) => jobsOf(t).filter((j) => SIGNING.test(exec(j.body))).map((j) => j.name));
    expect(holders, "the census found no key-holding job").toEqual(["macos", "sign", "sign"]);
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
    expect(concurrencyFindings(concurrencyOf(build.replace(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true")), "build"))
      .toEqual(["cancels off a pull request: true"]);
    expect(concurrencyFindings(concurrencyOf(build.replace(
      "group: build-${{ github.ref }}-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}", "group: build-${{ github.ref }}")), "build"))
      .toEqual(["a run on main or a tag can share its group: build-${{ github.ref }}"]);
    expect(keysOutsideRelease(android.replace("    environment: release\n", ""))).toEqual(["sign"]);
    expect(keysOutsideRelease(feeds.replace("    environment: release\n", ""))).toEqual(["sign"]);
    expect(keysOutsideRelease(build.replace(/^ {4}environment: .+\n/m, ""))).toEqual(["macos"]);
    /* The tools checkout as it was (no ref: the launching ref, which is the tag on a recovery). */
    expect(toolsRefOf(feeds.replace(/\n {10}ref: \$\{\{ github\.event_name == 'workflow_dispatch'[^\n]*\n/, "\n"))).toBeNull();
    expect(() => evaluate("github.ref || runner.os", { "github.ref": "x" })).toThrow(/unknown context runner\.os/);
    /* A key named only in a comment is not read: the census reads executed lines. */
    expect(keysOutsideRelease("jobs:\n  x:\n    steps:\n      # ${{ secrets.ANDROID_KEYSTORE_B64 }}\n")).toEqual([]);
  });
});
