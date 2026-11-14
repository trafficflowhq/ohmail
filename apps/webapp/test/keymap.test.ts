/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys/keymap";
import messages from "../messages/en.json";

/**
 * THE KEYBOARD REGISTRY.
 *
 * Two claims are made of it and they are the two the product makes:
 *
 *   1. the keys ARE integrated — one dispatcher, with a stated precedence, instead of six
 *      `document` listeners racing in mount order (this file, over the registry as the frame
 *      stands it); and
 *   2. they are VISIBLE — the `?` sheet is a projection of the dispatcher's own table, so
 *      it cannot list a key that does nothing or omit one that does (`keymap-sheet.test.tsx`).
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

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { await unmount(); vi.useRealTimers(); });

type Binding = import("@ohmail/app-logic/keys/keymap").KeyBinding;

/** The frame's own registry: one store under its context, as `OwnKeys` of the frame mounts it. */
function Registry({ children }: { children: React.ReactNode }): React.ReactElement {
  return h(KeymapContext.Provider, { value: useKeymapStore() }, children);
}

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
 * Mount the registry as the frame stands it (`OwnKeys` of `packages/app/src/frame/Frame.tsx`: one
 * `useKeymapStore()` under `KeymapContext`) holding `global` bindings, with a child holding `view`
 * ones. Nothing here is a stand-in: the dispatcher is the shipped one. (The `?` sheet's cases are in
 * `keymap-sheet.test.tsx`.)
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
  rerender: (next: MountOpts) => Promise<void>;
}> {
  await unmount();
  const { useKeyBindings, useCursorPlacer } = await import("@ohmail/app-logic/keys/keymap");
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
    return h(View, { o });
  }

  const draw = async (o: MountOpts): Promise<void> => {
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(Registry, { children: h(Shell, { o }) }),
        }),
      );
    });
  };

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await draw(opts);
  return { rerender: draw };
}

const b = (over: Partial<Binding> & Pick<Binding, "chord" | "run">): Binding => ({
  group: "app", label: `does ${over.chord}`, ...over,
});

