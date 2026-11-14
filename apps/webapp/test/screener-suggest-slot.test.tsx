/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * WHICH SUGGEST CONTROL THE SCREENER SHOWS, AND WHAT IT IS ALLOWED TO SAY.
 *
 * This view is compiled into a browser tab and into the desktop app, and the two are not asking the
 * same question. A hosted account buys suggestions out of an allowance, so its control names a
 * price before it spends. A standalone install has no account and no allowance — the model belongs
 * to whoever set it up — so a price there is not a different number, it is an invented one. The
 * desktop therefore brings its OWN control and hands it in.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────────────────────
 *
 * Because nothing was watching. Deleting the suggest control from the Screener outright — the whole
 * `suggest` prop, on every host — left the entire webapp suite green. A surface whose disappearance
 * no test notices is a surface that can disappear, and the two claims below are the ones a person
 * would actually miss:
 *
 *  1. THE HOSTED CONTROL STILL NAMES ITS PRICE. It is on screen, and the number on it is the
 *     server's quote — the whole reason that flow has a dry run in the middle of it.
 *  2. THE HANDED-IN CONTROL REPLACES IT, and the price vocabulary goes with it. Never both, because
 *     two controls over one queue is two ways to ask one question with different words on them.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

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
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/**
 * The hosted control, at rest with a price on it.
 *
 * Hand-built rather than driven through the hook, because what is under test here is the VIEW's
 * decision about which control to draw. `screener-suggest.test.tsx` owns the hook's own behaviour.
 */
const cloudControl = {
  available: 3,
  sizes: [3],
  size: 3,
  phase: "ready" as const,
  quote: { senders: 3, credits: 3 },
  notice: null,
  open: () => {},
  choose: () => {},
  confirm: () => {},
  cancel: () => {},
};

async function mount(props: Record<string, unknown>): Promise<HTMLElement> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const engine = await engineWith([
    held("m1", "one@example.test", 9),
    held("m2", "two@example.test", 10),
    held("m3", "three@example.test", 11),
  ]);

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true,
      selection: { waiting: null, screened: null, spam: null },
      onSelect: () => {}, hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
      ...props,
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
  await settleFirstPaint();
  return host;
}

describe("the Screener's suggest control", () => {
  it("is on screen for a hosted account, with the server's own price on it", async () => {
    const el = await mount({ suggest: cloudControl });
    const control = el.querySelector(".scn-suggest");
    expect(control, "the hosted suggest control is not on screen at all").not.toBeNull();
    // The price the server quoted, rendered — not a count multiplied by something held here.
    const price = el.querySelector(".scn-sg-price")?.textContent ?? "";
    expect(price, `the price is not on the control: ${control?.textContent ?? ""}`).toMatch(/3/);
    expect(control!.textContent).toMatch(/credit/i);
  });

  it("shows nothing at all when no host offered one", async () => {
    // The demo, and any surface with no way to ask. Absent means not offered, never offered
    // and inert — which is what this control was on the desktop for the whole of its life.
    const el = await mount({});
    expect(el.querySelector(".scn-suggest")).toBeNull();
  });

  it("shows the host's own control instead, and drops the price vocabulary with it", async () => {
    const el = await mount({
      suggest: cloudControl,
      suggestNode: h("div", { className: "brought-along" }, "Suggest for 3 senders"),
    });
    // NEVER BOTH. The handed-in one replaces the hosted one rather than joining it.
    expect(el.querySelector(".brought-along"), "the host's control did not render").not.toBeNull();
    expect(el.querySelector(".scn-suggest"), "both controls rendered").toBeNull();
    const text = el.textContent ?? "";
    expect(text).toContain("Suggest for 3 senders");
    for (const word of [/credit/i, /\bprice\b/i, /\$/]) {
      expect(text, `the host's control was drawn beside price copy: ${String(word)}`).not.toMatch(word);
    }
  });
});
