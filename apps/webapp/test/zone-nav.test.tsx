/** @vitest-environment jsdom */
// First: the new shell's door pins the API base before anything reads it (`engine-config.ts` reads it once).
import { installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { mountThread, msg as served, patches } from "./fixtures/thread-read-shell.js";
import { stubThreadLayout } from "./fixtures/thread-layout.js";
import { cursorRow, ohboxRow, openLetter, pickedCount } from "./ohbox/_finders.js";

/**
 * THE ARROW-KEY SPATIAL MODEL — rail ← list → open message (`@ohmail/app-logic/keys/zone-nav`). Asserted:
 * ↓/↑ are j/k (same walk, same entry moves); flicking through five messages marks NOTHING, and staying on one is a
 * preview that marks nothing (mutant: marking on the spot); ← moves focus into the rail and →/Escape return; → from
 * the list lands on the reading column as ENTERING it, which saves the read once the dwell is done; ↑/↓ inside the
 * column scroll it; text fields are never touched.
 *
 * RE-POINTED (share ohbox-1, the switch's older tests): the cases mounted today's Ohbox view alone beside a hand-made
 * `.rail` and, for the sheet, a hand-made `.reader`; they now walk THE NEW SHELL's own door
 * (`fixtures/thread-read-shell.ts`'s `mountThread`: the web's shell over a live engine, five letters from a consented
 * sender, each its own conversation, the read wire recorded): the seated Ohbox, the frame's own rail (its landmark
 * "Places"; the entry of the place on screen by `aria-current`, which is no longer the rail's first button: Write is),
 * and, for the sheet, the letter the frame stands over the list where one column stands (390 wide, opened by its
 * address as a link or Back opens it, so the keys are left on the page). Every expectation is as it stood; where a
 * case reads a part by another name, it says so where it stands.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* THE RENDERS COUNTED (the focus case): the seated Ohbox's list (the view) and the frame's rail (a part of the shell
   that reads the key registry: Write's key hint), each wrapped where it is made. */
let viewRenders = 0;
let shellRenders = 0;
vi.mock("../../../packages/app/src/ohbox/OhboxList.js", async (original) => {
  const m = await original<typeof import("../../../packages/app/src/ohbox/OhboxList.js")>();
  const OhboxList = (p: Parameters<typeof m.OhboxList>[0]) => {
    viewRenders++;
    return m.OhboxList(p);
  };
  return { ...m, OhboxList };
});
vi.mock("../../../packages/app/src/frame/RailHost.js", async (original) => {
  const m = await original<typeof import("../../../packages/app/src/frame/RailHost.js")>();
  const SideRail = (p: Parameters<typeof m.SideRail>[0]) => {
    shellRenders++;
    return m.SideRail(p);
  };
  return { ...m, SideRail };
});

/**
 * The window: 1440 wide (the list and the reading column side by side, the rail at the side), or `mobile`: 390 (one
 * column, the rail at the foot as the dock; the whole rail is put up over the app by More or a step toward it).
 */
function setViewport(mobile = false): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: mobile ? 390 : 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"), media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean }

let host: HTMLElement | null = null;
/** Every read-state write the wire carried, in the old seam's shape: the ids, `unread`, `glance` where nobody pressed. */
const markSeen = (): Array<[string[], boolean, string | undefined]> => patches.map((p) => [p.ids, p.unread, p.via]);

/** The rows served newest first, in the order given; each letter its own conversation. */
async function render(rows: Row[]): Promise<void> {
  const page = rows.map((r, i) => served(r.id, 50 - i, { threadId: `t-${r.id}`, subject: `subj-${r.id}`, unread: r.unread }));
  host = await mountThread(page);
  viewRenders = 0;
  shellRenders = 0;
}

const key = async (k: string, target: EventTarget = document): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await tick(20);
};

/** A while passes on the fake clock, in steps a browser's frames would take. */
const wait = async (ms: number): Promise<void> => {
  for (let left = ms; left > 0; left -= 100) await tick(Math.min(100, left));
};

/** The row the keys are on: the list's cursor row, else the open row. */
const cursor = (): string | null => cursorRow(host!)?.dataset.id ?? null;

