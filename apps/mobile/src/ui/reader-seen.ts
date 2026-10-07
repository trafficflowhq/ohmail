import { DWELL_MS, EVIDENCE_WINDOW_MS, READING_LINE, atScrollEnd, dwellCommits } from "@ohmail/client-engine";

/**
 * SCROLL-TO-READ IN THE PHONE'S READER — the web core's rules and numbers (the engine's
 * `reader-seen-rules.ts`) over React Native's scroll events: rule A, a downward pass (a member
 * panel's bottom was below the reading line at an earlier scroll of this open and a later one
 * carries the line past it); rule B and the end-of-reader rule, the dwell after the finger and its
 * fling settle (`dwellCommits`). The evidence is the DRAG: a scroll counts during it, during the
 * fling it starts, or within a second of the finger lifting; anything else — a restored offset, a
 * programmatic, keyboard or screen-reader scroll — writes nothing. Content coordinates throughout.
 */

export { DWELL_MS, READING_LINE };
/** The glance batch's quiet window — the web's `SEEN_QUIET_MS`. */
export const SEEN_QUIET_MS = 400;

export interface PhoneReaderSeen {
  /** The scroll view's own height, and its content's. */
  viewport: (height: number) => void;
  content: (height: number) => void;
  /** An enclosing view's y inside its parent: `padded` (the reader's column), `container` (the members' list). */
  offset: (which: "padded" | "container", y: number) => void;
  /** A member panel's y inside the members' list, and its height. */
  panel: (id: string, y: number, height: number) => void;
  onScroll: (offsetY: number) => void;
  dragBegin: () => void;
  dragEnd: () => void;
  momentumBegin: () => void;
  momentumEnd: () => void;
  /** The app left the foreground: a running dwell is dropped. */
  hidden: () => void;
  /** Leaving the message: a pending batch is sent, timers stop. */
  dispose: () => void;
}

export function createPhoneReaderSeen(o: {
  /** Has the member been read already (the mirror's answer at the moment)? */
  isSeen: (id: string) => boolean;
  /** The batch, as one glance. */
  onSeen: (ids: string[]) => void;
  now?: () => number;
  line?: number;
  dwellMs?: number;
  quietMs?: number;
}): PhoneReaderSeen {
  const now = o.now ?? Date.now;
  const line = o.line ?? READING_LINE;
  const dwellMs = o.dwellMs ?? DWELL_MS;
  const quietMs = o.quietMs ?? SEEN_QUIET_MS;
  const offsets = { padded: 0, container: 0 };
  const panels = new Map<string, { y: number; h: number }>();
  const seenBelow = new Set<string>();
  let height = 0;
  let contentH = Number.POSITIVE_INFINITY;
  let y = 0;
  let drove = false;
  let dragging = false;
  let flinging = false;
  let liftedAt = Number.NEGATIVE_INFINITY;
  let dwell: ReturnType<typeof setTimeout> | null = null;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();

  const top = (p: { y: number }): number => offsets.padded + offsets.container + p.y;
  const lineY = (): number => y + line * height;
  const evidenced = (): boolean => dragging || flinging || now() - liftedAt <= EVIDENCE_WINDOW_MS;

  const flush = (): void => {
    if (quiet !== null) clearTimeout(quiet);
    quiet = null;
    if (pending.size === 0) return;
    const ids = [...pending];
    pending.clear();
    o.onSeen(ids);
  };
  const commit = (id: string): void => {
    if (o.isSeen(id) || pending.has(id)) return;
    pending.add(id);
    if (quiet !== null) clearTimeout(quiet);
    quiet = setTimeout(flush, quietMs);
  };
  const cancelDwell = (): void => {
    if (dwell !== null) clearTimeout(dwell);
    dwell = null;
  };
  const armDwell = (): void => {
    cancelDwell();
    if (!drove) return;
    dwell = setTimeout(() => {
      dwell = null;
      const boxes = [...panels].filter(([id]) => !o.isSeen(id)).map(([id, p]) => ({ id, top: top(p), bottom: top(p) + p.h }));
      for (const id of dwellCommits(boxes, { top: y, bottom: y + height, line: lineY() }, atScrollEnd(y, height, contentH))) commit(id);
    }, dwellMs);
  };

  return {
    viewport: (h) => { height = h; },
    content: (h) => { contentH = h; },
    offset: (which, v) => { offsets[which] = v; },
    panel: (id, py, h) => { panels.set(id, { y: py, h }); },
    onScroll: (offsetY) => {
      y = offsetY;
      // An unevidenced scroll (a screen reader's, a restored offset) still moves the record, so the
      // next drag cannot commit what it carried past, and it drops a running dwell, as on the web.
      const human = evidenced();
      if (!human) cancelDwell();
      const at = lineY();
      for (const [id, p] of panels) {
        if (o.isSeen(id)) continue;
        if (top(p) + p.h > at) {
          seenBelow.add(id);
          continue;
        }
        if (human && seenBelow.has(id)) commit(id);
        seenBelow.delete(id);
      }
    },
    dragBegin: () => { drove = true; dragging = true; cancelDwell(); },
    dragEnd: () => { dragging = false; liftedAt = now(); armDwell(); },
    momentumBegin: () => { if (drove) flinging = true; cancelDwell(); },
    momentumEnd: () => { flinging = false; liftedAt = now(); armDwell(); },
    hidden: cancelDwell,
    dispose: () => { cancelDwell(); flush(); },
  };
}
