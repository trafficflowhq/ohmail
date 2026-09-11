import type { MouseEvent, ReactNode } from "react";
import { Avatar } from "../primitives/Avatar.js";
import { Badge, Chip, type TagHueName } from "../primitives/Chip.js";
import "./row.css";

export interface MessageRowTag {
  name: string;
  hue: TagHueName;
}

/**
 * How many faces a thread row may show beside its subject.
 *
 * A hard visual cap. The circles ride the badge strip on the subject line at a fixed 18px,
 * overlapping by 6px (`row.css`), so each further face costs the strip 12px of the width the
 * subject would otherwise have — three is where a stack still reads as a group of people rather
 * than a smear, and where the strip still fits beside a subject on a 390px screen. Whatever the
 * caller hands over, three is what is drawn, and there is no "+N" circle: the `⤷ N` count
 * standing immediately before the stack is already the overflow.
 */
export const THREAD_CIRCLES_MAX = 3;

export interface MessageRowProps {
  /** Stable id, stamped as data-id (and used by useSeenOnScroll). */
  id: string;
  /**
   * EVERY MESSAGE THIS ROW STANDS FOR — for rows that fold a conversation.
   *
   * `data-id` names the row's lead and always has; a folded row also SHOWS its other members,
   * and anything that needs to find "the row where message X is" (the shell's locate-and-flash
   * after a search jump) matched nothing when X was a folded member. Stamped as a space-
   * separated `data-ids`, the list shape the `~=` attribute selector exists for. Absent ⇒ no
   * attribute — a singleton row keeps rendering byte-for-byte as before.
   */
  memberIds?: string[];
  from: string;
  address?: string;
  time?: string;
  /**
   * The stamp's hover title: the same instant in the other form. A row
   * stamp is relative ("Sat", "09:12") and cannot say which Saturday, so
   * the caller hands over the absolute form and it hangs on the stamp;
   * when the list is flipped ({@link onToggleTime}) this is the relative
   * one — the title always names whichever form is not on screen. Data,
   * not a dependency: independent of the flip, so a surface without one
   * still says the exact instant on hover. Absent ⇒ no title.
   */
  timeTitle?: string;
  /**
   * Flip every stamp in the list between relative and absolute — or absent
   * where no surface holds that preference. One press changes the whole
   * list (AppShell owns the state); this component only reports the press.
   * The stamp is not a nested control — the HTML parser closes a <button>
   * at an inner button's start tag, and a tabindex span breaks the
   * "no interactive descendants" contract of `role="option"` rows — so the
   * press is hit-tested via `data-stamp` (the `sender-hit.ts` pattern).
   * The keyboard route is the open message's stamp. Absent ⇒ inert span.
   */
  onToggleTime?: () => void;
  subject: string;
  /**
   * A quiet destination gloss after the subject — "← Reads", where a
   * restore would put this message back. Only the Trash list has a
   * destination to name. It rides the subject's line, is the first thing
   * clipped, and is hidden under 640px. A string and not a node: the row
   * is a <button>, and markup here would be one paste away from a control
   * inside one (the parse failure {@link MessageRowProps.onToggleTime}
   * records). Absent ⇒ nothing rendered, rows byte-identical.
   */
  destination?: string;
  preview?: string;
  /** Receipts: right-aligned amount. */
  amount?: string;
  unread?: boolean;
  /**
   * Drop the row's dot, for lists whose newness lives on a waterline
   * (Reads, Receipts: "new" means "above the line"). A dotless row still
   * stamps `data-unseen` from `unread` — the seen-on-scroll observer
   * selects on it and the state flows to the user's own IMAP server.
   * This flag does not drop `seen`'s quiet ink: readness is the mailbox's
   * statement (`\Seen`), and a row may not render a claim the IMAP master
   * contradicts. Absent ⇒ the row is exactly what it always was, dot and
   * all — the Ohbox's contract.
   */
  dotless?: boolean;
  /** Seen styling (quiet ink, lighter weights). */
  seen?: boolean;
  /** The unread dot fades in place after being marked seen. */
  justSeen?: boolean;
  selected?: boolean;
  /**
   * Multi-select membership, and why it changes the row's role: picking
   * rows once set `aria-selected` on none of them, and `aria-selected` is
   * only valid on option/row/gridcell/tab. So a multi-select row declares
   * `role="option"` inside a `role="listbox"` container (`ListRows`); the
   * element stays a focusable <button> with no interactive descendants,
   * which `option` requires. `aria-pressed` would describe the wrong
   * action (click moves the cursor, `x` picks). Undefined ⇒ no
   * multi-select; the row stays a plain button.
   */
  picked?: boolean;
  /** Spam-grade rendering — less ink. */
  dull?: boolean;
  threadCount?: number;
  /**
   * Thread participants: two or more entries draw overlapping small
   * circles in the badge strip, newest voice first, after the `⤷ N` count
   * — same {@link Avatar}, same address-keyed hue as everywhere else. The
   * lead circle stays {@link avatarInitial}: the lead decides where the
   * row's text begins, and a stack there would misalign thread rows
   * against singleton neighbours. Circles say who, the count says how
   * many ({@link THREAD_CIRCLES_MAX} caps the stack). Fewer than two ⇒
   * the row renders byte-for-byte as one with no participants.
   */
  participants?: { initials: string; hue: number }[];
  hasAttachment?: boolean;
  /**
   * The protected badge's WORD, from the host's catalogue — and the badge renders only when it is
   * given. It used to be a `protected?: boolean` with the English literal "protected" inside this
   * component, which put an English capsule on every held row of a German window.
   */
  protectedLabel?: ReactNode;
  tags?: MessageRowTag[];
  /** Cross-view badge naming the message's home (Tag view). */
  place?: string;
  /**
   * A QUIET STATE NOTE on the badge strip — "Answer later", "Parked", "Back Tue 09:00".
   *
   * A message filed into a triage pile looked identical to its neighbours in the Ohbox, so
   * re-queueing something already queued (and losing a resurface date to it) was routine —
   * the state existed only on a different screen. Rendered with the `place` badge's own
   * quiet treatment because it answers the same kind of question ("where does this stand"),
   * not a tag's: a tag is the reader's mark, this is the product's.
   */
  stateNote?: string;
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
  /** The held chip's whole phrase ("2 held"), rendered only when `heldCount > 1`. */
  heldLabel?: ReactNode;
  /** Spam variant: detection badge text. */
  detection?: string;
  /**
   * A trailing control slot, rendered beside the row, never inside it:
   * the row is a <button>, nested interactive content is a parse error
   * the browser resolves by hoisting the inner control out, and
   * `role="option"` requires no interactive descendants. A row with
   * actions renders as a flex pair in one `role="presentation"` wrapper,
   * the row button unchanged beside this slot. Absent ⇒ the bare button.
   * To toggle during an exit animation pass a component that returns
   * null — dropping the prop remounts the button mid-transition.
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
    memberIds,
    from,
    address,
    time,
    timeTitle,
    onToggleTime,
    subject,
    destination,
    preview,
    amount,
    unread,
    dotless,
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
    stateNote,
    avatarInitial,
    avatarHue,
    aiSuggestion,
    heldCount,
    heldLabel,
    detection,
    actions,
    onClick,
    className,
  } = props;

  /**
   * Two strip groups, split by what may give way under width pressure.
   * `keep` holds members whose intrinsic width is bounded (thread count,
   * participant faces, attachment clip, protected capsule) and never
   * shrinks — a row that hides its thread count reads as a single message.
   * `tail` holds the unbounded members (tag chips, place and state notes)
   * and alone shrinks and clips. The split is structural: no CSS floor
   * expresses "as wide as the bounded members"; `min-width:min-content`
   * pulls chip text back in and `overflow:hidden` clips the kept members.
   */
  const keep: ReactNode[] = [];
  const tail: ReactNode[] = [];
  if (threadCount) keep.push(<Badge key="thread" className="bdg-thread">⤷ {threadCount}</Badge>);
  /**
   * THE CONVERSATION'S FACES, DIRECTLY AFTER ITS COUNT — see
   * {@link MessageRowProps.participants} for why they stand here and not in the row's lead.
   *
   * The order in the strip is the order of the two facts: how many messages, then who is in
   * them. Both belong to the same conversation, so they read as one statement about it rather
   * than as a count and an unrelated ornament separated by an attachment clip or a tag chip.
   * `aria-hidden` for the same reason each {@link Avatar} carries it — the faces are decorative,
   * and the row's own `aria-label` already names the sender and the subject.
   */
  const circles = (participants ?? []).slice(0, THREAD_CIRCLES_MAX);
  if (circles.length > 1)
    keep.push(
      <span className="thread-circles" key="circles" aria-hidden="true">
        {circles.map((p, i) => (
          <Avatar key={`${p.initials}-${i}`} initials={p.initials} hue={p.hue} size="s" />
        ))}
      </span>,
    );
  if (hasAttachment) keep.push(<Badge key="attach" icon="clip" />);
  if (props.protectedLabel !== undefined)
    keep.push(
      <Badge key="protected" variant="shield" icon="shield">
        {props.protectedLabel}
      </Badge>,
    );
  for (const t of tags ?? [])
    tail.push(
      <Chip key={`tag-${t.name}`} variant="tag" hue={t.hue}>
        {t.name}
      </Chip>,
    );
  if (place)
    tail.push(
      <Badge key="place" variant="place">
        {place}
      </Badge>,
    );
  if (stateNote)
    tail.push(
      <Badge key="state" variant="place">
        {stateNote}
      </Badge>,
    );

