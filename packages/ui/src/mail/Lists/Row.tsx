import { useId, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Avatar, Sign, Where } from "../../base/index.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./row.css";
import { useRowSwipe, type RowSwipe } from "./row-swipe.js";

export type { RowSwipe, RowSwipeVerb } from "./row-swipe.js";

/** Somebody of a conversation, as the row's circles show them. */
export interface RowPerson {
  name: string;
  address: string;
}

/**
 * A row standing as an option of a listbox: what a screen reader names it ("Petra Wyss: Your talk"), what it says
 * after the name ("unread"), whether it is selected, and its place in its group when the list draws only some.
 */
export interface RowListing {
  /** What a screen reader names the option: "Petra Wyss: Your talk is on the programme". */
  name: string;
  /** What it says after the name: "Saturday 09:12, unread". Empty or absent, it says nothing more. */
  spoken?: string;
  /** Picked in the list: the option is selected. */
  selected: boolean;
  /** Its place in its group, "2 of 7", where the list draws only some of its rows. */
  place?: { at: number; of: number };
  /** The list's one tab stop (the row the cursor is on) or not; left out, the row is a stop as every row is. */
  stop?: boolean;
}

/** What a list finds its rows by and measures them with: the letter, the letters a folded row holds, its index. */
export interface RowMark {
  /** The letter the row stands for: `data-id`. */
  id: string;
  /** Every letter a folded conversation holds: `data-ids`, none when empty. */
  ids?: readonly string[];
  /** Its index in the list's window: `data-index`, on the row or, where it can be swiped, on its slot. */
  index?: number;
  /** Not seen yet: `data-unseen`, which the seen-on-scroll observer watches for. */
  unseen?: boolean;
}

export interface RowProps {
  /** Line one: who the row speaks for, as the app names them ("Giulia, Ben", "To Nadja Lehner"). */
  who: string;
  /** The address after the name. With a pointer it is the handle of the contact card. */
  address?: string;
  /** The circles: who the row leads with, then one other voice. Empty: the row is no person and shows its `sign`. */
  people: readonly RowPerson[];
  /** From three people on, the small circle counts the others: "+2". */
  peopleMore?: string;
  /** Everybody, said to a screen reader and the pointer: "3 people: Giulia, Ben and you". */
  peopleLabel?: string;
  /** The sign of a row that is no person. */
  sign?: IconName;
  /**
   * A section of Settings, not a letter: its name in the ink whether or not it wants the person, its value
   * set off from the detail. Unread: it wants the person, and its sign carries the dot.
   */
  entry?: boolean;
  /** Line two: what it is about. A node where the app marks what a search found. */
  subject: ReactNode;
  /** The first words of the letter. */
  preview?: string;
  /** When it arrived, as it is printed. */
  when?: string;
  /** An amount in place of the time. */
  amount?: string;
  /** It carries a file: the paper-clip, by this name. */
  file?: string;
  /** How far the conversation is read: its squares. */
  squares?: ReactNode;
  /** One tag, whole or not there. */
  tag?: ReactNode;
  /** The place the letter is in, as a word. */
  where?: string;
  /** Not read yet: bold, in the ink, the dot on the circle. */
  unread?: boolean;
  /** It is the one open in the reading column. */
  open?: boolean;
  /** The keys are on it. */
  cursor?: boolean;
  /** It is picked: the circle becomes the check. */
  picked?: boolean;
  /** The verb a row offers while the pointer or the keys are on it: Done. */
  quick?: { label: string; icon: IconName; onPress?: () => void };
  /** A button of its own that always stands: Discard, Cancel send. */
  own?: { label: string; icon?: IconName; onPress?: () => void };
  /** Under a finger: the verb at each side, and what a swipe that went far enough does. */
  swipe?: RowSwipe;
  onOpen?: () => void;
  /** A press on the address: the contact card opens at it. */
  onContact?: (anchor: HTMLElement) => void;
  /** A right click, the menu key or the other key that opens the context menu: the row's menu, where the pointer is. */
  onMenu?: (at: { x: number; y: number }) => void;
  /** In a listbox: the row is an option, named and described as the list says. Absent, it is a button. */
  listing?: RowListing;
  /** The marks a list finds the row by; with `swipe` the index rides the slot, which is what is measured. */
  mark?: RowMark;
}

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

