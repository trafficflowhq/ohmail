import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  checkChangelog, fold, isDatedHeading, parseFragment, placeholdersByBlock, readChangelogText, readFragments, releasesFrom,
  withChangelogReleases,
} from "../scripts/changelog-fold.mjs";
import { ROOT, publicPath } from "./support/public-root.mjs";

/**
 * ONE FILE PER CHANGELOG ENTRY, GATHERED INTO CHANGELOG.md BY THE RELEASE BUMP.
 *
 * Every pull request used to write its entry under `## [Unreleased]`, so each landing left every other open
 * pull request CONFLICTING on CHANGELOG.md and cost it a CI cycle. A pull request now adds
 * `changelog.d/<slug>.md`; `scripts/changelog-fold.mjs --release <V> --date <D>` writes them into the new
 * version's section, in file-name order, rewrites the two link lines and the metainfo, and deletes them.
 * What must hold: two such pull requests merge cleanly in either order; the fold is deterministic; it
 * refuses a malformed fragment, a malformed [Unreleased] and a version that is not next, writing nothing;
 * it never follows a symbolic link out of the tree; and every reader of the changelog reads the result.
 */
const SCRIPT = join(ROOT, "scripts", "changelog-fold.mjs");
const SCOPE = publicPath("github/scripts/pr-build-scope.sh");
const URL_BASE = "https://github.com/trafficflowhq/ohmail";
const METAINFO = "apps/desktop/flatpak/app.ohmail.Desktop.metainfo.xml";
const POSIX = process.platform !== "win32";

const W = mkdtempSync(join(tmpdir(), "changelog-fragments-"));
afterAll(() => {
  // The partial-write case leaves a read-only directory behind; give it back its write bit so the tree can go.
  for (const d of readdirSync(W)) if (existsSync(join(W, d, "changelog.d"))) chmodSync(join(W, d, "changelog.d"), 0o755);
  rmSync(W, { recursive: true, force: true });
});
let n = 0;
const fresh = (tag: string) => { const d = join(W, `${tag}-${++n}`); mkdirSync(d); return d; };

const POINTER = [
  "What has changed since the last release is in [changelog.d/](changelog.d/), one file per change, until the",
  "release gathers those files into its own section below.",
];

/** A changelog of every shape the file has: preamble, pointer and Still to come, identity lines, a preview release. */
function changelog(newest = "0.27.5", unreleased: string[] = [], pointer = POINTER, link?: string): string {
  return [
    "# Changelog", "", "All notable changes to the ohmail desktop apps are recorded here.", "",
    "## [Unreleased]", "", ...pointer, "", ...unreleased, "### Still to come", "", "Signed installers.", "",
    `## [${newest}] — 2026-10-20`, "", "### The first start is faster", "<!-- changes: first-start.md -->", "",
    "The desktop app writes its store once.", "",
    "## [0.4.0-preview] — 2026-08-06", "", "**A lead.** Some text.", "", "### Added", "", "- a thing", "",
    "### Fixed", "", "- another thing", "",
    link ?? `[Unreleased]: ${URL_BASE}/compare/v${newest}...HEAD`,
    `[${newest}]: ${URL_BASE}/releases/tag/v${newest}`,
    `[0.4.0-preview]: ${URL_BASE}/releases/tag/v0.4.0-preview`, "",
  ].join("\n");
}

const META_EMPTY = '<?xml version="1.0"?>\n<component>\n  <releases>\n  </releases>\n</component>\n';
const metainfoFor = (text: string) => withChangelogReleases(META_EMPTY, text);

type Files = Record<string, string | Buffer>;
/** A repository-shaped tree: package.json at `version`, the changelog, the metainfo, changelog.d/ with `fragments`. */
function tree(fragments: Files, opts: { version?: string; text?: string; at?: string } = {}): string {
  const root = opts.at ?? fresh("tree");
  const text = opts.text ?? changelog();
  const files: Files = {
    "package.json": JSON.stringify({ name: "fixture", version: opts.version ?? "0.28.0" }, null, 2) + "\n",
    "CHANGELOG.md": text,
    [METAINFO]: metainfoFor(text),
    "changelog.d/README.md": "# changelog.d\n\nOne file per change.\n",
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), c); }
  // Written in reverse name order, so an order that follows creation or the directory listing shows.
  for (const [p, c] of Object.entries(fragments).reverse()) writeFileSync(join(root, "changelog.d", p), c);
  return root;
}

