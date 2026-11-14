import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
 * changes one, unless the BASE's `.github/scripts/admitted-fonts.tsv` names that file by path and sha256 and its
 * licence text is in the tree. A maintainer's `publish/<utc>-<sha12>` branch is otherwise admitted whole; any other pull request is
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

  it("refuses an outside change to the tools' own files, and admits a maintainer's", () => {
    for (const path of ["tools/borders.json", "tools/baseline.tsv", "eslint.config.mjs", "stylelint.config.mjs", ".prettierrc.json", ".prettierignore"]) {
      const w = world({ [path]: "changed\n" });
      const r = guard(w, fromFork());
      expect(r.rc, `${path}\n${r.out}`).toBe(1);
      expect(r.out).toContain(`    ${path}\n`);
      expect(guard(w, fromHere("pr/tools")).rc).toBe(0);
    }
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
      expect(r.out).toMatch(/carries only the typefaces `\.github\/scripts\/admitted-fonts\.tsv` names, by path and sha256/);
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

  it("refuses a font a side branch adds and a merge brings in, naming the commit that adds it and not the merge", () => {
    const w = world({ "a.txt": "b\n" });
    g(w.r, "checkout", "-q", "-b", "side", w.base);
    writeFileSync(join(w.r, "side.ttf"), ""); g(w.r, "add", "-A"); g(w.r, "commit", "-q", "--no-verify", "-m", "docs: side");
    const side = g(w.r, "rev-parse", "HEAD");
    g(w.r, "checkout", "-q", "topic");
    g(w.r, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
    g(w.r, "rm", "-q", "--", "side.ttf"); g(w.r, "commit", "-q", "--no-verify", "-m", "docs: drop it");
    const r = guard({ ...w, head: g(w.r, "rev-parse", "HEAD") }, fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(named(r.out)).toEqual([`, in commit ${side.slice(0, 12)}`]);
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

/* ── The admitted typefaces: six fixture files under the real paths, listed on the fixture's main. ── */
const LIST = ".github/scripts/admitted-fonts.tsv";
const HEADER = "path\tsha256\tlicence\n";
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const FACES = ["bricolage-latin-ext", "bricolage-latin", "hanken-latin-ext", "hanken-latin", "jetbrains-latin-ext", "jetbrains-latin"];
const facePath = (face: string) => `packages/tokens/fonts/${face}.woff2`;
const faceBytes = (face: string) => Buffer.concat([Buffer.from("wOF2"), Buffer.from([0, 1, 0, 0]), Buffer.from(face)]);
const licenceOf = (face: string) => `packages/tokens/fonts/OFL-${face.split("-")[0]}.txt`;
const row = (path: string, bytes: string | Uint8Array, licence: string) => `${path}\t${sha256(bytes)}\t${licence}\n`;
const SIX: Files = Object.fromEntries(FACES.map((f) => [facePath(f), faceBytes(f)]));
const LICENCES: Files = Object.fromEntries(FACES.map((f) => [licenceOf(f), "Copyright the authors\n"]));
const LISTED = HEADER + FACES.map((f) => row(facePath(f), faceBytes(f), licenceOf(f))).join("");
const ON_MAIN: Files = { [LIST]: LISTED };
/** What a refusal names: its indented lines. */
const refused = (out: string) => (out.match(/^ {4}.*$/gm) ?? []).map((l) => l.slice(4));
const inCommit = (out: string) => out.match(/, in commit [0-9a-f]{12}/g) ?? [];
/** One more commit on the branch, made in the index alone: a mode or a name no file system here has to carry. */
function planted(w: { r: string; base: string; head: string }, mode: string, bytes: string | Uint8Array, path: string) {
  const oid = execFileSync("git", ["-C", w.r, "hash-object", "-w", "--stdin"], { input: bytes, env: ENV, encoding: "utf8" }).trim();
  g(w.r, "update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`);
  g(w.r, "commit", "-q", "--no-verify", "-m", "docs: planted");
  return { ...w, head: g(w.r, "rev-parse", "HEAD") };
}

describe("the typefaces the base's list admits, by path and by sha256", () => {
  it("admits the six listed files with their licence texts, from a fork, a pr/ branch and a publish", () => {
    const w = world({ ...SIX, ...LICENCES }, "feat: the typefaces", ON_MAIN);
    for (const pr of [fromFork(), fromHere("pr/x"), publish]) {
      const r = guard(w, pr);
      expect(r.rc, r.out).toBe(0);
      expect(r.out).toContain(`guard: admitted typefaces: 6 row(s) read from ${w.base.slice(0, 12)}:${LIST}\n`);
    }
    expect(guard(w, fromFork()).out).toMatch(/ADMITTED — paula\/ohmail:topic changes none of .*, and carries no Monorepo-Commit: line and no font file beyond the admitted\n$/);
  });

  it("refuses a seventh file beside them, and names it alone", () => {
    const seventh = "packages/tokens/fonts/seventh.woff2";
    const r = guard(world({ ...SIX, ...LICENCES, [seventh]: faceBytes("seventh") }, "feat: seven", ON_MAIN), fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(refused(r.out)).toEqual([`${seventh} — not admitted`]);
    expect(r.out).toMatch(/REFUSED — paula\/ohmail:topic, 1 reason\(s\) above/);
  });

  it("refuses one of the six with its last byte changed, for a maintainer too, and names no other", () => {
    const bytes = Buffer.from(faceBytes("hanken-latin"));
    bytes[bytes.length - 1]! ^= 1;
    const w = world({ ...SIX, ...LICENCES, [facePath("hanken-latin")]: bytes }, "feat: a changed byte", ON_MAIN);
    for (const pr of [fromFork(), fromHere("pr/x"), publish]) {
      const r = guard(w, pr);
      expect(r.rc, r.out).toBe(1);
      expect(refused(r.out)).toEqual([`${facePath("hanken-latin")} — other bytes than admitted (sha256 ${sha256(bytes).slice(0, 12)}…)`]);
    }
  });

  it("refuses the listed bytes at another path, and at the listed path in upper case", () => {
    for (const p of ["assets/bricolage-latin.woff2", facePath("bricolage-latin").toUpperCase()]) {
      const r = guard(world({ [p]: faceBytes("bricolage-latin") }, "feat: elsewhere", ON_MAIN), fromFork());
      expect(r.rc, `${p}: ${r.out}`).toBe(1);
      expect(refused(r.out)).toEqual([`${p} — not admitted`]);
    }
  });

  it("reads the list from the base alone: a pull request cannot admit its own file", () => {
    const p = facePath("extra");
    const own: Files = { [LIST]: LISTED + row(p, faceBytes("extra"), licenceOf("bricolage-latin")), ...SIX, ...LICENCES, [p]: faceBytes("extra") };
    const first = guard(world(own), fromHere("pr/x"));
    expect(first.rc, first.out).toBe(1);
    expect(first.out).toContain("guard: admitted typefaces: none (the base carries no list)\n");
    expect(refused(first.out)).toEqual([...FACES, "extra"].map(facePath).sort());
    const later = guard(world(own, "feat: a row and its file", ON_MAIN), fromHere("pr/x"));
    expect(later.rc, later.out).toBe(1);
    expect(refused(later.out)).toEqual([`${p} — not admitted`]);
  });

  it("refuses an admitted file whose licence text is not in the tree, and a change that deletes one", () => {
    const lic = licenceOf("hanken-latin");
    const want = ["hanken-latin-ext", "hanken-latin"].map((f) => `${lic} — the licence text of ${facePath(f)} is not in the tree`);
    const others: Files = Object.fromEntries(Object.entries(LICENCES).filter(([p]) => p !== lic));
    const missing = guard(world({ ...SIX, ...others }, "feat: two licences", ON_MAIN), fromFork());
    expect(missing.rc, missing.out).toBe(1);
    expect(refused(missing.out)).toEqual(want);
    const deleted = guard(chain([{ drop: [lic] }], { ...ON_MAIN, ...SIX, ...LICENCES }), fromFork());
    expect(deleted.rc, deleted.out).toBe(1);
    expect(refused(deleted.out)).toEqual(want);
    expect(deleted.out).toMatch(/REFUSED — paula\/ohmail:topic, 1 reason\(s\) above/);
  });

  it("refuses other bytes in an earlier commit though the head carries the listed ones, naming that commit alone", () => {
    const p = facePath("jetbrains-latin"), wrong = Buffer.from("wOF2 another face");
    const w = chain([{ files: { ...LICENCES, [p]: wrong } }, { files: { [p]: faceBytes("jetbrains-latin") } }], ON_MAIN);
    const r = guard(w, fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(inCommit(r.out)).toEqual([`, in commit ${w.shas[0]!.slice(0, 12)}`]);
    expect(refused(r.out)).toEqual([`${p}, in commit ${w.shas[0]!.slice(0, 12)} — other bytes than admitted (sha256 ${sha256(wrong).slice(0, 12)}…)`]);
    /* The control: the listed bytes in both commits. */
    const twice = chain([{ files: { ...LICENCES, [p]: faceBytes("jetbrains-latin") } }, { files: { "a.txt": "b\n" } }], ON_MAIN);
    expect(guard(twice, fromFork()).rc).toBe(0);
  });

  it("refuses a list it cannot read whole, naming the line, on a pull request that carries no font at all", () => {
    const sum = sha256("x"), p = facePath("a"), lic = licenceOf("a");
    const lists: [string, string, number][] = [
      ["a sum of 63 digits", `${HEADER}${p}\t${sum.slice(1)}\t${lic}\n`, 2],
      ["a sum in capitals", `${HEADER}${p}\t${sum.toUpperCase()}\t${lic}\n`, 2],
      ["a .. segment", `${HEADER}packages/../a.woff2\t${sum}\t${lic}\n`, 2],
      ["a .. segment in the licence", `${HEADER}${p}\t${sum}\tpackages/../OFL.txt\n`, 2],
      ["a missing column", `${HEADER}${p}\t${sum}\n`, 2],
      ["another kind", `${HEADER}packages/tokens/fonts/a.ttf\t${sum}\t${lic}\n`, 2],
      ["a pattern for a path", `${HEADER}packages/tokens/fonts/*.woff2\t${sum}\t${lic}\n`, 2],
      ["a comment", `${HEADER}# the faces\n${row(p, "x", lic)}`, 2],
      ["a blank line", `${HEADER}${row(p, "x", lic)}\n${row(facePath("b"), "y", lic)}`, 3],
      ["a blank line at the end", `${HEADER}${row(p, "x", lic)}\n`, 3],
      ["line ends of another system", `${HEADER}${row(p, "x", lic)}`.replace(/\n/g, "\r\n"), 1],
      ["a font for a licence text", `${HEADER}${p}\t${sum}\t${facePath("b")}\n`, 2],
      ["another header", `path\tsha256\n${row(p, "x", lic)}`, 1],
      ["no header", row(p, "x", lic), 1],
      ["a row twice", `${HEADER}${row(p, "x", lic).repeat(2)}`, 3],
    ];
    for (const [what, text, line] of lists) {
      const r = guard(world({ "a.txt": "b\n" }, "docs: a change", { [LIST]: text }), fromFork());
      expect(r.rc, `${what}: ${r.out}`).toBe(2);
      expect(r.out, what).toMatch(new RegExp(`^guard: [0-9a-f]{12}:${esc(LIST)}, line ${line}: `, "m"));
      expect(r.out, what).not.toMatch(/ADMITTED/);
    }
    /* The control: a header and no row is a list that admits nothing. */
    const empty = guard(world({ "a.txt": "b\n" }, "docs: a change", { [LIST]: HEADER }), fromFork());
    expect(empty.rc, empty.out).toBe(0);
    expect(empty.out).toMatch(/admitted typefaces: 0 row\(s\) read from /);
  });

  it("refuses all six while the base carries no list (the control)", () => {
    const r = guard(world({ ...SIX, ...LICENCES }), fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(refused(r.out)).toEqual(FACES.map(facePath));
    expect(r.out).toMatch(/REFUSED — paula\/ohmail:topic, 1 reason\(s\) above/);
  });

  it("refuses a link at a listed path whose target text is the listed bytes, and a second version only once it has a row", () => {
    const p = facePath("bricolage-latin");
    const link = guard(planted(world({ ...LICENCES }, "feat: licences", ON_MAIN), "120000", faceBytes("bricolage-latin"), p), fromFork());
    expect(link.rc, link.out).toBe(1);
    expect(refused(link.out)).toEqual([`${p} — not a regular file`]);
    /* A list is a set of pairs: the row of a new version stands beside the old one's while both are in the history. */
    const next = Buffer.from("wOF2 the next version");
    const files: Files = { ...SIX, ...LICENCES, [p]: next };
    expect(guard(world(files, "feat: a new version", ON_MAIN), fromFork()).rc).toBe(1);
    const both = guard(world(files, "feat: a new version", { [LIST]: LISTED + row(p, next, licenceOf("bricolage-latin")) }), fromFork());
    expect(both.rc, both.out).toBe(0);
    expect(both.out).toMatch(/admitted typefaces: 7 row\(s\) read from /);
  });

  it("admits a branch that merged the base while an earlier version was listed, once it merges the base again", () => {
    const p = facePath("hanken-latin"), lic = licenceOf("hanken-latin");
    const old = faceBytes("hanken-latin"), next = Buffer.from("wOF2 the next version");
    const w = world({ "mine.txt": "1\n" }, "docs: mine", { [LIST]: HEADER + row(p, old, lic) });
    const onMain = (files: Files, message: string) => {
      g(w.r, "checkout", "-q", "main");
      for (const [path, c] of Object.entries(files)) {
        mkdirSync(join(w.r, path, ".."), { recursive: true });
        writeFileSync(join(w.r, path), c);
      }
      g(w.r, "add", "-A"); g(w.r, "commit", "-q", "--no-verify", "-m", message);
      const sha = g(w.r, "rev-parse", "HEAD");
      g(w.r, "checkout", "-q", "topic");
      return sha;
    };
    const mergeMain = () => { g(w.r, "merge", "-q", "--no-ff", "-m", "Merge branch 'main' into topic", "main"); return g(w.r, "rev-parse", "HEAD"); };
    onMain({ [p]: old, [lic]: "Copyright the authors\n" }, "feat: the typeface");
    const first = mergeMain();
    /* The next version, in the order the script's header gives: its row, its bytes, then the old row leaves. */
    onMain({ [LIST]: HEADER + row(p, old, lic) + row(p, next, lic) }, "ci: the row of the next version");
    onMain({ [p]: next }, "feat: the next version");
    const base = onMain({ [LIST]: HEADER + row(p, next, lic) }, "ci: the old row leaves");
    /* Until the branch merges the base again its tree carries the old bytes: refused, and told what clears it. */
    const stale = guard({ ...w, base, head: first }, fromFork());
    expect(stale.rc, stale.out).toBe(1);
    expect(refused(stale.out)).toEqual([`${p} — other bytes than admitted (sha256 ${sha256(old).slice(0, 12)}…)`]);
    expect(stale.out).toMatch(/merge\n? *the base branch into it, or rebase on it, and push/);
    /* After it: the old bytes are in the first merge alone, and that merge only carries what main carried. */
    const updated = guard({ ...w, base, head: mergeMain() }, fromFork());
    expect(updated.rc, updated.out).toBe(0);
    expect(updated.out).toMatch(/ADMITTED — paula\/ohmail:topic /);
    /* Bytes a merge writes by itself at that path are the merge's own, though both parents carry a file there. */
    const wrong = Buffer.from("wOF2 another face");
    const later = onMain({ "b.txt": "b\n" }, "docs: more");
    execFileSync("git", ["-C", w.r, "merge", "-q", "--no-ff", "--no-commit", "main"], { env: ENV, stdio: "ignore" });
    writeFileSync(join(w.r, p), wrong); g(w.r, "add", "-A"); g(w.r, "commit", "-q", "--no-verify", "-m", "Merge branch 'main' into topic");
    const own = g(w.r, "rev-parse", "HEAD");
    writeFileSync(join(w.r, p), next); g(w.r, "add", "-A"); g(w.r, "commit", "-q", "--no-verify", "-m", "docs: put it back");
    const r = guard({ ...w, base: later, head: g(w.r, "rev-parse", "HEAD") }, fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(refused(r.out)).toEqual([`${p}, in commit ${own.slice(0, 12)} — other bytes than admitted (sha256 ${sha256(wrong).slice(0, 12)}…)`]);
  });

  it.skipIf(process.platform === "win32")("prints a name that carries a line break on one line", () => {
    const r = guard(planted(world({ "a.txt": "b\n" }), "100644", "", "x\nguard: ADMITTED — forged.ttf"), fromFork());
    expect(r.rc, r.out).toBe(1);
    expect(refused(r.out)).toEqual(["x?guard: ADMITTED — forged.ttf"]);
    expect(r.out).not.toMatch(/^guard: ADMITTED/m);
  });

  it("the list this repository carries: six rows under packages/tokens/fonts, three licence texts, sorted, and read whole", () => {
    const text = readFileSync(resolve(ROOT, publicRel("github/scripts/admitted-fonts.tsv")), "utf8");
    const lines = text.split("\n");
    expect(lines[0]).toBe(HEADER.trimEnd());
    expect(lines.pop()).toBe("");
    const rows = lines.slice(1).map((l) => l.split("\t"));
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r).toHaveLength(3);
      expect(r[0]).toMatch(/^packages\/tokens\/fonts\/[a-z0-9-]+\.woff2$/);
      expect(r[1]).toMatch(/^[0-9a-f]{64}$/);
      expect(r[2]).toMatch(/^packages\/tokens\/fonts\/OFL-[A-Za-z]+\.txt$/);
    }
    expect(rows.map((r) => r[0])).toEqual(rows.map((r) => r[0]).sort());
    expect(new Set(rows.map((r) => r[0])).size).toBe(6);
    expect(new Set(rows.map((r) => r[2])).size).toBe(3);
    const r = guard(world({ "a.txt": "b\n" }, "docs: a change", { [LIST]: text }), fromFork());
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toMatch(/admitted typefaces: 6 row\(s\) read from /);
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
