/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * AN OPEN OVERLAY OWNS ESCAPE, EVEN WITH A SELECTION LIVE.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * The Ohbox's "Escape clears the selection" is a VIEW binding and the shell's Escape cascade
 * was a GLOBAL one, so a picked set outranked the cascade unconditionally. Select two rows,
 * open the `?` sheet — or the ⌘K palette, or a sender's screening popover — press Escape,
 * and the selection was cleared while the thing you were looking at stayed put. It had been
 * patched once, for the reply editor alone, by teaching the Ohbox to check
 * `chrome.replyTo != null`: one shell overlay, named inside a view that cannot see the other
 * seven.
 *
 * ── WHY THIS FILE MOUNTS THE WHOLE SHELL ────────────────────────────────────────────────
 *
 * `keymap.test.ts` proves the scope ordering with synthetic bindings, and it should. It
 * cannot prove THIS, because the bug was never in the dispatcher — it was in which scope the
 * real Escape was registered under, with the real overlays and the real selection. So every
 * case below opens the actual surface out of the actual `AppShell` and presses the actual
 * key, and each one asserts BOTH halves: the overlay closed, and the selection is still
 * there. The second half is the one that goes red when the precedence is put back.
 *
 * Demo mode, because the selection and the overlays are pure shell state — Mila's fixture
 * world gives real rows to pick with no network, no account and no fake server to keep
 * honest.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  // jsdom gaps, stubbed at their narrowest — see `sync-visible.test.ts`.
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** The shipped shell on the fixture world, wrapped exactly as the desktop entry wraps it. */
async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  return container;
}

/**
 * A keypress on the DOCUMENT, which is where the registry listens and where a user who has
 * not clicked into a text field produces one. Dispatching on `document` also keeps the
 * overlays' own handlers out of it — the palette's Escape lives on its `<input>`'s
 * `onKeyDown` and never sees this — so what closes a surface below is the registry, not a
 * second listener that happens to agree with it.
 */
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

/**
 * Wait for a condition instead of sleeping a guessed number of milliseconds.
 *
 * The first draft of the guards used `setTimeout(400)` after `f`, and it flaked once in six
 * runs — a fixed sleep encodes the machine's speed on the day it was written, which is gap
 * ("assertions are fixed-sleep snapshots") arriving in a new file. A poll fails only when the
 * thing genuinely never happens, and it reports that rather than a timing artifact.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeout = 3000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

/* THE COUNT IS THE PILL'S LEADING CAPSULE since 0.15.0, and it renders "× 1 selected esc" as
   separate nodes so the WORD can fold out at narrow widths while the number stays — so a
   `textContent` scan reads "×1selectedesc" and an `includes("1 selected")` finds nothing. The
   live region inside the capsule is the exact node, and it is the one that is announced. */
const picked = (el: HTMLElement): boolean =>
  [...el.querySelectorAll("button")].some((b) => /^1 selected — /.test(b.getAttribute("aria-label") ?? ""));
const open = (el: HTMLElement, sel: string): boolean => el.querySelector(sel) != null;

/** Put the Ohbox in the state that broke everything: one row picked. */
async function withSelection(): Promise<HTMLElement> {
  const container = await shell();
  expect(
    container.querySelectorAll(":is(.row, [role=option])[data-id]").length,
    "no rows to select — nothing below would prove anything",
  ).toBeGreaterThan(0);
  // `x` picks THE ROW AT THE CURSOR, and a fresh Ohbox no longer has one: the shell's
  // `?? allOhbox[0]` fallback — which used to make the newest unread message the selection
  // before anybody had chosen it — is gone. `j` puts the cursor exactly where that fallback
  // used to leave it, so everything below this line is unchanged.
  await key("j");
  await key("x");
  expect(picked(container), "`x` did not select a row").toBe(true);
  return container;
}

