// tools/retirement.tsv: every test file that reads a file, and where what it holds will live once
// it leaves. A test file leaves only with a row, and a row that reads source names its new home.
import path from "node:path";

export const RETIREMENT_HEADER = "file\tkind\tholds\thome\ttask\tverdict";
export const KINDS = ["source-text", "artifact", "data", "duplicate", "helper-only"];
/** A test that calls one of these reads a file: it has a row. */
export const READS_A_FILE = /\b(readFileSync|readFile|readdirSync|readdir|globSync)\b/;
const TASK = /^(ruling:[A-Za-z0-9][A-Za-z0-9-]*|[a-z][a-z0-9]*(-[a-z0-9]+)*)$/;
const VERDICT = /^docs\/(tool|invariant)-verdicts\/[A-Za-z0-9._-]+\.json$/;

/** A test file of the suite's default walk (vitest.config.ts `include`). */
export const isSuiteTest = (rel) => /^((apps|packages)\/[^/]+\/)?test\/.+\.test\.tsx?$/.test(rel);

/** What a classifier wrote where it could not tell what a file reads. It says nothing, so it is no row. */
const UNDECIDED = "reads files named at run time";

const LOCAL_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
const ENDINGS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  "/index.ts",
  "/index.tsx",
  "/index.mjs",
  "/index.js",
];
const isHelper = (rel) => /(^|\/)test\//.test(rel) && !isSuiteTest(rel);

/**
 * The test files that read a file: by a call of their own, or through a helper, a module under a test
 * folder that is no test itself, reached by local imports. Product code a test imports is not followed.
 * @param {object} given
 * @param {string[]} given.tests the suite's test files
 * @param {(rel: string) => string | null} given.textOf a tracked file's text, null where there is none
 */
export function readingTests({ tests, textOf }) {
  const helpersOf = (rel) => {
    const found = [];
    for (const [, source] of (textOf(rel) ?? "").matchAll(LOCAL_IMPORT)) {
      const base = path.posix.join(path.posix.dirname(rel), source);
      const stem = base.replace(/\.[cm]?js$/, "");
      const target = [...ENDINGS.map((end) => base + end), ...ENDINGS.slice(1).map((end) => stem + end)].find(
        (candidate) => textOf(candidate) !== null,
      );
      if (target && isHelper(target)) found.push(target);
    }
    return found;
  };
  const known = new Map();
  const reads = (helper) => {
    if (!known.has(helper)) {
      known.set(helper, false); // a helper that imports itself in a circle reads nothing by that
      known.set(helper, READS_A_FILE.test(textOf(helper)) || helpersOf(helper).some(reads));
    }
    return known.get(helper);
  };
  return new Set(tests.filter((rel) => READS_A_FILE.test(textOf(rel) ?? "") || helpersOf(rel).some(reads)));
}

export function parseRetirement(text) {
  const refusals = [];
  const lines = text.split("\n").filter((line) => line !== "");
  if (lines[0] !== RETIREMENT_HEADER)
    refusals.push(`retirement: the first line is not "${RETIREMENT_HEADER.replaceAll("\t", " ")}"`);
  const rows = lines.slice(1).map((line) => {
    const [file, kind, holds, home, task, verdict, ...rest] = line.split("\t");
    if (rest.length || verdict === undefined) refusals.push(`retirement: ${file}: a row has six columns`);
    return { file, kind, holds: holds ?? "", home: home ?? "", task: task ?? "", verdict: verdict ?? "" };
  });
  if (rows.some((row, i) => i > 0 && rows[i - 1].file >= row.file))
    refusals.push("retirement: the rows are not sorted by file, each file once");
  return { rows, refusals };
}

export function renderRetirement(rows) {
  const sorted = [...rows].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const lines = sorted.map((row) =>
    [row.file, row.kind, row.holds, row.home, row.task, row.verdict].join("\t"),
  );
  return [RETIREMENT_HEADER, ...lines].join("\n") + "\n";
}

/**
 * @param {object} given
 * @param {{ file: string, kind: string, holds: string, home: string, task: string, verdict: string }[]} given.rows
 * @param {Set<string>} given.reading the test files that read a file today
 * @param {Set<string>} given.present every test file in the tree
 * @param {string[]} given.deleted the test files the change deletes, read against its base
 * @param {(path: string) => boolean} given.verdictExists
 */
export function checkRetirement({ rows, reading, present, deleted, verdictExists }) {
  const refusals = [];
  const byFile = new Map(rows.map((row) => [row.file, row]));
  for (const row of rows) {
    const at = `retirement: ${row.file}`;
    if (!KINDS.includes(row.kind))
      refusals.push(`${at}: the kind "${row.kind}" is not one of ${KINDS.join(", ")}`);
    if (!row.holds) refusals.push(`${at}: the row does not say what the file holds`);
    if (row.holds === UNDECIDED) refusals.push(`${at}: "${UNDECIDED}" does not say what the file reads`);
    if (!row.home) refusals.push(`${at}: the row names no home; write none where nothing takes its place`);
    if (!TASK.test(row.task)) refusals.push(`${at}: the task "${row.task}" is empty or not a task's name`);
    if (row.kind === "source-text" && row.home === "none") {
      refusals.push(
        `${at}: it reads source as text, so its row names the rule, type or test that takes its place, not none`,
      );
    }
    if (row.verdict && !(VERDICT.test(row.verdict) && verdictExists(row.verdict))) {
      refusals.push(
        `${at}: the verdict "${row.verdict}" is not a file under docs/tool-verdicts or docs/invariant-verdicts`,
      );
    }
    if (!present.has(row.file) && !row.verdict)
      refusals.push(`${at}: the file is gone and its row has no verdict`);
    const mechanical = row.kind === "source-text" || row.kind === "artifact" || row.kind === "data";
    if (present.has(row.file) && !reading.has(row.file) && mechanical && !row.verdict) {
      refusals.push(`${at}: the file reads no file any more; its row leaves with the reading`);
    }
  }
  for (const file of [...reading].sort()) {
    if (!byFile.has(file))
      refusals.push(`retirement: ${file} reads a file and has no row in tools/retirement.tsv`);
  }
  for (const file of deleted) {
    if (!byFile.get(file)?.verdict)
      refusals.push(`retirement: ${file} is deleted without a row that carries a verdict`);
  }
  return refusals;
}
