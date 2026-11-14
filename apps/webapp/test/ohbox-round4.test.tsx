/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { pinnedRows } from "./_resurfaced-rows.js";
import type { EngineMessage } from "@ohmail/client-engine";

/**
 * ROUND-4 OHBOX: session placement, the resurfaced pin, Sent-in-Earlier, the mark-all control on
 * the meta row, and the settled reply.
 *
 * SESSION PLACEMENT IS ABOUT ORDER, NOT ABOUT HOLDING READ MAIL UP. The view keeps a session order
 * on top of the selector's truth so rows do not re-sort under the reader, and a live arrival merges
 * in at the slot the selector's date order gives it — the top, for genuinely new mail (pinned in
 * `ohbox-arrival-order.test.tsx`). It used to do a second thing as well — hold a row read this session in "New for
 * you" until a reload — and that is gone: a read row slides down to "Earlier" at once. These drive
 * the view with the exact prop change the shell makes on a read (the row moves from `newForYou` to
 * `previouslySeen`) and assert both halves of the move: the slot is held for the length of the
 * slide, and then it is not.
 *
 * The slide's own guards — the grouped case, the precedence over mark-unread, the reader's
 * viewport, and a `\Seen` adopted from another mail client — are in `ohbox-read-slide.test.tsx`.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Desktop split width, so the reading column exists and the mobile-only paths stay out of the way.
function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; folder?: string; triage?: unknown }
function msg(m: Row): EngineMessage {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: m.id, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z", folder: m.folder ?? "INBOX", snippet: "s", unread: m.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: m.triage ?? null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const marked: Array<{ ids: string[]; unread: boolean }> = [];

interface Props { resurfaced?: Row[]; newForYou: Row[]; previouslySeen: Row[]; replyDone?: { messageId: string; at: string } | null }

async function render(props: Props): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      resurfacedRows: pinnedRows((props.resurfaced ?? []).map(msg)),
      newForYou: props.newForYou.map(msg),
      previouslySeen: props.previouslySeen.map(msg),
      replyDone: props.replyDone ?? null,
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: null, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: (ids: string[], unread: boolean) => { marked.push({ ids, unread }); },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      onMarkAllRead: (ids: string[]) => marked.push({ ids, unread: false }),
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

/** The data-ids of the rows in the group with this aria-label ("New", "Earlier", "Resurfaced"). */
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".row[data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null; marked.length = 0;
});

describe("Ohbox round 4", () => {
  it("a row read this session slides out of New and re-files under Earlier", async () => {
    vi.useFakeTimers();
    try {
      setViewport();
      await render({ newForYou: [{ id: "a", unread: true }, { id: "b", unread: true }], previouslySeen: [] });
      expect(idsInGroup("New")).toEqual(["a", "b"]);

      // The shell's re-partition on a read: `a` moves out of newForYou into previouslySeen, read.
      await render({ newForYou: [{ id: "b", unread: true }], previouslySeen: [{ id: "a", unread: false }] });
      // It MOVES rather than jumping: the slot is held for the length of the slide, wearing the
      // class `row.css` transitions, and "Earlier" does not have the row yet.
      expect(idsInGroup("New")).toEqual(["a", "b"]);
      expect(idsInGroup("Earlier")).not.toContain("a");
      expect(host!.querySelector('.row[data-id="a"]')!.classList.contains("settling")).toBe(true);

      // …and when the slide ends the selector's own answer stands.
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(idsInGroup("New")).toEqual(["b"]);
      expect(idsInGroup("Earlier")).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resurfaced rows render in their own group above New", async () => {
    setViewport();
    await render({
      resurfaced: [{ id: "r", unread: true }],
      newForYou: [{ id: "n", unread: true }],
      previouslySeen: [],
    });
    expect(idsInGroup("Resurfaced")).toEqual(["r"]);
    expect(idsInGroup("New")).toEqual(["n"]);
    // The Resurfaced label precedes the New label in the document.
    const labels = [...host!.querySelectorAll(".grouplabel")].map((l) => l.textContent);
    expect(labels.indexOf("Resurfaced")).toBeLessThan(labels.indexOf("New"));
  });

  it("mark-all-read sits in the header meta row, not on a line of its own", async () => {
    setViewport();
    await render({ newForYou: [{ id: "a", unread: true }], previouslySeen: [] });
    // The control lives inside `.vhead` (the title/meta row), via the ListPane action slot.
    expect(host!.querySelector(".vhead .mark-all-read")).not.toBeNull();
  });

  it("a settled reply marks its parent read, and the read is what moves the row", async () => {
    vi.useFakeTimers();
    try {
      setViewport();
      // A filler keeps the pane non-empty (its empty state needs a provider this harness omits).
      await render({ newForYou: [{ id: "p", unread: true }, { id: "keep", unread: true }], previouslySeen: [] });
      expect(idsInGroup("New")).toEqual(["p", "keep"]);

      await render({ newForYou: [{ id: "p", unread: true }, { id: "keep", unread: true }], previouslySeen: [], replyDone: { messageId: "p", at: "2026-08-02T09:01:00.000Z" } });

      // The write is the whole of what the reply signal does — answering a message is being done
      // with it. The move follows from the read, on the same slide any other read takes.
      expect(marked.some((m) => m.ids.includes("p") && m.unread === false)).toBe(true);

      // The shell's follow-up: the selector now has `p` read, in Earlier.
      await render({ newForYou: [{ id: "keep", unread: true }], previouslySeen: [{ id: "p", unread: false }] });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(idsInGroup("New")).not.toContain("p");
      expect(idsInGroup("Earlier")).toContain("p");
    } finally {
      vi.useRealTimers();
    }
  });
});