const focused = (): Element | null => document.activeElement;
const focusedId = (): string | null => (focused() as HTMLElement | null)?.getAttribute?.("data-id") ?? null;

/** The frame's rail at the side: its landmark, and the buttons the walk steps through. */
const theRail = (): HTMLElement | null => document.querySelector<HTMLElement>('nav[aria-label="Places"]');
const railButtons = (): HTMLElement[] => [...(theRail()?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
/** The rail's entry for the place on screen. */
const railCurrent = (): HTMLElement | null => theRail()?.querySelector<HTMLElement>('[aria-current="page"]') ?? null;
/** The whole rail put up over the app (More's sheet). */
const railUp = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"][aria-label="More"]');
/** Do the keys stand in a rail: the one at the side, or the one put up? */
const inRail = (): boolean => {
  const el = focused();
  if (!(el instanceof HTMLElement)) return false;
  return theRail()?.contains(el) === true || railUp()?.contains(el) === true;
};

/** The open letter's reading box: where → lands, what ↑/↓ scroll (the reading sheet's scrolling box). */
const readingBox = (): HTMLElement | null => openLetter(host!)?.querySelector<HTMLElement>("[data-reading-scroll]") ?? null;
/** The letter the frame stands over the list where one column stands: its reading sheet. */
const letterOver = (): HTMLElement | null => host!.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const scrollerOver = (): HTMLElement | null => letterOver()?.querySelector<HTMLElement>("[data-reading-scroll]") ?? null;

/** A letter opened by its address (a link, Back): the keys are left on the page. */
const openByAddress = async (id: string): Promise<void> => {
  await act(async () => {
    window.location.hash = `#/ohbox/m/${id}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await wait(100);
};

beforeEach(() => {
  installShellEnv();
});

afterEach(async () => {
  await teardownShellEnv();
  host = null;
});

const FIVE: Row[] = [
  { id: "m1", unread: true },
  { id: "m2", unread: true },
  { id: "m3", unread: true },
  { id: "m4", unread: true },
  { id: "m5", unread: true },
];

describe("↓/↑ in the list are j/k", () => {
  it("↓ enters at the top and walks; ↑ walks back; ↑ with no cursor enters at the bottom", async () => {
    setViewport();
    await render(FIVE);
    expect(cursor()).toBeNull();

    await key("ArrowDown");
    expect(cursor(), "↓ did not enter the list at the top, the way j does").toBe("m1");
    await key("ArrowDown");
    expect(cursor()).toBe("m2");
    await key("ArrowUp");
    expect(cursor(), "↑ did not return to the row ↓ left — the pair is not an inverse").toBe("m1");
    await key("ArrowUp");
    expect(cursor(), "↑ at the top lost or wrapped the cursor").toBe("m1");
  });

  it("↑ enters from the bottom on a list nobody has entered — k's own entry move", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowUp");
    expect(cursor()).toBe("m5");
  });

  it("arrows and letters interleave over one cursor — one walk, four keycaps", async () => {
    setViewport();
    await render(FIVE);
    await key("j");
    await key("ArrowDown");
    await key("j");
    expect(cursor()).toBe("m3");
    await key("ArrowUp");
    await key("k");
    expect(cursor()).toBe("m1");
  });
});

describe("the read-marking guard on arrow navigation", () => {
  it("a flick through five messages marks NOTHING", async () => {
    setViewport();
    await render(FIVE);

    for (let i = 0; i < 5; i++) {
      await key("ArrowDown");
      // Well under the dwell, well over an instant: a real flick's cadence.
      await wait(300);
    }
    expect(cursor()).toBe("m5");
    expect(markSeen(), "arrowing through the list wrote read state — the dwell guard is gone")
      .toEqual([]);
  });

  it("staying on a row is a preview: nothing is marked, however long", async () => {
    setViewport();
    await render(FIVE);

    await key("ArrowDown");
    expect(cursor()).toBe("m1");
    // Base: the 2 s dwell read m1 here. A preview reads nothing.
    await wait(10_000);
    expect(markSeen(), "a preview wrote read state").toEqual([]);

    await key("ArrowDown");
    expect(markSeen()).toEqual([]);

    await wait(3000);
    await key("ArrowDown");
    expect(markSeen()).toEqual([]);
  });
});

describe("where one column stands, → is the deliberate open", () => {
  it("→ on the list's cursor row opens its letter over the list, as Enter does", async () => {
    // NEW (share ohbox-1): the holder of the retired census over today's stylesheet ("the app.css hide rule names
    // every split view's column"): that rule hid today's reading column at phone widths so that → took the views'
    // deliberate open; the new frame draws no reading column where one column stands, and → opens the letter.
    setViewport(true);
    await render(FIVE);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");
    expect(letterOver(), "fixture: nothing is open before →").toBeNull();

    await key("ArrowRight");
    expect(window.location.hash, "→ at one column did not open the cursor row's letter").toBe("#/ohbox/m/m1");
    expect(letterOver(), "→ at one column opened no letter over the list").not.toBeNull();
  });
});

describe("claimed arrows stop the sibling document listener", () => {
  it("ProviderPicker calls stopImmediatePropagation on the native event for every key it acts on", async () => {
    // A review finding: in the deployed App Router, React and the keymap registry are
    // sibling keydown listeners on `document`, and `stopPropagation` cannot stop a sibling —
    // MoreMenu measured this and `action-bar.test.ts` watches its CALL, because a test DOM
    // mounts React into a <div> where plain stopPropagation genuinely works. The same watch,
    // for the picker the zone walk collided with.
    const { ProviderPicker } = await import("../app/shell/ProviderPicker.js");
    const box = document.createElement("div");
    document.body.appendChild(box);
    const root: Root = createRoot(box);
    await act(async () => {
      root.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC",
          children: h(ProviderPicker as never, { value: null, onChange: () => {} } as never),
        }),
      );
    });
    const tile = box.querySelector<HTMLElement>("button")!;
    tile.focus();
    for (const k of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      let immediate = 0;
      e.stopImmediatePropagation = () => { immediate++; };
      await act(async () => { tile.dispatchEvent(e); });
      expect(immediate, `${k} did not claim the event away from the document listener`).toBe(1);
    }
    await act(async () => { root.unmount(); });
  });
});

describe("the zone walk: rail ← list → open message", () => {
  it("← focuses the rail's active row; ↑/↓ walk the rail; → returns to the selected row", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");

    await key("ArrowLeft");
    const items = railButtons();
    // The rail's active row is the entry of the place on screen (Write stands first in the frame's rail).
    const at = items.indexOf(railCurrent()!);
    expect(at, "fixture: the rail has an entry for the place on screen, with a row on either side").toBeGreaterThan(0);
    expect(at).toBeLessThan(items.length - 1);
    expect(focused(), "← did not land on the rail's active row").toBe(items[at]);

    await key("ArrowDown");
    expect(focused(), "↓ in the rail did not move to the next row").toBe(items[at + 1]);
    await key("ArrowUp");
    expect(focused()).toBe(items[at]);
    await key("ArrowUp");
    expect(focused()).toBe(items[at - 1]);
    await key("ArrowDown");
    expect(focused()).toBe(items[at]);

    await key("ArrowRight");
    expect(inRail(), "→ from the rail left focus in the rail").toBe(false);
    expect(focusedId()).toBe("m1");

    // …and the list keys answer again immediately.
    await key("ArrowDown");
    expect(cursor()).toBe("m2");
  });

  it("← with no cursor still reaches the rail, and → releases back to a resting list", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowLeft");
    expect(inRail()).toBe(true);
    await key("ArrowRight");
    // No selected row to land on: focus is released and the list rests, exactly as it
    // rests on arrival — the resting column is the Ohbox's own design, not a failure.
    expect(focused()).toBe(document.body);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");
  });

  it("→ from the list lands on the reading column as ENTERING it: what is on screen is read once the dwell is done", async () => {
    setViewport();
    // The column laid out, so the message's lines are on screen.
    const layout = stubThreadLayout();
    try {
      await render(FIVE);
      await key("ArrowDown");
      // The row's unread mark: `data-unread` on the seated row (today's row said it as `data-unseen`).
      expect(ohboxRow(host!, "m1")!.hasAttribute("data-unread"), "fixture: the row under the cursor must start unread").toBe(true);

      await key("ArrowRight");
      const col = readingBox();
      expect(focused(), "→ did not focus the reading column").toBe(col);
      // The reading column is a labelled region (the open letter's), and its scrolling box takes focus by script only.
      expect(col!.closest('[role="region"]')).toBe(openLetter(host!));
      expect(col!.getAttribute("tabindex")).toBe("-1");
      // Entering starts the dwell on what is on screen, and once its top was there for it the read is saved.
      await tick(40);
      expect(markSeen(), "the write waits for the dwell").toEqual([]);
      await layout.passDwell();
      await tick(20);
      expect(markSeen(), "→ into the message did not read it").toEqual([[["m1"], false, "glance"]]);

      // ← walks back to the list; moving the cursor is a departure, and it writes nothing more.
      await key("ArrowLeft");
      expect(focusedId()).toBe("m1");
      await key("ArrowDown");
      expect(markSeen()).toEqual([[["m1"], false, "glance"]]);
    } finally {
      layout.restore();
    }
  });

  it("↑/↓ inside the reading column scroll it by the named step and move no cursor", async () => {
    setViewport();
    await render(FIVE);
    const { READER_SCROLL_STEP } = await import("@ohmail/app-logic/keys/zone-nav");
    await key("ArrowDown");
    await key("ArrowRight");
    const col = readingBox()!;
    expect(col.scrollTop).toBe(0);

    await key("ArrowDown");
    expect(col.scrollTop, "↓ in the reader did not scroll the column").toBe(READER_SCROLL_STEP);
    expect(cursor(), "↓ in the reader moved the list cursor").toBe("m1");
    await key("ArrowDown");
    expect(col.scrollTop).toBe(2 * READER_SCROLL_STEP);
    await key("ArrowUp");
    expect(col.scrollTop).toBe(READER_SCROLL_STEP);
  });

  it("Escape walks back left: reader → list → rail", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    await key("ArrowRight");
    expect(focused()).toBe(readingBox());

    await key("Escape");
    expect(focusedId()).toBe("m1");

    /* RULED (the switch's point 64): beside the list, the list's Escape closes the open letter in place first, the
       keys staying on its row; the walk on to the rail is the next Escape. */
    await key("Escape");
    expect(openLetter(host!), "Escape in the list closed the open letter beside it").toBeNull();
    expect(focusedId()).toBe("m1");

    await key("Escape");
    expect(inRail(), "Escape in the list did not reach the rail").toBe(true);
  });

  it("focus follows the cursor while a row owns it — Enter can never press the row you left", async () => {
    // → from the rail lands REAL focus on the selected row. If the next ↓ moved only the
    // view's cursor, focus would stand on the old row and Enter — the browser's own button
    // activation — would press a message the reader has visibly left. So while a row owns
    // focus, every cursor move re-lands focus on the cursor row (and announces it, which is
    // the screen-reader walk). With focus on the BODY, the same keys move only the cursor —
    // the mouse-and-letters flow stays untouched, asserted at the end.
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    await key("ArrowLeft");
    await key("ArrowRight");
    expect(focusedId()).toBe("m1");

    await key("ArrowDown");
    expect(cursor()).toBe("m2");
    expect(focusedId(), "the cursor moved and focus stayed on the row it left").toBe("m2");
    await key("j");
    expect(focusedId(), "the letter walk must rove focus exactly as the arrow walk does while a row owns it").toBe("m3");

    // Release focus (body): the virtual-cursor flow — cursor moves, focus does not.
    await act(async () => { (focused() as HTMLElement).blur(); });
    await key("ArrowDown");
    expect(cursor()).toBe("m4");
    expect(focused(), "a body-focused walk must not start grabbing focus").toBe(document.body);
  });

  it("Escape never outranks the view: with picks standing, it clears them from ANY zone", async () => {
    // THE SCOPE RULING, ASSERTED BEHAVIOURALLY. The zone walk registers at `global` scope,
    // so every view-layer Escape wins first — whatever order the layers re-registered in.
    // This drives the exact sequence that re-registers the ZONE layer last: pick, then
    // cross a zone boundary, then press Escape. A zone walk mounted at `view` scope would
    // dispatch "back to the list" here and leave the picked set standing.
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    await key("x");
    expect(pickedCount(host!), "fixture: the pick did not register").not.toBeNull();

    await key("ArrowRight"); // zone boundary: the zone layer re-registers after the pick
    expect(focused()).toBe(readingBox());

    await key("Escape");
    expect(pickedCount(host!), "Escape walked zones over a standing selection").toBeNull();
    expect(focused(), "clearing the picks must not move focus").toBe(readingBox());

    // With nothing nearer left to claim it, the NEXT Escape walks.
    await key("Escape");
    expect(focusedId()).toBe("m1");
  });

  it("an open reader sheet IS the reader zone — scrolled by ↑/↓ from wherever focus was left", async () => {
    // A review finding: with the sheet up, ↑/↓ walked the hidden cursor behind the modal.
    // The sheet's existence decides the zone even if focus has fallen back to the page.
    // ↑/↓ scroll the sheet, the list cursor stands still, and ← cannot land focus on a
    // row or the rail behind the modal.
    // The sheet: the letter the frame stands over the list where one column stands, opened by its address.
    setViewport(true);
    await render(FIVE);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");
    await openByAddress("m1");
    const sheet = scrollerOver()!;
    expect(sheet, "fixture: the letter stands over the list").not.toBeNull();
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    expect(focused(), "fixture: focus has returned to the page").toBe(document.body);

    const { READER_SCROLL_STEP } = await import("@ohmail/app-logic/keys/zone-nav");
    await key("ArrowDown");
    expect(sheet.scrollTop, "↓ did not scroll the visible sheet — focus never entered it, and must not have to")
      .toBe(READER_SCROLL_STEP);
    expect(cursor(), "↓ moved the list cursor behind the open reader").toBe("m1");

    await key("ArrowLeft");
    expect(inRail(), "← reached the rail behind the open reader").toBe(false);
    expect((focused() as HTMLElement | null)?.matches?.('[role="option"]'),
      "← landed focus on a list row behind the open reader").toBeFalsy();

    // Focus INSIDE the sheet scrolls it exactly the same — one zone, however it was entered.
    await act(async () => { sheet.focus(); });
    await key("ArrowDown");
    expect(sheet.scrollTop).toBe(2 * READER_SCROLL_STEP);
  });

  it("a field buried UNDER the sheet does not silence it; a field INSIDE it does", async () => {
    // A review finding: a keyboard search opens a hit in place while the search box keeps
    // focus — the typing target is buried under the sheet, and a scroll pair that defers to
    // every typing target left the visible reader unscrollable. The pair claims ↑/↓ exactly
    // when the field is under the sheet, and yields to a field inside it (an editor in the
    // open message keeps its native caret).
    setViewport(true);
    await render(FIVE);
    await openByAddress("m1");
    const sheet = scrollerOver()!;
    const buried = document.createElement("input");
    host!.prepend(buried);
    await act(async () => { buried.focus(); });

    const { READER_SCROLL_STEP } = await import("@ohmail/app-logic/keys/zone-nav");
    await key("ArrowDown", buried);
    expect(sheet.scrollTop, "↓ from a field buried under the sheet did not scroll the sheet")
      .toBe(READER_SCROLL_STEP);
    expect(focused(), "the buried field lost focus").toBe(buried);

    const inside = document.createElement("input");
    sheet.appendChild(inside);
    await act(async () => { inside.focus(); });
    await key("ArrowDown", inside);
    expect(sheet.scrollTop, "↓ inside the sheet's own editor must stay the caret's")
      .toBe(READER_SCROLL_STEP);

    inside.remove(); buried.remove();
  });

  it("a dialog layered above the sheet owns its own arrows — the walk stands down whole", async () => {
    // A review finding: a screening panel over the open reader focuses its own controls;
    // the sheet must not swallow ↑/↓ and scroll itself, obscured, underneath. Document order
    // is the layering truth — the shell renders every higher surface AFTER the reader — so
    // focus in a node the sheet precedes suspends every zone key.
    setViewport(true);
    await render(FIVE);
    await key("ArrowDown");
    expect(cursor()).toBe("m1");
    await openByAddress("m1");
    const sheet = scrollerOver()!;
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog"); // every genuine higher surface carries the role
    panel.setAttribute("aria-label", "A panel");
    panel.innerHTML = '<button type="button">close</button>';
    document.body.appendChild(panel); // AFTER the sheet — layered above, as the shell renders
    await act(async () => { panel.querySelector("button")!.focus(); });

    await key("ArrowDown");
    expect(sheet.scrollTop, "↓ scrolled the sheet obscured under a higher dialog").toBe(0);
    expect(cursor(), "↓ walked the list buried under two layers").toBe("m1");
    await key("ArrowLeft");
    expect(inRail(), "← left a dialog for the rail behind everything").toBe(false);

    panel.remove();
  });

  it("an invisible follower that is NOT a layer cannot silence the reader", async () => {
    // A review finding: the expired Undo toast keeps a focusable button mounted after the
    // whole shell, at opacity 0 (`role="status"`). Tab landing on it while the reader stands
    // must leave the reader's keys working: a follower suspends the walk only when it IS a
    // layer — a dialog or menu, by role — never merely because it comes later in the document.
    setViewport(true);
    await render(FIVE);
    await openByAddress("m1");
    const sheet = scrollerOver()!;
    const toast = document.createElement("div");
    toast.setAttribute("role", "status");
    toast.innerHTML = '<button type="button">Undo</button>';
    document.body.appendChild(toast); // after the sheet, exactly as a report's live region stands
    await act(async () => { toast.querySelector("button")!.focus(); });

    const { READER_SCROLL_STEP } = await import("@ohmail/app-logic/keys/zone-nav");
    await key("ArrowDown", toast.querySelector("button")!);
    expect(sheet.scrollTop, "an invisible toast button silenced the visible reader")
      .toBe(READER_SCROLL_STEP);

    toast.remove();
  });

  it("focus crossing rail, list and reader re-renders neither the view nor a shell reading the registry", async () => {
    setViewport();
    await render(FIVE);
    await key("ArrowDown");
    // The shell's part that reads the registry: the rail, which says Write's key from it.
    expect(railButtons()[0]?.getAttribute("aria-keyshortcuts"), "fixture: the shell reads a live key").toBe("c");
    const row = ohboxRow(host!, "m1")!;
    const col = readingBox()!;
    const items = railButtons();
    const at = items.indexOf(railCurrent()!);
    const { READER_SCROLL_STEP } = await import("@ohmail/app-logic/keys/zone-nav");
    viewRenders = 0;
    shellRenders = 0;

    await act(async () => { items[at]!.focus(); });
    await key("ArrowDown");
    expect(focused(), "the rail keys did not follow a focus the view never rendered for").toBe(items[at + 1]);
    await act(async () => { row.focus(); });
    await act(async () => { col.focus(); });
    await act(async () => { row.focus(); });
    await act(async () => { col.focus(); });
    expect(viewRenders, "a focus move re-rendered the whole view").toBe(0);
    expect(shellRenders, "a focus move re-rendered the shell's registry reader").toBe(0);
    await key("ArrowDown");
    expect(col.scrollTop, "the reader keys did not follow").toBe(READER_SCROLL_STEP);
    expect(cursor()).toBe("m1");
  });

  it("every zone key is inert while a text field owns focus", async () => {
    setViewport();
    await render(FIVE);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(focused()).toBe(input);

    await key("ArrowLeft", input);
    expect(focused(), "← stole focus from a text field").toBe(input);
    await key("ArrowDown", input);
    expect(cursor(), "↓ moved the list cursor from inside a text field").toBeNull();
    await key("Escape", input);
    expect(focused(), "Escape moved focus out of a text field").toBe(input);
    input.remove();
  });
});
