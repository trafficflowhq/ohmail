"use client";

/**
 * The action bar's disclosure, as a menu that drops up. The bar folds whole verb groups away as its
 * container narrows, and "More" is the way back; it used to replace the bar with a second row, which
 * disconnected the press from the change. The menu anchors to its button, drops upward (the bar is
 * docked at the bottom of the reading area) and right-aligns to the last control. Inside `.abar`,
 * not a fixed popover: the fold rules hang off the bar — the measurement publishes `data-admit` on
 * `.abar` and one rule pair per group switches the row half on and the menu half off; anything
 * outside the bar would need a second JavaScript copy of that decision (`action-bar.css`). It answers
 * no questions: Resurface and Move keep their sub-row — their items close the menu and open the panel.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { BarVerb } from "./bar-density";

export interface MoreMenuItem {
  /** Stable key, and the value a test selects on. */
  id: string;
  label: ReactNode;
  /**
   * WHICH ADMISSIBLE VERB THIS ITEM IS, or absent for one that is only ever in the menu.
   *
   * Rendered as a class the admission rule switches off when the same verb is standing in the
   * row. Absent means "no row position at all" — Draft reply and Delete have never had one.
   *
   * The type is `BarVerb`, read from the module that owns the order, not a second copy of the
   * list: it used to name the five density GROUPS, and a group's members are admitted one by
   * one now, so a menu item and a row button that had drifted apart would type-check.
   */
  group?: BarVerb;
  /** Leading glyph, for the one item that carries one. */
  icon?: ReactNode;
  run: () => void;
}

