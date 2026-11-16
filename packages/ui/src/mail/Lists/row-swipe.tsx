import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { cssPoint } from "../../base/ui-zoom.js";
import { Icon, type IconName } from "../../icons/Icon.js";

/** The verb a swipe lands on. */
export interface RowSwipeVerb {
  label: string;
  icon: IconName;
}

/** A row under a finger: to the right the read slot, to the left Later. */
export interface RowSwipe {
  /** What a swipe to the right lands on, and one to the left. A side left out does not move. */
  right?: RowSwipeVerb;
  left?: RowSwipeVerb;
  /** The swipe went far enough and the finger let go. */
  onSwipe?: (side: "right" | "left") => void;
  /** How far the row is pulled, in px, where the app draws a swipe itself. Left out: the finger says. */
  pulled?: number;
}

/* A finger claims the row after this much sideways travel, in the window's px as the finger moves; the row
   travels in the page's px, and the verb fires from here on. */
const CLAIM = 12;
const FIRE = 76;
const LIMIT = 112;

/* The row travels with the finger, and with resistance past the point where the verb fires. */
function travel(dx: number): number {
  const far = Math.abs(dx);
  const eased = far <= FIRE ? far : FIRE + (Math.min(far, 260) - FIRE) * 0.2;
  return Math.max(-LIMIT, Math.min(LIMIT, eased * Math.sign(dx)));
}

interface Swiping {
  /** The verb on the ground behind the row, while it is pulled. */
  back: ReactNode;
  moving: boolean;
  style: CSSProperties | undefined;
  handlers: {
    onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerCancel?: () => void;
  };
}

/** What a row needs to be swiped: its listeners, its place while it is pulled, and the verb behind it. */
export function useRowSwipe(swipe: RowSwipe | undefined): Swiping {
  /* `x`, `y`: where the finger came down, in the window's px, for the claim; `at`: the same in the page's. */
  const start = useRef<{ x: number; y: number; at: number; claimed: boolean } | null>(null);
  const [drag, setDrag] = useState(0);
  const dx = swipe?.pulled ?? drag;
  const side = dx > 0 ? "right" : "left";
  const verb = dx === 0 ? undefined : swipe?.[side];

  const handlers: Swiping["handlers"] = swipe
    ? {
        onPointerDown(event) {
          if (event.pointerType !== "touch" || (event.target as Element).closest("button")) return;
          start.current = { x: event.clientX, y: event.clientY, at: cssPoint(event).x, claimed: false };
        },
        onPointerMove(event) {
          const from = start.current;
          if (!from) return;
          const [mx, my] = [event.clientX - from.x, event.clientY - from.y];
          if (!from.claimed) {
            if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > CLAIM) start.current = null;
            if (Math.abs(mx) < CLAIM || Math.abs(my) > Math.abs(mx)) return;
            from.claimed = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
          const by = cssPoint(event).x - from.at;
          setDrag(swipe[by > 0 ? "right" : "left"] ? by : 0);
        },
        onPointerUp(event) {
          const from = start.current;
          start.current = null;
          if (!from?.claimed) return;
          const mx = cssPoint(event).x - from.at;
          setDrag(0);
          if (Math.abs(mx) >= FIRE && swipe[mx > 0 ? "right" : "left"])
            swipe.onSwipe?.(mx > 0 ? "right" : "left");
        },
        onPointerCancel() {
          start.current = null;
          setDrag(0);
        },
      }
    : {};

  const back = verb ? (
    <div
      className="oh-row-back"
      aria-hidden="true"
      data-side={side}
      data-armed={Math.abs(dx) >= FIRE ? "" : undefined}
    >
      <Icon name={verb.icon} size={20} />
      <span className="oh-row-back-word">{verb.label}</span>
    </div>
  ) : null;

  return {
    back,
    moving: Boolean(verb),
    style: verb ? { transform: `translateX(${travel(dx)}px)`, transition: "none" } : undefined,
    handlers,
  };
}
