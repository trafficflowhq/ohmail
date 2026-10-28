/** @vitest-environment jsdom */
/**
 * A READ LETTER MOVED INTO NEWS OR RECEIPTS, IN THE BROWSER. With no line yet on
 * this browser, filing a read letter on top of a pile read "Nothing new since you were here" over
 * letters the server still held unseen. The views and the partition are the real ones over a real
 * `MemoryMirrorStore`; the move is the sync update the mirror receives for it. Receipts is mounted
 * with the props the shell passes (`AppShell`: `freshCount` from the position, `newCount` the badge).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  feedPartition,
  waterlineIdOf,
  FEED_SINCE_ID,
  type EngineMessage,
  type FeedPartition,
  type Folder,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
  escape: (s: string) => s.replace(/["\\]/g, (c) => `\\${c}`),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockIO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/* ── the warm mirror ───────────────────────────────────────────────────────────────────── */

let seq = 0;

function msg(o: { id: string; date: string; unread: boolean; folder: Folder }): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: o.id, address: `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date,
    folder: o.folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date,
  };
}

async function mirrorOf(rows: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    rows.map((m) => ({
      type: "message",
      op: "create",
      id: m.id,
      seq: ++seq,
      updatedAt: m.updatedAt,
      entity: m,
    })) as SyncChange[],
  );
  return store;
}

/** Newest-first: d(0) is the newest. */
const d = (i: number): string => `2026-08-${String(10 - i).padStart(2, "0")}${"T"}09:00:00.000Z`;
const NOW = new Date("2026-08-10T12:00:00.000Z");

/* ── mounting ──────────────────────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let markedAll: string[][] = [];
let commits: Array<{ upToId: string; messageIds: string[] }> = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mount(node: React.ReactNode, KeymapProvider: unknown): Promise<void> {
  await unmount();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: NOW,
        children: h(KeymapProvider as never, { children: node } as never),
      }),
    );
  });
}

async function mountReads(partition: FeedPartition): Promise<void> {
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const node = h(ReadsView as never, {
    settled: true, owed: false,
    partition,
    tags: [], now: NOW, cur: null, onCur: () => {},
    aiChip: null, chipState: null, onChipState: () => {},
    markSeen: () => {},
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    hydrateBody: () => {},
    jumpTo: null, onJumped: () => {},
    onMarkAllRead: (ids: string[]) => { markedAll.push(ids); },
  } as never);
  await mount(node, KeymapProvider);
}

async function mountReceipts(partition: FeedPartition): Promise<void> {
  const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const all = [...partition.fresh, ...partition.seen];
  const node = h(ReceiptsView as never, {
    settled: true, owed: false,
    messages: all,
    waterline: partition.waterline,
    freshCount: partition.fresh.length,
    newCount: partition.newCount,
    tags: [], now: NOW, cur: null, onCur: () => {},
    unreadCount: all.filter((m) => m.unread).length,
    isUnread: (m: { unread: boolean }) => m.unread,
    markSeen: () => {},
    onLeaveSeen: (c: { upToId: string; messageIds: string[] }) => { commits.push(c); },
    bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    hydrateBody: () => {},
    jumpTo: null, onJumped: () => {},
    onMarkAllRead: (ids: string[]) => { markedAll.push(ids); },
  } as never);
  await mount(node, KeymapProvider);
}

const metaText = (): string => host!.querySelector(".vhead .meta")?.textContent ?? "";
const lines = (): number => host!.querySelectorAll(".list-col .waterline").length;

async function moveInto(store: MemoryMirrorStore, id: string, folder: Folder): Promise<void> {
  const m = store.get<EngineMessage>("message", id)!;
  await store.applyChanges([{
    type: "message", op: "update", id, seq: ++seq, updatedAt: m.updatedAt, entity: { ...m, folder },
  }] as SyncChange[]);
}

async function firstSync(store: MemoryMirrorStore, iso: string): Promise<void> {
  await store.putLocal("view_meta", FEED_SINCE_ID, { at: iso });
}

const at = (hh: number, mm = 0): string =>
  `2026-08-10T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`;

beforeEach(() => {
  markedAll = [];
  commits = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;
});

afterEach(async () => {
  await unmount();
});

describe("no visit yet in this browser: a read letter filed on top", () => {
  it("News still says 2 new, and draws no line", async () => {
    const store = await mirrorOf([
      msg({ id: "n1", date: at(11, 35), unread: true, folder: "ohmail/News" }),
      msg({ id: "n2", date: at(11, 36), unread: true, folder: "ohmail/News" }),
      msg({ id: "w14", date: at(11, 43), unread: false, folder: "INBOX" }),
    ]);
    await firstSync(store, at(11));
    await mountReads(feedPartition(store, "reads"));
    expect(metaText()).toBe("2 new since you were here");
    await moveInto(store, "w14", "ohmail/News");
    await mountReads(feedPartition(store, "reads"));
    expect(metaText()).toBe("2 new since you were here");
    expect(lines()).toBe(0);
  });

  it("Receipts still says 5 new, and draws no line", async () => {
    const store = await mirrorOf([
      ...[1, 2, 3, 4, 5].map((i) => msg({ id: `rc${i}`, date: at(9, i), unread: true, folder: "ohmail/Receipts" })),
      msg({ id: "w07", date: at(11, 30), unread: false, folder: "Sent" as Folder }),
    ]);
    await firstSync(store, at(9));
    await moveInto(store, "w07", "ohmail/Receipts");
    await mountReceipts(feedPartition(store, "receipts"));
    expect(metaText()).toBe("5 new since you were here");
    expect(lines()).toBe(0);
  });

  it("control: truly nothing new — an all-read pile says so, and offers nothing to clear", async () => {
    const store = await mirrorOf([
      msg({ id: "r1", date: at(10), unread: false, folder: "ohmail/News" }),
      msg({ id: "r2", date: at(9), unread: false, folder: "ohmail/News" }),
    ]);
    await mountReads(feedPartition(store, "reads"));
    expect(metaText()).toBe("Nothing new since you were here");
    expect(host!.querySelector("button.mark-all-read")).toBeNull();
    await mountReceipts(feedPartition(await mirrorOf([
      msg({ id: "t1", date: at(10), unread: false, folder: "ohmail/Receipts" }),
    ]), "receipts"));
    expect(metaText()).toBe("Nothing new since you were here");
    expect(host!.querySelector("button.mark-all-read")).toBeNull();
  });

  it("an imported pile of old unread mail names it on the first visit, and draws no line", async () => {
    const store = await mirrorOf(Array.from({ length: 30 }, (_, i) =>
      msg({ id: `old${i}`, date: at(1, i), unread: true, folder: "ohmail/News" })));
    await firstSync(store, at(9));
    await mountReads(feedPartition(store, "reads"));
    expect(metaText()).toBe("30 new since you were here");
    expect(lines()).toBe(0);
  });

  it("control: a real visit draws the line, and nothing is new", async () => {
    const store = await mirrorOf([
      msg({ id: "n1", date: at(11, 35), unread: false, folder: "ohmail/News" }),
      msg({ id: "w14", date: at(11, 43), unread: false, folder: "ohmail/News" }),
    ]);
    await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "w14", at: at(11, 50) });
    await mountReads(feedPartition(store, "reads"));
    expect(metaText()).toBe("Nothing new since you were here");
    expect(lines()).toBe(1);
  });
});
