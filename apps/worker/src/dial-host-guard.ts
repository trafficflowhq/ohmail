import {
  clearMailDial, MailDialRefusal, MAX_PINNED_ADDRESSES, nodeHostResolver, privateNetworkScope, SsrfRefusal,
  type HostResolver,
} from "@trafficflow/core/net";

/**
 * THE HOST GUARD AT THE ORGANIZER'S DIAL. A stored host was cleared once, when the mailbox was
 * added; here it is resolved, checked and port-ruled at the moment of the dial, and the cleared
 * addresses travel as `ImapConfig.pin` — the name is untouched, because SNI and certificate
 * validation must see what the person typed. The decision is the API door's own (`clearMailDial`,
 * `@trafficflow/core/net`); this adapter only says its refusals as the organizer's closed codes,
 * because the API's module reaches a package this app keeps out of its runtime graph.
 */

/** The deployment's verdict on a host and port: the addresses to pin, or `null` for "dial by name". */
export interface DialHostGuard {
  check(host: string, port: number, transport: "imap" | "smtp"): Promise<readonly string[] | null>;
  /** Asked where a plaintext dial's host resolves NOW. Absent: no plaintext dial is admitted. */
  readonly scope?: HostResolver;
}

/**
 * The SELF-HOST policy. It clears nothing and therefore pins nothing: a mail server on a LAN
 * address behind a name only the operator's own resolver knows is legitimate there, so the dial is
 * by name exactly as it was before this guard existed.
 */
export const ALLOW_ANY_DIAL_HOST: DialHostGuard = { check: async () => null };

/** The self-host policy with a resolver, so a consented plaintext dial can be re-asked. */
function allowAnyDialHost(resolver: HostResolver): DialHostGuard {
  return { check: async () => null, scope: resolver };
}

/**
 * The MANAGED policy: a port that carries no mail, and private, loopback, link-local, CGNAT,
 * unresolvable and unparseable targets, are refused before a socket exists; what cleared is the pin.
 * The resolver is required at construction for the reason the gate states — a fallback to
 * `node:dns` would make every test take the refuse branch and ship the permit branch unexecuted.
 */
export function makeDialHostGuard(resolver: HostResolver): DialHostGuard {
  return { check: async (host, port, transport) => clearMailDial(resolver, host, port, transport), scope: resolver };
}

/**
 * Build this deployment's policy from its own configuration.
 *
 * `TF_PROBE_ALLOW_PRIVATE=1` — the variable `apps/server/src/config.ts` reads for the API's probe,
 * on `pushEndpointGuardFromEnv`'s exact argument: the process that ACCEPTS a mailbox and the one
 * that DIALS it must not disagree, or an operator gets a mailbox the API took and the organizer
 * refuses every cycle. `=== "1"` exactly, like both siblings. ABSENT SELECTS THE STRICT BRANCH:
 * a security default nobody chose is not a default.
 */
export function dialHostGuardFromEnv(
  env: NodeJS.ProcessEnv = process.env, resolver: HostResolver = nodeHostResolver,
): DialHostGuard {
  return (env.TF_PROBE_ALLOW_PRIVATE ?? "").trim() === "1"
    ? allowAnyDialHost(resolver)
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

/** A stored port that carries no mail. The detail the row stores, so Settings names the port. */
export class MailboxPortRefused extends Error {
  readonly code = "MAILBOX_PORT_REFUSED";
  constructor(transport: "imap" | "smtp") {
    super(`this mailbox's ${transport === "imap" ? "incoming (IMAP)" : "outgoing (SMTP)"} server is set to a port that does not carry mail`);
    this.name = "MailboxPortRefused";
  }
}

/** The socket's own code for a name that did not resolve, so the row says `connect`, not "could not tell". */
const unresolved = (transport: "imap" | "smtp"): Error =>
  Object.assign(new Error(`the ${transport} server's hostname did not resolve`), { code: "ENOTFOUND" });

/**
 * A consented plaintext dial whose host no longer resolves to the person's own network. The
 * detail the mailbox row stores, so Settings says that sentence and not "not available".
 */
class MailboxPlaintextRefused extends Error {
  readonly code = "MAILBOX_PLAINTEXT_REFUSED";
  constructor(transport: "imap" | "smtp") {
    super(
      `this mailbox's ${transport === "imap" ? "incoming (IMAP)" : "outgoing (SMTP)"} server's address `
      + "is no longer on your own network, so the password is not sent to it unencrypted",
    );
    this.name = "MailboxPlaintextRefused";
  }
}

/** One stored leg: its TLS mode and its own plaintext consent (`TransportCreds` has both). */
interface DialLeg { secure: boolean; allowInsecure?: boolean }

/** The gate's own word for "the resolver had nothing to say" — a FIELD, never a message tail. */
const UNRESOLVED = "host did not resolve";

/**
 * Resolve, check through the deployment's policy, and answer with the fields a dial config spreads.
 *
 * A RESOLVER OUTAGE IS NOT A VERDICT ABOUT A MAILBOX. Before this guard existed a DNS failure
 * arrived from the socket as an ordinary dial error and the mailbox was retried; a typed refusal
 * here would instead read as "this server can never be dialled again". So a failure to resolve
 * leaves by the ordinary door, carrying the socket's own `ENOTFOUND`, and only a refused port or a
 * cleared-and-refused address gets a typed refusal. `port` is required: every leg is port-ruled.
 */
export async function checkedDial(
  guard: DialHostGuard | undefined, host: string, port: number, transport: "imap" | "smtp", leg?: DialLeg,
): Promise<{ pin?: readonly string[]; allowInsecure?: true }> {
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
  let cleared: readonly string[] | null;
  try {
    cleared = await guard.check(host, port, transport);
  } catch (err) {
    if (err instanceof MailDialRefusal && err.port !== undefined) throw new MailboxPortRefused(transport);
    if (err instanceof SsrfRefusal) {
      if (err.why === UNRESOLVED) throw unresolved(transport);
      throw new MailboxHostRefused(transport);
    }
    throw err;
  }
  const pin = cleared && cleared.length > 0 ? cleared : null;
  if (leg?.allowInsecure !== true || leg.secure) return pin ? { pin } : {};
  /* THE PLAINTEXT DIAL, and the only place its flag is set. Admitted only where every address the
     name resolves to now is private, pinned there; a pin from the enforcing policy is public by
     construction. An unanswered lookup leaves by the ordinary door, as above. */
  if (pin || !guard.scope) throw new MailboxPlaintextRefused(transport);
  const scope = await privateNetworkScope(host, guard.scope);
  if (scope.kind === "unresolved") throw unresolved(transport);
  if (scope.kind === "public") throw new MailboxPlaintextRefused(transport);
  return { pin: scope.pin.slice(0, MAX_PINNED_ADDRESSES), allowInsecure: true };
}