/** Every file under `root` with its bytes, for "nothing written, nothing deleted". */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[child] = "symlink";
      else if (e.isDirectory()) walk(child);
      else out[child] = readFileSync(join(root, child)).toString("base64");
    }
  };
  walk("");
  return out;
}

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: W, LC_ALL: "C", TZ: "UTC" };
function cli(root: string | null, ...args: string[]) {
  const argv = root === null ? [SCRIPT, ...args] : [SCRIPT, "--root", root, ...args];
  const r = spawnSync(process.execPath, argv, { encoding: "utf8", env: ENV });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}
const release = (root: string, v = "0.28.0", d = "2026-10-21") => cli(root, "--release", v, "--date", d);

const FRAGMENTS: Files = {
  "a-one-paragraph.md": "### One paragraph entry\n\nA single paragraph that\nwraps onto a second line.\n",
  "b-two-paragraphs.md": "### Two paragraphs\n\nThe first one.\n\nThe second one.\n",
  "c-a-list.md": "### A list\n\nIt now does:\n\n- one thing\n- another thing\n",
  "d-code-and-link.md": "### Code and a link\n\nRun `ohmail --flag` and read [the docs](https://example.com/x).\n\n```sh\nohmail --version\n```\n",
  "e-quoted-placeholder.md": '### A quoted template\n\nThe strip says "As of <date> · catching up" until it converges.\n',
  "f-crlf-bom.md": "﻿### Windows line endings\r\n\r\nWritten on Windows.\r\n",
};
const SECTION = [
  "## [0.28.0] — 2026-10-21", "",
  "### One paragraph entry", "", "A single paragraph that", "wraps onto a second line.", "",
  "### Two paragraphs", "", "The first one.", "", "The second one.", "",
  "### A list", "", "It now does:", "", "- one thing", "- another thing", "",
  "### Code and a link", "", "Run `ohmail --flag` and read [the docs](https://example.com/x).", "", "```sh", "ohmail --version", "```", "",
  "### A quoted template", "", 'The strip says "As of <date> · catching up" until it converges.', "",
  "### Windows line endings", "", "Written on Windows.", "", "",
].join("\n");
const HEADLINES = ["One paragraph entry", "Two paragraphs", "A list", "Code and a link", "A quoted template", "Windows line endings"];

/** The text a correct fold of FRAGMENTS into changelog() writes, spelled out. */
function golden(before = changelog()): string {
  const at = before.indexOf("## [0.27.5] — 2026-10-20");
  return (before.slice(0, at) + SECTION + before.slice(at)).replace(
    `[Unreleased]: ${URL_BASE}/compare/v0.27.5...HEAD\n`,
    `[Unreleased]: ${URL_BASE}/compare/v0.28.0...HEAD\n[0.28.0]: ${URL_BASE}/releases/tag/v0.28.0\n`,
  );
}

