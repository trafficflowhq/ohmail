import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeGloss } from "../../primitives/Gloss.js";
import { cssRect, cssViewport } from "../../base/ui-zoom.js";

const HOLD_MS = 380;
const STAY_MS = 1100;

export function useSquareTip() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    anchor,
    enter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" && !held.current) setAnchor(event.currentTarget);
    },
    leave: () => {
      if (!held.current) setAnchor(null);
    },
    focus: (element: HTMLElement) => {
      if (!held.current && element.matches(":focus-visible")) setAnchor(element);
    },
    down: (event: PointerEvent<HTMLElement>) => {
      clear();
      held.current = false;
      setAnchor(null);
      if (event.pointerType !== "touch") return;
      const target = event.currentTarget;
      timer.current = setTimeout(() => {
        held.current = true;
        setAnchor(target);
      }, HOLD_MS);
    },
    up: () => {
      clear();
      if (!held.current) return;
      timer.current = setTimeout(() => {
        held.current = false;
        setAnchor(null);
      }, STAY_MS);
    },
    cancel: () => {
      clear();
      held.current = false;
      setAnchor(null);
    },
    suppressClick: () => held.current,
  };
}

export function SquareTip({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const chip = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = chip.current;
    const win = anchor.ownerDocument.defaultView;
    if (!element || !win) return;
    const place = () => {
      const { top, left } = placeGloss(
        cssRect(anchor),
        {
          width: element.offsetWidth,
          height: element.offsetHeight,
        },
        cssViewport(win),
      );
      element.style.top = `${top}px`;
      element.style.left = `${left}px`;
    };
    place();
    win.addEventListener("scroll", place, true);
    win.addEventListener("resize", place);
    return () => {
      win.removeEventListener("scroll", place, true);
      win.removeEventListener("resize", place);
    };
  }, [anchor, children]);
  return createPortal(
    <span className="gloss-pop oh-square-tip" ref={chip} role="tooltip" aria-hidden="true">
      {children}
    </span>,
    anchor.ownerDocument.body,
  );
}
