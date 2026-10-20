#!/usr/bin/env node
/**
 * changelog-fold.mjs — one file per changelog entry, gathered into CHANGELOG.md by the release bump.
 *
 *     node scripts/changelog-fold.mjs --check                             refuse a malformed fragment or [Unreleased]
 *     node scripts/changelog-fold.mjs --preview                           print the section the next fold writes
 *     node scripts/changelog-fold.mjs --release <V> --date <YYYY-MM-DD>   fold changelog.d/ into `## [V] — D`
 *     (any of them with --root <dir>; the default is this repository)
 *
 * Exit: 0 done · 1 refused, nothing written or deleted · 2 usage · 3 a write failed partway (it says how to
 * restore the tree).
 *
 * A pull request adds `changelog.d/<slug>.md` instead of editing `## [Unreleased]`, so two pull requests never
 * conflict on CHANGELOG.md. A fragment is the entry and nothing else: `### <headline>`, a blank line, then
 * the text. The release writes them under the new version in file-name order, rewrites the `[Unreleased]:`
 * link, adds the version's own link, rewrites the Flatpak metainfo's <releases> block and deletes exactly the
 * fragments it read. This runs on the release machine, so it reads no symbolic link and nothing outside
 * the tree. Messages name file and line and never repeat a file's content.
 */
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LIMIT, releasesFrom, renderReleases, withReleases } from "./appstream-releases.mjs";

export const FRAGMENT_DIR = "changelog.d";
/** The one file in changelog.d/ that is not an entry. */
export const README = "README.md";
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;
export const FRAGMENT_MAX_BYTES = 32 * 1024;
export const CHANGELOG_FILE = "CHANGELOG.md";
export const METAINFO_FILE = "apps/desktop/flatpak/app.ohmail.Desktop.metainfo.xml";
const RESTORE = `git checkout -- ${CHANGELOG_FILE} ${METAINFO_FILE} ${FRAGMENT_DIR}`;

const UNRELEASED = "## [Unreleased]";
const STILL_TO_COME = "### Still to come";
const VERSION_HEADING = /^## \[(\d+)\.(\d+)\.(\d+)\] — (\d{4}-\d{2}-\d{2})$/;
const VERSION_ARG = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNRELEASED_LINK = /^\[Unreleased\]: (https:\/\/github\.com\/[\w.-]+\/[\w.-]+)\/compare\/v(\d+\.\d+\.\d+)\.\.\.HEAD$/;
/** Any Markdown ATX heading. Every changelog reader is line-based, so a fence does not hide one. */
const ANY_HEADING = /^ {0,3}#{1,6}(\s|$)/;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:/;
/** ASCII control characters and DEL, except tab and newline. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

// ─── placeholders (moved here from test/changelog-no-unfilled-placeholder.test.ts) ───────────────────────

/** The three values an entry cannot know when it is written. A named set: `<time>` in quoted product copy
 *  is innocent, and a wider pattern went red on it. */
export const PLACEHOLDER_WORDS = ["date", "version", "sha"];
const PLACEHOLDER = new RegExp(`<(?:${PLACEHOLDER_WORDS.join("|")})>`, "g");

/** Inside a double-quoted span on its line (quoted UI copy, not a hole to fill)? An odd quote count before it. */
function insideQuotes(line, index) {
  let quotes = 0;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (ch === '"' || ch === "“" || ch === "”") quotes++;
  }
  return quotes % 2 === 1;
}

/** `## [0.15.0] — 2026-09-09` is dated; `## [Unreleased]` is not. */
export function isDatedHeading(line) {
  return /^## /.test(line) && /\d{4}-\d{2}-\d{2}/.test(line);
}

/** Every unquoted placeholder, with the `## ` heading that encloses it and its 1-based line. */
export function placeholdersByBlock(text) {
  const out = [];
  let heading = "(above the first heading)";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## /.test(line)) { heading = line.trim(); continue; }
    for (const m of line.matchAll(PLACEHOLDER)) {
      if (insideQuotes(line, m.index)) continue;
      out.push({ heading, line: i + 1, found: m[0] });
    }
  }
  return out;
}

// ─── fragments ───────────────────────────────────────────────────────────────────────────────────────────