// ─── the merge scenario ─────────────────────────────────────────────────────────────────────────────
describe("two pull requests that each add an entry merge cleanly in either order", () => {
  const cfg = join(W, "empty-gitconfig");
  writeFileSync(cfg, "");
  const GIT_ENV = {
    ...ENV, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Paula", GIT_AUTHOR_EMAIL: "paula@example.invalid", GIT_COMMITTER_NAME: "Paula", GIT_COMMITTER_EMAIL: "paula@example.invalid",
  };
  const g = (r: string, ...a: string[]) => execFileSync("git", ["-C", r, ...a], { encoding: "utf8", env: GIT_ENV }).trim();
  const tryMerge = (r: string, branch: string) =>
    spawnSync("git", ["-C", r, "merge", "-q", "--no-ff", "--no-edit", "--no-verify", branch], { encoding: "utf8", env: GIT_ENV });
  const commitAll = (r: string, msg: string) => { g(r, "add", "-A"); g(r, "commit", "-q", "--no-verify", "-m", msg); };
  function repo(): string {
    const r = fresh("repo");
    g(W, "init", "-q", "-b", "main", r);
    tree({}, { at: r });
    commitAll(r, "main");
    return r;
  }
  function branch(r: string, name: string, from: string, files: Files) {
    g(r, "checkout", "-q", "-b", name, from);
    for (const [p, c] of Object.entries(files)) { mkdirSync(join(r, p, ".."), { recursive: true }); writeFileSync(join(r, p), c); }
    commitAll(r, name);
  }
  const A = { "changelog.d/screener-keeps-focus.md": "### The Screener keeps focus\n\nIt does.\n" };
  const B = { "changelog.d/a-faster-search.md": "### Search is faster\n\nIt is.\n" };

  it("A then B and B then A are clean, and both fold to the same bytes", () => {
    const r = repo();
    branch(r, "a", "main", A);
    branch(r, "b", "main", B);
    const folded: string[] = [];
    for (const [first, second] of [["a", "b"], ["b", "a"]]) {
      g(r, "checkout", "-q", "-b", `m-${first}${second}`, "main");
      expect(tryMerge(r, first).status, `merging ${first}`).toBe(0);
      expect(tryMerge(r, second).status, `merging ${second} after ${first}`).toBe(0);
      expect(readdirSync(join(r, "changelog.d")).sort()).toEqual(["README.md", "a-faster-search.md", "screener-keeps-focus.md"]);
      expect(release(r).rc).toBe(0);
      folded.push(readFileSync(join(r, "CHANGELOG.md"), "utf8"));
      g(r, "reset", "-q", "--hard");
      g(r, "clean", "-fdq");
    }
    expect(folded[0]).toBe(folded[1]);
    expect(folded[0]).toContain("### Search is faster\n\nIt is.\n\n### The Screener keeps focus\n\nIt does.\n\n## [0.27.5]");
  });

  it("a branch cut before a release bump merges cleanly after it", () => {
    const r = repo();
    branch(r, "landed", "main", A);
    g(r, "checkout", "-q", "main");
    expect(tryMerge(r, "landed").status).toBe(0);
    branch(r, "late", "main", B);
    g(r, "checkout", "-q", "main");
    expect(release(r).rc).toBe(0);
    commitAll(r, "release: 0.28.0");
    expect(tryMerge(r, "late").status).toBe(0);
    expect(readdirSync(join(r, "changelog.d")).sort()).toEqual(["README.md", "a-faster-search.md"]);
    expect(readFileSync(join(r, "CHANGELOG.md"), "utf8")).toContain("## [0.28.0] — 2026-10-21\n\n### The Screener keeps focus\n");
  });

  it("CONTROL: two entries written under [Unreleased] conflict, which is what this replaces", () => {
    const r = repo();
    const under = (entry: string) => ({ "CHANGELOG.md": changelog("0.27.5", [`### ${entry}`, "", "Text.", ""]) });
    branch(r, "a2", "main", under("The Screener keeps focus"));
    branch(r, "b2", "main", under("Search is faster"));
    g(r, "checkout", "-q", "-b", "m2", "main");
    expect(tryMerge(r, "a2").status).toBe(0);
    const second = tryMerge(r, "b2");
    expect(second.status, "the control arm merged cleanly: the harness proves nothing").not.toBe(0);
    expect(g(r, "diff", "--name-only", "--diff-filter=U")).toBe("CHANGELOG.md");
  });
});

// ─── the golden fold ────────────────────────────────────────────────────────────────────────────────
describe("--release folds every fragment into the new version's section", () => {
  it("writes exactly the expected text, deletes the fragments, keeps README.md, rewrites the metainfo", () => {
    const root = tree(FRAGMENTS);
    const r = release(root);
    expect(r.rc, r.err).toBe(0);
    const out = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(out).toBe(golden());
    expect(readdirSync(join(root, "changelog.d"))).toEqual(["README.md"]);
    const meta = readFileSync(join(root, METAINFO), "utf8");
    expect(meta).toBe(metainfoFor(out));
    expect(meta).toContain('<release version="0.28.0" date="2026-10-21">');
    expect(meta.indexOf("<li>One paragraph entry</li>")).toBeLessThan(meta.indexOf("<li>Windows line endings</li>"));
    expect(meta).toContain('<release version="0.27.5" date="2026-10-20">');
  });

  it("changes nothing outside the inserted section and the two link lines", () => {
    const before = changelog();
    const after = fold(before, readFragments(tree(FRAGMENTS)).fragments, "0.28.0", "2026-10-21");
    const kept = after.replace(SECTION, "").split("\n").filter((l) => !/^\[(Unreleased|0\.28\.0)\]: /.test(l));
    expect(kept).toEqual(before.split("\n").filter((l) => !/^\[Unreleased\]: /.test(l)));
  });
});

