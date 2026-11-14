/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  consentPartition,
  mutationEffects,
  presentationReader,
  pressGained,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MessageBodyWire,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { shellSliceOf } from "./source-anchor";
import { COMMIT_MS } from "../app/shell/screener-state";
import { shellConsentOptions, type ShellConsentFacts } from "@ohmail/app-logic/press/consent-options";
import { screeningReadBack, screeningShown } from "@ohmail/app-logic/press/press-verdict";
import { dispatchScreeningChange, planScreeningChange, senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * THE COUNT IS WHAT YOU GAIN. Accepting a waiting sender said "Ohbox — 1 message
 * from them moved" while two of their letters appeared in the Ohbox: one moved back from Screened,
 * one already in the INBOX and shown at the gate until the rule placed it. The count was the
 * plan's moves. A count a sentence states is the rows the list shows at the place now and did not
 * before the press, read over the lists' own partition before the dispatch and at the answer.
 * TO WATCH IT FAIL: the past-the-gate toast's `count: pressGained(before, shownAt(subject, dest))`
 * in `screener-state.ts` → `count: plan.moved`, and the first two cases read 0, not 1 and 26.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-26T12:00:00.000Z");
const ADDR = "letters@split.example";
const FACTS: ShellConsentFacts = {
  known: true, standalone: false, dormancyDays: 90, screeningBaselineAt: null,
  screeningScope: "window", foldersEnabled: false,
};
const tr = createTranslator({ locale: "en", messages: messages as never, namespace: "screening" });

let seq = 0;
let sent: EngineMutation[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function msg(id: string, folder: Folder, date = "2026-09-25T09:00:00.000Z"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: ADDR }, to: [], cc: [],
    date, folder, snippet: `snippet ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-25T09:00:00.000Z",
  };
}

/** An engine that echoes every mutation's effects as the server would, and records what it was asked. */
async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(mail.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
          type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
          updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (): Promise<MessageBodyWire> => ({
        text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

interface StateLike {
  waiting: Array<{ id: string; from: { address: string }; gatePhysical?: boolean }>;
  decide: (sender: unknown, dest: string, opts: { read: boolean; scope: string }) => void;
}

/** The hook as `AppShell` wires it: the projected queue, and the count read over the same partition. */
async function mountScreener(engine: OhmailEngine, said: string[]): Promise<{ get: () => StateLike }> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: StateLike | null = null;
  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const reader = engine.read();
    const presented = presentationReader(reader, consentPartition(reader, shellConsentOptions(FACTS, NOW, [])));
    latest = useScreenerState(
      engine, v, ((m: string) => { said.push(m); }) as never, undefined, presented, true,
      undefined, [], [],
      (subject, dest) => screeningShown(engine.read(), subject, dest, { consent: FACTS, now: NOW, ownAddresses: [] }),
    ) as unknown as StateLike;
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: messages as never, timeZone: "UTC", now: NOW, children: h(Probe) }));
  });
  await settleFirstPaint();
  return { get: () => latest! };
}

/** The undo window closes, the awaited rule answers, and the toast is raised. */
async function settleCommit(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(COMMIT_MS + 50); });
  for (let i = 0; i < 24; i++) await act(async () => { await Promise.resolve(); });
}

async function acceptIntoOhbox(mail: EngineMessage[]): Promise<{ said: string[]; moves: number }> {
  const engine = await engineWith(mail);
  await engine.start();
  const said: string[] = [];
  const { get } = await mountScreener(engine, said);
  const row = get().waiting.find((s) => s.from.address === ADDR);
  expect(row, "the sender is not waiting in the Screener").toBeDefined();
  expect(row!.gatePhysical, "the row must take the past-the-gate press").toBe(false);
  await act(async () => { get().decide(row, "ohbox", { read: false, scope: "sender" }); });
  await settleCommit();
  return { said, moves: sent.filter((m) => m.kind === "move").length };
}

const ruled = (count: number) => tr("toastRuledMoved", { place: "Ohbox", sender: ADDR, count });

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("the Screener's accept says what the Ohbox gained", () => {
  it("one letter in the INBOX and one in Screened: one is there, and the Screened one stays where it is", async () => {
    // Ruled, the card files what it shows: the rule asks no past-mail answer, so the Screened letter
    // stays and the sentence says so; the count is the INBOX letter the rule placed.
    const { said, moves } = await acceptIntoOhbox([msg("in-1", "INBOX"), msg("sc-1", "ohmail/Screened", "2026-09-20T09:00:00.000Z")]);
    expect(moves, "an Ohbox decision moves nothing: the letter is already in the INBOX").toBe(0);
    expect(said, said.join(" | ")).toContain(ruled(1));
  });

  it("twenty-six already in the INBOX and one in Screened: twenty-six, and no move", async () => {
    const inbox = Array.from({ length: 26 }, (_, i) => msg(`in-${i}`, "INBOX", `2026-09-25T0${i % 10}:${String(i).padStart(2, "0")}:00.000Z`));
    const { said, moves } = await acceptIntoOhbox([...inbox, msg("sc-1", "ohmail/Screened", "2026-09-20T09:00:00.000Z")]);
    expect(moves).toBe(0);
    expect(said, said.join(" | ")).toContain(ruled(26));
  });

  it("the sentence says a letter is there, never that it moved", () => {
    for (const key of ["toastRuled", "toastRuledMoved", "toastRetargeted", "toastRuleQueued", "toastRuleFailing", "toastRuleUnsent"] as const) {
      expect(tr(key, { place: "Ohbox", sender: ADDR, count: 2 }), key).not.toMatch(/\bmoved\b/);
    }
  });
});

/**
 * THE SHEET'S DECIDE, OVER THE SAME READINGS the shell composes (`changeScreening`'s `say`): a
 * waiting sender with one letter at the gate, one in the INBOX shown at the gate, one in Screened.
 * The plan moves the gate letter (the Screened one is the pass's, THE-CLIENTS-FIFTY); the Ohbox gains two.
 */
describe("the sender sheet's count is the same reading", () => {
  it("a split waiting sender gains two where the plan moves one", async () => {
    const engine = await engineWith([
      msg("gate-1", "ohmail/Screener", "2026-09-25T10:00:00.000Z"),
      msg("in-1", "INBOX"),
      msg("sc-1", "ohmail/Screened", "2026-09-20T09:00:00.000Z"),
    ]);
    await engine.start();
    const sender = senderScreening(engine.verbRead(), "gate-1")!;
    const plan = planScreeningChange(sender, "ohbox", "sender", true);
    expect(plan.ruleState).toBe("promoted");
    expect(plan.moved, "the decide moves the gate letter; the Screened one is the pass's").toBe(1);
    const facts = { consent: FACTS, now: NOW, ownAddresses: [] as string[] };
    const subject = sender.scopes.sender.messages;
    const before = screeningShown(engine.verbRead(), subject, "ohbox", facts);
    const settled: Promise<unknown>[] = [];
    await dispatchScreeningChange(plan, [], (m) => { const p = engine.mutate(m); settled.push(p); return p; });
    await Promise.all(settled);
    const back = screeningReadBack(engine.verbRead(), "gate-1", undefined, "ohbox", "sender", { ...facts, retro: plan.retro });
    expect(back?.verdict.key, "the pass still owes the Screened letter").toBe("applying");
    expect(pressGained(before, back!.shown)).toBe(2);
  });

  it("a sender whose only letter is at the gate gains the one the decide moved (the control)", async () => {
    const engine = await engineWith([msg("gate-1", "ohmail/Screener", "2026-09-25T10:00:00.000Z")]);
    await engine.start();
    const sender = senderScreening(engine.verbRead(), "gate-1")!;
    const plan = planScreeningChange(sender, "ohbox", "sender", true);
    const facts = { consent: FACTS, now: NOW, ownAddresses: [] as string[] };
    const before = screeningShown(engine.verbRead(), sender.scopes.sender.messages, "ohbox", facts);
    const settled: Promise<unknown>[] = [];
    await dispatchScreeningChange(plan, [], (m) => { const p = engine.mutate(m); settled.push(p); return p; });
    await Promise.all(settled);
    expect(plan.moved).toBe(1);
    expect(pressGained(before, screeningShown(engine.verbRead(), sender.scopes.sender.messages, "ohbox", facts))).toBe(1);
  });

  it("every sheet sentence takes its count from pressGained, never from the plan's moves", () => {
    const says = shellSliceOf("changeScreening");
    expect(says).toMatch(/const before = shownNow\(\);/);
    expect(says).toMatch(/count: pressGained\(before, back\?\.shown \?\? shownNow\(\)\)/);
    expect(says).not.toMatch(/count: plan\.moved/);
    const held = shellSliceOf("holdScreenPress");
    expect(held.match(/count: p\.gained\(\)/g) ?? [], "the refused and queued sentences").toHaveLength(2);
    expect(shellSliceOf("pressSentence")).not.toMatch(/plan\.moved/);
    const bulk = shellSliceOf("onBulkScreen");
    expect(bulk.match(/count: gained\(\)/g) ?? [], "both bulk sentences").toHaveLength(2);
    expect(shellSliceOf("screenerShownAt"), "AppShell hands the Screener the lists' own reading")
      .toMatch(/screeningShown\(engine\.read\(\), subject, dest, \{ consent: demo \? null : consent/);
  });
});
