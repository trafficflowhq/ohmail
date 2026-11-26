import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";
import type {
  CSSProperties,
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  ReactNode,
  Ref,
} from "react";
import { Icon } from "../../icons/Icon.js";
import { cx, toneOf, toneStyle, type CalendarTone } from "../tone.js";
import { useEventTitle } from "../use-event-title.js";
import { CalendarSquare } from "./CalendarSquare.js";
import { blockLayout, type BlockPlace } from "./chip-layout.js";
import "./event-chip.css";

/**
 * What an event's line says. Plain stands on its calendar's tint. To answer is outlined. From mail
 * is dashed and has no colour yet; a draft and a proposed time are dashed in their calendar's
 * colour. Maybe is a lighter drawing. Off is struck: cancelled, or declined and still shown.
 */
export type EventChipState = "plain" | "to-answer" | "from-mail" | "draft" | "maybe" | "off";

interface EventChipCommon {
  recordId?: string;
  saving?: boolean;
  title: string;
  /** Whose it is; `null` while it is on no calendar. */
  tone: CalendarTone;
  state?: EventChipState;
  /** The one you have open: its own colour a step deeper, a line of it all round. */
  open?: boolean;
  /** It waits for you: the dot at the line's end. */
  waits?: boolean;
  /** The series' sign after the title; `"apart"` is one event changed for itself. */
  repeats?: "series" | "apart";
  /** View only: a lock, and no handles. */
  viewOnly?: boolean;
  /** Just set: its dashes close and its square drops in. */
  fresh?: boolean;
  /** The accessible name, where the words drawn do not say enough. */
  label?: string;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: import("react").KeyboardEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  dayEdges?: { start?: string; end?: string };
  drag?: "lifted" | "copy";
  ref?: Ref<HTMLButtonElement>;
}

export interface EventBlockProps extends EventChipCommon {
  /** A block of a time grid. */
  size: "block";
  place: BlockPlace;
  /** The second line: the place, or the time on the spot. */
  second?: string;
  /** The value a change replaced, struck before the second line. */
  was?: string;
  /** What the store says of it, in the second line's place: waiting to be sent, not saved. */
  status?: { text: string; failed?: boolean };
  /** A narrow day: titles at the small size. */
  dense?: boolean;
  /** Under 60 px wide: the title on one line with its ellipsis. */
  tiny?: boolean;
  /** The line of now crosses it: the words stand over the line. */
  nowCrosses?: boolean;
  /** An event of your own: its top and bottom edges lengthen it. */
  handles?: boolean;
  timeEdges?: { start?: string; end?: string };
  onResizeKey?: KeyboardEventHandler<HTMLButtonElement>;
  /** The shortest a block is drawn here, in px. */
  shortest?: number;
}

export interface EventPillProps extends EventChipCommon {
  /** A pill of the all-day lane: a whole day, or a run across days. */
  size: "pill";
  /** Where it stands on the lane's own grid, and how wide a lone one is. */
  style?: Pick<CSSProperties, "gridColumn" | "gridRow" | "width">;
}

export interface EventLineProps extends EventChipCommon {
  /** A line of a month: square, time, title, and no fill. */
  size: "line";
  /** The start, in the hour's own writing. A run has none. */
  time?: string;
  /** A run across days: the only fill in a month. */
  run?: boolean;
  style?: Pick<CSSProperties, "gridColumn" | "gridRow">;
}

export type EventChipProps = EventBlockProps | EventPillProps | EventLineProps;

/* An icon in a chip is 14 where the set's smallest is 16: the stylesheet sizes it. */
const LOCK = <Icon name="lock" size={16} className="oh-ev-ico" />;

function lead(p: EventChipProps): ReactNode {
  if (p.state === "from-mail") return <Icon name="frommail" size={16} className="oh-ev-ico" />;
  return p.tone === null ? null : <CalendarSquare />;
}

