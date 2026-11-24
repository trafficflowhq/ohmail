/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { modGlyph } from "@ohmail/app-logic/keys/mod-glyph";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";

/**
 * The keyboard-only walkthrough through the browser demo: five triage acts, two Screener
 * decisions, one Spam rescue, a reply, two moves, and a theme change. At each width, the
 * registered bindings take real key events. Where jsdom cannot supply a native Tab landing
 * or Enter on a focused button, activate() supplies the focus and activation.
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
  /* The frame lays itself out from the window's own width (its layout plan), not from a media query. */
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: px });
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
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom storage always exists; belt and braces */
  }
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(opts: { faces?: boolean } = {}): Promise<HTMLElement> {
  const { default: DemoPage } = await import("../app/(product)/demo/page.js");
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
          // The product door's door: without one the provider is `unpersisted` and reads no stored face.
          storage: localStorageDoor("theme"),
          children: h(ToastHost, { children: h(DemoPage) }),
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

/* A place's rows are its list's options, each carrying its letter's id; the cursor row is the one the list marks (or,
   where it marks none, the open one), as `ohbox/_finders.ts` finds them. */
const listRows = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('[role="option"][data-id]')];
const selRow = (c: HTMLElement): HTMLElement | null =>
  c.querySelector<HTMLElement>('[role="option"][data-cursor][data-id]') ?? c.querySelector<HTMLElement>('[role="option"][data-open][data-id]');
