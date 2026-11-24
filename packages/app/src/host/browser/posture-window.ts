/**
 * THE WINDOW WITH ITS FOLD: what a shell on a foldable hands the frame as `device.window`. The window's facts, with
 * the posture word composed from the host's fold (`book` where a fold stands upright across the window's middle,
 * each side a column's width). The frame stays a reader of the window alone; a host with no fold hands the window
 * as it is.
 */
import { foldLineOf } from "@ohmail/app-logic/touch";
import { NONE, type None } from "../contract.js";
import type { Posture, WindowFacts } from "../device.js";
import type { FoldReading, Signal } from "../signals.js";

export function postureWindow(
  window: Signal<WindowFacts>,
  posture: Signal<FoldReading> | None,
): Signal<WindowFacts> {
  if (posture === NONE) return window;
  let held: WindowFacts | null = null;
  return {
    read() {
      const facts = window.read();
      const word: Posture = foldLineOf(facts, posture.read().folds) ? "book" : "flat";
      const next: WindowFacts = word === facts.posture ? facts : { ...facts, posture: word };
      /* One object while nothing moved: the frame lays itself out again only on a change. */
      if (held === null || !same(held, next)) held = next;
      return held;
    },
    subscribe(changed) {
      const stopWindow = window.subscribe(changed);
      const stopFold = posture.subscribe(changed);
      return () => {
        stopWindow();
        stopFold();
      };
    },
  };
}

const same = (a: WindowFacts, b: WindowFacts): boolean =>
  a.width === b.width &&
  a.height === b.height &&
  a.pointer === b.pointer &&
  a.posture === b.posture &&
  a.reducedMotion === b.reducedMotion;
