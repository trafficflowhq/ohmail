/**
 * What the range views (Month, Year, Agenda, Search) are handed: the events on screen as the calendar's
 * body derived them from the mirror on this version, the day they stand on, and the few acts a view may
 * ask for. A view keeps none of it.
 */
import type { ZoneSource } from "@ohmail/cal-core";
import type { DayId, Placed } from "./days.js";

/** An event, or one day of a series, as the route and the frame's `event` command name it. */
export interface ViewEventRef {
  readonly event: string;
  readonly occurrence: string | null;
  readonly day: DayId;
}

/**
 * An occurrence as a view draws it: the time grid's event (its face and its reference), and the words Search finds
 * it by beside its title and place.
 */
export interface ViewEvent extends Placed {
  /** One occurrence, unique on screen. */
  readonly id: string;
  readonly ref: ViewEventRef;
  readonly title: string;
  /** The calendar's hue on the ring, `"neutral"` for one without, null while on no calendar. */
  readonly tone: number | "neutral" | null;
  /** How its line is drawn. */
  readonly state: "plain" | "to-answer" | "from-mail" | "draft" | "maybe" | "off";
  readonly repeats: "series" | "apart" | null;
  /** A calendar that cannot be changed here. */
  readonly viewOnly: boolean;
  /** It waits for the person: an invitation to answer, a change to see. */
  readonly waits: boolean;
  /** What the queue says of it: waiting, not saved. */
  readonly status: { readonly text: string; readonly failed: boolean } | null;
  /** The second line: the place. */
  readonly second: string | null;
  /** The organizer and the invitees, as named. */
  readonly people: readonly string[];
  readonly notes: string | null;
}

export type RangeDevice = "desktop" | "fold" | "phone";

/** Where the view stands. */
export interface RangeInput {
  readonly events: readonly ViewEvent[];
  /** The picked day: the route's anchor, today where it names none. */
  readonly anchor: DayId;
  readonly today: DayId;
  /** Now, in minutes after midnight on the reader's clock. */
  readonly nowMinute: number;
  /** The reader's zone. */
  readonly zone: string;
  /** The zone rules every view places by: the same source the Week and the Day are handed. */
  readonly zones: ZoneSource;
  /** Monday 0 to Sunday 6. */
  readonly weekStart: number;
  readonly weekNumbers: boolean;
  /** The open event's id. */
  readonly open: string | null;
  readonly device: RangeDevice;
}

/** What a view may ask: every one is a route change or the frame's named command. */
export interface RangeActs {
  /** Open an event, or close it (the frame's `event` command). */
  readonly event: (e: ViewEvent | null) => void;
  /** Pick a day in the view on screen. */
  readonly pick: (day: DayId) => void;
  /** Another view, on a day. */
  readonly view: (view: "day" | "week" | "month", day: DayId) => void;
  /** Take the person to an event where it stands: its day in the view they came from, the event open there. */
  readonly reveal: (e: ViewEvent) => void;
}

/** The edges of what this device holds: earlier and later than them nothing is drawn. */
export interface HeldEdge {
  /** The first day held, where days before it exist at the provider; null when nothing lies before. */
  readonly earlier: DayId | null;
  /** The last day held, where days after it exist at the provider; null when nothing lies after. */
  readonly later: DayId | null;
  /** Reads a span before the edge; `"none"` where this host cannot ask for one. */
  readonly load: ((span: { readonly from: DayId; readonly to: DayId }) => Promise<boolean>) | "none";
}
