/**
 * THE SENTENCE IS ON SCREEN BEFORE THE MIRROR MOVES. On the 18 Pro a
 * Park in the reader drew its pill together with the mirror's re-derivation (the whole list behind the
 * reader), 1.5–8 s after the tap, and neither a microtask nor a timer between speaking and
 * dispatching changed that. So the order is a CONTRACT: the pill reports its layout
 * (`toast-one.ts#paintGate`), the door awaits `painted()` — released by the report or by a short
 * bound — and only then dispatches. Held here on a real wire, with the gate and with its
 * fallback (a timer, since RN's `setImmediate` is a microtask shim), plus a census over `live.ts`
 * that no door speaks and dispatches in one task. The yield cut out reddens it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, paintFirst, type LiveWorldActions, type ToastOpts } from "../src/state/live";
import { PAINT_BOUND_MS, paintGate } from "../src/state/toast-one";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
interface SaidToast extends ToastOpts { say: string }

async function scene(painted?: () => Promise<void>) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const order: string[] = [];
  const raised: SaidToast[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m, opts) => {
      raised.push({ say: sayArg(m), ...(opts ?? {}) });
      order.push("sentence");
      // What React would do with the sentence's state: its flush is a microtask, its mount ends
      // the task. Both markers armed at the sentence must run before the dispatch publishes.
      queueMicrotask(() => order.push("microtask"));
      setTimeout(() => order.push("task-end"), 0);
    },
    uuid,
    zone: "UTC",
    ...(painted ? { painted } : {}),
  });
  return { fake, ...boot, actions, order, raised };
}

const triagePosts = (fake: ReturnType<typeof mailServer>, id: string) =>
  fake.seen
    .filter((r) => r.method === "POST" && r.url === `/messages/${id}/triage`)
    .map((r) => (JSON.parse(r.body) as { state: string }).state);

describe("a reader verb speaks, yields, then moves the mirror (the timer fallback)", () => {
  it("Park: sentence, then the microtask AND the task's end, then the engine's publish — and the act lands with its Undo", async () => {
    const live = await scene();
    live.fake.addMessage(dto("m1"));
    await live.engine.syncOnce();
    const off = live.engine.subscribe(() => live.order.push("publish"));

    expect(await live.actions.pileToggle("m1", "setAside")).toBe(true);
    off();

    const first = (w: string) => live.order.indexOf(w);
    expect(first("sentence"), live.order.join(" → ")).toBeGreaterThanOrEqual(0);
    expect(first("microtask"), live.order.join(" → ")).toBeGreaterThan(first("sentence"));
    expect(first("task-end"), live.order.join(" → ")).toBeGreaterThan(first("microtask"));
    expect(first("publish"), live.order.join(" → ")).toBeGreaterThan(first("task-end"));

    const said = live.raised.find((t) => t.say === Copy.toastAside);
    expect(said?.undo, "the way back still rides the sentence").toBeDefined();
    expect(triagePosts(live.fake, "m1")).toEqual(["set_aside"]);

    live.store.close();
    live.fake.server.close();
  });

  it("the yield is one TIMER task: every microtask and an earlier timer run first, a later timer runs after", async () => {
    const seen: string[] = [];
    setTimeout(() => seen.push("earlier timer"), 0);
    const p = paintFirst().then(() => seen.push("paintFirst"));
    queueMicrotask(() => seen.push("microtask"));
    setTimeout(() => seen.push("later timer"), 0);
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["microtask", "earlier timer", "paintFirst", "later timer"]);
  });
});

/* ── the gate: the act waits for the pill's layout, bounded ────────────────────────────────── */

describe("paintGate: the door is released by the pill's layout report, or by the bound", () => {
  it("released by onScreen — and not before", async () => {
    const gate = paintGate(10_000);
    let released = false;
    const p = gate.painted().then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(false);
    gate.onScreen();
    await p;
    expect(released).toBe(true);
  });

  it("released by the bound when no pill ever lays out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const gate = paintGate(15);
      const t0 = Date.now();
      let released = false;
      const p = gate.painted().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(14);
      expect(released, "the bound released before it ran out").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
    } finally {
      vi.useRealTimers();
    }
    expect(PAINT_BOUND_MS).toBeLessThanOrEqual(500);
  });

  it("on a real wire with the gate: Park's publish waits for the report; Undo still rides the sentence", async () => {
    const gate = paintGate(10_000);
    const live = await scene(gate.painted);
    live.fake.addMessage(dto("m1"));
    await live.engine.syncOnce();
    const off = live.engine.subscribe(() => live.order.push("publish"));
    const pressed = live.actions.pileToggle("m1", "setAside");
    await new Promise((r) => setTimeout(r, 30));
    expect(live.order, "nothing published before the pill reports").not.toContain("publish");
    live.order.push("on-screen");
    const reported = Date.now();
    gate.onScreen();
    expect(await pressed).toBe(true);
    off();
    expect(live.order.indexOf("publish")).toBeGreaterThan(live.order.indexOf("on-screen"));
    // Released BY THE REPORT: with a 10 s bound, a release that took the bound is a gate that heard nothing.
    expect(Date.now() - reported).toBeLessThan(2000);
    expect(live.raised.find((t) => t.say === Copy.toastAside)?.undo).toBeDefined();
    expect(triagePosts(live.fake, "m1")).toEqual(["set_aside"]);
    live.store.close();
    live.fake.server.close();
  });
});

/* ── the census: no door speaks and dispatches in one task ────────────────────────────────── */

const LIVE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "state", "live.ts");

