import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE GUARD CHECK: THE WORKFLOWS, THEIR TOOLS AND THE GATE CHANGE ONLY ON A MAINTAINER BRANCH OF THIS REPOSITORY.
 *
 * Every pull request is refused when its tree holds a file of a font kind, or any commit it would merge adds or
 * changes one. A maintainer's `publish/<utc>-<sha12>` branch is otherwise admitted whole; any other pull request is
 * refused when it changes `.github/`, `scripts/` or `.gate/` and is not a maintainer's `pr/<name>` branch, or
 * carries a `Monorepo-Commit:` line.
 * The script is driven over real fixture histories; the workflow is read as text for the properties that keep it
 * safe under `pull_request_target`: the base's checker, read-only permissions, no pull-request text in `run:`.
 */
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = resolve(ROOT, publicRel("github/scripts/assert-pr-guard.sh"));
const WORKFLOW = resolve(ROOT, publicRel("github/workflows/guard.yml"));
/** The job name, which becomes a required context of the main ruleset once it has run green. */
export const GUARD_CONTEXT = "the workflows, their tools and the gate change only on a maintainer branch of this repository";
const SLUG = "trafficflowhq/ohmail";
const PUBLISH_REF = "publish/20261013T120000Z-abcdefabcdef";

const W = mkdtempSync(join(tmpdir(), "pr-guard-"));
afterAll(() => rmSync(W, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Paula", GIT_AUTHOR_EMAIL: "paula@example.invalid",
  GIT_COMMITTER_NAME: "Paula", GIT_COMMITTER_EMAIL: "paula@example.invalid" };
const g = (repo: string, ...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: ENV }).trim();

