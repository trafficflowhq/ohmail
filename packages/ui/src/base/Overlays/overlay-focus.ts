/**
 * What every overlay owes the keyboard: the keys go into it as it opens, stay in it while it is
 * open, and go back to what opened it. A modal part takes them on every device; a menu or a phone
 * sheet leaves them where they are when a finger is used.
 */
import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const CAN_FOCUS =
  'a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Everything in `box` the keys can reach, in order. */
export const reachable = (box: Element): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(CAN_FOCUS)];

/** True where the page says a finger is used: the kit's own stylesheet answers, not the host. */
export const onTouch = (el: Element): boolean =>
  getComputedStyle(el).getPropertyValue("--oh-touch").trim() === "1";

type First = (box: HTMLElement) => HTMLElement | null | undefined;
type Anchor = () => Element | null | undefined;

/**
 * Moves the keys to `first(box)` when `open` turns true, and back to `anchor()`, or to what had
 * them, when it turns false or the overlay goes. `notOnTouch`: where a finger is used the keys stay
 * where they are (a menu, a phone sheet); a modal part never passes it.
 */
export function useOverlayFocus(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  first: First,
  anchor?: Anchor,
  notOnTouch = false,
): void {
  /* What is read as it opens: the newest of each, without opening again when one is handed in anew. */
  const how = useRef({ first, anchor, notOnTouch });
  useLayoutEffect(() => {
    how.current = { first, anchor, notOnTouch };
  });
  useLayoutEffect(() => {
    if (!open) return;
    /* A control that opened it takes the keys back; without one, whatever had them. */
    const back = how.current.anchor?.() ?? document.activeElement;
    const el = box.current;
    const stays = how.current.notOnTouch && el && onTouch(el);
    if (el && !stays) (how.current.first(el) ?? el).focus({ preventScroll: true });
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [open, box]);
}

/** Tab and Shift+Tab stay inside `box`: past its last stop comes its first. */
export function cycleTab(e: KeyboardEvent<HTMLElement>, box: HTMLElement): void {
  if (e.key !== "Tab") return;
  const stops = reachable(box);
  if (!stops.length) return;
  const at = stops.indexOf(document.activeElement as HTMLElement);
  const to = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at === stops.length - 1 ? 0 : at + 1;
  e.preventDefault();
  stops[to]!.focus();
}