function tail(p: EventChipProps): ReactNode {
  return (
    <>
      {p.repeats && p.size !== "line" ? (
        <span className="oh-ev-sign" data-apart={p.repeats === "apart" ? "" : undefined} aria-hidden>
          <Icon name="repeat" size={16} className="oh-ev-ico" />
        </span>
      ) : null}
      {p.viewOnly ? LOCK : null}
      {p.waits ? <span className="oh-cal-wait" aria-hidden /> : null}
    </>
  );
}

function shared(p: EventChipProps, style: CSSProperties | undefined) {
  const tone = toneOf(p.tone);
  return {
    type: "button" as const,
    ref: p.ref,
    className: cx("oh-ev", tone.className),
    "data-tone": tone["data-tone"],
    "data-size": p.size,
    "data-state": p.state && p.state !== "plain" ? p.state : undefined,
    "data-open": p.open ? "" : undefined,
    "data-fresh": p.fresh ? "" : undefined,
    "data-drag": p.drag,
    "data-record": p.recordId,
    "aria-busy": p.saving || undefined,
    "aria-hidden": p.drag === "copy" || undefined,
    tabIndex: p.drag === "copy" ? -1 : undefined,
    "aria-label": p.label,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": p.open ?? false,
    style: { ...toneStyle(p.tone), ...style },
    onClick: p.onPress,
    onContextMenu: p.onContextMenu,
    onKeyDown: p.onKeyDown,
    onPointerDown: p.onPointerDown,
  };
}

function ChipTitle({ title, lines, state }: { title: string; lines: number; state?: EventChipState }) {
  const { ref, wording } = useEventTitle(title, lines, state);
  const shortened = wording.replace(/\s+/gu, " ") !== title.replace(/\s+/gu, " ");
  return (
    <>
      <span ref={ref} className="oh-ev-tt" aria-hidden={shortened || undefined}>
        {wording}
      </span>
      {shortened ? <span className="oh-ev-spoken">{title}</span> : null}
    </>
  );
}

function Block(p: EventBlockProps) {
  const hasSecond = !p.tiny && Boolean(p.second || p.was || p.status);
  const layout = blockLayout(p.place, { dense: p.dense, shortest: p.shortest, hasSecond });
  const handles = p.handles && !p.viewOnly;
  const chip = (
    <button
      {...shared(p, layout.style)}
      data-small={layout.small ? "" : undefined}
      data-one={layout.one ? "" : undefined}
      data-tight={layout.tight ? "" : undefined}
      data-tiny={p.tiny ? "" : undefined}
      data-overlap={(p.place.columns ?? 1) > 1 && !p.place.lap ? "" : undefined}
      data-lap={p.place.lap ? "" : undefined}
      data-now={p.nowCrosses ? "" : undefined}
      data-fixed={handles || p.timeEdges ? undefined : ""}
      aria-keyshortcuts={
        p.onResizeKey
          ? [
              p.timeEdges?.start && "Alt+Shift+ArrowUp Alt+Shift+ArrowDown",
              p.timeEdges?.end && "Alt+ArrowUp Alt+ArrowDown",
            ]
              .filter(Boolean)
              .join(" ")
          : undefined
      }
      onKeyDown={(event) => {
        p.onKeyDown?.(event);
        if (!event.defaultPrevented) p.onResizeKey?.(event);
      }}
      data-failed={p.status?.failed ? "" : undefined}
    >
      <span className="oh-ev-t">
        {lead(p)}
        <ChipTitle
          title={p.title}
          state={p.state}
          lines={Math.max(1, layout.lines - Number(layout.second))}
        />
        {tail(p)}
      </span>
      {layout.second ? (
        <span className="oh-ev-p">
          {p.status ? <span className="oh-ev-st">{p.status.text}</span> : null}
          {!p.status && p.was ? <s className="oh-ev-was">{p.was}</s> : null}
          {!p.status && p.was && p.second ? " " : null}
          {p.status ? null : p.second}
        </span>
      ) : null}
      {!p.viewOnly && (p.timeEdges?.start || (handles && layout.height >= 28)) ? (
        <span
          className="oh-ev-hd"
          data-edge="start"
          data-cal-resize="start"
          title={p.timeEdges?.start}
          aria-hidden
        />
      ) : null}
      {!p.viewOnly && (p.timeEdges?.end || handles) ? (
        <span
          className="oh-ev-hd"
          data-edge="end"
          data-cal-resize="end"
          title={p.timeEdges?.end}
          aria-hidden
        />
      ) : null}
    </button>
  );
  if (p.viewOnly || p.drag === "copy" || !p.timeEdges) return chip;
  return (
    <>
      {chip}
      <div className="oh-ev-edges" style={layout.style}>
        {(["start", "end"] as const).map((edge) => {
          const label = p.timeEdges?.[edge];
          return label && <ResizeEdge key={edge} edge={edge} label={label} onResizeKey={p.onResizeKey} />;
        })}
      </div>
    </>
  );
}

