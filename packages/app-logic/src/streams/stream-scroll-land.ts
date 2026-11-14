/**
 * THE LANDING, carried over from the web shell's `StreamShell.scrollTo`: bring one card to the reading line and keep
 * it there until it IS there. A card laid out near the fold is flown to smoothly, reported at once and followed while
 * cards above it measure in; a far one is put at the line at once and re-measured every frame until it holds there
 * for ANCHOR_STABLE_FRAMES (a resting state, not an instant), or ANCHOR_FRAMES are spent. While it flies, the spy
 * stands down; a far jump ends the leave's tracked run, and the next starts where the landing rests.
 */
import { cssRect } from "../geometry/index.js";
import { ANCHOR_TOLERANCE_PX, LANDING_LEAD_PX, type StreamScrollCore } from "./stream-scroll-core.js";

/** Frames a landing may correct for before it is reported anyway. */
const ANCHOR_FRAMES = 90;
/** Frames the landing must hold before it is reported. */
const ANCHOR_STABLE_FRAMES = 3;

/** The landing's geometry over one scroller. */
function aimer(el: HTMLElement) {
  /** How far below the top of the scrollport the card sits right now. */
  const lineOf = (c: HTMLElement): number => cssRect(c).top - cssRect(el).top;
  /** The offset that would put the card exactly at the reading line. May be unreachable. */
  const rawTop = (c: HTMLElement): number => lineOf(c) + el.scrollTop - LANDING_LEAD_PX;
  /** The same offset clamped to what this scroller can reach (`scrollHeight` grows as cards render). */
  const aimTop = (c: HTMLElement): number =>
    Math.min(Math.max(rawTop(c), 0), Math.max(0, el.scrollHeight - el.clientHeight));
  return { lineOf, rawTop, aimTop };
}

export function landOn(core: StreamScrollCore, id: string, onLanded?: () => void): void {
  const el = core.el;
  if (!el) return;
  const find = (): HTMLElement | null => core.one(el, id);
  const card = find();
  // A card that is not mounted cannot be scrolled to, and `onLanded` is not called: nothing landed.
  if (!card) return;
  // The app's move, not the reader's scroll.
  core.moved();
  core.pin(id);
  core.owed = false; // the jump sets the cursor
  // One landing at a time.
  if (core.anchor) cancelAnimationFrame(core.anchor);
  core.anchor = 0;
  const { lineOf, aimTop } = aimer(el);
  // Protect the landing from the scroll-spy for the flight's duration; re-stamped on every correction.
  const protect = (): void => {
    core.jump = { id, until: Date.now() + 1500 };
  };
  protect();
  /** Is the card already laid out near the fold: measured on the card, never on an offset. */
  const near = lineOf(card) > -el.clientHeight && lineOf(card) < el.clientHeight * 2;
  // A far jump ends the tracked run; the next one starts where the landing rests.
  if (!near) {
    core.landing = true;
    core.range = { newestSeenId: null, bottomVisibleId: null };
    core.shown = null;
  } else if (core.landing) {
    // A near jump cut a far landing short: the run starts here.
    core.landing = false;
    core.restart();
    core.measure();
  }
  // `behavior` is always explicit: a stream may scroll smoothly by default.
  const flying = aimTop(card);
  if (near) el.scrollTo({ top: flying, behavior: "smooth" });
  else core.own(() => el.scrollTo({ top: flying, behavior: "instant" }));
  // Reported at once on a near landing: the card is laid out, and its own height does not move its own top.
  if (near) onLanded?.();
  const settle = settler(core, el, { id, near, flying, find, protect, onLanded });
  core.anchor = requestAnimationFrame(settle);
}

interface Flight {
  readonly id: string;
  readonly near: boolean;
  flying: number;
  readonly find: () => HTMLElement | null;
  readonly protect: () => void;
  readonly onLanded?: () => void;
}

/** One frame of the landing, again each frame until it holds at the line, or parks at the reachable end on screen. */
function settler(core: StreamScrollCore, el: HTMLElement, f: Flight): () => void {
  const { lineOf, rawTop, aimTop } = aimer(el);
  const { id, near, find } = f;
  let frames = 0;
  let held = 0;
  /* A near flight is followed too; it ends when the person takes the pane or the cursor, or the card leaves. */
  const hands = core.hands();
  let last = el.scrollTop;
  let gap = Math.abs(f.flying - last);
  let still = 0;
  const rest = (): void => {
    core.landing = false;
    core.restart();
    core.measure();
  };
  /** The landing is over: the spy and the hold loop take the card from here. */
  const flown = (): void => {
    if (core.jump?.id !== id) return;
    core.jump = null;
    core.spy();
  };
  const done = (): void => {
    if (!near) {
      rest();
      f.onLanded?.();
    }
    core.inputs.seam?.settled?.();
    flown();
  };
  const settle = (): void => {
    core.anchor = 0;
    const c = find();
    if (near && (!c || core.hands() !== hands || core.held !== id)) return flown();
    if (!c) return rest(); // left the stream mid-flight: nothing landed
    const aim = aimTop(c);
    const line = lineOf(c);
    const atLine = Math.abs(rawTop(c) - el.scrollTop) <= ANCHOR_TOLERANCE_PX;
    const onScreen = line < el.clientHeight - 1 && line + cssRect(c).height > 1;
    const parked = Math.abs(aim - el.scrollTop) <= ANCHOR_TOLERANCE_PX && onScreen;
    if (atLine || parked) {
      if (++held >= ANCHOR_STABLE_FRAMES) return done();
    } else if (near) {
      held = 0;
      // Moved away from the flight's end: somebody else scrolled (a scrollbar), and it is theirs.
      if (Math.abs(f.flying - el.scrollTop) > gap + ANCHOR_TOLERANCE_PX) return flown();
      still = el.scrollTop === last ? still + 1 : 0;
      // The card moved under the flight: fly on to where it is now; at rest, put it there.
      if (Math.abs(aim - f.flying) > ANCHOR_TOLERANCE_PX) {
        f.flying = aim;
        still = 0;
        el.scrollTo({ top: aim, behavior: "smooth" });
      } else if (still >= 2) {
        core.own(() => el.scrollTo({ top: aim, behavior: "instant" }));
      }
    } else {
      held = 0;
      core.own(() => el.scrollTo({ top: aim, behavior: "instant" }));
    }
    last = el.scrollTop;
    gap = Math.abs(f.flying - last);
    if (++frames > ANCHOR_FRAMES) return done();
    f.protect();
    core.anchor = requestAnimationFrame(settle);
  };
  return settle;
}
