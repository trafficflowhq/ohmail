/**
 * THE CLOSED SET `mailboxes.error_detail` MAY HOLD, AND THE EVIDENCE SETS IT IS BUILT FROM.
 *
 * It lived in `apps/worker/src/mailboxes.ts`, where the only reader that could ever see it was
 * the write door. That made the READ side unserviceable: the admin console projects this column
 * and had no way to ask whether a value it is about to render is a word this codebase chose. A
 * write-site allowlist is a claim about every writer past and future; a read-side membership test
 * is a claim about the ONE value in hand, which is the rule a staff surface has to meet. So the
 * set moves to the package that owns the column, both ends import it, and `staff-channels.ts` is
 * what the projection asks.
 *
 * The sets below are unchanged in content. The classifier that reads several of them for
 * CLASSIFICATION stays in the worker and imports them from here — classification is IMAP
 * judgement, membership is the column's rule, and only the second belongs to the database.
 */

export const CONNECT_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN",
  "ECONNRESET", "EPIPE", "EAI_AGAIN", "EADDRNOTAVAIL",
]);

/* The mail server is not available, which is not a rejected password. Two sets, one per channel,
   because a provider that will not serve us says so in two different places and the worker recognised
   neither. A provider at its connection cap answers `* BYE [UNAVAILABLE] Maximum number of
   connections…` and closes; `serverBye` keeps only the TEXT attributes as `byeReason` — a bracket
   atom is a SECTION, not TEXT — so the bracket atom never becomes `serverResponseCode` on this shape,
   and the pending LOGIN is rejected carrying `code` and nothing else, with `authenticationFailed`
   stamped on. So the fix is BOTH sets, not the response code alone. Neither WIDENS what can be stored:
   every member is already in {@link IMAPFLOW_CODES} or {@link IMAP_RESPONSE_CODES}, spread into
   {@link MAILBOX_ERROR_DETAIL_TOKENS} so that Set's "nothing storable without appearing" stays true. */

/**
 * The INSTALLED client's own words for a server that did not serve us — not errnos, hence their own
 * set rather than four more members of {@link CONNECT_ERRNOS}. `NoConnection`, `EConnectionClosed`
 * and the two `ClosedAfterConnect*` (a close landing while the connect promise is pending — that one
 * never reaches the LOGIN catch, carries no flag, and used to fall to the phase fallback as
 * `unknown`). `ETHROTTLE` is the fifth: set when a server answers a tagged failure with "Request is
 * throttled. Suggested Backoff Time: N" (Office 365's rate limit), on the GENERIC tagged-response
 * path, so it fires for LOGIN and `login.js` stamps the flag on it — leaving it out would ship the
 * identical sentence one provider over. Its `err.throttleReset` (the server's suggested backoff) is ignored by the retry ladder, which lives in the main loop, not here.
 */
export const SERVER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "NoConnection", "EConnectionClosed", "ClosedAfterConnectText", "ClosedAfterConnectTLS",
  "ETHROTTLE",
]);

/**
 * RFC 5530 response codes that mean THE SERVER WILL NOT SERVE US RIGHT NOW. `UNAVAILABLE` is "a
 * subsystem is temporarily down"; `LIMIT` is "an implementation limit was reached", which is what a
 * per-account connection cap is. A server that answers either has received and parsed our LOGIN, so
 * neither is a statement about credentials. CLOSED AND NAMED, never "an atom that looks like a
 * refusal": the forged-token rule applies to reading a server-chosen token as much as storing one, so
 * an atom this set does not contain must fall THROUGH to the evidence below, or a hostile endpoint
 * answering `NO [SECRETPASSWORD123]` could suppress the auth verdict by handing us a word we do not know.
 */
export const SERVER_UNAVAILABLE_RESPONSE_CODES: ReadonlySet<string> = new Set(["UNAVAILABLE", "LIMIT"]);

