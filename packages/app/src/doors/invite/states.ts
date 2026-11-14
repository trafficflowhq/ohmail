/** The household invite's states, one per address of the design's reference (`screen=invite&state=…`). */
export const INVITE_STATES = ["opening", "form", "dead", "used", "incomplete", "unavailable"] as const;
export type InviteStateId = (typeof INVITE_STATES)[number];
