import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../Primitives/Button.js";
import "./menu.css";
import { clearMenuReport, EDGE, placeMenu, type MenuFit, type Point } from "./menu-place.js";
import { cssRect } from "../ui-zoom.js";
import { closeTopmost, useOverlayEscape } from "./overlay-escape.js";
import { cycleTab, useOverlayFocus } from "./overlay-focus.js";
import { POPOVER_REPORT, popoverHost, portalRenderer } from "./portal-renderer.js";
import "./overlay.css";

export interface MenuProps {
  open: boolean;
  id?: string;
  modal?: boolean;
  /** Stand in the window's overlay layer when a scroller or toolbar would cover the menu. */
  portal?: boolean;
  onClose: () => void;
  /**
   * What it comes out of: the control that opened it, or a point in the window in the page's px (a right
   * click read through `cssPoint`, as `contextTrigger`, `Row` and `AgendaRow` hand it).
   * Left out: it comes up from the foot, on every device.
   */
  anchor?: RefObject<Element | null> | Point | Element;
  /** The control that opened a menu positioned at a point. */
  returnFocus?: RefObject<Element | null> | Element;
  /** Its name, said to a screen reader. */
  label: string;
  /**
   * `context`: the verbs about the thing under the pointer, with their keys. `card`: a card of a few
   * lines and controls. `picker`: a field followed by choices. `ask`: a question before an act.
   */
  kind?: "context" | "card" | "ask" | "picker";
  /**
   * A title over the whole list, and for a card a note at its right. A menu of more than one titled group leaves
   * it out and holds a `MenuGroup` for each, so that each group is said by its own title.
   */
  title?: string;
  aside?: string;
  /** Open upwards; align its right edge to the anchor's; twice as wide. */
  up?: boolean;
  /** Open above this element while keeping the trigger's horizontal alignment and focus. */
  upFrom?: Element;
  right?: boolean;
  wide?: boolean;
  /** Fit an ask to its contents within the available viewport. */
  fitContent?: boolean;
  /** Stay at the anchor on the phone, where a menu otherwise comes up from the foot. */
  anchored?: boolean;
  /** Keep an anchored card whole, or let a row menu scroll beside its trigger. */
  fit?: MenuFit;
  /** Show a named close control if the menu takes the viewport's full height. */
  closeWhenFull?: string;
  /** The control that takes focus when the overlay opens. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Whether an explicit initial field opens the keyboard on touch. */
  initialFocusOnTouch?: boolean;
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
const visible = (el: HTMLElement) => getComputedStyle(el).display !== "none";
const menuItems = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(ITEM)];
const firstStop = (el: HTMLElement) =>
  menuItems(el).find(visible) ?? [...el.querySelectorAll<HTMLElement>("button:not(:disabled)")].find(visible);

function focusMenuRow(box: HTMLElement, row: HTMLElement | undefined): void {
  if (!row) return;
  row.focus({ preventScroll: true });
  const pane = cssRect(box);
  const item = cssRect(row);
  const scale = pane.height / box.offsetHeight;
  if (!scale) return;
  const top = (item.top - pane.top) / scale - box.clientTop;
  const bottom = top + row.offsetHeight;
  if (top < 0) box.scrollTop += top;
  else if (bottom > box.clientHeight) box.scrollTop += bottom - box.clientHeight;
}

function moveMenuFocus(box: HTMLElement, key: string): void {
  const items = menuItems(box).filter(visible);
  const at = items.indexOf(box.ownerDocument.activeElement as HTMLElement);
  const move = key === "ArrowDown" ? 1 : -1;
  const to =
    key === "Home" ? 0 : key === "End" ? items.length - 1 : (at + move + items.length) % items.length;
  focusMenuRow(box, items[to]);
}

function repairMenuFocus(box: HTMLElement, held: HTMLElement, onClose: () => void): void {
  const { activeElement, body, documentElement } = box.ownerDocument;
  if (activeElement && activeElement !== held && activeElement !== body && activeElement !== documentElement)
    return;
  const items = menuItems(box);
  const at = items.indexOf(held);
  if (at >= 0 && visible(held)) return;
  const next = items.slice(at + 1).find(visible) ?? items.slice(0, Math.max(0, at)).reverse().find(visible);
  if (next) focusMenuRow(box, next);
  else onClose();
}

function claimKey(e: KeyboardEvent<HTMLDivElement>): void {
  e.preventDefault();
  e.stopPropagation();
  e.nativeEvent.stopImmediatePropagation();
}

