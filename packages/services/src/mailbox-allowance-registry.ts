import { ServiceError } from "./errors.js";
import type { MailboxAllowancePolicy } from "./mailbox-service.js";

/**
 * Where the paid mailbox gate is REGISTERED, and why registered rather than imported. Importing
 * `assertMayAddMailbox` from `mailbox-service.ts` is why the whole Cloud schema was once in the
 * desktop engine's bundle: that file is mounted by the LOCAL API too, and an import edge is not
 * conditional on whether the branch runs. The default is set by whoever loads the FULL barrel —
 * only a hosted process does — which is why {@link defaultMailboxAllowance} REFUSES when nothing
 * has registered: an admitting default would silently remove the plan limit from any host that
 * forgot to wire one. A host that means to be unmetered says so (`apps/sidecar` passes
 * `UNMETERED_MAILBOX_ALLOWANCE`). Absent both, adding a mailbox fails loudly.
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
