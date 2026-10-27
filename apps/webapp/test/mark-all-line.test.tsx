/** @vitest-environment jsdom */
/**
 * READ STATE IN THE READING STREAMS — one source, rendered truthfully, clearable.
 *
 * Measured on a live warm account (2026-08-12): every Reads row rendered at unread weight
 * whatever its real `\Seen` state, and pressing "Mark all read" made the BUTTON disappear
 * while the rows stayed bold — the button keyed on `m.unread`, the rows keyed on nothing.
 * Three statements have to hold together, all derived from the same field the IMAP flag
 * feeds (`EngineMessage.unread`):
 *
 *  1. FIRST PAINT IS TRUTHFUL. A message `\Seen` before this client ever ran renders READ
 *     (quiet ink, no `data-unseen`). Before the first visit every unread letter is "new since
 *     you were here" and no read one is (`feedPartition` `newCount`). No line is drawn before
 *     a visit commits one.
 *  2. THE BUTTON AND THE ROWS CANNOT DISAGREE. The control is present exactly while the view
 *     shows something to clear — an unread row, or a fresh count — and pressing it flips the
 *     unread ids AND commits the line to the top, so afterwards nothing renders unread,
 *     nothing counts as new, and the button's absence is a statement about the mail.
 *  3. Mail read in ANOTHER client (fresh side of the line, zero unread) still gets a control
 *     that zeroes the count — the state the old unread-only visibility left uncloseable.
 *
 * The mirror here is a real `MemoryMirrorStore` and the partitions are the real
 * `feedPartition`, so these guards break if the views and the selector ever stop reading
 * the same source.
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

/** The mirror after this device's first completed sync at `iso` (the engine's drain records it). */
async function importedAt(rows: EngineMessage[], iso: string): Promise<MemoryMirrorStore> {
  const store = await mirrorOf(rows);
  await store.putLocal("view_meta", FEED_SINCE_ID, { at: iso });
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
    newCount: partition.newCount, // as the shell passes it (`AppShell`)
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

const button = (): HTMLButtonElement | null =>
  host!.querySelector<HTMLButtonElement>("button.mark-all-read");
const metaText = (): string => host!.querySelector(".vhead .meta")?.textContent ?? "";
const rowOf = (id: string): HTMLElement | null =>
  host!.querySelector<HTMLElement>(`.list-col .row[data-id="${id}"]`);

async function press(): Promise<void> {
  await act(async () => { button()!.click(); });
}

beforeEach(() => {
  markedAll = [];
  commits = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;
});

afterEach(async () => {
  await unmount();
});

/** A reported warm import: read and unread interleaved, no waterline row yet. */
const WARM: EngineMessage[] = [
  msg({ id: "new1", date: d(0), unread: true, folder: "ohmail/News" }),
  msg({ id: "read1", date: d(1), unread: false, folder: "ohmail/News" }),
  msg({ id: "skip1", date: d(2), unread: true, folder: "ohmail/News" }),
  msg({ id: "read2", date: d(3), unread: false, folder: "ohmail/News" }),
];

describe("first paint over a warm import is truthful (Reads)", () => {
  it("an already-\\Seen message renders READ — quiet ink, no data-unseen — and is not counted new", async () => {
    const part = feedPartition(await importedAt(WARM, d(-1)), "reads");
    await mountReads(part);
    // The whole pile predates this device's first sync, and no visit has been made: its two
    // unread letters are new. It read "Nothing new" over them.
    expect(metaText()).toBe("2 new since you were here");
    // Pre-import \Seen mail LOOKS read. Stop passing `seen` from `m.unread` (or re-suppress it
    // under `dotless`) and these are red — the full-weight row is what read "all unread" live.
    expect(rowOf("read1")!.classList.contains("seen")).toBe(true);
    expect(rowOf("read2")!.classList.contains("seen")).toBe(true);
    expect(rowOf("read1")!.hasAttribute("data-unseen")).toBe(false);
    // A genuinely unread row still reads unread and still feeds the \Seen sweep.
    expect(rowOf("new1")!.classList.contains("seen")).toBe(false);
    expect(rowOf("new1")!.hasAttribute("data-unseen")).toBe(true);
    expect(rowOf("skip1")!.hasAttribute("data-unseen")).toBe(true);
    // Still the reading pile: no dots anywhere.
    expect(host!.querySelectorAll(".dot-unread")).toHaveLength(0);
  });

  it("no visit yet: unread mail counts on either side of the first sync, and no line is drawn", async () => {
    const part = feedPartition(await importedAt(WARM, d(1)), "reads");
    await mountReads(part);
    expect(metaText()).toBe("2 new since you were here");
    const blocks = [...host!.querySelectorAll(".list-col .rows")].map((b) =>
      [...b.querySelectorAll(".row[data-id]")].map((r) => r.getAttribute("data-id")),
    );
    expect(blocks[0]).toEqual(["new1", "read1", "skip1", "read2"]);
    expect(blocks[1]).toEqual([]);
    expect(host!.querySelectorAll(".list-col .waterline")).toHaveLength(0);
  });
});

describe("Mark all read clears WHAT THE VIEW SHOWS, not just its own button", () => {
  it("the press flips the unread ids AND commits the line to the top", async () => {
    const part = feedPartition(await importedAt(WARM, d(-1)), "reads");
    await mountReads(part);
    await press();
    // The \Seen flips ride the chunked mark_seen path (real server state, real IMAP)…
    expect(markedAll).toEqual([["new1", "skip1"]]);
    // …and the line commits to the newest message through the SAME writer the leave-commit
    // uses, so "new since last visit" zeroes with it. Drop the commit and this is red — the
    // live symptom was exactly a press that hid the button while the count stood.
    expect(commits).toEqual([{ upToId: "new1", messageIds: [] }]);
  });

  it("after the flips land, nothing renders unread and the button's absence is true", async () => {
    // The engine flips the mirror optimistically; this harness applies the same flips to the
    // same store and re-renders — the loop the shell closes live. One source, three answers:
    // rows quiet, count zero, button gone.
    const store = await mirrorOf(WARM);
    await mountReads(feedPartition(store, "reads"));
    await press();
    await store.applyChanges(
      WARM.filter((m) => m.unread).map((m) => ({
        type: "message",
        op: "update",
        id: m.id,
        seq: ++seq,
        updatedAt: d(0),
        entity: { ...m, unread: false },
      })) as SyncChange[],
    );
    await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "new1", at: d(0) });
    await mountReads(feedPartition(store, "reads"));
    expect(metaText()).toBe("Nothing new since you were here");
    expect(host!.querySelectorAll(".row[data-unseen]")).toHaveLength(0);
    expect([...host!.querySelectorAll(".list-col .row[data-id]")].every((r) => r.classList.contains("seen"))).toBe(true);
    expect(button()).toBeNull();
  });

  it("mail read in ANOTHER client: zero unread, a stale line — the headline says nothing is new, the control still clears the line", async () => {
    // r0/r1 went \Seen via the user's phone; the line (local-only) still sits at r2.
    //
    // THIS CASE'S HEADLINE EXPECTATION FLIPPED, deliberately (owner ruling on the
    // cross-surface report, 2026-08-31 — `FeedPartition.newCount` holds the argument). It used
    // to assert "2 new" here, which is this exact state as the account's owner met it on a
    // second device: a rail demanding attention for mail the mail server said was read. The
    // headline and the rail now speak the badge — fresh AND still unread, zero here — so two
    // devices agree the moment the mailbox does. What did NOT flip: the line itself is
    // positional truth (those two rows genuinely arrived since this device's last visit), so
    // the divider still stands, the control still renders FOR it, its label still names the
    // rows the press moves past, and the press still commits only the line — no PATCH, because
    // nothing is unread. `cross-surface-convergence.test.tsx` guards the headline's half from
    // the other side (a mutation restoring the positional headline goes red there).
    const pile = [
      msg({ id: "r0", date: d(0), unread: false, folder: "ohmail/News" }),
      msg({ id: "r1", date: d(1), unread: false, folder: "ohmail/News" }),
      msg({ id: "r2", date: d(2), unread: false, folder: "ohmail/News" }),
    ];
    const store = await mirrorOf(pile);
    await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "r2", at: d(2) });
    await mountReads(feedPartition(store, "reads"));
    expect(metaText()).toBe("Nothing new since you were here");
    expect(button()).not.toBeNull();
    expect(button()!.getAttribute("aria-label"))
      .toBe("Mark all 2 messages new since you were here as read");
    await press();
    expect(markedAll).toEqual([]); // nothing was unread; there is nothing to PATCH
    expect(commits).toEqual([{ upToId: "r0", messageIds: [] }]);
  });
});

