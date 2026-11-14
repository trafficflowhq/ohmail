/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";
import {
  markSessionAlive, registerSessionProbe, resetSessionTruthForTests,
} from "@ohmail/app-logic/session/session-truth";

/**
 * SEARCH OVER A SESSION RENEWAL — History's twin. The store's search pages go out on the engine's
 * transport, which does not renew, so a 401 read "the server did not answer" until somebody pressed
 * Search again. It asks the renewal, keeps searching while that is out, and asks again once it lands.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-23T12:00:00.000Z");
const UNANSWERED = messages.search.scopeUnanswered;

function msg(n: number): EngineMessage {
  return {
    id: `s${n}`, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Invoice ${n}`, from: { name: null, address: "billing@shop.example" }, to: [], cc: [],
    date: "2026-09-01T09:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

async function engineWith(status: () => number | null): Promise<{ engine: OhmailEngine; pages: () => number }> {
  const store = new MemoryMirrorStore();
  await store.load();
  let pages = 0;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (_q: string, o: { parts?: string }) => {
      if (o.parts === "page") pages += 1;
      const s = status();
      if (s !== null) {
        throw new MutationRejectedError(`HTTP ${s}`, { status: s, code: s === 401 ? "unauthorized" : null, retryable: s >= 500 });
      }
      return { items: [msg(1), msg(2)], total: 2, totalExact: true, nextCursor: null, ms: 3 };
    },
  } as unknown as EngineAdapter;
  return { engine: new OhmailEngine({ adapter, store, now: () => NOW }), pages: () => pages };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  resetSessionTruthForTests();
});

async function render(engine: OhmailEngine, query: string): Promise<void> {
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, { children: h(SearchView, { engine, version: 1, now: NOW, query, onQuery: () => {}, onOpen: () => {} }) }),
    }));
  });
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 320)); });
const text = (): string => host.textContent ?? "";
const hits = (): number => host.querySelectorAll(".hit").length;

describe("Search over a session renewal", () => {
  it("a 401 asks the renewal, keeps searching, and asks the store again once it lands", async () => {
    let status: number | null = 401;
    let probes = 0;
    registerSessionProbe(() => { probes += 1; });
    const fx = await engineWith(() => status);
    await render(fx.engine, "invoice");
    await settle();

    expect(text(), "a refused session read as a silent server").not.toContain(UNANSWERED);
    expect(probes).toBe(1);
    const asked = fx.pages();

    status = null;
    await act(async () => { markSessionAlive(); });
    await settle();
    expect(fx.pages(), "no second ask after the renewal").toBeGreaterThan(asked);
    expect(text()).not.toContain(UNANSWERED);
    expect(hits()).toBe(2);
  });

  it("CONTROL — a server fault is said at once and asks no renewal", async () => {
    let probes = 0;
    registerSessionProbe(() => { probes += 1; });
    const fx = await engineWith(() => 503);
    await render(fx.engine, "invoice");
    await settle();
    expect(text()).toContain(UNANSWERED);
    expect(probes).toBe(0);
  });
});
