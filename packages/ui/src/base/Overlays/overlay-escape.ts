/**
 * Escape closes the topmost open overlay of the kit (a dialog, a menu, a card, an ask, a sheet), once,
 * wherever the keys are. A key inside an open overlay is heard by that overlay's box, which keeps it
 * from the page underneath and asks its own fields first. A key anywhere else, the page under it or
 * nowhere (as when the control that had the keys turned disabled while it works), is heard by the one
 * listener kept here on the document while anything is open: in the capture phase, before the page.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";

interface Open {
  box: RefObject<HTMLElement | null>;
  close: () => void;
}

/** What is open, the newest last. */
const opened: Open[] = [];

function outside(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !opened.length) return;
  const at = event.target instanceof Node ? event.target : null;
  if (at && opened.some((o) => o.box.current?.contains(at))) return;
  event.preventDefault();
  event.stopPropagation();
  closeTopmost();
}

/** Closes the newest open overlay: what its box calls on Escape, whichever box has the keys. */
export function closeTopmost(): void {
  opened.at(-1)?.close();
}

/** Counts `box` among the open overlays while `open` is true; Escape from outside every box closes the newest. */
export function useOverlayEscape(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useLayoutEffect(() => {
    if (!open) return;
    const it: Open = { box, close: () => close.current() };
    opened.push(it);
    if (opened.length === 1) document.addEventListener("keydown", outside, true);
    return () => {
      opened.splice(opened.indexOf(it), 1);
      if (!opened.length) document.removeEventListener("keydown", outside, true);
    };
  }, [open, box]);
}