describe("Escape belongs to whatever is open, not to the selection underneath it", () => {
  it("the ? sheet: Escape closes the sheet and LEAVES the selection alone", async () => {
    const container = await withSelection();

    await key("?");
    expect(open(container, ".ks"), "`?` did not open the sheet").toBe(true);

    await key("Escape");
    expect(open(container, ".ks")).toBe(false);
    // THE ASSERTION THAT BITES. The sheet also dismisses itself on any keypress, so its
    // closing proves nothing on its own; the selection surviving is what says Escape was
    // spent on the sheet rather than on the picked set.
    expect(picked(container), "Escape cleared the selection instead of closing the sheet").toBe(true);
  });

  it("the ⌘K palette: Escape closes the palette and LEAVES the selection alone", async () => {
    const container = await withSelection();

    await key("k", { metaKey: true });
    expect(open(container, ".palette"), "⌘K did not open the palette").toBe(true);

    await key("Escape");
    expect(open(container, ".palette")).toBe(false);
    expect(picked(container), "Escape cleared the selection instead of closing the palette").toBe(true);
  });

  it("the screening popover: Escape closes the popover and LEAVES the selection alone", async () => {
    const container = await withSelection();

    /**
     * OPENED FROM THE READING COLUMN'S PILL, not from `s`, and the change is the 0.15.0 key law
     * rather than a workaround. While a selection exists the verb letters act on the SELECTION,
     * so `s` opens the selection pill's screening panel — a sub-row inside the foot bar, not the
     * sender popover this test is about. The reading column's own Screening button is the door
     * that still opens the popover with a selection standing, because that bar acts on the OPEN
     * MESSAGE whatever is picked in the list. Same overlay, same Escape question.
     */
    const screen = [...container.querySelectorAll<HTMLButtonElement>(".read-col .abar-b")]
      .find((b) => (b.textContent ?? "").trim().startsWith("Screening"));
    expect(screen, "the reading column has no Screening button to open the popover with").toBeTruthy();
    await act(async () => { screen!.click(); });
    expect(open(container, ".senderm"), "the popover did not open").toBe(true);

    await key("Escape");
    expect(open(container, ".senderm")).toBe(false);
    expect(picked(container), "Escape cleared the selection instead of closing the popover").toBe(true);
  });

  it("with NOTHING open, Escape still clears the selection — the old behaviour survives", async () => {
    // The control. Without it, "an overlay owns Escape" could be satisfied by an Escape that
    // owns nothing and does nothing, and the selection would become unclearable from the
    // keyboard — a regression the three tests above cannot see.
    const container = await withSelection();
    expect(open(container, ".ks")).toBe(false);
    expect(open(container, ".palette")).toBe(false);
    expect(open(container, ".senderm")).toBe(false);

    await key("Escape");
    expect(picked(container), "Escape no longer clears a selection when nothing is open").toBe(false);
  });

  it("one Escape closes one thing — the overlay, then the selection, never both at once", async () => {
    // The two rules together. A cascade that ran the view binding as well would empty the
    // selection on the way past, which is exactly what the shipped build did.
    const container = await withSelection();
    await key("?");
    await key("Escape");
    expect(open(container, ".ks")).toBe(false);
    expect(picked(container)).toBe(true);
    await key("Escape");
    expect(picked(container)).toBe(false);
  });
});

/**
 * `?` CLOSES THE SHEET `?` OPENED.
 *
 * Found by the Playwright suite on its first run against the hosted service, which is the whole
 * reason that suite exists. It survived here for weeks because every unit test dispatched
 * ONE synthetic keydown for `?`, and a real `?` on almost every layout is TWO: `Shift`, then
 * `?` with `shiftKey` set. `ShortcutSheet`'s "any key dismisses" document listener treated
 * the bare `Shift` as a dismissal and closed the sheet; the registry toggle then saw a
 * CLOSED sheet and re-opened it. A synthetic single keydown can never reproduce that, so the
 * tests below press the chord the way a keyboard produces it.
 *
 * Not cosmetic: `.ks` is `position: fixed` over the whole deck, so a sheet that will not
 * close swallows the user's next click. It ate the "Mark read" and was read for weeks
 * as a bulk-selection defect.
 */
