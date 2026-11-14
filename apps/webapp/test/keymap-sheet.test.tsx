/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * THE ? SHEET AS A PROJECTION OF THE KEYBOARD REGISTRY: moved as they were from `keymap.test.ts`, whose
 * dispatcher cases now stand the registry as the frame stands it. These read today's sheet
 * (`ShortcutSheet`) and leave with it: Search's mount holds the sheet (`mount-search`), and the rows that rest for
 * want of a cursor wait for the kit's resting row.
 *
 *
 * Two claims are under test and they are the two the product makes:
 *
 *   1. the keys ARE integrated — one dispatcher, with a stated precedence, instead of six
 *      `document` listeners racing in mount order; and
 *   2. they are VISIBLE — the `?` sheet is a projection of the dispatcher's own table, so
 *      it cannot list a key that does nothing or omit one that does.
 *
 * The second is the one worth defending, because the thing it replaced — a hand-typed
 * sentence in the (i) panel — was already wrong when this was written. The guard for it is
 * `the sheet is GENERATED…`: registering a brand-new binding must make a brand-new row
 * appear with no edit anywhere else. Mutate `groupedBindings` to return `[]` (or make
 * `ShortcutSheet` render a fixed list) and it goes red.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const text = (): string => host!.textContent ?? "";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { await unmount(); vi.useRealTimers(); });

type Binding = import("@ohmail/app-logic/keys/keymap").KeyBinding;

/**
 * Mount a provider holding `global` bindings with a child holding `view` ones, plus the
 * real `?` sheet. Nothing here is a stand-in: the components are the shipped ones.
 *
 * `overlay` bindings are declared by the SHELL component, not the view — deliberately, and
 * it is the whole point of that scope. The shell is the view's ancestor, so React runs its
 * effect LAST; if precedence came from registration order this layer would lose, and the
 * test below would pass only by accident of the tree.
 */
interface MountOpts {
  global?: Binding[];
  view?: Binding[];
  overlay?: Binding[];
  sheetOpen?: boolean;
  /**
   * CLAIM A CURSOR PLACER — `(label) => boolean`, and what it was called with is what the "names
   * the verb pressed" case reads. See `keymap.tsx#claimCursorPlacer`.
   *
   * `place` is claimed by the SHELL, which is this app's real shape: `AppShell` is the only
   * component that holds a cursor for the lists it renders. `placeEarlier` is claimed by the
   * VIEW, whose effect React runs FIRST — so it is the earlier claim, which is the only thing
   * the no-fallthrough case needs of it.
   */
  place?: (label: string) => boolean;
  placeEarlier?: (label: string) => boolean;
  /**
   * A VIEW-SCOPED claim — the split views' shape, where the view holds the cursor and the shell
   * holds none for that route. Both other placers are `global`, so this is the only way to ask
   * whether SCOPE decides the winner rather than recency. Claimed at `view` only when a case
   * supplies it: an unconditional view claim would win every case in this file by construction.
   */
  placeInView?: (label: string) => boolean;
}

/**
 * Mount a provider holding `global` bindings with a child holding `view` ones, plus the
 * real `?` sheet. Nothing here is a stand-in: the components are the shipped ones.
 *
 * `overlay` bindings are declared by the SHELL component, not the view — deliberately, and
 * it is the whole point of that scope. The shell is the view's ancestor, so React runs its
 * effect LAST; if precedence came from registration order this layer would lose, and the
 * test below would pass only by accident of the tree.
 *
 * `rerender` renders NEW bindings into the SAME root, which is a different question from
 * mounting again: it is the only way to ask whether a layer re-registers when its bindings
 * change shape, and `useKeyBindings` decides that from a JSON key over the fields the `?` sheet
 * renders. A remount would re-register unconditionally and could not tell the two apart.
 */
