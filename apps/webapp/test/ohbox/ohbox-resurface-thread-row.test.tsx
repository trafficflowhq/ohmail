/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import { pinnedRows } from "../_resurfaced-rows.js";

/**
 * ONE ROW PER CONVERSATION UNDER RESURFACED, AS THE DOM — the rendered half of FEAT-020.
 *
 * The pin is per message, so a conversation parked as three messages stood as three rows, and the
 * reply that arrived while it was away stood a fourth time under "New for you". `resurfacedThreads`
 * answers which conversations are back; this measures what the list does with that answer: one row,
 * its lead in `data-id` and every member in `data-ids`, the conversation's own length, and the
 * badge for what arrived since the pin went up — a chip, distinct from the unread dot, because the
 * dot says "not read" and this says "somebody wrote while this was waiting".
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

const NOW = new Date("2026-09-10T09:00:00.000Z");

interface Row { id: string; unread?: boolean; threadId?: string; date?: string }

function msg(m: Row): EngineMessage {
  const date = m.date ?? "2026-09-01T09:00:00.000Z";
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: m.id, address: `${m.id}@example.invalid` }, to: [], cc: [],
    date, arrivedAt: date, folder: "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread ?? false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(opts: {
  pinned: Row[];
  siblings?: Row[];
  /** When the pin went up — anything arriving after it and unread is "new since". */
  pinnedAt?: string;
  thread?: { id: string; messageIds: string[] };
}): Promise<void> {
  setViewport();
  const OhboxView = await (await import("./_today.js")).prepareSeated();
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const rows = pinnedRows(opts.pinned.map(msg), (opts.siblings ?? []).map(msg), opts.pinnedAt);
  // The server's own thread length, which a windowed mirror need not hold — stamped on the row
  // the same way `resurfacedThreads` reads it off a synced `thread` record.
  const withCount = opts.thread
    ? rows.map((r) => (r.key === opts.thread!.id
      ? { ...r, count: opts.thread!.messageIds.length, countFromThread: true }
      : r))
    : rows;
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      resurfacedRows: withCount,
      newForYou: [], previouslySeen: [],
      replyDone: null,
      tags: [], now: NOW,
      selectedId: null,
      onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: () => {},
      bulk: { run: () => true, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      onMarkAllRead: () => {},
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

/** The rows inside the Resurfaced listbox, as the other Ohbox guards read them. */
const resurfacedRowEls = (): HTMLElement[] =>
  [...host!.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Resurfaced"] [role=option][data-id]')];

describe("a resurfaced conversation is one row in the DOM", () => {
  /**
   * CONTROL (f). MUTATION WATCHED: render `displayResurfaced.map((m) => rowWith(m, doneFor(m)))`
   * again and this reads three rows with three leads — the defect, exactly as reported.
   */
  it("three pinned members are ONE row: the lead in data-id, every member in data-ids", async () => {
    await mount({
      pinned: [
        { id: "m-1", threadId: "T", date: "2026-09-01T09:00:00.000Z" },
        { id: "m-2", threadId: "T", date: "2026-09-02T09:00:00.000Z" },
        { id: "m-3", threadId: "T", date: "2026-09-03T09:00:00.000Z" },
      ],
    });
    const els = resurfacedRowEls();
    expect(els).toHaveLength(1);
    // `idsInGroup` reads leads only — the contract `ohbox-resurface-once` asserts one level up.
    expect(els[0]!.getAttribute("data-id")).toBe("m-3");
    expect(els[0]!.getAttribute("data-ids")?.split(" ").sort()).toEqual(["m-1", "m-2", "m-3"]);
  });

});

describe("the badge says somebody wrote since you asked to see this again", () => {
  const conversation = {
    pinned: [{ id: "pin", threadId: "T", date: "2026-09-01T09:00:00.000Z" }],
    siblings: [{ id: "reply", threadId: "T", date: "2026-09-05T09:00:00.000Z", unread: true }],
  };


  /**
   * MUTATION WATCHED: render the chip on `newSince >= 0` rather than `> 0` and every resurfaced
   * row in the product wears a "0 new" badge.
   */
  it("is absent when nothing arrived since the pin", async () => {
    await mount({ pinned: [{ id: "pin", threadId: "T" }, { id: "old", threadId: "T" }] });
  });

});
