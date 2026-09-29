/**
 * WHICH SIDE FAILED, for one file that could not be fetched. A reader's sentence is chosen by this
 * class and never by the server's English message, so every reader says the same thing in its own
 * language. Keyed on the refusal's code first, then its HTTP status; whether Try again is offered
 * is the refusal's own `retryable` and nothing here.
 */
export type AttachmentFaultClass =
  /** ohmail failed, or answered in a shape nothing names. */
  | "ohmail"
  /** ohmail's own cap on live connections to this mailbox. */
  | "busy"
  /** The person's mail server did not answer, or not in time. */
  | "unreachable"
  /** The person's mail server took the connection and would not serve this mailbox now. */
  | "server_busy"
  /** The person's mail server would not secure the connection. */
  | "not_secured"
  /** The person's mail server refused the stored sign-in. */
  | "login_refused"
  /** The mailbox's OAuth sign-in has expired: only a reconnect brings it back. */
  | "reconnect"
  /** This mailbox holds no sign-in here (signed out or removed): only signing in brings it back. */
  | "not_signed_in"
  /** The message is no longer where the mailbox had it. */
  | "gone"
  /** A refusal by policy: nothing about asking again changes it. */
  | "refused"
  /** The request never reached ohmail, or nothing came back. */
  | "offline"
  /** ohmail refused the session, not the file. */
  | "signed_out";

const BY_CODE: Readonly<Record<string, AttachmentFaultClass>> = {
  mailbox_busy: "busy",
  mail_server_unreachable: "unreachable",
  mailbox_read_timeout: "unreachable",
  mail_server_busy: "server_busy",
  mail_server_not_secured: "not_secured",
  mail_server_login_refused: "login_refused",
  mailbox_reconnect_required: "reconnect",
  mailbox_not_signed_in: "not_signed_in",
  not_found: "gone",
  network: "offline",
  timeout: "offline",
  unauthorized: "signed_out",
  csrf_failed: "signed_out",
  internal: "ohmail",
  db_busy: "ohmail",
  upstream_unavailable: "ohmail",
};

export function attachmentFaultClass(code: string | null | undefined, status?: number | null): AttachmentFaultClass {
  const named = code == null ? undefined : BY_CODE[code];
  if (named !== undefined) return named;
  if (status === 401) return "signed_out";
  if (typeof status === "number" && status >= 400 && status < 500) return "refused";
  if (typeof status === "number") return "ohmail";
  // No code and no status: the adapter threw before any answer existed.
  return code == null ? "offline" : "ohmail";
}
