import { ServiceError } from "@trafficflow/services/mail";
import { isRefusedCommand } from "@trafficflow/core/adapters/imap";
import { verdictFor } from "./imap-probe.js";

/** The sentence per refusal. Clients render their own copy from the code; these reach logs and old builds. */
const UNREACHABLE = "your mail server could not be reached, so this file could not be fetched — try again";
const NOT_SECURED = "the connection to your mail server could not be secured, so this file was not fetched";
const LOGIN_REFUSED = "your mail server refused the sign-in, so this file was not fetched — check the mailbox's password";
const RECONNECT = "this mailbox's sign-in has expired, so this file was not fetched — reconnect the mailbox";
const BUSY = "your mail server isn't serving this mailbox right now, so this file was not fetched — try again in a moment";

/**
 * A throw from the person's mail server as the typed 424 it is, or `null` for anything else, which
 * is ours until something names it (the envelope's 500). The classifier is the add-time probe's
 * `verdictFor`, so these codes and the sync strip's `mailboxes.error_code` are one vocabulary.
 * `retryable` says whether asking again can help: an unreachable server may answer next time; a
 * refused sign-in or an unsecured connection will not until the mailbox's settings change. A
 * server that took the connection and would not serve it (the probe's `store_unverified`), or that
 * answered a command NO or BAD after the sign-in, is busy, not silent and not ours. A refusal of
 * this deployment's own OAuth client names no arm here: it is ours.
 */
export function mailServerRefusal(err: unknown): ServiceError | null {
  if (typeof err !== "object" || err === null) return null;
  // Our own refusals are already named; read by shape, for two copies of the services package.
  if (err instanceof ServiceError || typeof (err as { httpStatus?: unknown }).httpStatus === "number") return null;
  const code = (err as { code?: unknown }).code;
  // The adapter's own "the connection ended" (imap.ts `ImapConnectionClosedError`), by its code.
  if (code === "EIMAPCLOSED") return refused("mail_server_unreachable", UNREACHABLE, true, err);
  // The OAuth token client's two verdicts, read as the worker's classifier reads them: a dead
  // refresh token is the person's to fix by reconnecting, a token-endpoint outage is the provider's.
  if (code === "OAUTH_INVALID_GRANT") return refused("mailbox_reconnect_required", RECONNECT, false, err);
  if (code === "OAUTH_TOKEN_ENDPOINT_UNAVAILABLE") return refused("mail_server_unreachable", UNREACHABLE, true, err);
  const v = verdictFor(err);
  if (v.verdict === "ok") return null;
  if (v.verdict === "store_unverified") return refused("mail_server_busy", BUSY, true, err);
  switch (v.code) {
    case "auth": return refused("mail_server_login_refused", LOGIN_REFUSED, false, err);
    case "tls": return refused("mail_server_not_secured", NOT_SECURED, false, err);
    case "connect":
    case "timeout": return refused("mail_server_unreachable", UNREACHABLE, true, err);
    // imapflow's "Command failed": a tagged NO or BAD. A refused LOGIN carries the auth flag and is
    // named above, so what reaches here was refused after the sign-in (Gmail's "could not be FETCHed").
    default: return isRefusedCommand(err) ? refused("mail_server_busy", BUSY, true, err) : null;
  }
}

function refused(code: string, message: string, retryable: boolean, cause: unknown): ServiceError {
  const e = new ServiceError(code, 424, message, undefined, retryable);
  (e as { cause?: unknown }).cause = cause;
  return e;
}
