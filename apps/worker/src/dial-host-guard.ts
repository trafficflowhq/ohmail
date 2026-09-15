import {
  assertPublicHost, nodeHostResolver, SsrfRefusal, type HostResolver,
} from "@trafficflow/core/net";

/**
 * THE HOST GUARD AT THE ORGANIZER'S DIAL. A stored `meta.host` was resolved and cleared once, when
 * the mailbox was added; every dial the background process has made since handed the NAME to a
 * fresh socket that resolved it again, so the address that was checked and the address that was
 * dialled were two different facts. Here they are one act: resolve, clear, and hand the cleared
 * addresses down as `ImapConfig.pin`. The name travels untouched — SNI and certificate validation
 * must see what the person typed; the pin narrows the ADDRESS and nothing else.
 *
 * ONE POLICY, READ FROM THE DEPLOYMENT. Not the API's `packages/api/src/dial-host-guard.ts`: that
 * one reaches `@trafficflow/services/mail`, which this app keeps out of its runtime dependencies
 * on a measured boot hazard. Both compose the SAME gate — `assertPublicHost` in
 * `@trafficflow/core/net`, the subpath that exists for this consumer — which is the rule that file
 * states: one implementation, two thin adapters, because a second copy of an SSRF gate is a bypass
 * nobody can see.
 */

/** The deployment's verdict on a host: the addresses to pin, or `null` for "dial by name". */
export interface DialHostGuard {
  check(host: string, transport: "imap" | "smtp"): Promise<readonly string[] | null>;
}

/**
 * The SELF-HOST policy. It clears nothing and therefore pins nothing: a mail server on a LAN
 * address behind a name only the operator's own resolver knows is legitimate there, so the dial is
 * by name exactly as it was before this guard existed.
 */
export const ALLOW_ANY_DIAL_HOST: DialHostGuard = { check: async () => null };

/**
 * The MANAGED policy: private, loopback, link-local, CGNAT, unresolvable and unparseable targets
 * are refused before a socket exists, and what cleared is the pin. The resolver is required at
 * construction for the reason the gate states — a fallback to `node:dns` would make every test
 * take the refuse branch and ship the permit branch unexecuted.
 */
export function makeDialHostGuard(resolver: HostResolver): DialHostGuard {
  return { check: async (host) => assertPublicHost(host, resolver) };
}

/**
 * Build this deployment's policy from its own configuration.
 *
 * `TF_PROBE_ALLOW_PRIVATE=1` — the same variable `apps/server/src/config.ts` reads for the API's
 * add-time probe, deliberately, on `pushEndpointGuardFromEnv`'s exact argument: the process that
 * ACCEPTS a mailbox and the process that DIALS it must not disagree about whether its server is
 * reachable, or an operator gets a mailbox the API took and the organizer refuses on every cycle.
 * `=== "1"` exactly, like both siblings, so `"true"` and `"yes"` cannot arm a relaxation. ABSENT
 * SELECTS THE STRICT BRANCH, which is the API's stated rule and not a convenience: a security
 * default nobody chose is not a default.
 */
export function dialHostGuardFromEnv(
  env: NodeJS.ProcessEnv = process.env, resolver: HostResolver = nodeHostResolver,
): DialHostGuard {
  return (env.TF_PROBE_ALLOW_PRIVATE ?? "").trim() === "1"
    ? ALLOW_ANY_DIAL_HOST
    : makeDialHostGuard(resolver);
}

/**
 * The refusal, as a CLASS, because the class is what the decision is made on. `classifyMailboxError`
 * reads it as `connect` — a mailbox at an address this deployment will not dial is a connect-time
 * failure, which is what the person's row and the admin console already know how to say — and the
 * `code` is a closed token of ours, never the gate's or a server's words.
 */
export class MailboxHostRefused extends Error {
  readonly code = "MAILBOX_HOST_REFUSED";
  constructor(transport: "imap" | "smtp") {
    super(
      `this mailbox's ${transport === "imap" ? "incoming (IMAP)" : "outgoing (SMTP)"} server is at `
      + "an address this deployment will not connect to",
    );
    this.name = "MailboxHostRefused";
  }
}

/** The gate's own word for "the resolver had nothing to say" — a FIELD, never a message tail. */
const UNRESOLVED = "host did not resolve";

/**
 * Resolve, check through the deployment's policy, and answer with the fields a dial config spreads.
 *
 * A RESOLVER OUTAGE IS NOT A VERDICT ABOUT A MAILBOX. Before this guard existed a DNS failure
 * arrived from the socket as an ordinary dial error and the mailbox was retried; a typed refusal
 * here would instead read as "this server can never be dialled again". So a failure to resolve
 * leaves by the ordinary door and only a cleared-and-refused address gets {@link MailboxHostRefused}.
 */
export async function checkedDial(
  guard: DialHostGuard | undefined, host: string, transport: "imap" | "smtp",
): Promise<{ pin?: readonly string[] }> {
  // A COMPOSITION WITH NO POLICY REFUSES, and names the input. The alternative is a silent dial by
  // name, which is the state this whole module removes — and it would be invisible, because it
  // looks exactly like a healthy self-hosted install.
  if (!guard) {
    throw new Error(
      "no dial host policy was composed for this process: it cannot decide whether this mailbox's "
      + "server may be dialled. Set TF_PROBE_ALLOW_PRIVATE (absent enforces public addresses only; "
      + "=1 permits a mail server on your own network) and compose `dialHostGuardFromEnv`",
    );
  }
  try {
    const cleared = await guard.check(host, transport);
    return cleared && cleared.length > 0 ? { pin: cleared } : {};
  } catch (err) {
    if (err instanceof SsrfRefusal) {
      if (err.why === UNRESOLVED) throw new Error(`the ${transport} server's hostname did not resolve`);
      throw new MailboxHostRefused(transport);
    }
    throw err;
  }
}