// ─── determinism ────────────────────────────────────────────────────────────────────────────────────
describe("the fold is deterministic", () => {
  it("the same fragments created in another order give the same bytes", () => {
    const one = tree(FRAGMENTS);
    const other = fresh("tree");
    const shuffled = Object.fromEntries(Object.entries(FRAGMENTS).sort(([a], [b]) => (a.charCodeAt(2) % 3) - (b.charCodeAt(2) % 3)));
    tree(shuffled, { at: other });
    expect(release(one).rc).toBe(0);
    expect(release(other).rc).toBe(0);
    expect(readFileSync(join(other, "CHANGELOG.md"), "utf8")).toBe(readFileSync(join(one, "CHANGELOG.md"), "utf8"));
    expect(readFileSync(join(other, METAINFO), "utf8")).toBe(readFileSync(join(one, METAINFO), "utf8"));
  });

  it("fold() orders by file name whatever order it is handed", () => {
    const { fragments } = readFragments(tree(FRAGMENTS));
    expect(fold(changelog(), [...fragments].reverse(), "0.28.0", "2026-10-21")).toBe(golden());
  });
});

// ─── the empty set ──────────────────────────────────────────────────────────────────────────────────
describe("an empty changelog.d/", () => {
  it("--check passes, --release refuses and writes nothing", () => {
    const root = tree({});
    expect(cli(root, "--check").rc).toBe(0);
    const before = snapshot(root);
    const r = release(root);
    expect(r.rc).toBe(1);
    expect(r.err).toMatch(/no fragment/i);
    expect(snapshot(root)).toEqual(before);
  });
});

// ─── malformed fragments ────────────────────────────────────────────────────────────────────────────
describe("a malformed fragment is refused by --check and --release, naming file:line", () => {
  const SECRET = "zebra-sentinel-word";
  const ok = { "ok-entry.md": "### A good entry\n\nFine.\n" };
  const cases: Array<[string, string, Files, string]> = [
    // rule a: files
    ["(a) a name that is not a slug", "changelog.d/Bad_Name.md:", { "Bad_Name.md": `### X\n\n${SECRET}\n` }, "slug"],
    ["(a) a file that is not .md", "changelog.d/entry.txt:", { "entry.txt": `### X\n\n${SECRET}\n` }, "slug"],
    ["(a) a hidden file", "changelog.d/.entry.md:", { ".entry.md": `### X\n\n${SECRET}\n` }, "slug"],
    ["(a) a slug over 80 characters", `changelog.d/${"a".repeat(81)}.md:`, { [`${"a".repeat(81)}.md`]: `### X\n\n${SECRET}\n` }, "slug"],
    ["(a) a file over 32 KiB", "changelog.d/huge.md:", { "huge.md": `### Huge\n\n${"word ".repeat(7000)}\n` }, "KiB"],
    ["(a) a control byte", "changelog.d/bell.md:3:", { "bell.md": `### Bell\n\n${SECRET}\u0007\n` }, "control"],
    ["(a) a lone carriage return", "changelog.d/cr.md:3:", { "cr.md": `### Cr\n\n${SECRET}\rmore\n` }, "control"],
    ["(a) bytes that are not UTF-8", "changelog.d/latin.md:", { "latin.md": Buffer.from([0x23, 0x23, 0x23, 0x20, 0x58, 0x0a, 0x0a, 0xe9, 0x0a]) }, "UTF-8"],
    // rule b: shape
    ["(b) an empty file", "changelog.d/empty.md:1:", { "empty.md": "" }, "heading"],
    ["(b) a first line that is a level-2 heading", "changelog.d/h2.md:1:", { "h2.md": `## Two\n\n${SECRET}\n` }, "### "],
    ["(b) a first line that is prose", "changelog.d/prose.md:2:", { "prose.md": `\n${SECRET} first\n\nmore\n` }, "### "],
    ["(b) a headline with a full stop", "changelog.d/stop.md:1:", { "stop.md": "### It ends.\n\nText.\n" }, "full stop"],
    ["(b) a second heading", "changelog.d/two.md:5:", { "two.md": `### One\n\n${SECRET}\n\n### Two\n\nText.\n` }, "heading"],
    ["(b) a heading inside a code fence", "changelog.d/fence.md:5:", { "fence.md": "### Fence\n\n```sh\necho\n# a comment\n```\n" }, "heading"],
    ["(b) no text under the headline", "changelog.d/bare.md:1:", { "bare.md": "### Only a headline\n\n\n" }, "text"],
    // rule c: hidden text
    ["(c) a link reference definition", "changelog.d/ref.md:5:", { "ref.md": `### Ref\n\nSee [x].\n\n[x]: https://example.com/${SECRET}\n` }, "link"],
    ["(c) an HTML comment", "changelog.d/comment.md:3:", { "comment.md": `### Comment\n\n<!-- ${SECRET} -->\nText.\n` }, "comment"],
    // rule d: unique headlines
    ["(d) two fragments with one headline", "changelog.d/second.md:1:", {
      "first.md": "### Search is faster\n\nOne.\n", "second.md": "### SEARCH is FASTER\n\nTwo.\n",
    }, "headline"],
  ];
  it.each(cases)("%s", (_label, where, files, reason) => {
    const root = tree({ ...ok, ...files });
    const check = cli(root, "--check");
    expect(check.rc, check.err).toBe(1);
    expect(check.err).toContain(where);
    expect(check.err).toContain(reason);
    expect(check.err, "a message repeated the file's content").not.toContain(SECRET);
    const before = snapshot(root);
    const r = release(root);
    expect(r.rc).toBe(1);
    expect(r.err).toContain(where);
    expect(snapshot(root), "a refused --release wrote or deleted something").toEqual(before);
  });

  it("(a) a directory in changelog.d/ is refused", () => {
    const root = tree(ok);
    mkdirSync(join(root, "changelog.d", "nested.md"));
    expect(cli(root, "--check").err).toContain("changelog.d/nested.md:");
    expect(release(root).rc).toBe(1);
  });

  it("(a) a missing changelog.d/ is refused", () => {
    const root = tree({});
    rmSync(join(root, "changelog.d"), { recursive: true });
    expect(cli(root, "--check").rc).toBe(1);
  });

  it("parseFragment reports the shape without the content", () => {
    const { fragment, problems } = parseFragment("changelog.d/x.md", "﻿### Headline\r\n\r\nBody one.\r\nBody two.\r\n");
    expect(problems).toEqual([]);
    expect(fragment).toMatchObject({ headline: "Headline", body: "Body one.\nBody two." });
  });
});

