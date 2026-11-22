/** @vitest-environment jsdom */
// First: the new shell's door pins the API base before anything reads it.
import {
  click as clickRow, columnHidden, frame as look, host as seatHost, idsInGroup, key, mountSeated,
  openInAddress, rowEl, seatDown, seatEnv, serverSays, wait, writes, type SeatedRow,
} from "../_ohbox-2-seated.js";
import { act } from "../fixtures/live-walk-shell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubThreadLayout, type ThreadLayout } from "../fixtures/thread-layout.js";
import { at, mount as mountModel, msg as plain, wide, type Harness } from "../../../../packages/app-logic/test/ohbox/harness.js";

/**
 * READING MOVES THE MESSAGE TO "EARLIER", AND IT MOVES IT NOW — mail read here or on another client
 * (a `\Seen` the worker writes into the mirror) re-files without a reload, by SLIDING (`slideOut`:
 * the row keeps its slot for `SETTLE_MS` wearing `settling`, then is redrawn below). Three things
 * hold at once: the move happens whatever read the message; it never happens while the message is
 * the one being read (its read is saved while it is open, its place held until it is left — `heldRead`),
 * and it is never a teleport; a later explicit act beats it.
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): from today's Ohbox view over a modelled mirror and hold
 * (`./_today.js`, which leaves with today's shell) to THE NEW SHELL's own door (`../_ohbox-2-seated.ts`: the web's
 * shell over a live engine whose own selector and hold file the rows, a served page, the read wire recorded, the
 * server echoing each write): a read from another client is the server's delta (`serverSays`). The settled reply's
 * case states the Ohbox's own model and is re-pointed to its door (`packages/app-logic/test/ohbox/harness.ts`: the
 * model handed the composer's settled reply, as the seat hands it `useReplyDone()`). Two cases retired, each holder
 * named where it stood. Every expectation as it stood.
 */

/** Comfortably past the slide. */
const AFTER_SLIDE_MS = 400;

type Row = SeatedRow;

/** What was saved, as today's seam carried it (ids and direction). */
let marked: Array<{ ids: string[]; unread: boolean }> = [];
let host: HTMLElement | null = null;

async function mount(rows: Row[]): Promise<void> {
  host = await mountSeated(rows);
  marked = writes();
}

/** A frame passes: the rule looks at what is on screen. */
async function frame(): Promise<void> {
  await look();
  marked = writes();
}

/** A click, and a frame for the rule. */
async function click(id: string): Promise<void> {
  await clickRow(id);
  await frame();
}

/** A chord, the way the keymap's dispatcher sees it. */
async function press(k: string, shift = false): Promise<void> {
  await key(k, { shiftKey: shift });
  await frame();
}

/**
 * READ A MESSAGE FOR REAL, the way the split pane does it: a click OPENS it, and the read rule
 * saves the read of what is on screen; then the cursor moves off with `j`/`k` — a preview, the
 * departure that releases the row's place so it can slide, and reads nothing itself.
 */
async function readAndLeave(id: string, leaveTo: string): Promise<void> {
  await click(id);
  await layout.passDwell(); // the message's top on screen for the dwell: it is read
  const order = [...idsInGroup("Resurfaced"), ...idsInGroup("New"), ...idsInGroup("Earlier")];
  const from = order.indexOf(openInAddress() ?? id);
  const to = order.indexOf(leaveTo);
  const step = to > from ? "j" : "k";
  for (let i = 0; i < Math.abs(to - from); i++) await press(step);
}

/** An older member of the conversation turns read (here: the account's server says it, as the column's rule would). */
async function readInColumn(id: string, settled = true): Promise<void> {
  await serverSays({ id, gone: false, over: { unread: false } });
  if (settled) await settle();
  else await frame();
}

/** Let the slide run to its end. */
async function settle(ms = AFTER_SLIDE_MS): Promise<void> {
  await frame();
  await wait(ms);
  marked = writes();
}

/**
 * A DELTA FROM SOMEWHERE ELSE — the worker writing an adopted `\Seen` (or an adopted unread) into
 * the mirror. No click, no keypress, nothing this view initiated: the server's next drain says it.
 */
async function delta(id: string, unread: boolean): Promise<void> {
  await serverSays({ id, gone: false, over: { unread } });
  marked = writes();
}

let layout: ThreadLayout;
beforeEach(() => {
  seatEnv();
  layout = stubThreadLayout({ columnHidden });
  marked = [];
  host = null;
});
afterEach(async () => {
  layout.restore();
  await seatDown();
});

describe("a message read in the Ohbox moves to Earlier, now", () => {
  /* "the row slides out of New and lands under Earlier — no reload" RETIRED (share ohbox-2): the same promise is held
     over the new shell by `ohbox/ohbox-read-state.test.ts`, "the four departures" > "#1 — the cursor moving to a
     different message releases the place and writes nothing" (a read of "a" saved at the open, j to "b", and after
     the slide "a" stands under Earlier, with no reload and nothing written twice). */

  it("mark-all-read empties New — every row slides, none is left behind", async () => {
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }, { id: "c", unread: false }]);
    await act(async () => { [...seatHost().querySelectorAll<HTMLElement>("button")].find((b) => /^Mark all \d+ unread messages read$/.test(b.getAttribute("aria-label") ?? ""))!.click(); });
    await frame();
    await settle();
    expect(idsInGroup("New")).toEqual([]);
    expect(idsInGroup("Earlier").sort()).toEqual(["a", "b", "c"]);
  });
});

