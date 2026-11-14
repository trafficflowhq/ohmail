import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../base/index.js";
import "./message.css";

/** A letter of a stream, cut until it is opened. */
export interface MessageClip {
  /** Open: the letter whole, with the way to shut it again. Shut: cut after a few lines, what follows the text waiting. */
  open: boolean;
  /** Its control's word: "Expand", "Collapse", or "Read in full" where the press leaves for the letter. */
  word: string;
  /** The press leaves for the letter itself (one column): a way on, with no open state. */
  goes?: boolean;
  onPress?: () => void;
}

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
  /** In a stream: cut until it is opened. A letter that fits, with nothing waiting under it, is whole and has no control. */
  clip?: MessageClip;
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
  clip,
}: MessageProps) {
  const text = typeof children === "string" ? <div className="oh-message-body">{children}</div> : children;
  const shut = clip ? !clip.open : false;
  const waits = Boolean(lead || after || files);
  const [cut, fits] = useFits(shut);
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
      {shut ? null : lead}
      {clip ? (
        <div
          ref={cut}
          className="oh-message-clip"
          data-shut={shut ? "" : undefined}
          data-fits={fits ? "" : undefined}
        >
          {text}
        </div>
      ) : (
        text
      )}
      {shut ? null : after}
      {shut ? null : files}
      {clip && !(shut && fits && !waits) ? (
        <div className="oh-message-more" data-open={clip.open ? "" : undefined}>
          <Button
            kind="two"
            size="s"
            mark={clip.goes ? "go" : "down"}
            expanded={clip.goes ? undefined : clip.open}
            onPress={clip.onPress}
          >
            {clip.word}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** Whether a cut text is whole in its box after all: measured when it is drawn and when its box changes. */
function useFits(shut: boolean) {
  const cut = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const el = cut.current;
    if (!el || !shut) return;
    const measure = () => setFits(el.clientHeight > 0 && el.scrollHeight <= el.clientHeight + 2);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [shut]);
  return [cut, shut && fits] as const;
}