async function mount(opts: MountOpts): Promise<{
  closes: number;
  rerender: (next: MountOpts) => Promise<void>;
}> {
  await unmount();
  const { useKeyBindings, useCursorPlacer } = await import("@ohmail/app-logic/keys/keymap");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const { ShortcutSheet } = await import("../app/shell/ShortcutSheet.js");
  const counters = { closes: 0 };
  const NO_PLACE = (): boolean => false;

  function View({ o }: { o: MountOpts }): null {
    useKeyBindings(o.view ?? [], "view");
    /* Claimed only when a case asks for it: an unconditional second claimant would be the MOST
       RECENT one on some renders and would decide every case by mount order, which is exactly
       the ambiguity the registry refuses to have. */
    useCursorPlacer(o.placeEarlier ?? NO_PLACE);
    /* The SCOPE is what varies, not whether the hook runs — a conditional hook is not a thing,
       and a scope read from the options keeps the registration honest either way. */
    useCursorPlacer(o.placeInView ?? NO_PLACE, o.placeInView ? "view" : "global");
    return null;
  }
  function Shell({ o }: { o: MountOpts }): React.ReactNode {
    useKeyBindings(o.global ?? [], "global");
    useKeyBindings(o.overlay ?? [], "overlay");
    useCursorPlacer(o.place ?? NO_PLACE);
    return h(React.Fragment, null,
      h(View, { o }),
      h(ShortcutSheet, { open: o.sheetOpen ?? false, onClose: () => { counters.closes++; } }),
    );
  }

  const draw = async (o: MountOpts): Promise<void> => {
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(KeymapProvider, { children: h(Shell, { o }) }),
        }),
      );
    });
  };

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await draw(opts);
  /* `closes` is a GETTER: the count moves after this function has returned, and a snapshot
     would read 0 for ever — the sheet's dismissal case is exactly the one that presses a key
     afterwards. */
  return { get closes() { return counters.closes; }, rerender: draw };
}

const b = (over: Partial<Binding> & Pick<Binding, "chord" | "run">): Binding => ({
  group: "app", label: `does ${over.chord}`, ...over,
});

