/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Menu, MenuItem } from "@ohmail/ui/base";

/**
 * ═══ WIDENING THE COLUMN TOOK THE KEYBOARD OUT OF THE OPEN MENU ════════════════════════════
 *
 * ── THE SEQUENCE ────────────────────────────────────────────────────────────────────────────
 *
 * The action bar folds whole groups of verbs behind More as its container narrows, and hands them
 * back to the row as it widens. "In the row or in the menu, never both" is one rule pair per group
 * in `action-bar.css`, keyed off the measurement's `data-admit`, so a widen switches a group's
 * MENU half off — and it can happen while the menu is open, with the keyboard on the very item
 * that leaves.
 *
 * Nothing repaired that. The item became `display: none` with focus on it; the browser blurs a
 * hidden element, so focus landed on `<body>`; and from there the menu's own key handler — which
 * is on the menu — never ran again. Arrow keys did nothing, and the next letter typed went
 * straight to the shell's mail shortcuts and acted on the message underneath the menu still on
 * screen.
 *
 * ── WHY AN INLINE `display` IS THE HONEST STAND-IN ──────────────────────────────────────────
 *
 * There is no layout engine and no stylesheet here, so a container query cannot be driven. What
 * the production rules DO is set `display: none` on the item, and `live()` asks
 * `getComputedStyle(el).display` — deliberately, so the question is answerable in both places
 * (see its own comment). Setting the property inline produces the same computed answer from the
 * same read. What this cannot reproduce is the browser's blur, so the blur is performed
 * explicitly in the case that is about it, and the case beside it covers the other order.
 *
 * ── WHY `MoreMenu` DIRECTLY AND NOT THE BAR ─────────────────────────────────────────────────
 *
 * The repair is the menu's, and the menu is shared: the message panel's ⋯ menu and the contact
 * popover mount the same component. Driving it through the bar would prove it for one of the
 * three callers and would need the whole admission machinery to change an item's `display`, which
 * jsdom cannot do at all. The harness wires the trigger and the menu exactly as `ActionBar` does
 * — the same shape `more-disclosure-dismiss.test.ts` uses, for the same reason.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Counts, because a wrong one sends the next person hunting. Pin the focus effect back to
 * mount-only (delete the repair effect, the one with no dependency array) and FOUR cases go red:
 * the three repair cases and the emptied-menu one, which reports "the emptied menu did not ask to
 * be dismissed: expected +0 to be 1". The fifth, "focus moved somewhere else ON PURPOSE", stays
 * green under that mutation and is meant to. Remove the single-character arm of `onKeyDown` and
 * exactly one case goes red — the letter one, at "a did not claim the event away from the document
 * listener" — while the positive control beside it (Enter, Tab, Space, a modified combo) stays
 * green.
 *
 * ── RE-POINTED (share reader-1, the switch's older tests) ───────────────────────────────────
 *
 * Today's `MoreMenu` leaves with today's shell: every menu of the new panel, More's among them, is the kit's `Menu`
 * (`packages/ui/src/base/Overlays/Menu.tsx`), so the harness wires the kit's menu to its trigger exactly as the new
 * panel does (`packages/app/src/reader/actions/ActionBar.tsx`: the trigger as the anchor, the caller's `onClose`),
 * and an item is found by its name. The repair cases and the keys a menu must not claim are red by their rows
 * (`GAP:kit`); the letter case retired with the case that holds it over the new shell
 * (`reader-panel-focus.test.tsx`, "a letter pressed inside the More menu does not reach the mail underneath").
 */
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** How many times the menu asked to be dismissed. */
let closes = 0;
/** Whether the harness's trigger holds focus — the caller's half of a dismissal. */
let triggerRef: React.RefObject<HTMLButtonElement | null> | null = null;
/** Every key that reached a DOCUMENT listener — the shell's mail shortcuts sit on one. */
let atDocument: string[] = [];
const onDocumentKey = (e: KeyboardEvent): void => { atDocument.push(e.key); };

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

beforeEach(() => {
  closes = 0;
  atDocument = [];
  /* Registered BEFORE the tree mounts, which is where the keymap registry's listener sits. */
  document.addEventListener("keydown", onDocumentKey);
});

afterEach(async () => {
  document.removeEventListener("keydown", onDocumentKey);
  await unmount();
  vi.restoreAllMocks();
});

/**
 * A trigger and the menu it opens, wired as the action bar wires them: the menu is a sibling of
 * the button, the button toggles on `click`, the menu is handed the button as its anchor, and the
 * CALLER returns focus to the trigger on dismissal (`MoreMenu`'s `onClose` contract).
 */
function Harness({ ids }: { ids: string[] }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  triggerRef = ref;
  return h("div", null,
    h("button", {
      ref, type: "button", "aria-haspopup": "menu", "aria-expanded": open,
      onClick: () => setOpen((o) => !o),
    }, "More"),
    h(Menu, {
      open,
      label: "More",
      anchor: ref,
      onClose: () => { closes += 1; setOpen(false); ref.current?.focus(); },
      children: ids.map((id) => h(MenuItem, { key: id, onPress: () => {}, children: id })),
    }));
}

async function mount(ids: string[]): Promise<void> {
  await unmount();
  closes = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(Harness, { ids }));
  });
}

const trigger = (): HTMLButtonElement => host!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const menu = (): HTMLElement | null => document.querySelector('[role="menu"]');
const item = (id: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => (el.textContent ?? "").trim() === id)!;
const shown = (): string[] =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .filter((el) => getComputedStyle(el).display !== "none")
    .map((el) => (el.textContent ?? "").trim());

