import { motionEase, motionMs, motionReduced } from "@ohmail/ui/base";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

const INTENT = 12;
const FLICK = 0.45;
const FLICK_TRAVEL = 20;
const FLICK_AGE = 80;

interface Drag {
  id: number;
  x: number;
  y: number;
  direction: 1 | -1;
  time: number;
  velocity: number;
  travel: number;
  width: number;
  claimed: boolean;
}

function draw(panel: HTMLElement, drag: Drag): void {
  const offset = drag.direction === 1 ? drag.travel - drag.width : -drag.travel;
  panel.style.transform = `translateX(${offset}px)`;
  panel.parentElement?.style.setProperty("--oh-drawer-scrim", String(1 + offset / drag.width));
}

function startDrag(event: PointerEvent, open: boolean): Drag {
  return {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    direction: open ? -1 : 1,
    time: event.timeStamp,
    velocity: 0,
    travel: 0,
    width: 0,
    claimed: false,
  };
}

function snapDestination(drag: Drag, event: PointerEvent): boolean {
  const flip =
    event.type !== "pointercancel" &&
    (drag.travel >= drag.width / 3 ||
      (drag.travel >= FLICK_TRAVEL && drag.velocity > FLICK && event.timeStamp - drag.time < FLICK_AGE));
  return drag.direction === 1 ? flip : !flip;
}

function trackDrag(drag: Drag, event: PointerEvent, width: () => number): "vertical" | "waiting" | "moving" {
  const dx = (event.clientX - drag.x) * drag.direction;
  const dy = Math.abs(event.clientY - drag.y);
  if (!drag.claimed) {
    if (dy >= INTENT && dy >= Math.abs(dx)) {
      return "vertical";
    }
    if (dx < INTENT || dx < dy * 1.6) return "waiting";
    drag.claimed = true;
    drag.width = width();
  }
  const travel = Math.max(0, Math.min(drag.width, dx));
  const dt = event.timeStamp - drag.time;
  if (dt > 0) drag.velocity = (travel - drag.travel) / dt;
  drag.travel = travel;
  drag.time = event.timeStamp;
  return "moving";
}

function clearDrawerMotion(target: HTMLElement): void {
  target.style.removeProperty("transform");
  target.parentElement?.removeAttribute("data-drawer-snap");
  target.parentElement?.style.removeProperty("--oh-drawer-scrim");
}

function snapDrawer(target: HTMLElement, next: boolean, finish: () => void): Animation {
  const end = next ? "translateX(0)" : "translateX(-100%)";
  const from = target.style.transform || "translateX(0)";
  const timing = { duration: motionMs(target, "--d-pop"), easing: motionEase(target, "--e-out") };
  target.style.transform = end;
  const scrim = target.parentElement;
  scrim?.setAttribute("data-drawer-snap", "");
  scrim?.style.setProperty("--oh-drawer-scrim", next ? "1" : "0");
  const animation = target.animate([{ transform: from }, { transform: end }], timing);
  animation.onfinish = finish;
  return animation;
}

/** The frame reserves rightward starts in this strip for the drawer. */
export function startsAtDrawerEdge(target: Element, x: number): boolean {
  const frame = target.closest("[data-drawer-edge]");
  return frame !== null && x - frame.getBoundingClientRect().left <= INTENT;
}

function fromDrawerStart(frame: HTMLElement, target: Element, x: number): boolean {
  if (target.closest("[data-drawer-edge]") !== frame) return false;
  if (
    target.closest("[data-touch-walk], [data-calendar-swipe], input, textarea, select, [contenteditable]")
  ) {
    return false;
  }
  if (frame.ownerDocument.getSelection()?.isCollapsed === false) return false;
  if (target.closest("[data-swipe-right]") && !startsAtDrawerEdge(target, x)) return false;
  for (let element: Element | null = target; element && element !== frame; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth) continue;
    const { overflowX } = getComputedStyle(element);
    if (overflowX === "auto" || overflowX === "scroll") return false;
  }
  return true;
}

