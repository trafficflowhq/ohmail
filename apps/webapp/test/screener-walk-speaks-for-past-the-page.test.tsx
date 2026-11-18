/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  consentPartition, presentationReader, screenerSegments, type OhmailEngine,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { createEngine } from "../app/shell/engine-config.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A SENDER THE STORE DOES NOT LIST LEAVES THE SCREENER ONCE THE QUEUE'S PAGES HAVE PASSED THEM.
 *
 * The first page speaks only for senders newer than its last row, so an unlisted sender whose
 * held mail is older stays a waiting row: they may be on a later page. Reading those pages is the
 * store's answer about them, and the row stayed after it. Now the pages read so far speak for
 * every sender newer than their last row, and the whole queue once they reach its end; the
 * sender's mail presents in the Ohbox, as it does for a sender the first page speaks for.
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

function held(id: string, from: string, date: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date, folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as EngineMessage;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Page one lists `a`; the next page lists `far` and ends the queue. `c`, held older than both, is on neither. */
const FIRST = { messageId: "m0", sender: { address: "a@one.test", name: null }, receivedAt: AT, subject: "Subject m0", snippet: "s", mailboxId: "mb" };
const ONWARD = { messageId: "far", sender: { address: "far@away.test", name: "Far" }, receivedAt: "2026-07-01T08:00:00.000Z", subject: "Old", snippet: "o", mailboxId: "mb" };
let onwardCursor: string | null = null;
let onward: object[] = [ONWARD];
/** Mirror rows beyond the two every case holds. */
let extra: EngineMessage[] = [];

const originalFetch = globalThis.fetch;
beforeEach(() => {
  localStorage.clear();
  onwardCursor = null;
  onward = [ONWARD];
  extra = [];
  globalThis.fetch = ((url: string) => {
    if (url.startsWith("/api/sync/snapshot")) {
      return Promise.resolve(json(200, {
        asOfSeq: 1, nextCursor: null, window: { days: 0, minRows: 0 },
        changes: [held("m0", "a@one.test", AT), held("mc", "c@old.test", "2026-06-01T08:00:00.000Z"), ...extra].map((m) => ({
          type: "message", op: "create", id: m.id, seq: 1, updatedAt: m.updatedAt, entity: m,
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
        return Promise.resolve(json(200, { items: onward, nextCursor: onwardCursor, pendingDecisions: [] }));
      }
      return Promise.resolve(json(200, { items: [FIRST], nextCursor: "n", total: 2, pendingDecisions: [] }));
    }
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const state: { current: import("@ohmail/app-logic/screener/screener-state").ScreenerState | null } = { current: null };
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

/** The shell's own composition: the queue from the partition's presentation, as `AppShell` builds it. */
const presented = (engine: OhmailEngine) => presentationReader(engine.read(), consentPartition(engine.read(), { now: NOW }));

async function mount(engine: OhmailEngine): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const view = React.useMemo(() => presented(engine), [v]);
    const s = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), undefined, view);
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

const waitingAddresses = (): string[] => state.current!.waiting.map((x) => x.from.address);

describe("an unlisted sender older than the first page", () => {
  it("stays while no page has passed them, and leaves once the pages reach the queue's end", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    expect(waitingAddresses(), "the first page cannot speak for c yet").toContain("c@old.test");
    expect(presented(engine).get<EngineMessage>("message", "mc")?.folder).toBe("ohmail/Screener");

    await act(async () => { state.current!.waitingMore.load(); });
    await flush();
    expect(waitingAddresses()).toContain("far@away.test");
    expect(waitingAddresses(), "the pages ended the queue without c, and c is still a waiting row").not.toContain("c@old.test");
    expect(presented(engine).get<EngineMessage>("message", "mc")?.folder, "c's mail is in no pile").toBe("INBOX");
  });

  it("a page that has not reached them yet leaves them waiting", async () => {
    onwardCursor = "more";
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    await act(async () => { state.current!.waitingMore.load(); });
    await flush();
    // The next page's last row is newer than c's mail, and the queue goes on past it.
    expect(waitingAddresses()).toContain("c@old.test");
    expect(presented(engine).get<EngineMessage>("message", "mc")?.folder).toBe("ohmail/Screener");
  });

  it("a page that has passed them speaks for them while the queue goes on", async () => {
    onwardCursor = "more";
    // The next page's last row is older than c's mail, and it lists d, whose mail the mirror holds.
    onward = [{ messageId: "md", sender: { address: "d@mid.test", name: null }, receivedAt: "2026-07-01T08:00:00.000Z", subject: "Subject md", snippet: "d", mailboxId: "mb" },
      { ...ONWARD, receivedAt: "2026-05-01T08:00:00.000Z" }];
    extra = [held("md", "d@mid.test", "2026-07-01T08:00:00.000Z")];
    const engine = createEngine(false, ARMED);
    await engine.start();
    await mount(engine);
    await act(async () => { state.current!.waitingMore.load(); });
    await flush();
    expect(waitingAddresses(), "a page past c's mail did not list c, and c is still a waiting row").not.toContain("c@old.test");
    expect(presented(engine).get<EngineMessage>("message", "mc")?.folder).toBe("INBOX");
    // A sender a later page listed keeps their row where the segments place it.
    expect(screenerSegments(presented(engine), NOW).waiting.map((x) => x.from.address)).toContain("d@mid.test");
    expect(waitingAddresses().filter((a) => a === "d@mid.test")).toHaveLength(1);
  });
});