/** The place the frame shows, by its rail entry's (or dock's) current mark and name. */
const placeShown = (name: string): boolean =>
  [...document.querySelectorAll<HTMLElement>('[aria-current="page"]')]
    .some((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().startsWith(name));
const parts = (container: HTMLElement) => within(container);
const segOn = (container: HTMLElement, label: string): boolean => {
  const sections = parts(container).queryByRole("group", { name: "Screener sections" });
  return sections !== null &&
    within(sections).queryByRole("button", { name: new RegExp(`^${label}(?: \\d+)?$`), pressed: true }) !== null;
};
const openMessage = (container: HTMLElement) => parts(container).queryByRole("region", { name: "Open message" });
const replyEditor = (container: HTMLElement) => parts(container).queryByRole("textbox", { name: "Reply body" });

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
    () => segOn(container, "Waiting"),
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
  await key("]");
  await waitFor(() => segOn(container, "Screened out"), "step 9: `]` did not reach the screened-out section");
  await key("]");
  await waitFor(() => segOn(container, "Spam"), "step 9: `]` `]` did not reach the spam section");
  await waitFor(() => listRows(container).length > 0, "step 9: the demo spam section is empty");
  const spamBefore = listRows(container).length;
  await key("j");
  const spamId = selRow(container)?.dataset.id;
  expect(spamId, "step 9: j did not select a spam sender").toBeTruthy();

  // 10 · The Spam panel's Ohbox answer (Tab/Enter lands on the named control).
  const spamPanel = () => parts(container).queryByRole("toolbar", { name: "Actions" });
  if (narrow) {
    const selected = selRow(container);
    expect(selected?.tabIndex, "step 10: the selected spam row must be a tab stop").toBe(0);
    // Supply Tab's landing. The focused row handles the real Enter event.
    await act(async () => selected!.focus());
    await key("Enter");
  }
  await waitFor(() => spamPanel() !== null, "step 10: the Spam action panel did not open");
  expect(spamPanel()!.textContent).toContain("Not spam");
  await activate(within(spamPanel()!).queryByRole("button", { name: "Ohbox" }), "step 10: the Ohbox rescue");
  if (narrow && spamPanel() !== null) await key("Escape");
  await waitFor(
    () => segOn(container, "Spam") && listRows(container).length < spamBefore &&
      !listRows(container).some((row) => row.dataset.id === spamId),
    "step 10: the rescue did not move the sender out of spam",
  );

  /* ── REPLY 1 — inline, under the message ──────────────────────────────────────────── */
  // 11 · g o · j · (narrow: ↵ raises the reader sheet) · r — the inline editor opens
  await key("g");
  await key("o");
  await waitFor(
    () => placeShown("Ohbox"),
    "step 11: `g o` did not return to the Ohbox",
  );
  await waitFor(() => listRows(container).length > 0, "step 11: the Ohbox shows no rows");
  await key("j");
  if (narrow) {
    await key("Enter");
    await waitFor(() => openMessage(container) !== null, "step 11: ↵ did not raise the reader sheet at 390px");
  }
  await key("r");
  await waitFor(
    () => replyEditor(container) !== null,
    "step 11: `r` did not open the inline reply editor",
  );

  // 12 · type · ⌘↵ — the reply goes out through the one send machine
  const surface = replyEditor(container)!;
  await act(async () => {
    surface.focus();
    typeInto(surface, "Answered from the keyboard walkthrough.");
  });
  const metaKey = modGlyph() === "⌘";
  await key("Enter", { metaKey, ctrlKey: !metaKey });
  await waitFor(
    () => replyEditor(container) === null,
    "step 12: Mod+Enter did not send the reply (the editor is still open)",
  );
  if (narrow) {
    await key("Escape"); // close the reader sheet the reply rode on
    await waitFor(() => openMessage(container) === null, "step 12: Escape did not close the sheet");
  }

  /* ── FILE 2 — the Move strip: m, focus on the first destination, ↵ ────────────────── */
  const file = async (step: number) => {
    await key("j");
    const id = selRow(container)?.dataset.id;
    expect(id, `step ${step}: no cursor to file`).toBeTruthy();
    await key("m");
    const picker = () => within(document.body).queryByRole(narrow ? "dialog" : "menu", { name: /^move(?: to)?$/i });
    await waitFor(() => picker() !== null, `step ${step}: m did not open the Move picker`);
    const news = within(picker()!).getByRole("menuitem", { name: messages.place.reads });
    expect(document.activeElement, `step ${step}: m did not focus News`).toBe(news);
    await activate(news, `step ${step}: file to News`);
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
  // The setting line and the choice track both say Theme. Auto belongs to the track.
  const theme = () => parts(container).queryAllByRole("group", { name: "Theme" })
    .find((group) => within(group).queryByRole("button", { name: "Auto" })?.parentElement === group) ?? null;
  const general = () => {
    const nav = parts(container).queryByRole("navigation", { name: "Settings sections" });
    return nav ? within(nav).queryByRole("button", { name: "General" }) : null;
  };
  await waitFor(() => theme() !== null || general() !== null, "step 15: Settings did not open");
  if (theme() === null) await activate(general(), "step 15: open General from the section list");
  await waitFor(() => theme() !== null, "step 15: General did not open with the Theme control");
  const segButtons = () => within(theme()!).getAllByRole("button");
  const activeSeg = () => within(theme()!).getByRole("button", { pressed: true });
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
 * rung of the §12 ladder. The `narrow` flag is the JS half of the ladder itself: the split
 * SURVIVES at 800px (classic's sheet width — the run that proves the ribbon tier's split is
 * real), and one column takes over only under 700.
 *
 * The frame has one layout, the Zero's successor: the layout axis (`ohmail.layout`,
 * `data-layout="zero"`) was today's shell's and nothing of the frame reads it. The rungs are
 * the frame's own layout plan (`packages/app/src/frame/layout-plan.ts`): 1280 the desktop, 800
 * two columns beside the rail of icons, 600 and 390 one column. The provider is mounted with
 * the face axis active, as the product door mounts it.
 */
describe("the §4 walkthrough under the Zero layout, per §12 ladder rung", () => {
  it("passes at the full-rail tier (1280px, split)", { timeout: 120_000 }, async () => {
    setup(1280);
    const container = await shell({ faces: true });
    await walkthrough(container, false);
  });

  it("passes at the ribbon tier (800px — the split classic never had here)", { timeout: 120_000 }, async () => {
    setup(800);
    const container = await shell({ faces: true });
    await walkthrough(container, false);
  });

  it("passes at the push-nav tier (600px, one tile)", { timeout: 120_000 }, async () => {
    setup(600);
    const container = await shell({ faces: true });
    await walkthrough(container, true);
  });

  it("passes at the floating tier (390px)", { timeout: 120_000 }, async () => {
    setup(390);
    const container = await shell({ faces: true });
    await walkthrough(container, true);
  });
});

/**
 * THE SIXTEENTH STEP — the rail's separator joins the walk. The frame draws the rail's separator on a desktop's width;
 * the list's comes with a place that registers columns, which today's views do not, so it is not walked here.
 *
 * A keyboard user can reach and drive it, and having done so every chord the walk used still means what it meant: the
 * handle's ←/→ are stopped before they reach the shell's document listener, and a `stopPropagation` written one line
 * too high would take EVERY key with them. `focus()` stands in for the Tab that lands on it.
 */
describe("the separators are part of the keyboard walk", () => {
  const root = () => document.documentElement;
  const handle = () => document.querySelector<HTMLElement>('[role="separator"][aria-label="Sidebar width"]');

  const drive = async (container: HTMLElement) => {
    await waitFor(() => listRows(container).length > 0, "the demo Ohbox never grew rows");
    await waitFor(() => handle() != null, "the rail's separator never reached the frame");
    const rail = handle()!;
    expect(rail.getAttribute("aria-orientation")).toBe("vertical");
    expect(rail.tabIndex, "the rail's separator must be a tab stop").toBe(0);

    // 16 · Tab to the rail's separator: → widens it, ← narrows it back. The kit's handle takes the arrows, Home and End
    //      (no coarse step, no ⌫: a double-click resets it, held by the frame's own test).
    const zoneBefore = root().dataset.zone;
    await act(async () => rail.focus());
    const send = async (k: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        rail.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
      });
    };
    const width = (): number => parseFloat(root().style.getPropertyValue("--rail-w"));
    await send("ArrowRight");
    expect(root().style.getPropertyValue("--rail-w"), "step 16: → did not widen the rail").toBe("240px");
    expect(rail.getAttribute("aria-valuenow")).toBeTruthy();
    await send("End");
    expect(width(), "step 16: End did not widen the rail to its widest").toBeGreaterThan(240);
    // The zone model's own ←/→ must not ALSO have fired: one press, one meaning.
    await send("ArrowLeft");
    expect(root().dataset.zone, "step 16: the arrows walked the zone as well as the rail").toBe(zoneBefore);
    await send("Home");
    expect(width(), "step 16: Home did not narrow the rail").toBeLessThan(240);

    // …and the registry's own chords are untouched by any of it: `g o` after the handle held focus.
    await act(async () => rail.blur());
    await key("g");
    await key("o");
    await waitFor(
      () => placeShown("Ohbox"),
      "step 16: `g o` stopped working after the separator held focus",
    );
  };

  it("at the desktop split (1280px)", { timeout: 120_000 }, async () => {
    const container = await shell();
    await drive(container);
  });

  it("under the Zero layout, at the full-rail tier (1280px)", { timeout: 120_000 }, async () => {
    setup(1280);
    const container = await shell({ faces: true });
    await drive(container);
  });
});
