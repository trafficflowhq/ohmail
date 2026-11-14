import { useId, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Avatar, Sign, Tag, Where } from "../../base/index.js";
import { cssPoint } from "../../base/ui-zoom.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./row.css";
import { RowPlaceFace, type RowPlace } from "./row-place.js";
import { useKeysFollowStop } from "./row-stop.js";
import { rowSwipe, type RowSwipe } from "./row-swipe.js";
import { breakable, RowAmount, RowTickMark, type RowTick } from "./row-tick.js";

export type { RowPlace } from "./row-place.js";
export type { RowSwipe, RowSwipeVerb } from "./row-swipe.js";
export type { RowTick } from "./row-tick.js";
export { Rows } from "./rows.js";

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
  /**
   * The list's one tab stop (the row the cursor is on) or not; left out, the row is a stop as every row is. A row
   * that becomes the stop takes the keys along from a row that lost it: `row-stop.ts` says when.
   */
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
   * set off from the detail. Unread: it wants the person, and its sign carries the dot. To a screen reader it
   * is named by `who` alone, its value and detail (line two) are its description, and while `open` it is the
   * current page.
   */
  entry?: boolean;
  /** Line two: what it is about. A node where the app marks what a search found. */
  subject: ReactNode;
  /** The first words of the letter. */
  preview?: string;
  /** When it arrived, as it is printed. */
  when?: string;
  /** What a pointer reads on the time: the same instant in the form not on screen. */
  whenTitle?: string;
  /** A press on the time: the list turns every time to its other form. The row does not open. */
  onWhen?: () => void;
  /** An amount in place of the time. */
  amount?: string;
  /** The amount in words, said in the figure's place: "2 messages". */
  amountSaid?: string;
  /** It carries a file: the paper-clip, by this name. */
  file?: string;
  /** How far the conversation is read: its squares. */
  squares?: ReactNode;
  /** One tag, whole or not there. */
  tag?: ReactNode;
  /** The place the letter is in, as a word. */
  where?: string;
  /**
   * What there is to say about the sender, as labels before the time ("Needs you", "2 held"). Each is whole or
   * not there: where the name needs the room a label goes, the last first.
   */
  labels?: readonly string[];
  /**
   * A sender that is not who the name says: the warning sign, named by `label`, and its word, where the address
   * would stand. Never by colour alone.
   */
  flag?: { label: string; word: string };
  /** A row that recedes (a sender taken for junk): its name and subject in the second ink, unless it is the open one. */
  receded?: boolean;
  /** Not read yet: bold, in the ink, the dot on the circle. */
  unread?: boolean;
  /** A row of a stream (News, Receipts): unread, it carries no dot: its newness is its place and its weight. */
  stream?: boolean;
  /** It is the one open in the reading column. */
  open?: boolean;
  /** The keys are on it. */
  cursor?: boolean;
  /** It is picked: the circle becomes the check. */
  picked?: boolean;
  /** The row a search or a link took you to: a wash that settles once, so you see which row it is. */
  located?: boolean;
  /** The verb a row offers while the pointer or the keys are on it: Done. */
  quick?: { label: string; icon: IconName; onPress?: () => void };
  /** A button of its own that always stands: Discard, Cancel send. */
  own?: { label: string; icon?: IconName; onPress?: () => void };
  /** Where a waiting sender's mail would go, at the end of the last line: accepted by one press, or chosen. */
  place?: RowPlace;
  /** Under a finger: the verb at each side, and how far the list's layer says the row is pulled. */
  swipe?: RowSwipe;
  onOpen?: () => void;
  /** A press on the address: the contact card opens at it. */
  onContact?: (anchor: HTMLElement) => void;
  /** A right click, the menu key or the other key that opens the context menu: the row's menu, where the pointer is. */
  onMenu?: (at: { x: number; y: number }) => void;
  /** In a listbox: the row is an option, named and described as the list says. Absent, it is a button. */
  listing?: RowListing;
  /** A row to tick: it is a checkbox, and no dot stands on its circle. */
  tick?: RowTick;
  /** The marks a list finds the row by; with `swipe` the index rides the slot, which is what is measured. */
  mark?: RowMark;
}

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

