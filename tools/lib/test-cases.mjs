// The cases of a test file, read as text: each by the name the checklist gives it, the titles of the describes
// it stands in and its own title, joined by " > " as the test runner prints them. A title is taken AS WRITTEN:
// the inside of its quotes, a template's placeholders as they stand (`${verb}`), a table's (`%s`, `$name`) too;
// a title that is no literal is the expression as written. So a case in a loop or a table is ONE name, found in
// the file's text, and stands for every run of it.
import { closeOf, literalInside, readSource, topLevelParts } from "./source-text.mjs";

export const SEP = " > ";
const GROUPS = new Set(["describe", "suite"]);
const CASES = new Set(["it", "test"]);
/** Modifiers that take their own argument list before the title's: `it.each(table)("title", ...)`. */
const WITH_ARGS = new Set(["each", "for", "skipIf", "runIf"]);
const PLAIN = new Set([
  "only",
  "skip",
  "todo",
  "concurrent",
  "sequential",
  "fails",
  "shuffle",
  "fixme",
  "fail",
  "slow",
  "serial",
  "parallel",
]);
/**
 * What makes a call no case that stands: skipped, left to do, or expected to fail, whatever the run. A case run on a
 * condition (`skipIf`, `runIf`: a service, a platform, a built bundle) stands where the condition holds, as in CI.
 */
const IDLE = new Set(["skip", "todo", "fails", "fail", "fixme"]);

/** A test of any runner the tree has, under a folder named test. */
export const isOldTestFile = (rel) =>
  /(^|\/)test\//.test(rel) && /(\.(test|spec)\.[cm]?[jt]sx?|\.pw\.ts|\.compare\.ts)$/.test(rel);

/** `path#case name` → { path, name } (name null for a whole file); the first `#` ends the path. */
export function splitKey(key) {
  const hash = key.indexOf("#");
  return hash < 0 ? { path: key, name: null } : { path: key.slice(0, hash), name: key.slice(hash + 1) };
}

/**
 * A call of describe, suite, it or test that starts at `at`: its kind, where its title's list opens, and the first
 * modifier that makes it stand for nothing (`it.todo`, `describe.skip`, …), null when none does.
 */
function callAt(code, at, head) {
  let kind = GROUPS.has(head) ? "group" : "case";
  let idle = null;
  let i = at + head.length;
  for (;;) {
    while (/\s/.test(code[i] ?? "")) i += 1;
    if (code[i] === "(") return { kind, open: i, idle };
    if (code[i] !== ".") return null;
    i += 1;
    while (/\s/.test(code[i] ?? "")) i += 1;
    const mod = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 40))?.[0];
    if (!mod) return null;
    i += mod.length;
    if (IDLE.has(mod)) idle ??= `${head}.${mod}`;
    if (mod === "describe" && head === "test") kind = "group";
    else if (WITH_ARGS.has(mod)) {
      while (/\s/.test(code[i] ?? "")) i += 1;
      if (code[i] !== "(") return null;
      i = closeOf(code, i);
      if (i < 0) return null;
      i += 1;
    } else if (!PLAIN.has(mod)) return null;
  }
}

/** The title of a call whose list opens at `open`, as written. */
function titleOf(code, text, open, close) {
  const [first] = topLevelParts(code, open + 1, close);
  if (!first) return "";
  const raw = text.slice(first[0], first[1]).trim();
  const lead = text.slice(first[0], first[1]).length - text.slice(first[0], first[1]).trimStart().length;
  const asCode = code.slice(first[0] + lead, first[0] + lead + raw.length);
  return literalInside(asCode, raw) ?? raw;
}

/**
 * Every case of a test file, in the order it is written: `{ name, at, idle }`, `name` the describes' titles and the
 * case's own, joined by " > "; `idle` the modifier, of the case or a describe around it, that makes it no case that
 * stands (`it.todo`, `it.skip`, `it.skipIf`, `it.fails`, `describe.skip`, …), else null. A case written inside another
 * case's body is no case of the file (a runner's step, a skip inside a test), and neither is a describe written there.
 * @param {string} text
 */
export function casesOf(text) {
  const { code } = readSource(text);
  const calls = [];
  const word = /\b(describe|suite|it|test)\b/g;
  for (const match of code.matchAll(word)) {
    const before = code[match.index - 1] ?? "";
    if (before === "." || /[\w$]/.test(before)) continue;
    const call = callAt(code, match.index, match[1]);
    if (!call) continue;
    const close = closeOf(code, call.open);
    if (close < 0) continue;
    calls.push({ ...call, at: match.index, close, title: titleOf(code, text, call.open, close) });
  }
  const inside = (outer, inner) => outer.open < inner.at && inner.at < outer.close;
  const cases = calls.filter((c) => c.kind === "case");
  const kept = cases.filter((c) => !cases.some((other) => other !== c && inside(other, c)));
  return kept.map((c) => {
    const groups = calls.filter((g) => g.kind === "group" && inside(g, c) && !kept.some((k) => inside(k, g)));
    const lineOf = text.slice(0, c.at).split("\n").length;
    const idle = c.idle ?? groups.find((g) => g.idle)?.idle ?? null;
    return { name: [...groups.map((g) => g.title), c.title].join(SEP), at: lineOf, idle };
  });
}

/**
 * Whether the file holds a case of this name, by `casesOf`. The runner's own name of one run of a table or a loop
 * is not this name: the checklist names the case as written.
 */
export function caseNamed(text, name) {
  return casesOf(text).some((c) => c.name === name);
}
