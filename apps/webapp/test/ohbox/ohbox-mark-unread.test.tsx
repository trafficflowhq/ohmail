/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";

/**
 * MARK-UNREAD IN THE OHBOX: THE ROW COMES BACK ABOVE THE "EARLIER" LINE.
 *
 * "New for you" is defined by unread-in-Ohbox, so a message the reader deliberately puts back to
 * unread belongs in that section — and `OhboxView`'s session placement is what decides where in
 * it. Both directions move the row at once: a read one slides down to "Earlier", and an explicit
 * unread comes back up into New at its ARRIVAL place — where every other surface, which only
 * received the change, puts it (as reported: leading New with it made the pressing desktop
 * disagree with the web for the rest of the session). Appending it, the first shape, is the other
 * wrong answer: one position, past a label.
 *
 * These drive the REAL path: the view's own `u` binding, then the prop change the shell makes when
 * the mirror flips. Delete `returnToNew([m.id])` from `markUnread` and the slide guards go red; put
 * a front block back into `reconcile` and the placement guards do.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Desktop split width — the reading column exists and the mobile-only paths stay away. */
function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; threadId?: string; date?: string }
function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: m.id, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: "s", unread: m.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** What the view asked the SHELL to write — the `onMarkSeen` seam. */
const marked: Array<{ ids: string[]; unread: boolean }> = [];

interface Props { newForYou: Row[]; previouslySeen: Row[]; selectedId?: string | null }

async function render(props: Props): Promise<void> {
  const OhboxView = await (await import("./_today.js")).prepareToday();
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      newForYou: props.newForYou.map(msg),
      previouslySeen: props.previouslySeen.map(msg),
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: props.selectedId ?? null, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: (ids: string[], unread: boolean) => { marked.push({ ids, unread }); },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

/** Press a chord the way the registry's dispatcher sees it. `shift` for the ⇧ variants. */
async function press(key: string, shift = false): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));
  });
}

/** The data-ids of the rows in the group with this aria-label ("New", "Earlier"). */
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll("[role=option][data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null; marked.length = 0;
});

describe("an explicit mark-unread RE-ENTERS New for you", () => {
  it("a row read before this session comes back ABOVE the Earlier line, at its arrival place in New", async () => {
    setViewport();
    await render({
      newForYou: [{ id: "n1", unread: true }, { id: "n2", unread: true }],
      previouslySeen: [{ id: "old", unread: false }],
      selectedId: "old",
    });
    expect(idsInGroup("New")).toEqual(["n1", "n2"]);
    expect(idsInGroup("Earlier")).toEqual(["old"]);

    await press("u");
    expect(marked).toEqual([{ ids: ["old"], unread: true }]);

    // The shell's re-partition: the mirror flips `old` unread, so the selector files it under
    // newForYou — LAST, because that group is ordered by arrival and `old` is the oldest.
    await render({
      newForYou: [{ id: "n1", unread: true }, { id: "n2", unread: true }, { id: "old", unread: true }],
      previouslySeen: [],
      selectedId: "old",
    });
    expect(idsInGroup("Earlier")).not.toContain("old");
    expect(idsInGroup("New")).toEqual(["n1", "n2", "old"]);
  });

  it("a row read this session goes DOWN, and `u` brings it back up to its arrival place", async () => {
    vi.useFakeTimers();
    try {
      setViewport();
      await render({ newForYou: [{ id: "a", unread: true }, { id: "b", unread: true }], previouslySeen: [], selectedId: "a" });
      // reading `a`: the mirror flips, the row slides, and "Earlier" has it when the slide ends.
      await render({ newForYou: [{ id: "b", unread: true }], previouslySeen: [{ id: "a", unread: false }], selectedId: "a" });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(idsInGroup("New")).toEqual(["b"]);
      expect(idsInGroup("Earlier")).toEqual(["a"]);

      // `u` on it: it re-enters at the selector's rank — first here, because it arrived first.
      await press("u");
      await render({ newForYou: [{ id: "a", unread: true }, { id: "b", unread: true }], previouslySeen: [], selectedId: "a" });
      expect(idsInGroup("New")).toEqual(["a", "b"]);
      expect(idsInGroup("Earlier")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("`u` on a row ALREADY in New is a no-op on placement", async () => {
    // A row already in New is a kept row: `u` changes nothing about where it belongs, so `b` stays
    // below the row it has always been below.
    setViewport();
    await render({ newForYou: [{ id: "a", unread: true }, { id: "b", unread: true }], previouslySeen: [], selectedId: "b" });
    expect(idsInGroup("New")).toEqual(["a", "b"]);

    await press("u");
    await render({ newForYou: [{ id: "a", unread: true }, { id: "b", unread: true }], previouslySeen: [], selectedId: "b" });
    expect(idsInGroup("New")).toEqual(["a", "b"]);
  });

  it("a GROUPED thread: re-unreading a member puts the conversation's row at its arrival place in New", async () => {
    setViewport();
    await render({
      newForYou: [{ id: "n1", unread: true }],
      previouslySeen: [
        { id: "t1", unread: false, threadId: "T", date: "2026-08-02T08:00:00.000Z" },
        { id: "t2", unread: false, threadId: "T", date: "2026-08-02T08:30:00.000Z" },
      ],
      selectedId: "t2",
    });
    // Both members fold into ONE Earlier row, led by the newest.
    expect(idsInGroup("Earlier")).toEqual(["t2"]);

    await press("u");
    expect(marked).toEqual([{ ids: ["t2"], unread: true }]);

    // The conversation is the unit of place (2026-09-28): the selector files the WHOLE
    // conversation in New once a member is unread, at its arrival rank, as ONE row.
    await render({
      newForYou: [
        { id: "n1", unread: true },
        { id: "t2", unread: true, threadId: "T", date: "2026-08-02T08:30:00.000Z" },
        { id: "t1", unread: false, threadId: "T", date: "2026-08-02T08:00:00.000Z" },
      ],
      previouslySeen: [],
      selectedId: "t2",
    });
    expect(idsInGroup("New")).toEqual(["n1", "t2"]);
    expect(idsInGroup("Earlier")).toEqual([]);
  });

  it("⇧I on a row returned to New sends it straight back down — both directions move", async () => {
    // A return is not a pin. The moment the row stops being unread it belongs under "Earlier"
    // again, and `dropped` reads the two facts together.
    vi.useFakeTimers();
    try {
      setViewport();
      await render({
        newForYou: [{ id: "n1", unread: true }],
        previouslySeen: [{ id: "old", unread: false }],
        selectedId: "old",
      });
      await press("u");
      await render({
        newForYou: [{ id: "n1", unread: true }, { id: "old", unread: true }],
        previouslySeen: [],
        selectedId: "old",
      });
      expect(idsInGroup("New")).toEqual(["n1", "old"]);

      await press("I", true);
      expect(marked).toEqual([{ ids: ["old"], unread: true }, { ids: ["old"], unread: false }]);
      await render({
        newForYou: [{ id: "n1", unread: true }],
        previouslySeen: [{ id: "old", unread: false }],
        selectedId: "old",
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(idsInGroup("New")).toEqual(["n1"]);
      expect(idsInGroup("Earlier")).toEqual(["old"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