/** A refusal carrying its problems; the message is the problems, one a line. */
export class FoldRefusal extends Error {
  constructor(problems) {
    super(problems.map(describe).join("\n"));
    this.name = "FoldRefusal";
    this.problems = problems;
  }
}
const describe = (p) => `${p.file}:${p.line}: ${p.reason}`;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One fragment's text to `{fragment, problems}`. A leading BOM and CRLF line ends are normalised. */
export function parseFragment(file, raw) {
  const problems = [];
  const bad = (line, reason) => problems.push({ file, line, reason });
  const text = String(raw).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  lines.forEach((l, i) => { if (CONTROL.test(l) || l.includes("\r")) bad(i + 1, "a control character: entries are plain text"); });
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) {
    bad(1, "no `### <headline>` heading: the file is empty");
    return { fragment: null, problems };
  }
  const m = /^### (\S.*?)\s*$/.exec(lines[first]);
  if (!m) {
    bad(first + 1, "the first line is not a `### <headline>` heading");
    return { fragment: null, problems };
  }
  const headline = m[1];
  if (/\.$/.test(headline)) bad(first + 1, "the headline ends with a full stop");
  let end = lines.length;
  while (end > first + 1 && lines[end - 1].trim() === "") end--;
  let start = first + 1;
  while (start < end && lines[start].trim() === "") start++;
  if (start >= end) bad(first + 1, "no text under the headline");
  for (let i = first + 1; i < lines.length; i++) {
    const l = lines[i];
    if (ANY_HEADING.test(l)) bad(i + 1, "a second heading: one entry per file, and no heading inside it (code included)");
    if (LINK_DEFINITION.test(l)) bad(i + 1, "a link reference definition: write the link inline");
    if (l.includes("<!--")) bad(i + 1, "an HTML comment: the changelog carries no hidden text");
  }
  const body = lines.slice(start, end).join("\n");
  return { fragment: { file, headline, headingLine: first + 1, bodyLine: start + 1, body }, problems };
}

