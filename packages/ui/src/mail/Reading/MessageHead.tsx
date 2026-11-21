import { Fragment, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Avatar, Button } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import { AddressText } from "../AddressText.js";
import "./message-head.css";

/** Somebody the head names, optionally with a contact action. */
export interface HeadPerson {
  name: string;
  title?: string;
  textOnly?: boolean;
  /** Their card stands open: the name says so (`aria-expanded`). */
  expanded?: boolean;
  onPress?: (anchor: HTMLElement) => void;
}

interface HeadGroup {
  word: string;
  people: readonly HeadPerson[];
}

interface HeadDetails {
  label: string;
  open: boolean;
  name?: string;
  max?: number;
  more?: (group: HeadGroup, shown: readonly HeadPerson[]) => { text: string; name: string };
  onToggle?: () => void;
  lines: readonly HeadLine[];
}

/** One line of the details: "Sent", the full date; "From", the name with its address beside it. */
export interface HeadLine {
  term: string;
  value: string;
  note?: string;
}

export interface MessageHeadProps {
  /** Keep a folded preview’s recipient disclosure beside its single recipient field. */
  preview?: boolean;
  /** Show the sender and time as text when the reader has no action for them. */
  staticMetadata?: true;
  /** Who wrote it. `printed` is the name as the head prints it where that is not the person's own ("You"). */
  sender: {
    name: string;
    address: string;
    printed?: string;
    displayAddress?: string;
    /** Their card stands open. */
    expanded?: boolean;
    controls?: string;
    onPress?: (anchor: HTMLElement) => void;
  };
  /** Not read yet: the dot on the circle. */
  unread?: boolean;
  /** What was kept out of the letter, as its one chip. */
  note?: ReactNode;
  /** The sender identity check sentence, when the mail carries one. */
  senderCheck?: string;
  amount?: string;
  /** The receiving mailbox for a stream letter, when there is a choice. */
  delivery?: ReactNode;
  deliveryOpen?: boolean;
  /** The message's own menu. */
  menu?: { label: string; expanded?: boolean; onPress?: (anchor: HTMLElement) => void };
  /**
   * When, as it is printed. A press turns short times into full dates and back; `title` says what a press does. `at`:
   * the instant, as a machine reads it (an ISO date), behind the printed words.
   */
  stamp: { when: string; full: boolean; title: string; at?: string; onPress?: () => void };
  /** The recipients, a group a word: "to", "cc". */
  to?: readonly HeadGroup[];
  /** The word that opens the full lines, and the lines. */
  details?: HeadDetails;
  /**
   * What stands under the recipients, a line each: what was kept out, in full, while the details are
   * open; that the away responder answered, and `when`; where it was forwarded to. With `lead` the line tells
   * of something that went wrong with this letter (its copy for the Sent folder was not saved): what it is,
   * as it is printed with its stop, heavy before the sentence, in the ink under the warning sign.
   * A localized mark can supply formatted content and an accessible label with the full instant.
   */
  marks?: readonly { text: string; when?: string; lead?: string; content?: ReactNode; ariaLabel?: string }[];
}

/** The sender's circle, name and uncut address. */
function Sender({
  sender,
  unread,
  staticMetadata,
}: Pick<MessageHeadProps, "sender" | "unread" | "staticMetadata">) {
  const address = sender.displayAddress ?? sender.address;
  const printed = sender.printed ?? sender.name;
  const addressOnly = printed === sender.address;
  const line = (
    <span className="oh-messagehead-line">
      <Avatar name={sender.name} address={sender.address} unread={unread} />
      <span className="oh-messagehead-who">
        <b className="oh-messagehead-name">
          {/* No name: the address stands in its place, and its domain is kept whole there too. */}
          {addressOnly ? <AddressText address={address} /> : printed}
        </b>
        {/* A sender with no name is printed once: the address is not said again beside itself. Its domain is never
          cut (the evidence a stranger is judged by): the local part gives way first. */}
        {!addressOnly ? (
          <span className="oh-messagehead-address">
            <AddressText address={address} />
          </span>
        ) : null}
      </span>
    </span>
  );
  if (staticMetadata && !sender.onPress) {
    return (
      <div className="oh-messagehead-sender" data-sender-line="">
        {line}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="oh-control oh-messagehead-sender"
      data-sender-line=""
      /* The address is drawn in two halves; a screen reader hears it whole, after the name, as the head prints it. */
      aria-label={addressOnly ? address : `${printed} ${address}`}
      aria-haspopup="dialog"
      aria-expanded={sender.expanded ?? false}
      aria-controls={sender.expanded ? sender.controls : undefined}
      onClick={(event) => sender.onPress?.(event.currentTarget)}
    >
      {line}
    </button>
  );
}

function Stamp({ stamp, staticMetadata }: Pick<MessageHeadProps, "stamp" | "staticMetadata">) {
  const when = (
    <time className="oh-messagehead-when" dateTime={stamp.at}>
      {stamp.when}
    </time>
  );
  if (staticMetadata && !stamp.onPress) {
    return (
      <span className="oh-messagehead-stamp" title={stamp.title}>
        {when}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="oh-control oh-messagehead-stamp"
      aria-pressed={stamp.full}
      title={stamp.title}
      onClick={stamp.onPress}
    >
      {when}
    </button>
  );
}

/** Who wrote it, to whom, and when. */
export function MessageHead({
  sender,
  unread,
  note,
  senderCheck,
  amount,
  delivery,
  deliveryOpen,
  menu,
  stamp,
  to,
  details,
  marks,
  staticMetadata,
  preview,
}: MessageHeadProps) {
  return (
    <header
      className="oh-messagehead"
      data-noted={note ? "" : undefined}
      data-preview={preview ? "" : undefined}
    >
      <Sender sender={sender} unread={unread} staticMetadata={staticMetadata} />
      {delivery ? (
        <span className="oh-messagehead-delivery" data-open={deliveryOpen ? "" : undefined}>
          {delivery}
        </span>
      ) : null}
      <span className="oh-messagehead-tools">
        {amount ? <span className="oh-text oh-messagehead-when">{amount}</span> : null}
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
        {stamp.when && <Stamp stamp={stamp} staticMetadata={staticMetadata} />}
      </span>
      {to?.length ? <Recipients groups={to} details={details} /> : null}
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
          aria-label={mark.ariaLabel}
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
            (mark.content ?? mark.text)
          )}
          {mark.when ? <span className="oh-messagehead-markwhen"> · {mark.when}</span> : null}
        </p>
      ))}
      {senderCheck ? (
        <p className="oh-messagehead-check">
          <Icon name="shield" size={18} />
          <span>{senderCheck}</span>
        </p>
      ) : null}
    </header>
  );
}

