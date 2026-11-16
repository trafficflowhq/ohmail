/**
 * A row's range, worked out in the calendar core (`packages/cal-core/src/stored/event-range.ts`) so
 * that the calendar's sync derives it with the same function as the services. Said here again for
 * the services' own callers, through the core's index as every other import of the core here.
 */
export {
  CALENDAR_RANGE_SLACK_MS, derivedRange, type EventRange, type EventRangeInput,
} from "@ohmail/cal-core";
