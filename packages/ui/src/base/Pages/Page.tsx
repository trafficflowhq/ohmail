import type { ReactNode } from "react";
import { Icon } from "../../icons/Icon.js";
import "./page.css";

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
  /** The heavy line where a decision needs it, and a note under it that explains. */
  line?: string;
  note?: string;
  /** One ink button, and the way on or back beside it. */
  acts: ReactNode;
  /** The material stands beside the sentence where there is room, or under it. */
  columns?: 1 | 2;
  /** On the phone the line stands over the material. */
  lineFirst?: boolean;
}

/**
 * A page that stands before the app: one sentence, the one thing it needs, one ink button. It is a
 * stage of its own, never the app behind a scrim.
 */
export function Page(props: PageProps) {
  const { children, back, aside, trail, refusal, material, line, note, acts, columns = 1, lineFirst } = props;
  return (
    <main className="oh-page" data-columns={columns} data-line-first={lineFirst ? "" : undefined}>
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
        {line ? (
          <div className="oh-page-line">
            <span className="oh-page-heavy">{line}</span>
            {note ? <span className="oh-page-note">{note}</span> : null}
          </div>
        ) : null}
        <div className="oh-page-acts">{acts}</div>
      </div>
    </main>
  );
}