  /**
   * THE ROW'S LEAD — one sender's circle, or nothing.
   *
   * ONE LEAD, ONE SHAPE, EVERY ROW: the sender's single full-size circle, whether the row stands
   * for one message or for a conversation of six. The lead is the row's left edge and therefore
   * the start of its text column, so it is the one part of a row that may not vary with how many
   * people are involved — see {@link MessageRowProps.participants}, whose faces ride the subject
   * line for exactly that reason. Absent {@link avatarInitial} ⇒ no lead and no `.srow` flex
   * layout, which is the plain block row every list started from.
   */
  const lead =
    avatarInitial !== undefined ? <Avatar initials={avatarInitial} hue={avatarHue} /> : null;

  const cls = [
    "row",
    lead !== null ? "srow" : null,
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
  /* The chip's whole phrase, from the host — the count is the host's to place, because "2 held"
     and "2 zurückgehalten" do not put the number in the same relation to the word everywhere.
     `heldCount` still decides WHETHER the chip appears; the words are not this file's. */
  if (heldCount !== undefined && heldCount > 1 && heldLabel !== undefined)
    chips.push(<Badge key="held">{heldLabel}</Badge>);
  if (detection) chips.push(<Badge key="det">{detection}</Badge>);

  const body = (
    <>
      <span className="row-top">
        {unread && !dotless ? <span className="dot-unread" /> : null}
        <span className="who">{from}</span>
        {address ? <span className="addr">{address}</span> : null}
        {/* See `onToggleTime`: `data-stamp` is the hit target the row's own press looks for, and
            it exists ONLY where a flip is wired — so an unwired stamp can never be routed to a
            handler that is not there. `tog` is the pressable styling, `title` is independent. */}
        {time ? (
          <span
            className={onToggleTime ? "t num tog" : "t num"}
            title={timeTitle || undefined}
            data-stamp={onToggleTime ? "" : undefined}
          >
            {time}
          </span>
        ) : null}
      </span>
      {/* The badge strip is the SUBJECT'S SIBLING, never its child (2026-08-31). Inside
          `.subj` — a nowrap/hidden/ellipsis span — every badge vanished the moment a subject
          ran long: the thread's `⤷ N`, the participants, the tag chips, all silently cut by
          the ellipsis, at exactly the list widths the product actually renders (a 368px demo
          pane hid the fixture thread's count in the mono face). A thread count is information,
          not decoration, so the subject is what yields first; inside the strip, the bounded
          `keep` group never shrinks and the unbounded `tail` clips — see the split above and
          the pressure order in row.css. */}
      <span className="row-mid">
        <span className="subj">{subject}</span>
        {/* The gloss sits between the subject and the badge strip, on the subject's own line —
            see {@link MessageRowProps.destination}. A plain span, no control. */}
        {destination ? <span className="trash-to">{`\u2190 ${destination}`}</span> : null}
        {keep.length || tail.length ? (
          <span className="badges">
            {keep}
            {tail.length ? <span className="bdg-tail">{tail}</span> : null}
          </span>
        ) : null}
        {amount ? <span className="amt num">{amount}</span> : null}
      </span>
      {preview ? <span className="prev" style={{ display: "block" }}>{preview}</span> : null}
      {chips.length ? <span className="sr-chips">{chips}</span> : null}
    </>
  );

  /**
   * ONE PRESS HANDLER, TWO MEANINGS — decided by where the press landed.
   *
   * See {@link MessageRowProps.onToggleTime} for why the stamp cannot be a control of its own.
   * The hit test is the marker the stamp above only wears when a flip is wired, so a row with no
   * flip behind it takes this branch never and behaves exactly as it always has.
   */
  const press = (e: MouseEvent<HTMLButtonElement>): void => {
    if (onToggleTime && (e.target as Element | null)?.closest?.("[data-stamp]")) {
      onToggleTime();
      return;
    }
    onClick?.();
  };

  const rowButton = (
    <button
      type="button"
      className={cls}
      data-id={id}
      data-ids={memberIds && memberIds.length > 0 ? memberIds.join(" ") : undefined}
      data-unseen={unread ? "1" : undefined}
      aria-label={`${from}: ${subject}`}
      {...selection}
      onClick={press}
    >
      {lead !== null ? (
        <>
          {lead}
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
