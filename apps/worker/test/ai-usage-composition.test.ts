import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readSource } from "./_start-function.js";

/**
 * THE WORKER'S METERED USAGE COMPOSITION, read by a parse of the three composition roots: the
 * worker body (`index.ts`) and the two backstops (`workflow-cron.ts`, `proposal-cron.ts`). Each
 * fact is a composition a refactor can drop with everything still compiling and every other test
 * green, because the passes are driven elsewhere with their hooks handed in. The backstops open
 * their own pool and leader lock, so this reads their source rather than running them. Each
 * mutation the money-class review measured green is planted below and must redden this census.
 *
 * SCANNED ROOT: `apps/worker/src`.
 */

const SRC = resolve(import.meta.dirname ?? ".", "../src");
const FILES = { index: "index.ts", workflow: "workflow-cron.ts", proposal: "proposal-cron.ts" } as const;
type Sources = Record<keyof typeof FILES, string>;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

function parse(name: string, src: string): ts.SourceFile {
  return ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
}

/** Every `const <name> = …` initializer in the file, whitespace collapsed. */
function inits(sf: ts.SourceFile, name: string): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer) out.push(squash(n.initializer.getText(sf)));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** Every call to `callee`, with its arguments' text collapsed. */
function callsTo(sf: ts.SourceFile, callee: string): string[][] {
  const out: string[][] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === callee) out.push(n.arguments.map((a) => squash(a.getText(sf))));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** What is wrong with the composition, by name. Empty when every metered path records. */
function compositionFaults(src: Sources): string[] {
  const idx = parse(FILES.index, src.index);
  const wf = parse(FILES.workflow, src.workflow);
  const pr = parse(FILES.proposal, src.proposal);
  const faults: string[] = [];
  const need = (ok: boolean, what: string): void => { if (!ok) faults.push(what); };

  // The worker body: the relay and the buffer are composed on the metered condition, and armed.
  need(inits(idx, "usageRelay").includes("spend ? config.aiUsage : undefined"), "index: no relay beside the metered port");
  need(inits(idx, "recordUsage").includes("isMetered(entitlements) ? entitlements.recordUsage?.bind(entitlements) : undefined"),
    "index: the buffer's port is not the metered one");
  need(inits(idx, "usageBuffer").some((i) => i.startsWith("usageRelay && recordUsage ?") && i.includes("makeAiUsageBuffer(")),
    "index: no usage buffer");
  need(callsTo(idx, "usageRelay?.arm").length === 1, "index: the relay is never armed");
  const suggest = callsTo(idx, "screenerAutoSuggestPass");
  need(suggest.length === 2 && suggest.every((a) => a[1]?.includes("...(usageRelay ? { usageHook: usageRelay.hook } : {})")),
    "index: a Screener pass takes no usage hook");
  const idxDrain = callsTo(idx, "workflowDrainPass");
  need(idxDrain.length === 1 && idxDrain.every((a) => a[1]?.includes("attributedWorkflowDrafter(config.drafter, accountId, usageRelay.hook, usageBuffer)")),
    "index: the workflow drain's drafter is unattributed");

  // The workflow backstop: metered when configured, its buffer composed and flushed.
  need(inits(wf, "client").some((i) => i.startsWith("config.entitlements ? makeEntitlementsClient(")), "workflow-cron: no entitlements client");
  need(inits(wf, "entitlements").includes("client ?? UNMETERED"), "workflow-cron: composed unmetered");
  need(inits(wf, "usageRelay").includes("spend && config.drafter ? config.aiUsage : undefined"), "workflow-cron: no relay");
  need(inits(wf, "usageBuffer").some((i) => i.includes("makeAiUsageBuffer(")), "workflow-cron: no usage buffer");
  need(callsTo(wf, "usageBuffer?.flush").length === 1, "workflow-cron: the buffer is never flushed");
  need(callsTo(wf, "usageRelay?.arm").length === 1, "workflow-cron: the relay is never armed");
  const wfDrain = callsTo(wf, "workflowDrainPass");
  need(wfDrain.length === 1 && wfDrain.every((a) => a[1]?.includes("attributedWorkflowDrafter(config.drafter, accountId, usageRelay.hook, usageBuffer)")),
    "workflow-cron: the drafter is unattributed");

  // The proposal backstop: its relay is composed and armed, and its pass takes the hook.
  need(inits(pr, "usageRelay").includes("metered && spend ? config.aiUsage : undefined"), "proposal-cron: no relay");
  need(callsTo(pr, "usageRelay?.arm").length === 1, "proposal-cron: the relay is never armed");
  const gen = callsTo(pr, "proposalGeneratePass");
  need(gen.length === 1 && gen.every((a) => a[1]?.includes("...(usageRelay ? { usageHook: usageRelay.hook } : {})")),
    "proposal-cron: the pass takes no usage hook");
  return faults;
}

