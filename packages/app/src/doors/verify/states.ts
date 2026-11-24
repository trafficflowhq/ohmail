/** The email confirmation's states, one per address of the design's reference (`screen=verify&state=…`). */
export const VERIFY_STATES = [
  "form",
  "code",
  "badlink",
  "badpw",
  "locked",
  "slowed",
  "done",
  "handed",
  "unavailable",
] as const;
export type VerifyStateId = (typeof VERIFY_STATES)[number];
