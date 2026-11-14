import type { ReactNode } from "react";
import "./message.css";

export interface MessageProps {
  /** Its head: who wrote it, to whom, when. */
  head: ReactNode;
  /** Not read yet: the sheet is tinted. */
  unread?: boolean;
  /** It came back unread a moment ago: the tint returns once. */
  back?: boolean;
  /** One line over the text, with its sign: why the letter is where it is. */
  line?: ReactNode;
  /** The message's own subject, where the column's head is out of sight or every message prints its own. */
  subject?: string;
  /** What stands between the subject and the text: an event found in the letter. */
  lead?: ReactNode;
  /** The letter: plain text as a string, or the body the app draws. */
  children: ReactNode;
  /** What follows the text: an invitation, its files. */
  after?: ReactNode;
  files?: ReactNode;
  /** The element's id, for a jump to this message. */
  id?: string;
}

/** One message of a conversation: a sheet of its own. */
export function Message({
  head,
  unread,
  back,
  line,
  subject,
  lead,
  children,
  after,
  files,
  id,
}: MessageProps) {
  return (
    <article
      className="oh-message"
      id={id}
      data-unread={unread ? "" : undefined}
      data-back={back ? "" : undefined}
    >
      {head}
      {line ? <p className="oh-text oh-message-line">{line}</p> : null}
      {subject ? <h2 className="oh-text oh-display oh-message-subject">{subject}</h2> : null}
      {lead}
      {typeof children === "string" ? <div className="oh-message-body">{children}</div> : children}
      {after}
      {files}
    </article>
  );
}
