import type { ReactNode } from "react";
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
   */
  line?: string | readonly PageLinePart[];
  note?: string;
  /** One ink button, and the way on or back beside it. */
  acts: ReactNode;
  /** The material stands beside the sentence where there is room, or under it. */
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
    acts,
    columns = 1,
    lineFirst,
    high,
    stack,
    smaller,
  } = props;
  return (
    <main
      className="oh-page"
      data-columns={columns}
      data-line-first={lineFirst ? "" : undefined}
      data-high={high ? "" : undefined}
      data-stack={stack ? "" : undefined}
      data-smaller={smaller ? "" : undefined}
    >
      <header className="oh-page-top">
        <span className="oh-page-back">{back}</span>
        <span className="oh-page-aside">{aside}</span>
      </header>
      <div className="oh-page-body">
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
        {line?.length ? (
          <div className="oh-page-line">
            {typeof line === "string" ? <span className="oh-page-heavy">{line}</span> : line.map(linePart)}
            {note ? <span className="oh-page-note">{note}</span> : null}
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
