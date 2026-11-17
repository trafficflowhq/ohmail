/**
 * A model fault that reached the sync loop, tagged so callers can tell it apart from a real mailbox
 * failure. Load-bearing, not cosmetic: without it a model outage counts toward `maxSyncFailures` and
 * quarantines the mailbox, depending on how the breaker threshold happens to compare with
 * `maxSyncFailures`; with it, "a model outage can never mark a mailbox broken" is true by construction at
 * any tuning. Its own module because it used to live in `ai-circuit.ts` and `sync.ts` imported it for a
 * single `instanceof`, which pulled the whole circuit breaker (retry policy, cooldown, model-client seam)
 * into every consumer of the sync loop — including the local engine, which configures no model. A class
 * used only as a discriminator imports NOTHING, which is what makes it safe to depend on from either side.
 */
export class ClassifierFaultError extends Error {
  override readonly name = "ClassifierFaultError";
  constructor(override readonly cause: unknown) {
    super("classifier call failed");
  }
}