/** A direct call in this statement — never inside a nested function, whose body is its own task. */
function calls(n: ts.Node, name: string): boolean {
  let found = false;
  const visit = (m: ts.Node) => {
    if (found) return;
    if (m !== n && (ts.isArrowFunction(m) || ts.isFunctionExpression(m) || ts.isFunctionDeclaration(m))) return;
    if (ts.isCallExpression(m) && m.expression.getText() === name) { found = true; return; }
    ts.forEachChild(m, visit);
  };
  visit(n);
  return found;
}

/**
 * Every block's statements in order: a `toast(` followed by an `engine.mutate(` with no
 * `await paintFirst()` between them shares a task with the publish (A); an un-awaited
 * `engine.mutate(` followed by a `toast(` does the same the other way round (B). A `mutate` that
 * is awaited in its own statement speaks after the wire, which is another task. Statement-level
 * only — an `if (...) { toast; return }` guards the flow it leaves and its block walks alone.
 */
function speakAndDispatchSites(source: string): string[] {
  const sf = ts.createSourceFile("live.ts", source, ts.ScriptTarget.Latest, true);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const isYield = (s: ts.Statement) => ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression)
    && ts.isCallExpression(s.expression.expression)
    && ["painted", "paintFirst"].includes(s.expression.expression.expression.getText());
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isBlock(n)) {
      let spoke: ts.Statement | null = null;
      let dispatched: ts.Statement | null = null;
      for (const s of n.statements) {
        if (isYield(s)) { spoke = null; dispatched = null; continue; }
        const plain = ts.isExpressionStatement(s) || ts.isVariableStatement(s) || ts.isReturnStatement(s);
        const t = plain && calls(s, "toast");
        const m = plain && calls(s, "engine.mutate");
        if (m && spoke !== null) out.push(`A toast@${line(spoke)} then mutate@${line(s)}`);
        if (t && dispatched !== null) out.push(`B mutate@${line(dispatched)} then toast@${line(s)}`);
        if (t) spoke = s;
        if (m) dispatched = /\bawait\b/.test(s.getText()) ? null : s;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/**
 * THE OPTIMISTIC DOORS DISPATCH THROUGH ONE FUNCTION: they speak and
 * hand the write to `gatedWrite`, which takes the message's chain slot, awaits the gate and only
 * then mutates. So the census has a second half — that function's own order — while the first
 * half still refuses any door that goes back to speaking and mutating in one task.
 */
function gatedWriteGatesFirst(source: string): "gates-first" | "mutates-first" | "no-gate" | "absent" {
  const sf = ts.createSourceFile("live.ts", source, ts.ScriptTarget.Latest, true);
  let decl: ts.VariableDeclaration | null = null;
  const find = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText() === "gatedWrite") decl = n;
    ts.forEachChild(n, find);
  };
  find(sf);
  if (decl === null) return "absent";
  const text = (decl as ts.VariableDeclaration).getText();
  const mutate = text.indexOf("engine.mutate(");
  if (mutate < 0) return "absent";
  const gate = text.indexOf("await onScreen");
  if (gate < 0) return "no-gate";
  return gate < mutate ? "gates-first" : "mutates-first";
}

describe("no door in live.ts speaks and dispatches in one task", () => {
  const source = fs.readFileSync(LIVE, "utf8");

  it("the census reads zero sites", () => {
    expect(speakAndDispatchSites(source)).toEqual([]);
  });

  it("the one gated door awaits the pill before it mutates", () => {
    expect(gatedWriteGatesFirst(source)).toBe("gates-first");
  });

  it("and it can see that yield cut out — no gate, and the two halves the other way round", () => {
    const cut = source.replace(/\n\s*await onScreen;/, "");
    expect(cut).not.toBe(source);
    expect(gatedWriteGatesFirst(cut)).toBe("no-gate");
    const reversed = "const gatedWrite = async (id, ms, onScreen, leaving) => {\n"
      + "  const v = await watched(engine.mutate(ms[0]));\n  await onScreen;\n  return [v];\n};";
    expect(gatedWriteGatesFirst(reversed)).toBe("mutates-first");
    expect(gatedWriteGatesFirst("const other = 1;")).toBe("absent");
  });

  it("and it can see one: a door back to speaking and mutating in one task, both orders, and a guard that returns is not one", () => {
    // The pre-fix shape of `tagCreate` — the door this lane took the race out of — planted where
    // `tagCreate` now hands its sentence to `pilePress`.
    const withoutYield = source.replace(
      '    return pilePress(messageId, refuse("tagTagged", typed), [m]);',
      '    toast(refuse("tagTagged", typed), undoable(inv));\n'
      + '    return said(await watched(engine.mutate(m)), null, refuse("liveSaveFailed"));',
    );
    expect(withoutYield).not.toBe(source);
    expect(speakAndDispatchSites(withoutYield)).toHaveLength(1);
    const reversed = `async function f() {\n  parts.push(watched(engine.mutate(m)));\n  toast(refuse("x"));\n}`;
    expect(speakAndDispatchSites(reversed)).toEqual(["B mutate@2 then toast@3"]);
    const guarded = `async function f() {\n  if (waiting) { toast(waiting); return true; }\n  const res = await engine.mutate(m);\n}`;
    expect(speakAndDispatchSites(guarded)).toEqual([]);
    const afterTheWire = `async function f() {\n  const v = await engine.mutate(m);\n  toast(refuse("x"));\n}`;
    expect(speakAndDispatchSites(afterTheWire)).toEqual([]);
  });
});
