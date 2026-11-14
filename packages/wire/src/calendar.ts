/**
 * THE CALENDAR'S ONE HOME ON THE WIRE. Empty of members until the calendar's own changes add them:
 * a record kind here, its record in {@link CalendarRecords}, an act in {@link CalendarAct}, a reason
 * word in {@link CalendarReason}. `never` joins a union without changing it, so the mail feed reads
 * exactly as it did while this stays empty.
 */

/** The kinds of calendar record the sync feed carries. None yet. */
export type CalendarRecordKind = never;

/**
 * Each calendar record kind and the record that travels under it. A kind is added here together
 * with its member of {@link CalendarRecordKind}, its builder for the feed and the list a request
 * may name.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CalendarRecords {}

/** What a person can do to the calendar from a client, as the queue carries it. None yet. */
export type CalendarAct = never;

/** The words a refused calendar act is answered with. None yet. */
export type CalendarReason = never;
