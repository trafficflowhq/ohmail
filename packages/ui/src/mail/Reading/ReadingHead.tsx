import type { ReactNode } from "react";
import { Faces } from "../../base/index.js";
import "./reading-head.css";

export interface ReadingHeadProps {
  /** The conversation's subject, as the mail has it. Left out where every message prints its own. */
  subject?: string;
  /** Who is in it, as circles and as words. */
  people: readonly { name: string; address: string }[];
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
  people,
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
  return (
    <header
      className="oh-readinghead"
      data-bare={subject ? undefined : ""}
      data-under={under ? "" : undefined}
    >
      {subject ? <h1 className="oh-text oh-readinghead-subject">{subject}</h1> : null}
      {squares ? (
        <div className="oh-readinghead-sub">
          {byline}
          {squares}
        </div>
      ) : (
        byline
      )}
    </header>
  );
}
