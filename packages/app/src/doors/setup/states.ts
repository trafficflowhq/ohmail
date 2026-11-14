/** The server setup's states, one per address of the design's reference (`screen=serversetup&state=…`). */
export const SETUP_STATES = ["checking", "form", "badtoken", "spent", "settled", "unreachable"] as const;
export type SetupStateId = (typeof SETUP_STATES)[number];
