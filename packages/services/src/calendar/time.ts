/**
 * The stored form of a time, kept in the calendar core (`packages/cal-core/src/stored/time.ts`) so
 * that every writer reaches it without the services. Said here again for the services' own callers,
 * through the core's index, with the proof that the core's triple is the wire's `CalendarTime`,
 * which the core cannot import.
 */
import type { EventTime, StoredTime } from "@ohmail/cal-core";
import type { Assert, CalendarTime, Same } from "@ohmail/wire";

export { DAY_MS, eventTimeOf, isExactMoment, momentOrUtc, storedTimeOf } from "@ohmail/cal-core";

/** The wire declares its own kind words, since it imports nothing; they are the core's, exactly. */
type _SameKinds = Assert<Same<CalendarTime["kind"], EventTime["kind"]>>;
/** And the triple is one shape on both sides. */
type _SameTriple = Assert<Same<CalendarTime, StoredTime>>;
