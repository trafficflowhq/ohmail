/** The return after paying, one state per address of the design's reference (`screen=subscribed&state=…`). */
export const SUBSCRIBED_STATES = ["continuing", "back"] as const;
export type SubscribedStateId = (typeof SUBSCRIBED_STATES)[number];
