/**
 * THE GLASS: what a phone's host says about its window's edges, written where the frame's sheets read it, and the
 * system's back. The app's room is the whole glass: nothing is kept free at its foot. What scrolls runs to the edge;
 * what is fixed keeps the larger of its own margin and the inset the system reports (`foot.css`), never the two
 * added; under a keyboard the inset counts 0. A host that answers none of these keys gets nothing written.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { foldLineOf } from "@ohmail/app-logic/touch";
import { NONE } from "../host/contract.js";
import type { Signal } from "../host/signals.js";
import { useFrame, useRailOpen } from "./commands.js";
import { useSignal } from "./feeds.js";
import "./foot.css";

const SILENT: Signal<null> = { read: () => null, subscribe: () => () => undefined };

const px = (n: number) => `${n}px`;

/** Every mark the glass writes now, by name; a mark left out is not written. */
function marksOf(
  insets: { bottom: number; left: number; right: number } | null,
  keyboard: number | null,
  fold: { at: number; band: number; floor: number } | null,
): Record<string, string> {
  const marks: Record<string, string> = {};
  if (insets !== null || keyboard !== null) marks["data-foot"] = "glass";
  if (insets !== null) {
    /* What stands on the keys keeps nothing more. */
    marks["--sys-b"] = px(keyboard ? 0 : insets.bottom);
    marks["--sys-l"] = px(insets.left);
    marks["--sys-r"] = px(insets.right);
  }
  if (keyboard !== null) marks["--kb"] = px(keyboard);
  if (fold !== null) {
    marks["data-fold"] = "book";
    marks["--fold-at"] = px(fold.at);
    marks["--fold-band"] = px(fold.band);
    marks["--fold-floor"] = px(fold.floor);
  }
  return marks;
}

export function useGlass(drawn: RefObject<HTMLElement | null>): void {
  const { host, route, commands } = useFrame();
  const [railOpen] = useRailOpen();
  const { insets, keyboard, posture, back } = host.signals;
  const facts = useSignal(host.device.window);
  const edges = useSignal(insets === NONE ? SILENT : insets);
  const keys = useSignal(keyboard === NONE ? SILENT : keyboard);
  const folds = useSignal(posture === NONE ? SILENT : posture);
  const fold = folds === null ? null : foldLineOf(facts, folds.folds);
  const marks = marksOf(edges, keys === null ? null : keys.height, fold);
  const key = JSON.stringify(marks);

  useLayoutEffect(() => {
    const root = drawn.current?.ownerDocument.documentElement;
    if (!root) return;
    const written = JSON.parse(key) as Record<string, string>;
    const names = Object.keys(written);
    if (names.length === 0) return;
    /* Only what is written now is taken back, to what stood before it. */
    const before = names.map(
      (name) =>
        [name, name.startsWith("--") ? root.style.getPropertyValue(name) : root.getAttribute(name)] as const,
    );
    for (const name of names) {
      if (name.startsWith("--")) root.style.setProperty(name, written[name]!);
      else root.setAttribute(name, written[name]!);
    }
    return () => {
      for (const [name, value] of before) {
        if (name.startsWith("--")) {
          if (value) root.style.setProperty(name, value);
          else root.style.removeProperty(name);
        } else if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
    };
  }, [drawn, key]);

  /* The system's back, newest first: the whole rail over the app, then the open letter; else the app leaves. */
  const now = useRef({ railOpen, open: route.open });
  now.current = { railOpen, open: route.open };
  useEffect(() => {
    if (back === NONE) return;
    return back.subscribe(() => {
      if (now.current.railOpen) {
        commands.rail(false);
        return true;
      }
      if (now.current.open !== null) {
        commands.open(null);
        return true;
      }
      return false;
    });
  }, [back, commands]);
}
