/**
 * A model fault that reached the sync loop, tagged so callers can tell it apart from a real
 * mailbox failure.
 *
 * The distinction is load-bearing rather than cosmetic: without it a model outage counts toward
 * `maxSyncFailures` and quarantines the mailbox, and whether it does so depends on how the
 * breaker threshold happens to compare with `maxSyncFailures`. With it, "a model outage can
 * never mark a mailbox broken" is true by construction at any tuning of either number.
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────────────────────
 *
 * It used to live in `ai-circuit.ts`, and `sync.ts` imported it from there for a single
 * `instanceof` test. That one edge pulled the whole circuit breaker — the retry policy, the
 * cooldown schedule and the model-client seam — into the import closure of every consumer of
 * the sync loop, including the local engine, which configures no model at all and can never
 * open the circuit.
 *
 * A class used only as a discriminator has no reason to carry its subsystem with it. This file
 * therefore imports NOTHING, which is what makes it safe to depend on from either side.
 */
export class ClassifierFaultError extends Error {
  override readonly name = "ClassifierFaultError";
  constructor(override readonly cause: unknown) {
    super("classifier call failed");
  }
}
