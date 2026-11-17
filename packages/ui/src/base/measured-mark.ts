import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A part that draws itself otherwise once its words no longer fit: the fewer words, a second line. A sheet cannot
 * say that (no rule of CSS weighs a box against its own words), so the part measures.
 *
 * `read` is the node whose words may be too wide for its box; `mark` is the node that then carries
 * `data-<name>`, which the part's sheet reads. The question is always asked with the mark taken off, so the answer
 * never depends on what was drawn before: the mark is removed, the words are measured, and the mark is set again
 * where they are too wide, all before a frame is painted. It is asked on every draw (the words may have changed)
 * and whenever the mark's room changes size.
 */
export function useMeasuredMark(
  mark: RefObject<HTMLElement | null>,
  read: RefObject<HTMLElement | null>,
  name: string,
  on: boolean,
): void {
  const measure = useRef<() => boolean>(() => false);
  measure.current = () => {
    const [el, words] = [mark.current, read.current];
    if (!el || !words) return false;
    const was = el.dataset[name] !== undefined;
    delete el.dataset[name];
    const wide = on && words.scrollWidth > words.clientWidth;
    if (wide) el.dataset[name] = "";
    return wide !== was;
  };
  useLayoutEffect(() => void measure.current());
  useLayoutEffect(() => {
    const room = mark.current?.parentElement;
    if (!on || !room || typeof ResizeObserver !== "function") return;
    let again = 0;
    const watch = new ResizeObserver(() => {
      if (!measure.current()) return;
      /* The mark has just moved the boxes watched here: the watch is let go for this frame and taken up in the next. */
      watch.disconnect();
      again = requestAnimationFrame(start);
    });
    const start = () => {
      watch.observe(room);
      if (room.parentElement) watch.observe(room.parentElement);
    };
    start();
    return () => {
      cancelAnimationFrame(again);
      watch.disconnect();
    };
  }, [mark, on]);
}
