import { Fragment, type ReactNode } from "react";
import { AddressText, Avatar, Button } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import "./message-head.css";

/** Somebody the head names: a press opens the contact card at the name. */
export interface HeadPerson {
  name: string;
  /** Their card stands open: the name says so (`aria-expanded`). */
  expanded?: boolean;
  onPress?: (anchor: HTMLElement) => void;
}

/** One line of the details: "Sent", the full date; "From", the name with its address beside it. */
export interface HeadLine {
  term: string;
  value: string;
  note?: string;
}

export interface MessageHeadProps {
  /** Who wrote it. `printed` is the name as the head prints it where that is not the person's own ("You"). */
  sender: {
    name: string;
    address: string;
    printed?: string;
    /** Their card stands open. */
    expanded?: boolean;
    onPress?: (anchor: HTMLElement) => void;
  };
  /** Not read yet: the dot on the circle. */
  unread?: boolean;
  /** What was kept out of the letter, as its one chip. */
  note?: ReactNode;
  /** The message's own menu. */
  menu?: { label: string; expanded?: boolean; onPress?: (anchor: HTMLElement) => void };
  /**
   * When, as it is printed. A press turns short times into full dates and back; `title` says what a press does. `at`:
   * the instant, as a machine reads it (an ISO date), behind the printed words.
   */
  stamp: { when: string; full: boolean; title: string; at?: string; onPress?: () => void };
  /** The recipients, a group a word: "to", "cc". */
  to?: readonly { word: string; people: readonly HeadPerson[] }[];
  /** The word that opens the full lines, and the lines. */
  details?: { label: string; open: boolean; onToggle?: () => void; lines: readonly HeadLine[] };
  /**
   * What stands under the recipients, a line each: what was kept out, in full, while the details are
   * open; that the away responder answered, and `when`; where it was forwarded to. With `lead` the line tells
   * of something that went wrong with this letter (its copy for the Sent folder was not saved): what it is,
   * as it is printed with its stop, heavy before the sentence, in the ink under the warning sign.
   */
  marks?: readonly { text: string; when?: string; lead?: string }[];
}

/** The sender, one button: the circle, the name and the address, whose domain is never cut. */
function Sender({ sender, unread }: Pick<MessageHeadProps, "sender" | "unread">) {
  const printed = sender.printed ?? sender.name;
  return (
    <button
      type="button"
      className="oh-control oh-messagehead-sender"
      data-sender-line=""
      /* The address is drawn in two halves; a screen reader hears it whole, after the name, as the head prints it. */
      aria-label={sender.address !== printed ? `${printed} ${sender.address}` : printed}
      aria-haspopup="dialog"
      aria-expanded={sender.expanded ?? false}
      onClick={(event) => sender.onPress?.(event.currentTarget)}
    >
      <span className="oh-messagehead-line">
        <Avatar name={sender.name} address={sender.address} unread={unread} />
        <span className="oh-messagehead-who">
          <b className="oh-messagehead-name">
            {/* No name: the address stands in its place, and its domain is kept whole there too. */}
            {printed === sender.address ? <AddressText address={printed} /> : printed}
          </b>
          {/* A sender with no name is printed once: the address is not said again beside itself. Its domain is never
            cut (the evidence a stranger is judged by): the local part gives way first. */}
          {sender.address !== printed ? (
            <span className="oh-messagehead-address">
              <AddressText address={sender.address} />
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** Who wrote it, to whom, and when. Every name is a way to the contact card. */
export function MessageHead({ sender, unread, note, menu, stamp, to, details, marks }: MessageHeadProps) {
  return (
    <header className="oh-messagehead" data-noted={note ? "" : undefined}>
      <Sender sender={sender} unread={unread} />
      <span className="oh-messagehead-tools">
        {note ? <span className="oh-messagehead-noted">{note}</span> : null}
        {menu ? (
          <Button
            kind="quiet"
            size="s"
            icon="more"
            label={menu.label}
            opens="menu"
            expanded={menu.expanded}
            onPress={(event) => menu.onPress?.(event.currentTarget)}
          />
        ) : null}
        {/* A letter with no date draws no stamp: no nameless control that toggles nothing. */}
        {stamp.when ? (
          <button
            type="button"
            className="oh-control oh-messagehead-stamp"
            aria-pressed={stamp.full}
            title={stamp.title}
            onClick={stamp.onPress}
          >
            <time className="oh-messagehead-when" dateTime={stamp.at}>
              {stamp.when}
            </time>
          </button>
        ) : null}
      </span>
      {to?.length ? (
        <p className="oh-text oh-messagehead-to">
          {to.map((group, g) => (
            <Fragment key={group.word}>
              {g ? " · " : null}
              {group.word}{" "}
              {group.people.map((person, i) => (
                <Fragment key={i}>
                  {i ? ", " : null}
                  <button
                    type="button"
                    className="oh-control oh-messagehead-person"
                    aria-haspopup="dialog"
                    aria-expanded={person.expanded ?? false}
                    onClick={(event) => person.onPress?.(event.currentTarget)}
                  >
                    {person.name}
                  </button>
                </Fragment>
              ))}
            </Fragment>
          ))}
          {details ? (
            <>
              {" "}
              <button
                type="button"
                className="oh-control oh-messagehead-person"
                data-details=""
                aria-expanded={details.open}
                onClick={details.onToggle}
              >
                {details.label}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {details?.open ? (
        <dl className="oh-messagehead-lines">
          {details.lines.map((line) => (
            <Fragment key={line.term}>
              <dt className="oh-messagehead-term">{line.term}</dt>
              <dd className="oh-messagehead-value">
                {line.value}
                {line.note ? <span className="oh-messagehead-note"> {line.note}</span> : null}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {marks?.map((mark) => (
        <p
          key={mark.text}
          className="oh-text oh-messagehead-mark"
          role="note"
          data-warn={mark.lead ? "" : undefined}
        >
          {mark.lead ? (
            <>
              <Icon name="warn" size={16} />
              <span className="oh-messagehead-warns">
                <b className="oh-messagehead-lead">{mark.lead}</b> {mark.text}
              </span>
            </>
          ) : (
            mark.text
          )}
          {mark.when ? <span className="oh-messagehead-markwhen"> · {mark.when}</span> : null}
        </p>
      ))}
    </header>
  );
}
