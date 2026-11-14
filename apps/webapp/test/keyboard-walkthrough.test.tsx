/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";

/**
 * THE KEYBOARD-ONLY WALKTHROUGH (OHMARCHY-PLAN §4 — the hard acceptance criterion).
 *
 * The full-day shape the prototype's script established, ported against the REAL shell on
 * the fixture world: triage 5 · screen 2 · reply 1 with schedule · file 2 · junk-rescue 1 ·
 * settings toggle 1 — fifteen named steps, every one driven by the keyboard through the
 * registry's own document listener, at BOTH widths (desktop split and the 390px phone
 * layout, which flips every `max-width: 699.98px` decision in the views).
 *
 * ── WHAT "KEYBOARD-ONLY" MEANS IN JSDOM, STATED HONESTLY ───────────────────────────────
 *
 * Every app-level chord is a real `keydown` on the document — the same event a person
 * produces and the same listener that serves them. TWO gestures cannot be synthesized:
 *
 *  · ↵ activating a FOCUSED BUTTON is the browser's own default action, which jsdom does
 *    not implement — `activate()` below stands in for it (focus, then click), and is used
 *    ONLY where a real keyboard user would Tab/↵ (the junk-rescue buttons, the send-later
 *    toggle, the settings switch). The registry deliberately leaves ↵-on-button to the
 *    browser (`when: e.target !== BUTTON` in the views), so this is the honest emulation
 *    of the path that exists, not a bypass of one that doesn't.
 *  · Tab traversal (jsdom has no sequential focus navigation) — `activate()` performs the
 *    landing the Tab would have made.
 *
 * ── THE MUTATION CONTRACT ──────────────────────────────────────────────────────────────
 *
 * Every step drives a REGISTERED binding (or the browser-native activation above), so
 * deleting a binding from the shell reddens the step that needed it by name — the other
 * half of the census test's promise (`keymap-census.test.tsx`).
 *
 * ── RECONCILIATIONS AGAINST THE PROTOTYPE (per §0, the app wins) ───────────────────────
 *
 *  · "file 2 to folders" — ohmail's filing model is the Move strip over the five places
 *    (`m`, focus on the first destination, ↵); IMAP folders ride the rail's Folders group,
 *    a different feature. The walkthrough files with the app's own verb.
 *  · "reply with schedule" — the shipping app schedules in COMPOSE (send-later presets),
 *    not in the inline reply; the walkthrough replies inline (r · type · ⌘↵) and schedules
 *    a composed message (c · type · Send later · `2`), which is the app's real shape.
 *  · junk-rescue — the Screener's rescue is the preview's two-step ceremony (Not spam… →
 *    destination), reached by keyboard via the section walk (`]`) + Tab/↵; the prototype's
 *    single-key rescue does not exist in the app and is not invented here.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

/** Width-aware matchMedia: answers `min-width`/`max-width` queries against `px`. */
function mkMatchMedia(px: number) {
  return (query: string) => {
    let matches = false;
    const max = /\(max-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
    const min = /\(min-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
    if (max) matches = px <= Number(max[1]);
    if (min) matches = px >= Number(min[1]) && (!max || matches);
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  };
}

function setup(px: number): void {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: mkMatchMedia(px),
  });
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
}

beforeEach(() => setup(1280));

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  // The Zero runs stamp the layout axis (see `zeroSetup`); a stale stamp or a stored
  // `ohmail.layout` must not leak into the classic runs' narrow question (shell/narrow.ts
  // reads the attribute).
  delete document.documentElement.dataset.layout;
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom storage always exists; belt and braces */
  }
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/**
 * THE ZERO LAYOUT'S MOUNT (OHMARCHY-PLAN §3b/§4 — the walkthrough must hold in BOTH
 * layouts). The stamp is written the way production writes it: `ohmail.layout` in storage
 * (what the boot script reads) plus the pre-paint attribute (what shell/narrow.ts asks),
 * and the provider is mounted with the face axis ACTIVE exactly as the product door mounts
 * it — with `faces: false`, or with no storage door, the provider would never adopt the
 * stored layout at all.
 */
function zeroSetup(px: number): void {
  setup(px);
  window.localStorage.setItem("ohmail.layout", "zero");
  document.documentElement.dataset.layout = "zero";
}

async function shell(opts: { faces?: boolean } = {}): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { localStorageDoor } = await import("@ohmail/app-logic/storage/durable");

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
          faces: opts.faces === true,
          // The product door's door: without one the provider is `unpersisted` and never reads
          // the `ohmail.layout` the Zero runs seed, so the Zero ladder would measure classic.
          storage: localStorageDoor("theme"),
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

