import { ServiceError } from "@trafficflow/services/mail";
import { verdictFor } from "./imap-probe.js";

/** The sentence per refusal. Clients render their own copy from the code; these reach logs and old builds. */
const UNREACHABLE = "your mail server could not be reached, so this file could not be fetched — try again";
const NOT_SECURED = "the connection to your mail server could not be secured, so this file was not fetched";
const LOGIN_REFUSED = "your mail server refused the sign-in, so this file was not fetched — check the mailbox's password";
const RECONNECT = "this mailbox's sign-in has expired, so this file was not fetched — reconnect the mailbox";

/**
 * A throw from the person's mail server as the typed 424 it is, or `null` for anything else, which
 * is ours until something names it (the envelope's 500). The classifier is the add-time probe's
 * `verdictFor`, so these codes and the sync strip's `mailboxes.error_code` are one vocabulary.
 * `retryable` says whether asking again can help: an unreachable server may answer next time; a
 * refused sign-in or an unsecured connection will not until the mailbox's settings change.
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
  switch (v.code) {
    case "auth": return refused("mail_server_login_refused", LOGIN_REFUSED, false, err);
    case "tls": return refused("mail_server_not_secured", NOT_SECURED, false, err);
    case "connect":
    case "timeout": return refused("mail_server_unreachable", UNREACHABLE, true, err);
    default: return null;
  }
}

function refused(code: string, message: string, retryable: boolean, cause: unknown): ServiceError {
  const e = new ServiceError(code, 424, message, undefined, retryable);
  (e as { cause?: unknown }).cause = cause;
  return e;
}
