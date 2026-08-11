import type { MouseEvent, ReactNode } from "react";
import { Avatar } from "../primitives/Avatar.js";
import { Badge, Chip, type TagHueName } from "../primitives/Chip.js";
import "./row.css";

export interface MessageRowTag {
  name: string;
  hue: TagHueName;
}

/**
 * How many faces a thread row's lead may show.
 *
 * A hard visual cap, not a restatement of the selector's: `row.css` holds the stack to the
 * width of ONE avatar whatever the count, and it does that by shrinking the circles as the
 * count rises (30 → two at 22px → three at 20px). A fourth would be a sliver of a face, and
 * a slot that grew instead would push a thread row's text out of line with the singleton rows
 * above and below it. Whatever the caller hands over, three is what is drawn; the rest of the
 * conversation is already spoken for by the `⤷ N` count beside the subject.
 */
export const THREAD_CIRCLES_MAX = 3;

export interface MessageRowProps {
  /** Stable id, stamped as data-id (and used by useSeenOnScroll). */
  id: string;
  from: string;
  address?: string;
  time?: string;
  /**
   * THE SAME INSTANT SAID THE OTHER WAY — the stamp's hover title.
   *
   * A row stamp is relative because that is what a list is scanned by ("Sat", "09:12"), and the
   * one question it cannot answer is which Saturday. So the caller hands over the other form of
   * the same instant and it hangs on the stamp: hover a date, read the exact one. When the list
   * has been flipped to the absolute form ({@link onToggleTime}) this is the relative one, so the
   * title always names whichever form is NOT on screen.
   *
   * DATA, NOT A DEPENDENCY: it is independent of {@link onToggleTime}, so a surface with no flip
   * behind it still says the exact instant on hover. Absent ⇒ no title, exactly as before.
   */
  timeTitle?: string;
  /**
   * FLIP EVERY STAMP IN THE LIST between the relative and absolute forms — or ABSENT, where no
   * surface is holding that preference.
   *
   * The gesture is one press on any one date, and what it changes is the whole list at once: a
   * reader comparing dates wants them all in the same shape, not one hovered at a time. The state
   * is the app's (`AppShell` owns it, resets it on a view switch and shares it with the open
   * message), so all this component does is report the press.
   *
   * ── WHY THE STAMP IS NOT A CONTROL OF ITS OWN, WHICH IS THE OBVIOUS SHAPE ────────────────────
   *
   * The row IS a `<button>` and a button may not contain another one. This is not a validity
   * quibble: the HTML PARSER closes the row at the inner start tag, so `<button class="row">…
   * <button class="stamp">` parses to two SIBLING buttons (measured against jsdom's parser) —
   * the stamp escapes the row it is supposed to sit in, and since this page is server-rendered
   * that is the tree the browser has built before React hydrates anything. A `tabindex` on the
   * span is no better: that is interactive content too, and it breaks the "no interactive
   * descendants" contract `role="option"` rows depend on (see {@link picked}), while adding one
   * tab stop per row to every list in the product.
   *
   * So the press is HIT-TESTED instead — the same answer `AppShell`'s capture-phase handler
   * already gives for the sender circle and address (`sender-hit.ts`), for the same reason. The
   * stamp is marked `data-stamp` only when a flip is actually wired, and the row's own press
   * routes a click that landed on it here. The consequence, stated rather than hidden: on a list
   * row the flip is a POINTER gesture. The keyboard route to the same preference is the open
   * message's stamp, which is a real `<button>` because a message header is not one.
   *
   * ABSENT ⇒ a plain, inert span: no hit target, no pressable styling, and a press on the date
   * does what a press on the row has always done. Never a control that answers nothing.
   */
  onToggleTime?: () => void;
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
   * THREAD PARTICIPANTS — the people in this conversation, as the row's LEAD.
   *
   * A row about several people wears several faces: two or more entries here put an overlapping
   * stack of smaller circles where {@link avatarInitial}'s single circle would stand, newest
   * voice first. The caller chooses the people (the Ohbox uses the same voices its sender line
   * names) and this component only draws them — same {@link Avatar}, same address-keyed hue, so
   * a face is the same colour here as everywhere else in the app.
   *
   * THE STACK DOES NOT REPLACE THE `⤷ N` COUNT, and the two are not the same statement: the
   * circles say WHO is in the conversation, the count says HOW MANY messages are folded into
   * the row. They are wanted together precisely in the case the stack is capped
   * ({@link THREAD_CIRCLES_MAX}) — which is also why there is no "+N" circle here: the count
   * beside the subject is already the overflow, and a second number would be a second idiom.
   *
   * FEWER THAN TWO ⇒ NOTHING CHANGES. One participant is not a conversation of people, so the
   * row falls back to the ordinary single full-size circle and renders byte-for-byte as a row
   * with no participants at all. Every list that passes none is untouched.
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
    timeTitle,
    onToggleTime,
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
  if (threadCount) badges.push(<Badge key="thread">⤷ {threadCount}</Badge>);
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

  /**
   * THE ROW'S LEAD — a stack of the conversation's faces, or one sender's circle, or nothing.
   *
   * See {@link MessageRowProps.participants}: two or more people make the stack, and anything
   * less falls through to the single circle so a one-voice thread and a plain message render
   * identically. Both leads occupy the same box (`row.css` pins the stack to one avatar's
   * width), so the `.srow` flex layout — and every row's text column with it — is the same
   * whichever one is drawn. `aria-hidden` on the stack for the same reason each `Avatar`
   * carries it: the faces are decorative, and the row's `aria-label` already names the sender.
   */
  const stack = (participants ?? []).slice(0, THREAD_CIRCLES_MAX);
  const lead =
    stack.length > 1 ? (
      <span className="av-stack" aria-hidden="true">
        {stack.map((p, i) => (
          <Avatar key={`${p.initials}-${i}`} initials={p.initials} hue={p.hue} size="s" />
        ))}
      </span>
    ) : avatarInitial !== undefined ? (
      <Avatar initials={avatarInitial} hue={avatarHue} />
    ) : null;

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
  if (heldCount !== undefined && heldCount > 1)
    chips.push(<Badge key="held">{heldCount} held</Badge>);
  if (detection) chips.push(<Badge key="det">{detection}</Badge>);

  const body = (
    <>
      <span className="row-top">
        {unread ? <span className="dot-unread" /> : null}
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
