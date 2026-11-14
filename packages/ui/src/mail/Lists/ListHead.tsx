import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Dot } from "../../base/index.js";
import "./list-head.css";

/** One part of the way to a place that lives inside a tree. */
export interface WayPart {
  label: string;
  /** Its whole name, where the label is a short one. */
  title?: string;
  /** Left out: a part that leads nowhere (a mailbox's name). */
  onPress?: () => void;
}

/** The way to a place inside a tree: where it starts, then each part above the place. */
export interface Way {
  parts: readonly WayPart[];
  /** The whole way in words, for the pointer's hint. */
  title: string;
  /** What stands for the parts a short line gives up. It opens the tree. */
  more: { label: string; onPress?: () => void };
}

export interface ListHeadProps {
  /** Where you are. */
  title: string;
  /** Something there is open: the title ends in the hot dot. */
  hot?: boolean;
  /** The list's own tools, at the line's end: at most one loud thing, the doorbell. */
  aside?: ReactNode;
  /** The way to a place that lives inside a tree. Its title is then content and may take two lines. */
  way?: Way;
  /** What stands under the title on a line of its own: a search field, a filter. */
  below?: ReactNode;
}

/* A way longer than its line gives up parts, never letters: the ones nearest the root, and one mark stands for them. */
function fitWay(line: HTMLElement): void {
  const parts = [...line.querySelectorAll<HTMLElement>("[data-part]")];
  const mark = line.querySelector<HTMLElement>("[data-more]");
  for (const part of parts) part.hidden = false;
  if (mark) mark.hidden = true;
  const over = () => line.scrollWidth > line.clientWidth + 1;
  for (let i = 1; i < parts.length - 1 && over(); i++) {
    parts[i]!.hidden = true;
    if (mark) mark.hidden = false;
  }
}

/** Where you are, and the list's own tools. */
export function ListHead({ title, hot, aside, way, below }: ListHeadProps) {
  const line = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    fitWay(el);
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(() => fitWay(el));
    watch.observe(el);
    return () => watch.disconnect();
  }, [way]);

  return (
    <header className="oh-listhead" data-way={way ? "" : undefined}>
      <h1 className="oh-text oh-display oh-listhead-title">
        {title}
        <Dot kind={hot ? "hot" : "ink"} />
      </h1>
      <div className="oh-listhead-aside">{aside}</div>
      {way || below ? (
        <div className="oh-listhead-below">
          {way ? (
            <p ref={line} className="oh-text oh-listhead-way" title={way.title}>
              {way.parts.map((part, index) => (
                <WayStep key={index} part={part} first={index === 0} />
              ))}
              <button
                type="button"
                className="oh-control oh-listhead-step"
                data-more=""
                hidden
                aria-label={way.more.label}
                onClick={way.more.onPress}
              >
                …
              </button>
            </p>
          ) : null}
          {below}
        </div>
      ) : null}
    </header>
  );
}

function WayStep({ part, first }: { part: WayPart; first: boolean }) {
  const order = first ? { "data-first": "" } : {};
  return part.onPress ? (
    <button
      type="button"
      className="oh-control oh-listhead-step"
      data-part=""
      title={part.title}
      onClick={part.onPress}
      {...order}
    >
      {part.label}
    </button>
  ) : (
    <span className="oh-listhead-step" data-part="" title={part.title} {...order}>
      {part.label}
    </span>
  );
}