// ─── refusals only --release makes ──────────────────────────────────────────────────────────────────
describe("--release refuses what --check lets wait", () => {
  it("an unfilled <date> waits in a fragment and is refused at the release", () => {
    const root = tree({ "hosted.md": "### A hosted fix\n\nFixed on ohmail Cloud on <date>.\n" });
    const check = cli(root, "--check");
    expect(check.rc).toBe(0);
    expect(check.out + check.err).toContain("changelog.d/hosted.md:3");
    const before = snapshot(root);
    const r = release(root);
    expect(r.rc).toBe(1);
    // Named by the fragment's own line: that is the file to fix, not the changelog it would have reached.
    expect(r.err).toContain("changelog.d/hosted.md:3: an unfilled <date>");
    expect(snapshot(root)).toEqual(before);
  });

  it("a second fold of the same version", () => {
    const root = tree({ "one.md": "### One\n\nText.\n" });
    expect(release(root).rc).toBe(0);
    writeFileSync(join(root, "changelog.d", "two.md"), "### Two\n\nText.\n");
    const before = snapshot(root);
    expect(release(root).rc).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });

  it.each([["0.27.5"], ["0.27.4"], ["0.3.0"]])("version %s, which is not after 0.27.5", (v) => {
    const root = tree({ "one.md": "### One\n\nText.\n" }, { version: v });
    const before = snapshot(root);
    const r = release(root, v);
    expect(r.rc).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });

  it("0.100.0 is after 0.99.9: versions compare as numbers", () => {
    const root = tree({ "one.md": "### One\n\nText.\n" }, { version: "0.100.0", text: changelog("0.99.9") });
    const r = release(root, "0.100.0");
    expect(r.rc, r.err).toBe(0);
    expect(releasesFrom(readFileSync(join(root, "CHANGELOG.md"), "utf8"))[0]?.version).toBe("0.100.0");
  });

  it("package.json at another version", () => {
    const root = tree({ "one.md": "### One\n\nText.\n" }, { version: "0.27.5" });
    const r = release(root, "0.28.0");
    expect(r.rc).toBe(1);
    expect(r.err).toContain("package.json");
  });

  it("a malformed [Unreleased] link", () => {
    const root = tree({ "one.md": "### One\n\nText.\n" }, { text: changelog("0.27.5", [], POINTER, `[Unreleased]: ${URL_BASE}/compare/v0.27.4...HEAD`) });
    expect(cli(root, "--check").rc).toBe(1);
    expect(release(root).rc).toBe(1);
  });

  it("an entry written under [Unreleased] is sent to changelog.d/", () => {
    const root = tree({ "one.md": "### One\n\nText.\n" }, { text: changelog("0.27.5", ["### Written the old way", "", "Text.", ""]) });
    const check = cli(root, "--check");
    expect(check.rc).toBe(1);
    expect(check.err).toContain("changelog.d/<slug>.md");
    expect(release(root).rc).toBe(1);
  });

  it("an [Unreleased] without the pointer to changelog.d/", () => {
    const root = tree({}, { text: changelog("0.27.5", [], ["Nothing here yet."]) });
    expect(cli(root, "--check").rc).toBe(1);
  });

  it("a date that is not a calendar date, and a missing --date, are refused", () => {
    const root = tree({ "one.md": "### One\n\nText.\n" });
    expect(release(root, "0.28.0", "2026-13-01").rc).toBe(1);
    expect(cli(root, "--release", "0.28.0").rc).toBe(2);
    expect(cli(root).rc).toBe(2);
  });

  it("fold() throws on each of them too", () => {
    const { fragments } = readFragments(tree({ "one.md": "### One\n\nText.\n" }));
    expect(() => fold(changelog(), fragments, "0.27.5", "2026-10-21")).toThrow(/already in the changelog/);
    expect(() => fold(changelog(), fragments, "0.27.4", "2026-10-21")).toThrow(/not after/);
    expect(() => fold(changelog(), fragments, "0.28", "2026-10-21")).toThrow(/x\.y\.z/);
    expect(() => fold(changelog(), [], "0.28.0", "2026-10-21")).toThrow(/no fragment/i);
    expect(() => fold(changelog("0.27.5", ["### Old way", "", "x", ""]), fragments, "0.28.0", "2026-10-21")).toThrow(/changelog\.d/);
  });
});