/**
 * OAuth token-refresh codes that are safe to STORE in `error_detail`.
 *
 * Only `OAUTH_INVALID_GRANT` — the re-auth verdict a user acts on ("reconnect this mailbox"). It is
 * a constant this codebase chose, not a server-supplied atom, so echoing it back to the account
 * owner tells them what happened without letting anyone else pick the words (the whole point of the
 * closed allowlist below). The provider-unavailable and config-missing codes are deliberately NOT
 * here: their `error_code` (`connect`/`unknown`) is what a human acts on, and a null detail is a
 * fine answer.
 */
export const OAUTH_ERROR_DETAIL_CODES: ReadonlySet<string> = new Set(["OAUTH_INVALID_GRANT"]);

/**
 * The organizer's own refusal to dial a host, safe to STORE for the reason
 * {@link OAUTH_ERROR_DETAIL_CODES} is: it is a constant this codebase chose, not a server-supplied
 * atom, so echoing it to the account owner lets nobody else pick the words. The `error_code` beside
 * it is `connect` — the failure IS a connect-time one — and this detail is what tells a reader
 * which connect failure it was: a mail server whose address now points somewhere this deployment
 * will not connect to, rather than one that is merely down.
 */
export const DIAL_REFUSAL_DETAIL_CODES: ReadonlySet<string> = new Set(["MAILBOX_HOST_REFUSED"]);

/**
 * Timeouts — Node's errnos AND the ones the INSTALLED IMAP client actually emits. The four imapflow
 * codes were missing, and their absence was not theoretical: `imapflow@1.5.0` sets `err.code` to
 * `CONNECT_TIMEOUT`, `GREETING_TIMEOUT`, `UPGRADE_TIMEOUT` and `ETIMEOUT` — between them EVERY way a
 * provider that accepts the TCP connection and then stops answering is reported. All four were
 * classified `unknown` (or `sync`), so the single most common shape of a flaky provider was
 * indistinguishable from "we have no idea", and the UI could not say "the server did not answer in
 * time" about the failure it says most.
 */
export const TIMEOUT_ERRNOS: ReadonlySet<string> = new Set([
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "57014",   // 57014 = query_canceled, i.e. our own statement_timeout
  // imapflow@1.5.0's own timeout constants — see the note above.
  "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ETIMEOUT",
]);

/**
 * SQLSTATEs that mean OUR storage failed, not the customer's mailbox.
 *
 * This is the class that produced the outage this slice comes from: Postgres answered
 * `53100 disk_full`, every ingest threw, and each mailbox in turn hit `maxSyncFailures` and was
 * quarantined — so the database being full was rendered to the user as "your mailbox is
 * broken". A distinct code is what lets the UI say the true thing instead.
 */
export const STORAGE_SQLSTATES: ReadonlySet<string> = new Set([
  "53100",  // disk_full
  "53200",  // out_of_memory
  "54000",  // program_limit_exceeded (a row that cannot be stored at all)
  "22001",  // string_data_right_truncation
  "23514",  // check_violation — `message_bodies_html_cap` is the one that fires here
]);

/** The OpenSSL / Node verification constants imapflow surfaces verbatim. */
export const CERT_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "EPROTO",
]);

/** Bound on `mailboxes.error_detail`. Every allowlist member below is far shorter. */
export const MAILBOX_ERROR_DETAIL_MAX = 200;

/* The closed allowlist. This replaced a SHAPE test
   (`/^[A-Z][A-Z0-9_-]{0,63}$|^[0-9A-Z]{5}$/`), and the difference is the whole finding. A shape test
   asks "does this look like a response code"; it never asks WHO CHOSE IT. imapflow derives
   `err.serverResponseCode` by uppercasing the first bracket atom of the server's own reply, so a
   hostile endpoint answering `* NO [SECRETPASSWORD123] authentication failed` hands us
   `serverResponseCode = "SECRETPASSWORD123"` — it passed the regex, and landed in a column the account
   owner reads in Settings and the admin console reads as `lastError`: an account-isolation breach
   chosen by an attacker who controls a mail server. Membership is the fix, because membership cannot
   be forged — a token is storable only if it is a name WE already knew; anything else is NULL. */