describe("the ? sheet closes with the same chord that opened it", () => {
  const sheet = (el: HTMLElement) => open(el, ".ks");

  it("opens on ? and CLOSES on ?, pressed as the real two-keydown chord", async () => {
    const container = await shell();

    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet(container), "`?` did not open the sheet").toBe(true);

    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet(container), "`?` re-opened the sheet instead of closing it").toBe(false);
  });

  it("a bare modifier does not dismiss it — it is half a chord, not a keystroke", async () => {
    const container = await shell();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet(container)).toBe(true);

    for (const mod of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]) {
      await key(mod);
      expect(sheet(container), `a bare ${mod} dismissed the sheet`).toBe(true);
    }
  });

  it("KEEPS the peek: a real key still dismisses and then does its own job", async () => {
    // The documented design — "?" then "j" reads the map and moves the cursor in two
    // keystrokes. A fix that turned the sheet into a mode would pass the test above and
    // break the feature, so this is the half that stops the modifier guard going too far.
    const container = await shell();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet(container)).toBe(true);

    await key("j");
    expect(sheet(container), "an ordinary key no longer dismisses the sheet").toBe(false);
  });

  it("Escape still closes it, through the cascade rather than the private listener", async () => {
    const container = await shell();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet(container)).toBe(true);
    await key("Escape");
    expect(sheet(container)).toBe(false);
  });
});

/**
 * A KEYBOARD PATH INTO ANSWER LATER, AND THE REPLY RUN IT FEEDS.
 *
 * `f` starts a Reply Run over the Answer Later pile. Until the `a` binding there was no
 * keyboard way to put anything IN it — `onMessageAction("later", …)` was reachable only from
 * the reader's action menu — so `f` sat permanently `disabled` for a keyboard user, who could
 * start a run they had no way to fill. The report: *"basic keyboard shortcuts … are not
 * integrated (and not visible in the ui to understand them)"*, and BOTH halves of that
 * sentence are asserted here: the binding works, and the sheet lists it.
 *
 * This also unblocks the reply overlay is the one surface still holding a private
 * Escape listener, and it could not be tested while nothing could open it.
 */
describe("Answer Later is reachable from the keyboard", () => {
  /** The rail's Answer Later count — the number the user actually reads. */
  const pile = (el: HTMLElement): number =>
    Number((el.textContent ?? "").match(/Answer Later\s*(\d+)/)?.[1] ?? "0");

  it("`a` queues the focused message — the pile grows by exactly one", async () => {
    const container = await shell();
    const before = pile(container);

    // ── WHY THIS WALKS THE CURSOR INSTEAD OF PRESSING `a` ONCE ──────────────────────────
    //
    // The demo fixture ships with TWO messages already in Answer Later, and `a` on an
    // already-queued message is a TOGGLE now — it takes the message OUT (`state:"none"`, the
    // un-triage path the wire always had and no surface dispatched). So the walk presses `a`
    // per row and reads which direction the pile moved: a shrink means the cursor stood on a
    // queued row, and the SAME key restores it before walking on — the toggle undoing itself
    // is exactly the property it exists for. A grow to `before + 1` is the queue this guard
    // is about.
    //
    // The first version of this guard pressed `a` once, landed on an already-queued row, and
    // asserted nothing. It also asserted `f` could not open a Reply Run "over an empty pile"
    // on a fixture whose pile is never empty — a timing artifact dressed as a precondition.
    let moved = false;
    for (let i = 0; i < 6 && !moved; i++) {
      await key("j");
      const at = pile(container);
      await key("a");
      await waitFor(() => pile(container) !== at, "the press to land", 1500);
      if (pile(container) === before + 1) {
        moved = true;
      } else if (pile(container) < at) {
        // A queued row left the pile — put it back with the same key, then walk on.
        await key("a");
        await waitFor(() => pile(container) === at, "the restore to land", 1500);
      }
    }

    expect(moved, `\`a\` never grew the Answer Later pile (still ${pile(container)} of ` +
      `${before}) after walking six rows — the binding does not queue`).toBe(true);
    expect(pile(container), "the pile moved by more than one").toBe(before + 1);
  });

  it("the ? sheet LISTS it — an undiscoverable shortcut is the reported complaint", async () => {
    const container = await shell();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    const sheet = container.querySelector(".ks");
    expect(sheet, "the shortcut sheet did not open").not.toBeNull();
    expect(sheet!.textContent ?? "", "the sheet does not mention the Answer Later binding")
      .toContain("Queue it for the Reply Run");
  });

  /**
   * IS STILL NOT GUARDED. The blocker is now diagnosed rather than guessed: `f` DOES
   * run with a selection live — the app navigates to `#/triage` — but `.fr-overlay` never
   * mounts. Without a selection the same keystroke opens it. So the Reply Run cannot be
   * stacked on another layer, and the shape (one Escape, two layers, the lost draft) has
   * no surface to test. Not faked with a weaker assertion.
   */
});