/** One conversation: who, what about, how far read. */
export function Row(props: RowProps) {
  const { subject, preview, unread, open, picked, entry, quick, own, onOpen, onContact, onMenu } = props;
  const swipe = useRowSwipe(props.swipe);
  const { listing, mark } = props;
  /* WebKitGTK does not expose aria-description; a description a hidden node carries, it does. */
  const saidId = useId();
  const said = listing?.spoken ? saidId : undefined;

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onOpen?.();
  };
  const menu = onMenu
    ? (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }
    : undefined;
  const contact = onContact
    ? (event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        onContact(event.currentTarget);
      }
    : undefined;

  const row = (
    <div
      className="oh-row"
      role={listing ? "option" : "button"}
      tabIndex={listing?.stop === false ? -1 : 0}
      aria-label={listing?.name}
      aria-description={listing?.spoken || undefined}
      aria-describedby={said}
      aria-posinset={listing?.place?.at}
      aria-setsize={listing?.place?.of}
      data-id={mark?.id}
      data-ids={mark?.ids && mark.ids.length > 0 ? mark.ids.join(" ") : undefined}
      data-index={props.swipe ? undefined : mark?.index}
      data-unseen={mark?.unseen ? "1" : undefined}
      data-entry={entry ? "" : undefined}
      data-unread={unread ? "" : undefined}
      data-open={open ? "" : undefined}
      data-cursor={props.cursor ? "" : undefined}
      data-picked={picked ? "" : undefined}
      data-own={own ? "" : undefined}
      data-swiping={swipe.moving ? "" : undefined}
      aria-selected={listing ? listing.selected : picked ? true : undefined}
      style={swipe.style}
      onClick={onOpen}
      onKeyDown={key}
      onContextMenu={menu}
      {...swipe.handlers}
    >
      <RowFace {...props} />
      <RowFirst {...props} contact={contact} />
      <span className="oh-row-second">
        <span className="oh-row-subject">{subject}</span>
        {preview ? <> </> : null}
        {preview ? (
          <span className="oh-row-preview">
            {entry && subject ? <i className="oh-row-sep">· </i> : null}
            {preview}
          </span>
        ) : null}
      </span>
      <RowVerbs quick={quick} own={own} />
      {said ? <span id={said} hidden aria-label={listing?.spoken} /> : null}
    </div>
  );
  /* Where a row can be swiped it lies in a slot of its own, and the verb it lands on stands on the ground behind it. */
  return props.swipe ? (
    <div className="oh-row-slot" data-index={mark?.index}>
      {swipe.back}
      {row}
    </div>
  ) : (
    row
  );
}

/** The circle or circles, the sign of a section, and the check a pick turns it into. */
function RowFace({ people, peopleMore, peopleLabel, sign, entry, unread }: RowProps) {
  const [lead, second] = people;
  return (
    <span
      className="oh-row-face"
      data-pair={second || peopleMore ? "" : undefined}
      role={peopleLabel ? "img" : undefined}
      aria-label={peopleLabel}
      title={peopleLabel}
    >
      {lead ? (
        <Avatar name={lead.name} address={lead.address} unread={unread} />
      ) : sign ? (
        <Sign icon={sign} unread={entry && unread} />
      ) : null}
      {peopleMore ? (
        <span className="oh-row-more" aria-hidden="true">
          {peopleMore}
        </span>
      ) : second ? (
        <Avatar name={second.name} address={second.address} size="xs" />
      ) : null}
      <i className="oh-row-check">
        <Icon name="check" size={18} />
      </i>
    </span>
  );
}

/** Line one: who, the address, and at its end the marks and the time. */
function RowFirst(props: RowProps & { contact?: (event: MouseEvent<HTMLElement>) => void }) {
  const { who, address, contact } = props;
  return (
    <span className="oh-row-first">
      <b className="oh-row-who">{who}</b>
      {address ? (
        <span className="oh-row-address" data-press={contact ? "" : undefined} onClick={contact}>
          {address}
        </span>
      ) : null}
      <span className="oh-row-room" />
      {props.squares}
      {props.where ? <Where>{props.where}</Where> : null}
      {props.tag}
      {props.file ? (
        <span className="oh-row-file" role="img" aria-label={props.file}>
          <Icon name="clip" size={16} />
        </span>
      ) : null}
      {props.amount ? (
        <span className="oh-row-amount">{props.amount}</span>
      ) : props.when ? (
        <time className="oh-row-when">{props.when}</time>
      ) : null}
    </span>
  );
}

/** The row's verbs: the quick one, and its own button. A press on either leaves the row shut. */
function RowVerbs({ quick, own }: Pick<RowProps, "quick" | "own">) {
  return (
    <>
      {quick ? (
        <span className="oh-row-quick">
          <button
            type="button"
            className="oh-control oh-row-verb"
            onClick={(event) => (stop(event), quick.onPress?.())}
            onKeyDown={stop}
          >
            <Icon name={quick.icon} size={16} />
            <span>{quick.label}</span>
          </button>
        </span>
      ) : null}
      {own ? (
        <button
          type="button"
          className="oh-control oh-row-verb"
          data-own=""
          onClick={(event) => (stop(event), own.onPress?.())}
          onKeyDown={stop}
        >
          {own.icon ? <Icon name={own.icon} size={16} /> : null}
          <span>{own.label}</span>
        </button>
      ) : null}
    </>
  );
}

/**
 * The rows of one group: the list they stand in, set in from the sheet's edge. Named, it is a listbox of options
 * (`Row.listing`), many-selectable when picks are made in it.
 */
export function Rows({ children, label, many }: { children: ReactNode; label?: string; many?: boolean }) {
  return (
    <div
      className="oh-rows"
      role={label ? "listbox" : "list"}
      aria-label={label}
      aria-multiselectable={label && many ? true : undefined}
    >
      {children}
    </div>
  );
}