/**
 * IMAP response codes: RFC 3501 §7.1, RFC 5530 (the enhanced set), and the extension codes a
 * CONDSTORE/QRESYNC/quota-aware client can actually be handed.
 *
 * Nothing here is free-text. Each is a protocol constant, so echoing one back to the mailbox
 * owner tells them what the server said WITHOUT letting the server choose the words.
 */
const IMAP_RESPONSE_CODES: readonly string[] = [
  // RFC 3501 §7.1
  "ALERT", "BADCHARSET", "CAPABILITY", "PARSE", "PERMANENTFLAGS", "READ-ONLY", "READ-WRITE",
  "TRYCREATE", "UIDNEXT", "UIDVALIDITY", "UNSEEN",
  // RFC 5530 — the ones that make a failure legible
  "UNAVAILABLE", "AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED", "PRIVACYREQUIRED",
  "CONTACTADMIN", "NOPERM", "INUSE", "EXPUNGEISSUED", "CORRUPTION", "SERVERBUG", "CLIENTBUG",
  "CANNOT", "LIMIT", "OVERQUOTA", "ALREADYEXISTS", "NONEXISTENT",
  // Extensions this client speaks or can be answered with
  "UIDNOTSTICKY", "APPENDUID", "COPYUID",                    // RFC 4315
  "CLOSED", "MODIFIED", "NOMODSEQ", "HIGHESTMODSEQ",         // RFC 7162 (CONDSTORE/QRESYNC)
  "COMPRESSIONACTIVE",                                       // RFC 4978
  "USEATTR", "HASCHILDREN",                                  // RFC 6154 / RFC 5258
  "METADATA", "TOOMANY", "LONGENTRIES", "MAXSIZE", "NOPRIVATE", // RFC 5464
  "UNKNOWN-CTE", "TOOBIG", "REFERRAL", "NOTSAVED",           // RFC 3516 / 4469 / 2193 / 5182
  "NOTIFICATIONOVERFLOW", "BADEVENT",                        // RFC 5465
  "MAILBOXID",                                               // RFC 8474
  "WEBALERT",                                                // Gmail; the atom only, never its URL
];

/**
 * imapflow@1.5.0's OWN `err.code` constants, read out of the installed package rather than
 * remembered. Grepped from `lib/imap-flow.js`; the timeout four also live in
 * {@link TIMEOUT_ERRNOS} because they carry a classification as well as a detail.
 */
const IMAPFLOW_CODES: readonly string[] = [
  "NoConnection", "StateLogout", "EConnectionClosed", "ClosedAfterConnectTLS",
  "ClosedAfterConnectText", "InvalidResponse", "ETHROTTLE", "LockTimeout", "ProxyError",
  "STARTTLS_INJECTION",
];

/**
 * TLS/OpenSSL constants, ENUMERATED rather than prefix-matched.
 *
 * {@link isTlsCode} still uses `startsWith("ERR_TLS_")` for CLASSIFICATION, and that is fine —
 * its output is a seven-value enum. Storage may not use a prefix rule: a prefix is a shape, and
 * a shape is what the forged-token finding walked through. An OpenSSL constant we did not list stores NULL and still
 * reports `error_code: "tls"`.
 */
const TLS_DETAIL_CODES: readonly string[] = [
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_HANDSHAKE_TIMEOUT", "ERR_TLS_INVALID_PROTOCOL_VERSION",
  "ERR_TLS_PROTOCOL_VERSION_CONFLICT", "ERR_TLS_REQUIRED_SERVER_NAME", "ERR_TLS_SNI_FROM_IP",
  "ERR_TLS_DH_PARAM_SIZE", "ERR_TLS_RENEGOTIATION_DISABLED", "ERR_TLS_INVALID_CONTEXT",
  "ERR_TLS_INVALID_STATE", "ERR_TLS_SESSION_ATTACK",
  "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_UNEXPECTED_MESSAGE", "ERR_SSL_NO_PROTOCOLS_AVAILABLE",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED", "ERR_SSL_UNSUPPORTED_PROTOCOL", "ERR_SSL_BAD_LENGTH",
];

