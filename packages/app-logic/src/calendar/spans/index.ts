/** The range views' shapes: month weeks, the year's months and runs, the agenda's days, search. Pure. */
export {
  addDays,
  boundariesOf,
  dayIdOf,
  dayNumberOf,
  daySpanOf,
  firstOfMonth,
  monthOfDay,
  readerZones,
  shiftMonth,
  weekStartOf,
  type DayId,
  type DaySpan,
  type MonthId,
  type Placed,
} from "./days.js";
export {
  monthWeeks,
  type MonthDay,
  type MonthGridData,
  type MonthPiece,
  type MonthQuery,
  type MonthWeek,
} from "./month.js";
export {
  yearMonths,
  type YearData,
  type YearDay,
  type YearMonth,
  type YearQuery,
  type YearRun,
} from "./year.js";
export {
  agendaDays,
  agendaFrom,
  spanOfView,
  type AgendaDay,
  type AgendaQuery,
  type AgendaRowData,
  type SpanView,
} from "./agenda.js";
export {
  fold,
  searchEvents,
  slips,
  wordsOf,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
} from "./search.js";
export type { HeldEdge, RangeActs, RangeDevice, RangeInput, ViewEvent, ViewEventRef } from "./view.js";
export {
  clockTime,
  clockTimeAt,
  dayAndMonth,
  dayDate,
  dayLong,
  dayShort,
  monthName,
  sameMonth,
  weekdayNames,
  weekTitle,
  yearOf,
} from "./format.js";
export { rowTime, type RowTime, type RowTimeInput } from "./rows.js";
export { EARLIER_DAYS, earlierSpan, useEarlier, type Earlier } from "./earlier.js";
