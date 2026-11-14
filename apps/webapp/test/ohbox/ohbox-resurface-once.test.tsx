/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { cleanup } from "@testing-library/react";
import { pinnedRows } from "../_resurfaced-rows.js";
import { ohboxListRedrawable } from "../_ohbox-2-list.js";
import type { OhboxListInput } from "@ohmail/app-logic/ohbox";

/**
 * A RESURFACED MESSAGE IS ONE ROW — through the OPTIMISTIC window, not only after a reload.
 *
 * "Resurface now" pins the row at the top immediately (the overlay writes the state and
 * `ohboxView` files it in the pinned group, held out of the other two). The props this view
 * receives therefore never contain the message twice — but the view's SESSION ORDERS did:
 * `reconcile`'s keep clause holds an id as long as any of the three groups still knows it, so
 * `newOrder` went on holding a row the pin had just claimed, and the message rendered twice —
 * pinned at the top AND in its old New slot — until a reload emptied the orders. The settled
 * state was always right, which is exactly why nothing caught it: every earlier test mounted
 * fresh. These tests re-render one live view across the transition, the way the shell does.
 *
 * The rule under guard: each session order agrees with the SELECTOR about which section owns an
 * id. Delete the prune (`.filter((id) => !pinnedIds.has(id))` on `newOrder`) and the duplicate
 * comes back — the first test goes red. Delete the release arm and a rolled-back pin strands or
 * doubles the row — the third test goes red.
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): from today's Ohbox view (`./_today.js`, which leaves with today's
 * shell) to the Ohbox's own list drawn from its model (`../_ohbox-2-list.tsx`: `useOhboxList` and the list's parts,
 * redrawn on the same tree with each publish's groups, as the shell re-rendered today's view). Expectations untouched.
 */

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

interface Row { id: string; unread: boolean; pinned?: boolean }

/** The message as the selector hands it over — pinned rows carry the `resurfaced` state. */
function msg(m: Row): EngineMessage {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
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
let redraw: ((input: Partial<OhboxListInput>) => Promise<void>) | null = null;
let live: Row[] = [];

/**
 * One shell re-render over the mirror as it is NOW. The three group props are derived exactly as
 * `ohboxView` derives them: the pinned group holds every resurfaced row, and holds it OUT of the
 * other two — the dedup the selector already guarantees, so any double row on screen is this
 * list's own doing.
 */
async function draw(): Promise<void> {
  const input: Partial<OhboxListInput> = {
    resurfacedRows: pinnedRows(live.filter((r) => r.pinned).map(msg)),
    newForYou: live.filter((r) => !r.pinned && r.unread).map(msg),
    previouslySeen: live.filter((r) => !r.pinned && !r.unread).map(msg),
    replyDone: null,
    tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
  };
  if (redraw === null) {
    const drawn = ohboxListRedrawable(input);
    host = drawn.view.container;
    redraw = drawn.redraw;
    await act(async () => { await Promise.resolve(); });
  } else await redraw(input);
}

async function mount(rows: Row[]): Promise<void> {
  live = rows.map((r) => ({ ...r }));
  setViewport();
  await draw();
}

afterEach(() => {
  cleanup();
  host = null;
  redraw = null;
});

/** Every rendered occurrence of the message, wherever it sits. */
function occurrences(id: string): HTMLElement[] {
  return [...host!.querySelectorAll<HTMLElement>(`[role=option][data-id="${id}"]`)];
}

function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll("[role=option][data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

describe("resurface-now draws the message exactly once, immediately", () => {
  it("the pin claims a row OUT of New in the same optimistic gesture — never a duplicate", async () => {
    // The row is on screen in New — the session order now holds its id.
    await mount([
      { id: "target", unread: true },
      { id: "neighbor", unread: true },
      { id: "old", unread: false },
    ]);
    expect(idsInGroup("New")).toEqual(["target", "neighbor"]);
    expect(idsInGroup("Resurfaced")).toEqual([]);

    // "Resurface now": the overlay pins it; the selector holds it out of New. Same view instance,
    // same session orders — the exact window the duplicate lived in.
    live.find((r) => r.id === "target")!.pinned = true;
    await draw();

    expect(occurrences("target"), "one message, one row — pinned, not also in its old slot").toHaveLength(1);
    expect(idsInGroup("Resurfaced")).toEqual(["target"]);
    expect(idsInGroup("New")).toEqual(["neighbor"]);
  });

  it("the settled state (a fresh mount over the same mirror) is identical — one pinned row", async () => {
    await mount([
      { id: "target", unread: true, pinned: true },
      { id: "neighbor", unread: true },
      { id: "old", unread: false },
    ]);
    expect(occurrences("target")).toHaveLength(1);
    expect(idsInGroup("Resurfaced")).toEqual(["target"]);
    expect(idsInGroup("New")).toEqual(["neighbor"]);
  });

  it("a pin that rolls back re-files the row in New — once, not stranded and not doubled", async () => {
    await mount([
      { id: "target", unread: true },
      { id: "neighbor", unread: true },
    ]);
    live.find((r) => r.id === "target")!.pinned = true;
    await draw();
    expect(idsInGroup("Resurfaced")).toEqual(["target"]);

    // A hard rejection rolls the overlay back: the row is New's again, in the same live view.
    live.find((r) => r.id === "target")!.pinned = false;
    await draw();

    expect(occurrences("target"), "released to New — not held by a spent pin, not drawn twice").toHaveLength(1);
    expect(idsInGroup("Resurfaced")).toEqual([]);
    expect(idsInGroup("New")).toContain("target");
  });
});
