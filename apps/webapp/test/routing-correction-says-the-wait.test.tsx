/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryMirrorStore, type EngineMessage, type EngineMutation, type SyncChange } from "@ohmail/client-engine";
import { useRoutingUndo, type RoutingSendResult } from "@ohmail/app-logic/press/routing-undo";
import type { ScreeningToastKey } from "@ohmail/app-logic/press/sender-screening";

/**
 * THE ROUTING WINDOW'S CORRECTION SAYS WHICH WAIT IT IS. A move press held in the window makes the
 * sender's rule at the close; when that rule's answer is queued, the correction said "made when
 * you're back online" over a server's failure while online. It now takes the same three waits as
 * the Rules page: a failure as one, "back online" only offline, otherwise not arrived yet.
 */
const ADDR = "lena@atelier.example";
let seq = 0;
const msg = (id: string): EngineMessage => ({
  id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Subject ${id}`,
  from: { name: null, address: ADDR }, to: [], cc: [], date: "2026-08-02T09:00:00.000Z", folder: "INBOX",
  snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
} as EngineMessage);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove(); root = null; host = null;
  vi.useRealTimers();
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
});

async function correctionFor(answer: RoutingSendResult): Promise<ScreeningToastKey[]> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{ type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: "2026-08-02T09:00:00.000Z", entity: msg("m1") }] as SyncChange[]);
  const said: ScreeningToastKey[] = [];
  const sent: EngineMutation[] = [];
  let latest: ReturnType<typeof useRoutingUndo> | null = null;
  function Probe(): null {
    latest = useRoutingUndo({
      read: () => store,
      send: async (m) => { sent.push(m); return answer; },
      toast: () => {},
      copy: { gone: "gone", expired: () => "expired", correction: (key) => { said.push(key); return key; } },
      owner: `acct-${++seq}`, windowMs: 1_000, now: () => Date.now(),
    });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(Probe)); });
  latest!.hold({
    id: `p-${seq}`, seedId: "m1", address: ADDR, dest: "reads", messageIds: ["m1"],
    note: { sender: ADDR, place: "News", count: 1 },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(sent.map((m) => m.kind), "the window sent no rule").toContain("rule_create");
  return said;
}

describe("the routing window's correction over a queued rule", () => {
  it("a server failure is said as one", async () => {
    expect(await correctionFor({ status: "queued", serverFailed: true })).toEqual(["toastRuleFailing"]);
  });

  it("online and unanswered: not arrived yet, never 'back online'", async () => {
    expect(await correctionFor({ status: "queued" })).toEqual(["toastRuleUnsent"]);
  });

  it("offline: back online", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    expect(await correctionFor({ status: "queued" })).toEqual(["toastRuleQueued"]);
  });

  it("a confirmed rule says nothing (the control)", async () => {
    expect(await correctionFor({ status: "confirmed" })).toEqual([]);
  });
});