// ─── the readers on the folded output ───────────────────────────────────────────────────────────────
describe("every reader of the changelog reads the folded output", () => {
  const root = tree(FRAGMENTS);
  const r = release(root);
  const out = readFileSync(join(root, "CHANGELOG.md"), "utf8");

  it("appstream's releasesFrom reads the new version with the fragment headlines", () => {
    expect(r.rc, r.err).toBe(0);
    expect(releasesFrom(out)[0]).toEqual({ version: "0.28.0", date: "2026-10-21", items: HEADLINES });
  });

  it("no placeholder sits under a dated heading", () => {
    expect(placeholdersByBlock(out).filter((p) => isDatedHeading(p.heading))).toEqual([]);
  });

  it("desktop-shell's three strings hold, and there is one heading for the version", () => {
    expect(out).toContain("## [0.28.0] — ");
    expect(out).toContain(`[0.28.0]: ${URL_BASE}/releases/tag/v0.28.0`);
    expect(out).toContain(`[Unreleased]: ${URL_BASE}/compare/v0.28.0...HEAD`);
    expect(out.split("\n").filter((l) => l.startsWith("## [0.28.0] —"))).toHaveLength(1);
    expect(checkChangelog(out)).toEqual([]);
  });

  it("pr-build-scope answers desktop=true for the fold's real diff, false/false for a fragment alone", () => {
    const cfg = join(W, "empty-gitconfig-scope");
    writeFileSync(cfg, "");
    const env = { ...ENV, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@example.invalid",
      GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@example.invalid" };
    const repo = tree({ "one.md": "### One\n\nText.\n" });
    const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env }).trim();
    g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "--no-verify", "-m", "before");
    const before = g("rev-parse", "HEAD");
    expect(release(repo).rc).toBe(0);
    g("add", "-A"); g("commit", "-q", "--no-verify", "-m", "fold");
    const scope = (args: string[]) => {
      const s = spawnSync("bash", [SCOPE, ...args], { cwd: repo, encoding: "utf8", env });
      expect(s.status, s.stderr).toBe(0);
      return /^desktop=(\w+)$/m.exec(s.stdout)?.[1];
    };
    expect(scope(["--base", before, "--head", "HEAD"])).toBe("true");
    // The heading alone carries it, without the metainfo path.
    writeFileSync(join(repo, "..", `files-${n}`), "CHANGELOG.md\nchangelog.d/one.md\n");
    writeFileSync(join(repo, "..", `diff-${n}`), g("diff", "-U0", before, "HEAD", "--", "CHANGELOG.md") + "\n");
    expect(scope(["--files", join(repo, "..", `files-${n}`), "--changelog", join(repo, "..", `diff-${n}`)])).toBe("true");
    writeFileSync(join(repo, "..", `frag-${n}`), "changelog.d/x.md\n");
    expect(scope(["--files", join(repo, "..", `frag-${n}`)])).toBe("false");
  });
});

