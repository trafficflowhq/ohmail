/** The no-page's states, one per address of the design's reference (`screen=nopage&state=…`). */
export const NO_PAGE_STATES = ["missing", "noserver"] as const;
export type NoPageStateId = (typeof NO_PAGE_STATES)[number];
