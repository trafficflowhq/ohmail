/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { createEngine } from "../app/shell/engine-config.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A DECISION ON A SENDER FROM A LATER PAGE TAKES THEM OFF THE COUNT AT THE PRESS, AND KEEPS THEM
 * OFF UNTIL THE STORE'S NEXT ANSWER. The mirror never holds such a sender, so nothing the engine
 * paints hides them; the row came back, and the count with it, from the moment the decision was
 * sent until the queue was read again after the server's answer.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const NOW = new Date("2026-09-28T09:00:00.000Z");
const AT = "2026-09-28T08:00:00.000Z";

function held(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: AT, folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: AT,
  } as EngineMessage;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let decided = false;
let refuseDecide = false;
let answerDecide: (() => void) | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // A decision journalled by an earlier case is replayed at the next mount.
  localStorage.clear();
  decided = false;
  refuseDecide = false;
  answerDecide = null;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/sync/snapshot")) {
      return Promise.resolve(json(200, {
        asOfSeq: 1, nextCursor: null, window: { days: 0, minRows: 0 },
        changes: [held("m0", "a@one.test"), held("m1", "b@one.test")].map((m) => ({
          type: "message", op: "create", id: m.id, seq: 1, updatedAt: AT, entity: m,
        })),
      }));
    }
    if (url.startsWith("/api/sync?")) {
      return Promise.resolve(json(200, {
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: AT,
      }));
    }
    if (url.startsWith("/api/screener?")) {
      if (url.includes("cursor=n")) {
        return Promise.resolve(json(200, {
          items: [{ messageId: "far", sender: { address: "far@away.test", name: "Far" }, receivedAt: "2026-01-01T08:00:00.000Z",
            subject: "An old note", snippet: "old", mailboxId: "mb" }],
          nextCursor: null, pendingDecisions: [],
        }));
      }
      return Promise.resolve(json(200, {
        items: [held("m0", "a@one.test"), held("m1", "b@one.test")].map((m) => ({
          messageId: m.id, sender: { address: m.from.address, name: null }, receivedAt: AT, subject: m.subject,
          snippet: m.snippet, mailboxId: "mb",
        })),
        nextCursor: "n", total: decided ? 249 : 250, pendingDecisions: [],
      }));
    }
    if (method === "POST" && url === "/api/screener/far") {
      return new Promise<Response>((ok) => {
        answerDecide = () => {
          if (refuseDecide) { ok(json(409, { error: { code: "conflict", message: "not decided" } })); return; }
          decided = true;
          ok(json(200, { messageId: "far", appliedFolder: "INBOX", createdRuleId: null }));
        };
      });
    }
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let state: { current: import("@ohmail/app-logic/screener/screener-state").ScreenerState | null } = { current: null };
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
});
async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(engine: OhmailEngine): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  state = { current: null };
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const s = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    state.current = s;
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state: s, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (seg: string, id: string | null) => setSel((m) => ({ ...m, [seg]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
    }));
  });
  await flush();
  await settleFirstPaint();
  await flush();
}

const text = (): string => host!.textContent ?? "";

describe("a decision on a sender from a later page", () => {
  it("lowers the count at the press and keeps it lowered until the store's next answer", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    expect(text()).toContain("250 first-time senders waiting");

    await act(async () => { state.current!.waitingMore.load(); });
    await flush();
    const far = state.current!.waiting.find((x) => x.from.address === "far@away.test");
    expect(far, "the next page's sender is not in the queue").toBeDefined();

    await act(async () => { state.current!.decide(far!, "ohbox", { read: false, scope: "sender" }); });
    await flush();
    expect(text(), "the press did not lower the count").toContain("249 first-time senders waiting");

    // The undo window closes: the decision is sent, and the server has not answered yet.
    await act(async () => { state.current!.flush(); });
    await flush();
    expect(answerDecide, "the decision never reached the door").not.toBeNull();
    expect(text(), "the count came back while the decision was on its way").toContain("249 first-time senders waiting");
    expect(state.current!.waiting.some((x) => x.from.address === "far@away.test"),
      "the decided sender is back in the queue").toBe(false);

    // A first page read while the decision is on its way still counts the sender, and the walk
    // past it starts over: the count stays where the press put it.
    await act(async () => { state.current!.rereadWaiting(); });
    await flush();
    expect(text(), "a re-read during the decision brought the count back").toContain("249 first-time senders waiting");

    await act(async () => { answerDecide!(); });
    await flush();
    expect(text()).toContain("249 first-time senders waiting");
    expect(state.current!.waiting.some((x) => x.from.address === "far@away.test")).toBe(false);
  });

  it("a decision the server refuses puts the sender and the count back", async () => {
    refuseDecide = true;
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    await act(async () => { state.current!.waitingMore.load(); });
    await flush();
    const far = state.current!.waiting.find((x) => x.from.address === "far@away.test")!;
    await act(async () => { state.current!.decide(far, "ohbox", { read: false, scope: "sender" }); });
    await act(async () => { state.current!.flush(); });
    await flush();
    await act(async () => { answerDecide!(); });
    await flush();
    expect(text()).toContain("250 first-time senders waiting");
    expect(state.current!.waiting.some((x) => x.from.address === "far@away.test"),
      "the refused sender did not come back").toBe(true);
  });
});
