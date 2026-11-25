import { useId, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Avatar, Sign } from "../../base/index.js";
import { isContextMenuKey, keepsNativeContextMenu } from "../../base/Overlays/menu-place.js";
import { cssPoint, cssRect } from "../../base/ui-zoom.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./row.css";
import { SelectionCircle, SelectionMark, type CircleSelection } from "./SelectionCircle.js";
import { RowFirst, type RowNameAction } from "./row-first.js";
import { RowSecond } from "./row-second.js";
import { RowPlaceFace, type RowPlace } from "./row-place.js";
import { useKeysFollowStop } from "./row-stop.js";
import { rowSwipe, type RowSwipe } from "./row-swipe.js";
import { RowTickMark, type RowTick } from "./row-tick.js";

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
  /** Whether this row is the list's tab stop. Omit it to keep this row tabbable. */
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
  /** The sender identity chip between the name and address. */
  senderCheck?: { label: string; title: string };
  /** The address is identity evidence on this row: let the name yield before its domain. */
  keepAddressDomain?: boolean;
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
  amountSaid?: string;
  /** It carries a file: the paper-clip, by this name. */
  file?: string;
  /** How far the conversation is read: its squares. */
  squares?: ReactNode;
  /** Put the conversation squares beside the preview on a narrow split. */
  squaresBelow?: boolean;
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
  /** A decided row slides toward the rail or fades in place before it leaves the list. */
  leaving?: "rail" | "fade";
  /** The verb a row offers while the pointer or the keys are on it: Done. */
  quick?: { label: string; icon: IconName; onPress?: () => void };
  /** A button of its own that always stands: Discard, Cancel send. */
  own?: { label: string; icon?: IconName; onPress?: () => void };
  /** Where a waiting sender's mail would go, at the end of the last line: accepted by one press, or chosen. */
  place?: RowPlace;
  /** Under a finger: the verb at each side, and how far the list's layer says the row is pulled. */
  swipe?: RowSwipe;
  onOpen?: () => void;
  onKeyboardOpen?: () => void;
  onContact?: (anchor: HTMLElement) => void;
  contactHref?: string;
  /** Toggle the row's avatar, or extend the selection when Shift is pressed. */
  selection?: CircleSelection;
  nameAction?: RowNameAction;
  nameActions?: readonly (RowNameAction & { id: string; text: string })[];
  addressAction?: (anchor: HTMLButtonElement) => void;
  /** A right click, the menu key or the other key that opens the context menu: the row's menu, where the pointer is. */
  onMenu?: (at: { x: number; y: number }, row: HTMLDivElement) => void;
  /** In a listbox: the row is an option, named and described as the list says. Absent, it is a button. */
  listing?: RowListing;
  /** A row to tick: it is a checkbox, and no dot stands on its circle. */
  tick?: RowTick;
  /** The marks a list finds the row by; with `swipe` the index rides the slot, which is what is measured. */
  mark?: RowMark;
}

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

function rowContextMenu(onMenu: RowProps["onMenu"]) {
  const menu = onMenu
    ? (event: MouseEvent<HTMLDivElement>) => {
        if (event.defaultPrevented || keepsNativeContextMenu(event.target)) return;
        event.preventDefault();
        onMenu(cssPoint(event), event.currentTarget);
      }
    : undefined;
  const openKeyMenu = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onMenu || event.defaultPrevented || !isContextMenuKey(event) || keepsNativeContextMenu(event.target))
      return;
    event.preventDefault();
    const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
    const rect = cssRect(target);
    onMenu({ x: rect.left, y: rect.bottom }, event.currentTarget);
  };
  return { menu, openKeyMenu };
}

/** One conversation: who, what about, how far read. */
export function Row(props: RowProps) {
  const { subject, preview, unread, open, picked, entry, quick, own, leaving, onOpen, onContact, onMenu } =
    props;
  const swipe = rowSwipe(props.swipe);
  const { listing, mark, place, selection, tick } = props;
  const el = useKeysFollowStop(listing?.stop);
  const circle = props.people[0] ? selection : undefined;
  const slotted = Boolean(props.swipe || quick || own || place || circle);
  /* WebKitGTK does not expose aria-description; a description a hidden node carries, it does. */
  const saidId = useId();
  const said = listing?.spoken ? saidId : undefined;
  /* A row whose ticks were taken takes no press. */
  const press = tick?.settled ? undefined : onOpen;
  /* A section of Settings is named by its section alone; what line two says is its description. */
  const section = entry && !listing;
  const hasSecond = !section || subject !== "" || Boolean(preview) || Boolean(place);
  const secondId = useId();

  const { menu, openKeyMenu } = rowContextMenu(onMenu);
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onMenu && isContextMenuKey(event)) {
      openKeyMenu(event);
      return;
    }
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    if (press) (props.onKeyboardOpen ?? press)();
  };
  const contact =
    onContact || props.contactHref
      ? (event: MouseEvent<HTMLElement>) => {
          event.stopPropagation();
          if (!onContact) return;
          if (props.contactHref) {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
              return;
            event.preventDefault();
          }
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
      aria-describedby={section ? (hasSecond ? secondId : undefined) : said}
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
      data-leaving={slotted ? undefined : leaving}
      data-receded={props.receded ? "" : undefined}
      data-own={own ? "" : undefined}
      data-tick={tick ? "" : undefined}
      data-swipe-right={props.swipe?.right ? "" : undefined}
      data-swiping={swipe.moving ? "" : undefined}
      aria-selected={listing ? listing.selected : picked ? true : undefined}
      inert={!slotted && leaving !== undefined}
      style={swipe.style}
      onClick={selection?.active ? (event) => selection.onPress(event.shiftKey) : press}
      onKeyDown={key}
      onContextMenu={slotted ? undefined : menu}
    >
      <RowFace {...props} />
      <RowFirst {...props} contact={contact} />
      {hasSecond ? <RowSecond {...props} id={section ? secondId : undefined} /> : null}
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
    <div
      className="oh-row-slot"
      data-index={props.swipe ? mark?.index : undefined}
      data-leaving={leaving}
      inert={leaving !== undefined}
      onContextMenu={menu}
      onKeyDown={openKeyMenu}
    >
      {swipe.back}
      {row}
      {circle ? <SelectionCircle selection={circle} picked={picked} style={swipe.style} /> : null}
      <RowVerbs quick={quick} own={own} travel={swipe.style} />
      {place ? <RowBeside {...props} place={place} travel={swipe.style} /> : null}
    </div>
  );
}

/** The circle or circles, the sign of a section, and the check a pick turns it into. */
function RowFace({ people, peopleMore, peopleLabel, sign, entry, unread, tick, stream, picked }: RowProps) {
  const [lead, second] = people;
  const face = (
    <>
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
    </>
  );
  const pair = second || peopleMore ? "" : undefined;
  const art = (
    <span
      className="oh-row-face-art"
      data-pair={pair}
      role={peopleLabel ? "img" : undefined}
      aria-label={peopleLabel}
      title={peopleLabel}
    >
      {face}
    </span>
  );
  return <span className="oh-row-face">{picked ? <SelectionMark /> : art}</span>;
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
            onKeyDown={(event) => {
              if (!isContextMenuKey(event)) stop(event);
            }}
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
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) stop(event);
          }}
        >
          {own.icon ? <Icon name={own.icon} size={16} /> : null}
          <span>{own.label}</span>
        </button>
      ) : null}
    </>
  );
}