/** ↵ on a focused control — the browser's own activation, which jsdom cannot synthesize. */
const activate = async (el: HTMLElement | null, what: string): Promise<void> => {
  expect(el, `${what}: control not on screen`).toBeTruthy();
  await act(async () => {
    el!.focus();
    el!.click();
  });
};

async function waitFor(predicate: () => boolean, what: string, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

const listRows = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>(".view .row[data-id]")];
const selRow = (c: HTMLElement): HTMLElement | null => c.querySelector<HTMLElement>(".view .row.sel[data-id]");
const byText = (c: HTMLElement, sel: string, text: string): HTMLElement | null =>
  [...c.querySelectorAll<HTMLElement>(sel)].find((el) => (el.textContent ?? "").includes(text)) ?? null;

/** The fifteen steps, driven at either width. */
async function walkthrough(container: HTMLElement, narrow: boolean): Promise<void> {
  /* ── TRIAGE 5 — the Ohbox, one keyboard verb per message ─────────────────────────── */
  await waitFor(() => listRows(container).length > 0, "the demo Ohbox never grew rows");
  const before = listRows(container).length;

  // 1 · j — take the cursor
  await key("j");
  await waitFor(() => selRow(container) != null, "step 1: `j` put no cursor on the list");

  const triage = async (step: number, chord: string, init: KeyboardEventInit = {}) => {
    const id = selRow(container)?.dataset.id;
    expect(id, `step ${step}: no cursor to act on`).toBeTruthy();
    await key(chord, init);
    await waitFor(
      () => !listRows(container).some((r) => r.dataset.id === id),
      `step ${step}: \`${chord}\` did not move the message out of the Ohbox`,
    );
    if (!selRow(container)) await key("j");
  };

  // 2 · a — answer later · 3 · e — park · 4 · b — resurface · 5–6 · a, e again
  await triage(2, "a");
  await triage(3, "e");
  await triage(4, "b");
  await triage(5, "a");
  await triage(6, "e");
  expect(
    listRows(container).length,
    "steps 2–6: five messages should have left the Ohbox",
  ).toBe(before - 5);

  /* ── SCREEN 2 — the Screener's decision letters ───────────────────────────────────── */
  // 7 · g s — to the Screener; j takes the cursor; `r` files this sender to Reads.
  // Every post-navigation wait below keys on the RENDER, not the hash: `location.hash`
  // reads back synchronously from the assignment, before jsdom has delivered `hashchange`,
  // so a hash-only wait can pass over a screen that has not moved yet.
  await key("g");
  await key("s");
  await waitFor(
    () => container.querySelector(".view-screener") != null,
    "step 7: `g s` did not open the Screener",
  );
  await waitFor(() => listRows(container).length > 0, "step 7: the Screener shows no waiting senders");
  const waitingBefore = listRows(container).length;
  await key("j");
  await key("r");
  await waitFor(
    () => listRows(container).length < waitingBefore,
    "step 7: `r` did not file the waiting sender",
  );

  // 8 · o — the next sender goes to the Ohbox
  await key("j");
  const w8 = listRows(container).length;
  await key("o");
  await waitFor(() => listRows(container).length < w8, "step 8: `o` did not file the waiting sender");

  /* ── JUNK-RESCUE 1 — the section walk, then the preview's own ceremony ────────────── */
  // 9 · ] ] — to the Junk section; j — select the held sender. The second press waits for
  // the first one's section to be ON SCREEN (the segmented control's own selected state),
  // exactly as a person's does — a hash that has changed under a screen that has not is
  // not a section anyone can act in.
  const segOn = (label: string): boolean =>
    [...container.querySelectorAll<HTMLElement>(".view-screener button")].some(
      (b) =>
        (b.textContent ?? "").includes(label)
        && (b.getAttribute("aria-selected") === "true" || b.getAttribute("aria-pressed") === "true"),
    );
  await key("]");
  await waitFor(() => segOn("Screened out"), "step 9: `]` did not reach the screened-out section");
  await key("]");
  await waitFor(() => segOn("Spam"), "step 9: `]` `]` did not reach the spam section");
  await waitFor(() => listRows(container).length > 0, "step 9: the demo spam section is empty");
  const spamBefore = listRows(container).length;
  await key("j");

  // 10 · Not spam… → Ohbox (Tab/↵ in a real browser; see the header)
  await activate(byText(container, ".d-btns button", "Not spam"), "step 10: the Not-spam ceremony");
  await activate(byText(container, ".d-btns button", "Ohbox"), "step 10: the → Ohbox rescue");
  await waitFor(
    () => listRows(container).length < spamBefore,
    "step 10: the rescue did not move the sender out of spam",
  );

  /* ── REPLY 1 — inline, under the message ──────────────────────────────────────────── */
  // 11 · g o · j · (narrow: ↵ raises the reader sheet) · r — the inline editor opens
  await key("g");
  await key("o");
  await waitFor(
    () => container.querySelector(".view-ohbox") != null,
    "step 11: `g o` did not return to the Ohbox",
  );
  await waitFor(() => listRows(container).length > 0, "step 11: the Ohbox shows no rows");
  await key("j");
  if (narrow) {
    await key("Enter");
    await waitFor(() => document.querySelector(".reader") != null, "step 11: ↵ did not raise the reader sheet at 390px");
  }
  await key("r");
  await waitFor(
    () => document.querySelector(".reply-editor .rte-surface") != null,
    "step 11: `r` did not open the inline reply editor",
  );

  // 12 · type · ⌘↵ — the reply goes out through the one send machine
  const surface = document.querySelector<HTMLElement>(".reply-editor .rte-surface")!;
  await act(async () => {
    typeInto(surface, "Answered from the keyboard walkthrough.");
  });
  await key("Enter", { metaKey: true });
  await waitFor(
    () => document.querySelector(".reply-editor .rte-surface") == null,
    "step 12: ⌘↵ did not send the reply (the editor is still open)",
  );
  if (narrow) {
    await key("Escape"); // close the reader sheet the reply rode on
    await waitFor(() => document.querySelector(".reader") == null, "step 12: Escape did not close the sheet");
  }

  /* ── FILE 2 — the Move strip: m, focus on the first destination, ↵ ────────────────── */
  const file = async (step: number) => {
    await key("j");
    const id = selRow(container)?.dataset.id;
    expect(id, `step ${step}: no cursor to file`).toBeTruthy();
    await key("m");
    await waitFor(
      () => document.querySelector(".abar-panel") != null,
      `step ${step}: \`m\` did not open the Move strip`,
    );
    // `m` lands focus on the first destination; ↵ there is the browser's activation.
    const first = document.activeElement as HTMLElement | null;
    expect(
      first?.classList.contains("abar-solo"),
      `step ${step}: \`m\` did not land focus on the first destination`,
    ).toBe(true);
    await activate(first, `step ${step}: the Move strip's first destination`);
    await waitFor(
      () => !listRows(container).some((r) => r.dataset.id === id),
      `step ${step}: the move did not take the message out of the list`,
    );
  };
  // 13 · file one message · 14 · file a second
  await file(13);
  await file(14);

  /* ── SETTINGS TOGGLE 1 ────────────────────────────────────────────────────────────── */
  // 15 · g , — Settings; flip the appearance scheme (the general pane's segmented control —
  // the one toggle every surface offers, demo included; Tab/↵'s landing in a real browser).
  await key("g");
  await key(",");
  /* On a phone (below 700, the width ladder's one-column band) the bare Settings route is the
     SECTION LIST (DESIGN-FOLD-WIDTHS §5) — General is one row of it, a real button, so
     the keyboard dives in by activating that row; at width the General pane stands directly. */
  await waitFor(
    () => container.querySelector(".theme-seg button") != null
      || container.querySelector('.set-list button[data-pane="general"]') != null,
    "step 15: `g ,` opened neither Settings' General pane nor the phone's section list",
  );
  const generalRow = container.querySelector<HTMLElement>('.set-list button[data-pane="general"]');
  if (generalRow) await activate(generalRow, "step 15: the General row of the phone's section list");
  await waitFor(
    () => container.querySelector(".theme-seg button") != null,
    "step 15: `g ,` did not open Settings with the scheme control on it",
  );
  const segButtons = () => [...container.querySelectorAll<HTMLElement>(".theme-seg button")];
  const activeSeg = () =>
    segButtons().find(
      (b) =>
        b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-selected") === "true",
    ) ?? null;
  const wasActive = activeSeg()?.textContent ?? "";
  const other = segButtons().find((b) => (b.textContent ?? "") !== wasActive);
  await activate(other ?? null, "step 15: a scheme other than the current one");
  await waitFor(
    () => (activeSeg()?.textContent ?? "") !== wasActive,
    "step 15: the scheme setting did not flip",
  );
}

