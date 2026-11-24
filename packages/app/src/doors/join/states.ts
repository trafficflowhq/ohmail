/**
 * The join's states, by the design reference's addresses: the onboarding's steps `account` (and `state=invite`),
 * `verify`, `factor` (`state=app`, `refused`), `codes`, `plan`; the door states it is handed (the sign-up refusals,
 * `full` and `expired`; the plan's three waits); and the product's own steps the reference does not draw (sent,
 * mailbox, done, resolving, unreachable, unavailable).
 */
export const JOIN_STATES = [
  "account",
  "invite",
  "verify",
  "factor",
  "app",
  "refused",
  "codes",
  "plan",
  "starting",
  "pending",
  "nopage",
  "full",
  "expired",
  "taken",
  "typo",
  "sent",
  "mailbox",
  "done",
  "resolving",
  "unreachable",
  "unavailable",
] as const;
export type JoinStateId = (typeof JOIN_STATES)[number];
