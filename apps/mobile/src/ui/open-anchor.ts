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
 */

/** How long after the last layout the anchor keeps aiming at a place the view has not reached. */
export const ANCHOR_SETTLE_MS = 1500;

export interface OpenAnchor {
  /** Still holding the opened message at the top: no hand-over yet. */
  readonly holding: boolean;
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
      return;
    }
    if (now() > until) return;
    o.scrollTo(w);
    pending = frame(aim);
  };
  return {
    get holding() { return holding; },
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
