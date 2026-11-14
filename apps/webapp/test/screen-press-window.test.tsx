/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryMirrorStore,
  routingIntentsKey,
  ruleFingerprint,
  screenIntentsKey,
  type EngineMutation,
  type EntityReader,
  type RuleDTO,
  type ScreenIntent,
  type SyncChange,
} from "@ohmail/client-engine";
import { useRoutingUndo, type ScreenCommitOutcome } from "@ohmail/app-logic/press/routing-undo";

/**
 * A SENDER-SHEET PRESS IS HELD AS A SCREEN INTENT, AND ITS ANSWER RIDES IT. Inside the window nothing
 * is sent; at the close the one commit planner writes the ladder and removes a shown rule only as
 * it was shown; a press stranded by a closed tab replays at the next launch WITH its resolution.
 */
const ADDR = "alerts@kestrel.example";
const OWNER = "acct";
let seq = 0;

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z", ...o,
  } as RuleDTO;
}
const bare = rule({ id: "bare", destination: "INBOX" });
const term = rule({ id: "term", destination: "ohmail/News", subjectContains: "[Monitor]" });

async function mirror(rules: RuleDTO[]): Promise<EntityReader> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })) as SyncChange[]);
  return store;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => { vi.useFakeTimers(); try { window.localStorage.clear(); } catch { /* no jar is its own case */ } });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove(); root = null; host = null;
  vi.useRealTimers();
});

async function windowOver(read: EntityReader) {
  const out: EngineMutation[] = [];
  const toasts: string[] = [];
  let latest: ReturnType<typeof useRoutingUndo> | null = null;
  function Probe(): null {
    latest = useRoutingUndo({
      read: () => read,
      send: async (m) => { out.push(m); return { status: "confirmed" as const }; },
      toast: (s) => { toasts.push(s); },
      copy: { gone: "gone", expired: () => "expired", correction: () => "correction" },
      owner: OWNER, windowMs: 1_000, now: () => Date.now(),
    });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(Probe)); });
  return { out, toasts, get: () => latest! };
}

describe("the press is held, and its answer is what commits", () => {
  it("nothing inside the window; at the close the shown rule is removed and the press is told", async () => {
    const w = await windowOver(await mirror([bare, term]));
    const told: ScreenCommitOutcome[] = [];
    const opened = w.get().holdScreen({
      id: "p1", seedId: "m1", address: ADDR, dest: "ohbox", messageIds: ["m1"],
      note: { sender: ADDR, place: "Ohbox", count: 1 }, makeRule: true, applyRetro: false,
      resolution: "remove", shown: [{ id: term.id, fp: ruleFingerprint(term) }], moves: [],
      after: (o) => { told.push(o); },
    });
    expect(opened.held).toBe(true);
    expect(w.out, "a rule went out inside the window").toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(w.out).toEqual([{ kind: "rule_delete", ruleId: "term" }]);
    expect(told.map((o) => [o.worst, o.changed])).toEqual([["confirmed", []]]);
  });

  it("Undo inside the window sends nothing", async () => {
    const w = await windowOver(await mirror([bare, term]));
    w.get().holdScreen({
      id: "p2", seedId: "m1", address: ADDR, dest: "ohbox", messageIds: ["m1"],
      note: { sender: ADDR, place: "Ohbox", count: 1 }, makeRule: true, applyRetro: false,
      resolution: "remove", shown: [{ id: term.id, fp: ruleFingerprint(term) }], moves: [],
    });
    await act(async () => { expect(w.get().undo(w.get().subjectOf(ADDR))).toBe(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(w.out).toEqual([]);
  });
});

describe("a press stranded by a closed tab replays with its resolution", () => {
  function strand(o: Partial<ScreenIntent> = {}): void {
    const row: ScreenIntent = {
      v: 2, verb: "screen", id: "s1", seedId: "m1", address: ADDR, scope: "sender", dest: "ohbox",
      messageIds: ["m1"], makeRule: true, applyRetro: false, resolution: "remove",
      shown: [{ id: term.id, fp: ruleFingerprint(term) }], at: Date.now() - 60_000, ...o,
    };
    window.localStorage.setItem(screenIntentsKey(routingIntentsKey(OWNER)), JSON.stringify([row]));
  }

  it("the rule the step showed is removed at the next launch", async () => {
    strand();
    const w = await windowOver(await mirror([bare, term]));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(w.out, "the replay dropped the press, or lost its answer").toEqual([{ kind: "rule_delete", ruleId: "term" }]);
    expect(window.localStorage.getItem(screenIntentsKey(routingIntentsKey(OWNER)))).toBeNull();
  });

  it("a rule edited while the tab was closed is left as it is", async () => {
    strand();
    const w = await windowOver(await mirror([bare, { ...term, subjectContains: "[Monitor] prod" }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(w.out).toEqual([]);
  });

  it("keep replays as keep", async () => {
    strand({ resolution: "keep" });
    const w = await windowOver(await mirror([bare, term]));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(w.out).toEqual([]);
    expect(window.localStorage.getItem(screenIntentsKey(routingIntentsKey(OWNER))), "a replayed press stayed journalled").toBeNull();
  });
});
