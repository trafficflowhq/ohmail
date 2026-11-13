import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_PASSES } from "../src/pass-registry.js";
import { TAIL_SECTION_PLAN } from "../src/cycle-tail-plan.js";
import { lineOf, span, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { readSource } from "./_start-function.js";

/**
 * EVERY CYCLE-TAIL CATCH GOES THROUGH THE RUNNER. In the worker entry's tail (from `tailSnapshot` to
 * `tailPosition`) no catch stands outside the allow list, and every section's `run` and `enter` CALLS
 * `runTailStage(` or `tailFaultNote(` — a call, not the name appearing. In the tail's pass modules
 * every catch that swallows either hands the error to the runner's hook or is named below with its
 * reason. Each rule is driven against a planted fixture first, so a zero is a reading.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRY = "apps/worker/src/index.ts";
const RUNNER_CALL = /\b(?:runTailStage|tailFaultNote)\s*\(/;
const HOOK_CALL = /\b(?:noteFault|onError)\s*(?:\?\.)?\s*\(/;

interface Allowed { readonly file: string; readonly anchor: string; readonly reason: string }

/** Catches in the ENTRY's tail that are not a stage's, by an anchor inside their body. */
const ENTRY_ALLOWED: readonly Allowed[] = [
  { file: ENTRY, anchor: "cycle_tail_failed_unexpectedly",
    reason: "kickTail's queue entry: the net behind cycleTail, whose every slice is already on the runner" },
];

/** Swallowing catches in the tail's pass modules, by an anchor inside their body. */
const MODULE_ALLOWED: readonly Allowed[] = [
  { file: "apps/worker/src/workflow-cron.ts", anchor: "account_failed",
    reason: "runWorkflowCron, the dead-worker backstop: not on the tail's path" },
  { file: "apps/worker/src/workflow-cron.ts", anchor: "pool_close_failed",
    reason: "runWorkflowCron closing its own pool: not on the tail's path" },
  { file: "apps/worker/src/list-address-backfill.ts", anchor: "return [v as string]",
    reason: "a stored header parsed as JSON: no I/O" },
  { file: "apps/worker/src/screener-correspondent-retro.ts", anchor: "return v as string",
    reason: "a stored header parsed as JSON: no I/O" },
  { file: "packages/core/src/message-search.ts", anchor: "A body nobody can render",
    reason: "an html body converted to text: no I/O" },
  { file: "packages/core/src/message-search.ts", anchor: "return false",
    reason: "searchIndexBuilt reads a failed read as unbuilt; the backfill's next statement meets the same database and throws to the runner" },
  { file: "apps/worker/src/thread-join-heal.ts", anchor: "thread_join_heal_group_retrying",
    reason: "the first of two attempts; the second's catch hands the error to noteFault" },
  { file: "apps/worker/src/screener-auto-suggest.ts", anchor: "screener_auto_suggest_model_failed",
    reason: "the model's refusal: a remote, never our database" },
  { file: "apps/worker/src/screener-auto-suggest.ts", anchor: "screener_auto_suggest_release_failed",
    reason: "the entitlements program's claim release: a remote, never our database" },
  { file: "apps/worker/src/retention-prune.ts", anchor: "retention_prune_account_failed",
    reason: "never throws by contract (global_maintenance awaits it bare); a LOW gap row owns announcing it" },
  { file: "apps/worker/src/retention-prune.ts", anchor: "retention_prune_failed",
    reason: "never throws by contract; a LOW gap row owns announcing it" },
  { file: "apps/worker/src/retention-prune.ts", anchor: "sign_in_retention_failed",
    reason: "never throws by contract; a LOW gap row owns announcing it" },
  { file: "apps/worker/src/refund-obligation-drain.ts", anchor: "refund_obligation",
    reason: "never throws by contract (global_maintenance awaits it bare); a LOW gap row owns announcing it" },
];

/** Every catch in `src` (statement or `.catch(`): its line, raw body and blanked body. Found in the
 *  blanked code, so a catch inside a comment or a string is none; the raw body carries the anchor. */
function catchesIn(src: string, lineBase = 0): Array<{ line: number; body: string; code: string }> {
  const code = withoutCommentsAndLiterals(src);
  const out: Array<{ line: number; body: string; code: string }> = [];
  for (const m of code.matchAll(/\bcatch\b/g)) {
    const open = code.indexOf("{", m.index);
    const [s, e] = span(code, open, "{", "}");
    out.push({ line: lineBase + lineOf(src, m.index), body: src.slice(s, e), code: code.slice(s, e) });
  }
  return out;
}

/** The entry's tail region: the snapshot, the table, the walk and its queue entry. */
function tailRegion(entry: string): { text: string; offset: number } {
  const b = entry.indexOf("async function tailSnapshot(");
  const e = entry.indexOf("function tailPosition(");
  expect(b, "tailSnapshot was not found").toBeGreaterThanOrEqual(0);
  expect(e, "tailPosition was not found after tailSnapshot").toBeGreaterThan(b);
  return { text: entry.slice(b, e), offset: b };
}

/** Catches in the region that no allowed anchor names. */
function strayCatches(src: string, allowed: readonly Allowed[], file: string, lineBase = 0): string[] {
  return catchesIn(src, lineBase)
    .filter((c) => !/\bthrow\b/.test(c.code) && !HOOK_CALL.test(c.code))
    .filter((c) => !allowed.some((a) => a.file === file && c.body.includes(a.anchor)))
    .map((c) => `${file}:${c.line}`);
}

/** The top-level `name: value` properties of one object body, split at depth zero. */
function properties(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const flush = (end: number): void => {
    const part = body.slice(start, end);
    const m = /^\s*([A-Za-z_]+)\s*:/.exec(part);
    if (m) out.set(m[1]!, part.slice(m[0].length));
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) { flush(i); start = i + 1; }
  }
  flush(body.length);
  return out;
}