function listenForDrag(
  win: Window,
  down: (event: PointerEvent) => void,
  move: (event: PointerEvent) => void,
  finish: (event: PointerEvent) => void,
  click: (event: MouseEvent) => void,
): () => void {
  win.addEventListener("pointerdown", down, { passive: true });
  win.addEventListener("pointermove", move, { passive: true });
  win.addEventListener("pointerup", finish, { passive: true });
  win.addEventListener("pointercancel", finish, { passive: true });
  win.addEventListener("click", click, true);
  return () => {
    win.removeEventListener("pointerdown", down);
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", finish);
    win.removeEventListener("pointercancel", finish);
    win.removeEventListener("click", click, true);
  };
}

/** Read a finger from unused ground in the compact frame or from the open drawer. */
export function useRailGesture(
  frame: RefObject<HTMLDivElement | null>,
  panel: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  open: boolean,
  setOpen: (open: boolean) => void,
): boolean {
  const [preview, setPreview] = useState(false);
  const current = useRef({ open, setOpen });
  current.current = { open, setOpen };

  const cancelSnap = useRef<() => void>(() => {});
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current !== open) cancelSnap.current();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const el = frame.current;
    const win = el?.ownerDocument.defaultView;
    if (!enabled || !el || !win) return;
    let drag: Drag | null = null;
    let swallow = 0;
    let animation: Animation | undefined;
    let movingPanel: HTMLElement | null = null;
    const reset = () => {
      drag = null;
      animation?.cancel();
      animation = undefined;
      if (movingPanel) clearDrawerMotion(movingPanel);
      movingPanel = null;
    };
    cancelSnap.current = () => {
      reset();
      setPreview(false);
    };

    const down = (event: PointerEvent): void => {
      swallow = 0;
      if (
        drag ||
        animation ||
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        event.button !== 0 ||
        !(event.target instanceof Element)
      )
        return;
      const open = current.current.open;
      if (open ? !panel.current?.contains(event.target) : !fromDrawerStart(el, event.target, event.clientX))
        return;
      drag = startDrag(event, open);
    };
    const move = (event: PointerEvent): void => {
      if (!drag || event.pointerId !== drag.id) return;
      const claimed = drag.claimed;
      const result = trackDrag(
        drag,
        event,
        () => panel.current?.getBoundingClientRect().width ?? Math.min(300, win.innerWidth * 0.8),
      );
      if (result === "vertical") drag = null;
      if (result !== "moving") return;
      if (!drag) return;
      if (motionReduced(el)) return;
      // Place the first preview at the finger before the browser can paint it.
      if (!claimed && drag.direction === 1) flushSync(() => setPreview(true));
      const target = panel.current;
      if (!target) return;
      if (movingPanel !== target) {
        movingPanel = target;
        target.style.animationName = "none";
      }
      draw(target, drag);
    };
    const finish = (event: PointerEvent): void => {
      const done = drag;
      if (!done || event.pointerId !== done.id) return;
      drag = null;
      if (!done.claimed) return;
      swallow = event.timeStamp;
      const next = snapDestination(done, event);
      const settle = () => {
        current.current.setOpen(next);
        setPreview(false);
      };
      const target = panel.current;
      if (motionReduced(el) || !target) {
        settle();
        return;
      }

      movingPanel = target;
      const snap = snapDrawer(target, next, () => {
        if (animation !== snap || panel.current !== target) return;
        if (current.current.open !== (done.direction === -1)) return;
        animation = undefined;
        movingPanel = null;
        // Keep both layers at the end of the snap until React has shown or removed the drawer.
        flushSync(settle);
        clearDrawerMotion(target);
      });
      animation = snap;
    };
    const click = (event: MouseEvent): void => {
      if (!event.detail || !swallow || event.timeStamp - swallow > 400) return;
      swallow = 0;
      event.preventDefault();
      event.stopPropagation();
    };
    const stop = listenForDrag(win, down, move, finish, click);
    return () => {
      reset();
      stop();
    };
  }, [frame, panel, enabled]);

  return enabled && preview;
}
