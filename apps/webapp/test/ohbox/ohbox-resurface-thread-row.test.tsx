/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { pinnedRows } from "../_resurfaced-rows.js";
import { ohboxList } from "../_ohbox-1-list.js";

/**
 * ONE ROW PER CONVERSATION UNDER RESURFACED, AS THE DOM — the rendered half of FEAT-020.
 *
 * The pin is per message, so a conversation parked as three messages stood as three rows, and the
 * reply that arrived while it was away stood a fourth time under "New for you". `resurfacedThreads`
 * answers which conversations are back; this measures what the list does with that answer: one row,
 * its lead in `data-id` and every member in `data-ids`.
 *
 * RE-POINTED (share ohbox-2, the switch's older tests) from today's harness (`./_today.js` `prepareSeated` under
 * today's `KeymapProvider`) to the Ohbox's own list drawn from its model (`../_ohbox-1-list.tsx`: the real
 * `useOhboxList` fed the same rows, as the seat draws them). The expectation is as it stood. Today's second describe
 * ("the badge says somebody wrote since you asked to see this again": a chip of today's row, its one case asserting
 * nothing) retired with today's Ohbox view: the kit's row draws no such chip.
 */

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

let host: HTMLElement | null = null;

async function mount(opts: {
  pinned: Row[];
  siblings?: Row[];
  /** When the pin went up — anything arriving after it and unread is "new since". */
  pinnedAt?: string;
}): Promise<void> {
  setViewport();
  const rows = pinnedRows(opts.pinned.map(msg), (opts.siblings ?? []).map(msg), opts.pinnedAt);
  host = ohboxList({ resurfacedRows: rows, newForYou: [], previouslySeen: [], now: NOW }).container;
}

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
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
