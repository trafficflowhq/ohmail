/**
 * THE UNSUBSCRIBE DRAIN'S CEILING AND THE BUDGET ONE RUN SPENDS UNDER IT — one pair, in the one
 * package the caller (`apps/worker/src/api-cron.ts`), the route (`@trafficflow/api`) and the pass
 * (`@trafficflow/services`) all import. The numbers used to be stated twice, 60 s on the caller
 * and 45 s in the service, and nothing could see them disagree; what shipped was worse than
 * drift — the service's clock started AFTER its candidate read, so a slow read spent the whole
 * invocation before anything bounded began and the platform killed the run with its remainder
 * undelivered. The budget is what a run may spend; the ceiling is what kills it.
 */

/** The invocation ceiling: the platform's kill, and the caller's abort, are both this. */
export const UNSUB_DRAIN_CEILING_MS = 60_000;

/**
 * What ONE run may spend end to end, entered at the top of the route and threaded through every
 * segment. Comfortably under the ceiling rather than flush with it: a run that returns is what
 * makes the counts readable, and a run that is killed reports nothing about what it did.
 */
export const UNSUB_DRAIN_RUN_BUDGET_MS = 25_000;

/**
 * The tail of the budget the posting phase may not enter, kept for the closing count that makes
 * `remaining` a fact rather than a lower bound. A number reported as 0 because the run ran out of
 * time to ask is the "not answered yet" / "nothing left" collapse this reserve exists to prevent.
 */
export const UNSUB_DRAIN_CLOSE_RESERVE_MS = 3_000;
