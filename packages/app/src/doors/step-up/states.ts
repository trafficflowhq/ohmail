/**
 * The step-up dialog's states, one per address of the design's reference (`ask=<place>&how=…&err=…` over a page): the
 * three ways, and the refusals each is said with. Cancelled with nothing run and the window expired are the place's
 * own states (the desktop pages' `discarded` and `cancelled`, the delete page's `cancelled` and `window`).
 */
export const STEP_UP_STATES = [
  "passkey",
  "code",
  "recovery",
  "locked",
  "badcode",
  "badpasskey",
  "badrecovery",
  "slowed",
  "refused",
  "lost",
] as const;
export type StepUpStateId = (typeof STEP_UP_STATES)[number];
