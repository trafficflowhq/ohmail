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

  /**
   * THE ITEM THE KEYBOARD IS ON, REMEMBERED — because `document.activeElement` cannot answer it
   * after the fact.
   *
   * When a rule makes the focused element `display: none`, the browser BLURS it: by the time
   * anything can react, focus is on `<body>` and nothing on screen knows the menu ever had it.
   * (A test DOM does not blur — it has no layout — so a repair written against `activeElement`
   * alone passes in a harness and does nothing in the product, which is the wrong way round.) A
   * `focusin` listener records the item while it is still the item.
   *
   * This effect is declared FIRST on purpose: effects run in declaration order, so the listener
   * is attached before the effect below moves focus into the menu, and the opening focus is
   * recorded like every other.
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
   * ── THE ADMITTED SET MOVES UNDER THE MENU, AND THE KEYBOARD MOVES WITH IT ──────────────────
   *
   * Widening the reading column hands a group back to the ROW, and the admission rules switch that
   * group's menu half off — while the menu is open, possibly with the keyboard on the very item
   * that leaves. Nothing repaired that: the item was hidden, the browser blurred it, and focus
   * landed on the document. Arrow keys then did nothing (the menu's own handler is on the menu,
   * and the keyboard was no longer in it) and the next letter typed was not the menu's — it
   * reached the shell's document-level shortcuts and acted on the mail underneath.
   *
   * NO DEPENDENCY ARRAY, deliberately. What changed is a computed style, decided by a container
   * query this component cannot subscribe to; the bar re-renders when the measurement publishes a
   * new answer (`bar-density.ts` holds it as state), and this asks the DOM the same question
   * `live()` already asks. A dependency naming the admitted set would be a SECOND copy of the
   * admission decision, kept in step by hand — the two-mechanism defect the static breakpoints
   * were retired for.
   *
   * It acts only when the item the menu was HOLDING has gone, and only while nothing outside the
   * menu has deliberately taken the keyboard since. Focus somebody moved on purpose is not taken
   * back: this repairs a reference the stylesheet invalidated and is not a second "put the
   * keyboard in the menu".
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
      return;
    }
    /**
     * ── AND EVERY OTHER SINGLE-CHARACTER KEY IS THE MENU'S TOO ────────────────────────────
     *
     * The paragraph above states the rule — while a menu is open its keys belong to it — and the
     * code kept it only for the five keys the menu ACTS on. Everything else went to the document,
     * which is where the shell's mail shortcuts live: with this menu open and the keyboard in it,
     * `a` parked the message underneath, `e` set it aside, `u` marked it unread. The menu was
     * still standing afterwards, over mail that had just changed under it, and nothing on screen
     * connected the two.
     *
     * A SINGLE CHARACTER WITH NO ⌘/⌃/⌥ is exactly the alphabet those shortcuts are written in —
     * a, e, r, b, u, x, j, k, t, s, m, d, and the ⇧ pairs, which arrive as `"I"` and `"F"` with
     * only `shiftKey` set. What it leaves alone is deliberate, and each exclusion has its own
     * reason rather than being a shorter list:
     *
     *   · `" "` is one character and is how a keyboard presses the focused item — claiming it
     *     would `preventDefault` the activation and make the menu unusable without a mouse;
     *   · `Enter`, `Tab` and the function keys are longer than one character, which is what
     *     keeps Enter's activation, Tab's way out of the menu and F5 intact;
     *   · a modified combo belongs to the application or the browser (⌘K opens the palette) and
     *     a menu has no claim on it.
     *
     * Same `claim()` as the acting keys, so the same `stopImmediatePropagation` reasoning above
     * applies: `stopPropagation` alone would not stop the registry's listener, which sits on the
     * same node as React's root container in the product.
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
