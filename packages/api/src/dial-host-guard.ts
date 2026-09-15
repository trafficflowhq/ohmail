import { ServiceError } from "@trafficflow/services/mail";
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
  if (err.message.endsWith(UNRESOLVED)) return new Error(`the ${leg} server's hostname did not resolve`);
  return new ServiceError(
    "mailbox_host_refused", 502,
    `This mailbox's ${leg} server is at an address that is not one this service will connect to. `
      + "Check the server settings in Settings → Mailboxes.",
  );
}
