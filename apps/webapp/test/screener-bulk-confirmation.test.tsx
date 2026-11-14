/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement as h, useEffect, useState, type ReactElement } from "react";
import { render, within, type RenderResult } from "@testing-library/react";
import { MemoryMirrorStore, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import type { SuggestionOverlay } from "@ohmail/app-logic/screener/suggestion-overlay";
import { useScreenerState, type ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { ThemeProvider } from "@ohmail/ui";
import { Frame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { ScreenerAbove, screenerPlace, type ScreenerBeside } from "@ohmail/app/screener";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { NextIntlClientProvider } from "next-intl";
import { TextProvider } from "@ohmail/app/text";
import messages from "../messages/en.json";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const beside: ScreenerBeside = {
  letters: NONE, junk: NONE, unsubscribe: NONE, mailboxWord: () => null, suggest: NONE, invitation: NONE,
  facts: { settled: true, owed: false, storeImportOpen: false, notOrganizingYet: null },
  undo: () => false,
};
let seq = 0;
let sent: EngineMutation[] = [];
let arrivals: EngineMessage[] = [];
let mounted: RenderResult | null = null;
let host: HTMLElement | null = null;

function msg(id: string, from: string, hour: number): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

/**
 * An engine over a mirror already holding `mail`, with every mutation it issues recorded.
 */
async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    mail.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const creates = arrivals.map((m): SyncChange => ({
          type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
        }));
        arrivals = [];
        return {
          changes: { creates, updates: [], moves: [], deletes: [] },
          cursor: creates.length ? `c${seq}` : store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

beforeEach(() => {
  sent = [];
  arrivals = [];
  window.localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount(mail: EngineMessage[], suggestions?: SuggestionOverlay, autoUnsubscribe = true) {
  const engine = await engineWith(mail);
  const { host: frame } = fakeHost({
    engine, service: "self", scope: "acct", places: { screener: screenerPlace },
    address: fakeAddress("#/screener"), window: fakeWindow("desktop"),
  });
  let live: ScreenerState | null = null;

  function World(): ReactElement {
    const [version, setVersion] = useState(0);
    useEffect(() => engine.subscribe(() => setVersion((v) => v + 1)), []);
    const state = useScreenerState(engine, "acct", version, () => {}, useScreenerWords(), suggestions, undefined, autoUnsubscribe);
    live = state;
    return h(ScreenerAbove, { model: state, beside, children: h(Frame, { host: frame }) });
  }

  mounted = render(h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(ThemeProvider, { storageKey: null, children: h(TextProvider, { locale: "en", timeZone: "UTC", messages, children: h(World) }) }),
  }));
  host = mounted.container;
  await flush();
  return {
    latest: () => live!,
    arrive: async (mail: EngineMessage[]) => {
      arrivals.push(...mail);
      await act(async () => { await engine.syncOnce(); });
      await flush();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

async function press(key: string): Promise<void> {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await flush();
}

async function commit(latest: () => ScreenerState): Promise<void> {
  await act(async () => { latest().flush(); });
  await flush();
}

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const askNow = (): HTMLElement | null => within(document.body).queryByRole("dialog", { name: /waiting senders? as spam/ });

async function markAll(): Promise<void> {
  await click(within(host!).getByRole("button", { name: "List" }));
  const menu = within(document.body).getByRole("menu", { name: "List" });
  await click(within(menu).getByRole("menuitem", { name: "Mark all spam" }));
}

it("files only the original letters when the same sender writes during the question and Undo", async () => {
  const from = "news" + "@" + "sender.example";
  const { latest, arrive } = await mount([msg("original", from, 9)], undefined, false);
  await markAll();
  await arrive([msg("during-question", from, 10)]);
  await click(within(askNow()!).getByRole("button", { name: "Mark 1 as spam" }));
  await wait(300);
  await arrive([msg("during-undo", from, 11)]);
  await commit(latest);
  expect(sent.filter((m) => m.kind === "screener_decide")).toEqual([
    expect.objectContaining({ senderId: "original", confirmedIds: ["original"], applyRetro: false }),
  ]);
});

it("warns before applying suggestions from the button or shortcut and keeps Cancel free of writes", async () => {
  const from = "news" + "@" + "sender.example";
  const { latest, arrive } = await mount([msg("advised", from, 9)], new Map([
    [from, { dest: "spam", confidence: 0.9, rationale: "An unsolicited list" }],
  ]));
  const warning = "Later mail goes too, with 1 unsubscribe request and no undo.";
  const ask = () => within(document.body).getByRole("dialog", { name: /Apply.*suggestion/i });
  await click(within(host!).getByRole("button", { name: /Apply 1/ }));
  expect(ask().textContent).toContain(warning);
  await click(within(ask()).getByRole("button", { name: "Cancel" }));
  await wait(300);
  await commit(latest);
  expect(sent).toEqual([]);

  await press("a");
  expect(ask().textContent).toContain(warning);
  await arrive([msg("later", from, 11)]);
  await click(within(ask()).getByRole("button", { name: /Apply 1/ }));
  expect(sent).toHaveLength(1);
  await wait(300);
  await commit(latest);
  expect(sent).toEqual([expect.objectContaining({
    kind: "screener_decide", dest: "spam", confirmedIds: ["advised"], unsubscribeIds: ["advised"],
  })]);
});

it("warns about irreversible requests inside the Mark all spam confirmation", async () => {
  const from = "news" + "@" + "sender.example";
  await mount([msg("one", from, 9), msg("two", from, 10)]);
  await markAll();
  expect(askNow()?.textContent).toContain("Later mail goes too, with 2 unsubscribe requests and no undo.");
});

it("sends from the single-sender confirmation for the displayed IDs only", async () => {
  const from = "news" + "@" + "sender.example";
  const { arrive } = await mount([msg("shown", from, 9)]);
  await click(within(host!).getByRole("option"));
  await press("x");
  const ask = () => within(document.body).getByRole("dialog", { name: "Mark spam and unsubscribe" });
  expect(ask().textContent).toContain("one-click");
  await arrive([msg("after-warning", from, 10)]);
  expect(sent).toEqual([]);
  await click(within(ask()).getByRole("button", { name: "Continue" }));
  expect(sent).toEqual([expect.objectContaining({
    kind: "screener_decide", dest: "spam", unsubscribeIds: ["shown"],
  })]);
});