describe("the §4 keyboard-only walkthrough, against the real shell", () => {
  it("passes at the desktop split (1280px)", { timeout: 120_000 }, async () => {
    const container = await shell();
    await walkthrough(container, false);
  });

  it("passes at the phone layout (390px)", { timeout: 120_000 }, async () => {
    setup(390);
    const container = await shell();
    await walkthrough(container, true);
  });
});

/**
 * THE SAME FIFTEEN STEPS UNDER THE ZERO LAYOUT (3b), at a representative width of every
 * rung of the §12 ladder. The `narrow` flag is the JS half of the ladder itself: under
 * zero the split SURVIVES at 800px (classic's sheet width — the run that proves the
 * ribbon tier's split is real), and the sheet takes over only under 722.
 */
describe("the §4 walkthrough under the Zero layout, per §12 ladder rung", () => {
  it("passes at the full-rail tier (1280px, split)", { timeout: 120_000 }, async () => {
    zeroSetup(1280);
    const container = await shell({ faces: true });
    await walkthrough(container, false);
  });

  it("passes at the ribbon tier (800px — the split classic never had here)", { timeout: 120_000 }, async () => {
    zeroSetup(800);
    const container = await shell({ faces: true });
    await walkthrough(container, false);
  });

  it("passes at the push-nav tier (600px, one tile)", { timeout: 120_000 }, async () => {
    zeroSetup(600);
    const container = await shell({ faces: true });
    await walkthrough(container, true);
  });

  it("passes at the floating tier (390px)", { timeout: 120_000 }, async () => {
    zeroSetup(390);
    const container = await shell({ faces: true });
    await walkthrough(container, true);
  });
});

