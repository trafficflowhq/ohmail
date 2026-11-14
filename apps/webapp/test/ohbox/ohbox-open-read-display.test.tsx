/** @vitest-environment jsdom */
// First: the new shell's door pins the API base before anything reads it.
import {
  back, click as clickRow, columnHidden, frame, held as heldLog, host as seatHost, idsInGroup, key, mountSeated, rowEl,
  seatDown, seatEnv, wait, writes,
} from "../_ohbox-2-seated.js";
import { headCount, letterShown, readSlot } from "./_finders.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubThreadLayout, type ThreadLayout } from "../fixtures/thread-layout.js";

/**
 * WHAT THE SCREEN SAYS IS WHAT THE ACCOUNT HOLDS (owner-reported presentation). An open enters the
 * conversation and the message on screen is read by the thread-read rule: the row's dot and weight
 * go, the open message's verb says "Mark unread" and the read is SAVED in the same moment, so the
 * counts agree with the row. A j/k preview shows the message and changes nothing. The row keeps
 * its PLACE under New until it is left, and `u` re-bolds it in place, puts the verb back and keeps
 * it unread for the visit. The column is laid out (`fixtures/thread-layout.ts`).
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): from today's Ohbox view handed its lists (`./_today.js`, which
 * leaves with today's shell) to THE NEW SHELL's own door (`../_ohbox-2-seated.ts`: the web's shell over a live engine,
 * a served page, the read wire recorded, the server echoing each write). The three seams the old harness handed the view
 * are read where the new shell carries them: what was saved is the read wire (`marked`, ids and direction as the seam
 * had them), the hold is what the engine was asked to hold (`heldLog`: the seat hands its `onHoldRow` to the engine's
 * `holdOpenRow` and `releaseOpenRow`), and the selection taken away from outside is the address going Back to the
 * Ohbox's. Every expectation as it stood; one case retired, its holder named where it stood.
 */

/** Comfortably past the slide. */
const AFTER_SLIDE_MS = 400;

interface Row { id: string; unread: boolean }

/** What was saved, as today's seam carried it. */
let marked: Array<{ ids: string[]; unread: boolean }> = [];
let host: HTMLElement | null = null;

async function mount(rows: Row[]): Promise<void> {
  host = await mountSeated(rows);
}

/** The read-state slot of the open message's action panel — "Mark read" or "Mark unread". */
function verb(): string {
  const b = readSlot(seatHost());
  if (!b) throw new Error("no read-state verb on screen — is a message open in the column?");
  return b.getAttribute("aria-label") ?? "";
}

async function click(id: string): Promise<void> {
  await clickRow(id);
  await frame();
  marked = writes();
}

async function press(k: string): Promise<void> {
  await key(k);
  await frame();
  marked = writes();
}

async function settle(ms = AFTER_SLIDE_MS): Promise<void> {
  await wait(ms);
  marked = writes();
}

/** Time passes with a letter on screen; what it saved is read after. */
async function advance(ms: number): Promise<void> {
  await wait(ms);
  marked = writes();
}

/** The address goes Back to the Ohbox's: the selection taken away from outside. */
async function goBack(): Promise<void> {
  await back();
  marked = writes();
}

/** A frame passes, and what it saved is read. */
async function draw(): Promise<void> {
  await frame();
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

/* "a" the newer (09:01 against 09:00 today): the served page dates its rows newest first in the order given. */
const two = (): Row[] => [{ id: "a", unread: true }, { id: "b", unread: true }];

describe("the selection taken away from outside is a departure", () => {
  // The URL carries the open message, so Back on `#/ohbox/m/A` clears the SHELL's selection while
  // this view stays mounted — a way of leaving that none of the in-view departures can see.
  it("Back from a preview within the rest: nothing is ever written for A", async () => {
    await mount(two());
    await press("j");          // a preview of "a"
    await advance(1000);
    await goBack();
    await advance(4000);
    expect(marked, "a preview left before the rest is not reading").toEqual([]);
  });

  it("Back from a preview rested on: its read stands, Back writes nothing more", async () => {
    await mount(two());
    await press("j");
    await advance(4000);
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    await goBack();
    await advance(4000);
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
  });

  it("an open saves the read; Back after it writes nothing more", async () => {
    await mount(two());
    await click("a");
    await layout.passDwell(); // its top on screen for the dwell
    await draw();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    await goBack();
    expect(marked, "Back is a departure: it releases the place and writes nothing").toEqual([
      { ids: ["a"], unread: false },
    ]);
  });
});

describe("the open message's read state is the account's", () => {
  it("open: the message on screen is read, the verb offers Mark unread, the row unbolds IN PLACE", async () => {
    await mount(two());
    await click("a");
    await layout.passDwell();
    await draw();
    expect(verb()).toContain("Mark unread");
    expect(verb()).not.toContain("Mark read");
    expect(rowEl("a").dataset.unseen, "the open message's row keeps unread ink").toBeUndefined();
    expect(rowEl("a").hasAttribute("data-unread")).toBe(false);
    // …and IN PLACE: nothing moved yet, the read was written, and the count agrees with the row.
    expect(idsInGroup("New")).toEqual(["a", "b"]);
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(headCount(host!)).toBe("1");
  });

  it("a preview shows the message as it is: bold, the verb Mark read, nothing saved; rested on, it reads", async () => {
    await mount(two());
    await press("j");
    await advance(1000);
    await draw();
    expect(rowEl("a").dataset.unseen, "a preview is not a reading").toBe("1");
    expect(verb()).toContain("Mark read");
    expect(marked).toEqual([]);
    expect(letterShown(host!, "a")?.hasAttribute("data-unseen"), "the opened panel wears its unread state").toBe(true);
    await advance(1100);
    await draw();
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(rowEl("a").dataset.unseen).toBeUndefined();
    expect(verb()).toContain("Mark unread");
  });

  it("`u` on the read message re-bolds it in place, the verb offers Mark read again, and it is not read back", async () => {
    await mount(two());
    await click("a");
    await layout.passDwell();
    await draw();
    expect(rowEl("a").dataset.unseen).toBeUndefined();

    await press("u");
    expect(marked.at(-1)).toEqual({ ids: ["a"], unread: true });
    expect(rowEl("a").dataset.unseen).toBe("1");
    expect(verb()).toContain("Mark read");
    expect(idsInGroup("New")).toEqual(["a", "b"]);

    // …and the keep holds: nothing after `u` writes the message read again while it stays open.
    const afterU = marked.length;
    await settle();
    await layout.passDwell();
    await draw();
    expect(marked.slice(afterU).filter((m) => m.ids.includes("a") && !m.unread)).toEqual([]);
  });

  /* "the open writes exactly one read, leaving adds none, and the row then slides to Earlier" RETIRED (share ohbox-2):
     the same promise is held over the new shell by `ohbox/ohbox-read-state.test.ts`, "the four departures" > "#1 — the
     cursor moving to a different message releases the place and writes nothing" (an open of "a" saves its one read; j
     to the next row writes nothing more; after the slide "a" stands in Earlier). */

  it("the entered row is reported upward for the engine's hold, and cleared on departure", async () => {
    /* The shell holds the row in New (`holdOpenRow`) from the enter, before anything is read, so
       every read of the conversation meanwhile is an open read. */
    await mount(two());
    await click("a");
    expect(heldLog.at(-1)).toBe("a");
    await press("u");
    expect(heldLog.at(-1)).toBeNull();

    await click("a");          // open again
    expect(heldLog.at(-1)).toBe("a");
    await press("j");          // a preview of b is the departure; the hold ends
    expect(heldLog.at(-1)).toBeNull();
  });
});