function Recipients({ groups, details }: { groups: readonly HeadGroup[]; details?: HeadDetails }) {
  const line = useRef<HTMLParagraphElement>(null);
  const returnTo = useRef<string | null>(null);
  const pressed = useRef<HTMLButtonElement | null>(null);
  const [fits, setFits] = useState<Readonly<Record<string, number>>>({});
  const open = details?.open ?? false;
  const capped = !open && details?.max !== undefined;
  const shown = groups.map((group) =>
    capped
      ? group.people.slice(0, Math.max(1, Math.min(details.max!, fits[group.word] ?? Infinity)))
      : group.people,
  );
  const hasMore = groups.some((group, i) => group.people.length > shown[i]!.length);

  useLayoutEffect(() => {
    if (!capped || !line.current) return;
    const less = recipientFit(line.current, groups, shown);
    if (Object.keys(less).length) setFits({ ...fits, ...less });
  }, [capped, fits, groups, shown]);
  useLayoutEffect(() => {
    const el = line.current;
    if (!capped || !el || typeof ResizeObserver !== "function") return;
    let width = el.clientWidth;
    const resize = new ResizeObserver(() => {
      if (width !== el.clientWidth) {
        width = el.clientWidth;
        setFits({});
      }
    });
    resize.observe(el);
    return () => resize.disconnect();
  }, [capped]);
  useLayoutEffect(() => {
    const was = pressed.current;
    pressed.current = null;
    if (!was || was.isConnected || !line.current) return;
    const candidates = [...line.current.querySelectorAll<HTMLButtonElement>("button[data-details]")];
    (candidates.find((candidate) => candidate.dataset.details === returnTo.current) ?? candidates[0])?.focus({
      preventScroll: true,
    });
  }, [open]);

  function disclosure(event: MouseEvent<HTMLButtonElement>) {
    pressed.current = event.currentTarget;
    if (!open) returnTo.current = event.currentTarget.dataset.details ?? null;
    details?.onToggle?.();
  }

  return (
    <p ref={line} className="oh-text oh-messagehead-to" data-folded={capped ? "" : undefined}>
      {groups.map((group, index) => {
        const people = shown[index]!;
        const more = group.people.length > people.length ? details?.more?.(group, people) : undefined;
        return (
          <Fragment key={group.word}>
            {index > 0 ? " · " : null}
            <span className="oh-messagehead-field" data-recipient-field={group.word}>
              <span>{group.word} </span>
              {people.map((person, at) => (
                <Fragment key={at}>
                  {at ? <span>, </span> : null}
                  {person.textOnly ? (
                    <span className="oh-messagehead-person">{person.name}</span>
                  ) : (
                    <button
                      type="button"
                      className="oh-control oh-messagehead-person"
                      aria-haspopup="dialog"
                      aria-expanded={person.expanded ?? false}
                      title={person.title}
                      onClick={(event) => person.onPress?.(event.currentTarget)}
                    >
                      {person.name}
                    </button>
                  )}
                </Fragment>
              ))}
              {more ? (
                <button
                  type="button"
                  className="oh-control oh-messagehead-person"
                  data-details={group.word}
                  aria-label={more.name}
                  aria-expanded={false}
                  onClick={disclosure}
                >
                  {more.text}
                </button>
              ) : null}
            </span>
          </Fragment>
        );
      })}
      {details && !hasMore && (open || details.name !== undefined || details.max === undefined) ? (
        <>
          {" "}
          <button
            type="button"
            className="oh-control oh-messagehead-person"
            data-details=""
            aria-label={details.name}
            aria-expanded={open}
            onClick={disclosure}
          >
            {details.label}
          </button>
        </>
      ) : null}
    </p>
  );
}

function recipientFit(
  line: HTMLElement,
  groups: readonly HeadGroup[],
  shown: ReadonlyArray<readonly unknown[]>,
): Record<string, number> {
  const clipped = [...line.querySelectorAll<HTMLElement>("[data-recipient-field]")].filter((field) =>
    [...field.querySelectorAll<HTMLElement>("button:not([data-details])")].some(
      (name) => name.clientWidth > 0 && name.scrollWidth > name.clientWidth + 1,
    ),
  );
  const less: Record<string, number> = {};
  for (const field of clipped) {
    const name = field.dataset.recipientField!;
    const at = groups.findIndex((group) => group.word === name);
    const count = shown[at]?.length ?? 0;
    if (count > 1) less[name] = count - 1;
  }
  return less;
}
