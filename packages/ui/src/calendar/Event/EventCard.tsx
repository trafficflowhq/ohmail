import {
  Fragment,
  useCallback,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEventHandler,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Button } from "../../base/Primitives/Button.js";
import { cssPoint } from "../../base/ui-zoom.js";
import { Icon } from "../../icons/Icon.js";
import { CalendarSquare } from "../Grids/CalendarSquare.js";
import { cx, toneOf, toneStyle, type CalendarTone } from "../tone.js";
import "./event-card.css";

interface Way {
  label: string;
  onPress?: MouseEventHandler<HTMLButtonElement>;
}

export interface EventCardRow {
  label: string;
  /** A calendar's square before the value. */
  tone?: CalendarTone;
  /** The value as a word, cut with an ellipsis where the row ends. */
  text?: string;
  /** A name that leads somewhere: who it is from, the letter it came in. */
  link?: Way;
  /** The words of the letter an event was found in, each marked. */
  words?: readonly string[];
  /** A file or a link the event carries: the clip or the arrow, its name, its size. */
  file?: { name: string; size?: string; link?: boolean };
  /** A call: Join, the address under it, and the control that copies the address. */
  call?: { join: Way; address: string; copy: Way };
  /** Anything else the row holds: faces, a slot, a lock. */
  children?: ReactNode;
  /** The quiet second thing: how the invitees answered, "Sent". */
  note?: string;
}