describe("the ? sheet is GENERATED from the registry", () => {
  it("a binding nobody edited the sheet for still appears in it, with its keycaps", async () => {
    // THE GUARD. Nothing below names this binding anywhere but the registration: no sheet
    // template, no message key, no list. Make `groupedBindings` return [] — or make
    // `ShortcutSheet` render a hand-written list instead of `bindings` — and it goes red,
    // which is exactly the failure the old (i)-panel sentence could never produce.
    await mount({
      view: [b({ chord: "shift+z", group: "message", label: "invent a whole new verb", run: () => {} })],
      sheetOpen: true,
    });
    expect(text()).toContain("invent a whole new verb");
    const row = [...host!.querySelectorAll("li")].find((li) =>
      (li.textContent ?? "").includes("invent a whole new verb"),
    );
    expect([...row!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["⇧", "z"]);
  });

  it("every arrow chord renders as a keycap, never as a KeyboardEvent name", async () => {
    // The zone model (`zone-nav.tsx`) put ← and → into the registry for the first time, and
    // `chordKeys` only knew ↑ and ↓ — the sheet would have printed the literal string
    // "ArrowLeft" in a keycap. The map is asserted through the RENDERED sheet, exactly as
    // the reader meets it, so deleting a cap from `chordKeys` goes red here.
    await mount({
      view: [
        b({ chord: "ArrowLeft", group: "navigate", label: "walk left", run: () => {} }),
        b({ chord: "ArrowRight", group: "navigate", label: "walk right", run: () => {} }),
      ],
      sheetOpen: true,
    });
    for (const [label, cap] of [["walk left", "←"], ["walk right", "→"]] as const) {
      const row = [...host!.querySelectorAll("li")].find((li) =>
        (li.textContent ?? "").includes(label),
      );
      expect(row, `the sheet lost the ${label} row`).toBeTruthy();
      expect([...row!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual([cap]);
    }
  });

  it("it lists the binding that would actually RUN, not every declaration", async () => {
    // Same precedence walk as the dispatcher: in the Screener the sheet must say `c` files
    // to Receipts, not that `c` writes a new message.
    await mount({
      global: [b({ chord: "c", label: "write a new message", run: () => {} })],
      view: [b({ chord: "c", group: "screener", label: "file to Receipts", run: () => {} })],
      sheetOpen: true,
    });
    expect(text()).toContain("file to Receipts");
    expect(text()).not.toContain("write a new message");
  });

  it("an inert binding is still listed — a key that hides when idle is a key nobody learns", async () => {
    await mount({
      global: [b({ chord: "r", group: "message", label: "reply inside the message", disabled: true, run: () => {} })],
      sheetOpen: true,
    });
    const row = [...host!.querySelectorAll("li")].find((li) =>
      (li.textContent ?? "").includes("reply inside the message"),
    );
    expect(row).toBeTruthy();
    expect(row!.className).toContain("off");
  });

  it("it is a dialog, and it groups under the headings the bindings name", async () => {
    await mount({
      global: [
        b({ chord: "/", group: "navigate", label: "search", run: () => {} }),
        b({ chord: "?", group: "app", label: "this list", run: () => {} }),
      ],
      sheetOpen: true,
    });
    // The shortcuts requirement asks for a [role=dialog] whose text mentions shortcuts — this is that.
    const dialog = host!.querySelector("[role=dialog]");
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("Keyboard shortcuts");
    // The groups are h3 under the sheet's h2 title (one heading level per surface).
    expect([...host!.querySelectorAll("h3")].map((x) => x.textContent)).toEqual([
      "Move around",
      "App",
    ]);
  });

  it("any key dismisses it — a peek, not a mode", async () => {
    const counters = await mount({
      global: [b({ chord: "j", group: "navigate", label: "next", run: () => {} })],
      sheetOpen: true,
    });
    await key("j");
    expect(counters.closes).toBe(1);
  });
});

describe("no cursor is its own reason", () => {
  it("the SHEET says why, and the sentence follows the reason ALONE", async () => {
    /**
     * THE SHAPE KEY, watched.
     *
     * `useKeyBindings` re-registers only when its bindings change SHAPE, and the shape is a JSON
     * key over the fields the sheet renders. `disabledReason` is one of them now, and this is the
     * only place the difference is observable: both renders below are `disabled: true` with the
     * same chord, group and label, so if the key omitted the reason nothing would re-register,
     * `version` would not bump, the provider's memoised `bindings` array would stay as it was,
     * and the sheet would keep a sentence about a state that had gone.
     *
     * Not reachable through the shell — there, a cursor arriving flips a dozen bindings' `disabled`
     * at once and something always bumps — which is exactly why it is asserted here.
     */
    const resting = b({
      chord: "Backspace", group: "message", label: "Move it to Trash",
      disabled: true, disabledReason: "no_cursor" as const, run: () => {},
    });
    const { rerender } = await mount({ global: [resting], sheetOpen: true });
    const row = (): HTMLElement | undefined =>
      [...host!.querySelectorAll<HTMLElement>(".ks li")]
        .find((li) => (li.querySelector(".ks-lab")?.textContent ?? "") === "Move it to Trash");

    expect(row()).toBeDefined();
    expect(row()!.className).toContain("off");
    expect(row()!.getAttribute("title")).toBe(messages.shortcuts.needsCursor);

    /* THE SAME ROW, still resting, for a reason that is no longer the cursor. */
    await rerender({
      global: [b({
        chord: "Backspace", group: "message", label: "Move it to Trash",
        disabled: true, run: () => {},
      })],
      sheetOpen: true,
    });
    expect(row()!.className, "the row stopped resting, so this proves nothing").toContain("off");
    expect(
      row()!.getAttribute("title"),
      "the sentence outlived the reason it describes — the shape key does not carry it",
    ).toBeNull();
  });

  it("a row needs a cursor only if EVERY chord on it does", async () => {
    /* ⌫ and ⌦ fold onto one row because they share a label. A row whose second spelling is live
       is not waiting for anything, and telling its reader to select a message first would be
       false — the same argument `disabled` is folded under. */
    await mount({
      global: [
        b({
          chord: "Backspace", group: "message", label: "Move it to Trash",
          disabled: true, disabledReason: "no_cursor", run: () => {},
        }),
        b({ chord: "Delete", group: "message", label: "Move it to Trash", run: () => {} }),
      ],
      sheetOpen: true,
    });
    const row = [...host!.querySelectorAll<HTMLElement>(".ks li")]
      .find((li) => (li.querySelector(".ks-lab")?.textContent ?? "") === "Move it to Trash");
    expect(row).toBeDefined();
    expect(row!.getAttribute("title")).toBeNull();
  });
});
