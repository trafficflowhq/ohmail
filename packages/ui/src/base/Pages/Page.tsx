import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "../../icons/Icon.js";
import { Tag } from "../Primitives/Tag.js";
import "./page.css";

/** A part of a page's line: what matters (heavy), a small fact as a tag, what explains it (plain), or a new row. */
export type PageLinePart = { heavy: string } | { tag: string } | { note: string } | { break: true };

export interface PageProps {
  /** The page's sentence, in the display face: one question, with its blanks. */
  children: ReactNode;
  /** The way back, at the top's left; what stands at its right (how far along it is). */
  back?: ReactNode;
  aside?: ReactNode;
  /** The answers so far, over the sentence. */
  trail?: ReactNode;
  /** A refusal: one or two plain sentences under the sentence. */
  refusal?: readonly [string] | readonly [string, string];
  /** The one thing the page needs beside its sentence: a code, rows to press. */
  material?: ReactNode;
  /**
   * The heavy line where a decision needs it, and a note under it that explains. In parts where it holds more than
   * words: small facts as tags in a row, what matters heavy and what explains it plain each on a row of its own.
   * A note handed without a line is drawn alone, in the line's place: what explains is never left out unsaid.
   */
  line?: string | readonly PageLinePart[];
  note?: string;
  /** Feedback that belongs below the facts and before the page’s answers. */
  afterLine?: ReactNode;
  /** One ink button, and the way on or back beside it. */
  acts: ReactNode;
  /**
   * The material stands beside the sentence where there is room, or under it. Two columns whose sentence column is
   * taller than the page fold by themselves to one column, which scrolls (`data-folded`): the material under the
   * buttons, as the unfolded phone held upright draws a page that stacks.
   */
  columns?: 1 | 2;
  /** On the phone the line stands over the material. */
  lineFirst?: boolean;
  /** The page starts higher on a desktop (96 under its top), so two sheets beside its sentence stand whole. */
  high?: boolean;
  /**
   * On the unfolded phone held upright the sentence takes the whole width and the material stands under the
   * buttons (a sentence with a long blank, beside sheets to read).
   */
  stack?: boolean;
  /** On a phone the sentence is set a step smaller, where it carries a whole address that has to be read on one line. */
  smaller?: boolean;
  /** Inset the Ohmarchy page on an unfolded phone. */
  foldInset?: boolean;
}

/**
 * A page that stands before the app: one sentence, the one thing it needs, one ink button. It is a
 * stage of its own, never the app behind a scrim.
 */
export function Page(props: PageProps) {
  const {
    children,
    back,
    aside,
    trail,
    refusal,
    material,
    line,
    note,
    afterLine,
    acts,
    columns = 1,
    lineFirst,
    high,
    stack,
    smaller,
    foldInset,
  } = props;
  const page = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const holdsMaterial = Boolean(material);
  const holdsLine = Boolean(line?.length || note || afterLine);
  /*
   * Two columns cannot scroll: where the sentence column is taller than the page, its act would stand under the
   * window's foot out of every pointer's reach. The page folds to one column then, which scrolls. A sheet cannot say
   * it: the one rule of CSS that weighs a box against its own content (a scroll-state query) is Chromium's alone, and
   * restyles only what stands inside the box, never the body's own grid. So the part measures, in its two columns,
   * each time the page or what it holds changes size, before the frame is painted. A page that fits says nothing.
   * A server cannot measure: markup drawn on a server stands in its two columns until this runs in the browser.
   */
  useLayoutEffect(() => {
    const main = page.current;
    const inner = body.current;
    if (columns !== 2 || !main || !inner || typeof ResizeObserver !== "function") return;
    const fold = () => {
      const was = main.hasAttribute("data-folded");
      const top = inner.scrollTop;
      if (was) main.removeAttribute("data-folded");
      const two = getComputedStyle(inner).gridTemplateColumns.trim().split(/\s+/).length > 1;
      const folds = two && inner.scrollHeight > inner.clientHeight + 1;
      if (!folds) return;
      main.setAttribute("data-folded", "");
      if (was) inner.scrollTop = top;
      /* Folded under a person's hands: what has the keys stays in sight. */
      const keys = document.activeElement;
      if (!was && keys instanceof HTMLElement && inner.contains(keys))
        keys.scrollIntoView?.({ block: "nearest" });
    };
    let again = 0;
    const watch = new ResizeObserver(() => {
      const was = main.hasAttribute("data-folded");
      fold();
      if (was === main.hasAttribute("data-folded")) return;
      /*
       * The stamp has just moved every box watched here, in the frame that told of them: the browser would say on the
       * window that it could not deliver those notifications. The watch is let go for this frame and taken up in the
       * next, where it measures once more.
       */
      watch.disconnect();
      again = requestAnimationFrame(start);
    });
    const start = () => {
      watch.observe(inner);
      for (const part of inner.children) watch.observe(part);
    };
    fold();
    start();
    return () => {
      cancelAnimationFrame(again);
      watch.disconnect();
      main.removeAttribute("data-folded");
    };
  }, [columns, holdsMaterial, holdsLine]);
  return (
    <main
      ref={page}
      className="oh-page"
      data-columns={columns}
      data-line-first={lineFirst ? "" : undefined}
      data-high={high ? "" : undefined}
      data-stack={stack ? "" : undefined}
      data-smaller={smaller ? "" : undefined}
      data-fold-inset={foldInset ? "" : undefined}
    >
      <header className="oh-page-top">
        <span className="oh-page-back">{back}</span>
        <span className="oh-page-aside">{aside}</span>
      </header>
      <div ref={body} className="oh-page-body">
        <div className="oh-page-trail">{trail}</div>
        <div className="oh-page-say">
          {children}
          {refusal?.map((sentence) => (
            <p key={sentence} className="oh-text oh-page-refusal" role="alert">
              <Icon name="warn" size={18} />
              <span>{sentence}</span>
            </p>
          ))}
        </div>
        {material ? <div className="oh-page-material">{material}</div> : null}
        {holdsLine ? (
          <div className="oh-page-line">
            {typeof line === "string" ? <span className="oh-page-heavy">{line}</span> : line?.map(linePart)}
            {note ? <span className="oh-page-note">{note}</span> : null}
            {afterLine ? <div className="oh-page-feedback">{afterLine}</div> : null}
          </div>
        ) : null}
        <div className="oh-page-acts">{acts}</div>
      </div>
    </main>
  );
}

function linePart(part: PageLinePart, at: number) {
  if ("tag" in part) return <Tag key={at}>{part.tag}</Tag>;
  if ("heavy" in part)
    return (
      <span key={at} className="oh-page-heavy">
        {part.heavy}
      </span>
    );
  if ("note" in part)
    return (
      <span key={at} className="oh-page-note">
        {part.note}
      </span>
    );
  return <i key={at} className="oh-page-break" aria-hidden="true" />;
}
