/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { cleanup, within } from "@testing-library/react";
import { pinnedRows } from "../_resurfaced-rows.js";
import { ohboxList } from "../_ohbox-1-list.js";

/**
 * "DONE" ON A RESURFACED ROW, AT THE OHBOX — the release verb's row-level face, over the Ohbox's own list.
 *
 * Moved from `ohbox-resurface-done.test.tsx` (whose Resurface pile's cases wait there for the streams' mount) and
 * re-pointed from today's `OhboxView` to the Ohbox's own model and list (`../_ohbox-1-list.tsx`, the seat's
 * `packages/app/test/ohbox/ohbox-world.tsx` over the list's own files: the real `useOhboxList` fed plain rows). The seams the cases count are the same two the
 * view had: `bulk.run` (the batched release) and `onAction` (the per-message press). The cases are as they stood.
 *
 * A resurfaced row stays pinned until it is answered or DELIBERATELY marked read, and nothing NAMED the deliberate
 * release: the control under guard is that name — a "Done" in the row's action slot — dispatching the release for
 * THE ROW'S OWN messages, never the selected one.
 */

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: string; unread: boolean; pinned?: boolean; threadId?: string }

/** The message as the selector hands it over — pinned rows carry the `resurfaced` state. */
function msg(m: Row): EngineMessage {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: m.pinned
      ? { messageId: m.id, state: "resurfaced", bubbleUpAt: null, setAt: "2026-08-02T09:00:00.000Z", updatedAt: "2026-08-02T09:00:00.000Z" }
      : null,
    labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  } as unknown as EngineMessage;
}

let host: HTMLElement | null = null;
/** What the list asked the shell to do — the `onAction` seam. */
let dispatched: Array<[string, string]> = [];
/** And the batched seam Done uses over a conversation — `bulk.run`. */
let bulkRuns: Array<[string, string[]]> = [];

/** The Ohbox's own list over the rows, as today's harness handed `OhboxView` its lists already cut. */
async function mountOhbox(rows: Row[]): Promise<void> {
  const view = ohboxList({
    resurfacedRows: pinnedRows(rows.filter((r) => r.pinned).map(msg)),
    newForYou: rows.filter((r) => !r.pinned && r.unread).map(msg),
    previouslySeen: rows.filter((r) => !r.pinned && !r.unread).map(msg),
    now: new Date("2026-08-02T09:00:00.000Z"),
    bulk: {
      run: (a: string, ids: string[]) => { bulkRuns.push([a, ids]); return true; },
      tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => true,
    },
    onAction: ((a: string, m: { id: string }) => { dispatched.push([a, m.id]); }) as never,
  });
  host = view.container;
}

/** What jsdom lacks that the kit's parts ask for: a media query that answers, an animation that ends. */
beforeEach(() => {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});

afterEach(() => {
  cleanup();
  host = null;
  dispatched = [];
  bulkRuns = [];
});

/** The Done control standing beside the row that carries `id`, or null. */
function doneBeside(id: string): HTMLButtonElement | null {
  const rowEl = host!.querySelector<HTMLElement>(`:is(.row, [role=option])[data-id="${id}"]`);
  if (!rowEl) return null;
  // Today's piles stand it beside the row; the Ohbox's row stands its own verb beside it too, in the row's slot.
  const slot = rowEl.parentElement;
  return slot === null ? null : within(slot).queryByRole<HTMLButtonElement>("button", { name: "Done" });
}

const click = async (el: Element | null): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

describe("the pinned row carries Done — and only the pinned row", () => {

  /**
   * MOVED DELIBERATELY (FEAT-020): the Resurfaced block is one row per CONVERSATION, so Done is a
   * release over the row's pinned members and goes through the batched `bulk.run("done", ids)`
   * seam, not the per-message `onAction`. What the test defends is unchanged — the press acts on
   * THIS row and no other — and it now also says how many ids that is.
   */
  it("releases THIS row and no other — the second pin, not the first", async () => {
    await mountOhbox([
      { id: "pin-a", unread: true, pinned: true },
      { id: "pin-b", unread: true, pinned: true },
    ]);
    await click(doneBeside("pin-b"));
    // One call, the row's own ids. A control that pressed `⇧I` instead would act on the
    // SELECTED message — with nothing selected, on nothing at all.
    expect(bulkRuns).toEqual([["done", ["pin-b"]]]);
    expect(dispatched).toEqual([]);
  });

  /**
   * THE POINT OF THE FOLD, as data. MUTATION WATCHED: pass `[g.openTarget.id]` instead of the
   * row's pinned members in `doneForRow` and this reads one id — the conversation comes straight
   * back with two of its three pins still standing.
   */
  it("a conversation releases every member carrying a pin, in one press", async () => {
    await mountOhbox([
      { id: "c-1", unread: true, pinned: true, threadId: "T" },
      { id: "c-2", unread: true, pinned: true, threadId: "T" },
      { id: "c-3", unread: true, pinned: true, threadId: "T" },
    ]);
    const done = within(host!).getAllByRole("button", { name: "Done" });
    expect(done, "three pins in one conversation are ONE row").toHaveLength(1);
    await click(done[0]!);
    expect(bulkRuns).toHaveLength(1);
    expect(bulkRuns[0]![0]).toBe("done");
    expect([...bulkRuns[0]![1]].sort()).toEqual(["c-1", "c-2", "c-3"]);
  });


});