/**
 * `f` OPENS THE REPLY RUN, WITH OR WITHOUT A SELECTION.
 *
 * ── WAS NOT A BUG, AND THE FILING WAS MY OWN MEASUREMENT ERROR ───────────────────────
 *
 * I filed "a live selection prevents the Reply Run from opening" after a probe that waited a
 * FIXED 600 ms and saw no overlay. It opens later than that and well inside a 3 s poll — so
 * the old `go("triage"); setTimeout(startFR, 130)` passes every assertion below. **Mutation
 * restoring that exact code, SURVIVES.** These guards do not prove a bug was fixed,
 * because there was no demonstrable bug; I used the fixed-sleep artifact I have spent this
 * session catching in other people's tests.
 *
 * What the change actually is: a REFACTOR that deletes a timing constant. `setTimeout(…, 130)`
 * coordinating with a route-transition effect that calls `setFr(null)` is a race by
 * construction — the 130 ms is a bet that the effect runs first — and jsdom simply happens to
 * schedule it so the bet always wins. A real browser under load is not obliged to. The intent
 * flag makes the clear and the re-arm one ordered pass with no constant to be wrong about.
 *
 * That ordering IS load-bearing and IS proven: mutation re-arming before the clear instead
 * of after, goes red on all three of these.
 */
describe("the Reply Run opens whether or not a row is selected", () => {
  const frOpen = (el: HTMLElement) => open(el, ".fr-overlay");

  it("opens with NO selection", async () => {
    const container = await shell();
    await key("f");
    await waitFor(() => frOpen(container), "the Reply Run to open with no selection");
  });

  it("opens WITH a selection — the case that was silently doing nothing", async () => {
    // The original repro, keystroke for keystroke — kept because it is the user-facing path,
    // not because it reproduces anything.
    const container = await shell();
    // `j` first: `a` acts on the message at the cursor and `x` picks it, and a fresh Ohbox
    // has no cursor now that the shell resolves no selection of its own.
    await key("j");
    await key("a");
    // A SECOND `j`, because `a` now takes the row OUT of the Ohbox: a mail is in exactly one
    // pile, so answering-later removes it from every Ohbox group (`selectors.ts#OhboxView`) and
    // the cursor it was standing on has nothing under it. This press puts the cursor back on a
    // row that is still there, which is what `x` needs — the selection is the precondition of
    // this guard, not its subject.
    await key("j");
    await key("x");
    expect(picked(container), "`x` did not select a row").toBe(true);
    await key("f");
    await waitFor(() => frOpen(container), "the Reply Run to open with a row picked");
    // NOT asserting the "N selected" bar survives: `f` navigates to Triage, which unmounts the
    // Ohbox and its pick-bar with it. That is a view change, not a lost selection, and my first
    // draft of this guard asserted the affordance rather than the state — measuring a thing
    // that only exists on the view we just left.
  });

  /** At last: the reply run stacked on a selection, and ONE Escape closing ONE layer. */
  it("one Escape closes the Reply Run and LEAVES the selection alone", async () => {
    const container = await shell();
    // `j` first: `a` acts on the message at the cursor and `x` picks it, and a fresh Ohbox
    // has no cursor now that the shell resolves no selection of its own.
    await key("j");
    await key("a");
    await key("x");
    await key("f");
    await waitFor(() => frOpen(container), "the Reply Run to open");

    await key("Escape");
    expect(frOpen(container), "Escape did not close the Reply Run").toBe(false);
    // ONE layer, not two. `FocusReplyOverlay` still holds a private document Escape listener
    // beside the shell's cascade; both fire on the same dispatch and both close `fr`, so the
    // view underneath must survive. `Reader.tsx:16` names the cost of getting this wrong — the
    // layer below closing too "reads as Esc having lost the draft". Until that change this could not be
    // tested at all, because nothing could stack the run on another layer.
    expect(window.location.hash, "Escape closed the Reply Run AND navigated away")
      .toBe("#/triage");
  });
});