/** One conversation: who, what about, how far read. */
export function Row(props: RowProps) {
  const { subject, preview, unread, open, picked, entry, quick, own, onOpen, onContact, onMenu } = props;
  const swipe = rowSwipe(props.swipe);
  const { listing, mark, place, tick } = props;
  const el = useKeysFollowStop(listing?.stop);
  const slotted = Boolean(props.swipe || quick || own || place);
  /* WebKitGTK does not expose aria-description; a description a hidden node carries, it does. */
  const saidId = useId();
  const said = listing?.spoken ? saidId : undefined;
  /* A row whose ticks were taken takes no press. */
  const press = tick?.settled ? undefined : onOpen;
  /* A section of Settings is named by its section alone; what line two says is its description. */
  const section = entry && !listing;
  const secondId = useId();

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    press?.();
  };
  const menu = onMenu
    ? (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        onMenu(cssPoint(event));
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
      ref={el}
      className="oh-row"
      role={tick ? "checkbox" : listing ? "option" : "button"}
      tabIndex={listing?.stop === false ? -1 : 0}
      aria-label={section ? props.who : listing?.name}
      aria-description={listing?.spoken || undefined}
      aria-checked={tick ? tick.on : undefined}
      aria-disabled={tick?.settled ? true : undefined}
      aria-describedby={section ? secondId : said}
      aria-current={section && open ? "page" : undefined}
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
      data-located={props.located ? "" : undefined}
      data-receded={props.receded ? "" : undefined}
      data-own={own ? "" : undefined}
      data-tick={tick ? "" : undefined}
      data-swiping={swipe.moving ? "" : undefined}
      aria-selected={listing ? listing.selected : picked ? true : undefined}
      style={swipe.style}
      onClick={press}
      onKeyDown={key}
      onContextMenu={slotted ? undefined : menu}
    >
      <RowFace {...props} />
      <RowFirst {...props} contact={contact} />
      <span className="oh-row-second" id={section ? secondId : undefined} data-place={place ? "" : undefined}>
        {/* A row that is about nothing (a person to tick) has no subject's line and no space before its preview. */}
        {subject === "" ? null : <span className="oh-row-subject">{subject}</span>}
        {preview && subject !== "" ? <> </> : null}
        {preview ? (
          <span className="oh-row-preview">
            {entry && subject ? <i className="oh-row-sep">· </i> : null}
            {tick ? breakable(preview) : preview}
          </span>
        ) : null}
        {place ? <RowPlaceFace place={place} room /> : null}
      </span>
      {own ? <OwnRoom own={own} /> : null}
      {tick ? <RowTickMark tick={tick} /> : null}
      {said ? <span id={said} hidden aria-label={listing?.spoken} /> : null}
    </div>
  );
  /* A row with verbs, or one that can be swiped, lies in a slot of its own. The verbs stand there beside it (a
     button inside an option or a button is no button to a screen reader), over the room the row keeps for them;
     the verb a swipe lands on stands on the ground behind it. A right click on a verb is the row's menu. */
  if (!slotted) return row;
  return (
    <div className="oh-row-slot" data-index={props.swipe ? mark?.index : undefined} onContextMenu={menu}>
      {swipe.back}
      {row}
      <RowVerbs quick={quick} own={own} travel={swipe.style} />
      {place ? <RowBeside {...props} place={place} travel={swipe.style} /> : null}
    </div>
  );
}

/** The circle or circles, the sign of a section, and the check a pick turns it into. */
function RowFace({ people, peopleMore, peopleLabel, sign, entry, unread, tick, stream }: RowProps) {
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
        <Avatar name={lead.name} address={lead.address} unread={unread && !tick && !stream} />
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
function RowFirst(props: RowProps & { contact?: (event: MouseEvent<HTMLElement>) => void; twin?: boolean }) {
  const { who, address, contact, onWhen } = props;
  const flip = onWhen
    ? (event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        onWhen();
      }
    : undefined;
  return (
    <span className="oh-row-first" aria-hidden={props.twin ? true : undefined}>
      <b className="oh-row-who">{who}</b>
      {props.flag ? (
        <span className="oh-row-flag">
          <span className="oh-row-flag-sign" role="img" aria-label={props.flag.label}>
            <Icon name="warn" size={18} />
          </span>
          <Tag>{props.flag.word}</Tag>
        </span>
      ) : address ? (
        <span
          className="oh-row-address"
          data-press={contact ? "" : undefined}
          data-whole={props.labels?.length ? "" : undefined}
          onClick={contact}
        >
          {props.labels?.length ? <span>{address}</span> : address}
        </span>
      ) : null}
      <span className="oh-row-room" />
      {props.labels && props.labels.length > 0 ? (
        <span className="oh-row-labels">
          {props.labels.map((label) => (
            <Tag key={label}>{label}</Tag>
          ))}
        </span>
      ) : null}
      {props.squares}
      {props.where ? <Where>{props.where}</Where> : null}
      {props.tag}
      {props.file ? (
        <span className="oh-row-file" role="img" aria-label={props.file}>
          <Icon name="clip" size={16} />
        </span>
      ) : null}
      {props.amount ? (
        <RowAmount figure={props.amount} said={props.amountSaid} />
      ) : props.when ? (
        <time
          className="oh-row-when"
          title={props.whenTitle}
          data-press={onWhen ? "" : undefined}
          onClick={flip}
        >
          {props.when}
        </time>
      ) : null}
    </span>
  );
}

/**
 * The place beside the row. The row's two lines stand here once more, unseen and unsaid, so the place's controls
 * lie exactly over the room the row keeps for them, whatever the lines hold and however the row folds.
 */
function RowBeside(props: RowProps & { place: RowPlace; travel?: CSSProperties }) {
  return (
    <span className="oh-row-beside" style={props.travel}>
      <RowFirst {...props} onWhen={undefined} twin />
      <span className="oh-row-second" data-place="">
        <span className="oh-row-subject" aria-hidden="true">
          {props.subject}
        </span>
        {props.preview ? (
          <span className="oh-row-preview" aria-hidden="true">
            {props.preview}
          </span>
        ) : null}
        <RowPlaceFace place={props.place} />
      </span>
    </span>
  );
}

/** The room the row keeps for its own button, which stands beside it over this room: the same box, unseen. */
function OwnRoom({ own }: { own: NonNullable<RowProps["own"]> }) {
  return (
    <span className="oh-row-verb" data-own="" data-room="" aria-hidden="true">
      {own.icon ? <Icon name={own.icon} size={16} /> : null}
      <span data-label={own.label} />
    </span>
  );
}

/** The row's verbs, beside it: the quick one, and its own button, which travels with a pulled row. */
function RowVerbs({ quick, own, travel }: Pick<RowProps, "quick" | "own"> & { travel?: CSSProperties }) {
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
          style={travel}
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