/** Node errnos that are not connect/timeout but still name a real, non-secret condition. */
const NODE_ERRNOS: readonly string[] = [
  "EACCES", "EPERM", "EADDRINUSE", "ECONNABORTED", "EMFILE", "ENFILE", "ENOMEM", "ENOSPC",
  "EIO", "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CLOSED", "ABORT_ERR",
];

/**
 * SQLSTATEs. OUR storage's vocabulary, not the customer's mailbox — and the reason the old
 * `^[0-9A-Z]{5}$` alternative existed at all. Enumerated for the same reason as the TLS set:
 * five uppercase characters is a shape, and `53100` is a fact.
 */
export const SQLSTATE_DETAILS: readonly string[] = [
  "53100", "53200", "54000", "22001", "23514",   // the storage set, verbatim
  "23503", "23505", "22P02", "42P01", "42703",   // FK / unique / bad text / missing relation or column
  "40001", "40P01", "57014", "57P01", "57P03",   // serialization, deadlock, cancel, admin shutdown, starting up
  "08000", "08003", "08006", "08P01", "53300",   // connection family + too_many_connections
];

/**
 * THE ONLY VALUES `mailboxes.error_detail` MAY HOLD. Closed, by membership.
 *
 * Frozen at module load from the sets the classifier already keeps, so the taxonomy and the
 * storage rule cannot drift apart: adding an errno to {@link CONNECT_ERRNOS} makes it storable
 * in the same commit, and nothing becomes storable without appearing in one of these lists.
 */
export const MAILBOX_ERROR_DETAIL_TOKENS: ReadonlySet<string> = new Set<string>([
  ...IMAP_RESPONSE_CODES,
  ...IMAPFLOW_CODES,
  ...TLS_DETAIL_CODES,
  ...NODE_ERRNOS,
  ...SQLSTATE_DETAILS,
  ...CONNECT_ERRNOS,
  ...TIMEOUT_ERRNOS,
  ...STORAGE_SQLSTATES,
  ...CERT_CODES,
  // The reclassification's two sets. Every member is ALREADY reachable through the two lists above them
  // — that is the finding, not an oversight: the tokens were storable while being unclassifiable
  // — so these two spreads widen nothing. They are here so the sentence above stays literally
  // true rather than true by coincidence, and so the next classifier set is added the same way.
  ...SERVER_UNAVAILABLE_CODES,
  ...SERVER_UNAVAILABLE_RESPONSE_CODES,
  // OAuth's one storable detail. Added WITH the classifier arm that emits it (see
  // classifyMailboxError's OAUTH_INVALID_GRANT → 'auth'), so the taxonomy and the storage rule stay
  // in step — the same discipline every set above this line follows.
  ...OAUTH_ERROR_DETAIL_CODES,
  // The dial guard's one storable detail, added WITH the classifier arm that emits it (see
  // classifyMailboxError's MAILBOX_HOST_REFUSED -> 'connect'), on the same discipline.
  ...DIAL_REFUSAL_DETAIL_CODES,
]);

/**
 * Is this a value `mailboxes.error_detail` is allowed to hold?
 *
 * Exported because it is the guard at BOTH ends of the pipe: {@link mailboxErrorDetail} builds
 * with it, and {@link markMailboxFailed} re-checks with it at the write site — so "the single
 * safe write site" is enforced rather than merely conventional. A caller that hands
 * `{ detail: err.message }` typechecks (the parameter is a `string | null`) and stores NULL.
 */
export function isSafeMailboxErrorDetail(value: unknown): value is string {
  return typeof value === "string" && MAILBOX_ERROR_DETAIL_TOKENS.has(value);
}