export interface EventCardProps {
  title: string;
  titleInput?: { label: string; value: string; onChange: (value: string) => void; readOnly: boolean };
  editor?: ReactNode;
  /** Whose it is: the head stands on that colour, a step deeper. `null` while it is on no calendar. */
  tone: CalendarTone;
  /** The time in full, and the time it replaced, struck before it. */
  when?: string;
  was?: string;
  /** The time on the spot, the place; a place may lead to a map. */
  where?: readonly { text: string; maps?: Way }[];
  /** What it overlaps, what changed: a tag each. A hot one waits for you. */
  tags?: readonly { text: string; hot?: boolean; tone?: CalendarTone }[];
  /** A sync waiting or failure, shown before the event details. */
  status?: { text: string; failed: boolean };
  /** An event of your own: Edit. In a sheet from the foot the verbs at the foot carry it. */
  edit?: Way;
  /** Nothing to edit: the same place says why. */
  why?: { text: string; locked?: boolean };
  close: Way;
  /** On an invitation: the answers, at the end of the head. */
  answers?: ReactNode;
  /** The rows: calendar, invitees, alert, the call, the letter it came in. */
  rows?: readonly EventCardRow[];
  notes?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  keyShortcuts?: string;
  /** In a sheet from the foot: the event's verbs, which stay at its foot. */
  foot?: ReactNode;
  /** `card` stands beside its event; `inline` is set into a list under the row that is its head; `sheet` comes up from the foot. */
  frame?: "card" | "inline" | "sheet";
  /** Which side of its event it stands on, as the app placed it. */
  side?: "r" | "l" | "b" | "t" | "o";
  /** Where the app placed it, and how wide where it had to narrow it to fit. */
  style?: Pick<CSSProperties, "left" | "top" | "width">;
  /** Where it grows from as it arrives, from its own corner: the middle of the bridge to its event. */
  origin?: { x: number; y: number };
  /** It stood already: it does not arrive again. */
  still?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** How far a sheet is pulled down before it closes; under that it springs back. */
const PULL_TO_CLOSE = 80;

/**
 * The open event, read: its head on the event's own colour (title, time, place, what it overlaps,
 * the answers), then its rows. It closes by its close and by Esc; a sheet also by a pull down on its grabber.
 * Where a card stands is the app's to say; the card says which side it was put on.
 */
export function EventCard(p: EventCardProps) {
  const own = toneOf(p.tone);
  const frame = p.frame ?? "card";
  const esc = (event: KeyboardEvent<HTMLDivElement>) => {
    p.onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape") return;
    event.stopPropagation();
    p.close.onPress?.(event as never);
  };
  const pulls = useSheetPull(frame === "sheet", p.close);
  const focusTitle = useCallback((input: HTMLInputElement | null) => {
    if (!input || input.ownerDocument.documentElement.dataset.touch === "1") return;
    input.focus({ preventScroll: true });
    input.select();
  }, []);
  const why = p.why ? (
    <span className="oh-tag oh-ecard-tag oh-ecard-why">
      {p.why.locked ? <Icon name="lock" size={16} className="oh-ecard-why-ico" /> : null}
      {p.why.text}
    </span>
  ) : null;
  return (
    <div
      ref={p.ref}
      className={cx("oh-ecard", own.className)}
      data-tone={own["data-tone"]}
      data-frame={frame === "card" ? undefined : frame}
      data-editing={p.titleInput ? "" : undefined}
      data-side={p.side}
      data-still={p.still ? "" : undefined}
      style={{
        ...toneStyle(p.tone),
        ...p.style,
        ...(p.origin ? { transformOrigin: `${p.origin.x}px ${p.origin.y}px` } : null),
      }}
      role="dialog"
      aria-label={p.title}
      aria-keyshortcuts={p.keyShortcuts}
      onKeyDown={esc}
      {...pulls}
    >
      {frame === "sheet" ? <i className="oh-ecard-grab" aria-hidden /> : null}
      <div
        className="oh-ecard-head"
        data-act={frame !== "card" ? undefined : p.edit ? "edit" : p.why ? "why" : undefined}
      >
        <span className="oh-ecard-close">
          <Button kind="quiet" size="s" icon="x" label={p.close.label} onPress={p.close.onPress} />
        </span>
        {frame !== "card" ? null : p.edit ? (
          <button
            type="button"
            className="oh-control oh-button oh-ecard-edit"
            data-kind="two"
            data-size="s"
            onClick={p.edit.onPress}
          >
            <Icon name="write" size={16} className="oh-ecard-edit-ico" />
            <span>{p.edit.label}</span>
          </button>
        ) : (
          why
        )}
        {p.titleInput ? (
          <input
            ref={focusTitle}
            className="oh-control oh-display oh-ecard-title oh-ecard-title-input"
            aria-label={p.titleInput.label}
            readOnly={p.titleInput.readOnly}
            value={p.titleInput.value}
            onChange={(e) => p.titleInput?.onChange(e.currentTarget.value)}
          />
        ) : (
          <h3 className="oh-text oh-display oh-ecard-title">{p.title}</h3>
        )}
        {p.when !== undefined && (
          <p className="oh-text oh-ecard-when">
            {p.was ? <s className="oh-ecard-was">{p.was}</s> : null}
            {p.when}
          </p>
        )}
        {p.where?.map((w, i) => (
          <p key={i} className="oh-text oh-ecard-where">
            {w.text}
            {w.maps ? (
              <button type="button" className="oh-control oh-ecard-link" onClick={w.maps.onPress}>
                {w.maps.label}
              </button>
            ) : null}
          </p>
        ))}
        {p.tags?.length || (frame === "sheet" && why) ? (
          <div className="oh-ecard-tags">
            {p.tags?.map((t, i) => (
              <span key={i} className="oh-tag oh-ecard-tag" data-hot={t.hot ? "" : undefined}>
                {t.tone === undefined ? null : <CalendarSquare tone={t.tone} />}
                {t.text}
              </span>
            ))}
            {frame === "sheet" ? why : null}
          </div>
        ) : null}
        {p.answers}
      </div>
      {p.editor}
      <CardRows status={p.status} rows={p.rows} />
      {p.notes ? <p className="oh-text oh-ecard-notes">{p.notes}</p> : null}
      {frame === "sheet" && p.foot ? <div className="oh-ecard-foot">{p.foot}</div> : null}
    </div>
  );
}

function CardRows({ status, rows }: Pick<EventCardProps, "status" | "rows">) {
  if (!status && !rows?.length) return null;
  return (
    <dl className="oh-ecard-rows">
      {status ? (
        <div className="oh-ecard-row">
          <dt className="oh-ecard-term" />
          <dd className="oh-ecard-value">
            <span className="oh-ecard-status" data-failed={status.failed ? "" : undefined}>
              <Icon name={status.failed ? "warn" : "clock"} size={16} />
              {status.text}
            </span>
          </dd>
        </div>
      ) : null}
      {rows?.map((row) => (
        <CardRow key={row.label} row={row} />
      ))}
    </dl>
  );
}

/**
 * The sheet follows a finger or the mouse down from its grabber, and only from there: the rest of the sheet is
 * the browser's to scroll. A pull from anywhere while its content is at its top needs touch listeners that keep
 * the pan, and waits for the calendar's views, which bring the sheet's content and its scroll.
 */
function useSheetPull(on: boolean, close: Way) {
  const pull = useRef<{ from: number; by: number } | null>(null);
  if (!on) return {};
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (!(event.target as Element).closest?.(".oh-ecard-grab")) return;
      /* The pull is heard to its end wherever the pointer goes: a mouse that leaves the sheet and lets go there has let go. */
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pull.current = { from: cssPoint(event).y, by: 0 };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!pull.current) return;
      pull.current.by = Math.max(0, cssPoint(event).y - pull.current.from);
      event.currentTarget.style.translate = `0 ${pull.current.by}px`;
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      const was = pull.current;
      pull.current = null;
      event.currentTarget.style.translate = "";
      if (was && was.by >= PULL_TO_CLOSE) close.onPress?.(event as never);
    },
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
      pull.current = null;
      event.currentTarget.style.translate = "";
    },
  };
}

