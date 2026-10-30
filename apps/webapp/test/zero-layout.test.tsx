/** @vitest-environment jsdom */
/**
 * THE ZERO LAYOUT'S OWN CONTRACT (OHMARCHY-PLAN §3b, the §12 ladder) — the pieces the
 * walkthrough runs do not pin by name:
 *
 *  · `w` cycles classic ⇄ zero through the ONE provider (stamp + `ohmail.layout`), and the
 *    generated `?` sheet documents it — on the default face, because the offer is
 *    deliberately face-independent (the close-out's argued call);
 *  · the ladder's JS boundary is EXACT: under zero the reading column leaves at 721, not
 *    722 — the off-by-one mutation the brief demands red — and classic keeps 900/901;
 *  · `h` toward the rail SUMMONS the full drawer under zero at ribbon widths (§12's one
 *    meaning for `h`), esc re-docks it — and under classic the same key summons classic's
 *    drawer, which ≡ opens.
 *
 * Mounted exactly as the keymap census mounts the shipped shell on the fixture world.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { chordKeys, modGlyph } from "../app/shell/keymap";
import { readColumnHidden } from "../app/shell/narrow";
import { currentZone } from "../app/shell/zone-nav";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

/** Width-aware matchMedia, the walkthrough's own — and a RESIZE the shell's `watchNarrow` hears:
 *  every list handed out remembers its query and its `change` listeners, and `resize(px)` re-answers
 *  each and fires the listeners whose answer moved (the width ladder's crossing test needs it). */
