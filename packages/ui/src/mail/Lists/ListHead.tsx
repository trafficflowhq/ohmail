import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Dot } from "../../base/index.js";
import { cssRect } from "../../base/ui-zoom.js";
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
  /**
   * What stands under the title on a line of its own: a search field, a filter, a line of segments (a place's
   * piles, a person's directions). The line never widens the head: segments wider than their list scroll sideways
   * inside it, the pressed one in view, and the line fades at each end that hides more.
   */
  below?: ReactNode;
  /** A quiet line under the title, over what stands below: a person's address. */
  meta?: string;
  /** How many the list holds, in words, at the line's end before its tools: "1 draft". */
  count?: string;
  /**
   * The place's own sections, a `Seg` with their counts: beside the name with a pointer, the head's second
   * line under a finger, each as wide as its share of the list. The name's line keeps a place's first line.
   */
  sections?: ReactNode;
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
export function ListHead({ title, hot, aside, way, below, meta, count, sections }: ListHeadProps) {
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
    <header className="oh-listhead" data-way={way ? "" : undefined} data-sections={sections ? "" : undefined}>
      <h1 className="oh-text oh-display oh-listhead-title">
        {title}
        <Dot kind={hot ? "hot" : "ink"} />
      </h1>
      {sections ? <div className="oh-listhead-sections">{sections}</div> : null}
      {!sections || count || aside ? (
        <div className="oh-listhead-aside">
          {count ? <span className="oh-listhead-count">{count}</span> : null}
          {aside}
        </div>
      ) : null}
      {way || below || meta ? (
        <div className="oh-listhead-below">
          {meta ? <p className="oh-text oh-listhead-meta">{meta}</p> : null}
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
          {below ? <Run>{below}</Run> : null}
        </div>
      ) : null}
    </header>
  );
}

/* What stays in view after the pressed segment of a line that scrolls: the start of the one after it. */
const PEEK = 24;

/** The head's own line under its name: as wide as the head, whatever it holds, and scrolled inside itself. */
function Run({ children }: { children: ReactNode }) {
  const run = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = run.current;
    if (!el) return;
    /* The line says which of its ends hides more: its sheet fades those. */
    const ends = () => {
      el.toggleAttribute("data-less", el.scrollLeft > 1);
      el.toggleAttribute("data-more", el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    const on = el.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (on && el.scrollWidth > el.clientWidth + 1) {
      const end = cssRect(on).right - cssRect(el).left + el.scrollLeft;
      el.scrollLeft = Math.max(0, end + PEEK - el.clientWidth);
    }
    ends();
    el.addEventListener("scroll", ends, { passive: true });
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(ends) : null;
    watch?.observe(el);
    return () => {
      el.removeEventListener("scroll", ends);
      watch?.disconnect();
    };
  }, []);
  return (
    <div ref={run} className="oh-listhead-run">
      {children}
    </div>
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