/** One row of the card: its term, and its value with what the value carries. */
function CardRow({ row: r }: { row: EventCardRow }) {
  return (
    <div className="oh-ecard-row">
      <dt className="oh-ecard-term">{r.label}</dt>
      <dd className="oh-ecard-value" data-stacked={r.call ? "" : undefined}>
        {r.tone === undefined ? null : <CalendarSquare tone={r.tone} />}
        {r.text ? <span className="oh-ecard-text">{r.text}</span> : null}
        {r.link ? (
          <button type="button" className="oh-control oh-ecard-link" onClick={r.link.onPress}>
            {r.link.label}
          </button>
        ) : null}
        {r.words ? (
          <span className="oh-ecard-words">
            {r.words.map((w, i) => (
              <Fragment key={i}>
                {i ? " " : null}
                <mark className="oh-ecard-mark">{w}</mark>
              </Fragment>
            ))}
          </span>
        ) : null}
        {r.file ? (
          <span className="oh-ecard-file">
            <Icon name={r.file.link ? "go" : "clip"} size={16} className="oh-ecard-file-ico" />
            {r.file.name}
            {r.file.size ? <small className="oh-ecard-file-size">{r.file.size}</small> : null}
          </span>
        ) : null}
        {r.call ? (
          <>
            <button
              type="button"
              className="oh-control oh-button oh-ecard-join"
              data-kind="two"
              data-size="s"
              onClick={r.call.join.onPress}
            >
              <Icon name="video" size={16} className="oh-ecard-join-ico" />
              <span>{r.call.join.label}</span>
            </button>
            <span className="oh-ecard-address">
              <span className="oh-ecard-note oh-ecard-address-text">{r.call.address}</span>
              <Button
                kind="quiet"
                size="s"
                icon="copy"
                label={r.call.copy.label}
                onPress={r.call.copy.onPress}
              />
            </span>
          </>
        ) : null}
        {r.children}
        {r.note ? <span className="oh-ecard-note">{r.note}</span> : null}
      </dd>
    </div>
  );
}
