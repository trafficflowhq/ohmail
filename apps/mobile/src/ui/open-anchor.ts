/**
 * THE OPEN ANCHOR — the Ohbox's time order draws the older members above the opened message, so the
 * reader opens with the opened message at the top, or at the content's end where the content is
 * shorter. Until the person's own first scroll (a drag, a square) every layout that moves it aims
 * again.
 *
 * A SCROLL ASKED IS NOT A SCROLL REACHED. React Native's scroll view runs a scroll command before it
 * mounts the taller content of the same commit and clamps it to the old end (and a clamp that does
 * not move it reports nothing); on a fresh start the members' bodies lay out after the first anchor
 * scroll, and no later layout came to move it again. So the anchor keeps aiming, one scroll a frame,
 * until the view stands where it asked, or at the end of the content it was told about, bounded by
 * `ANCHOR_SETTLE_MS` after the last layout. And where the reader stands — the read rule's view, the
 * pane memory — is only ever an offset the view reported (`reached`), never the one asked for.
 *
 * A NEW WIDTH AIMS AGAIN. A rotation, a fold or a density change reflows every panel, and the offset
 * the view kept then points into another message: `rearm` aims at the kept place (`placeAt`,
 * `placeY`) until the person's own scroll, and while it is on its way (`aiming`) nothing is read.
 * A view the person scrolled to the content's end keeps the end, not the panel under its top; an open
 * clamped at the end keeps its message's top.
 */
import type { PanePlace } from "./pane-memory";

/** How long after the last layout the anchor keeps aiming at a place the view has not reached. */
export const ANCHOR_SETTLE_MS = 1500;

export interface OpenAnchor {
  /** Still holding the opened message at the top: no hand-over yet. */
  readonly holding: boolean;
  /** On its way to a place it has not reached: what the view shows is no place the person chose. */
  readonly aiming: boolean;
  /** Standing at the place itself, not at a content end short of it. */
  readonly settled: boolean;
  /** A scroll asked and the next look not yet done: a report now is the anchor's, never the person's. */
  readonly moving: boolean;
  /** A new width: hold the place again, as on the open. */
  rearm: () => void;
  /** A layout moved the opened message, the content or the view: aim again, and keep aiming until reached. */
  layout: () => void;
  /** The scroll view reports where it stands (a scroll event, a drag's or a fling's end). */
  reached: (y: number) => void;
  /** The person's own scroll: the anchor lets go for good. */
  handOver: () => void;
  dispose: () => void;
}

export interface OpenAnchorOptions {
  /** Aim at all (nothing remembered: a remembered offset is the person's own place and wins). */
  holding: boolean;
  /** Where the scroll view starts. */
  start: number;
  /** Where the view should stand (the opened message's top, less its air), `null` before its layout or where none applies. */
  target: () => number | null;
  /** The content and view heights the reader was told about. */
  extent: () => { content: number; view: number };
  scrollTo: (y: number) => void;
  /** Where the reader stands now: the read rule and the pane memory hear it. */
  stand: (y: number) => void;
  /** The opened message stands where it should, once: the column may be drawn. */
  onPlaced: () => void;
  /** The aim stopped, reached or given up: the read rule may look again. */
  onSettle?: () => void;
  /** The frame scheduler and the clock; tests run them by hand. */
  frame?: (run: () => void) => () => void;
  now?: () => number;
}

export function createOpenAnchor(o: OpenAnchorOptions): OpenAnchor {
  const frame = o.frame ?? ((run: () => void) => {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  });
  const now = o.now ?? Date.now;
  let holding = o.holding;
  let at = o.start;
  let placed = false;
  let until = 0;
  let pending: (() => void) | null = null;

  /** The place it can stand at now: the target, or the content's end where the content is shorter. */
  const want = (): number | null => {
    const t = o.target();
    if (t === null) return null;
    const { content, view } = o.extent();
    const y = Math.max(0, t);
    return content > 0 && view > 0 ? Math.min(y, Math.max(0, content - view)) : y;
  };
  const aim = (): void => {
    pending = null;
    if (!holding) return;
    const w = want();
    if (w === null) return;
    if (Math.abs(at - w) <= 1) {
      if (!placed) { placed = true; o.onPlaced(); }
      o.onSettle?.();
      return;
    }
    if (now() > until) { o.onSettle?.(); return; }
    o.scrollTo(w);
    pending = frame(aim);
  };
  return {
    get holding() { return holding; },
    get aiming() {
      if (!holding || now() > until) return false;
      const w = want();
      return w !== null && Math.abs(at - w) > 1;
    },
    get moving() { return pending !== null; },
    get settled() {
      const t = o.target();
      return t !== null && Math.abs(at - Math.max(0, t)) <= 1;
    },
    rearm: () => {
      holding = true;
      until = now() + ANCHOR_SETTLE_MS;
      pending?.();
      aim();
    },
    layout: () => {
      if (!holding) return;
      until = now() + ANCHOR_SETTLE_MS;
      pending?.();
      aim();
    },
    reached: (y) => {
      at = y;
      o.stand(y);
    },
    handOver: () => {
      holding = false;
      pending?.();
      pending = null;
    },
    dispose: () => {
      holding = false;
      pending?.();
      pending = null;
    },
  };
}

/** A panel of the reader, top to bottom: its id, its top in the scroll content and its height. */
export interface PlacePanel { id: string; top: number; height: number }

/** The air a jump leaves above a panel's top: a view standing in it stands at that panel. */
const PLACE_AIR = 8;

/** The content and view heights of the scroll view. */
export interface PlaceExtent { content: number; view: number }

/** Where the view at `y` stands: the panel under its top line, and how far into it; at the end of a content taller than the view, the end. */
export function placeAt(panels: readonly PlacePanel[], y: number, extent: PlaceExtent): PanePlace | null {
  let at: PlacePanel | null = null;
  for (const p of panels) if (p.top <= y + PLACE_AIR + 1) at = p;
  if (at === null) return null;
  const max = extent.content - extent.view;
  const end = extent.content > 0 && extent.view > 0 && max > 1 && y >= max - 1;
  return end ? { id: at.id, dy: y - at.top, h: at.height, end: true } : { id: at.id, dy: y - at.top, h: at.height };
}

/** Where `place` stands in today's layout: the content's end, or the same distance above the top, as far into the panel, or past its end. */
export function placeY(panels: readonly PlacePanel[], place: PanePlace, extent: PlaceExtent): number | null {
  if (place.end === true) return extent.content > 0 && extent.view > 0 ? Math.max(0, extent.content - extent.view) : null;
  const p = panels.find((x) => x.id === place.id);
  if (!p) return null;
  if (place.dy <= 0 || place.h <= 0 || p.height <= 0) return p.top + place.dy;
  if (place.dy >= place.h) return p.top + p.height + (place.dy - place.h);
  return p.top + (place.dy * p.height) / place.h;
}