/** Read one regular file without following a symbolic link, or say why not. */
function readRegular(abs, file) {
  let fd;
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { problem: { file, line: 1, reason: "cannot be opened as a regular file (a symbolic link is refused)" } };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: { file, line: 1, reason: "not a regular file" } };
    if (st.size > FRAGMENT_MAX_BYTES) return { problem: { file, line: 1, reason: `larger than ${FRAGMENT_MAX_BYTES / 1024} KiB` } };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const k = readSync(fd, buf, got, st.size - got, got);
      if (k === 0) break;
      got += k;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, got));
    } catch {
      return { problem: { file, line: 1, reason: "not UTF-8 text" } };
    }
    return { text, dev: st.dev, ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

/** The fragment directory, or a problem: a real directory, no symbolic link, inside the root. */
function fragmentDir(root) {
  const dir = join(root, FRAGMENT_DIR);
  let st;
  try { st = lstatSync(dir); } catch { return { problem: { file: `${FRAGMENT_DIR}/`, line: 1, reason: "is missing" } }; }
  if (st.isSymbolicLink()) return { problem: { file: `${FRAGMENT_DIR}/`, line: 1, reason: "is a symbolic link: it must be a directory in the tree" } };
  if (!st.isDirectory()) return { problem: { file: `${FRAGMENT_DIR}/`, line: 1, reason: "is not a directory" } };
  if (realpathSync(dir) !== join(realpathSync(root), FRAGMENT_DIR)) {
    return { problem: { file: `${FRAGMENT_DIR}/`, line: 1, reason: "resolves outside the tree" } };
  }
  return { dir };
}

/** Every fragment under `root`, in file-name order, and every problem with them (rules a, b, c, d). */
export function readFragments(root) {
  const problems = [];
  const fragments = [];
  const at = fragmentDir(root);
  if (at.problem) return { fragments, problems: [at.problem] };
  for (const name of readdirSync(at.dir).sort(byName)) {
    if (name === README) continue;
    const file = `${FRAGMENT_DIR}/${name}`;
    const abs = join(at.dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) { problems.push({ file, line: 1, reason: "a symbolic link: an entry is a regular file" }); continue; }
    if (!st.isFile()) { problems.push({ file, line: 1, reason: "not a regular file" }); continue; }
    const slug = name.endsWith(".md") ? name.slice(0, -3) : "";
    if (!SLUG_RE.test(slug) || slug.length > SLUG_MAX) {
      problems.push({ file, line: 1, reason: `not named <slug>.md (lower-case letters and digits joined by single dashes, at most ${SLUG_MAX})` });
      continue;
    }
    const read = readRegular(abs, file);
    if (read.problem) { problems.push(read.problem); continue; }
    const parsed = parseFragment(file, read.text);
    problems.push(...parsed.problems);
    if (parsed.fragment && parsed.problems.length === 0) fragments.push({ ...parsed.fragment, abs, dev: read.dev, ino: read.ino });
  }
  problems.push(...duplicateHeadlines(fragments));
  return { fragments, problems };
}

function duplicateHeadlines(fragments) {
  const seen = new Map();
  const out = [];
  for (const f of [...fragments].sort((a, b) => byName(a.file, b.file))) {
    const key = f.headline.toLowerCase();
    if (seen.has(key)) out.push({ file: f.file, line: f.headingLine, reason: `the same headline as ${seen.get(key)}` });
    else seen.set(key, f.file);
  }
  return out;
}

/** The placeholders a fragment still waits for, as problems on the line they sit on in the file. */
function waitingIn(f, reason) {
  const out = [];
  for (const p of placeholdersByBlock(`### ${f.headline}`)) out.push({ file: f.file, line: f.headingLine, reason: reason(p.found) });
  for (const p of placeholdersByBlock(f.body)) out.push({ file: f.file, line: f.bodyLine + p.line - 1, reason: reason(p.found) });
  return out;
}

// ─── CHANGELOG.md ────────────────────────────────────────────────────────────────────────────────────────

/** Where things are in the changelog, or the problems that stop it being read (rule e). */
function locate(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const problems = [];
  const bad = (line, reason) => problems.push({ file: CHANGELOG_FILE, line, reason });
  const un = lines.flatMap((l, i) => (l === UNRELEASED ? [i] : []));
  if (un.length !== 1) { bad(un[1] !== undefined ? un[1] + 1 : 1, `${un.length} \`${UNRELEASED}\` headings; there must be exactly one`); return { problems }; }
  const u = un[0];
  const next = lines.findIndex((l, i) => i > u && /^## /.test(l));
  const newest = next < 0 ? null : VERSION_HEADING.exec(lines[next]);
  if (!newest) { bad(next < 0 ? u + 1 : next + 1, "no released `## [x.y.z] — YYYY-MM-DD` section right after [Unreleased]"); return { problems }; }
  let still = 0;
  let pointer = false;
  for (let i = u + 1; i < next; i++) {
    if (lines[i] === STILL_TO_COME) { still++; continue; }
    if (ANY_HEADING.test(lines[i])) bad(i + 1, "an entry under [Unreleased]: write it as changelog.d/<slug>.md");
    if (lines[i].includes(`${FRAGMENT_DIR}/`)) pointer = true;
  }
  if (still !== 1) bad(u + 1, `[Unreleased] must hold exactly one \`${STILL_TO_COME}\``);
  if (!pointer) bad(u + 1, `[Unreleased] does not point at ${FRAGMENT_DIR}/`);
  const links = lines.flatMap((l, i) => (l.startsWith("[Unreleased]:") ? [i] : []));
  const link = links.length === 1 ? UNRELEASED_LINK.exec(lines[links[0]]) : null;
  const newestVersion = `${newest[1]}.${newest[2]}.${newest[3]}`;
  if (!link) bad(links.length ? links[0] + 1 : lines.length, "no single `[Unreleased]: https://github.com/<owner>/<repo>/compare/v<x.y.z>...HEAD` line");
  else if (link[2] !== newestVersion) bad(links[0] + 1, `the [Unreleased] comparison does not start at the newest release, ${newestVersion}`);
  for (const p of placeholdersByBlock(lines.join("\n"))) {
    if (isDatedHeading(p.heading)) bad(p.line, `an unfilled ${p.found} in a released section`);
  }
  return {
    problems, lines, newestAt: next,
    newest: [Number(newest[1]), Number(newest[2]), Number(newest[3])],
    linkAt: links[0], base: link?.[1],
  };
}

/** Every problem with the changelog's own shape. */
export function checkChangelog(text) {
  return locate(text).problems;
}

function validDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}

/** The lines a fold writes for `fragments`, in file-name order, under `heading`. */
function section(heading, fragments) {
  const out = [heading, ""];
  for (const f of [...fragments].sort((a, b) => byName(a.file, b.file))) out.push(`### ${f.headline}`, "", ...f.body.split("\n"), "");
  return out;
}

/** The changelog with `fragments` folded in as `## [version] — date`, or a thrown FoldRefusal. Pure. */
export function fold(text, fragments, version, date) {
  const here = (reason) => new FoldRefusal([{ file: CHANGELOG_FILE, line: 1, reason }]);
  if (text.includes("\r")) throw here("carriage returns in the changelog: it is written with LF line ends");
  const at = locate(text);
  if (at.problems.length) throw new FoldRefusal(at.problems);
  const v = VERSION_ARG.exec(version);
  if (!v) throw here(`the version is not x.y.z`);
  if (!validDate(date)) throw here(`the date is not a YYYY-MM-DD calendar date`);
  if (fragments.length === 0) throw new FoldRefusal([{ file: `${FRAGMENT_DIR}/`, line: 1, reason: "no fragment to fold" }]);
  const lines = at.lines;
  if (lines.some((l) => l.startsWith(`## [${version}]`) || l.startsWith(`[${version}]:`))) throw here(`${version} is already in the changelog`);
  const want = [Number(v[1]), Number(v[2]), Number(v[3])];
  const after = want[0] !== at.newest[0] ? want[0] > at.newest[0] : want[1] !== at.newest[1] ? want[1] > at.newest[1] : want[2] > at.newest[2];
  if (!after) throw here(`${version} is not after the newest release, ${at.newest.join(".")}`);
  const problems = [...duplicateHeadlines(fragments)];
  for (const f of fragments) problems.push(...waitingIn(f, (w) => `an unfilled ${w}: fill it before the release`));
  if (problems.length) throw new FoldRefusal(problems);

  const out = [...lines];
  out.splice(at.linkAt, 1, `[Unreleased]: ${at.base}/compare/v${version}...HEAD`, `[${version}]: ${at.base}/releases/tag/v${version}`);
  out.splice(at.newestAt, 0, ...section(`## [${version}] — ${date}`, fragments));
  const folded = out.join("\n");

  // Read back as the readers will: one heading for it, newest in appstream's reading, the shape intact.
  const check = locate(folded).problems;
  const heads = out.filter((l) => l.startsWith(`## [${version}] — `)).length;
  const newest = releasesFrom(folded)[0];
  if (check.length || heads !== 1 || newest?.version !== version || newest.items.length !== fragments.length) {
    throw new FoldRefusal([...check, { file: CHANGELOG_FILE, line: 1, reason: "the folded changelog does not read back; nothing written" }]);
  }
  return folded;
}

export { releasesFrom };

/** The metainfo with its <releases> block derived from `changelog`, by appstream-releases.mjs's own renderer. */
export function withChangelogReleases(metainfo, changelog) {
  return withReleases(metainfo, renderReleases(releasesFrom(changelog).slice(0, LIMIT)));
}

/** The section the next fold writes, with its heading left to fill. */
export function preview(fragments) {
  if (fragments.length === 0) return `${FRAGMENT_DIR}/ holds no entry; the next release has nothing to fold yet.\n`;
  return section("## [<version>] — <date>", fragments).join("\n") + "\n";
}

/** CHANGELOG.md and every entry waiting in changelog.d/, for a test that pins a sentence of the changelog:
 *  the sentence is in a fragment until the release and in CHANGELOG.md after it. */
export function readChangelogText(root) {
  const parts = [readFileSync(join(root, CHANGELOG_FILE), "utf8")];
  const at = fragmentDir(root);
  if (at.dir) {
    for (const name of readdirSync(at.dir).sort(byName)) {
      if (name === README || !name.endsWith(".md")) continue;
      const read = readRegular(join(at.dir, name), `${FRAGMENT_DIR}/${name}`);
      if (read.text !== undefined) parts.push(read.text.replace(/^﻿/, "").replace(/\r\n/g, "\n"));
    }
  }
  return parts.join("\n");
}

// ─── the command ─────────────────────────────────────────────────────────────────────────────────────────

const USAGE = "usage: changelog-fold.mjs [--root <dir>] --check | --preview | --release <x.y.z> --date <YYYY-MM-DD>\n";

function regularText(root, rel) {
  const abs = join(root, rel);
  let st;
  try { st = lstatSync(abs); } catch { throw new FoldRefusal([{ file: rel, line: 1, reason: "is missing" }]); }
  if (!st.isFile()) throw new FoldRefusal([{ file: rel, line: 1, reason: "is not a regular file" }]);
  return readFileSync(abs, "utf8");
}

/** Write through a fresh temp file beside the target, then rename over it. */
function stage(abs, text) {
  const tmp = `${abs}.fold-${process.pid}.tmp`;
  writeFileSync(tmp, text, { flag: "wx" });
  return tmp;
}

function main(argv) {
  const say = (s) => process.stdout.write(`changelog-fold: ${s}\n`);
  const refuse = (problems) => {
    for (const p of problems) process.stderr.write(`${describe(p)}\n`);
    process.stderr.write("changelog-fold: refused; nothing written\n");
    return 1;
  };
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let mode = null, version = null, date = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1] !== undefined) root = resolve(argv[++i]);
    else if ((a === "--check" || a === "--preview") && mode === null) mode = a;
    else if (a === "--release" && mode === null && argv[i + 1] !== undefined) { mode = a; version = argv[++i]; }
    else if (a === "--date" && argv[i + 1] !== undefined) date = argv[++i];
    else { process.stderr.write(USAGE); return 2; }
  }
  if (mode === null || (mode === "--release") !== (date !== null)) { process.stderr.write(USAGE); return 2; }

  let text;
  try { text = regularText(root, CHANGELOG_FILE); } catch (e) { return refuse(e.problems); }
  const { fragments, problems } = readFragments(root);
  problems.push(...checkChangelog(text));
  if (problems.length) return refuse(problems);

  if (mode === "--check") {
    for (const f of fragments) {
      for (const p of waitingIn(f, (w) => `waits for ${w}; --release refuses it until it is filled`)) process.stderr.write(`${describe(p)}\n`);
    }
    say(`${fragments.length} entr${fragments.length === 1 ? "y" : "ies"} waiting in ${FRAGMENT_DIR}/; ${CHANGELOG_FILE} is in shape`);
    return 0;
  }
  if (mode === "--preview") {
    process.stdout.write(preview(fragments));
    return 0;
  }

  // --release
  let pkg;
  try { pkg = JSON.parse(regularText(root, "package.json")).version; } catch (e) {
    return refuse(e.problems ?? [{ file: "package.json", line: 1, reason: "cannot be read as JSON" }]);
  }
  if (pkg !== version) return refuse([{ file: "package.json", line: 1, reason: `the version is ${pkg}, not ${version}: bump it first` }]);
  let folded, meta;
  try {
    folded = fold(text, fragments, version, date);
    meta = withChangelogReleases(regularText(root, METAINFO_FILE), folded);
  } catch (e) {
    return refuse(e.problems ?? [{ file: METAINFO_FILE, line: 1, reason: "has no <releases> block to rewrite" }]);
  }

  const targets = [[join(root, CHANGELOG_FILE), folded], [join(root, METAINFO_FILE), meta]];
  const staged = [];
  try {
    for (const [abs, body] of targets) staged.push([stage(abs, body), abs]);
  } catch {
    for (const [tmp] of staged) { try { unlinkSync(tmp); } catch { /* already gone */ } }
    return refuse([{ file: CHANGELOG_FILE, line: 1, reason: "a temporary file beside it could not be written" }]);
  }
  try {
    for (const [tmp, abs] of staged) renameSync(tmp, abs);
    for (const f of fragments) {
      const st = lstatSync(f.abs);
      // Delete only the file that was read: the same inode, still a regular file.
      if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino) throw new Error("changed");
      unlinkSync(f.abs);
    }
  } catch {
    for (const [tmp] of staged) { try { unlinkSync(tmp); } catch { /* renamed already */ } }
    process.stderr.write(
      `changelog-fold: the fold stopped partway: ${CHANGELOG_FILE} or the metainfo may be written and some fragments not deleted.\n` +
      `  Restore the tree with: ${RESTORE}\n`,
    );
    return 3;
  }
  say(`folded ${fragments.length} entr${fragments.length === 1 ? "y" : "ies"} into ## [${version}] — ${date}, rewrote the links and the metainfo, deleted the fragments`);
  return 0;
}

/* Through realpath: `import.meta.url` is the resolved file, so a script reached through a symlink would compare
 * unequal and run nothing. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
