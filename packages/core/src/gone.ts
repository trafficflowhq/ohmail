/**
 * ── A GONE LOCATOR IS ONE FACT WITH THREE READINGS, AND THE DEFAULT IS NOT "FAILED" ─────────
 *
 * `MessageGoneError` (`adapters/imap.ts`) says exactly one thing: **the locator we hold no longer
 * names this message on this server.** It says nothing whatever about whether the message exists.
 * Three readings fit that fact, and the consumer must pick between them ON EVIDENCE:
 *
 *  1. **RE-RESOLVABLE** — the message is still there under a different UID. Another client moved
 *     it, or the folder was recycled and re-enumerated under a new UIDVALIDITY. The mirror learns
 *     the new locator on the next scan, because adoption keys on the message's dedup identity
 *     (Message-ID and fingerprint), not on its UID.
 *  2. **DEFERRABLE** — we cannot yet tell which of (1) and (3) is true. This is the ORDINARY case
 *     and it is the one the whole family gets wrong.
 *  3. **TERMINAL** — the message is gone for good. This reading requires POSITIVE evidence: a
 *     durably-observed disappearance under a matching epoch (`RepoPort.primaryInstanceVanished`,
 *     which `sync.ts#voidGoneFiling` is written against). Absent that evidence it may not be
 *     assumed, because the two are indistinguishable at the point the error is caught.
 *
 * **The default when in doubt is (2), never (3), and never "the action failed".** A consumer that
 * reads a gone locator as terminal converts an ordinary provider housekeeping event into lost user
 * intent — the failure this module's consumers were all found to share.
 *
 * ── THE RULE, PER SEAM ──────────────────────────────────────────────────────────────────────
 *
 * · **A READ may re-resolve and retry.** Re-reading `messages.native_locator` and fetching again
 *   sends nothing, changes nothing and cannot land on a stranger's mail: the worst case is a
 *   second wasted read. `SendService#streamForwardParts` does exactly this, once.
 * · **A MUTATION may NOT re-resolve in line.** Re-resolving a locator and then MOVING what is
 *   found there is the precise shape of the defect the epoch guard exists to stop — the identity
 *   of what now wears the UID has not been proved. A mutation that meets a gone locator persists
 *   the INTENT and returns; the organizer re-adopts the message by identity on its next scan and
 *   applies the intent to the message rather than to the UID. `pipeline.ts#applyReconcileAction`
 *   and `sync.ts#fileOne` are the two implementations of that rule.
 * · **A user-visible refusal names the true state.** Never "it failed" for work that is merely not
 *   done yet, and never "check whether it happened" for an action the code KNOWS did not happen.
 *
 * ── WHY THE PREDICATE AND NOT `instanceof` ──────────────────────────────────────────────────
 *
 * `packages/services` and this module's own `pipeline.ts` must not import
 * `@trafficflow/core/adapters/imap`: that would drag `imapflow` into the service layer and into the
 * desktop engine's graph, which is the seam the injected `openAdapter` exists to keep. So the
 * error is recognised by its `code`, which it carries for this reason and says so on its own
 * docblock. `instanceof` stays correct inside the worker and the API, which do import the class,
 * and the two agree because {@link MESSAGE_GONE_CODE} is the single spelling both are built from.
 *
 * This module is a LEAF: no imports, no adapter, no database. That is what lets the model layer,
 * the service layer and the client engine all name the same rule.
 */

/**
 * `MessageGoneError.code`. Declared here rather than in the adapter so that the class and every
 * duck-typed consumer are built from one string — a second spelling is a predicate that silently
 * stops matching, which reads exactly like "this never happens".
 */
export const MESSAGE_GONE_CODE = "EMSGGONE";

/**
 * Is this the adapter's "not at that locator any more" refusal?
 *
 * True for `MessageGoneError` from any adapter — the real IMAP one, a fake, a GreenMail-backed
 * double — because the check is on the carried `code` and not on the class identity.
 */
export function isMessageGone(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as { code?: unknown }).code === MESSAGE_GONE_CODE;
}
