"use client";

/**
 * THE ACTION BAR'S DISCLOSURE, AS A MENU THAT DROPS UP.
 *
 * The bar folds whole groups of verbs away as its container narrows, and "More" is the way back
 * to them. That used to REPLACE the bar with a second row of buttons in the same place: the row
 * you were looking at vanished, a different row appeared where it had been, and the only way
 * back was a Cancel button. Nothing on screen connected the press to the change, and the verbs
 * that were still standing in the row disappeared along with the ones that were not.
 *
 * A menu anchored to the button that opened it says what happened. It drops UPWARD because the
 * bar is docked at the bottom of the reading area — a menu opening downward would immediately
 * run off the bottom of the column — and it is right-aligned to the button, which is the last
 * control in the row, so it grows back across the bar it belongs to rather than out into the
 * mail.
 *
 * ── WHY IT LIVES INSIDE `.abar` AND IS NOT A FIXED POPOVER ───────────────────────────────
 *
 * The sender sheet and the tag picker are `position: fixed` popovers placed from a measured
 * anchor rectangle, and copying that here would have been wrong twice over. `.abar` is a
 * container-query CONTAINER, which makes it a containing block for positioned descendants — so a
 * `fixed` child would be positioned against the bar anyway, but by an accident of containment
 * rather than by intent. And the rules that decide which verbs are folded hang off the BAR: the
 * measurement publishes its answer as `data-admit` on `.abar`, and one rule pair per group
 * switches the row half on and the menu half off under that same predicate. An element outside
 * the bar could not be asked which groups are standing, so "in the row or in the menu, never
 * both" would have needed a second copy of the decision, in JavaScript, kept in step by hand —
 * which is precisely the two-mechanism defect the static breakpoints were retired for. See the
 * admission block at the foot of `action-bar.css`.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────────────
 *
 * It does not answer questions. Resurface and Move each need a WHEN or a WHERE, and those keep
 * the sub-row they already had: choosing from a strip that replaces the bar is a small ceremony
 * with its own Cancel, and nesting it inside a menu would make an eight-item menu with two
 * submenus out of a control that has four verbs. The menu items for those two close the menu and
 * open the panel, which is the same two-step the row's own buttons perform.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";

export interface MoreMenuItem {
  /** Stable key, and the value a test selects on. */
  id: string;
  label: ReactNode;
  /**
   * WHICH DENSITY GROUP THIS ITEM BELONGS TO, or absent for one that is only ever in the menu.
   *
   * Rendered as a class the admission rule switches off when the same group is standing in the
   * row. Absent means "no row position at all" — Draft reply has never had one.
   */
  group?: "defer" | "file" | "rall" | "tag" | "fwd";
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
   * THE BUTTON THAT OPENED THIS, so a press on it is not read as a press outside.
   *
   * The menu used to hold nothing but `onClose`, on the argument that the caller owns the trigger
   * and a menu holding a reference to it would be holding one more thing than it needs. That was
   * right about ownership and wrong about the consequence: the dismissal listener asks whether the
   * press landed outside the MENU, and the trigger is outside the menu, so pressing the open
   * control counted as an outside press. See the listener below for what that did.
   *
   * `null` is a menu with no anchor — every press outside the menu dismisses it, which is the
   * behaviour this had before and is still correct for a caller that does not have a trigger
   * element to give.
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

  // Opening a menu puts the keyboard in it. Without this the reader would press More and then
  // have to Tab into what they just opened, which for a menu is not a disclosure at all.
  useEffect(() => {
    live()[0]?.focus();
  }, [live]);

  /**
   * ── DISMISS ON A PRESS OUTSIDE — AND THE TRIGGER IS NOT OUTSIDE ────────────────────────────
   *
   * `mousedown` and not `click`, matching the tag picker and the sender sheet: a `click` listener
   * would race the very press that opened this and close it in the same gesture. That is still
   * true and is why the listener is NOT moved back to `click`.
   *
   * What was wrong is what counts as outside. `rootRef` is the menu, and the button that opened it
   * is not inside the menu — so pressing that button while the menu was open ran BOTH halves of a
   * single press: `mousedown` reached this listener and closed the menu, then the `click` that
   * followed reached the trigger's own toggle and opened it again. The menu could not be dismissed
   * by pressing its own control, which is the first thing anybody tries. One press, two handlers,
   * and they cancelled out.
   *
   * The anchor is excluded, exactly as `DatePicker` excludes its own. The trigger's toggle then
   * owns that press by itself, so one press is one dismissal.
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
   * A KEY THE MENU HANDLES IS THE MENU'S, AND NOTHING ELSE'S.
   *
   * **`stopImmediatePropagation`, and `stopPropagation` is NOT enough — this was measured on the
   * deployed build, not reasoned about.** Escape while the menu was open dismissed the menu AND
   * closed the reader sheet underneath it, so a reader who pressed Escape to put a menu away lost
   * the message they were reading.
   *
   * The mechanism is worth writing down because it is invisible from the component's own code.
   * The keyboard registry listens for `keydown` ON `document`. So does React: the App Router
   * hydrates the whole document, which makes `document` React's root container too. Two
   * bubble-phase listeners on the SAME node run in registration order, and `stopPropagation` only
   * stops the event moving to the next NODE — it does nothing about a second listener already
   * attached to the one it is on. React's runs first, this handler calls `stopPropagation`, and
   * the registry's listener runs anyway, one line later, on the same element.
   *
   * `stopImmediatePropagation` on the NATIVE event is the one that stops a sibling listener. It is
   * called for every key the menu acts on, not only Escape: while a menu is open its keys belong
   * to it, and a `j` that both moved the menu's focus and moved the mail cursor underneath would
   * be the same defect wearing different clothes.
   *
   * It cannot be reproduced under a test DOM, and that is stated rather than left to be
   * discovered: a harness mounts React into a `<div>`, so React's listener is on that div and a
   * plain `stopPropagation` genuinely does stop `document`. The guard therefore watches the CALL
   * rather than the outcome — see `test/action-bar.test.ts`.
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
    }
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