/** A press, as a pointing device makes one — down, up, then click. */
async function pointer(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * The admission moving: `ids` leave the menu because the row has taken them back.
 *
 * `blur` reproduces what a browser does when the focused element becomes hidden. jsdom does not,
 * which is why it is a parameter and not an assumption — a repair that only handles the state
 * jsdom produces would do nothing in the product.
 */
async function widen(ids: string[], opts: { blur: boolean }): Promise<void> {
  await act(async () => {
    for (const id of ids) item(id).style.display = "none";
    if (opts.blur) (document.activeElement as HTMLElement | null)?.blur();
    // A widen is a new measurement, and the measurement is state — so the bar re-renders and so
    // does the menu. Re-rendering the same tree is how that arrives here.
    root!.render(h(Harness, { ids: LONG }));
  });
}

/** Five items, so "the nearest survivor" has a direction to be wrong about. */
const LONG = ["later", "aside", "resurface", "move", "draft"];

async function opened(): Promise<void> {
  await mount(LONG);
  await pointer(trigger());
  expect(menu(), "the press did not open the menu").not.toBeNull();
  expect(document.activeElement, "opening the menu did not put the keyboard in it")
    .toBe(item("later"));
}

describe("the admitted set moves under an open menu", () => {
  it("THE REGRESSION: the item under the keyboard leaves, and focus lands on a live one", async () => {
    await opened();
    // Walk to the third item, then let the group holding it go back to the row. `resurface` is
    // in the middle on purpose: focus must move to a NEIGHBOUR, not to the top of the list.
    await act(async () => { item("later").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await act(async () => { item("aside").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.activeElement, "the arrow keys did not walk the menu").toBe(item("resurface"));

    await widen(["later", "aside", "resurface"], { blur: true });

    expect(shown(), "the widen did not fold the group away").toEqual(["move", "draft"]);
    // Forward first: the nearest survivor after the item that left.
    expect(document.activeElement, "focus was left on the hidden item or on the document")
      .toBe(item("move"));
    // …and the keyboard is genuinely back IN the menu, not merely pointed at it.
    await act(async () => { item("move").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(document.activeElement, "ArrowDown did not move after the repair").toBe(item("draft"));
  });

  it("…and when nothing survives AFTER it, the nearest is the one BEFORE", async () => {
    /* The other direction, which a repair that always took `standing[0]` would pass by accident
       only when the survivor happens to be first. Here it is last. */
    await opened();
    for (const from of ["later", "aside", "resurface", "move"]) {
      await act(async () => { item(from).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    }
    expect(document.activeElement).toBe(item("draft"));
    await widen(["draft"], { blur: true });
    expect(shown()).toEqual(["later", "aside", "resurface", "move"]);
    expect(document.activeElement, "focus did not fall back to the preceding item").toBe(item("move"));
  });

  it("WITHOUT the browser's blur — the state a test DOM produces — it is repaired too", async () => {
    /* jsdom leaves focus on a `display:none` element; a real browser blurs it. Both orders have
       to end in the same place, or the guard beside this one measures the harness. */
    await opened();
    await widen(["later"], { blur: false });
    expect(shown()).toEqual(["aside", "resurface", "move", "draft"]);
    expect(document.activeElement, "the hidden item kept the keyboard").toBe(item("aside"));
  });

  it("a menu EMPTIED by a widen closes, and the trigger takes the keyboard", async () => {
    // A disclosure with nothing behind it is not a disclosure. The menu asks to be dismissed and
    // the caller returns focus — the same contract Escape and an outside press already use.
    await opened();
    await widen(LONG, { blur: true });
    expect(shown(), "something is still standing in the menu").toEqual([]);
    expect(closes, "the emptied menu did not ask to be dismissed").toBe(1);
    expect(menu(), "the menu is still mounted").toBeNull();
    expect(document.activeElement, "the trigger did not take the keyboard back")
      .toBe(triggerRef!.current);
  });

  it("THE CONTROL: focus moved somewhere else ON PURPOSE is not taken back", async () => {
    /* The repair fixes a reference the stylesheet invalidated. It is not a second "put the
       keyboard in the menu": without this case it could be, and every assertion above would
       still pass while the menu stole focus from whatever a person had moved to. */
    await opened();
    const elsewhere = trigger();
    await act(async () => { elsewhere.focus(); });
    await widen(["later"], { blur: false });
    expect(document.activeElement, "the menu took focus back off the control the person moved to")
      .toBe(elsewhere);
    expect(closes, "the menu dismissed itself over a focus move").toBe(0);
  });
});

describe("while the menu is open its keys are its own", () => {
  it("…and the keys a menu must NOT claim still pass: Enter, Tab, Space, and a modified combo", async () => {
    /* The positive control. A rule written as "swallow everything" would pass the case above and
       break the menu: Enter and Space are how a keyboard presses an item, Tab is the way out, and
       ⌘K belongs to the palette. Each is checked for reaching the document, which is what the
       claim would stop. Tab goes last: it leaves the menu, which closes. */
    await opened();
    for (const [key, init] of [
      ["Enter", {}],
      [" ", {}],
      ["k", { metaKey: true }],
      ["r", { ctrlKey: true }],
      ["Tab", {}],
    ] as Array<[string, KeyboardEventInit]>) {
      const before = atDocument.length;
      await act(async () => {
        item("later").dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
        );
      });
      expect(atDocument.length, `${key} was swallowed by the menu`).toBe(before + 1);
    }
    expect(menu(), "Tab left the menu drawn").toBeNull();
  });
});
