/**
 * THE CALENDAR'S DOOR INTO THE MAIL FEED, as a type and nothing else.
 *
 * The feed's reader (`sync-service.ts`) is in the phone's own engine, which may never hold the
 * calendar's code or name one of its tables. So the reader names no builder: a composition that
 * keeps a calendar hands this port in (`@trafficflow/services/calendar`), and a composition that
 * does not hands nothing, which the reader answers by sending no calendar record at all, never
 * by turning one into a deletion.
 */
import type { CalendarRecordKind, CalendarRecords, CalendarWindow } from "@ohmail/wire";
import type { Db } from "./context.js";

/** A span of time as epoch milliseconds, `fromMs` before `toMs`. */
export interface CalendarSpanMs {
  readonly fromMs: number;
  readonly toMs: number;
}

/** Where a first load's event walk resumes: the last event served, by `(starts_at, id)`. */
export interface CalendarKeyset {
  readonly startsAtMs: number;
  readonly id: string;
}

/** One record a first load serves, with the key the walk resumes after when it is an event. */
export interface CalendarSnapshotRecord {
  readonly kind: CalendarRecordKind;
  readonly id: string;
  readonly entity: CalendarRecords[CalendarRecordKind];
  readonly updatedAt: string;
  readonly keyset?: CalendarKeyset;
}

/** What one page of a first load reads; the reader charges it to the page and cuts the events. */
export interface CalendarSnapshotSlice {
  /** The span the walk serves: the one asked for, or the window narrowed to its row ceiling. */
  readonly span: CalendarSpanMs;
  /** On the first page only: the connections, the calendars and the newest open suggestions. */
  readonly lead: readonly CalendarSnapshotRecord[];
  /** The span's events after the keyset, in `(starts_at, id)` order, at most `limit` of them. */
  readonly events: readonly CalendarSnapshotRecord[];
  /** The read took `limit` rows, so more may follow. */
  readonly full: boolean;
  /** The last row the read reached, kept when it was gone by the time it was built. */
  readonly readTo: CalendarKeyset | null;
}

export interface CalendarSnapshotQuery {
  readonly now: Date;
  /** The window served (the port's own): its days around `now` and its row ceiling. */
  readonly window: CalendarWindow;
  /** A span named by the request, or `null` for the served window around `now`. */
  readonly span: CalendarSpanMs | null;
  /** `null` on the first page, which leads with the connections, calendars and suggestions. */
  readonly after: CalendarKeyset | null;
  readonly limit: number;
}

export interface CalendarFeedPort {
  /**
   * When the account switched its calendar on, `null` while it is off. One keyed read, asked only
   * by a page that holds a calendar change.
   */
  enabledAt(db: Db, accountId: string): Promise<Date | null>;
  /**
   * The records of `kind` named by `ids`, as they stand now and scoped to the account. An id the
   * answer leaves out is gone, and the reader sends its deletion.
   */
  build<K extends CalendarRecordKind>(
    db: Db, accountId: string, kind: K, ids: readonly string[],
  ): Promise<ReadonlyMap<string, CalendarRecords[K]>>;
  /** The span of days a first load serves and a device keeps (`CalendarWindow`). */
  readonly window: CalendarWindow;
  /** One page of the first load's calendar phase, built by the same builders as the feed. */
  snapshotPage(db: Db, accountId: string, q: CalendarSnapshotQuery): Promise<CalendarSnapshotSlice>;
}
