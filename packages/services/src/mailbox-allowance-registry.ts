import { ServiceError } from "./errors.js";
import type { MailboxAllowancePolicy } from "./mailbox-service.js";

/**
 * WHERE THE PAID MAILBOX GATE IS REGISTERED, and why it is registered rather than imported.
 *
 * `MailboxService` needs a default allowance policy, and the right default for a hosted
 * deployment is `assertMayAddMailbox` — the limit gate that counts the account's mailboxes under
 * a row lock inside the caller's transaction. Importing it from `mailbox-service.ts` is the
 * obvious way to say that, and it is the reason the whole Cloud schema was once in the desktop
 * engine's shipped bundle: `mailbox-service.ts` is mounted by the LOCAL API too, and an import
 * edge is not conditional on whether the branch that uses it ever runs.
 *
 * So the default is set by whoever loads the FULL `@trafficflow/services` barrel — which only a
 * hosted process does. `@trafficflow/services/mail`, the entry point the engine is bundled from,
 * deliberately does not, which is why {@link defaultMailboxAllowance} refuses rather than
 * permits when nothing has registered.
 *
 * ── WHY REFUSING IS THE RIGHT UNSET BEHAVIOUR ─────────────────────────────────────────────
 *
 * The alternative — an unset default that admits — silently removes the plan limit from any host
 * that forgot to wire one, and "the paid gate quietly stopped applying" is not a failure anyone
 * would notice from the outside. A host that means to be unmetered says so: `apps/sidecar` passes
 * `UNMETERED_MAILBOX_ALLOWANCE`, whose comment states that the desktop tier is free. Absent
 * both, adding a mailbox fails loudly at the one call that needed a decision nobody made.
 */
let registered: MailboxAllowancePolicy | null = null;

/** Called by the full `@trafficflow/services` barrel on load. Idempotent; last writer wins. */
export function setDefaultMailboxAllowance(policy: MailboxAllowancePolicy): void {
  registered = policy;
}

/** The registered policy, or one that refuses. Never silently unmetered — see the header. */
export function defaultMailboxAllowance(): MailboxAllowancePolicy {
  const policy = registered;
  if (policy) return policy;
  return async () => {
    throw new ServiceError(
      "server_error", 500,
      "no mailbox allowance policy is configured for this host",
    );
  };
}