describe("a conversation moves as one row", () => {
  it("one of three read: the row STAYS in New, count and all; the last read takes the row", async () => {
    /* The unit of reading is the message and the unit of place is the conversation, so a thread
       with unread replies left in it is still waiting and must not move. The harness models
       `ohboxView`'s filing; the rule itself is pinned by the engine census, where putting it back
       to per message reddens it. What this measures is the view: the read member rides the row,
       the row stays one, and it leaves New only with its last unread member. */
    layout.heights.t3 = 900; // The latest letter fills the reader when it opens.
    await mount([
      { id: "t3", unread: true, threadId: "T", n: 3 },
      { id: "t2", unread: true, threadId: "T", n: 2 },
      { id: "t1", unread: true, threadId: "T", n: 1 },
      { id: "solo", unread: true, n: 0 },
    ]);
    // One row for the conversation, led by its latest unread, and one for the loner.
    expect(idsInGroup("New")).toEqual(["t3", "solo"]);
    expect(rowEl("t3").dataset.ids?.split(" ").length, "the row stands for its 3 letters").toBe(3);

    // Read the latest letter, then leave the conversation.
    await readAndLeave("t3", "solo");
    await settle();

    // The conversation is still waiting — two replies of it are unread — so the row stands.
    // The read message RIDES that row (2026-09-28): the conversation is one row, and
    // its count is the conversation's length, not what is left unread. The row keeps t3's id:
    // it represents the entire conversation.
    expect(idsInGroup("New")).toEqual(["t3", "solo"]);
    expect(rowEl("t3").dataset.ids?.split(" ").length, "the row stands for its 3 letters").toBe(3);
    expect(idsInGroup("Earlier")).toEqual([]);

    // Work through the rest, read in the conversation's column. The last one takes the row with it.
    const readOnOpen = writes().flatMap((w) => w.ids);
    expect(readOnOpen).toEqual(["t3"]);
    const rest = ["t3", "t2", "t1"].filter((id) => !readOnOpen.includes(id));
    await readInColumn(rest[0]!);
    expect(idsInGroup("New")).toEqual(["t3", "solo"]);

    await readInColumn(rest[1]!);
    expect(idsInGroup("New")).toEqual(["solo"]);
    // The whole conversation is one row under Earlier now.
    expect(idsInGroup("Earlier")).toEqual(["t3"]);
    expect(rowEl("t3").dataset.ids?.split(" ").length, "the row stands for its 3 letters").toBe(3);
  });

});

describe("a later explicit act beats a slide", () => {

  it("an unread arriving from another client brings a row that already went down BACK", async () => {
    /* `dismissed` takes an entry for every message read in the session now, so a permanent one
       would swallow the way back. Drop the `earlierIds` conjunct from `dropped` in
       `OhboxView.tsx` and this goes red: mail marked unread in Outlook re-partitions into "New
       for you" and this view refuses to draw it there — the row is in neither section. */
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);
    await readAndLeave("a", "b");
    await settle();
    expect(idsInGroup("Earlier")).toEqual(["a"]);

    await delta("a", true);            // somebody marked it unread on another device
    await settle();
    expect(idsInGroup("New")).toContain("a");
    expect(idsInGroup("Earlier")).toEqual([]);
  });
});

describe("the reader is not yanked", () => {
  /* "the row does not move while the message is the one being read" RETIRED (share ohbox-2): the same promise is held
     over the new shell by `ohbox/ohbox-read-state.test.ts`, "opening a message enters it: …" > "the message being read
     keeps its PLACE, and its ink and the count agree with the save" (the read saved at the open, the row kept in New
     unbolded while it is read, moving on files it under Earlier, one write). Its `settling` class was today's view's
     markup: the kit's row wears none. */

  it("nothing writes the list's scrollTop — the slide never moves the viewport itself", async () => {
    /* The row's own height is animated away and the browser's scroll anchoring does the rest.
       Add a `scrollTop` assignment anywhere on the slide path — the obvious "scroll the reader
       back to the top" — and this goes red. A reader forty rows down does not expect a message
       they finished with to take the page with it. */
    await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);
    const scroller = host!.querySelector(".ob-scroll")!;
    let writes = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => { writes += 1; },
    });

    await readAndLeave("a", "b");
    await settle();
    expect(idsInGroup("Earlier")).toEqual(["a"]);
    expect(writes).toBe(0);
  });
});

describe("a read that happened somewhere else", () => {

  /* RE-POINTED to the Ohbox's own model (its door: `packages/app-logic/test/ohbox/harness.ts`), which the seat hands
     the composer's settled reply (`packages/app-logic/src/ohbox/live.ts`, `replyDone: useReplyDone()`); the
     engine's re-filing after the read is the model's next publish, as the mirror's flip reached today's view. */
  it("a settled reply marks the answered message read, and the same slide carries it down", async () => {
    layout.restore();
    await seatDown();
    wide();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(at(12)));
    const p = plain({ id: "p", date: at(9, 1) });
    const keep = plain({ id: "keep", date: at(9) });
    const ohbox: Harness = await mountModel({ newForYou: [p, keep] });
    const group = (g: "groupedNew" | "groupedPrev"): string[] => ohbox.model[g].map((r) => r.openTarget.id);
    try {
      await ohbox.publish({ replyDone: { messageId: "p", at: "2026-08-02T09:01:00.000Z" } });
      const marked = ohbox.calls.marked.map(({ ids, unread }) => ({ ids, unread }));
      expect(marked).toEqual([{ ids: ["p"], unread: false }]);
      await ohbox.publish({ newForYou: [keep], previouslySeen: [{ ...p, unread: false }] });   // the shell's re-render on the flip

      await ohbox.run(() => { vi.advanceTimersByTime(AFTER_SLIDE_MS); });
      await ohbox.publish({});
      expect(group("groupedNew")).toEqual(["keep"]);
      expect(group("groupedPrev")).toEqual(["p"]);
    } finally {
      await ohbox.unmount();
      layout = stubThreadLayout({ columnHidden });
      seatEnv();
    }
  });
});
