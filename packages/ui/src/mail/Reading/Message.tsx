import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  /** How the list opens this folded card from the keyboard. */
  description?: string;
  /** Only a snippet is available, so opening the message can still reveal more. */
  incomplete?: boolean;
  /** A body is arriving and the available preview is still provisional. */
  pending?: boolean;
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
  /** A receipt amount beside the folded subject, and below it when opened. */
  amount?: string;
  /** What stands between the subject and the text: an event found in the letter. */
  lead?: ReactNode;
  /** The letter: plain text as a string, or the body the app draws. */
  children: ReactNode;
  /** What follows the text: an invitation, its files. */
  after?: ReactNode;
  files?: ReactNode;
  /** The element's id, for a jump to this message. */
  id?: string;
  /** Position in a feed whose other articles can be mounted on demand. */
  position?: { at: number; total: number };
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
  amount,
  lead,
  children,
  after,
  files,
  id,
  position,
  clip,
}: MessageProps) {
  const text = typeof children === "string" ? <div className="oh-message-body">{children}</div> : children;
  const heading = subject ? <h2 className="oh-text oh-display oh-message-subject">{subject}</h2> : null;
  const amountLine = amount ? <p className="oh-text oh-display oh-message-amount">{amount}</p> : null;
  const cutId = useId();
  const shut = clip ? !clip.open : false;
  const waits = Boolean(lead || after || files || clip?.incomplete || clip?.pending);
  const [cut, fits] = useFits(shut);
  return (
    <article
      className="oh-message"
      id={id}
      aria-description={shut ? clip?.description : undefined}
      aria-posinset={position?.at}
      aria-setsize={position?.total}
      data-unread={unread ? "" : undefined}
      data-back={back ? "" : undefined}
    >
      {head}
      {line ? <p className="oh-text oh-message-line">{line}</p> : null}
      {amount ? (
        <div className="oh-message-heading" data-preview={shut ? "" : undefined}>
          {shut ? amountLine : null}
          {heading}
          {shut ? null : amountLine}
        </div>
      ) : (
        heading
      )}
      {shut ? null : lead}
      {clip ? (
        <div
          ref={cut}
          id={cutId}
          className="oh-message-clip"
          data-shut={shut ? "" : undefined}
          data-fits={fits ? "" : undefined}
          data-pending={clip.pending ? "" : undefined}
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
            controls={clip.goes ? undefined : cutId}
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
