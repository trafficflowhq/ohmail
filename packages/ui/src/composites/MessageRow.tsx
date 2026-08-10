import type { ReactNode } from "react";
import { Avatar } from "../primitives/Avatar.js";
import { Badge, Chip, type TagHueName } from "../primitives/Chip.js";
import "./row.css";

export interface MessageRowTag {
  name: string;
  hue: TagHueName;
}

export interface MessageRowProps {
  /** Stable id, stamped as data-id (and used by useSeenOnScroll). */
  id: string;
  from: string;
  address?: string;
  time?: string;
  subject: string;
  preview?: string;
  /** Receipts: right-aligned amount. */
  amount?: string;
  unread?: boolean;
  /** Seen styling (quiet ink, lighter weights). */
  seen?: boolean;
  /** The unread dot fades in place after being marked seen. */
  justSeen?: boolean;
  selected?: boolean;
  /**
   * MULTI-SELECT MEMBERSHIP, and why it changes the row's ROLE.
   *
   * Measured live on 2026-08-02: picking rows in the Ohbox set `aria-selected` on zero of
   * them. The pick was a class name and nothing else, so a screen reader could not tell a
   * picked row from any other and the bulk action operated on a set the user could not
   * perceive.
   *
   * `aria-selected` is only meaningful on `option`/`row`/`gridcell`/`tab` — putting it on a
   * `button` is invalid ARIA that some readers ignore — so a row that participates in a
   * multi-select declares `role="option"` and its container declares `role="listbox"`
   * (`ListRows`). The element stays a focusable `<button>`; only the role changes, and the
   * row has no interactive descendants, which is what `option` requires.
   *
   * `aria-pressed` was the alternative and it describes the wrong action: clicking a row
   * moves the CURSOR, `x` picks. A toggle button would announce the click as the toggle.
   *
   * Undefined ⇒ this list has no multi-select and the row stays a plain button. Every list
   * but the Ohbox is untouched.
   */
  picked?: boolean;
  /** Spam-grade rendering — less ink. */
  dull?: boolean;
  threadCount?: number;
  /**
   * THREAD PARTICIPANTS — the people in this conversation, replacing the numeric thread badge.
   *
   * Up to three overlapping sender circles, newest voice first, computed by
   * `threadParticipants` and never derived in the row. Present and non-empty ⇒ the circles render
   * in place of the `⤷ N` badge; absent or empty ⇒ the numeric badge stays. The slot is a fixed,
   * overlap-bounded width (a negative-margin stack), so a two- and a three-person thread cost the
   * row the same space and the subject beside it never shifts.
   */
  participants?: { initials: string; hue: number }[];
  hasAttachment?: boolean;
  /** Protected badge (shield + "protected"). */
  protected?: boolean;
  tags?: MessageRowTag[];
  /** Cross-view badge naming the message's home (Tag view). */
  place?: string;
  /**
   * The sender's initial circle. Started as the Screener's own variant and is now the
   * lead of every mail row — one row language, so the Ohbox and the Screener
   * do not describe the same person two different ways.
   */
  avatarInitial?: string;
  /** Deterministic per-sender hue for the circle; see `Avatar`. */
  avatarHue?: number;
  /** Screener variant: AI suggestion chip ("→ Reads 0.88"). */
  aiSuggestion?: { destLabel: string; confidence: number };
  /** Screener variant: held-mail count chip. */
  heldCount?: number;
  /** Spam variant: detection badge text. */
  detection?: string;
  /**
   * A TRAILING CONTROL SLOT — rendered BESIDE the row, never inside it.
   *
   * The row is a `<button>`, and a button may not contain another one: nested interactive
   * content is a parse error, so the browser HOISTS the inner control out of the row and the
   * two end up siblings anyway — with the DOM no longer matching the tree React thinks it
   * rendered. It would also break the `role="option"` contract stated on {@link picked}, which
   * requires the row to have no interactive descendants.
   *
   * So a row with actions renders as a flex pair inside one presentational wrapper: the row
   * button, which keeps every class, `data-id` and role it has always had, and this slot
   * beside it. `role="presentation"` on the wrapper is what keeps a `listbox`'s ownership of
   * its `option` rows intact across the extra element.
   *
   * ABSENT BY DEFAULT, and absent means the row renders exactly as it always did — the bare
   * button, no wrapper. Every list but the one that opts in is untouched, byte for byte.
   *
   * A caller that wants the slot to come and go DURING a row's exit animation should pass a
   * component that returns null rather than dropping the prop: changing the prop from present
   * to absent changes the element tree around the button, which remounts it and kills the
   * transition mid-flight.
   */
  actions?: ReactNode;
  onClick?: () => void;
  className?: string;
}