/** The stop() method of the object the worker body returns: the order its usage calls run in. */
function stopOrder(src: string): string[] {
  const sf = parse(FILES.index, src);
  let body: ts.Node | undefined;
  const find = (n: ts.Node): void => {
    if (ts.isMethodDeclaration(n) && n.name.getText(sf) === "stop" && n.body?.getText(sf).includes("teardown")) body = n.body;
    ts.forEachChild(n, find);
  };
  find(sf);
  if (!body) throw new Error("index.ts declares no stop() with a teardown");
  const keep: Record<string, string> = { clearTimers: "clearTimers", drain: "drain", "usageBuffer?.flush": "flush", "owned.close": "close" };
  const out: Array<{ name: string; pos: number }> = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = keep[n.expression.getText(sf)];
      if (name) out.push({ name, pos: n.getStart(sf) });
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return out.sort((a, b) => a.pos - b.pos).map((c) => c.name);
}

const read = (f: string): string => readSource(resolve(SRC, f));
const real: Sources = { index: read(FILES.index), workflow: read(FILES.workflow), proposal: read(FILES.proposal) };

/** Replace exactly one occurrence, or throw: a planted mutation that matched nothing measures nothing. */
function plant(src: string, from: string | RegExp, to: string): string {
  const hits = typeof from === "string" ? src.split(from).length - 1 : (src.match(new RegExp(from, "g")) ?? []).length;
  if (hits < 1) throw new Error(`the planted mutation matched nothing: ${String(from)}`);
  return src.replace(typeof from === "string" ? new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : new RegExp(from, "g"), to);
}

describe("the worker's metered usage composition", () => {
  it("every metered path records, in all three composition roots", () => {
    expect(compositionFaults(real)).toEqual([]);
  });

  // The mutations two reviews measured green, each planted here and each refused.
  const MUTATIONS: Array<[string, keyof Sources, string | RegExp, string]> = [
    ["the body composes no relay", "index", "const usageRelay = spend ? config.aiUsage : undefined;", "const usageRelay = undefined as typeof config.aiUsage;"],
    ["the Screener passes take no hook", "index", "                ...(usageRelay ? { usageHook: usageRelay.hook } : {}),\n", ""],
    ["the drain's drafter is unattributed", "index", "attributedWorkflowDrafter(config.drafter, accountId, usageRelay.hook, usageBuffer)", "config.drafter"],
    ["the body composes no buffer", "index", /const usageBuffer = usageRelay && recordUsage\n\s*\? makeAiUsageBuffer\([^\n]*\n\s*: undefined;/, "const usageBuffer = undefined;"],
    ["the workflow backstop is unmetered", "workflow", "const entitlements: EntitlementsComposition = client ?? UNMETERED;", "const entitlements: EntitlementsComposition = UNMETERED;"],
    ["the workflow backstop has no buffer", "workflow", /const usageBuffer = usageRelay && client\?\.recordUsage\n\s*\? makeAiUsageBuffer\([^\n]*\n\s*: undefined;/, "const usageBuffer = undefined;"],
    ["the proposal backstop takes no hook", "proposal", "          ...(usageRelay ? { usageHook: usageRelay.hook } : {}),\n", ""],
    ["the body's buffer has no port", "index", "const recordUsage = isMetered(entitlements) ? entitlements.recordUsage?.bind(entitlements) : undefined;", "const recordUsage = undefined;"],
    ["the workflow backstop composes no relay", "workflow", "const usageRelay = spend && config.drafter ? config.aiUsage : undefined;", "const usageRelay = undefined as typeof config.aiUsage;"],
  ];
  for (const [name, file, from, to] of MUTATIONS) {
    it(`${name}: the census refuses it`, () => {
      expect(compositionFaults({ ...real, [file]: plant(real[file], from, to) })).not.toEqual([]);
    });
  }

  it("stop() flushes before drain() and after it, both before the pool closes", () => {
    expect(stopOrder(real.index)).toEqual(["clearTimers", "flush", "drain", "flush", "close"]);
    expect(stopOrder(plant(real.index, /\n\s*await usageBuffer\?\.flush\(\);\n(\s*await drain\(\);)/, "\n$1")))
      .toEqual(["clearTimers", "drain", "flush", "close"]);
  });

  it("the composition root hands the model client its logger, lazily", () => {
    const load = callsTo(parse(FILES.index, real.index), "loadConfig");
    expect(load).toHaveLength(1);
    expect(load[0]!.join(", ")).toMatch(/log:\s*\(\)\s*=>\s*cliLog/);
  });

  it("the ingest classifier is the attributed one", () => {
    const sf = parse(FILES.index, real.index);
    expect(callsTo(sf, "attributedIngestClassifier")).toHaveLength(1);
    expect(callsTo(sf, "attributedIngest").some((a) => a[0] === "classifierCircuit.port(mailboxId)")).toBe(true);
  });
});
