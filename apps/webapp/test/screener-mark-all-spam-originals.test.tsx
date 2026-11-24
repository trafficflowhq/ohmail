/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h, useEffect, useState, type ReactElement } from "react";
import { render, within, type RenderResult } from "@testing-library/react";
import { MemoryMirrorStore, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { useScreenerState, type ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { ThemeProvider } from "@ohmail/ui";
import { Frame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { ScreenerAbove, screenerPlace, type ScreenerBeside } from "@ohmail/app/screener";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { NextIntlClientProvider } from "next-intl";
import { TextFromIntl } from "../app/shell/LocaleContext";
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

async function mount(mail: EngineMessage[]) {
  const engine = await engineWith(mail);
  const { host: frame } = fakeHost({
    engine, service: "self", scope: "acct", places: { screener: screenerPlace },
    address: fakeAddress("#/screener"), window: fakeWindow("desktop"),
  });
  let live: ScreenerState | null = null;

  function World(): ReactElement {
    const [version, setVersion] = useState(0);
    useEffect(() => engine.subscribe(() => setVersion((v) => v + 1)), []);
    const state = useScreenerState(engine, "acct", version, () => {}, useScreenerWords(), undefined, undefined, false);
    live = state;
    return h(ScreenerAbove, { model: state, beside, children: h(Frame, { host: frame }) });
  }

  mounted = render(h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(ThemeProvider, { storageKey: null, children: h(TextFromIntl, { children: h(World) }) }),
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

const decided = (): string[] =>
  sent.filter((m) => m.kind === "screener_decide").map((m) => m.senderId);
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const askNow = (): HTMLElement | null => within(document.body).queryByRole("dialog", { name: /Mark \d+ as spam/ });

async function markAll(): Promise<void> {
  await click(within(host!).getByRole("button", { name: "List" }));
  const menu = within(document.body).getByRole("menu", { name: "List" });
  await click(within(menu).getByRole("menuitem", { name: "Mark all spam" }));
}

describe("s is this sender, and Mark all spam asks first", () => {
  it("Mark all spam states the number and moves nobody until it is confirmed", async () => {
    const { latest } = await mount([msg("a1", "anna@example.test", 9), msg("b1", "bert@example.test", 10)]);
    const open = async () => {
      await markAll();
      return askNow();
    };
    const exiting = () => ["a1", "b1"].filter((id) => latest().isExiting(id));

    const ask = await open();
    expect(ask?.textContent).toContain("Mark 2 as spam");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await wait(600);
    expect(exiting()).toEqual([]);
    await click([...ask!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
    expect(askNow()).toBeNull();

    await open();
    await press("Escape");
    expect(askNow()).toBeNull();
    await wait(600);
    expect(exiting()).toEqual([]);

    const confirm = await open();
    await click([...confirm!.querySelectorAll("button")].find((b) => b.textContent === "Mark as spam")!);
    await wait(900);
    expect(exiting()).toEqual(["a1", "b1"]);
    await commit(latest);
    expect(decided().sort()).toEqual(["a1", "b1"]);
  });

  it("a sender arriving while the question is open is not in it: the number stays, the confirm moves only those named", async () => {
    const { latest, arrive } = await mount([msg("a1", "anna@example.test", 9), msg("b1", "bert@example.test", 10)]);
    await markAll();
    await arrive([msg("c1", "cleo@example.test", 11)]);
    expect(askNow()?.textContent).toContain("Mark 2 as spam");
    await click([...askNow()!.querySelectorAll("button")].find((b) => b.textContent === "Mark as spam")!);
    await wait(900);
    await commit(latest);
    expect(decided().sort()).toEqual(["a1", "b1"]);
  });
});