// ─── symbolic links ─────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!POSIX)("the fold never follows a symbolic link out of the tree", () => {
  const outside = () => {
    const o = fresh("outside");
    writeFileSync(join(o, "README.md"), "# readme\n");
    writeFileSync(join(o, "notes.md"), "### Looks like an entry\n\nOutside the tree.\n");
    return o;
  };

  it("a changelog.d/ that is a symlink is refused, and the outside files survive", () => {
    const o = outside();
    const root = tree({});
    rmSync(join(root, "changelog.d"), { recursive: true });
    symlinkSync(o, join(root, "changelog.d"));
    const check = cli(root, "--check");
    expect(check.rc).toBe(1);
    // Caught by the lstat rule itself; the realpath containment behind it is a second layer, not this one.
    expect(check.err).toContain("changelog.d/:1: is a symbolic link");
    const before = snapshot(root);
    expect(release(root).rc).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(readFileSync(join(o, "notes.md"), "utf8")).toContain("Outside the tree.");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).not.toContain("Outside the tree.");
  });

  it("a fragment that is a symlink is refused, and its target survives", () => {
    const o = outside();
    const root = tree({ "ok.md": "### Fine\n\nText.\n" });
    symlinkSync(join(o, "notes.md"), join(root, "changelog.d", "linked.md"));
    const check = cli(root, "--check");
    expect(check.rc).toBe(1);
    // Caught by lstat; the O_NOFOLLOW open behind it is a second layer.
    expect(check.err).toContain("changelog.d/linked.md:1: a symbolic link");
    expect(release(root).rc).toBe(1);
    expect(lstatSync(join(root, "changelog.d", "linked.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(o, "notes.md"))).toBe(true);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).not.toContain("Outside the tree.");
  });
});

// ─── the live tree ──────────────────────────────────────────────────────────────────────────────────
describe("this checkout", () => {
  it("--check passes on the repository itself, by default root and by --root", () => {
    const own = cli(null, "--check");
    expect(own.rc, own.err).toBe(0);
    expect(cli(ROOT, "--check").rc).toBe(0);
  });

  it("the CLI refuses a malformed fixture with exit 1", () => {
    expect(cli(tree({ "bad.md": "no heading\n" }), "--check").rc).toBe(1);
  });

  it("every fragment in the repository parses, and the changelog is in shape", () => {
    const { problems } = readFragments(ROOT);
    expect(problems).toEqual([]);
    expect(checkChangelog(readFileSync(publicPath("CHANGELOG.md"), "utf8"))).toEqual([]);
  });
});

// ─── --preview and readChangelogText ───────────────────────────────────────────────────────────────
describe("--preview and readChangelogText", () => {
  it("--preview prints the section the fold would write and writes nothing", () => {
    const root = tree(FRAGMENTS);
    const before = snapshot(root);
    const p = cli(root, "--preview");
    expect(p.rc, p.err).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const at = HEADLINES.map((h) => p.out.indexOf(`### ${h}\n`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("readChangelogText finds a sentence before and after the fold", () => {
    const root = tree(FRAGMENTS);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).not.toContain("The second one.");
    expect(readChangelogText(root)).toContain("The second one.");
    expect(release(root).rc).toBe(0);
    expect(readChangelogText(root)).toContain("The second one.");
  });
});

// ─── a write that fails partway ────────────────────────────────────────────────────────────────────
describe.skipIf(!POSIX || process.getuid?.() === 0)("a fold that cannot finish says how to restore the tree", () => {
  it("exits 3 and prints the git checkout line when a fragment cannot be deleted", () => {
    const root = tree({ "one.md": "### One\n\nText.\n" });
    chmodSync(join(root, "changelog.d"), 0o555);
    const r = release(root);
    chmodSync(join(root, "changelog.d"), 0o755);
    expect(r.rc).toBe(3);
    expect(r.err).toContain("git checkout -- CHANGELOG.md");
  });
});
