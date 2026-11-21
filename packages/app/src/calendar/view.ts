/**
 * WHAT THE CALENDAR'S BODY HANDS A VIEW. One mounted body draws the head, the view of the place, the panel and the
 * open event; a view draws its span of days from what it is handed and keeps no list of its own. It asks the
 * body for the span it shows, so the body expands the repeats over that span and no other.
 */
import type { ComponentType, KeyboardEvent, PointerEvent, ReactNode } from "react";
import type { GridEvent, HeldEdge, PlainDate, ZoneSource } from "@ohmail/app-logic/calendar";
import type { EventRef, LayoutPlan } from "../frame/contract.js";

export type { EventRef };

/** An event as a view shows it: its face for the chip, and the reference that opens it. `id` is unique in a list. */
export interface CalendarEventView extends GridEvent {
  readonly ref: EventRef;
  readonly timeEditable?: boolean;
}

/** The settings a view draws by; until the account's settings answer: no week numbers, no second zone, and 06:00–22:00. */
export interface CalendarViewSettings {
  readonly newEventsCalendarId?: string | null;
  /** The week's first day, Monday 0 to Sunday 6. */
  readonly weekStart: number;
  readonly weekNumbers: boolean;
  readonly secondZone: string | null;
  /** The hours in view when the calendar opens, in minutes of the day. */
  readonly hours: { readonly from: number; readonly to: number };
}

export type DayEdge = "start" | "end";
export type TimedSegment = { from: number; to: number };
export type CalendarEventDrag = (
  id: string,
  event: PointerEvent<HTMLButtonElement>,
  segment?: TimedSegment,
) => void;

export interface CalendarViewProps {
  /** The day the view stands on: the address's anchor, or today. */
  readonly anchor: PlainDate;
  /** The occurrences in the span the view asked for, of the calendars that are shown. */
  readonly events: readonly CalendarEventView[];
  /** The expansion stopped at a ceiling: there may be more than it returned. */
  readonly capped: boolean;
  /** The edges of what this device holds: days beyond them are said, never drawn as empty. */
  readonly edge: HeldEdge;
  /** The id (`CalendarEventView.id`) of the event open now. */
  readonly openId: string | null;
  readonly revealOpen?: boolean;
  /** The reader's zone, the zone rules, and now. */
  readonly clock: { readonly zone: string; readonly zones: ZoneSource; readonly nowMs: number };
  readonly settings: CalendarViewSettings;
  readonly plan: LayoutPlan;
  /** A panel (the Agenda, the Invitations) stands beside the view. */
  readonly panel: boolean;
  readonly cursor?: number | null;
  /** The phone's time scroller picks the adjacent civil day. */
  readonly stepDay?: (direction: -1 | 1) => void;
  /** Opens an event: the frame's named command. */
  readonly onDrag?: CalendarEventDrag;
  readonly onResizeTime?: (id: string, edge: DayEdge, minutes: number, anchor: HTMLElement) => void;
  readonly onSlot?: (day: string, event: PointerEvent<HTMLDivElement>) => void;
  readonly dragPreview?: { day: string; chip: ReactNode };
  readonly onOpen: (ref: EventRef) => void;
  /** Goes to a day, in the Day view. */
  readonly onDay: (day: PlainDate) => void;
}

/** A view and the span of days it shows for an anchor. */
export interface CalendarView {
  readonly View: ComponentType<CalendarViewProps>;
  readonly span: (
    anchor: PlainDate,
    settings: CalendarViewSettings,
    plan: LayoutPlan,
  ) => readonly PlainDate[];
}

export function timedResizeProps(
  props: CalendarViewProps,
  block: TimedSegment & { before: boolean; after: boolean; item: CalendarEventView },
  labels: { start: string; end: string },
) {
  const id = block.item.id;
  const enabled =
    props.onResizeTime &&
    block.item.timeEditable &&
    (props.openId === null || props.openId === id || block.item.state === "draft");
  const start = enabled && !block.before;
  const end = enabled && !block.after;
  return {
    handles: false,
    timeEdges:
      start || end
        ? { start: start ? labels.start : undefined, end: end ? labels.end : undefined }
        : undefined,
    onPointerDown: props.onDrag
      ? (event: PointerEvent<HTMLButtonElement>) => props.onDrag?.(id, event, block)
      : undefined,
    onResizeKey:
      start || end
        ? (event: KeyboardEvent<HTMLButtonElement>) => {
            if (!event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            if (event.shiftKey ? !start : !end) return;
            event.preventDefault();
            event.stopPropagation();
            props.onResizeTime?.(
              id,
              event.shiftKey ? "start" : "end",
              event.key === "ArrowUp" ? -15 : 15,
              event.currentTarget,
            );
          }
        : undefined,
  };
}
