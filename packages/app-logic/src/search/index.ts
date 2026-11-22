/** The door of `search`: Search's behaviour, apart from what draws it. */
export { shortCivilDateStamp } from "@ohmail/client-engine";
export * from "./types.js";
export * from "./context.js";
export { useSearchList } from "./search-list.js";
export { ARCHIVE_DEBOUNCE_MS, ARCHIVE_TIMEOUT_MS, PAGE_AHEAD_PX, SEARCH_SORTS } from "./constants.js";
export {
  justFinished,
  parseOperators,
  withoutOperator,
  OPERATOR_KEYS,
  type OperatorKey,
  type TypedOperator,
  type TypedText,
} from "./operators.js";
export { onePersonMeant, peopleFor, sharesName } from "./people.js";
export {
  dayBounds,
  filtersOf,
  narrowed,
  NO_NARROWING,
  type SearchBy,
  type SearchNarrowing,
} from "./question.js";

export { useSearchLive, type SearchLive, type SearchLiveOwn } from "./live.js";
export {
  useSearchOpen,
  type SearchOpenGround,
  type SearchOpenOwn,
  type SearchScreenerRow,
} from "./live-open.js";
export {
  openTargetOf,
  type SearchOpenFacts,
  type SearchOpenTarget,
  type SearchScreenerSegment,
} from "./open-target.js";

export { mailboxTotalOf, readSearchBy } from "./supplies.js";
