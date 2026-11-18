/** @vitest-environment jsdom */
import type { EngineMessage, ScreenerSuggestionEntity } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A REFUSED ACT IS TOLD TO THE PERSON. The act on suggestions tried to file a sender
 * and was refused; the refusal rides the mirror's suggestion entity, and the row says one
 * sentence naming the row's own Accept, which still files the sender. The Screener over the real
 * state hook and a real mirror — no overlay, so the mirror is the only source of the fact.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
const REFUSED = "offers@spam-shop.example";
const PLAIN = "deals@other-shop.example";
let seq = 0;

function held(id: string, from: string, hour: number): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}
function suggestion(id: string, messageId: string, sender: string, refused: boolean): ScreenerSuggestionEntity {
  return {
    id, messageId, senderKey: sender, decision: "no", destination: "ohmail/Quarantine", spam: true,
    confidence: 0.95, boughtAt: "2026-08-02T10:00:00.000Z", updatedAt: "2026-08-02T11:00:00.000Z",
    actRefusal: refused ? "store_fault" : null, actRefusedAt: refused ? "2026-08-02T11:00:00.000Z" : null,
  };
}

async function engineWith(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const rows: SyncChange[] = [
    ...[held("m0", REFUSED, 9), held("m1", PLAIN, 10)].map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    { type: "screener_suggestion", op: "create", id: "sg-0", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: suggestion("sg-0", "m0", REFUSED, true) } as SyncChange,
    { type: "screener_suggestion", op: "create", id: "sg-1", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: suggestion("sg-1", "m1", PLAIN, false) } as SyncChange,
  ];
  await store.applyChanges(rows);
  return new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
};

async function mount(locale: "en" | "de" = "en"): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const engine = await engineWith();
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : en, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
    }));
  });
  await flush();
  await settleFirstPaint();
}
async function open(address: string): Promise<void> {
  const row = [...host!.querySelectorAll<HTMLElement>(".rows .row")].find((r) => (r.textContent ?? "").includes(address));
  if (!row) throw new Error(`no row for ${address}`);
  await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

describe("a refused act on the Screener row", () => {
  it("says ohmail tried and could not, and names the row's own Accept", async () => {
    await mount();
    await open(REFUSED);
    const said = host!.querySelector("[data-act-refused]");
    expect(said?.textContent).toBe("ohmail tried to file this sender for you and could not. Accept files it now.");
    expect(en.screener.rowAccept, "the sentence names a button the row does not carry").toBe("Accept");
  });

  it("CONTROL: a suggestion the act never tried says nothing of the kind", async () => {
    await mount();
    await open(PLAIN);
    expect(host!.querySelector("[data-act-refused]")).toBeNull();
  });

  it("says it in German with the German button's name", async () => {
    await mount("de");
    await open(REFUSED);
    expect(host!.querySelector("[data-act-refused]")?.textContent)
      .toBe(`ohmail wollte diesen Absender für dich ablegen und konnte es nicht. ${de.screener.rowAccept} legt ihn jetzt ab.`);
  });
});
