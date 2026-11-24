/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { fakeMail, type FakeMail } from "../../../../packages/app/test/reader/support/fake-mail.js";
import { admitting, mountSeat, unmountSeat } from "../_ohbox-1-seat.js";

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
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): from today's harness (`./_today.js` `prepareSeated`, handed
 * cut lists, under today's `KeymapProvider`) to the Ohbox's own seat over the mail ground (`../_ohbox-1-seat.tsx`):
 * the seat binds `u` and ⇧I, the shell's re-partition is the mirror's flip written into the engine's rows, and what the
 * view asked the shell to write is read off what the seat's seam sent. Every expectation is as it stood.
 */

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

let host: HTMLElement | null = null;
let mail: FakeMail | null = null;
/** What the view asked the SHELL to write: the `mark_seen` the seat's seam sent, in its direction. */
const marked = (): Array<{ ids: string[]; unread: boolean }> =>
  (mail?.mutations ?? []).flatMap((x) => {
    const r = x as { kind: string; messageIds?: string[]; messageId?: string; unread?: boolean };
    return r.kind === "mark_seen" ? [{ ids: r.messageIds ?? [r.messageId!], unread: r.unread === true }] : [];
  });

interface Props {
  newForYou: Row[];
  previouslySeen: Row[];
  selectedId?: string | null;
  /**
   * The selected row is the CURSOR's and no reader shows its letter (today's harness: `selectedId` with `readerId`
   * null): the seat at one column, the cursor walked onto the row with `j`, as a person puts it there.
   */
  cursorOnly?: boolean;
}

/** The seat's letters come from one admitted sender (named as the row). */
const SENDER = "sender@ex.example";
/**
 * Today's harness was handed each group in the selector's order (arrival, newest first); the seat orders its rows by
 * their dates, so a row without a date of its own is dated by where it first stood: each a minute older than the last.
 */
const dated = new Map<string, string>();
const dateOf = (r: Row): string => {
  if (r.date !== undefined) return r.date;
  if (!dated.has(r.id)) dated.set(r.id, new Date(Date.parse("2026-08-02T09:00:00.000Z") - dated.size * 60_000).toISOString());
  return dated.get(r.id)!;
};
const seatMsg = (r: Row): EngineMessage =>
  ({ ...msg({ ...r, date: dateOf(r) }), from: { name: r.id, address: SENDER } }) as unknown as EngineMessage;

/**
 * The first call stands the seat over an engine of these rows (the selected row's letter in the address); a later
 * call is the shell's re-partition: the mirror's flip written into the engine's rows, as a sync or a write lands.
 */
async function render(props: Props): Promise<void> {
  const rows = [...props.newForYou, ...props.previouslySeen];
  if (mail === null) {
    mail = fakeMail(rows.map(seatMsg), [], {}, admitting([SENDER]));
    if (props.cursorOnly === true) {
      host = mountSeat(mail.engine, { room: "phone" }).container;
      for (let i = 0; i < rows.length && cursorRow() !== props.selectedId; i++) await press("j");
      expect(cursorRow(), "the cursor walked onto the selected row").toBe(props.selectedId);
    } else host = mountSeat(mail.engine, { first: props.selectedId ? `#/ohbox/m/${props.selectedId}` : "#/ohbox" }).container;
  } else {
    const m = mail;
    await act(async () => {
      for (const r of rows) {
        if (m.engine.read().get("message", r.id) === undefined) m.add(seatMsg(r));
        else m.patch(r.id, { unread: r.unread });
      }
    });
  }
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** Press a chord the way the registry's dispatcher sees it. `shift` for the ⇧ variants. */
async function press(key: string, shift = false): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));
  });
}

/** The row the cursor stands on at one column (the list marks it open: no letter is named), or null. */
const cursorRow = (): string | null => host?.querySelector<HTMLElement>("[role=option][data-open]")?.dataset.id ?? null;

/** The data-ids of the rows in the group with this aria-label ("New", "Earlier"). */
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll("[role=option][data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

afterEach(() => {
  unmountSeat();
  host = null; mail = null; dated.clear();
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
    expect(marked()).toEqual([{ ids: ["old"], unread: true }]);

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
    expect(marked()).toEqual([{ ids: ["t2"], unread: true }]);

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
        selectedId: "old", cursorOnly: true,
      });
      await press("u");
      await render({
        newForYou: [{ id: "n1", unread: true }, { id: "old", unread: true }],
        previouslySeen: [],
        selectedId: "old", cursorOnly: true,
      });
      expect(idsInGroup("New")).toEqual(["n1", "old"]);

      await press("I", true);
      expect(marked()).toEqual([{ ids: ["old"], unread: true }, { ids: ["old"], unread: false }]);
      await render({
        newForYou: [{ id: "n1", unread: true }],
        previouslySeen: [{ id: "old", unread: false }],
        selectedId: "old", cursorOnly: true,
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(idsInGroup("New")).toEqual(["n1"]);
      expect(idsInGroup("Earlier")).toEqual(["old"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
