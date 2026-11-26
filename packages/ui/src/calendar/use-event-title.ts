import { useLayoutEffect, useRef, useState } from "react";

let titleMeasure: CanvasRenderingContext2D | null = null;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function withEllipsis(text: string, width: number, measure: (text: string) => number): string {
  const letters = Array.from(graphemes.segment(text), ({ segment }) => segment);
  let lo = 1;
  let hi = letters.length;
  let fitted = letters[0] ?? text;
  while (lo <= hi) {
    const count = Math.floor((lo + hi) / 2);
    const shortened = letters.slice(0, count).join("").trimEnd() + "…";
    if (measure(shortened) <= width) {
      fitted = shortened;
      lo = count + 1;
    } else {
      hi = count - 1;
    }
  }
  return fitted;
}

function fitTitle(title: string, lines: number, width: number, measure: (text: string) => number): string {
  const words = title.trim().split(/\s+/u);
  const wrapped: string[] = [];
  let line = "";
  let clipped = false;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= width) {
      line = next;
      continue;
    }
    if (line) {
      if (wrapped.length === lines - 1) {
        return [...wrapped, withEllipsis(line, width, measure)].join("\n");
      }
      wrapped.push(line);
      line = "";
    }
    if (measure(word) <= width) {
      line = word;
      continue;
    }
    clipped = true;
    wrapped.push(withEllipsis(word, width, measure));
    if (wrapped.length === lines) return wrapped.join("\n");
  }
  if (!Number.isFinite(lines) && !clipped) return title;
  if (line) wrapped.push(line);
  return wrapped.join("\n");
}

/** Fit timed blocks to their line limit. Card headings can wrap as far as their words fit. */
export function useEventTitle(title: string, lines = Infinity, state?: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [wording, setWording] = useState(title);
  useLayoutEffect(() => {
    const element = ref.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const style = view.getComputedStyle(element);
      const width = Number.parseFloat(style.width);
      if (!(width > 0)) return;
      titleMeasure ??= element.ownerDocument.createElement("canvas").getContext("2d");
      if (!titleMeasure) return;
      const measure = titleMeasure;
      measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      measure.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      setWording(fitTitle(title, lines, width, (text) => measure.measureText(text).width));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    const fonts = element.ownerDocument.fonts;
    fonts?.addEventListener("loadingdone", fit);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener("loadingdone", fit);
    };
  }, [title, lines, state]);
  return { ref, wording };
}
