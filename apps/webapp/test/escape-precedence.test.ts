/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { cursorRow } from "./ohbox/_finders.js";

/** The mounted shell's Escape precedence, shortcut sheet, and Answer Later keyboard path. */
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
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
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
async function shell(hash = "#/ohbox"): Promise<HTMLElement> {
  window.location.hash = hash;
  const { MailShell } = await import("./_mail-shell.js");
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
          children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
        }),
      }),
    );
  });
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
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
const dialog = (name: string) => screen.queryByRole("dialog", { name });
const sheet = () => dialog("Keyboard shortcuts");
const palette = () => dialog("Command palette");
const screening = (el: HTMLElement) => el.querySelector(".senderm");
const runOpen = (el: HTMLElement) =>
  [...el.querySelectorAll('[role="status"]')].some((status) => /^\d+ of \d+$/.test(status.textContent ?? ""));

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
    expect(sheet() !== null, "`?` did not open the sheet").toBe(true);

    await key("Escape");
    expect(sheet() !== null).toBe(false);
    // THE ASSERTION THAT BITES. The sheet also dismisses itself on any keypress, so its
    // closing proves nothing on its own; the selection surviving is what says Escape was
    // spent on the sheet rather than on the picked set.
    expect(picked(container), "Escape cleared the selection instead of closing the sheet").toBe(true);
  });

  it("the command palette: Escape closes the palette and LEAVES the selection alone", async () => {
    const container = await withSelection();

    await key("k", { ctrlKey: true });
    expect(palette() !== null, "the command palette did not open").toBe(true);

    await key("Escape");
    expect(palette() !== null).toBe(false);
    expect(picked(container), "Escape cleared the selection instead of closing the palette").toBe(true);
  });

  it("the screening popover: Escape closes the popover and LEAVES the selection alone", async () => {
    const container = await withSelection();

    const reading = within(screen.getByRole("region", { name: "Open message" }));
    const opener = reading.getByRole("button", { name: messages.screening.action });
    await act(async () => { opener.click(); });
    const popover = screen.getByRole("dialog", { name: /^Options for / });
    expect(within(popover).getByRole("radiogroup", { name: messages.screening.sectionWhere })).toBeTruthy();
    expect(popover.getAttribute("aria-modal")).toBe("true");
    expect(popover.contains(document.activeElement)).toBe(true);
    expect(opener.getAttribute("aria-controls")).toBe(popover.id);
    expect(opener.getAttribute("aria-expanded")).toBe("true");

    await key("Escape");
    expect(screen.queryByRole("dialog", { name: /^Options for / })).toBeNull();
    expect(picked(container), "Escape cleared the selection instead of closing the popover").toBe(true);
  });

  it("with NOTHING open, Escape still clears the selection — the old behaviour survives", async () => {
    // The control. Without it, "an overlay owns Escape" could be satisfied by an Escape that
    // owns nothing and does nothing, and the selection would become unclearable from the
    // keyboard — a regression the three tests above cannot see.
    const container = await withSelection();
    expect(sheet() !== null).toBe(false);
    expect(palette() !== null).toBe(false);
    expect(screening(container) !== null).toBe(false);

    await key("Escape");
    expect(picked(container), "Escape no longer clears a selection when nothing is open").toBe(false);
  });

  it("one Escape closes one thing — the overlay, then the selection, never both at once", async () => {
    // The two rules together. A cascade that ran the view binding as well would empty the
    // selection on the way past, which is exactly what the shipped build did.
    const container = await withSelection();
    await key("?");
    expect(sheet()).not.toBeNull();
    await key("Escape");
    expect(sheet() !== null).toBe(false);
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

  it("opens on ? and CLOSES on ?, pressed as the real two-keydown chord", async () => {
    await shell();

    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet() !== null, "`?` did not open the sheet").toBe(true);

    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet() !== null, "`?` re-opened the sheet instead of closing it").toBe(false);
  });

  it("a bare modifier does not dismiss it — it is half a chord, not a keystroke", async () => {
    await shell();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet() !== null).toBe(true);

    for (const mod of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]) {
      await key(mod);
      expect(sheet() !== null, `a bare ${mod} dismissed the sheet`).toBe(true);
    }
  });

  it("a dismissing letter leaves the cursor in place until pressed again", async () => {
    const container = await shell();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet() !== null).toBe(true);

    const before = cursorRow(container);
    await key("j");
    expect(sheet(), "an ordinary key dismisses the sheet").toBeNull();
    expect(cursorRow(container)).toBe(before);
    await key("j");
    expect(cursorRow(container)).not.toBe(before);
  });

  it("Escape still closes it, through the cascade rather than the private listener", async () => {
    await shell();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    expect(sheet() !== null).toBe(true);
    await key("Escape");
    expect(sheet() !== null).toBe(false);
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
    Number(el.querySelector('[data-rail-id="later"] button')?.getAttribute("aria-label")?.match(/^Answer Later (\d+)$/)?.[1] ?? "0");

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
    // The shortcut sheet lists bindings that are live where it opened.
    await key("j");
    expect(cursorRow(container)).not.toBeNull();
    await key("Shift", { shiftKey: true });
    await key("?", { shiftKey: true });
    const shown = sheet();
    expect(shown, "the shortcut sheet did not open").not.toBeNull();
    expect(shown!.textContent ?? "", "the sheet does not mention the Answer Later binding")
      .toContain("Queue it for the Reply Run");
  });
});

describe("the Reply Run opens whether or not a row is selected", () => {
  it("opens with NO selection", async () => {
    const container = await shell("#/triage");
    await key("f");
    await waitFor(() => runOpen(container), "the Reply Run to open with no selection");
  });

  it("one Escape closes the Reply Run and keeps its Answer Later letter open", async () => {
    const container = await shell("#/triage");
    await key("f");
    await waitFor(() => runOpen(container), "the Reply Run to open");
    const letter = window.location.hash;
    expect(letter).toMatch(/^#\/triage\/m\//);

    await key("Escape");
    expect(runOpen(container), "Escape did not close the Reply Run").toBe(false);
    expect(window.location.hash, "Escape closed the Reply Run AND navigated away")
      .toBe(letter);
  });
});