function ResizeEdge({
  edge,
  label,
  onResizeKey,
}: {
  edge: "start" | "end";
  label: string;
  onResizeKey?: EventBlockProps["onResizeKey"];
}) {
  return (
    <button
      type="button"
      className="oh-control oh-ev-hd"
      data-edge={edge}
      aria-label={label}
      aria-keyshortcuts="ArrowUp ArrowDown"
      onKeyDown={(event) => {
        if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        // Use the same resize action and cancellation as the shortcut on the event button.
        onResizeKey?.({
          ...event,
          altKey: true,
          shiftKey: edge === "start",
          preventDefault: () => event.preventDefault(),
          stopPropagation: () => event.stopPropagation(),
        });
      }}
    />
  );
}

/** One arrival for the editor's draft, across every position and size in the grid. */
export const DraftChipArrival = createContext<{ played: boolean } | null>(null);

function ArrivingDraft(props: EventChipProps) {
  const { ref } = props;
  const arrival = useContext(DraftChipArrival);
  const chip = useRef<HTMLButtonElement | null>(null);
  const attach = useCallback(
    (node: HTMLButtonElement | null) => {
      chip.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );
  useLayoutEffect(() => {
    const button = chip.current;
    if (!button || !arrival) return;
    if (!arrival.played) {
      arrival.played = true;
      button.dataset.born = "";
    }
    if (!button.hasAttribute("data-born")) return;
    const finish = () => delete button.dataset.born;
    button.addEventListener("animationend", finish, { once: true });
    return () => button.removeEventListener("animationend", finish);
  }, [arrival]);
  return <Chip {...props} ref={attach} />;
}

/**
 * One event: its calendar's square and its title. It is one component in three sizes: a block of a
 * time grid, a pill of the all-day lane, a line of a month. One set of states for all three.
 */
export function EventChip(p: EventChipProps) {
  return p.state === "draft" && p.drag !== "copy" ? <ArrivingDraft {...p} /> : <Chip {...p} />;
}

function Chip(p: EventChipProps) {
  if (p.size === "block") return <Block {...p} />;
  if (p.size === "pill") {
    return (
      <button {...shared(p, p.style)}>
        {lead(p)}
        <ChipTitle title={p.title} state={p.state} lines={1} />
        {tail(p)}
        {dayGrips(p)}
      </button>
    );
  }
  return (
    <button {...shared(p, p.style)} data-run={p.run ? "" : undefined}>
      {lead(p)}
      {p.run || p.time === undefined ? null : <time className="oh-ev-time">{p.time}</time>}
      <span className="oh-ev-tt">{p.title}</span>
      {tail(p)}
      {dayGrips(p)}
    </button>
  );
}

function dayGrips({ dayEdges }: EventChipCommon) {
  return dayEdges ? (
    <>
      {dayEdges.start && <span data-cal-resize="start" title={dayEdges.start} aria-hidden />}
      {dayEdges.end && <span data-cal-resize="end" title={dayEdges.end} aria-hidden />}
    </>
  ) : null;
}