function MenuVeil({ dim, onClose }: { dim: boolean; onClose: () => void }) {
  return (
    <div
      className="oh-veil"
      data-veil=""
      data-dim={dim ? "" : undefined}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") onClose();
      }}
      onClick={(event) => {
        // Keep the veil in place until a tap's click has landed on it.
        event.stopPropagation();
        onClose();
      }}
    />
  );
}

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
    returnFocus,
    label,
    kind,
    title,
    aside,
    wide,
    fitContent,
    anchored,
    closeWhenFull,
    initialFocus,
    initialFocusOnTouch = true,
    onKey,
    children,
  } = props;
  const renderPortal = useContext(portalRenderer);
  const box = useRef<HTMLDivElement | null>(null);
  const closeBar = useRef<HTMLDivElement | null>(null);
  const lastItem = useRef<HTMLElement | null>(null);
  const [full, setFull] = useState(false);
  const dialog = kind === "card" || kind === "ask" || kind === "picker";
  const from = returnFocus ?? (anchor && !("x" in anchor) ? anchor : null);
  useOverlayFocus(
    open,
    box,
    (el) => initialFocus?.current ?? firstStop(el),
    () => (from && "current" in from ? from.current : from),
    initialFocus === undefined || !initialFocusOnTouch,
  );
  useOverlayEscape(open, box, onClose);
  useMenuPosition(props, box, closeBar, setFull);
  // CSS can hide the focused item and the browser can blur it before the next render.
  useLayoutEffect(() => {
    if (!open) lastItem.current = null;
    else if (!dialog && box.current && lastItem.current)
      repairMenuFocus(box.current, lastItem.current, onClose);
  });
  if (!open) return null;

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (dialog || onKey) e.stopPropagation();
    if (onKey?.(e)) return;
    if (e.key === "Escape") {
      claimKey(e);
      closeTopmost();
    } else if (e.key === "Tab") {
      if (dialog) cycleTab(e, el);
      else onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      moveMenuFocus(el, e.key);
      claimKey(e);
    } else if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Keep typing local without blocking the default action of an input inside the menu.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
    }
  };

  const rememberItem = (e: FocusEvent<HTMLDivElement>) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
    lastItem.current = item && e.currentTarget.contains(item) ? item : null;
  };

  const releaseItem = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (next && next !== e.currentTarget.ownerDocument.body && !e.currentTarget.contains(next)) {
      lastItem.current = null;
    }
  };

  const drawn = (
    <div className="oh-over" data-popover={props.portal ? "" : undefined}>
      <MenuVeil dim={!anchor} onClose={onClose} />
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
        data-fit-content={fitContent ? "" : undefined}
        data-anchored={anchored ? "" : undefined}
        data-sheet={anchor ? undefined : ""}
        onFocusCapture={rememberItem}
        onBlurCapture={releaseItem}
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
  if (!props.portal) return drawn;
  const host = popoverHost(from && "current" in from ? from.current : from);
  return host ? renderPortal(drawn, host) : null;
}

function useMenuPosition(
  { open, portal, anchor, up, upFrom, right, fit, closeWhenFull }: MenuProps,
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
    const report = portal ? el.ownerDocument.querySelector(POPOVER_REPORT) : null;
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
        if (portal) clearMenuReport(el, room, report);
        return;
      }
      if (portal) el.style.removeProperty("--oh-menu-clearance");
      const control = from && "current" in from ? from.current : from;
      const r = control ? cssRect(control) : undefined;
      const at =
        x !== undefined && y !== undefined
          ? { x: x - room.left, y: y - room.top }
          : r && {
              left: r.left - room.left,
              top: (upFrom ? cssRect(upFrom).top : r.top) - room.top,
              right: r.right - room.left,
              bottom: r.bottom - room.top,
            };
      if (!at) return;
      const to = placeMenu(at, { width: el.offsetWidth, height }, room, { up: up || !!upFrom, right, fit });
      el.style.left = `${to.left}px`;
      el.style.top = `${to.top}px`;
      if (fit) el.style.maxHeight = to.maxHeight === undefined ? "" : `${to.maxHeight}px`;
      if (to.up) el.dataset.up = "";
      else delete el.dataset.up;
    };
    position();
    if (!fit && !closeWhenFull && !report) return;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(position) : null;
    observer?.observe(el);
    observer?.observe(stage);
    if (report) observer?.observe(report);
    if (upFrom) observer?.observe(upFrom);
    const window = el.ownerDocument.defaultView;
    window?.addEventListener("resize", position);
    return () => {
      observer?.disconnect();
      window?.removeEventListener("resize", position);
    };
  }, [open, portal, x, y, from, up, upFrom, right, fit, closeWhenFull, box, closeBar, setFull]);
}
