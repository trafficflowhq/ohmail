/**
 * Why the act on suggestions could not file a sender (`routing_decisions.act_refusal`):
 * the account was erased, this install is not the mailbox's organizer, the mailbox was removed, or
 * any other store refusal. The ONE definition — the CHECK, the pass's classifier and the closed-set
 * census read it. `store_fault` is the catch-all, so a new failure has a member without a widening.
 */
export const SCREENER_ACT_REFUSALS = [
  "account_erased", "not_organizer", "mailbox_removed", "store_fault",
] as const;
export type ScreenerActRefusal = (typeof SCREENER_ACT_REFUSALS)[number];

export function isScreenerActRefusal(v: unknown): v is ScreenerActRefusal {
  return typeof v === "string" && (SCREENER_ACT_REFUSALS as readonly string[]).includes(v);
}
