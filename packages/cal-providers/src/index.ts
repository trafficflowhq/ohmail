/**
 * The calendar's providers: Google, CalDAV, Microsoft and a subscription by address, each a reader
 * behind one port (`./port`). The package reads no environment and no clock of its own, and it
 * reaches a host only through the request ports of `./request`.
 */
export type * from "./port.js";
export * from "./refusals.js";
export * from "./limits.js";
export * from "./secret.js";
export * from "./credentials.js";
export * from "./request/index.js";
export * from "./providers.js";
export * from "./repeat-shapes.js";
export * from "./series.js";
/** Microsoft's own address of its API: what a composing program names as the base unless it means another. */
export { MS_GRAPH_BASE } from "./microsoft/index.js";
export { alreadyHolds } from "./write-compare.js";
export { calendarKey } from "./calendar-key.js";

export { portableCalendarText } from "./portable.js";
