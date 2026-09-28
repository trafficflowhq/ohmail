import {
  MailboxSideRefusal, ServiceError, privateNetworkScope, type HostResolver,
} from "@trafficflow/services/mail";
import { pinFrom, probeHostGuardFor } from "./imap-probe.js";
import type { ApiDeps } from "./deps.js";

/**
 * THE HOST GUARD AT THE DIAL, which is the only moment it means anything. A stored `meta.host` was
 * cleared ONCE, when the mailbox was added, and every dial since handed the NAME to a fresh socket
 * that resolved it again — so the address checked and the address dialled were never one fact.
 * Here they are: resolve, clear, dial what was cleared. The name travels untouched, because SNI
 * and certificate validation must see what the user typed; a self-host install clears nothing and
 * so pins nothing. ONE module and not a copy per door — the send adapter and the attachment door
 * dial the same stored credential, and two spellings would be one door fixed and one door open.
 */

/**
 * The core gate's word for "the resolver had nothing to say", reached here as the tail of the
 * `ServiceError` message `@trafficflow/services/mail` wraps it in. Matched rather than assumed:
 * `send-adapter-pin.test.ts` drives a throwing resolver end to end, so a reworded refusal reddens
 * there instead of quietly turning every DNS blip into a terminal verdict. See {@link hostRefusal}.
 */
const UNRESOLVED = "host did not resolve";

/** Resolve, check through the deployment's guard, and answer with the addresses the dial may use. */
export async function clearedFor(
  deps: ApiDeps, host: string, port: number, transport: "imap" | "smtp",
): Promise<readonly string[] | undefined> {
  try {
    return pinFrom(await probeHostGuardFor(deps).check(host, port, transport));
  } catch (err) {
    throw hostRefusal(err, transport);
  }
}

/**
 * The guard's refusal as a dialling door owes it, and the CLASS is the decision. `resolveStale`
 * reads a `ServiceError` from the send factory as "this mailbox can never be dialled again" and
 * settles a stranded send terminally `unverified` — right for a server at an address this service
 * will not connect to, wrong for a resolver that was down for a minute. Before this guard existed
 * a DNS failure arrived from the socket as an ordinary dial error and the row was deferred, so a
 * resolver failure keeps leaving by that door.
 */
function hostRefusal(err: unknown, transport: "imap" | "smtp"): unknown {
  if (!(err instanceof ServiceError)) return err;
  const leg = transport === "imap" ? "incoming (IMAP)" : "outgoing (SMTP)";
  // The socket's own code, as before the guard: the send reads an unresolved host by it.
  if (err.message.endsWith(UNRESOLVED)) {
    return Object.assign(new Error(`the ${leg} server's hostname did not resolve`), { code: "ENOTFOUND" });
  }
  return new MailboxSideRefusal(
    "mailbox_host_refused", 502,
    `This mailbox's ${leg} server is at an address that is not one this service will connect to. `
      + "Check the server settings in Settings → Mailboxes.",
  );
}

/** One stored leg of a mailbox: where it dials, its TLS mode and its own plaintext consent. */
export interface DialLeg { host: string; port: number; secure: boolean; consent: boolean }

/**
 * THE FIELDS ONE LEG DIALS WITH, and the only place `allowInsecure` is set for a stored consent.
 * A leg without TLS is asked again where its name resolves NOW and admitted only when every
 * address is private, pinned to them: the consent was given for a server on the person's own
 * network, and a name that has since moved must not carry the password there in clear.
 */
export async function dialFieldsFor(
  deps: ApiDeps, leg: DialLeg, transport: "imap" | "smtp",
): Promise<{ pin?: readonly string[]; allowInsecure?: true }> {
  const pin = await clearedFor(deps, leg.host, leg.port, transport);
  if (!leg.consent || leg.secure) return pin ? { pin } : {};
  // The enforcing guard clears public addresses only, so a pin from it is never a private one.
  if (pin) throw new PlaintextDialRefused(transport);
  return { pin: await plaintextDialPin(deps.services?.probeScopeResolver, leg.host, transport), allowInsecure: true };
}

/**
 * The addresses a plaintext dial to `host` may use, from `resolver` at the moment of the dial.
 * No resolver, or one public address among the answers, is a refusal. A resolver that said
 * nothing leaves as the socket's own ENOTFOUND, for {@link hostRefusal}'s reason.
 */
export async function plaintextDialPin(
  resolver: HostResolver | undefined, host: string, transport: "imap" | "smtp",
): Promise<readonly string[]> {
  if (!resolver) throw new PlaintextDialRefused(transport);
  const scope = await privateNetworkScope(host, resolver);
  if (scope.kind === "private") return pinFrom(scope.pin)!;
  if (scope.kind === "public") throw new PlaintextDialRefused(transport);
  const leg = transport === "imap" ? "incoming (IMAP)" : "outgoing (SMTP)";
  throw Object.assign(new Error(`the ${leg} server's hostname did not resolve`), { code: "ENOTFOUND" });
}

/** The refusal, in the mailbox's own sentence. `mailbox_host_refused`'s class: no fault row. */
export class PlaintextDialRefused extends MailboxSideRefusal {
  constructor(readonly transport: "imap" | "smtp") {
    super(
      "mailbox_host_refused", 502,
      `This mailbox's ${transport === "imap" ? "incoming (IMAP)" : "outgoing (SMTP)"} server's address `
        + "is no longer on your own network, so ohmail will not send your password to it unencrypted.",
    );
    this.name = "PlaintextDialRefused";
  }
}
