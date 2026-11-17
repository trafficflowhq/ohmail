import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";

/** The verb a swipe lands on. */
export interface RowSwipeVerb {
  label: string;
  icon: IconName;
}

/**
 * A row under a finger: to the right the read slot, to the left Later. The list's own layer listens for the
 * finger and says how far it has pulled this row; the row draws that, and takes no pointer for itself.
 */
export interface RowSwipe {
  /** What a swipe to the right lands on, and one to the left. A side left out does not move. */
  right?: RowSwipeVerb;
  left?: RowSwipeVerb;
  /** How far the finger has pulled the row, in the page's px, to the right or (negative) to the left; 0 at rest. */
  pulled: number;
}

/* Where a swipe's verb fires, in the finger's travel: from there the verb behind the row is drawn armed. The
   list's layer lets go at the same travel. */
const FIRE = 76;
const LIMIT = 112;

/* The row travels with the finger, and with resistance past the point where the verb fires. The one place a
   pull is eased: what hands `pulled` hands the finger's own travel. */
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
}

/** What a pulled row draws: its place while it is pulled, and the verb behind it. */
export function rowSwipe(swipe: RowSwipe | undefined): Swiping {
  const dx = swipe?.pulled ?? 0;
  const side = dx > 0 ? "right" : "left";
  const verb = dx === 0 ? undefined : swipe?.[side];

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
  };
}
