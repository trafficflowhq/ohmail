import type { ReactNode, Ref } from "react";
import { Faces, Sentence } from "../../base/index.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./reading-head.css";

export interface ReadingHeadProps {
  /** The conversation's subject, as the mail has it. Left out where every message prints its own. */
  subject?: string;
  /**
   * In the subject's place, the sentence that is the control: "<who> goes to <place>.", its words with the
   * slot and the dot that stand in them (a `SentencePart` each side of where it may break). A line, no heading.
   */
  sentence?: ReactNode;
  /** Under a sentence: who it is and why, a `ReadingLine` each. */
  lines?: ReactNode;
  /** Who is in it, as circles and as words. Left out under a sentence. */
  people?: readonly { name: string; address: string }[];
  peopleMore?: string;
  /** Left out for a single letter: its sender stands in the message. */
  names?: string;
  /** Its tags. */
  tags?: ReactNode;
  /** The mailbox it is in, as a word, where there are several. */
  mailbox?: string;
  /** What ends the line on touch: the squares along the head. */
  squares?: ReactNode;
  /** Something has scrolled under the head: a short fade of the ground under its edge says so. */
  under?: boolean;
}

/** The conversation's subject and who is in it. It stays while the sheets scroll under it. */
export function ReadingHead({
  subject,
  sentence,
  lines,
  people = [],
  peopleMore,
  names,
  tags,
  mailbox,
  squares,
  under,
}: ReadingHeadProps) {
  const byline = (
    <p className="oh-text oh-readinghead-byline">
      <Faces people={people} more={peopleMore} />
      {names ? <span className="oh-readinghead-names">{names}</span> : null}
      {tags}
      {mailbox ? <span className="oh-readinghead-mailbox">{mailbox}</span> : null}
    </p>
  );
  /* A sentence brings its own lines: the line of who is in it stands only where something is handed for it. */
  const told = !sentence || people.length > 0 || Boolean(names || tags || mailbox || squares);
  return (
    <header
      className="oh-readinghead"
      data-bare={subject || sentence ? undefined : ""}
      data-sentence={sentence ? "" : undefined}
      data-under={under ? "" : undefined}
    >
      {/* A part of the place it stands in: the place's head is the page's one level-1 heading. */}
      {subject ? <h2 className="oh-text oh-readinghead-subject">{subject}</h2> : null}
      {sentence ? <Sentence>{sentence}</Sentence> : null}
      {lines}
      {!told ? null : squares ? (
        <div className="oh-readinghead-sub">
          {byline}
          {squares}
        </div>
      ) : (
        byline
      )}
      {subject ? (
        <b className="oh-readinghead-short" aria-hidden="true">
          <span className="oh-readinghead-short-text">{subject}</span>
        </b>
      ) : null}
    </header>
  );
}

export interface ReadingLineProps {
  /** The sign the line starts with: what a check found, or whose advice the line is. */
  sign?: IconName;
  /**
   * A name behind the sign: the sender's address. With `onPress` it is the way to their card and hands the pressed
   * control (`ref` is that control's); without one it is words, and nothing says it opens anything.
   */
  person?: { label: string; onPress?: (at: HTMLElement) => void; ref?: Ref<HTMLButtonElement> };
  /** What the sign says, as a word: said and not drawn where it is good news, bold in the ink where it warns. */
  word?: { text: string; warns?: boolean };
  /** A figure the line leads with: how sure the advice is, and what it measures for the pointer's hint. */
  figure?: { text: string; title?: string };
  /** Why: a size smaller, its words folding inside the column. */
  why?: boolean;
  /** What follows: who a decision is for (a `Slot`), what the sender offers (a `Tag`), or the reason's words. */
  children?: ReactNode;
}

/** One line under the reading column's sentence: who it is, with what a check found, or why a place is advised. */
export function ReadingLine({ sign, person, word, figure, why, children }: ReadingLineProps) {
  const mark = sign ? <Icon name={sign} size={18} /> : null;
  return (
    <p className="oh-text oh-readingline" data-why={why ? "" : undefined}>
      {person ? (
        <span className="oh-readingline-check" title={word?.text}>
          {mark}
          {person.onPress ? (
            <button
              ref={person.ref}
              type="button"
              className="oh-control oh-readingline-person"
              aria-haspopup="dialog"
              onClick={(event) => person.onPress?.(event.currentTarget)}
            >
              {person.label}
            </button>
          ) : (
            <span className="oh-readingline-person">{person.label}</span>
          )}
        </span>
      ) : (
        mark
      )}
      {word ? <b className={word.warns ? "oh-readingline-warns" : "oh-vh"}>{word.text}</b> : null}
      {figure ? (
        <b className="oh-readingline-figure" title={figure.title}>
          {figure.text}
        </b>
      ) : null}
      {why && children ? <span className="oh-readingline-reason">{children}</span> : children}
    </p>
  );
}