/**
 * The one row language shared by every list in ohmail. Variants are
 * additive: unread dot, badges, tag chips, right-aligned amount,
 * screener avatar + AI suggestion, quiet/dull spam rendering.
 */
export function MessageRow(props: MessageRowProps) {
  const {
    id,
    from,
    address,
    time,
    subject,
    preview,
    amount,
    unread,
    seen,
    justSeen,
    selected,
    picked,
    dull,
    threadCount,
    participants,
    hasAttachment,
    tags,
    place,
    avatarInitial,
    avatarHue,
    aiSuggestion,
    heldCount,
    detection,
    actions,
    onClick,
    className,
  } = props;

  const badges: ReactNode[] = [];
  // the participant circles REPLACE the numeric badge when present — "who is in this
  // conversation" carries more than "how many mails", and a same-sender thread (the selector
  // answers `[]` for it) keeps the count. `aria-hidden` like the badge it stands in for: the
  // thread hint is decorative, and the row's own `aria-label` already names sender and subject.
  if (participants && participants.length > 0)
    badges.push(
      <span className="thread-circles" key="thread" aria-hidden="true">
        {participants.map((p, i) => (
          <Avatar key={i} initials={p.initials} hue={p.hue} size="s" />
        ))}
      </span>,
    );
  else if (threadCount) badges.push(<Badge key="thread">⤷ {threadCount}</Badge>);
  if (hasAttachment) badges.push(<Badge key="attach" icon="clip" />);
  if (props.protected)
    badges.push(
      <Badge key="protected" variant="shield" icon="shield">
        protected
      </Badge>,
    );
  for (const t of tags ?? [])
    badges.push(
      <Chip key={`tag-${t.name}`} variant="tag" hue={t.hue}>
        {t.name}
      </Chip>,
    );
  if (place)
    badges.push(
      <Badge key="place" variant="place">
        {place}
      </Badge>,
    );

  const cls = [
    "row",
    avatarInitial !== undefined ? "srow" : null,
    seen ? "seen" : null,
    justSeen ? "justseen" : null,
    selected ? "sel" : null,
    picked ? "picked" : null,
    dull ? "dull" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // See `picked` above: opting into the multi-select changes the role, because that is the
  // only role `aria-selected` is defined on.
  const selection =
    picked === undefined
      ? {}
      : ({ role: "option", "aria-selected": picked ? "true" : "false" } as const);

  const chips: ReactNode[] = [];
  if (aiSuggestion)
    chips.push(
      <Badge key="ai" variant="ai">
        → {aiSuggestion.destLabel} <span className="num">{aiSuggestion.confidence.toFixed(2)}</span>
      </Badge>,
    );
  if (heldCount !== undefined && heldCount > 1)
    chips.push(<Badge key="held">{heldCount} held</Badge>);
  if (detection) chips.push(<Badge key="det">{detection}</Badge>);

  const body = (
    <>
      <span className="row-top">
        {unread ? <span className="dot-unread" /> : null}
        <span className="who">{from}</span>
        {address ? <span className="addr">{address}</span> : null}
        {time ? <span className="t num">{time}</span> : null}
      </span>
      <span className="row-mid">
        <span className="subj">
          {subject}
          {badges.length ? <span className="badges">{badges}</span> : null}
        </span>
        {amount ? <span className="amt num">{amount}</span> : null}
      </span>
      {preview ? <span className="prev" style={{ display: "block" }}>{preview}</span> : null}
      {chips.length ? <span className="sr-chips">{chips}</span> : null}
    </>
  );

  const rowButton = (
    <button
      type="button"
      className={cls}
      data-id={id}
      data-unseen={unread ? "1" : undefined}
      aria-label={`${from}: ${subject}`}
      {...selection}
      onClick={onClick}
    >
      {avatarInitial !== undefined ? (
        <>
          <Avatar initials={avatarInitial} hue={avatarHue} />
          <span className="sr-main">{body}</span>
        </>
      ) : (
        body
      )}
    </button>
  );

  // See `actions`: no slot ⇒ the row IS the button, unchanged.
  if (actions === undefined) return rowButton;
  return (
    <div className="row-slot" role="presentation">
      {rowButton}
      <span className="row-actions">{actions}</span>
    </div>
  );
}
