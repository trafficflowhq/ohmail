import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Button } from "../Primitives/Button.js";
import "./menu.css";
import { EDGE, placeMenu, type MenuFit, type Point } from "./menu-place.js";
import { cssRect } from "../ui-zoom.js";
import { closeTopmost, useOverlayEscape } from "./overlay-escape.js";
import { cycleTab, useOverlayFocus } from "./overlay-focus.js";
import "./overlay.css";

export interface MenuProps {
  open: boolean;
  id?: string;
  modal?: boolean;
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
  /**
   * A title over the whole list, and for a card a note at its right. A menu of more than one titled group leaves
   * it out and holds a `MenuGroup` for each, so that each group is said by its own title.
   */
  title?: string;
  aside?: string;
  /** Open upwards; align its right edge to the anchor's; twice as wide. */
  up?: boolean;
  right?: boolean;
  wide?: boolean;
  /** Stay at the anchor on the phone, where a menu otherwise comes up from the foot. */
  anchored?: boolean;
  /** Keep an anchored card whole, or let a row menu scroll beside its trigger. */
  fit?: MenuFit;
  /** Show a named close control if the menu takes the viewport's full height. */
  closeWhenFull?: string;
  /** The control that takes focus when the overlay opens. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * The app's own keys over this menu (a card's digits, the key that sends), asked before Esc, Tab and the
   * arrows. True: the key was taken, and the menu does nothing with it. Taken or not, it never reaches what
   * lies under the menu. A key it takes keeps its browser default unless it cancels it (Mod+Enter on a focused
   * item would also press it).
   */
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
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
  const {
    open,
    id,
    modal,
    onClose,
    anchor,
    label,
    kind,
    title,
    aside,
    wide,
    anchored,
    closeWhenFull,
    initialFocus,
    onKey,
    children,
  } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const closeBar = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const dialog = kind === "card" || kind === "ask";
  const from = anchor && !("x" in anchor) ? anchor : null;
  useOverlayFocus(
    open,
    box,
    (el) => initialFocus?.current ?? firstStop(el),
    () => (from && "current" in from ? from.current : from),
    initialFocus === undefined,
  );
  useOverlayEscape(open, box, onClose);
  useMenuPosition(props, box, closeBar, setFull);
  if (!open) return null;

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    /* A letter typed over an open menu is the menu's, never what lies underneath. A field in it still takes it. */
    e.stopPropagation();
    if (onKey?.(e)) return;
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
        id={id}
        role={dialog ? "dialog" : "menu"}
        aria-modal={dialog && modal ? true : undefined}
        aria-label={label}
        tabIndex={-1}
        data-kind={kind}
        data-wide={wide ? "" : undefined}
        data-anchored={anchored ? "" : undefined}
        data-sheet={anchor ? undefined : ""}
        onKeyDown={keys}
      >
        {full && closeWhenFull ? (
          <div className="oh-menu-close" ref={closeBar}>
            <Button kind="quiet" icon="x" label={closeWhenFull} onPress={onClose} />
          </div>
        ) : null}
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

function useMenuPosition(
  { open, anchor, up, right, fit, closeWhenFull }: MenuProps,
  box: RefObject<HTMLDivElement | null>,
  closeBar: RefObject<HTMLDivElement | null>,
  setFull: (full: boolean) => void,
): void {
  const point = anchor && "x" in anchor ? anchor : null;
  const x = point?.x;
  const y = point?.y;
  const from = anchor && !("x" in anchor) ? anchor : null;
  useLayoutEffect(() => {
    const el = box.current;
    const stage = el?.parentElement;
    if (!open || !el || !stage) return;
    const position = () => {
      const room = cssRect(stage);
      const height =
        fit || closeWhenFull
          ? Math.max(el.offsetHeight, el.scrollHeight + el.offsetHeight - el.clientHeight)
          : el.offsetHeight;
      if (closeWhenFull && room.height > EDGE * 2)
        setFull(height - (closeBar.current?.offsetHeight ?? 0) >= room.height - EDGE * 2);
      if (getComputedStyle(el).getPropertyValue("--oh-menu-sheet").trim() === "1") {
        if (fit) {
          el.style.left = "";
          el.style.top = "";
          el.style.maxHeight = "";
          delete el.dataset.up;
        }
        return;
      }
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
      const to = placeMenu(at, { width: el.offsetWidth, height }, room, { up, right, fit });
      el.style.left = `${to.left}px`;
      el.style.top = `${to.top}px`;
      if (fit) el.style.maxHeight = to.maxHeight === undefined ? "" : `${to.maxHeight}px`;
      if (to.up) el.dataset.up = "";
      else delete el.dataset.up;
    };
    position();
    if (!fit && !closeWhenFull) return;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(position) : null;
    observer?.observe(el);
    observer?.observe(stage);
    const window = el.ownerDocument.defaultView;
    window?.addEventListener("resize", position);
    return () => {
      observer?.disconnect();
      window?.removeEventListener("resize", position);
    };
  }, [open, x, y, from, up, right, fit, closeWhenFull, box, closeBar, setFull]);
}