describe("one dispatcher, with a stated precedence", () => {
  it("a view binding beats a global one on the same key", async () => {
    // The concrete case: `c` is Compose everywhere and Receipts in the Screener. Before the
    // registry the shell carried a `screenerOwnsC` special case that read the Screener's
    // state to guess. Precedence is a rule now — and it CANNOT be registration order,
    // because React runs a child's effects before its parent's.
    const ran: string[] = [];
    await mount({
      global: [b({ chord: "c", run: () => ran.push("global") })],
      view: [b({ chord: "c", run: () => ran.push("view") })],
    });
    await key("c");
    expect(ran).toEqual(["view"]);
  });

  it("a DISABLED view binding falls through to the global one", async () => {
    const ran: string[] = [];
    await mount({
      global: [b({ chord: "c", run: () => ran.push("global") })],
      view: [b({ chord: "c", disabled: true, run: () => ran.push("view") })],
    });
    await key("c");
    expect(ran).toEqual(["global"]);
  });

  it("keys stop when the view unmounts — no listener outlives its owner", async () => {
    const ran: string[] = [];
    await mount({ view: [b({ chord: "j", run: () => ran.push("j") })] });
    await key("j");
    await unmount();
    await key("j");
    expect(ran).toEqual(["j"]);
  });

  it("typing is typing: a plain letter is ignored in a text field, Escape is not", async () => {
    const ran: string[] = [];
    await mount({
      global: [
        b({ chord: "j", run: () => ran.push("j") }),
        b({ chord: "Escape", inInput: true, run: () => ran.push("esc") }),
      ],
    });
    const input = document.createElement("input");
    host!.appendChild(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(ran).toEqual(["esc"]);
  });

  it("a plain letter does not swallow its shifted twin", async () => {
    // ⇧O files-and-marks-read in the Screener; o just files. Drop the shift check in
    // `chordMatches` and the shifted binding becomes unreachable while the sheet still
    // documents it.
    const ran: string[] = [];
    await mount({
      view: [
        b({ chord: "o", run: () => ran.push("o") }),
        b({ chord: "shift+o", run: () => ran.push("O") }),
      ],
    });
    await key("o");
    await key("O", { shiftKey: true });
    expect(ran).toEqual(["o", "O"]);
  });

  it("⌘K is a chord, not the letter k", async () => {
    const ran: string[] = [];
    await mount({
      global: [
        b({ chord: "mod+k", inInput: true, run: () => ran.push("palette") }),
        b({ chord: "k", run: () => ran.push("prev") }),
      ],
    });
    await key("k", { metaKey: true });
    await key("k");
    expect(ran).toEqual(["palette", "prev"]);
  });

  it("AltGr produces characters; Alt chords stay refused", async () => {
    // On a German layout `[` is AltGr+8, and Windows spells AltGr as ctrl+alt — so a flat
    // altKey⇒no in `chordMatches` made the Screener's section walk unreachable on exactly
    // the keyboards it was added for. A press COMPOSED with AltGr is judged by the
    // character it produced; a plain Alt chord is still nobody's (the collision policy).
    const ran: string[] = [];
    await mount({
      view: [b({ chord: "[", run: () => ran.push("[") })],
    });
    // AltGr-composed: alt+ctrl down, AltGraph modifier state set — the character wins.
    await key("[", { altKey: true, ctrlKey: true, modifierAltGraph: true });
    // A plain Alt chord: refused, exactly as before.
    await key("[", { altKey: true });
    expect(ran).toEqual(["["]);
  });

  it("the AltGr exemption is for CHARACTERS — AltGr+Enter is still an Alt chord", async () => {
    // AltGr types `[`; it does not type Enter. An AltGr exemption that forgot this let
    // AltGr+Enter activate a bare-Enter binding (review finding, round 2).
    const ran: string[] = [];
    await mount({
      view: [b({ chord: "Enter", run: () => ran.push("open") })],
    });
    await key("Enter", { altKey: true, ctrlKey: true, modifierAltGraph: true });
    expect(ran).toEqual([]);
    await key("Enter");
    expect(ran).toEqual(["open"]);
  });

  it("an OVERLAY binding beats a view one on the same key", async () => {
    // The rank the registry was missing. The shell's overlays — the `?` sheet, the palette,
    // a popover — are registered by an ANCESTOR of the view, so by mount order they are the
    // outermost thing in the app and by intent they are the innermost. Two scopes could only
    // express the first, which is why a picked set in the Ohbox stole Escape from all three.
    const ran: string[] = [];
    await mount({
      global: [b({ chord: "Escape", run: () => ran.push("global") })],
      view: [b({ chord: "Escape", run: () => ran.push("view") })],
      overlay: [b({ chord: "Escape", run: () => ran.push("overlay") })],
    });
    await key("Escape");
    expect(ran).toEqual(["overlay"]);
  });

  it("a DISABLED overlay binding falls through to the view — nothing open, nothing claimed", async () => {
    // The other half of the rule, and the reason it cannot rot: the shell's Escape is live
    // only while something is open, so "an overlay owns Escape" costs the view nothing the
    // rest of the time. Without this the selection would become unclearable.
    const ran: string[] = [];
    await mount({
      global: [b({ chord: "Escape", run: () => ran.push("global") })],
      view: [b({ chord: "Escape", run: () => ran.push("view") })],
      overlay: [b({ chord: "Escape", disabled: true, run: () => ran.push("overlay") })],
    });
    await key("Escape");
    expect(ran).toEqual(["view"]);
  });

  it("g o is a sequence — and g alone is not `go to Ohbox`", async () => {
    // The ⌘K palette has advertised `g o` since it shipped and nothing implemented it.
    const ran: string[] = [];
    await mount({
      global: [
        b({ chord: "g o", run: () => ran.push("ohbox") }),
        b({ chord: "o", run: () => ran.push("plain-o") }),
      ],
    });
    await key("g");
    expect(ran).toEqual([]);
    await key("o");
    expect(ran).toEqual(["ohbox"]);
    // …and a bare `o` still means what it means.
    await key("o");
    expect(ran).toEqual(["ohbox", "plain-o"]);
  });
});


/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A MESSAGE VERB RESTING FOR WANT OF A CURSOR — the registry's half of the rule
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `cursorless-first-press.test.tsx` proves the OUTCOME on the shipped shell: the ring on the
 * first row, the sentence, nothing on the wire. These are the registry's own rules, which that
 * file cannot reach — the placer's argument, the precedence between two claims, and the two
 * filters that decide which resting bindings this can touch at all. Each one is a way for the
 * rule to be wrong while every screen still looks right.
 */
describe("no cursor is its own reason", () => {
  /** Dispatch and hand back the event, so `defaultPrevented` can be read. */
  const press = async (k: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    await act(async () => { document.dispatchEvent(e); });
    return e;
  };

  const parked = (over: Partial<Binding> & Pick<Binding, "chord" | "run">): Binding =>
    b({ group: "message", disabled: true, disabledReason: "no_cursor", ...over });

  it("the placer is called with the PRESSED binding's label, and the binding does not run", async () => {
    /* The label is what makes one sentence work for every verb — "press again: Move it to Trash"
       is the binding's own words, not a phrase per verb. A placer handed the wrong binding's
       label is the hard stop this case exists for. */
    const ran: string[] = [];
    const asked: string[] = [];
    await mount({
      global: [
        parked({ chord: "Backspace", label: "Move it to Trash", run: () => ran.push("delete") }),
        parked({ chord: "e", label: "Park it", run: () => ran.push("park") }),
      ],
      place: (label) => { asked.push(label); return true; },
    });

    const e = await press("e");
    expect(asked).toEqual(["Park it"]);
    expect(ran, "the first press performed").toEqual([]);
    expect(e.defaultPrevented, "the press that placed a cursor was not consumed").toBe(true);
  });

  it("a placer that places NOTHING consumes nothing — the press stays as inert as it was", async () => {
    /* An empty list, or a surface no claimant holds a cursor for. Swallowing the key there would
       make an empty Ohbox feel like a broken one, and would take the keystroke away from whatever
       the browser would otherwise have done with it. */
    const ran: string[] = [];
    await mount({
      global: [parked({ chord: "Backspace", run: () => ran.push("delete") })],
      place: () => false,
    });
    const e = await press("Backspace");
    expect(ran).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("with NO placer claimed at all, nothing happens and nothing is consumed", async () => {
    const ran: string[] = [];
    await mount({ global: [parked({ chord: "Backspace", run: () => ran.push("delete") })] });
    const e = await press("Backspace");
    expect(ran).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("ONE placer answers and nothing falls through — a decline is not re-asked of another host", async () => {
    /* The fallthrough is the tempting shape and it is wrong: `false` means both "my list is
       empty" and "not my surface", so a second host asked after the first declined would draw
       the ring on a row the pressed verb does not act on. The one asked is the MOST RECENT claim
       — here the shell's, whose effect React runs after the view's — and the earlier claim is not
       consulted even though it would have answered yes. */
    const asked: string[] = [];
    const earlier: string[] = [];
    const e = await mount({
      global: [parked({ chord: "Backspace", label: "Move it to Trash", run: () => {} })],
      place: (l) => { asked.push(l); return false; },
      placeEarlier: (l) => { earlier.push(l); return true; },
    }).then(async () => press("Backspace"));
    expect(asked).toEqual(["Move it to Trash"]);
    expect(earlier, "a declined press was re-asked of a second host").toEqual([]);
    expect(e.defaultPrevented, "nothing was placed and the press was consumed anyway").toBe(false);
  });

  it("a VIEW's claim answers, though the SHELL claimed later — scope, not recency", async () => {
    /* React runs a child's effects before its parent's, so the shell is the more recent claim on
       every render. Split views hold their own list cursor and the shell holds none for their
       routes: by recency alone the answer comes from a host that declines, and the first press on
       Folder, Tag or History stays silent. `PlacerScope` states the rank the tree says wrong. */
    const shellAsked: string[] = [];
    const viewAsked: string[] = [];
    await mount({
      global: [parked({ chord: "e", label: "Park it", run: () => {} })],
      place: (l) => { shellAsked.push(l); return true; },
      placeInView: (l) => { viewAsked.push(l); return true; },
    });
    const e = await press("e");
    expect(viewAsked, "the view's claim was not the one asked").toEqual(["Park it"]);
    expect(shellAsked, "the shell answered over a view that holds the cursor").toEqual([]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("…and a DECLINING view claim still ends it — the shell is not asked afterwards", async () => {
    /* The no-fall-through rule, one rank up: a view whose list is empty answers `false`, and a
       shell asked after it would draw a ring on a list the pressed verb does not act on. */
    const shellAsked: string[] = [];
    await mount({
      global: [parked({ chord: "e", label: "Park it", run: () => {} })],
      place: (l) => { shellAsked.push(l); return true; },
      placeInView: () => false,
    });
    const e = await press("e");
    expect(shellAsked, "a declined view claim was handed on to the shell").toEqual([]);
    expect(e.defaultPrevented, "nothing was placed and the press was consumed anyway").toBe(false);
  });

  it("with NO view claim the shell answers as before — the scope narrows nothing", async () => {
    /* The positive control for the two cases above: `global` is the default, so every route no
       view claims for is still the shell's, which is every route the shipped app has today. */
    const shellAsked: string[] = [];
    await mount({
      global: [parked({ chord: "e", label: "Park it", run: () => {} })],
      place: (l) => { shellAsked.push(l); return true; },
    });
    await press("e");
    expect(shellAsked).toEqual(["Park it"]);
  });

  it("a binding disabled for ANOTHER reason is untouched — no reason, no placement", async () => {
    const asked: string[] = [];
    await mount({
      global: [b({ chord: "R", group: "message", disabled: true, run: () => {} })],
      place: (l) => { asked.push(l); return true; },
    });
    const e = await press("R", { shiftKey: false });
    expect(asked).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("the rule is scoped to the MESSAGE group — an app verb waiting on its own state is not a cursor", async () => {
    const asked: string[] = [];
    await mount({
      global: [b({
        chord: "p", group: "app", label: "Pull new mail now",
        disabled: true, disabledReason: "no_cursor", run: () => {},
      })],
      place: (l) => { asked.push(l); return true; },
    });
    await press("p");
    expect(asked, "an app-group binding placed a message cursor").toEqual([]);
  });

  it("an ENABLED binding still wins outright — the parked walk is LAST", async () => {
    /* The ordering that makes this rule additive: nothing that does something today can be
       diverted into placing a cursor instead. A resting declaration ahead of a live one in
       dispatch order is the exact case, and the live one must still run. */
    const ran: string[] = [];
    const asked: string[] = [];
    await mount({
      view: [parked({ chord: "e", run: () => ran.push("parked") })],
      global: [b({ chord: "e", group: "message", run: () => ran.push("live") })],
      place: (l) => { asked.push(l); return true; },
    });
    await press("e");
    expect(ran).toEqual(["live"]);
    expect(asked).toEqual([]);
  });

  it("a `when` that says no places nothing — auto-repeat and an open dialog are not presses", async () => {
    /* Both of the delete factory's conditions live in `when`, and they have to be asked BEFORE
       the placer: a finger resting on ⌫ would otherwise place a cursor per repeat, and a press
       under a dialog would place one behind it. */
    const asked: string[] = [];
    await mount({
      global: [parked({ chord: "Backspace", when: (e) => !e.repeat, run: () => {} })],
      place: (l) => { asked.push(l); return true; },
    });
    await press("Backspace", { repeat: true });
    expect(asked).toEqual([]);
    // THE CONTROL: the same binding, the same key, pressed rather than held.
    await press("Backspace");
    expect(asked).toHaveLength(1);
  });

  it("typing is typing: a resting verb pressed in a text field places nothing", async () => {
    /* The filter the parked walk shares with the live one, asserted because it is SHARED code:
       a message verb pressed in a field is a character, and a placer reached from there would
       move the cursor in the list behind whatever somebody is writing. */
    const asked: string[] = [];
    await mount({
      global: [parked({ chord: "e", run: () => {} })],
      place: (l) => { asked.push(l); return true; },
    });
    const input = document.createElement("input");
    host!.appendChild(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    });
    expect(asked).toEqual([]);
  });

  it("`press` from a CLICK never places a cursor — a button is not a keystroke", async () => {
    /* `Registry.press` skips disabled bindings, and it must keep doing so: a control is only
       drawn where there is something to act on, so a click that placed a cursor would be a
       button that did something other than what it says. */
    const asked: string[] = [];
    let pressed: boolean | null = null;
    const { useKeyBindings, useKeymap, useCursorPlacer } =
      await import("@ohmail/app-logic/keys/keymap");
    function Probe(): null {
      useKeyBindings([b({
        chord: "Backspace", group: "message", disabled: true,
        disabledReason: "no_cursor", run: () => {},
      })], "global");
      useCursorPlacer((l) => { asked.push(l); return true; });
      const km = useKeymap();
      React.useEffect(() => { pressed = km.press("Backspace"); }, [km]);
      return null;
    }
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(Registry, { children: h(Probe) }));
    });
    expect(pressed).toBe(false);
    expect(asked).toEqual([]);
  });


  it("the placer is read LIVE — a caller that does not memoise still gets its current closure", async () => {
    /**
     * WHY THE HOOK HOLDS A REF.
     *
     * `useCursorPlacer`'s effect depends on the stable `claimCursorPlacer` alone, so it runs ONCE:
     * a claim that captured the function it was given would hold the FIRST render's closure for
     * the life of the mount, and a placer's whole job is to read the list and the cursor as they
     * are at the keypress. That is the failure `Registry.press` exists to avoid, one layer over —
     * and it is invisible through `AppShell`, whose `placeCursor` is a `useStableCallback` that
     * reads a ref of its own. A second mechanism covering for the one under test measures the
     * pair, so this case passes a PLAIN closure, which is what the hook's contract permits.
     *
     * Mutate the hook to `claimCursorPlacer(place)` and this reads the first render's value.
     */
    const seen: number[] = [];
    const placerFor = (n: number) => (): boolean => { seen.push(n); return true; };
    const binding = parked({ chord: "Backspace", run: () => {} });
    const { rerender } = await mount({ global: [binding], place: placerFor(1) });
    await press("Backspace");
    expect(seen).toEqual([1]);

    await rerender({ global: [binding], place: placerFor(2) });
    await press("Backspace");
    expect(seen, "the claim held a closure from an earlier render").toEqual([1, 2]);
  });
});

describe("reading the registry pins no earlier render", () => {
  it("a shell that shows its own key and re-declares it each render lets every earlier render go", async () => {
    /* The shell reads `b` back (`resurfaceKey`) and its next declaration closes over what it read:
       a published row carrying `run` chained every render's whole scope to the one before. */
    vi.useRealTimers();
    const v8 = await import("node:v8");
    const vm = await import("node:vm");
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const { useKeyBindings, useEnabledBinding } = await import("@ohmail/app-logic/keys/keymap");
    const renders: Array<WeakRef<object>> = [];
    const held: unknown[] = [];
    function Shell({ n }: { n: number }): null {
      const own = useEnabledBinding("b");
      const derived = { n, rows: new Array(2000).fill(n) };
      renders.push(new WeakRef(derived));
      useKeyBindings([b({ chord: "b", label: `resurface ${n}`, run: () => { held.push(own, derived); } })], "global");
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    for (let n = 0; n < 20; n++) {
      await act(async () => { root!.render(h(Registry, { children: h(Shell, { n }) })); });
    }
    await new Promise((r) => setTimeout(r, 0));
    gc();
    const early = renders.slice(0, renders.length - 6);
    expect(early.length).toBeGreaterThan(10);
    expect(early.filter((r) => r.deref() !== undefined).length, "earlier renders are still reachable").toBe(0);
  });
});
