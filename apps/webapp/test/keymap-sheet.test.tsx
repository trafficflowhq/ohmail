/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { useKeyBindings, type KeyBinding as Binding } from "@ohmail/app-logic/keys";
import { mountOvers, press } from "../../../packages/app/test/overs/over-world.js";
import messages from "../messages/en.json";

// The frame mounts its own registry and the registered shortcut overlay.
(globalThis as unknown as { React: unknown }).React = React;

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

interface Bindings {
  global?: Binding[];
  view?: Binding[];
}

function View({ bindings }: { bindings: Binding[] }) {
  useKeyBindings(bindings, "view");
  return null;
}

function mount(initial: Bindings) {
  let update!: React.Dispatch<React.SetStateAction<Bindings>>;

  function Place() {
    const [bindings, setBindings] = React.useState(initial);
    update = setBindings;
    useKeyBindings(bindings.global ?? [], "global");
    return <View bindings={bindings.view ?? []} />;
  }

  mountOvers(() => <Place />);
  act(() => press("?"));
  return { rerender: (next: Bindings) => act(() => update(next)) };
}

const sheet = () => screen.queryByRole("dialog", { name: messages.shortcuts.title });
const text = () => sheet()?.textContent ?? "";
const rowFor = (label: string) =>
  within(screen.getByRole("dialog", { name: messages.shortcuts.title })).queryByText(label)?.closest("p");
const caps = (row: Element) => [...row.querySelectorAll("kbd")].map((key) => key.textContent);

const b = (over: Partial<Binding> & Pick<Binding, "chord" | "run">): Binding => ({
  group: "app", label: `does ${over.chord}`, ...over,
});

describe("the ? sheet is GENERATED from the registry", () => {
  it("a binding nobody edited the sheet for still appears in it, with its keycaps", () => {
    // THE GUARD. Nothing below names this binding anywhere but the registration: no sheet
    // template, no message key, no list. Make `groupedBindings` return [] — or make
    // `ShortcutSheet` render a hand-written list instead of `bindings` — and it goes red,
    // which is exactly the failure the old (i)-panel sentence could never produce.
    mount({
      view: [b({ chord: "shift+z", group: "message", label: "invent a whole new verb", run: () => {} })],
    });
    expect(text()).toContain("invent a whole new verb");
    expect(caps(rowFor("invent a whole new verb")!)).toEqual(["⇧", "z"]);
  });

  it("every arrow chord renders as a keycap, never as a KeyboardEvent name", () => {
    // The zone model (`zone-nav.tsx`) put ← and → into the registry for the first time, and
    // `chordKeys` only knew ↑ and ↓ — the sheet would have printed the literal string
    // "ArrowLeft" in a keycap. The map is asserted through the RENDERED sheet, exactly as
    // the reader meets it, so deleting a cap from `chordKeys` goes red here.
    mount({
      view: [
        b({ chord: "ArrowLeft", group: "navigate", label: "walk left", run: () => {} }),
        b({ chord: "ArrowRight", group: "navigate", label: "walk right", run: () => {} }),
      ],
    });
    for (const [label, cap] of [["walk left", "←"], ["walk right", "→"]] as const) {
      const row = rowFor(label);
      expect(row, `the sheet lost the ${label} row`).toBeTruthy();
      expect(caps(row!)).toEqual([cap]);
    }
  });

  it("it lists the binding that would actually RUN, not every declaration", () => {
    // Same precedence walk as the dispatcher: in the Screener the sheet must say `c` files
    // to Receipts, not that `c` writes a new message.
    mount({
      global: [b({ chord: "c", label: "write a new message", run: () => {} })],
      view: [b({ chord: "c", group: "screener", label: "file to Receipts", run: () => {} })],
    });
    expect(text()).toContain("file to Receipts");
    expect(text()).not.toContain("write a new message");
  });

  it("an inert binding is still listed — a key that hides when idle is a key nobody learns", () => {
    mount({
      global: [b({ chord: "r", group: "message", label: "reply inside the message", disabled: true, run: () => {} })],
    });
    const row = rowFor("reply inside the message");
    expect(row).toBeTruthy();
    expect(row!.getAttribute("aria-disabled")).toBe("true");
  });

  it("it is a dialog, and it groups under the headings the bindings name", () => {
    mount({
      global: [
        b({ chord: "/", group: "navigate", label: "search", run: () => {} }),
        b({ chord: "?", group: "app", label: "this list", run: () => {} }),
      ],
    });
    const dialog = sheet();
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("Keyboard shortcuts");
    expect(within(dialog!).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Move around",
      "App",
    ]);
  });

  it("any key dismisses it — a peek, not a mode", () => {
    const moved: string[] = [];
    mount({
      global: [b({ chord: "j", group: "navigate", label: "next", run: () => moved.push("j") })],
    });
    expect(sheet()).toBeTruthy();
    act(() => press("j"));
    expect(sheet()).toBeNull();
    expect(moved).toEqual([]);
  });
});

describe("no cursor is its own reason", () => {
  it("the SHEET says why, and the sentence follows the reason ALONE", () => {
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
    const { rerender } = mount({ global: [resting] });
    const row = () => rowFor("Move it to Trash");

    expect(row()).toBeTruthy();
    expect(row()!.getAttribute("aria-disabled")).toBe("true");
    expect(row()!.getAttribute("title")).toBe(messages.shortcuts.needsCursor);

    /* THE SAME ROW, still resting, for a reason that is no longer the cursor. */
    rerender({
      global: [b({
        chord: "Backspace", group: "message", label: "Move it to Trash",
        disabled: true, run: () => {},
      })],
    });
    expect(row()!.getAttribute("title"), "the open overlay keeps its original registry snapshot")
      .toBe(messages.shortcuts.needsCursor);
    act(() => press("Escape"));
    expect(sheet()).toBeNull();
    act(() => press("?"));
    expect(row()!.getAttribute("aria-disabled"), "the row stopped resting").toBe("true");
    expect(
      row()!.getAttribute("title"),
      "the sentence outlived the reason it describes — the shape key does not carry it",
    ).toBeNull();
  });

  it("a row needs a cursor only if EVERY chord on it does", () => {
    /* ⌫ and ⌦ fold onto one row because they share a label. A row whose second spelling is live
       is not waiting for anything, and telling its reader to select a message first would be
       false — the same argument `disabled` is folded under. */
    mount({
      global: [
        b({
          chord: "Backspace", group: "message", label: "Move it to Trash",
          disabled: true, disabledReason: "no_cursor", run: () => {},
        }),
        b({ chord: "Delete", group: "message", label: "Move it to Trash", run: () => {} }),
      ],
    });
    const row = rowFor("Move it to Trash");
    expect(row).toBeTruthy();
    expect(caps(row!)).toEqual(["⌫", "⌦"]);
    expect(row!.getAttribute("title")).toBeNull();
  });
});
