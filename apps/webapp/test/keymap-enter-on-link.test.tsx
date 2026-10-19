/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import type { FiledSince } from "@ohmail/client-engine";

/**
 * ↵ ON A FOCUSED LINK FOLLOWS THE LINK. The where-line put the first `<a href>` in the Ohbox
 * header; the keymap listens on `document` and the Ohbox's ↵ skipped only buttons, so ↵ on
 * "12 to News" opened (and marked read) the selected letter, or placed a cursor, and cancelled the
 * link. A bare ↵ on an element the browser activates itself is the browser's.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null,
  asOf: null, address: null, minutes: null, slow: false, screenerCandidate: false,
  pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: QUIET,
    mailboxes: [{
      id: "mb_1", address: "rig@example.invalid", status: "connected", errorCode: null, disabledReason: null,
      syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: new Date(Date.now() - 120_000).toISOString(),
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    factsReadAt: () => Date.now(),
    refresh: () => {},
  }),
}));

const calls: string[] = [];
vi.mock("../app/shell/routing", async (importActual) => ({
  ...(await importActual<typeof import("../app/shell/routing")>()),
  go: (view: string) => { calls.push(`go:${view}`); },
  goScreener: (seg: string) => { calls.push(`screener:${seg}`); },
}));

const FILED: FiledSince = { at: "2026-10-19T08:00:00.000Z", counts: [{ pile: "reads", count: 12 }] };

const row = (id: string, unread: boolean) => ({
  id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: `subj-${id}`, from: { name: id, address: `${id}@ex.example` }, to: [], cc: [],
  date: "2026-10-19T09:00:00.000Z", folder: "INBOX", snippet: `snip-${id}`, unread,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-19T09:00:00.000Z",
});

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(async () => { r.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  calls.length = 0;
});

async function mount(initialSel: string | null): Promise<HTMLElement> {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const { OhboxWhereLine } = await import("../app/shell/OhboxWhereLine.js");
  const { useRowCursorPlacer } = await import("../app/shell/cursor-placer.js");
  const { ToastHost } = await import("@ohmail/ui");
  const rows = [row("n1", true), row("n2", true)];
  const seen = [row("p1", false)];
  const notice = h(OhboxWhereLine, { filed: FILED, demo: false });
  function Shell(): React.ReactElement {
    const [sel, setSel] = React.useState<string | null>(initialSel);
    // The shell's global placer (shell-open-state.ts), over the same rows.
    function Placer(): null {
      useRowCursorPlacer({
        rows: [...rows, ...seen], current: sel, scope: ".view",
        select: (id) => { calls.push(`placed:${id}`); setSel(id); },
      }, "global");
      return null;
    }
    return h(React.Fragment, null, h(Placer), h(OhboxView as never, {
      owed: false, demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      resurfacedRows: [], newForYou: rows, previouslySeen: seen,
      replyDone: null, tags: [], now: new Date("2026-10-19T10:00:00.000Z"), selectedId: sel,
      onSelect: (id: string) => { calls.push(`select:${id}`); setSel(id); },
      onEnterReader: (id: string) => { calls.push(`reader:${id}`); },
      readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: (ids: string[]) => { calls.push(`seen:${ids.join(",")}`); return true; },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      onMarkAllRead: () => {}, noticeSection: notice,
    } as never));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: h(ToastHost as never, { children: h(KeymapProvider as never, { children: h(Shell) } as never) } as never),
    } as never));
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  return host;
}

/** A keydown at `el` (focused when it can be), bubbling to the keymap's document listener. */
async function enterOn(el: HTMLElement): Promise<boolean> {
  el.focus();
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => { el.dispatchEvent(ev); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
  return ev.defaultPrevented;
}

const newsLink = (host: HTMLElement): HTMLAnchorElement =>
  [...host.querySelectorAll<HTMLAnchorElement>(".ohbox-where a")].find((a) => a.textContent === "12 to News")!;

describe("↵ on a focused where-line link", () => {
  it("with a letter selected: the link keeps its activation and no letter opens or is read", async () => {
    const host = await mount("n1");
    const a = newsLink(host);
    expect(a).toBeTruthy();
    expect(await enterOn(a)).toBe(false);
    expect(calls).toEqual([]);
    // The browser's activation of the link is its click.
    await act(async () => { a.click(); });
    expect(calls).toEqual(["go:reads"]);
  });

  it("with no cursor: no cursor is placed, twice over", async () => {
    const host = await mount(null);
    expect(await enterOn(newsLink(host))).toBe(false);
    expect(await enterOn(newsLink(host))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("control: ↵ off the link still opens the selected letter", async () => {
    await mount("n1");
    expect(await enterOn(document.body)).toBe(true);
    expect(calls).toContain("seen:n1");
    expect(calls).toContain("reader:n1");
  });

  it("control: ↵ off the link with no cursor still places one", async () => {
    await mount(null);
    expect(await enterOn(document.body)).toBe(true);
    expect(calls).toEqual(["placed:n1"]);
  });
});
