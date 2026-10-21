/* The invariant table's reader: docs/INVARIANTS.md says what each column means and what a verdict holds. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testFiles } from "./ci-shards.mjs";

export const TABLE = "docs/INVARIANTS.tsv";
export const VERDICTS = "docs/invariant-verdicts";
export const HEADER = ["id", "claim", "status", "tests", "verdict", "waits"];
export const STATUSES = ["bitten", "not yet run", "no test", "out of tree"];
export const WAITS = ["-", "restatement", "scope"];
const ID = /^(?:[1-9]|1[01])[a-z]?$|^junk$/;
const VERDICT_KEYS = ["arms", "base", "command", "green", "id", "recorded", "tests"];
const count = (text, part) => text.split(part).length - 1;

/** Every way the table in `root` is wrong, one line each; an empty list is a clean table. */
export function checkTable(root) {
  const out = [];
  const lines = readFileSync(join(root, TABLE), "utf8").split("\n").filter((l) => l !== "");
  if (lines[0] !== HEADER.join("\t")) out.push(`${TABLE}: the header is not ${HEADER.join(", ")}`);
  const suite = new Set(testFiles(root));
  const ids = new Set();
  const named = new Set();
  for (const line of lines.slice(1)) {
    const f = line.split("\t");
    const id = f[0] ?? "";
    if (f.length !== HEADER.length || f.some((x) => x === "")) { out.push(`${id}: not ${HEADER.length} filled fields`); continue; }
    const [, claim, status, tests, verdict, waits] = f;
    if (!ID.test(id)) out.push(`${id}: not an id`);
    if (ids.has(id)) out.push(`${id}: named twice`);
    ids.add(id);
    if (claim.length > 160) out.push(`${id}: the claim is longer than one line`);
    if (!STATUSES.includes(status)) out.push(`${id}: status ${status} is not one of ${STATUSES.join(", ")}`);
    if (!WAITS.includes(waits)) out.push(`${id}: waits ${waits} is not one of ${WAITS.join(", ")}`);
    if (status === "out of tree" && waits !== "scope") out.push(`${id}: out of tree waits on scope`);
    const list = tests === "-" ? [] : tests.split(" ");
    if (new Set(list).size !== list.length) out.push(`${id}: a test named twice`);
    const testless = status === "no test" || status === "out of tree";
    if (testless !== (list.length === 0)) out.push(`${id}: ${status} with ${list.length} test files`);
    for (const t of list) if (!suite.has(t)) out.push(`${id}: ${t} is not a test the suite runs (renamed or deleted? update this row)`);
    if (verdict !== `${VERDICTS}/${id}.json`) out.push(`${id}: the verdict path is ${VERDICTS}/${id}.json`);
    const has = existsSync(join(root, verdict));
    if (has !== (status === "bitten")) out.push(`${id}: ${status} ${has ? "with" : "without"} a verdict file`);
    if (status === "bitten" && has) { named.add(`${id}.json`); out.push(...checkVerdict(root, id, verdict, list)); }
  }
  for (let n = 1; n <= 11; n++) {
    if (![...ids].some((i) => i.replace(/[a-z]+$/, "") === String(n))) out.push(`invariant ${n} has no row`);
  }
  const dir = join(root, VERDICTS);
  for (const f of existsSync(dir) ? readdirSync(dir) : []) if (!named.has(f)) out.push(`${VERDICTS}/${f}: no bitten row names it`);
  return out;
}

function checkVerdict(root, id, path, list) {
  const out = [];
  let v;
  try { v = JSON.parse(readFileSync(join(root, path), "utf8")); } catch { return [`${id}: the verdict is not JSON`]; }
  if (Object.keys(v).sort().join() !== VERDICT_KEYS.join()) out.push(`${id}: the verdict keys are ${VERDICT_KEYS.join(", ")}`);
  if (v.id !== id) out.push(`${id}: the verdict names ${String(v.id)}`);
  if (typeof v.base !== "string" || !/^[0-9a-f]{40}$/.test(v.base)) out.push(`${id}: base is not a commit`);
  if (typeof v.recorded !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.recorded)) out.push(`${id}: recorded is not a date`);
  if (typeof v.command !== "string" || v.command === "") out.push(`${id}: no command`);
  const tests = Array.isArray(v.tests) ? v.tests : [];
  if (tests.length === 0 || tests.some((t) => !list.includes(t))) out.push(`${id}: the verdict's tests are not this row's`);
  const arms = Array.isArray(v.arms) ? v.arms : [];
  if (arms.length === 0) out.push(`${id}: no arm`);
  for (const a of arms.map((x) => (x !== null && typeof x === "object" ? x : {}))) {
    const file = typeof a.file === "string" ? a.file : "";
    if (list.includes(file)) out.push(`${id}: an arm mutates the test itself`);
    const text = file !== "" && existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null;
    if (text === null) out.push(`${id}: ${file} is gone; record the verdict again or set the row back to not yet run`);
    else if (typeof a.line !== "string" || a.line === "" || count(text, a.line) !== 1) out.push(`${id}: the deciding line no longer reads once in ${file}; record the verdict again or set the row back to not yet run`);
    if (typeof a.to !== "string" || a.to === a.line) out.push(`${id}: an arm changes nothing`);
    if (!Number.isInteger(a.failed) || a.failed < 1) out.push(`${id}: an arm shows no red`);
  }
  const g = v.green;
  if (!g || g.failed !== 0 || !Number.isInteger(g.passed) || g.passed < 1) out.push(`${id}: not green restored`);
  return out;
}
