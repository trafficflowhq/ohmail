/**
 * The one helper for motion a stylesheet cannot write: it reads the motion tokens off the
 * element and plays them with the browser's own animations.
 *
 * Every time, curve and shape is a token (`@ohmail/tokens/design/motion.css`); nothing here
 * carries a value. A new move on an element replaces the one on it, and under reduced motion
 * nothing is played: the end state stands at once.
 *
 * A leave holds its end (gone, or where it went) until the next move on that element, so the
 * caller can hide or remove the node in its own time without the node showing again in between.
 */
import type { MotionRole, TokenName } from "@ohmail/tokens/design";
import { cssRect, type CssRect } from "../ui-zoom.js";

export type DurationToken = `--d-${MotionRole}`;
export type EaseToken = `--${Extract<TokenName, `e-${string}`>}`;
export type ShapeToken = `--${Extract<TokenName, `x-${string}` | `o-${string}`>}`;

const read = (el: Element, token: string) => getComputedStyle(el).getPropertyValue(token).trim();

const TIME = /^(-?[\d.]+)(ms|s)$/;
const SCALED = /^calc\(\s*(-?[\d.]+)(ms|s)\s*\*\s*(.+?)\s*\)$/;
const inMs = (n: string, unit: string) => Number(n) * (unit === "s" ? 1000 : 1);

/** A duration token in milliseconds, the time scale applied. A token that is not set is 0: nothing moves. */
export function motionMs(el: Element, token: DurationToken): number {
  const text = read(el, token);
  const plain = TIME.exec(text);
  if (plain) return inMs(plain[1], plain[2]);
  const scaled = SCALED.exec(text);
  if (!scaled) return 0;
  /* A browser hands the factor over as a number; where it is still `var(--m-time)`, read it. */
  const factor = Number(scaled[3].startsWith("var(") ? read(el, "--m-time") || 1 : scaled[3]);
  return Number.isFinite(factor) ? inMs(scaled[1], scaled[2]) * factor : 0;
}

/** A curve token as the browser's animations take it. */
export const motionEase = (el: Element, token: EaseToken): string => read(el, token) || "linear";

/** A shape token: a transform for `--x-*`, an opacity for `--o-*`. Unset is "does not move" and "all there". */
export const motionShape = (el: Element, token: ShapeToken): string =>
  read(el, token) || (token.startsWith("--x-") ? "none" : "1");

/** True when the person's system asks for less motion, or the element stands under `data-rm="1"`. */
export function motionReduced(el: Element): boolean {
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  return el.closest('[data-rm="1"]') !== null;
}

/* The roles whose shape is where a thing goes to; every other role's shape is where it comes from. */
const LEAVES: readonly MotionRole[] = ["out", "leave", "close", "hush"];

/* The move on each element: the one running, or a leave that has ended and still holds its end. */
const current = new WeakMap<Element, Animation>();
function replace(el: Element): void {
  current.get(el)?.cancel();
  current.delete(el);
}

function play(el: Element, keyframes: Keyframe[], duration: number, easing: string, fill: FillMode, onDone?: () => void): Animation {
  const animation = el.animate(keyframes, { duration, easing, fill });
  current.set(el, animation);
  animation.addEventListener("finish", () => {
    /* One that holds its end is still on the element: forgotten here, nothing could take it off again. */
    if (fill === "none" && current.get(el) === animation) current.delete(el);
    onDone?.();
  });
  return animation;
}

/** The keyframes a role's own tokens describe: from its shape to rest, or from rest to its shape when it leaves. */
function shapeOf(el: Element, role: MotionRole): Keyframe[] {
  const shape = {
    transform: motionShape(el, `--x-${role}` as ShapeToken),
    opacity: motionShape(el, `--o-${role}` as ShapeToken),
  };
  const rest = { transform: "none", opacity: "1" };
  return LEAVES.includes(role) ? [rest, shape] : [shape, rest];
}

export interface AnimateOptions {
  /** The curve. A time has no curve of its own (an arrival settles, drops or eases), so the moment names it. */
  ease?: EaseToken;
  /** The frames to play in place of the role's own shape. */
  keyframes?: Keyframe[];
  /** Called once the move has ended, at once when nothing is played. Not called for a move that was replaced. */
  onDone?: () => void;
}

/**
 * Plays `role` on `el` with that role's time and shape, on the curve named. The move on `el` is
 * cancelled first. Returns null when nothing is played: reduced motion, or a time of 0. A leave
 * ends the same way either way: held at its last frame.
 */
export function animate(el: Element, role: MotionRole, { ease = "--e-std", keyframes, onDone }: AnimateOptions = {}): Animation | null {
  replace(el);
  const leaves = LEAVES.includes(role);
  const frames = keyframes ?? shapeOf(el, role);
  const duration = motionReduced(el) ? 0 : motionMs(el, `--d-${role}`);
  if (duration <= 0) {
    if (leaves) current.set(el, el.animate(frames, { duration: 0, fill: "forwards" }));
    onDone?.();
    return null;
  }
  return play(el, frames, duration, motionEase(el, ease), leaves ? "forwards" : "none", onDone);
}

/**
 * Where each element stands now, to be handed to `flipPlay` after the layout has changed. In the
 * page's own px, as a transform is: under a stamped text size the browser's rect is not.
 */
export function flipSnap(els: Iterable<Element>): Map<Element, CssRect> {
  const before = new Map<Element, CssRect>();
  for (const el of els) before.set(el, cssRect(el));
  return before;
}

/** Moves every element from where `before` saw it to where it stands now, on the travel tokens. */
export function flipPlay(before: Map<Element, CssRect>, els: Iterable<Element>): void {
  for (const el of els) {
    replace(el);
    const from = before.get(el);
    if (!from || motionReduced(el)) continue;
    const to = cssRect(el);
    const [dx, dy] = [from.left - to.left, from.top - to.top];
    const duration = motionMs(el, "--d-move");
    if ((dx === 0 && dy === 0) || duration <= 0) continue;
    play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], duration, motionEase(el, "--e-move"), "none");
  }
}