export function MoreMenu({
  items,
  ariaLabel,
  anchor,
  onClose,
}: {
  items: MoreMenuItem[];
  ariaLabel: string;
  /**
   * The button that opened this, so a press on it is not read as a press outside. The menu used to
   * hold only `onClose` — right about ownership, wrong about the consequence: the dismissal listener
   * asks whether the press landed outside the MENU, and the trigger is outside the menu, so pressing
   * the open control counted as an outside press (see the listener below). `null` is a menu with no
   * anchor — every outside press dismisses, still correct for a caller with no trigger element.
   */
  anchor: HTMLElement | null;
  /**
   * Dismiss. The CALLER returns focus to the trigger — it owns the button, and the reference above
   * is read for one comparison and never focused or written to.
   */
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * The items that are actually on screen, in order.
   *
   * Read from the DOM rather than filtered from `items`, because WHICH of them are visible is
   * decided by the stylesheet's admission rules — the same rules that decide whether the group
   * is standing in the row. A roving focus computed from the props would step onto a
   * `display: none` item and appear to do nothing.
   */
  const live = useCallback(
    (): HTMLButtonElement[] =>
      [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
        // `display` and not `offsetParent`, deliberately. `offsetParent` is the browser's own
        // answer and is the more general one — and it is `null` for EVERY element in a DOM with
        // no layout engine, so a harness would see an empty menu and every keyboard assertion
        // in it would pass vacuously. The rules that fold an item away set `display: none` on
        // the item itself, so asking for that is both true in a browser and answerable without
        // one.
        .filter((el) => getComputedStyle(el).display !== "none"),
    [],
  );

  /**
   * The item the keyboard is on, remembered — `document.activeElement` cannot answer it after the
   * fact: when a rule makes the focused element `display: none`, the browser blurs it, and by the
   * time anything can react focus is on `<body>`. (A test DOM does not blur — no layout — so a
   * repair written against `activeElement` alone passes in a harness and does nothing in the
   * product.) A `focusin` listener records the item while it is still the item. Declared FIRST on
   * purpose: effects run in declaration order, so the listener is attached before the effect below
   * moves focus into the menu, and the opening focus is recorded like every other.
   */
  const heldRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (root == null) return;
    const onFocusIn = (e: FocusEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el?.getAttribute("role") === "menuitem") heldRef.current = el as HTMLButtonElement;
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, []);

  // Opening a menu puts the keyboard in it. Without this the reader would press More and then
  // have to Tab into what they just opened, which for a menu is not a disclosure at all.
  useEffect(() => {
    live()[0]?.focus();
  }, [live]);

  /**
   * The admitted set moves under the menu, and the keyboard moves with it. Widening the column hands
   * a group back to the row and the admission rules hide that group's menu half — possibly with the
   * keyboard on the very item that leaves: the browser blurred it, arrows died, and the next letter
   * reached the shell's document-level shortcuts and acted on the mail underneath. No dependency
   * array, deliberately: what changed is a computed style decided by a container query this
   * component cannot subscribe to — a dependency naming the admitted set would be a second copy of
   * the admission decision. It acts only when the item the menu was holding has gone, and only while
   * nothing outside has taken the keyboard since: it repairs a reference the stylesheet invalidated.
   */
  useEffect(() => {
    const held = heldRef.current;
    if (held == null) return; // the menu never had the keyboard
    const standing = live();
    if (standing.includes(held)) return; // the item is still admitted
    const active = document.activeElement;
    const elsewhere =
      active != null
      && active !== document.body
      && active !== document.documentElement
      && !(rootRef.current?.contains(active) ?? false);
    if (elsewhere) {
      heldRef.current = null;
      return;
    }
    if (standing.length === 0) {
      // Nothing is left behind the disclosure, so it is not a disclosure any more. The CALLER
      // returns focus to the trigger — the same contract every other dismissal here relies on.
      heldRef.current = null;
      onClose();
      return;
    }
    /* The NEAREST survivor by DOM order — forward first, then back — so the keyboard lands where
       the eye already is rather than at the top of a list that has just changed shape. Read from
       ALL the items, not from `standing`, because the one being left is not in `standing`. */
    const all = [
      ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const at = all.indexOf(held);
    const next =
      all.slice(at + 1).find((el) => standing.includes(el))
      ?? all.slice(0, Math.max(at, 0)).reverse().find((el) => standing.includes(el));
    /* Optional because `find` is, and NOT because there is a case where nothing is found: every
       member of `standing` came from the same query as `all`, and a forward search that finds
       nothing means `held` is the last item — so a survivor is behind it. A `?? standing[0]`
       fallback stood here for one revision and was removed: it declared a behaviour (jump to the
       top of the list) for a state that cannot arise, which the next reader would have taken for
       a guarantee this code keeps. */
    next?.focus();
  });

  /**
   * Dismiss on a press outside — and the trigger is not outside. `mousedown`, not `click`, matching
   * the tag picker and sender sheet: a `click` listener would race the very press that opened this
   * and close it in the same gesture. What was wrong is what counted as outside: `rootRef` is the
   * menu and the trigger is not inside it, so pressing the open control ran both halves of one press
   * — `mousedown` closed the menu, the following `click` toggled it open again; the menu could not
   * be dismissed by its own control. The anchor is excluded, exactly as `DatePicker` excludes its
   * own, so the trigger's toggle owns that press and one press is one dismissal.
   */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchor, onClose]);

  /**
   * A key the menu handles is the menu's, and nothing else's. `stopImmediatePropagation`, and
   * `stopPropagation` is NOT enough — measured on the deployed build: Escape dismissed the menu AND
   * closed the reader sheet underneath. The keyboard registry listens for `keydown` on `document`;
   * so does React (the App Router hydrates the whole document). Two bubble-phase listeners on one
   * node run in registration order, and `stopPropagation` does nothing about a sibling on the same
   * node — the registry's listener runs anyway. Called for every key the menu acts on, not only
   * Escape. Not reproducible under a test DOM (a harness mounts React into a `<div>`), so the guard
   * watches the CALL rather than the outcome — see `test/action-bar.test.ts`.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const buttons = live();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const claim = (): void => {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    };
    const move = (next: number): void => {
      claim();
      buttons[(next + buttons.length) % buttons.length]?.focus();
    };
    if (e.key === "ArrowDown") return move(at + 1);
    if (e.key === "ArrowUp") return move(at - 1);
    if (e.key === "Home") return move(0);
    if (e.key === "End") return move(buttons.length - 1);
    if (e.key === "Escape") {
      claim();
      onClose();
      return;
    }
    /**
     * And every other single-character key is the menu's too. The rule above was kept only for the
     * five keys the menu acts on; everything else reached the shell's mail shortcuts — with the menu
     * open, `a` parked the message underneath, `e` set it aside, `u` marked it unread. A single
     * character with no ⌘/⌃/⌥ is exactly the alphabet those shortcuts are written in (the ⇧ pairs
     * arrive as `"I"`/`"F"` with only `shiftKey` set). Left alone deliberately: `" "` is how a
     * keyboard presses the focused item; `Enter`, `Tab` and function keys are longer than one
     * character; a modified combo belongs to the application or the browser. Same `claim()` as the
     * acting keys, so the same `stopImmediatePropagation` reasoning applies.
     */
    if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) claim();
  };

  return (
    <div
      ref={rootRef}
      className="mmenu"
      role="menu"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-item={item.id}
          className={item.group ? `mm-item mm-${item.group}` : "mm-item"}
          onClick={() => item.run()}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
