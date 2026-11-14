import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { animate } from "../../motion/motion.js";
import "./menu.css";
import { placeMenu, type Point } from "./menu-place.js";
import { cssRect } from "../ui-zoom.js";
import { closeTopmost, useOverlayEscape } from "./overlay-escape.js";
import { cycleTab, useOverlayFocus } from "./overlay-focus.js";
import "./overlay.css";

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /**
   * What it comes out of: the control that opened it, or a point in the window in the page's px (a right
   * click read through `cssPoint`, as `contextTrigger`, `Row` and `AgendaRow` hand it).
   * Left out: it comes up from the foot, on every device.
   */
  anchor?: RefObject<Element | null> | Point | Element;
  /** Its name, said to a screen reader. */
  label: string;
  /**
   * `context`: the verbs about the thing under the pointer, with their keys. `card`: a card of a few
   * lines and controls. `ask`: a question before an act. Left out: a short list.
   */
  kind?: "context" | "card" | "ask";
  /** A title over the list, and for a card a note at its right. */
  title?: string;
  aside?: string;
  /** Open upwards; align its right edge to the anchor's; twice as wide. */
  up?: boolean;
  right?: boolean;
  wide?: boolean;
  /** Stay at the anchor on the phone, where a menu otherwise comes up from the foot. */
  anchored?: boolean;
  children: ReactNode;
}

const ITEM = '[role^="menuitem"]:not(:disabled)';
const firstStop = (el: HTMLElement) =>
  el.querySelector<HTMLElement>(ITEM) ?? el.querySelector<HTMLElement>("button:not(:disabled)");

/**
 * A short list that comes out of the thing you pressed. The arrows, Home and End move; Enter runs;
 * Esc (wherever the keys are, the topmost first), Tab and a press beside it close it, and the keys go back
 * to what opened it.
 */
export function Menu(props: MenuProps) {
  const { open, onClose, anchor, label, kind, title, aside, up, right, wide, anchored, children } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const dialog = kind === "card" || kind === "ask";
  const point = anchor && "x" in anchor ? anchor : null;
  const x = point?.x;
  const y = point?.y;
  const from = anchor && !("x" in anchor) ? anchor : null;
  useOverlayFocus(open, box, firstStop, () => (from && "current" in from ? from.current : from), true);
  useOverlayEscape(open, box, onClose);
  useLayoutEffect(() => {
    const el = box.current;
    const stage = el?.parentElement;
    if (!open || !el || !stage || getComputedStyle(el).getPropertyValue("--oh-menu-sheet").trim() === "1")
      return;
    const room = cssRect(stage);
    const control = from && "current" in from ? from.current : from;
    const r = control ? cssRect(control) : undefined;
    const at =
      x !== undefined && y !== undefined
        ? { x: x - room.left, y: y - room.top }
        : r && {
            left: r.left - room.left,
            top: r.top - room.top,
            right: r.right - room.left,
            bottom: r.bottom - room.top,
          };
    if (!at) return;
    const to = placeMenu(at, { width: el.offsetWidth, height: el.offsetHeight }, room, { up, right });
    el.style.left = `${to.left}px`;
    el.style.top = `${to.top}px`;
    if (to.up) el.dataset.up = "";
    else delete el.dataset.up;
  }, [open, x, y, from, up, right]);
  useLayoutEffect(() => {
    if (open && box.current) animate(box.current, "pop", { ease: "--e-pop" });
  }, [open]);
  if (!open) return null;

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    /* A letter typed over an open menu is the menu's, never what lies underneath. A field in it still takes it. */
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      closeTopmost();
    } else if (e.key === "Tab") {
      if (dialog) cycleTab(e, el);
      else {
        e.preventDefault();
        onClose();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const items = [...el.querySelectorAll<HTMLElement>(ITEM)];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const move = e.key === "ArrowDown" ? 1 : -1;
      const to =
        e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + move + items.length) % items.length;
      items[to]?.focus();
      e.preventDefault();
    }
  };

  return (
    <div className="oh-over">
      <div className="oh-veil" data-veil="" data-dim={anchor ? undefined : ""} onPointerDown={onClose} />
      <div
        ref={box}
        className="oh-menu"
        role={dialog ? "dialog" : "menu"}
        aria-label={label}
        tabIndex={-1}
        data-kind={kind}
        data-wide={wide ? "" : undefined}
        data-anchored={anchored ? "" : undefined}
        data-sheet={anchor ? undefined : ""}
        onKeyDown={keys}
      >
        {title ? (
          <h4 className="oh-text oh-menu-title">
            {title}
            {aside ? <small className="oh-menu-aside">{aside}</small> : null}
          </h4>
        ) : null}
        {children}
      </div>
    </div>
  );
}
