import { useLayoutEffect, useRef, useState } from "react";
import { cssRect } from "../../base/ui-zoom.js";
import "./now-line.css";

export interface NowLineProps {
  /** Where now stands on the hours it is drawn in, in px from their first hour. */
  top: number;
}

/**
 * The dot marks now even when today is busy. The rule only uses free stretches between
 * the objects at that height, so it never crosses an event or its words.
 */
export function NowLine({ top }: NowLineProps) {
  const line = useRef<HTMLElement>(null);
  const [stretches, setStretches] = useState<readonly Stretch[]>([]);
  useLayoutEffect(() => {
    const node = line.current;
    const column = node?.parentElement;
    if (!node || !column) return;
    const measure = () => {
      const next = clearStretches(node, column);
      setStretches((previous) =>
        previous.length === next.length &&
        previous.every(([start, end], i) => start === next[i]![0] && end === next[i]![1])
          ? previous
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  });
  return (
    <i ref={line} className="oh-now" data-today-pulse-target="now" aria-hidden style={{ top }}>
      {stretches.map(([start, end]) => (
        <span className="oh-now-stroke" key={start} style={{ left: start, width: end - start }} />
      ))}
    </i>
  );
}

type Stretch = readonly [start: number, end: number];

const NOW_LINE = { gap: 3, min: 32, max: 64, share: 0.2, dot: 10 } as const;

function clearStretches(line: HTMLElement, column: HTMLElement): Stretch[] {
  const { gap, min, max, share, dot } = NOW_LINE;
  const rule = cssRect(line);
  const day = cssRect(column);
  const minimum = Math.min(max, Math.max(min, day.width * share));
  const blocks = [...column.querySelectorAll(":scope > :is(.oh-ev, .oh-tg-mark, .oh-tg-free)")]
    .map(cssRect)
    .filter((box) => box.width > 0 && box.bottom + gap > rule.top && box.top - gap < rule.bottom)
    .sort((a, b) => a.left - b.left);

  const stretches: Stretch[] = [];
  let start = day.left;
  for (const block of blocks) {
    const end = block.left - gap;
    if (end - Math.max(start, rule.left + dot) >= minimum) {
      stretches.push([start - rule.left, end - rule.left]);
    }
    start = Math.max(start, block.right + gap);
  }
  if (rule.right - Math.max(start, rule.left + dot) >= minimum) {
    stretches.push([start - rule.left, rule.width]);
  }
  return stretches;
}