/**
 * THE SIXTEENTH STEP — the two column separators join the walk.
 *
 * They are a new pair of tab stops in the middle of the shell, so the walkthrough owes two
 * answers: that a keyboard user can reach and drive them, and that having done so, every chord
 * the previous fifteen steps used still means what it meant. The second half is the one that
 * could quietly break: the handle's ←/→ are stopped before they reach the shell's document
 * listener, and a `stopPropagation` written one line too high would take EVERY key with them.
 *
 * Its own describe, at the split width only, deliberately: below 901 the seams do not exist
 * (`column-handles.css` hides both handles; the Zero ladder re-shows only the list's, from
 * 722) and jsdom applies no stylesheet, so a run at 390 here would drive a handle that a real
 * browser has taken off the screen — a green that claims the opposite of the truth. The widths
 * where they are hidden are covered by the rendered walk, not by this.
 *
 * `focus()` stands in for the Tab that lands on them, exactly as `activate()` does above:
 * jsdom implements no sequential focus navigation. What is asserted is that the element IS a
 * tab stop (`tabIndex` 0 on a `role="separator"`), which is the half jsdom can answer.
 */
describe("the separators are part of the keyboard walk", () => {
  const root = () => document.documentElement;
  const handle = (c: HTMLElement, kind: "rail" | "list") =>
    c.querySelector<HTMLElement>(`.col-handle-${kind}`);

  const drive = async (container: HTMLElement) => {
    await waitFor(() => listRows(container).length > 0, "the demo Ohbox never grew rows");
    await waitFor(
      () => handle(container, "rail") != null && handle(container, "list") != null,
      "neither separator reached the shell",
    );

    for (const kind of ["rail", "list"] as const) {
      const el = handle(container, kind)!;
      expect(el.getAttribute("role"), `the ${kind} separator's role`).toBe("separator");
      expect(el.getAttribute("aria-orientation")).toBe("vertical");
      expect(el.tabIndex, `the ${kind} separator must be a tab stop`).toBe(0);
      expect(el.getAttribute("aria-label"), `the ${kind} separator must say what it is`).toBeTruthy();
    }

    // 16 · Tab to the rail's separator, → widens it, ⇧→ widens it coarsely, ⌫ puts it back.
    const rail = handle(container, "rail")!;
    const zoneBefore = root().dataset.zone;
    await act(async () => rail.focus());
    const send = async (k: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        rail.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
        );
      });
    };
    await send("ArrowRight");
    expect(root().style.getPropertyValue("--rail-w"), "step 16: → did not widen the rail").toBe("240px");
    expect(rail.getAttribute("aria-valuenow")).toBeTruthy();
    await send("ArrowRight", { shiftKey: true });
    expect(root().style.getPropertyValue("--rail-w"), "step 16: ⇧→ did not take the coarse step").toBe("304px");
    // The zone model's own ←/→ must not ALSO have fired: one press, one meaning.
    await send("ArrowLeft");
    expect(root().dataset.zone, "step 16: the arrows walked the zone as well as the rail").toBe(zoneBefore);
    await send("Backspace");
    expect(root().style.getPropertyValue("--rail-w"), "step 16: ⌫ did not reset the rail").toBe("");

    // …and the registry's own chords are untouched by any of it. `g o` after the handle has
    // held focus is the whole claim: the handler stopped its six keys, not the keyboard.
    await act(async () => rail.blur());
    await key("g");
    await key("o");
    await waitFor(
      () => container.querySelector(".view-ohbox") != null,
      "step 16: `g o` stopped working after the separator held focus",
    );
  };

  it("at the desktop split (1280px)", { timeout: 120_000 }, async () => {
    const container = await shell();
    await drive(container);
  });

  it("under the Zero layout, at the full-rail tier (1280px)", { timeout: 120_000 }, async () => {
    zeroSetup(1280);
    const container = await shell({ faces: true });
    await drive(container);
  });
});