/** Sections whose `run` or `enter` does not CALL the runner. */
function sectionsOffRunner(region: string, names: readonly string[]): string[] {
  const code = withoutCommentsAndLiterals(region);
  const off: string[] = [];
  for (const name of names) {
    const at = code.indexOf(`\n      ${name}: {`);
    if (at < 0) { off.push(`${name} (no row)`); continue; }
    const [s, e] = span(code, code.indexOf("{", at + 1), "{", "}");
    const props = properties(code.slice(s, e));
    if (!props.has("run")) off.push(`${name}.run (absent)`);
    for (const key of ["run", "enter"] as const) {
      const v = props.get(key);
      if (v !== undefined && !RUNNER_CALL.test(v)) off.push(`${name}.${key}`);
    }
  }
  return off;
}

const read = (p: string): string => readSource(join(REPO, p));
const tailModules = [
  ...new Set(WORKER_PASSES.filter((p) => p.triggers.includes("cycle-tail")).map((p) => p.module)),
  "apps/worker/src/away-reply-sweep.ts", "apps/worker/src/retention-prune.ts", "apps/worker/src/refund-obligation-drain.ts",
].filter((m) => m !== ENTRY);

describe("every cycle-tail catch goes through the runner", () => {
  it("refuses a planted bare catch and a named-but-uncalled runner, and admits the runner's shapes", () => {
    const planted = [
      "async function tailSnapshot() {}",
      "const TAIL_IMPL = {",
      "      bare: {",
      "        run: async (a) => { try { await p(a); } catch (err) { log.error(\"bare_failed\", { err }); } },",
      "      },",
      "      named: {",
      "        run: async (a) => { const f = runTailStage; await f(\"x\", \"database\", () => p(a), () => {}); },",
      "      },",
      "      good: {",
      "        enter: async () => { let o = []; await runTailStage(\"y\", \"database\", async () => { o = await q(); }, () => {}); return o; },",
      "        run: async (a) => { await runTailStage(\"x\", \"database\", () => p(a), (err) => { log.error(\"good_failed\", { err }); }); },",
      "      },",
      "      hooked: {",
      "        run: async (a) => { await p(a, { noteFault: tailFaultNote(\"z\") }); },",
      "      },",
      "};",
      "function tailPosition() {}",
    ].join("\n");
    const { text } = tailRegion(planted);
    expect(sectionsOffRunner(text, ["bare", "named", "good", "hooked"])).toEqual(["bare.run", "named.run"]);
    expect(strayCatches(text, [], "fixture")).toEqual(["fixture:4"]);
    expect(strayCatches(text, [{ file: "fixture", anchor: "bare_failed", reason: "control" }], "fixture")).toEqual([]);
  });

  it("refuses a planted swallowing module catch, and admits a rethrow and a hooked catch", () => {
    const mod = [
      "export async function p(db, deps) {",
      "  try { await db.a(); } catch (err) { log.warn(\"swallowed\", { err }); }",
      "  try { await db.b(); } catch (err) { if (!(err instanceof X)) throw err; }",
      "  try { await db.c(); } catch (err) { deps.noteFault?.(err); log.error(\"hooked\", { err }); }",
      "  // try { } catch (err) { a comment is not a catch }",
      "}",
    ].join("\n");
    expect(strayCatches(mod, [], "m.ts")).toEqual(["m.ts:2"]);
  });

  it("finds every tail section of the entry on the runner, and no stray catch in its tail", () => {
    const entry = read(ENTRY);
    const { text, offset } = tailRegion(entry);
    const names = TAIL_SECTION_PLAN.map((s) => s.name);
    expect(names.length, "no tail sections were read").toBeGreaterThan(15);
    expect(sectionsOffRunner(text, names), "a tail section's pass runs outside the runner").toEqual([]);
    const strays = strayCatches(text, ENTRY_ALLOWED, ENTRY, lineOf(entry, offset) - 1);
    expect(strays, "a catch in the cycle tail swallows outside the runner").toEqual([]);
    expect(catchesIn(text).length, "the tail's catches were not read at all").toBeGreaterThan(0);
  });

  it("finds no swallowing catch in a tail pass module outside the hook and the allow list", () => {
    expect(tailModules.length, "no tail modules were read").toBeGreaterThan(15);
    const strays = tailModules.flatMap((m) => strayCatches(read(m), MODULE_ALLOWED, m));
    expect(strays, "a tail pass swallows a failure the runner never hears").toEqual([]);
    const hooked = tailModules.flatMap((m) => catchesIn(read(m)).filter((c) => HOOK_CALL.test(c.code)));
    expect(hooked.length, "no module catch hands its error to the runner's hook").toBeGreaterThanOrEqual(5);
  });

  it("names no allowed entry that no longer matches a catch", () => {
    const stale = [...ENTRY_ALLOWED, ...MODULE_ALLOWED].filter((a) =>
      !catchesIn(read(a.file)).some((c) => c.body.includes(a.anchor)));
    expect(stale.map((a) => `${a.file}: ${a.anchor}`), "an allow-list entry matches nothing").toEqual([]);
  });
});