describe("Receipts — the same contract through its own props", () => {
  it("read receipts render read; the press flips the unread ids and commits ITS line", async () => {
    const pile = [
      msg({ id: "t0", date: d(0), unread: true, folder: "ohmail/Receipts" }),
      msg({ id: "t1", date: d(1), unread: false, folder: "ohmail/Receipts" }),
      msg({ id: "t2", date: d(2), unread: true, folder: "ohmail/Receipts" }),
    ];
    const part = feedPartition(await importedAt(pile, d(1)), "receipts");
    await mountReceipts(part);
    expect(metaText()).toBe("2 new since you were here");
    expect(rowOf("t1")!.classList.contains("seen")).toBe(true);
    expect(rowOf("t1")!.hasAttribute("data-unseen")).toBe(false);
    expect(rowOf("t0")!.hasAttribute("data-unseen")).toBe(true);
    await press();
    expect(markedAll).toEqual([["t0", "t2"]]);
    expect(commits).toEqual([{ upToId: "t0", messageIds: [] }]);
  });

  it("fresh-only receipts still get the control", async () => {
    const pile = [
      msg({ id: "t0", date: d(0), unread: false, folder: "ohmail/Receipts" }),
      msg({ id: "t1", date: d(1), unread: false, folder: "ohmail/Receipts" }),
    ];
    const store = await mirrorOf(pile);
    await store.putLocal("view_meta", waterlineIdOf("receipts"), { newestSeenId: "t1", at: d(1) });
    await mountReceipts(feedPartition(store, "receipts"));
    // The headline is the badge, as the shell passes it: t0 is above the line but read, so
    // nothing is new — the Reads twin above holds the same ruling. The control still clears the line.
    expect(metaText()).toBe("Nothing new since you were here");
    expect(button()).not.toBeNull();
    await press();
    expect(markedAll).toEqual([]);
    expect(commits).toEqual([{ upToId: "t0", messageIds: [] }]);
  });
});