let widthNow = 1280;
const lists: Array<{ query: string; matches: boolean; listeners: Set<(e: { matches: boolean }) => void> }> = [];
const answer = (query: string, px: number): boolean => {
  let matches = false;
  const max = /\(max-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  const min = /\(min-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  if (max) matches = px <= Number(max[1]);
  if (min) matches = px >= Number(min[1]) && (!max || matches);
  return matches;
};
function mkMatchMedia(px: number) {
  widthNow = px;
  lists.length = 0;
  return (query: string) => {
    const entry = { query, matches: answer(query, widthNow), listeners: new Set<(e: { matches: boolean }) => void>() };
    lists.push(entry);
    return {
      get matches() { return entry.matches; },
      media: query,
      addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => { entry.listeners.add(fn); },
      removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => { entry.listeners.delete(fn); },
      addListener: (fn: (e: { matches: boolean }) => void) => { entry.listeners.add(fn); },
      removeListener: (fn: (e: { matches: boolean }) => void) => { entry.listeners.delete(fn); },
      onchange: null,
      dispatchEvent: () => false,
    };
  };
}
async function resize(px: number): Promise<void> {
  widthNow = px;
  await act(async () => {
    for (const l of lists) {
      const next = answer(l.query, px);
      if (next === l.matches) continue;
      l.matches = next;
      for (const fn of l.listeners) fn({ matches: next });
    }
  });
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

beforeEach(() => {
  setup(1280);
  window.localStorage.clear();
  delete document.documentElement.dataset.layout;
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete document.documentElement.dataset.layout;
  window.localStorage.clear();
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(opts: { zero?: boolean } = {}): Promise<HTMLElement> {
  if (opts.zero) {
    // Production's own two writes: the storage the boot script reads, the pre-paint stamp
    // the narrow question reads. The provider adopts the same answer post-mount.
    window.localStorage.setItem("ohmail.layout", "zero");
    document.documentElement.dataset.layout = "zero";
  }
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { localStorageDoor } = await import("../app/shell/durable.js");

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
        /* The product door's own wiring: the provider persists through the durable door, which
           is what makes the layout pin survive a reload here as it does in the app. */
        children: h(ThemeProvider, {
          faces: true,
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

const tick = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
};

describe("`w` — the layout cycle through the one provider", () => {
  it("stamps zero, persists the device choice, and cycles back", async () => {
    setup(800);
    await shell();
    expect(document.documentElement.dataset.layout).toBeUndefined();

    await key("w");
    await tick();
    expect(document.documentElement.dataset.layout).toBe("zero");
    expect(window.localStorage.getItem("ohmail.layout")).toBe("zero");

    await key("w");
    await tick();
    expect(document.documentElement.dataset.layout).toBeUndefined();
    expect(window.localStorage.getItem("ohmail.layout")).toBe("classic");
  });

  it("the ? sheet documents it — on the paper face, because the offer is face-independent", async () => {
    setup(800);
    const container = await shell();
    await key("?");
    const sheet = container.querySelector(".ks");
    expect(sheet, "the ? sheet is not open").toBeTruthy();
    const caps = [...sheet!.querySelectorAll(".ks-keys")].map((el) => el.textContent ?? "");
    // `w` carries no modifier, but `chordKeys` requires the glyph from every caller now —
    // a default would be the shipped Mac-cap-on-Linux bug waiting in the signature.
    expect(caps).toContain(chordKeys("w", modGlyph()).join(""));
  });
});

/* Zero draws classic's arrangement from 1024 and under 392, so there `w` would change nothing. */
describe("`w` is live only where the two layouts look different", () => {
  /** The sheet's `w` row: whether it rests, and the reason it gives. */
  const sheetRow = async (container: HTMLElement): Promise<{ off: boolean; why: string | null } | null> => {
    await key("?");
    const row = [...container.querySelectorAll<HTMLElement>(".ks li")]
      .find((li) => li.querySelector(".ks-lab")?.textContent === messages.shortcuts.layout);
    const out = row ? { off: row.classList.contains("off"), why: row.getAttribute("title") } : null;
    await key("Escape");
    return out;
  };
  const paletteLabels = async (): Promise<string[]> => {
    await key("k", { ctrlKey: true });
    const labels = [...document.querySelectorAll(".palette li[role=option]")].map((el) => el.textContent ?? "");
    await key("Escape");
    return labels;
  };
  for (const px of [1280, 390]) {
    it(`at ${px}px the key rests, the sheet says why, and the palette leaves it out`, async () => {
      setup(px);
      const container = await shell();
      await key("w");
      await tick();
      expect(document.documentElement.dataset.layout, "w changed the layout where nothing shows it").toBeUndefined();
      expect(await sheetRow(container)).toEqual({ off: true, why: messages.shortcuts.layoutSame });
      expect((await paletteLabels()).join("|")).not.toContain(messages.palette.cycleLayout);
    });
  }

  it("a window narrowed into the band offers it, and the palette names it there", async () => {
    setup(1280);
    const container = await shell();
    await resize(800);
    expect(await sheetRow(container)).toEqual({ off: false, why: null });
    expect((await paletteLabels()).join("|")).toContain(messages.palette.cycleLayout);
    await key("w");
    await tick();
    expect(document.documentElement.dataset.layout).toBe("zero");
  });
});

describe("the ladder's JS boundary is exact (shell/narrow.ts)", () => {
  const at = (px: number, zero: boolean): boolean => {
    setup(px);
    if (zero) document.documentElement.dataset.layout = "zero";
    else delete document.documentElement.dataset.layout;
    return readColumnHidden();
  };

  it("zero: the split survives 722, the sheet owns 721 — off by one is red", () => {
    expect(at(722, true), "722 under zero must keep the reading column").toBe(false);
    expect(at(721, true), "721 under zero must hide the reading column").toBe(true);
  });

  it("classic's phone edge is the width ladder's: 700 split, 699 sheet — off by one is red", () => {
    expect(at(700, false), "700 under classic is the two-pane band").toBe(false);
    expect(at(699, false), "699 under classic is the phone").toBe(true);
    expect(at(1024, false)).toBe(false);
  });

  it("zero above the ribbon band asks nothing new: 1024 splits, 800 splits too", () => {
    expect(at(1024, true)).toBe(false);
    expect(at(800, true), "the ribbon tier's split is the point of the layout").toBe(false);
  });
});

describe("the fix round — reconcile, exits, names", () => {
  const openSheet = async (container: HTMLElement): Promise<void> => {
    await key("j");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !container.querySelector(".view .row.sel[data-id]")) {
      await tick();
    }
    await key("Enter");
    const until = Date.now() + 4000;
    while (Date.now() < until && !document.querySelector(".reader")) {
      await tick();
    }
    expect(document.querySelector(".reader"), "the reader sheet never rose").toBeTruthy();
  };

  /**
   * SINCE THE WIDTH LADDER (DESIGN-FOLD-WIDTHS §0) classic seats two panes from 700, so there is
   * no width left where classic shows a sheet and zero a column — the reconcile's one reachable
   * direction is now zero → classic between 700 and 721: zero's push tier still re-houses the
   * sheet there (its split dies under 722) while classic's two-pane column stands. Cycling OUT
   * of zero at 710 must close that sheet, or it stands fixed over the column it duplicates.
   */
  it("cycling OUT of zero at 710px closes the push-tier sheet the classic two-pane column replaces", async () => {
    setup(710);
    const container = await shell({ zero: true });
    await openSheet(container);
    await key("w");
    await tick();
    expect(document.documentElement.dataset.layout).toBeUndefined();
    expect(
      document.querySelector(".reader"),
      "the sheet stood over the two-pane column it duplicates",
    ).toBeNull();
  });

  it("…and the former case is gone: at 800 classic opens in its own column, so there is no sheet to close", async () => {
    setup(800);
    const container = await shell();
    await key("j");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !container.querySelector(".view .row.sel[data-id]")) await tick();
    await key("Enter");
    await tick();
    expect(document.querySelector(".reader"), "a sheet rose at 800 under classic — the two-pane band lost its column").toBeNull();
    await key("w");
    await tick();
    expect(document.documentElement.dataset.layout).toBe("zero");
    expect(document.querySelector(".reader")).toBeNull();
  });

  it("`h` leaves the re-housed reader at the push tier (one meaning for h)", async () => {
    setup(600);
    const container = await shell({ zero: true });
    await openSheet(container);
    await key("h");
    await tick();
    expect(document.querySelector(".reader"), "`h` did not put the list back").toBeNull();
    // …and under CLASSIC the sheet cedes h exactly as before (modal grammar).
    setup(600);
  });

  it("classic's sheet still cedes `h` — the exit stays Escape", async () => {
    setup(600);
    const container = await shell();
    await openSheet(container);
    await key("h");
    await tick();
    expect(document.querySelector(".reader"), "classic behavior moved").toBeTruthy();
  });

  it("a keyboard summon lands focus IN the drawer, and the toggle says what it does", async () => {
    setup(800);
    const container = await shell({ zero: true });
    await key("h");
    const deadline = Date.now() + 4000;
    while (
      Date.now() < deadline &&
      !(container.querySelector(".rail.open")?.contains(document.activeElement) ?? false)
    ) {
      await tick();
    }
    const drawer = container.querySelector(".rail.open");
    expect(drawer, "the drawer did not open").toBeTruthy();
    expect(
      drawer!.contains(document.activeElement),
      "focus stayed in the list after the summon",
    ).toBe(true);
    const toggle = container.querySelector<HTMLElement>(".rail-expand");
    expect(toggle?.getAttribute("aria-label")).toBe("Close navigation");
    await key("Escape");
    await tick();
    expect(container.querySelector(".rail.open")).toBeNull();
    expect(toggle?.getAttribute("aria-label")).toBe("Open navigation");
  });

  it("the push tier's reader is non-modal to ARIA; the floating tier's stays modal", async () => {
    setup(600);
    let container = await shell({ zero: true });
    await openSheet(container);
    expect(document.querySelector(".reader")?.getAttribute("aria-modal")).toBeNull();
    await key("Escape");
    await tick();
    for (const root of roots) {
      await act(() => root.unmount());
    }
    roots = [];
    document.body.innerHTML = "";

    setup(390);
    window.localStorage.setItem("ohmail.layout", "zero");
    document.documentElement.dataset.layout = "zero";
    container = await shell({ zero: true });
    await openSheet(container);
    expect(document.querySelector(".reader")?.getAttribute("aria-modal")).toBe("true");
  });
});

describe("the fix round, round 2 — tiers, transitions, the drawer's zone", () => {
  const openSheet = async (container: HTMLElement): Promise<void> => {
    await key("j");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !container.querySelector(".view .row.sel[data-id]")) {
      await tick();
    }
    await key("Enter");
    const until = Date.now() + 4000;
    while (Date.now() < until && !document.querySelector(".reader")) {
      await tick();
    }
    expect(document.querySelector(".reader"), "the reader sheet never rose").toBeTruthy();
  };

  it("the floating tier's modal sheet cedes `h` — Escape stays its one exit", async () => {
    setup(390);
    const container = await shell({ zero: true });
    await openSheet(container);
    await key("h");
    await tick();
    expect(document.querySelector(".reader"), "`h` dismissed the modal sheet").toBeTruthy();
  });

  it("a narrow→narrow cycle keeps the sheet, and its ARIA claim follows the layout live", async () => {
    setup(600);
    const container = await shell({ zero: true });
    await openSheet(container);
    expect(document.querySelector(".reader")?.getAttribute("aria-modal")).toBeNull();
    await key("w"); // zero → classic at 600: the column stays hidden in both
    await tick();
    await tick();
    const sheet = document.querySelector(".reader");
    expect(sheet, "a narrow→narrow cycle must not take the open message away").toBeTruthy();
    expect(
      sheet?.getAttribute("aria-modal"),
      "classic's sheet is modal — the subscribed tier must have followed the stamp",
    ).toBe("true");
  });

  it("closing the summoned drawer releases focus from the off-canvas rail", async () => {
    setup(800);
    const container = await shell({ zero: true });
    await key("h");
    const deadline = Date.now() + 4000;
    while (
      Date.now() < deadline &&
      !(container.querySelector(".rail.open")?.contains(document.activeElement) ?? false)
    ) {
      await tick();
    }
    expect(container.querySelector(".rail.open")?.contains(document.activeElement)).toBe(true);
    await key("Escape");
    await tick();
    expect(container.querySelector(".rail.open")).toBeNull();
    expect(
      container.querySelector(".rail")?.contains(document.activeElement),
      "focus stayed inside invisible navigation",
    ).toBe(false);
  });

  it("with the drawer raised over the push reader, the drawer owns the keys", async () => {
    setup(600);
    const container = await shell({ zero: true });
    await openSheet(container);
    // The pointer path: the ribbon's ≡ stays operable beside the re-housed reader.
    const toggle = container.querySelector<HTMLElement>(".rail-expand");
    await act(async () => {
      toggle!.click();
    });
    await tick();
    const drawer = container.querySelector(".rail.open");
    expect(drawer, "≡ did not raise the drawer").toBeTruthy();
    const row = drawer!.querySelector<HTMLElement>(".ritem");
    await act(async () => {
      row!.focus();
    });
    expect(currentZone(), "focus in an open drawer is the rail zone, sheet or no sheet").toBe(
      "rail",
    );
    await key("h");
    await tick();
    expect(
      document.querySelector(".reader"),
      "`h` in the drawer must not close the reader behind it",
    ).toBeTruthy();
  });
});

describe("`h` at the rail boundary — summon under zero and under classic (§12)", () => {
  it("zero at 800px: h summons the full drawer, esc re-docks it", async () => {
    setup(800);
    const container = await shell({ zero: true });
    // The zone derives "list" with focus at rest on the body; `h` walks toward the rail,
    // which at ribbon widths means drawer-in (zone-nav's summon seam).
    await key("h");
    await tick();
    expect(
      container.querySelector(".rail.open"),
      "`h` did not summon the drawer at the ribbon tier",
    ).toBeTruthy();
    await key("Escape");
    await tick();
    expect(
      container.querySelector(".rail.open"),
      "Escape did not re-dock the drawer",
    ).toBeNull();
  });

  /* Was "summons nothing — classic behavior does not move": a stability pin that held a dead key.
     At classic drawer widths ← and `h` sat in the `?` sheet as "Focus the menu" and did nothing
     (390px); they now summon the drawer ≡ opens, as under zero. */
  it("classic at 800px and 390px: the same key summons the drawer, esc closes it", async () => {
    for (const px of [800, 390]) {
      setup(px);
      const container = await shell();
      await key("h");
      await tick();
      expect(container.querySelector(".rail.open"), `\`h\` summoned no drawer at classic ${px}px`).toBeTruthy();
      await key("Escape");
      await tick();
      expect(container.querySelector(".rail.open"), `Escape did not close the drawer at ${px}px`).toBeNull();
      for (const root of roots) await act(() => { root.unmount(); });
      roots = [];
      document.body.innerHTML = "";
    }
  });
});

describe("the fix round, round 3 — the reconcile asks at the current width", () => {
  const openSheet = async (container: HTMLElement): Promise<void> => {
    await key("j");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !container.querySelector(".view .row.sel[data-id]")) {
      await tick();
    }
    await key("Enter");
    const until = Date.now() + 4000;
    while (Date.now() < until && !document.querySelector(".reader")) {
      await tick();
    }
    expect(document.querySelector(".reader"), "the reader sheet never rose").toBeTruthy();
  };

  /**
   * A RESIZE BETWEEN CYCLES must not be remembered as the old answer. The reconcile only
   * re-runs when the layout changes, so anything it caches describes the viewport at the
   * PREVIOUS cycle: here the shell mounts wide (column standing), the visitor narrows the
   * window to a width where classic hides the column and legitimately opens the sheet, and
   * `w` then reveals Zero's standing pair. Remembering "was standing" reads that as
   * standing→standing and leaves the sheet fixed over the column it duplicates — the exact
   * double-render the reconcile exists to prevent. Comparing the two LAYOUTS at the current
   * width is what makes the resize irrelevant.
   */
  it("wide mount, narrowed window, then `w` — the duplicated sheet still goes", async () => {
    // Since the width ladder the reachable direction is zero → classic at 700–721.
    setup(1280);
    const container = await shell({ zero: true });
    // the premise: wide zero reads its message in the standing column, no sheet stands
    expect(
      document.querySelector(".reader"),
      "a sheet stood at 1280 — this test's premise is gone",
    ).toBeNull();

    // the visitor narrows the window into zero's push tier; no layout cycle happened, so
    // nothing refreshes a cached answer (`readColumnHidden` is asked live at event time,
    // which is why the sheet below is correct while a remembered boolean is not). A real
    // resize, so the `w` offer hears the window enter its band.
    await resize(710);
    await openSheet(container);

    await key("w");
    await tick();
    expect(document.documentElement.dataset.layout).toBeUndefined();
    expect(
      document.querySelector(".reader"),
      "the sheet stood over the column classic just brought back (a stale narrow answer)",
    ).toBeNull();
  });

  /* The other direction — a cycle that reveals nothing must leave the sheet alone — stays
     pinned where it is observable: "a narrow→narrow cycle keeps the sheet" in round 2's
     block above. It is not testable through a WIDENED window, and the reason is a rule of
     the shell's own: for a row its pile holds, the route reflection nulls the overlay at
     any split width (AppShell.tsx, the ohbox arm — "a stale reader … would sit over the
     column"), so no ordinary message keeps a sheet at 1280 whatever this effect decides.
     The wide sheet round 2 protects is the archive-only one, which that arm never claims. */
});

/**
 * ═══ THE WIDTH LADDER'S CROSSING WITH A MESSAGE OPEN (LOW 4) ═══════
 *
 * A reported foldable: the phone reader is up at 650, the phone unfolds to 821. The overlay used
 * to stand over the two panes with its close hidden (`reader.css` paints the ✕ below 700 only) and
 * the page behind faded out. Crossing 700 upward now moves the open message into the reading column
 * and takes the overlay down; crossing downward the column's message becomes the overlay again. A
 * reply being typed rides with the message, because the dock is keyed by its id.
 *
 * Mutation: drop the `crossNarrow` effect in `shell-open-state.ts` — the first arm goes red.
 */
describe("crossing 700 with a message open — the overlay and the column trade the message", () => {
  const openOverlay = async (container: HTMLElement): Promise<string> => {
    await key("j");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !container.querySelector(".view .row.sel[data-id]")) await tick();
    const id = container.querySelector<HTMLElement>(".view .row.sel[data-id]")!.dataset.id!;
    await key("Enter");
    const until = Date.now() + 4000;
    while (Date.now() < until && !document.querySelector(".reader")) await tick();
    expect(document.querySelector(".reader"), "the reader sheet never rose").toBeTruthy();
    return id;
  };

  it("unfolding at 650 → 821 moves the open message into the column; folding back raises the overlay on it", async () => {
    setup(650);
    const container = await shell();
    const id = await openOverlay(container);
    // the reply being written, in the overlay
    const { typeInto } = await import("./fixtures/rich-editor-driver.js");
    await key("r");
    const until = Date.now() + 4000;
    while (Date.now() < until && !document.querySelector(".reply-editor .rte-surface")) await tick();
    const surface = document.querySelector<HTMLElement>(".reply-editor .rte-surface");
    expect(surface, "`r` did not open the inline reply in the overlay").not.toBeNull();
    await act(async () => { typeInto(surface!, "typed before the unfold"); });

    await resize(821);
    await tick();
    expect(document.querySelector(".reader"), "the overlay stood over the two panes").toBeNull();
    const col = container.querySelector(".read-col");
    expect(col, "no reading column at 821").not.toBeNull();
    expect(container.querySelector(`.view .row.sel[data-id="${id}"]`), "the column lost the message").not.toBeNull();
    const colSurface = col!.querySelector<HTMLElement>(".reply-editor .rte-surface");
    expect(colSurface, "the reply did not move into the column").not.toBeNull();
    expect(colSurface!.textContent).toContain("typed before the unfold");
    // the keyboard stays in the reply: a key typed through the unfold is text, never a list command
    expect(colSurface!.contains(document.activeElement), "focus went to the list row, not the editor being typed in").toBe(true);

    await resize(650);
    await tick();
    const sheet = document.querySelector(".reader");
    expect(sheet, "folding back raised no overlay on the column's message").not.toBeNull();
    expect(sheet!.querySelector(".reply-editor .rte-surface")?.textContent ?? "").toContain("typed before the unfold");
  });

  it("the column's ✕ on a fallback column rests the column — it never swaps in the first row", async () => {
    /* Triage: a column view whose pick is the plain `selectedId` path and whose column falls back to
       its first row when nothing is picked (History's paged rows need the engine's page reads). */
    setup(821);
    const container = await shell();
    await act(async () => { window.location.hash = "#/triage"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await tick();
    await tick();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !container.querySelector(".view-triage .row[data-id]")) await tick();
    const row = container.querySelector<HTMLElement>(".view-triage .row[data-id]")!;
    const id = row.dataset.id!;
    // a column view's own pick is its row's press (the keys open through the shell's column pick)
    await act(async () => { row.click(); });
    await tick();
    const close = container.querySelector<HTMLButtonElement>(".read-col .read-col-close");
    expect(close, "no ✕ on the Triage column with a row picked").not.toBeNull();
    expect(container.querySelector(".read-col .msg"), "no message in the column before the close").not.toBeNull();
    await act(async () => { close!.click(); });
    await tick();
    expect(container.querySelector(".read-col .msg"), "the close swapped another message into the column").toBeNull();
    expect(container.querySelector(".read-col .read-col-close"), "the ✕ stayed on a column at rest").toBeNull();
    // the next pick brings the column back
    await act(async () => { container.querySelector<HTMLElement>(`.view-triage .row[data-id="${id}"]`)!.click(); });
    await tick();
    expect(container.querySelector(".read-col .msg"), "a pick after the close did not open").not.toBeNull();
  });

  it("control: a message open in the column at 821 is untouched by a resize that stays above 700", async () => {
    setup(821);
    const container = await shell();
    await key("j");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !container.querySelector(".view .row.sel[data-id]")) await tick();
    await key("Enter");
    await tick();
    expect(document.querySelector(".reader")).toBeNull();
    await resize(1023);
    await tick();
    expect(document.querySelector(".reader")).toBeNull();
    expect(container.querySelector(".read-col")).not.toBeNull();
  });
});