type Files = Record<string, string | Uint8Array>;
let n = 0;
/** A main with the four kinds of path (and `onMain`), and a branch from it changing `files` with `message`. */
function world(files: Files, message = "docs: a change", onMain: Files = {}) {
  const r = join(W, `w${++n}`);
  execFileSync("git", ["init", "-q", "-b", "main", r], { env: ENV });
  for (const [p, c] of Object.entries({ "README.md": "readme\n", ".github/workflows/x.yml": "on: push\n", "scripts/t.mjs": "x\n", "a.txt": "a\n", ...onMain })) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), c);
  }
  g(r, "add", "-A"); g(r, "commit", "-q", "--no-verify", "-m", "main");
  const base = g(r, "rev-parse", "HEAD");
  g(r, "checkout", "-q", "-b", "topic");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), c);
  }
  g(r, "add", "-A"); g(r, "commit", "-q", "--no-verify", "--allow-empty", "-m", message);
  return { r, base, head: g(r, "rev-parse", "HEAD") };
}
function guard(w: { r: string; base: string; head: string }, pr: Record<string, unknown>) {
  const json = join(w.r, "..", `pr-${n}.json`);
  writeFileSync(json, JSON.stringify(pr));
  const env = { ...ENV, GUARD_REPO: SLUG, GITHUB_STEP_SUMMARY: "" };
  const res = spawnSync("bash", [SCRIPT, w.base, w.head, json], { cwd: w.r, encoding: "utf8", env });
  return { rc: res.status, out: `${res.stdout}${res.stderr}` };
}
const fromFork = (over: Record<string, unknown> = {}) => ({ title: "docs: a change", body: "", head: { ref: "topic", repo: { full_name: "paula/ohmail" } }, ...over });
/** A pull request a maintainer opened from a branch of this repository: a person, a member of the organization. */
const fromHere = (ref: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ title: "ci: a change", body: "", head: { ref, repo: { full_name: SLUG } }, user: { type: "User" }, author_association: "MEMBER", ...over });
const publish = { ...fromHere(PUBLISH_REF), title: "publish: 3 commit(s)", body: "x\n\nMonorepo-Commit: " + "b".repeat(40) };
/** One change to each of the three guarded directories. */
const MACHINERY: Files = { ".github/workflows/x.yml": "on: [push, merge_group]\n", "scripts/t.mjs": "y\n", ".gate/SCAN-BASELINE.tsv": "path\tline\n" };
/** A `world` (main, `onMain` on it), then one commit per step on its branch, each writing `files` and deleting `drop`. */
function chain(steps: { files?: Files; drop?: string[] }[], onMain: Files = {}) {
  const w = world({}, "docs: a start", onMain);
  const shas: string[] = [];
  steps.forEach((s, i) => {
    for (const [p, c] of Object.entries(s.files ?? {})) {
      mkdirSync(join(w.r, p, ".."), { recursive: true });
      writeFileSync(join(w.r, p), c);
    }
    for (const p of s.drop ?? []) g(w.r, "rm", "-q", "--", p);
    g(w.r, "add", "-A"); g(w.r, "commit", "-q", "--no-verify", "--allow-empty", "-m", `docs: step ${i + 1}`);
    shas.push(g(w.r, "rev-parse", "HEAD"));
  });
  return { ...w, head: shas[shas.length - 1] ?? w.head, shas };
}
const absent = (pr: Record<string, unknown>, key: string) => { const copy = { ...pr }; delete copy[key]; return copy; };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the guard script, over real fixture histories", () => {
  it("admits a publish from this repository, workflows, tools and trailers included", () => {
    const w = world({ ".github/workflows/x.yml": "on: [push, merge_group]\n", "scripts/t.mjs": "y\n" }, `fix: x\n\nMonorepo-Commit: ${"b".repeat(40)}`);
    expect(guard(w, publish)).toMatchObject({ rc: 0 });
    expect(guard(w, publish).out).toMatch(/ADMITTED — trafficflowhq\/ohmail:publish\/20261013T120000Z-abcdefabcdef is a publish/);
  });

  it("admits an outside change to anything else, with no Monorepo-Commit line (the positive control)", () => {
    const w = world({ "README.md": "a better readme\n", "a.txt": "b\n" });
    const r = guard(w, fromFork());
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toMatch(/ADMITTED — paula\/ohmail:topic changes none of \.github\/, scripts\/ and \.gate\//);
  });

  it("refuses a workflow or a tool from a fork, even one naming its branch publish/…, and from another branch here", () => {
    const wf = world({ ".github/workflows/x.yml": "on: push\njobs: {}\n" });
    const fork = guard(wf, fromFork({ head: { ref: PUBLISH_REF, repo: { full_name: "paula/ohmail" } } }));
    expect(fork.rc).toBe(1);
    expect(fork.out).toMatch(/changes the workflows, the tools they run or the push gate's baseline:\n {4}\.github\/workflows\/x\.yml/);
    expect(fork.out).toMatch(/Please leave them out/);
    const here = guard(wf, fromFork({ head: { ref: "docs/x", repo: { full_name: SLUG } } }));
    expect(here.rc).toBe(1);
    const tool = guard(world({ "scripts/t.mjs": "changed\n" }), fromFork());
    expect(tool.rc).toBe(1);
    expect(tool.out).toMatch(/ {4}scripts\/t\.mjs/);
    /* A deleted fork is not this repository either. */
    expect(guard(wf, fromFork({ head: { ref: PUBLISH_REF, repo: null } })).out).toMatch(/REFUSED — a deleted fork:/);
  });

  it("refuses an outside change to .gate/, the push gate's baseline, and admits a publish that carries one", () => {
    const w = world({ ".gate/SCAN-BASELINE.tsv": "path\tline\tclass\truling\thash\tnote\n" });
    const r = guard(w, fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(r.out).toMatch(/the push gate's baseline:\n {4}\.gate\/SCAN-BASELINE\.tsv/);
    expect(guard(w, publish)).toMatchObject({ rc: 0 });
  });

  it("refuses a Monorepo-Commit line in a commit, the title or the description, in any spelling", () => {
    const c = guard(world({ "a.txt": "c\n" }, `docs: c\n\nMonorepo-Commit: ${"a".repeat(40)}`), fromFork());
    expect(c.rc).toBe(1);
    expect(c.out).toMatch(/a Monorepo-Commit: line in commit [0-9a-f]{12}\./);
    const t = guard(world({ "a.txt": "d\n" }), fromFork({ title: "monorepo commit: abc" }));
    expect(t.out).toMatch(/line in the title\./);
    /* A description with CRLF line ends, as the web form writes them, and a mid-line mention. */
    const d = guard(world({ "a.txt": "e\n" }), fromFork({ body: `Fixes a typo.\r\n\r\nsee Monorepo-Commit: ${"c".repeat(40)}\r\n` }));
    expect(d.rc).toBe(1);
    expect(d.out).toMatch(/line in the description\./);
    expect(d.out).toMatch(/git commit --amend/);
  });

  it("finds a line at the head of a description longer than a pipe buffer (the grep -q under pipefail trap)", () => {
    const body = `Monorepo-Commit: ${"d".repeat(40)}\n${"x".repeat(200_000)}\n`;
    const r = guard(world({ "a.txt": "f\n" }), fromFork({ body }));
    expect(r.rc, r.out).toBe(1);
    expect(r.out).toMatch(/line in the description\./);
  });

  it("says both reasons at once, and refuses an unreadable premise apart from a refusal", () => {
    const both = guard(world({ ".github/workflows/y.yml": "x\n" }, `ci: y\n\nMonorepo-Commit: ${"e".repeat(40)}`), fromFork());
    expect(both.out).toMatch(/REFUSED — paula\/ohmail:topic, 2 reason\(s\) above/);
    const w = world({ "a.txt": "g\n" });
    expect(guard({ ...w, base: "f".repeat(40) }, fromFork()).rc).toBe(2);
    const json = join(W, "not-an-object.json");
    writeFileSync(json, "[1]");
    expect(spawnSync("bash", [SCRIPT, w.base, w.head, json], { cwd: w.r, env: { ...ENV, GUARD_REPO: SLUG } }).status).toBe(2);
  });
});

describe("the door: a pr/ branch of this repository that a maintainer opened", () => {
  it("admits it changing all three directories, for OWNER, MEMBER and COLLABORATOR", () => {
    const w = world(MACHINERY);
    for (const association of ["MEMBER", "OWNER", "COLLABORATOR"]) {
      const r = guard(w, fromHere("pr/x", { author_association: association }));
      expect(r.rc, `${association}: ${r.out}`).toBe(0);
      expect(r.out).toMatch(/ADMITTED — trafficflowhq\/ohmail:pr\/x is a maintainer branch of this repository/);
    }
  });

  it("refuses it for any other association, and for none at all", () => {
    const w = world(MACHINERY);
    const prs = ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"].map((a) => fromHere("pr/x", { author_association: a }));
    for (const pr of [...prs, absent(fromHere("pr/x"), "author_association")]) {
      const r = guard(w, pr);
      expect(r.rc, `${String(pr.author_association)}: ${r.out}`).toBe(1);
      expect(r.out).toMatch(/baseline:\n {4}\.gate\/SCAN-BASELINE\.tsv\n {4}\.github\/workflows\/x\.yml\n {4}scripts\/t\.mjs\n/);
    }
  });

  it("refuses it when an app opened it, whatever its association, and when the opener is unknown", () => {
    const w = world(MACHINERY);
    for (const association of ["MEMBER", "OWNER", "COLLABORATOR"]) {
      const r = guard(w, fromHere("pr/x", { author_association: association, user: { login: "an-app[bot]", type: "Bot" } }));
      expect(r.rc, `${association}: ${r.out}`).toBe(1);
      expect(r.out).toMatch(/REFUSED — trafficflowhq\/ohmail:pr\/x, 1 reason\(s\) above/);
    }
    expect(guard(w, absent(fromHere("pr/x"), "user")).rc).toBe(1);
  });

  it("refuses a maintainer's other branch here, and a maintainer's own fork", () => {
    const w = world(MACHINERY);
    for (const ref of ["docs/x", "pr/a/b", "pr/", "publish/x"]) {
      const r = guard(w, fromHere(ref));
      expect(r.rc, `${ref}: ${r.out}`).toBe(1);
      expect(r.out).toMatch(/Those files change only on a maintainer branch of this repository\./);
    }
    const fork = guard(w, fromHere("pr/x", { head: { ref: "pr/x", repo: { full_name: "paula/ohmail" } } }));
    expect(fork.rc, fork.out).toBe(1);
    expect(fork.out).toMatch(/REFUSED — paula\/ohmail:pr\/x, 1 reason\(s\) above/);
  });

  it("still refuses a Monorepo-Commit line there, in a commit, the title or the description, for one reason", () => {
    const line = `Monorepo-Commit: ${"a".repeat(40)}`;
    const runs = [
      guard(world(MACHINERY, `ci: x\n\n${line}`), fromHere("pr/x")),
      guard(world(MACHINERY), fromHere("pr/x", { title: line })),
      guard(world(MACHINERY), fromHere("pr/x", { body: `x\n\n${line}` })),
    ];
    for (const r of runs) {
      expect(r.rc, r.out).toBe(1);
      expect(r.out).toMatch(/REFUSED — trafficflowhq\/ohmail:pr\/x, 1 reason\(s\) above/);
      expect(r.out).toMatch(/That line belongs to the repository's publishing history, and only a maintainer's publish branch\n {2}carries it\./);
    }
    expect(runs.map((r) => /line in (commit [0-9a-f]{12}|the title|the description)\./.exec(r.out)?.[1]?.replace(/ [0-9a-f]{12}$/, "")))
      .toEqual(["commit", "the title", "the description"]);
  });

  it("refuses a publish/ branch from a fork, or opened by an app or by someone not a maintainer", () => {
    const w = world({ ".github/workflows/x.yml": "on: [push, merge_group]\n" }, `fix: x\n\nMonorepo-Commit: ${"b".repeat(40)}`);
    const fork = guard(w, { ...publish, head: { ref: PUBLISH_REF, repo: { full_name: "paula/ohmail" } } });
    expect(fork.rc, fork.out).toBe(1);
    const app = guard(w, { ...publish, user: { type: "Bot" } });
    expect(app.rc, app.out).toBe(1);
    expect(app.out).toMatch(/REFUSED — trafficflowhq\/ohmail:publish\/20261013T120000Z-abcdefabcdef, 2 reason\(s\) above/);
    expect(guard(w, { ...publish, author_association: "CONTRIBUTOR" }).rc).toBe(1);
  });
});

describe("a file of a font kind, anywhere in the head's tree", () => {
  it("refuses an empty .ttf, a .woff2 carrying NULs and an upper-case .TTF, naming each", () => {
    const fonts: Files = { "x/y.ttf": "", "z.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]), "A.TTF": "true" };
    for (const [p, c] of Object.entries(fonts)) {
      const r = guard(world({ [p]: c }), fromFork());
      expect(r.rc, `${p}: ${r.out}`).toBe(1);
      expect(r.out).toMatch(new RegExp(`a file of a font kind:\\n {4}${esc(p)}\\n`));
      expect(r.out).toMatch(/distributes no Font Software \(COPYRIGHT says why\)/);
      expect(r.out).toMatch(/REFUSED — paula\/ohmail:topic, 1 reason\(s\) above/);
    }
  });

  it("admits an .svg and a .png (the positive control)", () => {
    const controls: Files[] = [
      { "icons/mark.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>\n' },
      { "icons/mark.png": Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") },
    ];
    for (const files of controls) {
      const r = guard(world(files), fromFork());
      expect(r.rc, r.out).toBe(0);
    }
  });

  it("reads a name git quotes, a font already on main, and a maintainer's pr/ and publish/ branches", () => {
    for (const p of ['with"quote.ttf', "Schrift-ä.otf"]) expect(guard(world({ [p]: "" }), fromFork()).rc, p).toBe(1);
    const old = guard(world({ "a.txt": "b\n" }, "docs: a change", { "assets/old.dfont": "" }), fromFork());
    expect(old.rc, old.out).toBe(1);
    expect(old.out).toMatch(/font kind:\n {4}assets\/old\.dfont\n/);
    const w = world({ "fonts/x.otf": "" });
    expect(guard(w, fromHere("pr/x")).out).toMatch(/REFUSED — trafficflowhq\/ohmail:pr\/x, 1 reason\(s\) above/);
    expect(guard(w, publish).out).toMatch(/REFUSED — trafficflowhq\/ohmail:publish\/20261013T120000Z-abcdefabcdef, 1 reason\(s\) above/);
  });
});

describe("a file of a font kind in any commit the merge would keep, though not in the head", () => {
  const named = (out: string) => out.match(/, in commit [0-9a-f]{12}/g) ?? [];
  it("refuses a font added and deleted again, naming the path and the commit that adds it", () => {
    const w = chain([{ files: { "Inter-Bold.ttf": "" } }, { drop: ["Inter-Bold.ttf"] }]);
    expect(g(w.r, "ls-tree", "-r", "--name-only", w.head)).not.toMatch(/\.ttf/);
    const r = guard(w, fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(r.out).toMatch(new RegExp(`font kind:\\n {4}Inter-Bold\\.ttf, in commit ${w.shas[0].slice(0, 12)}\\n`));
    expect(r.out).toMatch(/take\n? *it out of the commit that adds it \(git rebase -i\)/);
    expect(r.out).toMatch(/REFUSED — paula\/ohmail:topic, 1 reason\(s\) above/);
  });

  it("refuses a font only a middle commit carries, and names that commit alone", () => {
    const w = chain([{ files: { "a.txt": "b\n" } }, { files: { "fonts/m.woff2": "wOF2" } }, { drop: ["fonts/m.woff2"] }]);
    const r = guard(w, fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(named(r.out)).toEqual([`, in commit ${w.shas[1].slice(0, 12)}`]);
    expect(r.out).toMatch(/ {4}fonts\/m\.woff2, in commit/);
  });

  it("refuses a font a merge commit adds by itself, and one in a root commit of an unrelated history", () => {
    const w = world({ "a.txt": "b\n" });
    g(w.r, "checkout", "-q", "-b", "side", w.base);
    writeFileSync(join(w.r, "s.txt"), "s\n"); g(w.r, "add", "-A"); g(w.r, "commit", "-q", "--no-verify", "-m", "docs: side");
    g(w.r, "checkout", "-q", "topic");
    execFileSync("git", ["-C", w.r, "merge", "-q", "--no-ff", "--no-commit", "side"], { env: ENV, stdio: "ignore" });
    writeFileSync(join(w.r, "evil.ttf"), ""); g(w.r, "add", "evil.ttf"); g(w.r, "commit", "-q", "--no-verify", "-m", "Merge side");
    const merge = g(w.r, "rev-parse", "HEAD");
    g(w.r, "rm", "-q", "--", "evil.ttf"); g(w.r, "commit", "-q", "--no-verify", "-m", "docs: drop it");
    const m = guard({ ...w, head: g(w.r, "rev-parse", "HEAD") }, fromFork());
    expect(m.rc, m.out).toBe(1);
    expect(named(m.out)).toEqual([`, in commit ${merge.slice(0, 12)}`]);
    g(w.r, "checkout", "-q", "--orphan", "other"); g(w.r, "rm", "-rfq", ".");
    writeFileSync(join(w.r, "root.ttf"), ""); g(w.r, "add", "-A"); g(w.r, "commit", "-q", "--no-verify", "-m", "docs: a root");
    const root = g(w.r, "rev-parse", "HEAD");
    g(w.r, "rm", "-q", "--", "root.ttf"); writeFileSync(join(w.r, "b.txt"), "b\n"); g(w.r, "add", "-A");
    g(w.r, "commit", "-q", "--no-verify", "-m", "docs: drop it");
    const o = guard({ ...w, head: g(w.r, "rev-parse", "HEAD") }, fromHere("pr/x"));
    expect(o.rc, o.out).toBe(1);
    expect(named(o.out)).toEqual([`, in commit ${root.slice(0, 12)}`]);
  });

  it("reaches a maintainer's pr/ and publish/ branches", () => {
    const w = chain([{ files: { "fonts/x.otf": "" } }, { drop: ["fonts/x.otf"] }]);
    expect(guard(w, fromHere("pr/x")).out).toMatch(/REFUSED — trafficflowhq\/ohmail:pr\/x, 1 reason\(s\) above/);
    expect(guard(w, publish).out).toMatch(/REFUSED — trafficflowhq\/ohmail:publish\/20261013T120000Z-abcdefabcdef, 1 reason\(s\) above/);
  });

  it("admits a picture added and deleted again, and the commit that removes a font already on main (the controls)", () => {
    const png = guard(chain([{ files: { "icons/a.png": Buffer.from("89504e470d0a1a0a", "hex") } }, { drop: ["icons/a.png"] }]), fromFork());
    expect(png.rc, png.out).toBe(0);
    const removal = guard(chain([{ files: { "a.txt": "c\n" } }, { drop: ["assets/old.dfont"] }], { "assets/old.dfont": "" }), fromFork());
    expect(removal.rc, removal.out).toBe(0);
  });
});

/** The guard workflow's own properties, read as text: what makes `pull_request_target` safe here. */
export function workflowFindings(text: string): string[] {
  const out: string[] = [];
  const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  if (!/\non:\n {2}pull_request_target:\n {4}types: \[[^\]]*\bedited\b[^\]]*\]\n {2}merge_group:\n/.test(code)) out.push("it does not run on pull_request_target (edited included) and merge_group");
  if (!/\npermissions:\n {2}contents: read\n {2}pull-requests: read\n\n/.test(code)) out.push("its permissions are not read-only");
  if (/\bwrite\b/.test(/\npermissions:\n((?: {2}.*\n)+)/.exec(code)?.[1] ?? "")) out.push("a write permission");
  if (!/ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/.test(code)) out.push("the checkout is not the base");
  if (/pull_request\.head\.(sha|ref)|refs\/guard\/head\s*$/m.test(code.split("\n").filter((l) => /^\s+ref:/.test(l)).join("\n"))) out.push("the pull request's head is checked out");
  /* No event text in a run block: only steps.*.outputs may be interpolated where the shell reads it. */
  const runs = [...code.matchAll(/\n( +)run: \|\n((?:\1 {2}.*\n|\n)+)|\n +run: (.+)/g)].map((m) => m[2] ?? m[3] ?? "");
  for (const r of runs) for (const e of r.match(/\$\{\{[^}]*\}\}/g) ?? []) if (!/^\$\{\{ steps\.subject\.outputs\.(base|head|pr) \}\}$/.test(e)) out.push(`an expression in a run block: ${e}`);
  if (!/run: bash \.github\/scripts\/assert-pr-guard\.sh /.test(code)) out.push("the base's assert-pr-guard.sh is not what decides");
  if (!new RegExp(`\\n {4}name: ${esc(GUARD_CONTEXT)}\\n`).test(code)) out.push("the job's name is not the context the ruleset will require");
  return out;
}

/* The sentences the guard printed while the workflows arrived from elsewhere, read case-blind. The needle is
 * assembled from its words so that this file never spells one. */
const PUBLISHER_PHRASES: [string, string][] = [["development", "repository"], ["publishing", "tool"], ["publishing", "script"]];
const PUBLISHER_SENTENCE = new RegExp(PUBLISHER_PHRASES.map(([a, b]) => `${a}\\s+${b}`).join("|"), "i");
export const publisherSentences = (text: string) => text.split("\n").filter((l) => PUBLISHER_SENTENCE.test(l)).length;

describe("the guard workflow", () => {
  const wf = readFileSync(WORKFLOW, "utf8");
  it("runs the base's checker with read-only permissions, and no pull-request text reaches a shell", () => {
    expect(workflowFindings(wf)).toEqual([]);
  });
  it("each property is watched failing", () => {
    expect(workflowFindings(wf.replace("  pull-requests: read\n", "  pull-requests: write\n"))).toContain("its permissions are not read-only");
    expect(workflowFindings(wf.replace("contents: read\n  pull-requests", "contents: write\n  pull-requests"))).toContain("a write permission");
    expect(workflowFindings(wf.replace('"${{ steps.subject.outputs.pr }}"', '"${{ github.event.pull_request.title }}"')))
      .toEqual(["an expression in a run block: ${{ github.event.pull_request.title }}"]);
    expect(workflowFindings(wf.replace("          base=\"$PR_BASE\"\n", "          base=\"$PR_BASE\" # ${{ github.event.pull_request.body }}\n")))
      .toEqual(["an expression in a run block: ${{ github.event.pull_request.body }}"]);
    expect(workflowFindings(wf.replace("github.event.pull_request.base.sha ||", "github.event.pull_request.head.sha ||"))).toContain("the checkout is not the base");
    expect(workflowFindings(wf.replace("types: [opened, synchronize, reopened, ready_for_review, edited]", "types: [opened, synchronize]")))
      .toEqual(["it does not run on pull_request_target (edited included) and merge_group"]);
  });
  it("names its job by the context the ruleset requires, never `guard`, the job's id", () => {
    expect(GUARD_CONTEXT).toBe("the workflows, their tools and the gate change only on a maintainer branch of this repository");
    expect(workflowFindings(wf.replace(`    name: ${GUARD_CONTEXT}\n`, "    name: guard\n")))
      .toEqual(["the job's name is not the context the ruleset will require"]);
  });
  it("carries none of the publisher's sentences, in either file, on a line or across one", () => {
    for (const f of [WORKFLOW, SCRIPT]) {
      const text = readFileSync(f, "utf8");
      expect(publisherSentences(text), f).toBe(0);
      expect(PUBLISHER_SENTENCE.test(text.replace(/[ \t]*\n[ \t]*(?:#[ \t]*)?/g, " ")), f).toBe(false);
    }
    /* The control: each phrase is seen, in any case. */
    for (const [a, b] of PUBLISHER_PHRASES) expect(publisherSentences(`it came from the ${a.toUpperCase()} ${b}.\n`), `${a} ${b}`).toBe(1);
  });
});
