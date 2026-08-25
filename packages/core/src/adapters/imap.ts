import { randomUUID } from "node:crypto";
import {
  ImapFlow, type ImapFlowOptions, type ListResponse, type MailboxObject, type StatusObject,
} from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
// The connection class `SMTPTransport.verify()` drives internally. Imported directly for the one
// thing `verify()` cannot do — see {@link verifySmtpLogin}.
import SMTPConnection from "nodemailer/lib/smtp-connection/index.js";
// The XOAUTH2 authenticator `SMTPConnection.login` requires for a bearer-token AUTH. Imported
// directly for the same reason as the connection class above: `SMTPTransport` builds one internally
// and exports no handle on it. See {@link loginAuth}.
import XOAuth2 from "nodemailer/lib/xoauth2/index.js";
// `../mail.js`, not `../index.js`: the IMAP adapter needs the mail half only, and the default
// barrel would pull the classifier and drafter prompts into every artifact that opens a mailbox.
import {
  messageFingerprint, normalizeMessageId, normalizeMime,
  type Change, type NativeLocator, type AdapterPort,
  // The folder-scan port this class also satisfies. It arrives from the same mail-half entry as
  // the other two ports, which is the point of moving it there: the adapter states what it
  // offers without naming the migration that consumes it.
  type FolderScanner,
} from "../mail.js";
import {
  WATCHED_FOLDERS, OHMAIL_FOLDERS, DEFAULT_NET_TIMEOUTS, DEFAULT_SENT_SCAN_MESSAGES,
  DEFAULT_SENT_HISTORY_MESSAGES,
  DEFAULT_SYNC_BATCH_MAX_MESSAGES, DEFAULT_SYNC_BATCH_MAX_BYTES, DEFAULT_SYNC_BATCH_MAX_FLAGS,
  DEFAULT_PASSIVE_FOLDERS_MAX, PASSIVE_FOLDERS_MAX_NO_STATUS, passiveFolderExclusion,
  imapTlsFloor, smtpTlsFloor,
  type ImapConfig, type ImapAdapterOpts, type ImapCapabilities, type MailboxAdapter,
  type ImapCursor, type ChangeBatch, type PersistedFolderCursor, type FolderCursor,
  type KnownEntry,
  type OutboundMessage, type SendResult, type FetchedPart, type FetchPartOptions,
  type FetchRawOptions, type NetTimeouts, type FetchByUidOptions, type TargetedFetch,
  type ImapAuth, type ImapOAuthAuth, type ResolvedImapAuth,
  FILING_BATCH_MAX, type MoveManyResult,
  JUNK_BY_NAME, TRASH_BY_NAME, type SpecialFolders,
} from "./imap-types.js";
import {
  makeLeaseIo, makeLeasePeekIo,
  type LeaseImapClient, type LeaseIo, type LeasePeekIo,
} from "./organizer-lease.js";
import { makeProfileIo, type ProfileImapClient, type ProfileIo } from "./organizer-profile.js";

// Re-export the adapter types + folder constants so consumers can import them from this entrypoint.
export * from "./imap-types.js";
// The shared credential→auth builder lives beside the adapter and is reached through the same
// entrypoint every dialer already imports, so no site has to reinvent the `authType` branch.
export * from "./imap-auth.js";

/** ref === `${uidvalidity}:${uid}` */
export function makeRef(uidValidity: bigint | number | string, uid: number): string { return `${uidValidity}:${uid}`; }
export function parseRef(ref: string): { uidValidity: string; uid: number } {
  const [v, u] = ref.split(":");
  return { uidValidity: v ?? "0", uid: Number(u) };
}

/**
 * The Junk window's page bound — newest 50 headers per read.
 * {@link ImapAdapter.listFolderPage} clamps every caller to it, so a Junk folder holding years
 * of mail still answers one bounded page whatever a request asks for.
 */
export const FOLDER_PAGE_MAX = 50;

/** One header row of a {@link ImapAdapter.listFolderPage} answer. Facts only, never a `Change`. */
export interface FolderPageItem {
  uid: number;
  /** The message's SEQUENCE number at read time — the pagination watermark, epoch-scoped. */
  seq: number;
  subject: string;
  from: { name: string | null; address: string };
  /** Sender's Date header, INTERNALDATE as the fallback; `null` when neither parses. */
  date: string | null;
  messageIdHeader: string | null;
  seen: boolean;
}

/** A bounded, newest-first header page of one folder. See {@link ImapAdapter.listFolderPage}. */
export interface FolderPage {
  /** The folder's UIDVALIDITY at read time — a caller's cursor is void when this changes. */
  uidValidity: string;
  /** How many messages the folder holds in total (the page is at most {@link FOLDER_PAGE_MAX}). */
  total: number;
  items: FolderPageItem[];
  /**
   * Pass back as `beforeSeq` (with this answer's `uidValidity` as `expectUidValidity`) for the
   * next-older page; `null` when this page reached the folder's oldest message.
   */
  nextBeforeSeq: number | null;
}

/**
 * The slice of imapflow's `StatusObject` the passive skip reads — see
 * {@link ImapAdapter.unchangedPassive}. Named locally so a test fake can supply three numbers
 * without constructing the library's whole response shape.
 */
type FolderStatus = Pick<StatusObject, "messages" | "uidNext" | "highestModseq">;

/** Sent-folder names, for servers that do not advertise SPECIAL-USE. Canonical paths only. */
const SENT_BY_NAME = /^(inbox\/)?sent( items| messages| mail)?$/i;

const toMs = (d: unknown): number | null => {
  if (d == null) return null;
  const ms = d instanceof Date ? d.getTime() : new Date(d as string).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * HOW OLD IS THIS MESSAGE — the one number the backfill orders by.
 *
 * ── WHY NOT JUST INTERNALDATE ───────────────────────────────────────────────────────────
 *
 * INTERNALDATE is when THIS server took delivery, which is the honest answer right up until
 * somebody migrates a mailbox. A migration tool that APPENDs without supplying an
 * internaldate leaves every message stamped with the import time, and an ordering key that is
 * constant across the whole mailbox orders nothing — the backfill would fall straight back to
 * UID order, which is the defect. That is not a rare shape: it is what an imported mailbox
 * IS, and an imported mailbox is exactly the one whose UIDs are not chronological.
 *
 * ── WHY NOT JUST THE `Date:` HEADER ─────────────────────────────────────────────────────
 *
 * It is the field the client sorts by (`byDateDesc` in `client-engine/src/selectors.ts`) and
 * the field `messages.date` stores, so ordering ingest by it makes "what arrives first" and
 * "what the user sees at the top" the same question. But it is written by the SENDER. Trusting
 * it alone hands the head of every backfill pass to whoever stamps `Date: 2099` — a fresh
 * account's first impression becomes two hundred pieces of spam, in the order the spammer
 * chose.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────
 *
 * A message cannot be newer than the moment the server received it. So: the sender's date when
 * it is EARLIER than the server's, otherwise the server's. The migrated mailbox is ordered by
 * its real dates (all of them below the import time); a forged future date is clamped back to
 * its actual arrival and wins nothing; a message with no `Date:` at all falls through to
 * INTERNALDATE. Neither field present sorts as 0 — oldest, drained last, never a throw.
 */
export function arrivalKey(internalDate: unknown, headerDate: unknown): number {
  const internal = toMs(internalDate);
  const header = toMs(headerDate);
  if (internal === null) return header ?? 0;
  if (header === null) return internal;
  return header < internal ? header : internal;
}

/**
 * The backfill's selection order: newest arrival first, UID descending to break ties.
 *
 * Pure, and exported, so the rule can be tested without a server — the greenmail tests prove
 * the adapter ASKS for the right fields, this proves what it does with the answers.
 *
 * THE TIEBREAK IS NOT COSMETIC. On a server whose dates are second-granular, and on the
 * flattened migration described in {@link arrivalKey} where every key is identical, this is the
 * ONLY discriminator left — and falling back to UID descending is precisely the behaviour this
 * function replaced. So the worst case of this change is the behaviour before it, which is
 * what makes it safe to ship: there is no mailbox it can order worse than it already was.
 */
export function orderCandidates(uids: readonly number[], dates: ReadonlyMap<number, number>): number[] {
  return [...uids].sort((a, b) => (dates.get(b) ?? 0) - (dates.get(a) ?? 0) || b - a);
}

/**
 * THE COMPLETE `ImapFlow` OPTION SET FOR A CONFIG — the whole thing, not just the TLS part.
 *
 * ONE place where a `secure: false` from the onboarding request body becomes a socket, and
 * it cannot be reached without the TLS floor: {@link imapTlsFloor} is spread in here, not at
 * the call site. `connect()` is a single `new ImapFlow(imapFlowOptions(...))`, which is a
 * regression the guard can see — reverting it to an inline option literal is caught by the
 * TLS-floor guard, which fails with a server transcript containing the plaintext password.
 *
 * Exported for two reasons and both are real: the guards assert the whole assembled set
 * (not only the slice), and `packages/services` owes an onboarding-time refusal that should
 * reject a configuration the adapter would refuse anyway, rather than re-deriving the rule.
 */
export function imapFlowOptions(
  config: Omit<ImapConfig, "auth"> & { auth: ResolvedImapAuth },
  opts: Pick<ImapAdapterOpts, "logger"> = {},
): ImapFlowOptions {
  const t: NetTimeouts = { ...DEFAULT_NET_TIMEOUTS, ...(config.timeouts ?? {}) };
  return {
    // `config.auth` is the RESOLVED wire form: `{ user, pass }` or `{ user, accessToken }`. This
    // function stays pure/sync — the OAuth CALLBACK is awaited by `connect()` BEFORE it reaches here,
    // so the TLS-floor guards can keep asserting the whole assembled option set. imapflow reads
    // `auth.accessToken` and issues XOAUTH2 with no password on the wire.
    host: config.host, port: config.port,
    ...imapTlsFloor(config.host, config.secure, config.allowInsecure === true).options,
    auth: config.auth, qresync: true, logger: opts.logger ? undefined : false,
    connectionTimeout: t.connectionMs, greetingTimeout: t.greetingMs, socketTimeout: t.socketMs,
  };
}

/** Is this the OAuth2 (callback-carrying) auth member? */
export function isOAuthAuth(auth: ImapAuth): auth is ImapOAuthAuth {
  return "fetchAccessToken" in auth;
}

/**
 * Await the OAuth callback into a literal token, or pass a password through untouched.
 *
 * This is the ONE await between a stored config and a socket. A password config returns byte-for-byte
 * what it was handed — the union defaults to the historical path with nothing added — so an existing
 * mailbox reaches `imapFlowOptions` exactly as before. An OAuth config resolves a FRESH token on every
 * call, which is what makes a re-dial after a dead socket pick up a new token with no reconnect
 * machinery of its own.
 */
export async function resolveImapAuth(auth: ImapAuth): Promise<ResolvedImapAuth> {
  if (isOAuthAuth(auth)) {
    return { user: auth.user, accessToken: await auth.fetchAccessToken() };
  }
  return auth;
}

/** The complete nodemailer transport option set for a config's SMTP block. See {@link imapFlowOptions}. */
export function smtpTransportOptions(config: ImapConfig): SMTPTransport.Options {
  const smtp = config.smtp;
  if (!smtp) throw new Error("smtpTransportOptions(): ImapConfig.smtp is not configured");
  const t: NetTimeouts = { ...DEFAULT_NET_TIMEOUTS, ...(config.timeouts ?? {}) };
  return {
    host: smtp.host, port: smtp.port,
    ...smtpTlsFloor(smtp.host, smtp.secure).options,
    auth: smtp.auth,
    connectionTimeout: t.connectionMs, greetingTimeout: t.greetingMs, socketTimeout: t.socketMs,
  };
}

/**
 * WHAT A COMPLETED SMTP LOGIN PROVED — beyond the fact that it completed.
 *
 * One field today: the server's own `SIZE` announcement from the EHLO it just ran. `null` is
 * "the server said nothing we can use", and it covers three genuinely different servers —
 * one that never advertised `SIZE`, one that advertised the bare keyword with no number, and
 * one that advertised `SIZE 0`, which RFC 1870 §6 defines as "no fixed maximum". All three are
 * the same answer to the only question a caller asks (*"is there a ceiling I must stay under?"*),
 * and collapsing them here is what stops a caller inventing `0` as a ceiling nothing can clear.
 */
export interface SmtpLoginProof {
  /** The advertised `SIZE` ceiling in bytes, or `null` when the server declared none. */
  maxMessageBytes: number | null;
}

/**
 * Dial an SMTP submission endpoint and AUTHENTICATE, without sending anything — the connect-time
 * proof the SMTP probe needs, kept here because this package owns nodemailer and the TLS floor.
 * It runs the full sequence (connect, EHLO, mandatory STARTTLS where `secure` is false, AUTH)
 * against the complete option set from {@link smtpTransportOptions}, so what it proves is
 * byte-identical to what a later send will do. Resolves on a completed login; throws nodemailer's
 * error otherwise. The caller classifies; nothing here logs — the config carries a password.
 *
 * ── WHY THIS DRIVES `SMTPConnection` RATHER THAN CALLING `transporter.verify()` ────────────
 *
 * The sequence below is `SMTPTransport.verify()`'s, arm for arm: connect, then `login` only when
 * the server advertised AUTH (`allowsAuth`) or the options force it, then QUIT; an `error`
 * closes and rejects, an `end` before either outcome rejects with nodemailer's own
 * "Connection closed". It is transcribed rather than delegated for one reason: the EHLO response
 * carries the server's `SIZE` limit, nodemailer parses it into `_maxAllowedSize` on the
 * connection — and `verify()` builds that connection in a local, closes it, and resolves `true`.
 * There is no supported handle on it, so the number is unreachable through that call.
 *
 * The option set is still the one `smtpTransportOptions` assembles, unchanged, which is what
 * keeps the TLS floor on this path: `SMTPTransport` passes its options straight to
 * `new SMTPConnection(options)`, so `requireTLS`, `opportunisticTLS: false` and the certificate
 * floor govern this dial exactly as they governed `verify()`'s.
 *
 * `_maxAllowedSize` IS PRIVATE, and the read is written to survive its disappearance: anything
 * that is not a positive number reads as `null` — "no ceiling was learned" — which is the same
 * answer a server that advertises nothing gives, and is the safe direction for every caller
 * (`SEND_ATTACHMENT_MAX_TOTAL_BYTES` in `packages/services` treats an unknown ceiling as the
 * strict one, never as an unbounded one).
 */
/**
 * ══ WHETHER TO ASK A SUBMISSION SERVER FOR ITS `SIZE` AT ALL ══════════════════════════════════
 *
 * `mailboxes.smtp_max_size_bytes` is the RFC 1870 `SIZE` a submission server announced, and once
 * attachment bytes stop riding the send request it is the only ceiling left on one. It is written
 * when a mailbox is created with an SMTP block and when a PATCH re-dials SMTP — which means the
 * person re-entering their password — so a mailbox that predates the column announces nothing for
 * ever, and an unannounced ceiling is deliberately read as the strict product constant rather than
 * as "no limit".
 *
 * This is the decision half of the back-fill that closes that: given what the row already says and
 * what credentials exist, should a dial happen, and what should be recorded. It lives beside
 * {@link verifySmtpLogin} because that is the call it is deciding about, and it is HOST-AGNOSTIC on
 * purpose — the same rule is wanted from a long-running sync process and from a scheduled pass on a
 * serverless host, and those two disagree about timeouts and about which of them can even reach a
 * submission port. Neither difference belongs in the rule.
 *
 * ── THE FOUR BOUNDS, EACH OF WHICH HAS A REASON ─────────────────────────────────────────────
 *
 *  · ONE DIAL PER MAILBOX PER PROCESS. `attempted` is marked BEFORE the dial, so a failure counts
 *    as an attempt. A caller that re-enters this path per pass — a roster that re-attaches a
 *    flapping mailbox, a cron that runs every few minutes — would otherwise log in to somebody's
 *    provider over and over, which is how a provider decides to throttle a customer.
 *  · AN OAUTH TRANSPORT IS DIALLED WITH A TOKEN, NEVER WITH THE STORED SECRET. For such a row the
 *    secret at rest is a REFRESH TOKEN, and {@link buildImapAuth} therefore yields a freshness
 *    callback rather than a password. This rule awaits THAT callback — the same one
 *    `ImapAdapter.send` awaits per message — and dials XOAUTH2 with the resulting access token, so
 *    the probe authenticates the way the send authenticates and the refresh token never reaches a
 *    password seat. No token means no dial: a closed `token_unavailable`, and the mailbox keeps the
 *    strict fallback until the next pass.
 *
 *    This bullet used to say the opposite — an oauth transport was SKIPPED — and the cost was
 *    invisible rather than dramatic: such a mailbox could never learn its ceiling from any host, so
 *    it stayed pinned to the product constant no matter how generous its provider was.
 *  · NEVER THROWS, AND NEVER REPEATS THE SERVER'S WORDS. A submission server that refuses a login
 *    must cost this mailbox its ceiling and nothing else — on a sync host an exception here would
 *    abort an attach, which means a mailbox stops receiving mail over an attachment limit. The
 *    failure is reported as a closed code rather than as a message, because the message is written
 *    by a third party and callers log it: see {@link SmtpSizeFailure}.
 *  · SILENCE IS NOT A CEILING. No `SIZE`, a bare `SIZE` keyword, and `SIZE 0` (RFC 1870 §6, "no
 *    fixed maximum") all resolve to `null` and record NOTHING, leaving the strict fallback in
 *    place. A stored `0` would be a ceiling no message can clear.
 */

/**
 * THE AUTHENTICATION A PROBE DIAL PRESENTS — a static password, or a bearer access token.
 *
 * Two members because a submission server can be reached two ways and BOTH are the send path's:
 * `{ user, pass }` is AUTH PLAIN/LOGIN, `{ user, accessToken }` is AUTH XOAUTH2. They are a union
 * rather than one optional-field shape so that no site can hand a token to the password seat by
 * forgetting a branch — the mistake this whole family of types exists to make unrepresentable.
 *
 * The oauth member carries a TOKEN and never a refresh token: the refresh token stays behind
 * {@link ImapOAuthAuth.fetchAccessToken}, which {@link learnSmtpMaxSize} awaits, exactly as
 * `ImapAdapter.send` awaits it per message.
 */
export type SmtpSizeDialAuth =
  | { user: string; pass: string }
  | { user: string; accessToken: string };

/** The dial this decision may perform, injectable so the rule is testable without a server. */
export type SmtpSizeDial = (smtp: {
  host: string;
  port: number;
  secure: boolean;
  auth: SmtpSizeDialAuth;
}) => Promise<SmtpLoginProof>;

export type SmtpSizeOutcome =
  /** The column already holds an announcement. No dial was made. */
  | { outcome: "known"; maxMessageBytes: number }
  /** Nothing to dial with, or nothing to learn. No dial was made. */
  | { outcome: "skipped"; reason: "no_smtp_credentials" | "already_attempted" }
  /** Dialled, and the server announced a usable ceiling. The caller records it. */
  | { outcome: "learned"; maxMessageBytes: number }
  /** Dialled, and the server announced nothing usable. Nothing to record. */
  | { outcome: "silent" }
  /** The dial failed. Reported, never thrown — as a CLOSED CODE, never as the server's words. */
  | { outcome: "failed"; code: SmtpSizeFailure };

/**
 * WHY A FAILURE IS A CODE AND NOT A MESSAGE, which is a privacy boundary rather than tidiness.
 *
 * nodemailer's error text embeds the SMTP server's own response line. On an AUTH failure that
 * response is written by somebody else's server and routinely contains the username; it can contain
 * an echoed credential, and it can contain arbitrary provider-controlled text. Callers log this,
 * `reason` is an allowlisted field in the structured logger, and the value scrubber only redacts
 * strings that LABEL themselves as secrets — so a raw message here would be a path from a third
 * party's socket to a log drain. The closed set below is derived from nodemailer's own `code`,
 * never from its prose, so nothing a remote server writes can reach a log line through this.
 */
export type SmtpSizeFailure =
  /** The server refused the credentials (nodemailer `EAUTH`). */
  | "auth_refused"
  /** Never got a usable connection: timeout, DNS, refused socket. */
  | "unreachable"
  /** The connection was made and TLS would not come up on the floor this product requires. */
  | "tls_refused"
  /**
   * AN OAUTH MAILBOX, AND NO ACCESS TOKEN COULD BE OBTAINED — so no dial was made at all.
   *
   * One member for every reason, deliberately: the refresh token is dead and the mailbox needs
   * reconnecting, the token endpoint is down, this deployment has no client secret. Those are
   * genuinely different situations and telling them apart HERE would mean carrying a provider's
   * own error text one step further towards a log line, which is the boundary this whole type
   * exists to hold. The distinction is already available where it belongs — the token client
   * raises named classes (`OAuthReauthRequiredError`, `OAuthProviderUnavailableError`,
   * `OAuthConfigError`) and the sync path classifies a mailbox on them. A back-fill probe needs
   * one bit: there was no token, so there is nothing to learn today.
   */
  | "token_unavailable"
  /** Anything else. Deliberately opaque — see the note above. */
  | "unknown";

/**
 * Classify a dial failure from the ERROR'S CODE, never from its message.
 *
 * nodemailer sets `code` on the errors this path can produce (`EAUTH`, `ETIMEDOUT`,
 * `ECONNECTION`, `ESOCKET`, `EDNS`, `ETLS`). An error with no code — including the plain
 * `Connection closed` this module raises itself — is `unknown`, which is the honest answer and
 * the one that leaks nothing.
 */
export function classifySmtpSizeFailure(err: unknown): SmtpSizeFailure {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return "unknown";
  switch (code) {
    case "EAUTH": return "auth_refused";
    case "ETIMEDOUT": case "ETIMEOUT": case "ECONNECTION": case "ESOCKET": case "EDNS":
      return "unreachable";
    case "ETLS": return "tls_refused";
    default: return "unknown";
  }
}

/** The minimal shape of a decrypted SMTP credential this rule reads. */
export interface SmtpSizeCreds {
  host: string;
  port: number;
  secure: boolean;
  /** The assembled auth — `{ user, pass }` for a password row, a token callback for oauth2. */
  auth: unknown;
}

/** The static password auth, or `null` for anything else (an oauth token callback included). */
function staticSmtpAuth(smtp: SmtpSizeCreds): { user: string; pass: string } | null {
  const auth = smtp.auth as { user?: unknown; pass?: unknown } | null | undefined;
  return typeof auth?.user === "string" && typeof auth?.pass === "string"
    ? { user: auth.user, pass: auth.pass }
    : null;
}

/**
 * The OAUTH auth — a user plus the freshness callback — or `null` for anything else.
 *
 * Structural, like {@link staticSmtpAuth} beside it, because `SmtpSizeCreds.auth` is deliberately
 * `unknown`: this rule is reached from three hosts that each assemble the credential themselves,
 * and a nominal type here would only be as strong as the weakest cast on the way in. The two
 * predicates are mutually exclusive on the shapes {@link buildImapAuth} produces — a password row
 * has no `fetchAccessToken`, an oauth row has no `pass` — and the PASSWORD branch is tested first
 * at the call site, so a hypothetical object carrying both could never route a token into an AUTH
 * PLAIN. That order is the one property here worth stating: it fails towards the password the
 * caller explicitly stored, never towards a secret it did not.
 */
function oauthSmtpAuth(smtp: SmtpSizeCreds): { user: string; fetchAccessToken: () => Promise<string> } | null {
  const auth = smtp.auth as { user?: unknown; fetchAccessToken?: unknown } | null | undefined;
  return typeof auth?.user === "string" && typeof auth?.fetchAccessToken === "function"
    ? { user: auth.user, fetchAccessToken: auth.fetchAccessToken as () => Promise<string> }
    : null;
}

export async function learnSmtpMaxSize(input: {
  mailboxId: string;
  /** The stored `smtp_max_size_bytes`, or `null` when this mailbox has never announced one. */
  announced: number | null;
  /** The decrypted SMTP credential, absent when the mailbox has no `smtp` row. */
  smtp: SmtpSizeCreds | undefined;
  /** Mailbox ids this process has already tried. Mutated here — see the once-per-process bound. */
  attempted: Set<string>;
  dial: SmtpSizeDial;
}): Promise<SmtpSizeOutcome> {
  const { mailboxId, announced, smtp, attempted, dial } = input;

  // A stored announcement is the answer. Re-dialling to confirm it would spend a provider login
  // per pass to learn what the column already says.
  if (typeof announced === "number" && Number.isFinite(announced) && announced > 0) {
    return { outcome: "known", maxMessageBytes: announced };
  }
  if (attempted.has(mailboxId)) return { outcome: "skipped", reason: "already_attempted" };
  if (!smtp) return { outcome: "skipped", reason: "no_smtp_credentials" };

  // ── WHICH AUTHENTICATION THIS MAILBOX'S SEND WOULD PRESENT ─────────────────────────────────
  //
  // PASSWORD FIRST, and the order is the safety property rather than a style choice: a shape that
  // somehow carried both a password and a token callback dials the password the caller stored, and
  // can never route a secret it did not choose into an AUTH command.
  //
  // The oauth arm is the one that used to be absent, and its absence was not neutral. An oauth
  // mailbox could not be probed at all, so it kept the strict product constant for ever while its
  // provider would have accepted far more — and the arm cannot simply be "dial with the secret",
  // because for such a row the stored secret is a REFRESH TOKEN. The access token is fetched
  // through THE SAME CALLBACK THE SEND USES (`ImapAdapter.send` awaits `fetchAccessToken()` per
  // message and hands nodemailer message-level OAuth2 auth), so there is exactly one token path in
  // the product: one cache, one rotation-persist, one client resolution. A probe that minted its
  // own token would be a second one, and a second one is a second thing to get wrong.
  const auth = staticSmtpAuth(smtp);
  const oauth = auth ? null : oauthSmtpAuth(smtp);
  if (!auth && !oauth) return { outcome: "skipped", reason: "no_smtp_credentials" };

  // BEFORE the dial, so a failure counts. See the once-per-process bound in the header.
  attempted.add(mailboxId);

  try {
    // NO TOKEN, NO DIAL — and it is reported as a failure with a closed code rather than thrown.
    // `fetchAccessToken` rejects for three reasons that are all somebody else's to fix (a dead
    // refresh token, a token endpoint that will not answer, a deployment with no client secret),
    // and every one of them must cost this mailbox its ceiling and nothing else. The rejection's
    // MESSAGE is dropped here: it is the token endpoint's own words, and `SmtpSizeFailure` states
    // why third-party prose may not travel to a caller that logs.
    let dialAuth: SmtpSizeDialAuth;
    if (auth) {
      dialAuth = auth;
    } else {
      let accessToken: string;
      try {
        accessToken = await oauth!.fetchAccessToken();
      } catch {
        return { outcome: "failed", code: "token_unavailable" };
      }
      // An empty token is not a token. Presenting one would send `AUTH XOAUTH2` with an empty
      // bearer, which a provider answers with an auth failure — a misleading classification for a
      // condition that never left this process.
      if (typeof accessToken !== "string" || accessToken.trim() === "") {
        return { outcome: "failed", code: "token_unavailable" };
      }
      dialAuth = { user: oauth!.user, accessToken };
    }
    const proof = await dial({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: dialAuth });
    const bytes = proof.maxMessageBytes;
    // The same admissibility test the column's readers apply, restated rather than trusted: this
    // is the last point at which a `0` or a `NaN` could become a stored ceiling.
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
      ? { outcome: "learned", maxMessageBytes: bytes }
      : { outcome: "silent" };
  } catch (err) {
    // A CODE, never the server's words. See {@link SmtpSizeFailure}.
    return { outcome: "failed", code: classifySmtpSizeFailure(err) };
  }
}

/**
 * WHAT `SMTPConnection.login` IS HANDED — the password credentials, or an XOAUTH2 authenticator.
 *
 * `SMTPTransport` builds this object itself in `getAuth()` and never exports it; the shape below is
 * that function's `OAUTH2` branch, arm for arm (`type`, `user`, `oauth2`, `method`), for the same
 * reason {@link verifySmtpLogin} transcribes `verify()` rather than calling it: the EHLO's `SIZE`
 * only exists on a connection this module owns.
 *
 * ── WHY NODEMAILER'S OWN `XOAuth2` AND NOT A HAND-ROLLED SASL STRING ────────────────────────
 *
 * `login` does not accept a bare access token: it selects XOAUTH2 only when `_auth.oauth2` is
 * present, and then drives it through `getToken`/`buildXOAuth2Token`. Constructing that object with
 * an `accessToken` and nothing else is EXACTLY what a send does — `ImapAdapter.send` sets
 * `mail.data.auth = { type: "OAuth2", user, accessToken }` and nodemailer's `getAuth` turns it into
 * this — so the bytes on the wire here are the bytes a later send will put there.
 *
 * It also makes the retry path safe by construction. On an AUTH failure nodemailer asks the
 * authenticator for a FRESH token once (`_handleXOauth2Token(true, …)`); with no `refreshToken`,
 * `clientId` or `serviceClient` on the object, `generateToken` refuses locally and immediately —
 * no request to any token endpoint, and certainly not to the Google default `accessUrl` this class
 * carries. The refusal surfaces as nodemailer's `EAUTH`, which {@link classifySmtpSizeFailure}
 * reads as `auth_refused`: the honest answer, since the server did refuse the token we presented.
 * A refresh, if one is warranted, belongs to the token provider that owns the refresh token — not
 * to a probe holding a copy of one access token.
 */
function loginAuth(auth: SmtpSizeDialAuth): Parameters<SMTPConnection["login"]>[0] {
  if ("pass" in auth) return { user: auth.user, pass: auth.pass };
  const oauth2 = new XOAuth2({ user: auth.user, accessToken: auth.accessToken });
  return {
    type: "OAUTH2", user: auth.user, method: "XOAUTH2", oauth2,
    // `login`'s published types describe `oauth2` as XOAuth2.OPTIONS, while the runtime requires the
    // AUTHENTICATOR (it calls `oauth2.getToken`). The cast names that gap rather than working around
    // it: `getAuth` passes an instance here too.
  } as unknown as Parameters<SMTPConnection["login"]>[0];
}

export async function verifySmtpLogin(
  smtp: { host: string; port: number; secure: boolean; auth: SmtpSizeDialAuth },
  timeouts?: Partial<NetTimeouts>,
): Promise<SmtpLoginProof> {
  const password = "pass" in smtp.auth ? smtp.auth : null;
  const options = smtpTransportOptions({
    // The top-level fields are an `ImapConfig`'s IMAP half and `smtpTransportOptions` reads NONE of
    // them but `timeouts`; the submission coordinates are the `smtp` block. They are still filled
    // honestly rather than with placeholders, because a future reader will assume they are read.
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: password ?? {
      user: smtp.auth.user,
      fetchAccessToken: async (): Promise<string> => (smtp.auth as { accessToken: string }).accessToken,
    },
    // NO STATIC AUTH FOR THE OAUTH ARM, and that is `makeSendAdapter`'s shape verbatim: a bearer
    // token is not transport state, so it is presented at the AUTH step below and nowhere else.
    smtp: {
      host: smtp.host, port: smtp.port, secure: smtp.secure,
      ...(password ? { auth: password } : {}),
    },
    ...(timeouts ? { timeouts } : {}),
  });
  const connection = new SMTPConnection(options as ConstructorParameters<typeof SMTPConnection>[0]);
  return new Promise<SmtpLoginProof>((resolve, reject) => {
    let returned = false;
    const settleErr = (err: Error): void => {
      if (returned) return;
      returned = true;
      connection.close();
      reject(err);
    };
    const settleOk = (): void => {
      if (returned) return;
      returned = true;
      // Read BEFORE `quit()`: the connection is torn down asynchronously and this is the one
      // instant at which both "the login completed" and "the EHLO is still on the object" hold.
      const raw = (connection as unknown as { _maxAllowedSize?: unknown })._maxAllowedSize;
      const maxMessageBytes = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
      connection.quit();
      resolve({ maxMessageBytes });
    };
    connection.once("error", settleErr);
    connection.once("end", () => settleErr(new Error("Connection closed")));
    connection.connect(() => {
      if (returned) return;
      // `allowsAuth` is nodemailer's own "the server advertised AUTH". A server that offers none
      // is verified by having connected, exactly as `verify()` treats it — logging in anyway
      // would refuse a submission endpoint that works.
      const allowsAuth = (connection as unknown as { allowsAuth?: boolean }).allowsAuth !== false;
      if (!allowsAuth) return settleOk();
      connection.login(loginAuth(smtp.auth), (err) => {
        if (err) return settleErr(err);
        settleOk();
      });
    });
  });
}

/**
 * THE CONNECTION ENDED — imapflow's `close` event, as something a caller can act on.
 *
 * A synthesised class rather than the raw event (which carries no argument at all) and rather than
 * imapflow's own `NoConnection` (which is what the NEXT command throws, from a caller's stack, and
 * has a sibling `EConnectionClosed` at `imap-flow.js:635-638` — so keying policy on either string
 * is keying on a driver's internals).
 *
 * `name` and `code` are the whole payload on purpose: `packages/core/src/log.ts` reduces any `err`
 * field to exactly those two through two grammars and discards the message, so a line reading
 * `errorClass="ImapConnectionClosedError" errorCode="EIMAPCLOSED"` is the complete, greppable
 * record — and it is DISTINGUISHABLE from the `errorClass="Error" errorCode="ETIMEOUT"` a genuine
 * socket failure produces, which matters because the two have different root causes and only one of
 * them was visible before the `close` listener below existed.
 */
export class ImapConnectionClosedError extends Error {
  readonly code = "EIMAPCLOSED";
  constructor() {
    super("the IMAP connection closed");
    this.name = "ImapConnectionClosedError";
  }
}

export class MessageGoneError extends Error {
  constructor(public locator: NativeLocator) { super(`message not at source locator ${locator.folder}#${locator.ref}`); }
}

/**
 * A part exceeded the byte ceiling {@link ImapAdapter.fetchPart} was given, and the download was
 * ABANDONED mid-stream rather than buffered to the end.
 *
 * `bytesSoFar` is what had accumulated when the ceiling tripped — deliberately NOT the part's real
 * size, which is exactly the number nobody has, because the whole point is that we stopped reading.
 * Callers wanting a number to show the user should use the stored metadata size, not this.
 *
 * ## THE CONNECTION IS DEAD AFTER THIS ERROR
 *
 * Abandoning `dl.content` leaves imapflow's parser mid-literal: the server is still writing the
 * remaining octets of a FETCH response nobody is draining, so the next command on this socket reads
 * that tail as its own reply. A caller MUST close the adapter rather than reuse it. That is why
 * `AttachmentsService.fetchBytes` may pass a ceiling — it owns a per-request connection it closes in
 * a `finally` — and why `downloadAll` must NOT, since it reuses one connection across every part of
 * a mailbox group and an abort would desync each remaining fetch in that group.
 */
export class AttachmentTooLargeError extends Error {
  readonly code = "EATTACHTOOLARGE";
  constructor(public locator: NativeLocator, public limitBytes: number, public bytesSoFar: number) {
    super(`attachment part at ${locator.folder}#${locator.ref} exceeds the ${limitBytes} byte ceiling`);
    this.name = "AttachmentTooLargeError";
  }
}
/**
 * A whole message exceeded the ceiling {@link ImapAdapter.fetchRaw} was given, so NOTHING was
 * returned — see {@link MailboxAdapter.fetchRaw} for why a short read is not an option here.
 *
 * `sizeBytes` is the server's own `RFC822.SIZE`, which is a real number and not a guess: the
 * ceiling is enforced by declining to keep the bytes, not by abandoning the transfer, so the
 * size is known even though the message was refused.
 *
 * THE CONNECTION IS STILL USABLE AFTER THIS ERROR, and that is the whole difference from
 * {@link AttachmentTooLargeError}. Nothing was abandoned mid-literal; the fetch loop stopped at
 * a chunk boundary with the socket idle. A caller may go straight on to the next message.
 */
export class RawMessageTooLargeError extends Error {
  readonly code = "ERAWTOOLARGE";
  constructor(public locator: NativeLocator, public limitBytes: number, public sizeBytes: number) {
    super(`message at ${locator.folder}#${locator.ref} is ${sizeBytes} bytes, over the ${limitBytes} byte ceiling`);
    this.name = "RawMessageTooLargeError";
  }
}

export class MoveVerifyError extends Error {
  constructor(public locator: NativeLocator, public toFolder: string) { super(`could not learn new UID after move ${locator.folder}#${locator.ref} → ${toFolder}`); }
}

/**
 * The default ceiling {@link ImapAdapter.fetchRaw} refuses above.
 *
 * 8 MiB, which is above every message in the corpora this has been measured on and well below
 * the size at which holding a mailbox lock becomes a sync outage. It is a per-call option
 * because the right answer depends on who owns the connection, and a default because the caller
 * that forgets to pass one must still get a bounded read.
 */
export const DEFAULT_FETCH_RAW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `internalDate` is the server's own receive time, carried through to {@link Change.internalDate}
 * so the pipeline's screening cutoff has a date the SENDER did not choose. Optional because a
 * server may answer the fetch without one; absent reaches the pipeline as absent and it falls back
 * to the header date. It is deliberately NOT folded into `arrivalKey`'s ordering value on the way
 * through — that one takes the EARLIER of the two dates, which is right for sorting and wrong for
 * deciding whether a message is genuinely old.
 */
interface InternalCreate { folder: string; uidValidity: bigint; uid: number; raw: Buffer; seen: boolean; messageId: string | null; internalDate?: Date; }
interface InternalDelete { folder: string; uidValidity: bigint; uid: number; messageId: string | null; }

/**
 * The `Message-ID` of a raw message (RFC 5322), read from the HEADER BLOCK ONLY.
 *
 * The envelope is normally where this comes from. This exists for the messages whose envelope the
 * SERVER will not produce — see the recovery fetch in {@link ImapAdapter.fetchCapped} — so it has
 * to read the same value from the bytes.
 *
 * Three details, each of which changes the answer:
 *
 *  · **The header block only.** Scanning the whole message would match a `Message-ID:` quoted
 *    inside a forwarded body or a `message/rfc822` attachment, and hand back the WRONG identity —
 *    which `correlateMoves` would then pair a delete against, reporting a move that never happened.
 *    The block ends at the first empty line (CRLF CRLF, or LF LF from a server that stores bare
 *    LF); absent one, the whole buffer IS the header block.
 *  · **Unfolded first.** RFC 5322 §2.2.3 lets a long header wrap onto continuation lines beginning
 *    with whitespace, and a wrapped `Message-ID` is what a line-anchored match would truncate.
 *  · **`latin1`, not `utf8`.** Header bytes above 0x7F are not valid UTF-8 in general (RFC 2047
 *    encodes them precisely because they are not), and decoding as UTF-8 replaces them with U+FFFD.
 *    A Message-ID is `dot-atom-text`/quoted-string — ASCII — so a byte-preserving decode is both
 *    safe here and the only one that cannot corrupt the surrounding text mid-scan.
 */
export function messageIdFromRaw(raw: Buffer): string | null {
  if (raw.length === 0) return null;
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : (lf >= 0 ? lf : raw.length);
  const head = raw.subarray(0, end).toString("latin1");
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const m = /^message-id:[ \t]*(.+)$/im.exec(unfolded);
  return m ? normalizeMessageId(m[1].trim()) : null;
}

/** Pair a vanished message with a re-appeared one sharing the same canonical Message-ID → a single MOVE. */
export function correlateMoves(creates: InternalCreate[], deletes: InternalDelete[]): {
  moves: Change[]; creates: InternalCreate[]; deletes: InternalDelete[];
} {
  const delByMsg = new Map<string, InternalDelete>();
  for (const d of deletes) if (d.messageId) delByMsg.set(d.messageId, d);
  const used = new Set<InternalDelete>();
  const moves: Change[] = [];
  const pureCreates: InternalCreate[] = [];
  for (const c of creates) {
    const d = c.messageId ? delByMsg.get(c.messageId) : undefined;
    if (d && !used.has(d)) {
      used.add(d);
      moves.push({ type: "move", locator: { folder: c.folder, ref: makeRef(c.uidValidity, c.uid) }, raw: c.raw, seen: c.seen });
    } else {
      pureCreates.push(c);
    }
  }
  const pureDeletes = deletes.filter((d) => !used.has(d));
  return { moves, creates: pureCreates, deletes: pureDeletes };
}

/**
 * Where a bounded flag drain has got to, per folder — IN MEMORY, and deliberately so.
 *
 * The creates budget resumes for free: an ingested UID joins the known-set and drops out of
 * `unknownUids`. Flags have no such property — the server re-reports the identical set for the
 * identical `changedSince`, so "take the first N and hold the cursor" would hand back the same
 * N for ever. This is the resume point that makes the bound terminate.
 *
 * It is not persisted, and that is the safe direction: the FOLDER CURSOR is held at its previous
 * modseq for the whole drain, so a process that dies mid-drain simply re-reports from the start
 * and re-applies changes that are already idempotent (`applyExternalFlag` answers
 * `changed: false`). Losing this map costs repeated work; it can never lose a flag.
 */
interface FlagDrain {
  /** The UID the next pass starts at. */
  resumeUid: number;
  /** The modseq the whole drain is reading against — held until it finishes. */
  sinceModseq: string;
  /**
   * The modseq the cursor may advance to once the drain COMPLETES, captured when it started.
   *
   * Not the modseq observed on the final pass: a flag changed on a LOW uid halfway through a
   * multi-pass drain sits below the resume point and is never read by it, so advancing past it
   * would drop that change permanently. Advancing only to where the drain began leaves it to be
   * re-reported on the next cycle.
   */
  advanceTo: string;
}

export class ImapAdapter implements MailboxAdapter, AdapterPort, FolderScanner {
  private client!: ImapFlow;
  private transporter: Transporter | null = null;
  private delimiter = "/";
  private sentFolder: string | null = null;
  /**
   * The Sent path resolved by NAME for reads, memoised — see {@link findSentForScan}.
   *
   * Separate from {@link sentFolder} because that field is where the SEND path appends, and a
   * read must never redirect it. Memoised because `changesSince` now asks every cycle
   * and the answer costs a LIST; a NEGATIVE answer is deliberately not memoised, so
   * a mailbox that grows a Sent folder later starts being watched on the next cycle instead of
   * on the next process restart.
   */
  private scanSentFolder: string | null = null;
  /**
   * {@link fetchByUid}'s OWN memo of the resolved Sent path — and unlike {@link scanSentFolder}
   * it holds a NEGATIVE answer too, behind a clock. The scan deliberately re-asks a null every
   * cycle so a mailbox that grows a Sent folder starts being watched on the next cycle; a
   * TARGETED fetch has no such discovery duty per call, and on a no-Sent server the re-ask made
   * every chunked fetch pay a full inventory LIST (review round 3 — round 2's fix covered only
   * the positive path). The TTL keeps discovery honest: a Sent folder created mid-connection
   * reaches the `ownAuthored` stamp within {@link ImapAdapter.TARGETED_SENT_TTL_MS}.
   */
  private targetedSent: { value: string | null; at: number } | null = null;
  private static readonly TARGETED_SENT_TTL_MS = 5 * 60 * 1000;
  /** {@link findSpecialFolders}' memo — positive answers only, a null is re-asked. */
  private specialJunk: string | null = null;
  private specialTrash: string | null = null;
  /**
   * The customer's OWN folders, canonical, sorted, capped — see {@link PASSIVE_EXCLUDED_SPECIAL_USE}
   * for what this set is and what it excludes.
   *
   * Derived from the LIST that `connect()` and `ensureFolders()` already issue, so discovery costs
   * NOTHING on the ordinary path: both of those call `list()` for their own reasons and this reads
   * the same response. `changesSince` refreshes it every
   * {@link ImapAdapter.PASSIVE_RELIST_CYCLES} passes, which is what makes a folder the customer
   * creates mid-connection visible without a reconnect — an iCloud connection is held for hours.
   *
   * `null` means "never computed", which is distinct from "computed and empty": a mailbox whose
   * server has no user folders answers `[]`, and only a caller that skipped `connect()` sees null.
   */
  private passiveFolders: string[] | null = null;
  /** Folders LIST offered and the passive rule declined, path → reason. Reported, never read. */
  private passiveExcluded = new Map<string, string>();
  /** Customer folders beyond {@link DEFAULT_PASSIVE_FOLDERS_MAX} — reported, never read. */
  private passiveOverflow: string[] = [];
  /** `changesSince` passes since the folder inventory was LISTed. See `PASSIVE_RELIST_CYCLES`. */
  private passiveCycle = 0;
  /** Canonical path → the STATUS the last LIST volunteered. See {@link unchangedPassive}. */
  private passiveStatus: ReadonlyMap<string, FolderStatus> = new Map();
  /** Folder → in-flight bounded flag drain. See {@link FlagDrain}. */
  private readonly flagDrain = new Map<string, FlagDrain>();
  /**
   * How many `changesSince` passes this adapter has run — the ROTATION COUNTER of the flag
   * schedule. See the scheduling block in {@link ImapAdapter.changesSince}.
   *
   * In memory, like {@link flagDrain}, and for the same reason: it decides only WHICH owing folder
   * leads a cycle, so losing it across a reconnect costs one arbitrary starting position and can
   * never cost a flag. Deliberately not persisted — a cursor column that exists only to pick a
   * queue position is a migration and a write per cycle for something a counter answers.
   */
  private flagCycle = 0;
  /**
   * Folder → the arrival dates this drain has already learned, and the EPOCH they belong to.
   * See {@link ImapAdapter.arrivalDatesFor}; the ordering rule itself is {@link arrivalKey}.
   *
   * Keyed by `uidValidity` rather than invalidated by a side effect. A UIDVALIDITY change
   * renumbers every UID, so a cache carried across one would order the post-reset refetch by
   * the dates of different messages — and the obvious hook for invalidating it, the
   * `flagDrain.delete(folder)` in `changesSince`, runs AFTER the `fetchCapped` call that would
   * already have read the stale entry. Comparing the epoch on read cannot be sequenced wrong.
   *
   * In memory only, for the reason {@link FlagDrain} is: losing it across a worker restart
   * costs one metadata refetch of the remaining unknown set and can never cost mail.
   */
  private readonly dateCache = new Map<string, { uidValidity: string; dates: Map<number, number> }>();
  /**
   * `true` once {@link connect} has fully returned — the guard on the `close` arm of
   * {@link guardAsyncErrors}.
   *
   * `guardAsyncErrors` is attached BEFORE the dial on purpose (see the note in `connect`), so
   * without this flag a connection that never came up at all would report a fault out of band
   * *in addition to* rejecting the `await connect()` its caller is already holding — one dead
   * mailbox logged as two different failures, one of them at error level with no owner. A `close`
   * before `connect()` returns belongs to the awaited path; only a `close` after it is the
   * out-of-band death this listener exists for.
   */
  private established = false;
  /**
   * `true` while a DELIBERATE teardown is in flight — one hazard the dead-connection handling closes.
   *
   * `close()` calls `logout()`, imapflow's `logout()` calls its own `close()`, and that emits
   * `close` exactly like a dead socket does. Without this flag every clean detach — a roster pass
   * dropping a disabled mailbox, a stand-down, a quarantine, `stop()` — would log
   * `mailbox_connection_error` at error level and (harmlessly, but visibly) enqueue a detach for a
   * mailbox already gone. Log noise masquerading as errors is how a real error line stops being
   * read.
   */
  private closing = false;

  constructor(private readonly config: ImapConfig, private readonly opts: ImapAdapterOpts = {}) {}

  async connect(): Promise<void> {
    // Deadlines on both transports (see `ImapConfig.timeouts`), and the TLS floor on both
    // (see `imapTlsFloor`) — every option either transport gets is assembled by the two
    // exported builders, so there is exactly one place where a `secure: false` from the
    // onboarding body turns into a socket, and it cannot be reached without the floor.
    //
    // Both connection-lifecycle flags are reset here rather than only initialised at construction,
    // so a re-dialled adapter cannot inherit the previous connection's teardown state and silently
    // swallow the new connection's death. See {@link established} and {@link closing}.
    this.established = false;
    this.closing = false;
    // FIRST, before any option is assembled: resolve the auth. For a password config this is a
    // no-op; for an OAuth config it awaits `fetchAccessToken()` into a literal token. Doing it here
    // — above the injected-client branch too — is what makes "connect() fetches a token, and a
    // re-dial fetches a FRESH one" true regardless of how the client was constructed.
    const resolvedAuth = await resolveImapAuth(this.config.auth);
    if (this.opts.client) {
      this.client = this.opts.client as ImapFlow;
      this.guardAsyncErrors();
    } else {
      this.client = new ImapFlow(imapFlowOptions({ ...this.config, auth: resolvedAuth }, { logger: this.opts.logger }));
      // BEFORE the dial, not after, and the ordering is the whole point. imapflow's own
      // `emitError` routes to `initialReject` only while the connect promise is pending; the
      // moment it resolves, every later failure is a plain `emit("error")`. `connect()` is
      // followed here by `list()`, so "after `await connect()`" already has a window in which
      // a dead socket would emit into nothing.
      this.guardAsyncErrors();
      await this.client.connect();
    }
    const list = await this.client.list();
    this.delimiter = list.find((f) => f.path.toUpperCase() === "INBOX")?.delimiter ?? list[0]?.delimiter ?? "/";
    this.sentFolder = this.findSent(list);
    // AFTER the delimiter and the Sent resolution, both of which it reads. See
    // {@link ImapAdapter.passiveFolders}: this is discovery for free, off a LIST already issued.
    this.learnPassiveFolders(list);
    if (this.config.smtp) {
      this.transporter = nodemailer.createTransport(smtpTransportOptions(this.config));
    }
    // LAST. Everything above is still owned by the promise the caller is awaiting; from here on a
    // failure has nowhere to be reported except the `close`/`error` listeners.
    this.established = true;
  }

  /**
   * THE TWO LISTENERS THAT MAKE AN ASYNCHRONOUS CONNECTION DEATH OBSERVABLE AT ALL.
   *
   * ── `error`: THE OUTAGE THAT KILLED A SHARD ─────────────────────────────────────────────
   *
   * `ImapFlow` is an EventEmitter, and Node throws when `error` is emitted with no listener —
   * an uncaught exception, which the worker's entrypoint answers with `exit(1)`. In
   * production that turned one mailbox's socket timeout into minutes with the whole
   * shard dead and the platform restarting the container over and over. Nothing in the call stack
   * could have caught it: the emit happens on a timer, not inside an `await`.
   *
   * So this is attached UNCONDITIONALLY — not only when a caller supplies
   * {@link ImapAdapterOpts.onConnectionError} — because the property being defended is "this
   * process stays alive", and that must not be contingent on a construction option somebody
   * remembered to pass. The optional callback is only how the OWNER of the connection gets
   * told, so it can detach and quarantine one mailbox instead of losing all of them.
   *
   * ── `close`: THE SECOND OUTAGE, AND WHY `error` ALONE WAS NEVER ENOUGH ──────────────────
   *
   * This method listened for `error` only, and the sentence above ("`ImapFlow` reports a dead
   * socket by emitting `error`") is true of a socket that FAILS and false of one that ENDS.
   * imapflow 1.5.0's `_socketClose` and `_socketEnd` both call `this.close()`
   * (`imapflow/lib/imap-flow.js:953-954`), and `close()` emits **`close`** (`:2204`) — never
   * `error`. The IDLE path lands in the same place: `_socketTimeout` (`:964-988`) attempts a NOOP
   * recovery and, on failure, calls `close()`, logging its warning to imapflow's internal logger,
   * which the worker disables (`logger: false`, `imapFlowOptions`).
   *
   * With nothing listening for `close`, a connection that ended was completely silent: a
   * running deployment stopped syncing for nearly an hour
   * with ZERO connection events in the log, and the runtime's own IDLE handlers
   * (`exists`/`flags`/`expunge`, registered in `watch()`) simply never fired again because the
   * emitter they were registered on was dead. Every subsequent command threw imapflow's
   * `NoConnection` from a client that still existed.
   *
   * So `close` routes to the SAME callback. Two guards keep that from being noise rather than
   * signal — {@link closing} for a teardown we asked for, {@link established} for a connection
   * that never came up — and both are documented on their fields.
   *
   * ── AND THIS IS THE FAST PATH, NOT THE ONLY PATH ─────────────────────────────────────────
   *
   * The early return below means every client with no event surface bypasses this method entirely —
   * which is every fake in the test suite. Event-driven detection alone would therefore be this
   * repository's own named failure pattern, an injected dependency whose default branch is the
   * untested one, so the worker ALSO bounds the exempt lease-unavailable arm by duration
   * (`DEFAULT_LEASE_UNAVAILABLE_DETACH_MS`) and detaches on it. This listener turns a two-minute
   * heal into a seconds-long one; it is not what makes the heal exist.
   * A test drives both arms through an injected real `EventEmitter`, because nothing in the
   * worker's own suite can reach this line.
   */
  private guardAsyncErrors(): void {
    const emitter = this.client as unknown as { on?: (ev: string, fn: (e: unknown) => void) => void };
    if (typeof emitter.on !== "function") return;   // an injected fake without an event surface
    emitter.on("error", (err: unknown) => {
      // A handler that throws inside an `error` listener is the same uncaught exception again,
      // one frame further out. There is nowhere for it to go, so it goes nowhere.
      try { this.opts.onConnectionError?.(err); } catch { /* never re-raise from here */ }
    });
    emitter.on("close", () => {
      if (this.closing || !this.established) return;
      // ONCE per connection. imapflow guards its own `close()` against re-entry, but a second
      // `close` reaching the worker would enqueue a second detach for a mailbox already gone, and
      // deduplicating it is a property of today's `handleConnectionError` rather than of
      // this adapter.
      this.established = false;
      try { this.opts.onConnectionError?.(new ImapConnectionClosedError()); } catch { /* as above */ }
    });
  }

  async close(): Promise<void> {
    // BEFORE the logout, because `logout()` itself emits `close` — see {@link closing}.
    this.closing = true;
    try { await this.client?.logout(); } catch { this.client?.close(); }
    this.transporter?.close();
    this.established = false;
  }

  /**
   * Tear the connection down NOW — no LOGOUT. imapflow serializes commands, so a graceful
   * `logout()` queues BEHIND whatever command is currently hung; a caller abandoning a
   * timed-out operation that then awaited {@link close} would wait exactly as long as the hang
   * it was escaping (the Junk window's deadline reviews caught this). `client.close()` destroys
   * the socket, which is also what actually ENDS the hung command. For deliberate teardown of a
   * healthy connection, {@link close} remains the polite path.
   */
  forceClose(): void {
    this.closing = true;
    try { this.client?.close(); } catch { /* already down */ }
    this.transporter?.close();
    this.established = false;
  }

  async capabilities(): Promise<ImapCapabilities> {
    const c = this.client.capabilities;
    const base: ImapCapabilities = {
      move: c.has("MOVE"),
      uidplus: c.has("UIDPLUS"),
      condstore: c.has("CONDSTORE"),
      qresync: c.has("QRESYNC"),
      idle: c.has("IDLE"),
      specialUse: c.has("SPECIAL-USE"),
      sentFolder: this.sentFolder,
      // The path the scan WATCHES — the name fallback where SPECIAL-USE gave nothing. See the
      // interface doc for who reads it and why `sentFolder` alone would miss those providers.
      watchedSentFolder: this.sentFolder ?? this.scanSentFolder,
    };
    return { ...base, ...this.opts.capabilityOverrides };
  }

  async ensureFolders(): Promise<void> {
    const list = await this.client.list();
    const existing = new Set(list.map((f) => f.path));
    this.sentFolder = this.findSent(list);
    this.learnPassiveFolders(list);
    for (const canonical of OHMAIL_FOLDERS) {
      const path = this.toServerPath(canonical);
      if (existing.has(path)) continue;
      try {
        await this.client.mailboxCreate(path);
      } catch (err) {
        if (!/already exists/i.test(String((err as Error).message))) throw err;
      }
    }
  }

  // ---- FolderScanner (HEY migration folder-scan, §16) ----

  /** Canonical paths of every selectable folder on the server. */
  async listFolders(): Promise<string[]> {
    const list = await this.client.list();
    return list
      .filter((f) => !(f.flags?.has("\\Noselect") ?? false))
      .map((f) => this.toCanonical(f.path));
  }

  /**
   * Sample up to `limit` DISTINCT sender addresses from a folder (newest first).
   * Read-only: opens a mailbox lock, fetches envelopes for the tail UIDs, and
   * never moves or flags anything. Returns lowercased addresses.
   */
  async sampleSenders(folder: string, limit = 50): Promise<string[]> {
    const serverPath = this.toServerPath(folder);
    let lock: { release(): void };
    try {
      lock = await this.client.getMailboxLock(serverPath);
    } catch {
      return [];   // folder not present / not selectable
    }
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      if (!mb || mb.exists === 0) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      // Newest `limit` messages by sequence number (envelope-only fetch is cheap).
      const start = Math.max(1, mb.exists - limit + 1);
      const range = `${start}:*`;
      for await (const m of this.client.fetch(range, { envelope: true })) {
        const addr = m.envelope?.from?.[0]?.address?.trim().toLowerCase();
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        out.push(addr);
        if (out.length >= limit) break;
      }
      return out;
    } finally {
      lock.release();
    }
  }

  /**
   * ONE BOUNDED HEADER PAGE of a named folder, newest first — the Junk window's list read
   * (FOLDERS-SPEC.md §16.2: the Screener's third segment is a LIVE, UN-MIRRORED view of the
   * provider's own `\Junk` folder; this method is the "list page" half of its bounded read
   * shape, {@link fetchByUid} is the body-on-open half).
   *
   * READ-ONLY BY CONSTRUCTION: one mailbox lock, one UID SEARCH, one envelope/flags FETCH —
   * envelope fetches never set `\Seen`, nothing is moved, flagged, appended or created. And it
   * WRITES NOTHING ANYWHERE ELSE either — the window's defining property is that Junk never
   * enters `messages` or any mirror, so this returns plain header facts and no `Change`s: a
   * caller cannot ingest what it answers even by mistake, because the ingest pipeline's input
   * shape is deliberately not produced.
   *
   * The page is `limit` (capped at {@link FOLDER_PAGE_MAX}) newest UIDs, optionally strictly
   * BELOW `beforeUid` — the "Show older" cursor, stable across connections because UIDs are
   * (per uidValidity, which the answer carries so a caller can spot a renumbered folder).
   * `null` for a folder the server refuses to open (not present, `\Noselect`) — the honest
   * "this mailbox has no such window" the degrade path renders, distinct from an EMPTY folder,
   * which answers a real page of zero items.
   */
  async listFolderPage(
    folder: string,
    opts: { limit?: number; beforeSeq?: number; expectUidValidity?: string } = {},
  ): Promise<FolderPage | null> {
    const limit = Math.max(1, Math.min(opts.limit ?? FOLDER_PAGE_MAX, FOLDER_PAGE_MAX));
    let lock: { release(): void };
    try {
      lock = await this.client.getMailboxLock(this.toServerPath(folder));
    } catch (err) {
      // ONLY a live connection's refusal of the SELECT means "no such window" (missing folder,
      // `\Noselect`). A transport failure — the socket died, the open timed out and killed the
      // connection — propagates, so the caller's honest states can tell "this mailbox has no
      // Junk folder" from "the mailbox could not be read just now" (the §16.2 rule; a review
      // caught the first version folding both into the first sentence, the misleading one).
      if (!(this.client as unknown as { usable?: boolean }).usable) throw err;
      return null;
    }
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      const uidValidity = mb && mb.uidValidity != null ? String(mb.uidValidity) : "0";
      const total = mb ? mb.exists : 0;
      if (!mb || total === 0) return { uidValidity, total: 0, items: [], nextBeforeSeq: null };

      /**
       * A SEQUENCE WINDOW, and no SEARCH — the whole read is bounded by `limit`, not merely the
       * response. The first version ran `SEARCH ALL` and sorted every UID in the folder, which
       * made "one bounded page" true of the answer and false of the work: a decade of junk is a
       * six-figure UID list per page. Message sequence numbers are 1..exists with no holes, so
       * the newest `limit` messages are exactly the range `exists-limit+1 : exists` — one FETCH
       * of at most `limit` envelopes, whatever the folder holds.
       *
       * The cursor is therefore a SEQ, not a UID, and it is meaningful only within one
       * UIDVALIDITY epoch and one connection's view of the folder (an expunge between pages
       * shifts numbers). `expectUidValidity` is the caller's cursor epoch: when it no longer
       * matches the folder — recreated, renumbered — the cursor is DISCARDED and this serves
       * the top page under the new epoch, which the caller detects by the changed
       * `uidValidity` in the answer. Serving `beforeSeq` against a renumbered folder would
       * silently skip everything above the stale watermark.
       */
      const paged =
        opts.expectUidValidity !== undefined && opts.expectUidValidity !== uidValidity
          ? undefined
          : opts.beforeSeq;
      const end = Math.min(paged !== undefined ? paged - 1 : total, total);
      if (end < 1) return { uidValidity, total, items: [], nextBeforeSeq: null };
      const start = Math.max(1, end - limit + 1);

      const rows: FolderPageItem[] = [];
      for await (const m of this.client.fetch(
        `${start}:${end}`, { uid: true, envelope: true, flags: true, internalDate: true },
      )) {
        const from = m.envelope?.from?.[0];
        const date = m.envelope?.date ?? m.internalDate;
        rows.push({
          uid: m.uid,
          seq: m.seq,
          subject: m.envelope?.subject ?? "",
          from: { name: from?.name ?? null, address: from?.address?.trim().toLowerCase() ?? "" },
          date: date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
          messageIdHeader: m.envelope?.messageId ?? null,
          seen: m.flags?.has("\\Seen") ?? false,
        });
      }
      // Newest first — by sequence, which IS the folder's arrival order.
      rows.sort((a, b) => b.seq - a.seq);
      return { uidValidity, total, items: rows, nextBeforeSeq: start > 1 ? start : null };
    } finally {
      lock.release();
    }
  }

  /**
   * DISTINCT recipient addresses from the newest `limit` Sent messages. See
   * {@link MailboxAdapter.scanSentRecipients} for WHY; the notes here are about the mechanics.
   *
   * Envelope-only, under one mailbox lock, and it writes nothing — not even the folder it reads.
   * `limit` bounds BOTH the messages scanned and the addresses returned, so a single mail with
   * a 4 000-address To: header cannot turn a bounded scan into an unbounded result.
   */
  async scanSentRecipients(limit = DEFAULT_SENT_SCAN_MESSAGES): Promise<string[]> {
    const folder = await this.findSentForScan();
    if (!folder) return [];
    let lock: { release(): void };
    try {
      lock = await this.client.getMailboxLock(this.toServerPath(folder));
    } catch {
      return [];   // not present / not selectable — the kickstart simply has no material
    }
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      if (!mb || mb.exists === 0) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      const start = Math.max(1, mb.exists - limit + 1);
      outer:
      for await (const m of this.client.fetch(`${start}:*`, { envelope: true })) {
        const rcpts = [...(m.envelope?.to ?? []), ...(m.envelope?.cc ?? []), ...(m.envelope?.bcc ?? [])];
        for (const r of rcpts) {
          const addr = r.address?.trim().toLowerCase();
          if (!addr || !addr.includes("@") || seen.has(addr)) continue;
          seen.add(addr);
          out.push(addr);
          if (out.length >= limit) break outer;
        }
      }
      return out;
    } finally {
      lock.release();
    }
  }

  // ---- helpers ----
  /**
   * The folder imapflow resolved as `\Sent`, canonicalized. **NOT NECESSARILY THE SERVER'S
   * SPECIAL-USE FLAG** — imapflow reads the flag when the connection advertises SPECIAL-USE
   * (RFC 6154) or XLIST, and otherwise guesses from a localized name table of its own. Both
   * callers therefore treat a hit as a strong hint and neither may treat a miss as "this
   * mailbox has no Sent folder"; see {@link resolveSentFolder} for the measurement.
   */
  private findSent(list: ListResponse[]): string | null {
    const sent = list.find((f) => (f.specialUse ?? "").toLowerCase() === "\\sent");
    return sent ? this.toCanonical(sent.path) : null;
  }

  /**
   * Learn the customer's OWN folders from a LIST response — see {@link ImapAdapter.passiveFolders}.
   *
   * Called from `connect()` and `ensureFolders()`, both of which LIST for their own reasons, and
   * from `foldersToScan` every {@link PASSIVE_RELIST_CYCLES} passes. It writes three fields and
   * issues no command of its own.
   *
   * ── THE SENT PATH IT EXCLUDES AGAINST IS THE ONE `changesSince` WILL SCAN ──────────────────
   *
   * `this.sentFolder ?? this.scanSentFolder` and not `findSent(list)`, because a server that
   * advertises no SPECIAL-USE resolves Sent BY NAME (`findSentForScan`) and only that field holds
   * the answer. Getting this wrong would put the Sent folder into the passive set as well as the
   * watched one: read twice per cycle, its creates no longer stamped `ownAuthored`, and every
   * message the customer ever wrote handed to the Screener.
   *
   * A NEGATIVE Sent answer is not yet known on the `connect()` call (the name fallback runs on the
   * first `changesSince`), so this can, on a no-SPECIAL-USE server, admit the Sent folder into the
   * passive set for exactly one pass. `foldersToScan` therefore re-filters against the resolved
   * path on every call — the field here is a candidate list, and that function is the authority.
   */
  private learnPassiveFolders(list: ListResponse[]): void {
    const sent = this.sentFolder ?? this.scanSentFolder;
    // The ceiling bounds SELECTS PER CYCLE, not folders — see {@link DEFAULT_PASSIVE_FOLDERS_MAX}.
    // With LIST-STATUS a settled folder costs nothing at all, so the number that applies is the high
    // one; without it every folder is a SELECT every cycle and the low one applies.
    const cap = (this.client.capabilities?.has?.("LIST-STATUS") ?? false)
      ? DEFAULT_PASSIVE_FOLDERS_MAX
      : PASSIVE_FOLDERS_MAX_NO_STATUS;
    const admitted: string[] = [];
    const excluded = new Map<string, string>();
    for (const entry of list) {
      const path = this.toCanonical(entry.path);
      const reason = passiveFolderExclusion(
        { path, specialUse: entry.specialUse ?? null, flags: entry.flags }, sent,
      );
      if (reason === null) admitted.push(path);
      else excluded.set(path, reason);
    }
    admitted.sort();
    this.passiveFolders = admitted.slice(0, cap);
    this.passiveOverflow = admitted.slice(cap);
    this.passiveExcluded = excluded;
    // The STATUS the server volunteered, when it was asked for one. REPLACED wholesale rather than
    // merged: a stale entry would be read as "this folder is unchanged", which is the one wrong
    // answer this map can give.
    this.passiveStatus = new Map(
      list.flatMap((e) => (e.status ? [[this.toCanonical(e.path), e.status] as const] : [])),
    );
  }

  /**
   * What the passive-folder decision did on this connection: what is read, what was declined and
   * why, and what the {@link DEFAULT_PASSIVE_FOLDERS_MAX} ceiling left out.
   *
   * For an operator answering "why is this customer's `Private/Editor` not in search". Read
   * by no product path — it exists so the ceiling and the exclusion list are observable rather than
   * inferred from a folder's absence, which is the shape this whole slice exists because of.
   */
  passiveFolderReport(): {
    read: readonly string[];
    excluded: ReadonlyMap<string, string>;
    overflow: readonly string[];
  } {
    return {
      read: this.passiveFolders ?? [],
      excluded: this.passiveExcluded,
      overflow: this.passiveOverflow,
    };
  }

  /**
   * How many `changesSince` passes may go by before the folder inventory is re-LISTed.
   *
   * A folder the customer creates in Apple Mail must become visible without waiting for a
   * reconnect, and an iCloud connection is held for hours. One LIST per 20 passes is one command
   * every ~20 minutes at the default poll interval — against the ~110 SELECTs a passive scan of a
   * large mailbox already costs, it does not register.
   */
  private static readonly PASSIVE_RELIST_CYCLES = 20;

  /**
   * The Sent folder for a READ, resolved without creating anything.
   *
   * `connect()` already sets `sentFolder` from {@link findSent}, which is what a modern provider
   * advertises. Plenty do not — GreenMail among them — so a name match is the fallback, and it
   * is deliberately NOT cached onto `this.sentFolder`: that field is what the SEND path appends
   * to, and a scan has no business redirecting where sent mail is filed. The send path runs the
   * same two lookups for itself, in {@link resolveSentFolder}.
   */
  private async findSentForScan(): Promise<string | null> {
    if (this.sentFolder) return this.sentFolder;
    if (this.scanSentFolder) return this.scanSentFolder;
    const list = await this.client.list();
    const special = this.findSent(list);
    if (special) { this.sentFolder = special; return special; }
    const byName = list.find(
      (f) => !(f.flags?.has("\\Noselect") ?? false) && SENT_BY_NAME.test(this.toCanonical(f.path)),
    );
    // Positive answers only (see {@link scanSentFolder}): a null is re-asked next cycle.
    this.scanSentFolder = byName ? this.toCanonical(byName.path) : null;
    return this.scanSentFolder;
  }

  /**
   * The provider's native `\Junk` and `\Trash`, resolved without creating anything — the
   * discovery behind the three user-commanded writes ({@link MailboxAdapter.findSpecialFolders}).
   *
   * SPECIAL-USE first, then {@link JUNK_BY_NAME}/{@link TRASH_BY_NAME} on the canonical leaf —
   * the same two-step `findSentForScan` runs, for the same measured reason: plenty of live
   * servers advertise no SPECIAL-USE (GreenMail among them), and imapflow's own `specialUse`
   * field is a localized-name guess on those, so the belt is ours to own rather than a caret
   * range's to withdraw. `\Noselect` entries and anything in the `ohmail` namespace are excluded;
   * a folder that cannot be selected cannot receive a MOVE, and the ohmail folders are ours.
   *
   * Positive answers are memoised for the life of the connection; a null is re-asked on the next
   * call, so a mailbox that GAINS a Junk folder is picked up on the next connect without a
   * restart. Read-only: one LIST, no other command, nothing created — see {@link SpecialFolders}
   * for why null is the honest answer and what each caller does with it.
   */
  async findSpecialFolders(): Promise<SpecialFolders> {
    if (this.specialJunk !== null && this.specialTrash !== null) {
      return { junk: this.specialJunk, trash: this.specialTrash };
    }
    const list = await this.client.list();
    const resolve = (use: string, belt: RegExp): string | null => {
      const selectable = (f: ListResponse): boolean => !(f.flags?.has("\\Noselect") ?? false);
      const outsideOhmail = (path: string): boolean => !/(?:^|\/)ohmail(?:\/|$)/i.test(path);
      const special = list.find((f) =>
        selectable(f) && (f.specialUse ?? "").toLowerCase() === use
        && outsideOhmail(this.toCanonical(f.path)));
      if (special) return this.toCanonical(special.path);
      const byName = list.find((f) => {
        if (!selectable(f)) return false;
        const path = this.toCanonical(f.path);
        if (!outsideOhmail(path)) return false;
        return belt.test(path.split("/").pop() ?? path);
      });
      return byName ? this.toCanonical(byName.path) : null;
    };
    this.specialJunk = this.specialJunk ?? resolve("\\junk", JUNK_BY_NAME);
    this.specialTrash = this.specialTrash ?? resolve("\\trash", TRASH_BY_NAME);
    return { junk: this.specialJunk, trash: this.specialTrash };
  }

  /**
   * The organizer lease's IO, bound to THIS adapter's live login.
   *
   * The lease needs APPEND, FETCH-headers, STORE `\Deleted` + EXPUNGE,
   * CREATE and UNSUBSCRIBE — none of which are on `MailboxAdapter`, and none of which belong
   * there: they are one feature's needs, not every caller's.
   *
   * It reuses the connection rather than opening its own. A lease with its own client would mean
   * a second login per mailbox per cycle, which is how a provider decides to throttle a user, and
   * it would double the connection count of every deployment for a message the size of a
   * postcard.
   *
   * Callable only after {@link connect}, like every other method here — `toServerPath` depends on
   * the delimiter discovered at login.
   */
  leaseIo(): LeaseIo {
    return makeLeaseIo(this.client as unknown as LeaseImapClient, (c) => this.toServerPath(c));
  }

  /**
   * The portable organizer profile's IO, bound to THIS adapter's live login — the lease's
   * arrangement, for the lease's reasons (one connection, additive method, callable only after
   * {@link connect}).
   *
   * A THIRD accessor rather than a widening of {@link leaseIo}, because the two read different
   * things at different costs: the lease fetches headers only, every cycle, and must stay that
   * cheap; the profile fetches full sources, rarely (a takeover read, a debounced write), and
   * folding `source: true` into the lease's fetch would make the gate's per-cycle cost scale
   * with the profile document's size.
   */
  profileIo(): ProfileIo {
    return makeProfileIo(this.client as unknown as ProfileImapClient, (c) => this.toServerPath(c));
  }

  /**
   * The organizer lease, READ-ONLY, for a surface that reports who holds a mailbox rather than
   * competing for it.
   *
   * A SECOND accessor rather than a flag on {@link leaseIo}, because the difference has to be
   * visible at the call site and unreachable from it. `leaseIo()` hands out APPEND and EXPUNGE;
   * an API process holding that object is one line away from becoming an organizer — and the
   * failure would not look like a bug, it would look like a settings pane that quietly stood the
   * user's own laptop down. The object this returns has one method, and it reads.
   *
   * It also never CREATEs `ohmail/_meta`. See {@link makeLeasePeekIo}.
   */
  leasePeekIo(): LeasePeekIo {
    return makeLeasePeekIo(this.client as unknown as LeaseImapClient, (c) => this.toServerPath(c));
  }

  toServerPath(canonical: string): string {
    if (canonical.toUpperCase() === "INBOX") return "INBOX";
    if (this.delimiter === "/") return canonical;
    return canonical.split("/").join(this.delimiter);
  }

  toCanonical(serverPath: string): string {
    if (serverPath.toUpperCase() === "INBOX") return "INBOX";
    if (this.delimiter === "/") return serverPath;
    return serverPath.split(this.delimiter).join("/");
  }

  /** Enumerate current UIDs of the OPEN mailbox (delete detection + fallback create detection). */
  private async enumerateUids(): Promise<number[]> {
    const mb = this.client.mailbox as MailboxObject | false;
    if (!mb || mb.exists === 0) return [];
    const uids: number[] = [];
    for await (const m of this.client.fetch("1:*", { uid: true })) uids.push(m.uid);
    return uids;
  }

  /**
   * UIDs of the newest `count` messages of the OPEN mailbox, by SEQUENCE number.
   *
   * The Sent folder's FIRST scan. Sequence numbers, not UIDs, because "the newest
   * N" is a position question and UIDs are not contiguous after deletes — `scanSentRecipients`
   * asks the same question the same way.
   */
  private async enumerateNewestUids(count: number): Promise<number[]> {
    const mb = this.client.mailbox as MailboxObject | false;
    if (!mb || mb.exists === 0) return [];
    const start = mb.exists > count ? mb.exists - count + 1 : 1;
    const uids: number[] = [];
    for await (const m of this.client.fetch(`${start}:*`, { uid: true })) uids.push(m.uid);
    return uids;
  }

  /**
   * UIDs at or above `fromUid` — the Sent folder's steady-state watermark scan.
   *
   * **The `uid >= fromUid` filter is not defensive tidying.** RFC 3501 says a UID range whose
   * start exceeds its end is the same range reversed, so `UID FETCH 5001:*` against a mailbox
   * whose highest UID is 5000 does NOT return nothing — it returns message 5000, every cycle,
   * for ever. Without the filter the newest sent message is re-fetched (body and all) on every
   * poll of every idle mailbox in the fleet.
   */
  private async enumerateUidsFrom(fromUid: number): Promise<number[]> {
    const mb = this.client.mailbox as MailboxObject | false;
    if (!mb || mb.exists === 0) return [];
    const uids: number[] = [];
    for await (const m of this.client.fetch(`${fromUid}:*`, { uid: true }, { uid: true })) {
      if (m.uid >= fromUid) uids.push(m.uid);
    }
    return uids;
  }

  /**
   * The arrival date of every candidate UID, cached per (folder, epoch).
   *
   * ── WHY THIS IS A SEPARATE FETCH FROM THE RFC822.SIZE ONE ───────────────────────────────
   *
   * They ask different questions of different sets. Sizes are needed only for the messages
   * that survived the COUNT cap, so that query stays bounded by the batch budget and the byte
   * budget it feeds is untouched. Dates are needed for every CANDIDATE, because the cap is
   * what they decide. Widening the size fetch to the candidate set would have collapsed the
   * two and silently unbounded the first one.
   *
   * ── CHUNKED, BECAUSE imapflow DOES NOT COMPRESS A UID LIST ──────────────────────────────
   *
   * `ImapFlow.fetch` serialises an array with `range.join(',')` — no range packing. The
   * unknown set on the first pass of a real mailbox is the whole mailbox: thousands of UIDs make
   * a command line tens of kilobytes long (measured), against RFC 2683 §3.2.1.5's request that
   * clients keep them short, and servers do enforce limits. Date ordering makes this worse over time rather
   * than better — ingested UIDs no longer come off the top in a block, so the remaining unknown
   * set FRAGMENTS across the UID space and cannot be expressed as a range at all. Hence a fixed
   * chunk, sized so one command stays in the same order of magnitude as the 200-UID list this
   * function already sent.
   *
   * ── AND CACHED, BECAUSE OTHERWISE IT IS QUADRATIC ───────────────────────────────────────
   *
   * The unknown set shrinks by one batch per pass, so re-asking for all of it every pass costs
   * O(n²/batch) metadata over a drain — tens of millions of items for a mailbox of a hundred
   * thousand messages. With the
   * cache the whole set is read once, on the pass where it is contiguous anyway, and later
   * passes ask only about UIDs that have ARRIVED since. Pruned to the live candidate set each
   * pass so it shrinks with the drain instead of growing with it.
   */
  private async arrivalDatesFor(
    folder: string,
    curUidValidity: bigint,
    uids: readonly number[],
  ): Promise<Map<number, number>> {
    const epoch = String(curUidValidity);
    let entry = this.dateCache.get(folder);
    if (!entry || entry.uidValidity !== epoch) {
      entry = { uidValidity: epoch, dates: new Map<number, number>() };
      this.dateCache.set(folder, entry);
    }

    const misses = uids.filter((u) => !entry!.dates.has(u));
    for (let i = 0; i < misses.length; i += ImapAdapter.DATE_FETCH_CHUNK) {
      const chunk = misses.slice(i, i + ImapAdapter.DATE_FETCH_CHUNK);
      for await (const m of this.client.fetch(
        chunk, { uid: true, internalDate: true, envelope: true }, { uid: true },
      )) {
        entry.dates.set(m.uid, arrivalKey(m.internalDate, m.envelope?.date));
      }
      // A UID the server did not answer for (expunged between enumeration and now) is recorded
      // as 0 rather than left missing, or it would be re-asked on every pass for ever.
      for (const u of chunk) if (!entry.dates.has(u)) entry.dates.set(u, 0);
    }

    // Prune: a UID that is no longer a candidate has been ingested (or has gone away) and its
    // date will never be consulted again.
    const live = new Set(uids);
    for (const u of [...entry.dates.keys()]) if (!live.has(u)) entry.dates.delete(u);
    return entry.dates;
  }

  /** UIDs per date-lookup command. See {@link ImapAdapter.arrivalDatesFor} — ~1.9 KiB on the wire. */
  private static readonly DATE_FETCH_CHUNK = 500;

  /**
   * Fetch bodies for at most `budget` worth of UIDs, NEWEST MAIL FIRST, and say what was left.
   *
   * THE MEMORY BOUND OF THE WHOLE WORKER lives here. Every path that pulls `source: true`
   * goes through this function, because the alternative — one unbounded fetch — has
   * killed production before (see {@link DEFAULT_SYNC_BATCH_MAX_MESSAGES}).
   *
   * ── "NEWEST FIRST" USED TO MEAN "HIGHEST UID FIRST", AND THAT WAS THE BUG ────────────────
   *
   * This sorted `uids` descending and named the result `newestFirst`. A UID is an arrival
   * COUNTER, not a clock, and on any mailbox that was imported the two disagree completely: an
   * import writes messages in whatever order it walked them, so a high UID can carry a message
   * from years before a low one, and the two orderings share no useful structure at all.
   * Ordering here is not a nicety, because it is the order the CLIENT receives
   * its mailbox in: the worker commits `batch.creates` in array order, each commit allocates
   * the next `change_log.seq`, and `/sync` reads that log ascending. So this sort decides what
   * is on page 1 of a fresh account's bootstrap. With UID order it was an arbitrary slice of
   * the user's history — measured on a large seeded account, the newest mail did not
   * arrive until page 4 of 34, and page 1 spanned three years of history rather than the most
   * recent mail.
   *
   * The old header said "correctness does not depend on order (selection is known-set based,
   * not UID-range based), but a user watching a first sync wants this week's mail before mail
   * from 2019". BOTH HALVES STILL HOLD, and the first half is what makes the second one
   * reachable: nothing downstream reads a UID RANGE, so the candidate set may be re-ordered
   * freely. What it did not say is that the SECOND half was not actually being delivered.
   *
   * {@link arrivalKey} is the sort key and says why it is neither field on its own.
   *
   * ── WHAT DID NOT CHANGE ─────────────────────────────────────────────────────────────────
   *
   * Sizes still come from a cheap RFC822.SIZE pre-fetch on the count-capped slice, so the size
   * query is itself still bounded; the byte cap and the anti-stall rule are untouched; and at
   * least one message is always taken, or a single oversized mail would stall the drain
   * forever.
   */
  private async fetchCapped(
    uids: number[],
    folder: string,
    curUidValidity: bigint,
    budget: { messages: number; bytes: number },
  ): Promise<{ fetched: InternalCreate[]; truncated: boolean; unanswered: number[] }> {
    const fetched: InternalCreate[] = [];
    if (uids.length === 0) return { fetched, truncated: false, unanswered: [] };

    const dates = await this.arrivalDatesFor(folder, curUidValidity, uids);
    const newestFirst = orderCandidates(uids, dates);
    const slice = newestFirst.slice(0, Math.max(1, budget.messages));
    let truncated = slice.length < newestFirst.length;

    // RFC822.SIZE first: bytes are the budget that actually protects the container, and
    // learning them costs one metadata fetch over an already count-capped list.
    const sizes = new Map<number, number>();
    for await (const m of this.client.fetch(slice, { uid: true, size: true }, { uid: true })) {
      sizes.set(m.uid, typeof m.size === "number" ? m.size : 0);
    }

    const take: number[] = [];
    let bytes = 0;
    for (const uid of slice) {
      const size = sizes.get(uid) ?? 0;
      // `take.length === 0` is the anti-stall rule: the first message is always admitted,
      // however large, so the drain can never wedge on one oversized mail.
      if (take.length > 0 && bytes + size > budget.bytes) { truncated = true; break; }
      take.push(uid);
      bytes += size;
    }
    if (take.length === 0) return { fetched, truncated, unanswered: [] };

    for await (const m of this.client.fetch(
      take,
      { uid: true, flags: true, envelope: true, source: true, internalDate: true },
      { uid: true },
    )) {
      fetched.push({
        folder, uidValidity: curUidValidity, uid: m.uid,
        raw: (m.source ?? Buffer.alloc(0)) as Buffer,
        seen: m.flags?.has("\\Seen") ?? false,
        messageId: normalizeMessageId(m.envelope?.messageId ?? null),
        // The fetch already asks for `internalDate` (it is in the field list above, for the
        // ordering key); this carries it to the pipeline instead of discarding it. Guarded on the
        // instance and on validity because a server may answer without one, or with garbage. An
        // omitted or invalid value means the backlog cutoff does not engage for that message and
        // it is HELD at the consent gate like fresh mail — the pipeline no longer falls back to
        // the sender-written `Date:` header (a security review showed a backdated header kept a
        // stranger's mail in-folder), so a server that cannot vouch for a receive time screens
        // more, never admits more.
        ...(m.internalDate instanceof Date && Number.isFinite(m.internalDate.getTime())
          ? { internalDate: m.internalDate }
          : {}),
      });
      /**
       * NOT `dates.set(...)` HERE, THOUGH THE BODY FETCH CARRIES BOTH FIELDS.
       *
       * Every UID in `take` came out of `arrivalDatesFor`, so its key is already cached and
       * writing it again buys nothing. It also costs something: this loop's value would
       * OVERWRITE the one the selection was made with, so if the two ever disagreed the page
       * would be emitted in a different order from the one it was chosen in. They cannot
       * disagree against a real server — same fields, same messages — which is exactly why the
       * hazard would never have shown up in production. A test fake that answers the two
       * fetches differently is what caught it.
       */
    }

    /**
     * SORTED AGAIN, AFTER THE FETCH, AND THIS IS NOT REDUNDANT.
     *
     * `ImapFlow.fetch` yields in the order the SERVER streams — ascending sequence number —
     * not in the order the UIDs were asked for. So selecting `take` newest-first bought the
     * right two hundred messages and then handed them over oldest-first, and since this array
     * is committed in order and each commit allocates the next `change_log.seq`, the client
     * received each page of its own mailbox backwards.
     *
     * Found by a test that expected the emitted order to match the requested one on a batch
     * where every date was identical: it
     * failed against the ORIGINAL code too, so this was already true before that change and the UID
     * sort above was never reaching the wire order at all.
     */
    // ── THE SERVER MAY ANSWER WITH FEWER MESSAGES THAN IT WAS ASKED FOR ────────────────────────
    //
    // RFC 3501 lets a `UID FETCH` simply return fewer messages than the UID set names, with no
    // error and no per-UID signal — `fetchByUid` has always said so and derives its `absent` set by
    // subtraction for exactly that reason. THIS function did not, and read a short answer as a
    // complete one: `truncated` was computed only from the count cap and the byte cap, so a UID the
    // server withheld left no create, no `hasBacklog`, and no ledger row, while the cursor below
    // published `mb.uidNext` and advanced `highestModseq` as though the folder had drained.
    //
    // NOT HYPOTHETICAL, and the trigger is a header the sender chose. iCloud cannot serialize an
    // ENVELOPE for a message whose `Message-ID` is a QUOTED STRING — RFC 5322 §3.6.4 allows
    // `msg-id` to carry one, and `<"2015-01-12T20:15:35.803795+00:00.26974-mail"@example.com>` is
    // the shape of a real one — and rather than failing the command it omits the row. Measured on a live iCloud
    // mailbox: `UID SEARCH ALL` returns the UID, `FETCH (FLAGS RFC822.SIZE)` returns it,
    // `FETCH (BODY.PEEK[])` returns it, and `FETCH (ENVELOPE)` returns nothing at all for it. One
    // folder held two such messages and therefore imported ZERO of its mail while its cursor read
    // as complete — and `initial_import_completed_at`, which is written on a cycle that ends with
    // no backlog, landed over it.
    //
    // ── SO ASK AGAIN WITHOUT THE FIELD THE SERVER CANNOT PRODUCE ───────────────────────────────
    //
    // The envelope is wanted for ONE value here — the Message-ID `correlateMoves` pairs on — and
    // the raw source carries that same header. A second fetch over just the shortfall, with
    // `envelope` dropped, therefore recovers the message in full rather than writing it off: the
    // body, the flags and the receive time are all fields this server answers happily.
    //
    // A UID still absent after that is genuinely unanswerable and is returned to the caller, which
    // must record it durably BEFORE the cursor crosses it (see `ChangeBatch.unanswered`). Silence
    // is the one thing this path may not do with it.
    const answered = new Set(fetched.map((f) => f.uid));
    const withheld = take.filter((u) => !answered.has(u));
    let unanswered: number[] = [];
    if (withheld.length > 0) {
      for await (const m of this.client.fetch(
        withheld,
        { uid: true, flags: true, source: true, internalDate: true },
        { uid: true },
      )) {
        const raw = (m.source ?? Buffer.alloc(0)) as Buffer;
        answered.add(m.uid);
        fetched.push({
          folder, uidValidity: curUidValidity, uid: m.uid,
          raw,
          seen: m.flags?.has("\\Seen") ?? false,
          // From the RAW HEADERS, because the envelope is the field this retry exists to avoid.
          messageId: messageIdFromRaw(raw),
          ...(m.internalDate instanceof Date && Number.isFinite(m.internalDate.getTime())
            ? { internalDate: m.internalDate }
            : {}),
        });
      }
      unanswered = withheld.filter((u) => !answered.has(u));
    }

    fetched.sort((a, b) => (dates.get(b.uid) ?? 0) - (dates.get(a.uid) ?? 0) || b.uid - a.uid);
    return { fetched, truncated, unanswered };
  }

  /**
   * The folders ONE `changesSince` pass reads: the frozen six, the mailbox's own Sent folder when
   * the server has one, and the customer's OWN folders LAST.
   *
   * `sent` is null on a server with no Sent folder at all, and is dropped when it collides with
   * a watched folder — a mailbox whose Sent path somehow resolved to `INBOX` must be read once,
   * not twice, and must not have its INBOX creates tagged as own-authored.
   *
   * ── PASSIVE FOLDERS ARE LAST, AND THAT ORDERING IS THE WHOLE COST ANSWER ───────────────────
   *
   * It is the same argument that admits the Sent folder (see the budget declaration in
   * {@link changesSince}): ONE budget is spent in this order, so a folder at the end can only take
   * what the folders before it left. Fifteen years of `_archive/Clients/…` therefore cannot delay
   * this cycle's inbound mail by one message — it drains through `hasBacklog` re-kicks behind the
   * Imbox, exactly as a Sent backlog does.
   *
   * ── AND THE SENT FOLDER IS RE-FILTERED HERE, NOT ONLY AT DISCOVERY ─────────────────────────
   *
   * `learnPassiveFolders` runs at `connect()`, where the name-based Sent fallback has not run yet.
   * See its docblock: the field is a candidate list and this is the authority.
   */
  private async foldersToScan(): Promise<{
    folders: string[];
    sent: string | null;
    passive: ReadonlySet<string>;
    /** Canonical path → the STATUS the server volunteered this pass. Empty without LIST-STATUS. */
    status: ReadonlyMap<string, FolderStatus>;
  }> {
    const resolved = await this.findSentForScan();
    const watched = new Set<string>(WATCHED_FOLDERS);
    const sent = resolved && !watched.has(resolved) ? resolved : null;
    // ── THE LIST IS PER-CYCLE WHEN THE SERVER CAN ANSWER IT IN ONE COMMAND ────────────────────
    //
    // With RFC 5819 LIST-STATUS the server returns every folder's UIDNEXT / MESSAGES /
    // HIGHESTMODSEQ inside the LIST response, so asking every cycle costs ONE command and buys the
    // `unchangedPassive` skip below — which is what keeps a 110-folder mailbox from paying 110
    // SELECTs per cycle to learn that nothing happened. Both production providers, measured,
    // advertise it.
    //
    // WITHOUT it, imapflow issues a STATUS *per listed folder* to satisfy `statusQuery`
    // (`imapflow/lib/commands/list.js:418`) — 137 commands where the point was to save round trips
    // — so the query is not sent at all, the skip never fires, and the LIST falls back to once per
    // {@link PASSIVE_RELIST_CYCLES} passes. Correct either way; only the cost differs.
    const wantStatus = this.client.capabilities?.has?.("LIST-STATUS") ?? false;
    // `passiveCycle > 0` so the FIRST pass adds no LIST: `connect()` has just done one and this
    // would be a second command for a byte-identical answer. Two Sent-folder tests count LISTs
    // exactly and would go red on the difference, which is the right thing for them to do — a
    // per-cycle LIST on every connection in the fleet is what the memoisation exists to avoid.
    const stale = this.passiveCycle > 0
      && this.passiveCycle % ImapAdapter.PASSIVE_RELIST_CYCLES === 0;
    this.passiveCycle++;
    if (this.passiveFolders === null || wantStatus || stale) {
      try {
        this.learnPassiveFolders(await this.client.list(
          wantStatus
            ? { statusQuery: { messages: true, uidNext: true, highestModseq: true } }
            : undefined,
        ));
      } catch {
        // A LIST that fails costs the refresh and nothing else: keep the inventory we have rather
        // than dropping every customer folder out of the scan on one bad command.
        this.passiveFolders ??= [];
      }
    }
    const passive = (this.passiveFolders ?? []).filter(
      (f) => !watched.has(f) && f !== sent && f !== resolved,
    );
    return {
      folders: [...WATCHED_FOLDERS, ...(sent ? [sent] : []), ...passive],
      sent,
      passive: new Set(passive),
      status: this.passiveStatus,
    };
  }

  /**
   * Is this PASSIVE folder provably unchanged since the cursor was written — may the pass skip it
   * without so much as a SELECT?
   *
   * Three equalities, and all three are needed. This is the one place in the adapter that decides
   * not to look at a folder at all, so it must fail CLOSED: any field the server did not volunteer
   * answers false and the folder is read normally.
   *
   *  · `highestModseq` — no flag changed and no message arrived (RFC 7162 §3.1).
   *  · `uidNext` — no message arrived. Redundant with the above on a correct server and kept
   *    because a server whose CONDSTORE is decorative is not hypothetical: iCloud's `CHANGEDSINCE`
   *    is inert (see the agreement filter in `changesSince`), so a modseq from such a server buys
   *    less than it looks like it does.
   *  · `messages` (EXISTS) equal to the count this cursor knows — **the expunge half, and the one
   *    the other two cannot cover.** CONDSTORE does not raise HIGHESTMODSEQ for an EXPUNGE (that is
   *    what QRESYNC's VANISHED exists for), so without this a message the customer deleted from
   *    their own archive would leave a row pointing at a dead UID for ever. An arrival and an
   *    expunge cancelling out in one interval is caught by `uidNext`.
   *
   * A folder holding a permanently-unknown UID — one enumerated but never ingested — never
   * satisfies the third, so it is read every cycle. That is the safe direction: the skip is an
   * optimisation and declining it costs round trips, never correctness.
   *
   * PASSIVE FOLDERS ONLY, deliberately. INBOX and the five organized folders are where the product
   * happens and the pipeline writes to them; skipping a SELECT there to save a round trip on the
   * hot path is not a trade worth making.
   */
  private unchangedPassive(
    status: FolderStatus | undefined, prev: FolderCursor | undefined, condstore: boolean,
  ): boolean {
    if (!condstore || !status || !prev) return false;
    if (prev.highestModseq === "0" || prev.uidNext === 0) return false;
    if (status.highestModseq === undefined || status.uidNext === undefined) return false;
    if (status.messages === undefined) return false;
    return String(status.highestModseq) === prev.highestModseq
      && Number(status.uidNext) === prev.uidNext
      && Number(status.messages) === prev.known.length;
  }

  async changesSince(cursor: ImapCursor): Promise<ChangeBatch> {
    const caps = await this.capabilities();
    const {
      folders: scanFolders, sent: sentFolder, passive: passiveFolders, status: listStatus,
    } = await this.foldersToScan();
    const sentHistory = this.opts.sentHistoryMessages ?? DEFAULT_SENT_HISTORY_MESSAGES;
    const creates: InternalCreate[] = [];
    const flagChanges: Change[] = [];
    const deletes: InternalDelete[] = [];
    const newFolders: Record<string, PersistedFolderCursor> = {};
    /** UIDs this pass asked for and the server did not return — see {@link ChangeBatch.unanswered}. */
    const unanswered: Array<{ folder: string; uidValidity: string; uid: number }> = [];
    // ONE budget for the whole call, spent in WATCHED_FOLDERS order (INBOX first, Sent LAST),
    // so the bound is per-cycle rather than per-folder — six folders each fetching a full batch
    // would be six times the memory this is supposed to cap.
    //
    // That ordering is also the entire cost answer for watching Sent: adding the Sent folder does
    // NOT add a batch. Sent can only spend what INBOX and the ohmail folders left, so a Sent
    // backlog of tens of thousands of messages cannot delay this cycle's inbound mail by one
    // message — it drains through `hasBacklog` re-kicks behind it.
    const budget = {
      messages: this.opts.maxBatchMessages ?? DEFAULT_SYNC_BATCH_MAX_MESSAGES,
      bytes: this.opts.maxBatchBytes ?? DEFAULT_SYNC_BATCH_MAX_BYTES,
      // …and FLAGS, which had no budget at all at first. See
      // `DEFAULT_SYNC_BATCH_MAX_FLAGS`: this one bounds the worker's serial queue, not memory.
      flags: this.opts.maxBatchFlags ?? DEFAULT_SYNC_BATCH_MAX_FLAGS,
    };
    let hasBacklog = false;

    // ── THE FLAG BUDGET IS SHARED, SO IT NEEDS A SCHEDULE — NOT A QUEUE ────────────────────────
    //
    // Spending the flag budget the way the creates budget is spent — in `scanFolders` order, each
    // folder taking all it can — is FIFO, and FIFO on a shared resource starves the tail. Measured
    // on a real iCloud mailbox: `ohmail/Screener` owed 5 101 known UIDs, roughly sixteen cycles of
    // the whole budget on its own, and the five folders behind it (Reads 40, Receipts 1, Screened
    // 238, Quarantine 247, Sent 1 984) were never reached. Every one of them was therefore
    // `flagsTruncated` on every cycle, every one of their cursors was held, `hasBacklog` was
    // pinned true, and `initial_import_completed_at` — which the organizer writes only on a cycle
    // that ends with no backlog — stayed NULL for days on a mailbox that was doing no work.
    //
    // This is NOT the rewind the `lastFlagUid` seed fixed. That one LOST progress; this one makes
    // none, which is why it survived the fix. A folder at the back of the queue keeps its resume
    // point perfectly and is simply never asked.
    //
    // Two rules, and neither of them touches the cursor. Fairness has to come from scheduling:
    // `FlagDrain.advanceTo` is what makes a multi-pass drain safe, and buying throughput by
    // advancing a cursor past changes nobody examined would trade a stall for silent flag loss.
    //
    //   ROTATION. `flagCycle` picks which OWING folder leads, so the front of the queue moves
    //   every cycle and no folder is permanently last.
    //
    //   OWED SHARE. A folder may take `ceil(remaining / claimants-from-here-on)` — an equal split
    //   of what is left among the folders that still owe. The divisor shrinks as the walk
    //   proceeds, so a folder that could not use its share hands it to the ones behind it and the
    //   cycle still spends the whole budget: at the measured sizes the schedule converges in the
    //   same 16 cycles the FIFO order needs, while reading every folder from cycle 1.
    //
    // The leader is exempt from that cap so leading means something, but only down to `flagFloor`
    // per folder behind it — a leader can never take the cycle.
    //
    // `scanFolders` ORDER IS UNTOUCHED, deliberately. It is the CREATES order (INBOX first, Sent
    // last) and that ordering is a mail-latency guarantee — see the budget declaration above. Only
    // the flag ALLOWANCE rotates.
    const flagTotal = budget.flags;
    // Eligible: could run a flag pass at all this cycle. With CONDSTORE that means a modseq
    // baseline exists; without it (the FALLBACK — Office 365 advertises no CONDSTORE) it means
    // the known-set carries seen baselines to diff against, and the Sent folder is out — see the
    // fallback block below for both. A folder that never reaches the fetch must not have budget
    // reserved for it, which would be reserving it for nobody.
    const flagEligible = scanFolders.filter((f) => {
      const p = cursor.folders[f];
      if (caps.condstore) return !!p && p.highestModseq !== "0";
      return f !== sentFolder && (p?.known.length ?? 0) > 0;
    });
    // Claimants: the folders KNOWN to owe, which before the fetch means "has an in-flight drain".
    //
    // ELIGIBILITY IS NOT A CLAIM, and treating it as one is a throttle on the common case. Every
    // watched folder is eligible on a healthy mailbox, so reserving a share for each of them would
    // hand INBOX a sixth of the budget on a quiet cycle where the other five owe nothing — the
    // reserve would be held for folders that never spend it and the whole cycle would go slower
    // than the FIFO it replaced. Watched: `imap.changes.flagdrain-starvation.test.ts` reported
    // `['1:*', '6:*', '16:*']` for a drain that must read ten at a time.
    //
    // So when NOTHING is in flight there is nothing to be fair about and this degenerates to the
    // FIFO order exactly. A folder that then turns out to owe more than the budget truncates,
    // records a drain, and is a claimant from the next cycle on — the transient is one cycle, and
    // the starving folders are by definition the ones holding a drain.
    const flagClaimants = new Set(flagEligible.filter((f) => this.flagDrain.has(f)));
    const rotation = [...flagClaimants];
    const flagLead = rotation.length > 0 ? rotation[this.flagCycle % rotation.length]! : null;
    this.flagCycle++;
    // What every claimant behind a folder keeps whatever that folder does with its turn.
    const flagFloor = Math.max(1, Math.floor(flagTotal / (2 * Math.max(1, flagClaimants.size))));

    for (const [folderIndex, folder] of scanFolders.entries()) {
      const isSent = folder === sentFolder;
      const isPassive = passiveFolders.has(folder);
      const serverPath = this.toServerPath(folder);
      const prev = cursor.folders[folder];
      // PROVABLY UNCHANGED PASSIVE FOLDER — not even a SELECT. See {@link unchangedPassive} for the
      // three equalities and why each is required. This is what keeps a mailbox with a hundred
      // customer folders costing one LIST per cycle instead of a hundred SELECTs.
      if (isPassive && this.unchangedPassive(listStatus.get(folder), prev, caps.condstore)) {
        newFolders[folder] = {
          uidValidity: prev!.uidValidity, uidNext: prev!.uidNext, highestModseq: prev!.highestModseq,
        };
        continue;
      }
      let lock: { release(): void };
      try {
        lock = await this.client.getMailboxLock(serverPath);
      } catch {
        // Folder does not exist yet (e.g. ensureFolders not run, or server lacks it).
        // Carry the previous cursor forward and skip — no changes can be observed here.
        newFolders[folder] = prev
          ? { uidValidity: prev.uidValidity, uidNext: prev.uidNext, highestModseq: prev.highestModseq }
          : { uidValidity: "0", uidNext: 0, highestModseq: "0" };
        continue;
      }
      try {
        const mb = this.client.mailbox as MailboxObject;
        const curUidValidity = mb.uidValidity;
        const knownMap = new Map<number, KnownEntry>((prev?.known ?? []).map((k) => [k.uid, k]));
        const uidValidityChanged =
          !!prev && prev.uidValidity !== "0" && prev.uidValidity !== String(curUidValidity);
        // On a UIDVALIDITY change every prior UID is stale: treat the known-set as empty for
        // create/flag detection (so all current UIDs are re-learned) and emit every prior UID as a
        // delete; correlateMoves then re-pairs create↔delete by Message-ID into a single locator refresh.
        const effectiveKnown = uidValidityChanged ? new Map<number, KnownEntry>() : knownMap;
        const canFastPath = caps.condstore && !!prev && prev.highestModseq !== "0" && !uidValidityChanged;
        // ── THE FALLBACK: FLAG CHANGES WITHOUT CONDSTORE ────────────────────────────────────
        //
        // Office 365 advertises no CONDSTORE (measured live: `IMAP4 IMAP4rev1 AUTH=PLAIN
        // AUTH=XOAUTH2 SASL-IR UIDPLUS MOVE ID UNSELECT CHILDREN IDLE NAMESPACE LITERAL+`), so
        // on such a server `canFastPath` is false on every cycle for ever — and until this
        // branch existed that meant NO flag change was ever derived: mail read in Outlook stayed
        // bold here permanently, per folder, which is the read-state-mirror bug all over again.
        //
        // The prior flags the old "documented limitation" said were missing are in the known-set
        // now (`KnownEntry.seen` — what the database last observed the server holding). So the
        // fallback fetches FLAGS for the known range — a plain fetch, no `changedSince` — and
        // emits a change only where the server DISAGREES with that baseline. Agreement is free,
        // so a clean folder costs one flags-only fetch and emits nothing, however large it is;
        // that fetch every cycle is the unavoidable price of a server that cannot say "what
        // changed", and it is the same price every no-CONDSTORE mail client pays.
        //
        // The SENT folder is excluded. `pipeline.ts` ingests own-sent mail `seen: true`
        // regardless of what the server reported (a client that appends to Sent without `\Seen`
        // must not put the user's own outbox into the unread count), so an unflagged Sent row's
        // database state is a POLICY, not an observation — diffing against it would "adopt" a
        // divergence nobody created and flip the user's own sent mail unread.
        //
        // The user-wins decision stays in `applyExternalFlag`, which declines while our own
        // write is still in flight; this diff is a cost filter, not an authority.
        const canFlagFallback =
          !caps.condstore && !isSent && !uidValidityChanged && effectiveKnown.size > 0;

        // ── ENUMERATION: WHOLE FOLDER, OR THE SENT WATERMARK ──────────────────────────────
        //
        // Every watched folder is enumerated end to end, because the known-set diff is what
        // detects creates and the known-set is rebuilt from `messages` each cycle.
        //
        // Sent cannot use that, for two independent reasons, and the watermark answers both.
        // (1) COST: the folder is unbounded and mostly historical, so
        // `DEFAULT_SENT_HISTORY_MESSAGES` bounds what is ever ingested and the watermark bounds
        // what is ever RE-READ. (2) CORRECTNESS: `own_copy` (see `dedup.ts`) deliberately
        // stores no row for the Sent twin of a message we already hold, so its UID never enters
        // the known-set — under a plain diff it would be "unknown" every cycle and its body
        // would be re-fetched for ever. A UID is behind the watermark whether or not it
        // produced a row.
        //
        // `enumFloorUid` is what this pass actually LOOKED at. Below it, "not in currentSet"
        // means "not enumerated", not "expunged" — see the deletes loop.
        let currentUids: number[];
        let enumFloorUid = 0;
        if (!isSent) {
          currentUids = await this.enumerateUids();
        } else {
          const watermark = uidValidityChanged ? 0 : (prev?.uidNext ?? 0);
          if (watermark > 0) {
            currentUids = await this.enumerateUidsFrom(watermark);
            enumFloorUid = watermark;
          } else {
            // First scan (or a UIDVALIDITY reset): the newest N by sequence number.
            currentUids = await this.enumerateNewestUids(sentHistory);
            // A UIDVALIDITY reset keeps the ordinary full-delete semantics: every prior UID is
            // meaningless, so the floor stays 0 and `knownMap` is emitted wholesale below.
            enumFloorUid = uidValidityChanged
              ? 0
              : (currentUids.length > 0 ? Math.min(...currentUids) : Number.MAX_SAFE_INTEGER);
          }
        }
        const currentSet = new Set(currentUids);

        // CREATES COME FROM THE KNOWN-SET DIFF ON BOTH PATHS, and only ever through the
        // capped fetch. The fast path used to pull `source: true` for everything with
        // modseq > cursor — which includes known messages whose FLAGS merely changed, whose
        // bodies are then discarded. So "mark thousands of messages read" reproduced the same OOM
        // as a cold sync. The unknown-UID diff is a strict superset of the creates
        // `changedSince` could report, so nothing is lost by sourcing them here instead.
        const unknownUids = currentUids.filter((u) => !effectiveKnown.has(u));
        const {
          fetched, truncated, unanswered: withheldUids,
        } = await this.fetchCapped(unknownUids, folder, curUidValidity, budget);
        creates.push(...fetched);
        budget.messages -= fetched.length;
        for (const f of fetched) budget.bytes -= f.raw.length;
        if (truncated) hasBacklog = true;
        // Reported, never swallowed. The cursor written at the bottom of this loop ADVANCES over
        // these UIDs, so the caller owes each one a durable record first — see
        // {@link ChangeBatch.unanswered}, which is where that obligation is stated.
        for (const uid of withheldUids) {
          unanswered.push({ folder, uidValidity: String(curUidValidity), uid });
        }

        // A UIDVALIDITY reset makes every remembered UID meaningless, including a drain's
        // resume point. Drop it before anything can read it.
        if (uidValidityChanged) this.flagDrain.delete(folder);

        const drain = this.flagDrain.get(folder);
        let flagsTruncated = false;
        if (canFastPath || canFlagFallback) {
          // Flags only — no bodies, no envelopes. Known UIDs are the only ones that can
          // produce a flag change; unknown ones are creates and were handled above.
          //
          // BOUNDED, and resumable by UID. `changedSince` is a fixed query: it re-reports the
          // identical set until the cursor moves, so truncating at N without a resume point
          // would hand back the same N for ever and the drain would never finish. The range
          // starts at the drain's resume UID and the modseq stays the one the drain began on.
          //
          // The FALLBACK (`canFlagFallback` — see its declaration) runs this same loop with two
          // differences: the fetch carries no `changedSince` (the server cannot answer one), and
          // a row is a change only when it DIVERGES from the known-set's seen baseline, where
          // the fast path trusts CONDSTORE to have pre-filtered. The resume machinery is shared:
          // a truncated fallback pass holds its place by UID exactly like a truncated fast pass,
          // so "mark all read in Outlook" drains across cycles instead of re-reporting its first
          // `allowance` for ever. `sinceModseq`/`advanceTo` are inert in that mode — the folder
          // cursor's `highestModseq` is pinned at "0" for a no-CONDSTORE server below.
          const from = drain?.resumeUid ?? 1;
          const since = drain?.sinceModseq ?? prev!.highestModseq;
          // ── THE RESUME POINT IS WHAT THIS PASS EXAMINED, NOT WHAT IT ACCEPTED ────────────
          //
          // Seeded at `from - 1` — one below where the pass starts — so that
          // `resumeUid: lastFlagUid + 1` below reads "no progress this pass" when nothing was
          // accepted. It used to start at 0, which made that same expression write
          // `resumeUid: 1`: not "no progress" but START OVER, discarding every UID the drain had
          // already reported on earlier cycles.
          //
          // That mattered because THE BUDGET IS SHARED ACROSS FOLDERS (see its declaration). A
          // folder reaching this loop with `budget.flags` already spent by INBOX broke on its
          // first known UID having accepted nothing, rewound to 1, and — `flagsTruncated` holding
          // the folder cursor — re-read the identical range from the start on the next cycle. The
          // stall is not that starvation is continuous; it is that a drain needing four clean
          // cycles and reset by an INBOX burst every third NEVER finishes, so `hasBacklog` is true
          // for ever — and the stamp that records a first import as complete, which the organizer
          // writes only on a cycle that ends with no backlog, is therefore never written. A mailbox
          // in that state stays in it: fully drained, motionless, and still described as importing.
          //
          // THE RESIDUAL THAT PARAGRAPH LEFT — "a folder starved on EVERY cycle still makes no
          // progress" — WAS NOT HYPOTHETICAL, AND IT IS WHAT THE SCHEDULE ABOVE CLOSES. It was
          // written here as a bound worth stating and not chasing, on the argument that "the
          // folder ahead cannot eat the budget for ever". A folder ahead with five thousand owed
          // UIDs eats
          // it for sixteen consecutive cycles, which is long enough to look exactly like for ever;
          // measured on a real mailbox days after this line was written. Progress is now
          // guaranteed per cycle by `allowance`, not argued from the folder ahead running out.
          //
          // The seed below is still the thing THIS test file watches, and it is still observable:
          // `allowance` can be 0 for a folder whose reserve was consumed by rounding, so
          // `flagsTruncated` does not imply anything was accepted. That was the objection to the
          // anti-stall floor written and dropped here (admit the first candidate of every folder
          // however spent the budget, which is what `fetchCapped` does for creates) — with the
          // floor in place `lastFlagUid` could never still hold the seed, and a guard that cannot
          // be watched fail is not one. A share is not a floor: it bounds from above.
          // ── THIS FOLDER'S SHARE OF THE CYCLE. See the schedule above `for (const [folderIndex…`.
          //
          // `after` is the claimants still to come, so the reserve held back is theirs and nobody
          // else's; everything a visited folder did not use is already inside `budget.flags` and
          // is offered here. A NON-claimant — a folder with no drain, on a cycle where some other
          // folder has one — is not owed a share, but new flag changes on it are more urgent than
          // an old drain, so it may take whatever is not reserved.
          const after = scanFolders.slice(folderIndex + 1).filter((f) => flagClaimants.has(f)).length;
          const unreserved = budget.flags - after * flagFloor;
          const share = flagClaimants.has(folder)
            ? Math.ceil(budget.flags / (after + 1))
            : unreserved;
          const allowance = Math.max(0, Math.min(
            budget.flags,
            folder === flagLead ? Math.max(share, unreserved) : share,
          ));
          let taken = 0;
          let lastFlagUid = from - 1;
          for await (const m of this.client.fetch(
            `${from}:*`,
            { uid: true, flags: true },
            canFastPath ? { uid: true, changedSince: BigInt(since) } : { uid: true },
          )) {
            // NOT A SKIP — an unknown UID was EXAMINED, and unknown-ness is the answer. It is a
            // create, sourced by the known-set diff above with its flags attached, so this pass
            // owes it nothing; leaving the cursor behind it only re-reads it from the server on
            // every later pass of the same drain. Safe to step over for the same reason it is
            // safe to ignore: `advanceTo` is the modseq observed when the drain STARTED, so it
            // is at or above this UID's modseq, and a flag change on it after the drain ends is
            // re-reported by the ordinary `changedSince` on the next cycle.
            const known = effectiveKnown.get(m.uid);
            if (!known) { lastFlagUid = m.uid; continue; }
            const seen = m.flags?.has("\\Seen") ?? false;
            // ── AGREEMENT WITH THE BASELINE IS NOT A CHANGE, ON *BOTH* PATHS ─────────────────
            //
            // A baseline the repo could not state (`seen` null/absent — a dead-lettered UID) splits
            // the two paths and is the ONLY thing that does. The FALLBACK skips it: nothing was ever
            // ingested for that UID, so there is no divergence to compute and inventing one would
            // adopt a value nobody observed. The FAST PATH reports it: CONDSTORE named the row as
            // changed, and with no baseline this code cannot prove the application would be a no-op
            // — the only two positions available are "report it" and "invent a baseline", and the
            // second one is not a position.
            //
            // Everything else is compared on both paths, and an agreement is stepped over for the
            // resume point exactly like an unknown UID: an agreement examined is an agreement
            // answered.
            //
            // THIS USED TO READ `!canFastPath && (…)`, exempting the CONDSTORE path on the argument
            // that *"CONDSTORE already said these rows changed, and its cursor semantics own
            // them."* That argument is a claim about the SERVER, and it is false on a server people
            // actually use.
            //
            // **iCloud's `CHANGEDSINCE` IS INERT.** It advertises CONDSTORE and QRESYNC, and it
            // answers `CHANGEDSINCE <modseq>` with EVERY message in the folder — verified by handing
            // it the folder's own reported `HIGHESTMODSEQ`, above which RFC 7162 says nothing can
            // exist, and getting one row per message back on every folder of the mailbox.
            //
            // With no agreement filter every one of those rows was a flag CHANGE. A mailbox with
            // more messages than {@link DEFAULT_SYNC_BATCH_MAX_FLAGS} therefore truncated every
            // folder on every cycle, held every folder's `highestModseq`, and pinned `hasBacklog`
            // true — so the stamp that records a first import as finished, which the organizer
            // writes only on a cycle that ends with no backlog, was unreachable FOR EVER. Nothing
            // was wrong with such a mailbox: its cursors were exact and its every UID was known. It
            // re-read a budget's worth of flags it already had, once a poll interval, indefinitely.
            //
            // ── WHY THIS CANNOT LOSE A FLAG, STATED AS AN EQUIVALENCE ────────────────────────
            //
            // `KnownEntry.seen` is `flag_state.observed_seen` — *what the database last observed the
            // server holding* — which is the value `applyExternalFlag` compares against on the
            // consuming side. So a row suppressed here is exactly a row whose application would have
            // answered `changed: false` and written nothing. The filter is MONOTONE: it can only
            // ever suppress reports, so it cannot introduce a flag application that did not happen
            // before, and the ones it removes were no-ops. On a server whose CHANGEDSINCE works it
            // suppresses almost nothing, because such a server has already pre-filtered.
            if (known.seen == null ? !canFastPath : known.seen === seen) {
              lastFlagUid = m.uid;
              continue;
            }
            // BOTH bounds. `taken` is this folder's share, `budget.flags` the cycle's hard cap —
            // the share is derived from the cap, so the second can only bite if a share was
            // rounded up past what was left.
            if (taken >= allowance || budget.flags <= 0) { flagsTruncated = true; break; }
            flagChanges.push({
              type: "flag",
              locator: { folder, ref: makeRef(curUidValidity, m.uid) },
              seen,
            });
            budget.flags--;
            taken++;
            lastFlagUid = m.uid;
          }
          if (flagsTruncated) {
            hasBacklog = true;
            this.flagDrain.set(folder, {
              resumeUid: lastFlagUid + 1,
              sinceModseq: since,
              // Captured ONCE, when the drain starts. See `FlagDrain.advanceTo`.
              advanceTo: drain?.advanceTo ?? String(mb.highestModseq ?? 0n),
            });
          } else {
            this.flagDrain.delete(folder);
          }
        }
        // Deletes: previously-known UIDs that are gone (or ALL prior UIDs on a UIDVALIDITY change).
        const priorUidValidity = prev ? BigInt(prev.uidValidity === "0" ? String(curUidValidity) : prev.uidValidity) : curUidValidity;
        for (const [uid, { messageId }] of knownMap) {
          if (uidValidityChanged) {
            deletes.push({ folder, uidValidity: priorUidValidity, uid, messageId });
            continue;
          }
          // Outside the range this pass enumerated (Sent only — `enumFloorUid` is 0 everywhere
          // else), so its absence from `currentSet` is silence, not evidence. Reporting it
          // would tell `correlateMoves` that every ingested Sent message vanished the first
          // time the watermark moved past it.
          if (uid < enumFloorUid) continue;
          if (!currentSet.has(uid)) {
            deletes.push({ folder, uidValidity: priorUidValidity, uid, messageId });
          }
        }

        // THE CURSOR IS HELD PER FIELD, BECAUSE THE THREE FIELDS ARE HELD FOR DIFFERENT REASONS.
        // It used to be one ternary over `truncated || flagsTruncated`, and the
        // paragraph that justified that is reproduced and refuted below, because it was the
        // load-bearing explanation of this policy and it had stopped being true.
        //
        // `uidValidity` — AN IDENTITY, NOT A WATERMARK. Held while anything is owed, so the pair
        // (epoch, watermarks) this function publishes stays internally consistent. Recording the
        // epoch the server actually reported is `epochAware`'s job one layer up
        // (`apps/worker/src/sync.ts`), and it does that WITHOUT zeroing what is held here; the
        // `"0" → V` promotion is a first-time set, not a reset.
        //
        // `uidNext` — HELD WHENEVER CREATES WERE TRUNCATED, AND THIS IS THE MAIL-SAFETY ONE.
        // Sent is the one folder that reads this field (`enumerateUidsFrom`, the `if (isSent)`
        // branch above), and a watermark above unfetched mail means that mail is never enumerated
        // again — while `own_copy` guarantees no row will ever exist to notice. So only a pass
        // that left nothing unknown may publish `mb.uidNext`.
        //
        // ── THE JUSTIFICATION CHANGED UNDER THIS POLICY; THE POLICY DID NOT ─────────────────
        //
        // This used to argue from UID order: "`fetchCapped` sorts newest-first and slices, so the
        // highest UID this pass ingested sits ABOVE unknown lower UIDs it did not fetch." That
        // sentence is now false. `fetchCapped` sorts by ARRIVAL DATE, so a pass takes UIDs
        // scattered across the whole space and the set it leaves behind is fragmented rather than
        // a contiguous block below it.
        //
        // The rule survives unchanged because it never depended on that — it is a COMPLETENESS
        // test ("did anything remain unknown?"), not an order test. What changes is the strength
        // of the rejection below: "carry forward max(ingested UID)" was already permanently
        // rejected as unsafe at the edges, and under date ordering it is not an edge case at all.
        // The first pass of an imported mailbox can easily ingest the highest UID in the folder
        // while leaving thousands of lower ones unread; publishing that as the watermark would
        // strand all of them. The only safe watermark remains min(unknown UID not fetched), and
        // nobody should resurrect the alternative.
        //
        // `highestModseq` — HELD ONLY WHEN THE FLAG PASS WAS TRUNCATED, or when the server has no
        // CONDSTORE and there is therefore no baseline the fallback path could ever use (never
        // publish one it cannot use). A TRUNCATED CREATES PASS IS NOT A REASON. This comment used
        // to say it was: "advancing `highestModseq` past mail this batch did not return is how you
        // lose it permanently: the next fast path asks for modseq > cursor and those messages are
        // below it". That stopped being true when creates moved onto the known-set diff (see the
        // CREATES paragraph above: the diff is a strict superset of what `changedSince` could
        // report). The fast path reports FLAGS only and skips everything outside `effectiveKnown`,
        // so an unfetched create cannot hide below a modseq: it is still unknown next cycle, the
        // diff re-offers it independently of any modseq, and its `\Seen` arrives with its body.
        // The only loss a modseq advance can cause is a flag change on an ALREADY-KNOWN UID this
        // pass did not read — which is precisely `flagsTruncated`, handled here and by
        // `FlagDrain.advanceTo`.
        //
        // Holding it on creates-truncation cost the whole inbound read-state mirror instead:
        // `canFastPath` requires `prev.highestModseq !== "0"`, so a mailbox that truncates every
        // pass never publishes a FIRST baseline, never runs a flag pass at all, and reinstates the
        // read-state-mirror bug — mail read in Apple Mail stays bold in ohmail for ever — per folder.
        //
        // A COMPLETED multi-pass drain still advances only to where that drain BEGAN
        // (`FlagDrain.advanceTo`): a flag changed on a low UID while the drain was above it is
        // below the resume point and was never read, so advancing to the modseq observed on the
        // last pass would drop it silently.
        //
        // Residual, stated and deliberately not chased: on the pass that first publishes a
        // baseline `canFastPath` was false, so no flags were read, and a `\Seen` toggled between a
        // message's create and that baseline is never reported. Today's first non-truncated pass
        // does exactly the same thing — this only reaches it sooner.
        const advanceTo = drain && !flagsTruncated
          ? drain.advanceTo
          : String(mb.highestModseq ?? 0n);
        newFolders[folder] = {
          uidValidity: truncated || flagsTruncated ? (prev?.uidValidity ?? "0") : String(curUidValidity),
          uidNext: truncated ? (prev?.uidNext ?? 0) : mb.uidNext,
          highestModseq: flagsTruncated || !caps.condstore ? (prev?.highestModseq ?? "0") : advanceTo,
        };
      } finally {
        lock.release();
      }
    }

    const correlated = correlateMoves(creates, deletes);
    return {
      // `ownAuthored` is stamped HERE, on pure creates only, and not inside `correlateMoves`.
      // A create the correlator paired with a delete is a MOVE into Sent — the
      // user filed an existing message there from another folder — and the existing
      // `adopt_external` path is the right answer for that. Tagging it would route it through
      // `own_copy`, which writes nothing, leaving the row pointing at a UID that no longer
      // exists.
      creates: correlated.creates.map((c): Change => ({
        type: "create",
        locator: { folder: c.folder, ref: makeRef(c.uidValidity, c.uid) },
        raw: c.raw,
        seen: c.seen,
        // The server's receive time, for the pipeline's screening cutoff. Only on pure creates:
        // a correlated MOVE is the user filing an existing message and never reaches the gate.
        ...(c.internalDate ? { internalDate: c.internalDate } : {}),
        ...(sentFolder !== null && c.folder === sentFolder ? { ownAuthored: true } : {}),
        // ── PASSIVE PRESENCE, STAMPED BY THE ONLY COMPONENT THAT KNOWS ──────────────────────
        //
        // `Change.passive` is on `ownAuthored`'s precedent and for the identical reason: the
        // pipeline cannot derive it, because "is this one of the customer's own folders" is a fact
        // about the SERVER's folder inventory and this class is the only thing that has LISTed it.
        // A pipeline that guessed from the folder NAME would have to re-implement
        // `passiveFolderExclusion` and would get the Sent folder wrong on every server that
        // advertises no SPECIAL-USE.
        //
        // Stamped on pure creates only, exactly like `ownAuthored`. A correlated MOVE into a
        // passive folder IS the customer filing mail we already hold, and `adopt_external` is
        // already the right answer for that: it follows their hand to the new folder and writes
        // `last_set_by = 'external'` itself.
        ...(passiveFolders.has(c.folder) ? { passive: true } : {}),
      })),
      moves: correlated.moves,
      flagChanges,
      deletes: correlated.deletes.map((d): Change => ({ type: "delete", locator: { folder: d.folder, ref: makeRef(d.uidValidity, d.uid) } })),
      newCursor: { folders: newFolders },
      hasBacklog,
      unanswered,
    };
  }

  /**
   * Re-read NAMED UIDs of one folder. See {@link MailboxAdapter.fetchByUid} for WHY; the notes
   * here are about the mechanics.
   *
   * ── EVERY NAMED UID GETS AN ANSWER ─────────────────────────────────────────────────────────
   *
   * The caller is closing a durable record per UID, so `creates ∪ absent ∪ oversize` is exactly the
   * set it asked about. `absent` is derived by subtraction rather than by trusting the server to say
   * anything about a UID it no longer holds — RFC 3501 lets a `UID FETCH` simply return fewer
   * messages, with no error and no per-UID signal.
   *
   * ── IT DOES NOT GO THROUGH `fetchCapped`, DELIBERATELY ─────────────────────────────────────
   *
   * `fetchCapped` is the memory bound of the whole worker and it earns that with two things this
   * call must not touch: the shared per-cycle budget, and `arrivalDatesFor`'s cache, which PRUNES
   * itself to the candidate set it is handed. Passing a handful of retry UIDs through it would evict
   * the drain's date cache and make the next `changesSince` re-fetch metadata for the entire unknown
   * set — quadratic behaviour bought for nothing, since a bounded, caller-capped list of UIDs needs
   * neither a budget nor an ordering.
   *
   * ── THE SIZE PRE-CHECK IS NOT AN OPTIMISATION EITHER ───────────────────────────────────────
   *
   * `RFC822.SIZE` first, and a UID over `opts.maxBytes` is reported without its body being pulled.
   * The reachable failures are `mime_too_large` and `mime_unparseable`, both deterministic in the
   * raw bytes; a standing oversize message would otherwise transfer its whole self on every deploy
   * to be refused by `normalizeMime` for the same reason as last time.
   */
  async fetchByUid(
    folder: string, uids: readonly number[], opts: FetchByUidOptions = {},
  ): Promise<TargetedFetch> {
    const wanted = [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0);
    // The Sent path BEFORE the lock: `findSentForScan` may issue LIST, and imapflow's mailbox lock
    // is not re-entrant. Resolved DIRECTLY rather than through `foldersToScan`, whose LIST-STATUS
    // arm re-lists the whole folder inventory on every call — a caller that fetches in chunks
    // (the junk-restore pass, review round 2) was paying one full LIST per four messages for a
    // value `findSentForScan` memoises for the connection's life. The watched-set guard is
    // `foldersToScan`'s own, byte for byte, so the `ownAuthored` stamp below is unchanged.
    const nowMs = Date.now();
    // A POSITIVE resolution the adapter already holds OUTRANKS a cached negative: the scan or
    // the send path can learn the Sent folder inside the TTL window, and a retry from that
    // folder must reach `planChange` WITH the `ownAuthored` stamp — un-stamped, the user's own
    // outbound mail routes as inbound (round 4's finding). `findSentForScan` answers a known
    // positive from its fields without a LIST, so honouring it costs nothing.
    const knownPositive = this.sentFolder ?? this.scanSentFolder;
    let sent: string | null;
    if (knownPositive !== null || this.targetedSent === null
      || nowMs - this.targetedSent.at > ImapAdapter.TARGETED_SENT_TTL_MS) {
      const resolvedSent = await this.findSentForScan();
      sent = resolvedSent !== null && !(WATCHED_FOLDERS as readonly string[]).includes(resolvedSent)
        ? resolvedSent : null;
      this.targetedSent = { value: sent, at: nowMs };
    } else {
      sent = this.targetedSent.value;
    }
    if (wanted.length === 0) return { uidValidity: "0", creates: [], absent: [], oversize: [] };

    const lock = await this.client.getMailboxLock(this.toServerPath(folder));
    try {
      const mb = this.client.mailbox as MailboxObject;
      const curUidValidity = mb.uidValidity;
      const oversize: number[] = [];
      const take: number[] = [];
      const seen = new Set<number>();
      for await (const m of this.client.fetch(
        [...wanted], { uid: true, size: true }, { uid: true },
      )) {
        seen.add(m.uid);
        const size = typeof m.size === "number" ? m.size : 0;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) oversize.push(m.uid);
        else take.push(m.uid);
      }

      const creates: Change[] = [];
      if (take.length > 0) {
        for await (const m of this.client.fetch(
          take,
          { uid: true, flags: true, envelope: true, source: true, internalDate: true },
          { uid: true },
        )) {
          creates.push({
            type: "create",
            locator: { folder, ref: makeRef(curUidValidity, m.uid) },
            raw: (m.source ?? Buffer.alloc(0)) as Buffer,
            seen: m.flags?.has("\\Seen") ?? false,
            // Same stamp, same guard as `changesSince` — a re-read must reach the gate with the
            // same age evidence the first read did, or a retry would route differently.
            ...(m.internalDate instanceof Date && Number.isFinite(m.internalDate.getTime())
              ? { internalDate: m.internalDate }
              : {}),
            // The SAME stamp `changesSince` applies, from the same resolution. Omitting it would
            // route a retried Sent message through `new` instead of `own_copy` and file the user's
            // own reply as an inbound message.
            ...(sent !== null && folder === sent ? { ownAuthored: true } : {}),
          });
        }
      }
      // ── A UID THE BODY FETCH WITHHELD IS NOT NECESSARILY GONE ──────────────────────────────
      //
      // This used to read "a UID in `take` that the body fetch did not answer for was expunged
      // between the two commands", and let the subtraction below drop it into `absent`. The
      // consequence was not a lost retry but a DURABLE LIE: `sync.ts` closes an `absent` UID as
      // `gone_from_server` and deletes its failure row, so a message that is still sitting on the
      // server stops being owed by anything.
      //
      // The premise is false on a real server. iCloud answers `RFC822.SIZE` for a message whose
      // `Message-ID` is a quoted string and then omits that same message from any fetch requesting
      // ENVELOPE — so the UID is in `seen`, absent from `creates`, and demonstrably not expunged.
      // See the matching recovery in `fetchCapped`, which is where this shape was first measured.
      //
      // So ask again without the field, exactly as the batch path does. Only a UID that is still
      // missing after the envelope-free retry is treated as gone — and that one really did fail to
      // answer two different commands, which is the strongest evidence this protocol offers.
      const answered = new Set(creates.map((c) => parseRef(c.locator.ref).uid));
      const withheld = take.filter((u) => !answered.has(u));
      if (withheld.length > 0) {
        for await (const m of this.client.fetch(
          withheld,
          { uid: true, flags: true, source: true, internalDate: true },
          { uid: true },
        )) {
          creates.push({
            type: "create",
            locator: { folder, ref: makeRef(curUidValidity, m.uid) },
            raw: (m.source ?? Buffer.alloc(0)) as Buffer,
            seen: m.flags?.has("\\Seen") ?? false,
            ...(m.internalDate instanceof Date && Number.isFinite(m.internalDate.getTime())
              ? { internalDate: m.internalDate }
              : {}),
            ...(sent !== null && folder === sent ? { ownAuthored: true } : {}),
          });
        }
      }
      const returned = new Set(creates.map((c) => parseRef(c.locator.ref).uid));
      return {
        uidValidity: String(curUidValidity),
        creates,
        absent: wanted.filter((u) => !seen.has(u) || (!returned.has(u) && !oversize.includes(u))),
        oversize,
      };
    } finally {
      lock.release();
    }
  }

  /**
   * The fingerprint of a message's raw bytes, or null when they could not be parsed.
   *
   * Used ONLY by {@link move}'s no-COPYUID fallback to tell our message from another that shares
   * its Message-ID. A parse failure is null rather than a throw: a candidate we cannot fingerprint
   * simply is not a match, which is the safe direction — it produces a {@link MoveVerifyError}
   * instead of a wrong locator.
   */
  private static async fingerprintOf(raw: Buffer | string | null | undefined): Promise<string | null> {
    if (raw == null) return null;
    try {
      return messageFingerprint(await normalizeMime(raw));
    } catch {
      return null;
    }
  }

  /**
   * Everything the destination can tell us about a message we are about to put there, read under
   * ONE destination lock: the UID validity, the UIDs that share the message's `Message-ID`, and
   * the subset of those that are byte-for-byte OUR message by full fingerprint.
   *
   * `candidates` and `matches` are returned separately because the gap between them is the whole
   * signal. Candidates sharing a `Message-ID` mean nothing — a `Message-ID` is chosen by whoever
   * sent the mail, so anyone may name one the mailbox already holds. A fingerprint match covers
   * every field a sender chooses, so it is the only thing that identifies a message.
   *
   * With `sourceFingerprint` null nothing can be verified and `matches` is empty by construction,
   * which is the safe direction at both call sites: it produces a refusal rather than a guess.
   */
  private async destinationLook(
    dstPath: string, messageId: string | null, sourceFingerprint: string | null,
  ): Promise<{ uidValidity: bigint; candidates: number[]; matches: number[] }> {
    const lock = await this.client.getMailboxLock(dstPath);
    try {
      const uidValidity = (this.client.mailbox as MailboxObject).uidValidity;
      const inner = messageId ? messageId.replace(/[<>]/g, "").trim() : "";
      const found = inner
        ? await this.client.search({ header: { "message-id": inner } }, { uid: true })
        : [];
      const candidates = Array.isArray(found) ? found : [];
      const matches: number[] = [];
      if (sourceFingerprint !== null) {
        for (const candidate of candidates) {
          const fetched = await this.client.fetchOne(
            String(candidate), { uid: true, source: true }, { uid: true },
          );
          if (!fetched) continue;
          const fp = await ImapAdapter.fingerprintOf(fetched.source as Buffer | undefined);
          if (fp !== null && fp === sourceFingerprint) matches.push(candidate);
        }
      }
      return { uidValidity, candidates, matches };
    } finally {
      lock.release();
    }
  }

  /**
   * The source message's fingerprint, fetched on its own.
   *
   * Only reached when the destination pre-check found candidates and the first probe did not pull
   * the body — a server advertising UIDPLUS, where the bytes are normally never needed. Paying a
   * body fetch here keeps the common path (no candidates at the destination) at one SEARCH.
   *
   * A vanished source answers null rather than throwing: the caller is mid-decision and its own
   * existence probe already ran, so the honest answer is "nothing to compare", which refuses.
   */
  private async sourceFingerprintOf(srcPath: string, uid: number): Promise<string | null> {
    const lock = await this.client.getMailboxLock(srcPath);
    try {
      const one = await this.client.fetchOne(
        String(uid), { uid: true, source: true }, { uid: true },
      );
      return one ? await ImapAdapter.fingerprintOf(one.source as Buffer | undefined) : null;
    } finally {
      lock.release();
    }
  }

  /**
   * ── WHY THIS FUNCTION IS ORDERED THE WAY IT IS ───────────────────────────────────────────────
   *
   * Two defects, both in the no-COPYUID fallback, and both of them silent.
   *
   * **It adopted the attacker's bytes.** The destination UID was learned by
   * `search({ header: { "message-id": inner } })` and then `Math.max(...found)`. A Message-ID is
   * chosen by whoever sent the mail, so two messages in the destination can share one — a stranger
   * only has to name the id of a message the user holds. `Math.max` then takes the HIGHEST UID,
   * which is the most recently delivered one, which is the attacker's. The row's locator points at
   * their bytes, and `GET /attachments/:id` and reply quoting both read through it.
   * So the candidate set is now verified by FULL FINGERPRINT — every field a sender chooses, not
   * one of them — and ambiguity raises {@link MoveVerifyError} rather than picking a winner.
   *
   * **It expunged the source before it knew where the copy went.** `messageDelete` ran inside
   * phase 1, before the verify, so a `MoveVerifyError` left the message already gone from the
   * source AND the database pointing at a UID that never existed. The delete now runs in phase 3,
   * after a destination UID is established, so a failed verify leaves the source in place: a
   * duplicate on the server, which the next `changesSince` sees and reconciles, instead of a
   * message that is nowhere we can name.
   *
   * The MOVE branch cannot be reordered — `MOVE` is atomic and the source is gone the moment it
   * returns — and does not need to be: it is the branch that has no separate delete. A verify
   * failure there leaves the row on its old locator and the next cycle re-observes the message in
   * the destination, where `correlateMoves` pairs it with the source's disappearance and the
   * ordinary adoption path (with real evidence) applies. Self-healing, and unchanged.
   *
   * The source bytes are fetched ONLY when a fingerprint verify might be needed (`!caps.uidplus`),
   * or when the pre-check below finds something at the destination worth telling apart.
   * Pulling `source: true` on every move would put a body fetch behind every reconcile pass.
   *
   * ── AND WHY IT NOW LOOKS AT THE DESTINATION BEFORE IT WRITES ANYTHING ────────────────────────
   *
   * COPY-then-EXPUNGE is two operations across a network boundary, so there is a window in which
   * the copy has landed and the source has not gone. A crash, a dropped connection or a refused
   * EXPUNGE in that window leaves the message in both folders — and the retry is what turns that
   * from a duplicate into a disaster. Without a pre-check the retry COPIES AGAIN: the destination
   * gains a second identical message every cycle, and the verify below, which requires exactly one
   * fingerprint match, then finds several and refuses for ever. One extra copy per cycle,
   * permanently, from a fault that produced a single duplicate.
   *
   * So the destination is read FIRST, and what is found there decides whether a write is needed
   * at all:
   *
   *  · **Exactly one fingerprint match already there** — this move's copy has already landed and
   *    only the expunge is outstanding. Skip the COPY entirely and go straight to it. This is what
   *    makes the operation idempotent, and it is the only path on which a repeated move converges
   *    on exactly one surviving message.
   *  · **Two or more** — the destination holds messages that cannot be told apart. Refuse, WITHOUT
   *    copying: adding another would deepen an ambiguity we already cannot resolve.
   *  · **Candidates present but the source cannot be fingerprinted** — same refusal, same reason
   *    as the verify below. An unreadable source cannot be matched against anything, and copying
   *    blind is how the amplifying loop starts.
   *  · **No candidates, or candidates that are not ours** — nothing of ours is there, so copy as
   *    normal. A stranger who names a `Message-ID` the mailbox already holds does not get to block
   *    a move; the fingerprint separates them.
   *
   * **This is needed on a UIDPLUS server too, which is the easy thing to get wrong.** COPYUID
   * tells us where a new copy landed; it does not stop one being made. UIDPLUS and MOVE are also
   * separate capabilities, so a server can advertise the first and still take the COPY branch —
   * exactly the branch with the interruptible window. Gating the pre-check on `!caps.uidplus`
   * would leave the whole defect in place on real servers while every test passed.
   *
   * ── WHAT THE EXPUNGE IS ALLOWED TO ASSUME, STATED PLAINLY ───────────────────────────────────
   *
   * The source is only ever removed while a destination UID is in hand whose FULL FINGERPRINT
   * equals the source's — the `Message-ID`, author, recipients, subject, date, both body hashes
   * and every attachment's content hash. Everything the reader of a message sees is therefore
   * preserved by construction, which is why adopting an already-present copy is safe rather than
   * merely convenient. What is not covered is transport metadata the fingerprint deliberately
   * ignores — `Received` chains, `Authentication-Results`, `X-` headers — so on the adopt path
   * those belong to the copy that was already at the destination. That is a real residue and it
   * is bounded: an authentication verdict is read once, from the bytes ingested at first sight,
   * and is never re-derived from a surviving copy.
   */
  async move(
    locator: NativeLocator, toFolder: string,
    opts: {
      /**
       * REFUSE THE MOVE WHEN THE SOURCE FOLDER'S UIDVALIDITY NO LONGER MATCHES THE REF'S.
       *
       * A UID names a message only within one UIDVALIDITY epoch: a folder that was deleted and
       * recreated re-issues low UIDs, so a stale ref can silently address a DIFFERENT message.
       * With this set, a ref whose epoch (the half of `ref` before the `:`) is real (non-"0")
       * and differs from the opened source folder's current UIDVALIDITY throws
       * {@link MessageGoneError} — the same honest "no longer what you looked at" signal an
       * expunge produces — instead of moving whatever now wears that number.
       *
       * OPT-IN, not the default, deliberately: the Junk-window rescue sets it (its refs come
       * from a live list of a folder ohmail never watches, so staleness is the NORMAL hazard
       * there), while the worker's reconciler keeps its own epoch machinery and its own
       * conventions — including test fixtures and cold-drain sentinels whose refs carry a
       * placeholder epoch — and must not change behaviour under a guard written for a
       * different caller.
       */
      requireEpoch?: boolean;
    } = {},
  ): Promise<NativeLocator> {
    const caps = await this.capabilities();
    const { uid, uidValidity: refEpoch } = parseRef(locator.ref);
    const srcPath = this.toServerPath(locator.folder);
    const dstPath = this.toServerPath(toFolder);

    let messageId: string | null = null;
    let sourceFingerprint: string | null = null;
    let dstUidValidity: bigint | null = null;
    let dstUid: number | null = null;
    // The source still exists and is owed an expunge once the destination UID is known. True on
    // the COPY branch, and true on the adopt path below — where nothing was written at all, so the
    // source is necessarily still there. Only an atomic MOVE leaves it already gone.
    let sourceAwaitingDelete = false;

    /**
     * The epoch guard, called UNDER EVERY SOURCE LOCK this move takes — see `opts.requireEpoch`.
     * Once is not enough: the locks are released between steps (imapflow locks are not
     * re-entrant across the destination look), so a folder deleted and recreated mid-move would
     * pass a step-1-only check and still reach `messageMove`/`messageDelete` addressing a
     * recycled UID. Each re-acquisition re-opens the mailbox, so each check reads the epoch the
     * NEXT command will actually run against.
     */
    const assertEpoch = (): void => {
      if (!opts.requireEpoch) return;
      const mb = this.client.mailbox as MailboxObject | false;
      const current = mb && mb.uidValidity != null ? String(mb.uidValidity) : "0";
      if (refEpoch !== "0" && current !== "0" && refEpoch !== current) {
        throw new MessageGoneError(locator);
      }
    };

    // Step 1: under the SOURCE lock — probe existence and capture identity. NOTHING is written
    // here any more; the decision to write comes after the destination has been read.
    {
      const lock = await this.client.getMailboxLock(srcPath);
      try {
        assertEpoch();
        const one = await this.client.fetchOne(
          String(uid),
          // The body is pulled only when the fallback could need it to tell two candidates apart.
          { uid: true, envelope: true, ...(caps.uidplus ? {} : { source: true }) },
          { uid: true },
        );
        if (!one) throw new MessageGoneError(locator);
        messageId = one.envelope?.messageId ?? null;
        sourceFingerprint = await ImapAdapter.fingerprintOf(one.source as Buffer | undefined);
      } finally {
        lock.release();
      }
    }

    // Step 2: the destination PRE-CHECK. Separate lock, after releasing the source lock —
    // imapflow locks are not re-entrant on one connection.
    let look = await this.destinationLook(dstPath, messageId, sourceFingerprint);
    // Something is there and we did not pull the body. Pay for it now and look again: this is the
    // rare path by construction, so the common move still costs one SEARCH and no fetch.
    if (look.candidates.length > 0 && sourceFingerprint === null) {
      sourceFingerprint = await this.sourceFingerprintOf(srcPath, uid);
      look = await this.destinationLook(dstPath, messageId, sourceFingerprint);
    }
    dstUidValidity = look.uidValidity;

    // Ambiguous, or unverifiable with something present. Refuse BEFORE writing — see the header.
    if (look.matches.length > 1) throw new MoveVerifyError(locator, toFolder);
    if (look.candidates.length > 0 && sourceFingerprint === null) {
      throw new MoveVerifyError(locator, toFolder);
    }

    if (look.matches.length === 1) {
      // Our copy is already there. The expunge is all that is outstanding.
      dstUid = look.matches[0]!;
      sourceAwaitingDelete = true;
    } else {
      // Step 3: nothing of ours at the destination, so write. Under the SOURCE lock again —
      // and under the epoch guard again, because the lock was released in between.
      const lock = await this.client.getMailboxLock(srcPath);
      try {
        assertEpoch();
        if (caps.move) {
          const res = await this.client.messageMove([uid], dstPath, { uid: true });
          if (res && typeof res !== "boolean") {
            dstUidValidity = res.uidValidity ?? dstUidValidity;
            dstUid = caps.uidplus ? (res.uidMap?.get(uid) ?? null) : null;
          }
        } else {
          const res = await this.client.messageCopy([uid], dstPath, { uid: true });
          if (res && typeof res !== "boolean") {
            dstUidValidity = res.uidValidity ?? dstUidValidity;
            dstUid = caps.uidplus ? (res.uidMap?.get(uid) ?? null) : null;
          }
          // NOT deleted here. See the header: the expunge is last, after the verify.
          sourceAwaitingDelete = true;
        }
      } finally {
        lock.release();
      }

      // Step 4 (fallback): no COPYUID → find the copy in the destination and PROVE it is ours.
      // EXACTLY ONE. Zero means the copy is not visible yet (or is not ours); more than one means
      // the destination holds two messages we cannot distinguish, which is the ambiguity
      // `Math.max` used to resolve in the attacker's favour.
      if (dstUid == null || dstUidValidity == null) {
        const after = await this.destinationLook(dstPath, messageId, sourceFingerprint);
        dstUidValidity = after.uidValidity;
        dstUid = after.matches.length === 1 ? after.matches[0]! : null;
      }
    }

    if (dstUid == null || dstUidValidity == null) throw new MoveVerifyError(locator, toFolder);

    // Step 5: the destination UID is established, so the source may go. A failure here leaves a
    // duplicate rather than a dangling locator, and the next reconcile pass retries the whole
    // move — which the pre-check above now makes convergent instead of amplifying.
    if (sourceAwaitingDelete) {
      const lock = await this.client.getMailboxLock(srcPath);
      try {
        assertEpoch(); // the expunge is the destructive half — never against a recycled UID
        await this.client.messageDelete([uid], { uid: true }); // \Deleted + EXPUNGE on source
      } finally {
        lock.release();
      }
    }
    return { folder: toFolder, ref: makeRef(dstUidValidity, dstUid) };
  }

  /**
   * File a GROUP of messages that share a source folder and a destination, in a handful of
   * round trips instead of a handful PER MESSAGE. See {@link MailboxAdapter.moveMany} for the
   * contract and {@link FILING_BATCH_MAX} for why the caller must still chunk.
   *
   * ── THE COST THIS EXISTS TO REMOVE, MEASURED ───────────────────────────────────────────────
   *
   * {@link move} is five IMAP commands per message, and three of them are mailbox SELECTs that no
   * adapter-level log ever showed: `getMailboxLock` re-SELECTs whenever the path changes, and the
   * sequence source → destination → source changes it twice. Against real hosts that came to
   * 0.30–0.51 s per message — a screening session of 1 137 decisions took 583 seconds of IMAP
   * time, during which the worker's serial cycle served no other mailbox. The work itself is
   * trivial; the round trips are the whole bill.
   *
   * A batch pays the same five commands ONCE for up to {@link FILING_BATCH_MAX} messages: one
   * FETCH of the whole UID set, one SEARCH at the destination, one `UID MOVE` of the whole set.
   *
   * ── WHAT IT REFUSES TO DO, AND WHY THAT IS THE POINT ───────────────────────────────────────
   *
   * This is a fast path, not a second implementation of {@link move}. It answers
   * `batched: false` — and writes nothing at all — whenever the group is not one it can prove is
   * equivalent to moving each message on its own:
   *
   *  · **The server lacks MOVE or UIDPLUS.** Without MOVE there is a COPY/EXPUNGE window per
   *    message; without UIDPLUS there is no `COPYUID`, so the destination UIDs would have to be
   *    recovered by fingerprint, which is the per-message work this function exists to avoid.
   *  · **Anything at the destination shares a Message-ID with anything in the group.** This is the
   *    pre-check {@link move} performs, asked once for the whole group instead of once per
   *    message. A hit means at least one member needs the fingerprint verify, the adopt path or a
   *    refusal — all three per-message decisions — so the whole chunk goes back to {@link move}.
   *    Note the asymmetry is deliberate: a MISS proves no member has a candidate, which is the
   *    branch on which {@link move} does a plain move and nothing else.
   *  · **`COPYUID` did not name every message.** A partial map cannot say where the unnamed ones
   *    landed, and a locator we cannot name is the failure `move`'s verify was rewritten to
   *    prevent.
   *
   * The refusal costs at most the three commands already spent; it never leaves a half-filed
   * group, because it happens strictly BEFORE the `UID MOVE`.
   *
   * ── CRASH AND PARTIAL FAILURE ──────────────────────────────────────────────────────────────
   *
   * `UID MOVE` is atomic per message and the caller commits nothing until this returns, so the
   * states a crash can leave are exactly the states {@link move} can leave, and they resolve the
   * same way: a message the server moved but the database still calls pending is GONE from the
   * source, so the next pass's FETCH does not return its UID, it is reported in `gone`, the
   * caller leaves the row pending, and `changesSince` adopts the completed move. A message the
   * server did not move is still in the source and is filed by the next batch. Nothing here can
   * produce a second copy: unlike COPY, `MOVE` has no window in which both exist.
   *
   * ── WHY THE MESSAGE-ID SEARCH IS ONE COMMAND AND NOT `n` ───────────────────────────────────
   *
   * `OR HEADER MESSAGE-ID a HEADER MESSAGE-ID b …`, which imapflow builds as a nested binary
   * tree. At {@link FILING_BATCH_MAX} ids the command is a few kilobytes — well inside what
   * servers accept — and it is why the chunk size is a constant here rather than "as many as are
   * pending". A group of 1 137 in one command would be ~70 KB and would be refused by hosts that
   * cap the command line, which is a failure that only appears on large backlogs, i.e. exactly
   * the case this path is for.
   *
   * Members whose envelope carries NO Message-ID contribute nothing to the search, which matches
   * {@link move} exactly: it computes `candidates` as the empty set for a null Message-ID rather
   * than searching for one.
   */
  async moveMany(
    locators: readonly NativeLocator[], toFolder: string,
  ): Promise<MoveManyResult> {
    const empty: MoveManyResult = { batched: false, moved: new Map(), gone: [] };
    if (locators.length === 0) return { batched: true, moved: new Map(), gone: [] };
    if (locators.length > FILING_BATCH_MAX) {
      throw new Error(`moveMany: ${locators.length} exceeds FILING_BATCH_MAX (${FILING_BATCH_MAX}); the caller must chunk`);
    }
    const srcFolder = locators[0]!.folder;
    if (locators.some((l) => l.folder !== srcFolder)) {
      throw new Error("moveMany: every locator must share one source folder");
    }
    if (srcFolder === toFolder) {
      throw new Error("moveMany: source and destination are the same folder");
    }

    const caps = await this.capabilities();
    // No atomic MOVE ⇒ a per-message COPY/EXPUNGE window. No UIDPLUS ⇒ no COPYUID, so the
    // destination UIDs would have to be recovered per message by fingerprint. Either way the
    // per-message path is the correct one and this refuses before touching anything.
    if (!caps.move || !caps.uidplus) return empty;

    const srcPath = this.toServerPath(srcFolder);
    const dstPath = this.toServerPath(toFolder);
    const wanted = new Map<number, NativeLocator>();
    for (const loc of locators) wanted.set(parseRef(loc.ref).uid, loc);

    // Step 1: the existence probe and the Message-IDs, for the whole set, under one source lock.
    const present = new Map<number, string | null>();
    {
      const lock = await this.client.getMailboxLock(srcPath);
      try {
        const rows = await this.client.fetchAll(
          [...wanted.keys()].join(","), { uid: true, envelope: true }, { uid: true },
        );
        for (const r of rows) {
          if (!wanted.has(r.uid)) continue;         // a server answering outside the set it was asked
          present.set(r.uid, r.envelope?.messageId ?? null);
        }
      } finally {
        lock.release();
      }
    }
    // A UID the server did not return is GONE — the batch's {@link MessageGoneError}, reported
    // rather than thrown because one vanished message must not cost the other forty-nine.
    const gone = [...wanted.keys()].filter((uid) => !present.has(uid)).map((uid) => wanted.get(uid)!);
    if (present.size === 0) return { batched: true, moved: new Map(), gone };

    // Step 2: the destination pre-check, asked ONCE for the whole group. See the header.
    const ids = [...present.values()]
      .filter((id): id is string => typeof id === "string" && id.trim() !== "")
      .map((id) => id.replace(/[<>]/g, "").trim())
      .filter((id) => id !== "");
    let dstUidValidity: bigint;
    {
      const lock = await this.client.getMailboxLock(dstPath);
      try {
        dstUidValidity = (this.client.mailbox as MailboxObject).uidValidity;
        if (ids.length > 0) {
          const found = await this.client.search(
            ids.length === 1
              ? { header: { "message-id": ids[0]! } }
              : { or: ids.map((id) => ({ header: { "message-id": id } })) },
            { uid: true },
          );
          // ANY hit sends the whole chunk back to the per-message path — see the header.
          if (Array.isArray(found) && found.length > 0) return empty;
        }
      } finally {
        lock.release();
      }
    }

    // Step 3: one `UID MOVE` for the set. Atomic per message, so there is no window in which a
    // message exists in both folders and no expunge of our own to get wrong.
    const uids = [...present.keys()];
    const moved = new Map<string, NativeLocator>();
    {
      const lock = await this.client.getMailboxLock(srcPath);
      try {
        const res = await this.client.messageMove(uids, dstPath, { uid: true });
        if (!res || typeof res === "boolean") return empty;
        const map = res.uidMap;
        // A map that does not name every message cannot say where the unnamed ones landed. The
        // per-message path can recover that by fingerprint; this one refuses instead — and it may,
        // because the messages HAVE moved and the caller commits nothing, so the next pass sees
        // them gone from the source and adopts them through `changesSince`.
        if (!map || map.size !== uids.length) return empty;
        const validity = res.uidValidity ?? dstUidValidity;
        for (const uid of uids) {
          const dstUid = map.get(uid);
          if (dstUid == null) return empty;
          moved.set(wanted.get(uid)!.ref, { folder: toFolder, ref: makeRef(validity, dstUid) });
        }
      } finally {
        lock.release();
      }
    }
    return { batched: true, moved, gone };
  }

  /**
   * Write `\Seen` on one message. See {@link MailboxAdapter.setFlags} for the
   * contract; the notes here are about this implementation.
   *
   * ONE `getMailboxLock` around the whole thing. `move` needs two locks because it touches two
   * folders; this touches one, and imapflow's locks are not re-entrant on a single connection,
   * so an extra lock would deadlock the adapter against itself.
   *
   * **THE EXISTENCE PROBE IS NOT BELT-AND-BRACES.** The obvious implementation trusts the STORE's
   * own return value — and it is wrong on a real server: GreenMail answers `true` to a
   * `UID STORE` whose UID set matched nothing at all — measured against it, not assumed. RFC
   * 3501 permits it: a UID command against a vanished UID is a successful no-op, not an error.
   * So `!ok` alone would have reported success for a message this connection never touched, the
   * reconciler would have flipped `observed_seen` to a value no server ever confirmed, and the
   * row would read as converged forever while the user's mailbox stayed unread. `fetchOne`
   * costs one round trip under a lock we already hold and turns that into the
   * {@link MessageGoneError} the reconciler's skip-and-retry branch is written for — the same
   * probe, for the same reason, that `move` performs before it moves anything.
   *
   * The `!ok` check stays as a second signal, for servers that DO report the failure.
   */
  async setFlags(locator: NativeLocator, flags: { seen: boolean }): Promise<void> {
    const { uid } = parseRef(locator.ref);
    const lock = await this.client.getMailboxLock(this.toServerPath(locator.folder));
    try {
      const present = await this.client.fetchOne(String(uid), { uid: true }, { uid: true });
      if (!present) throw new MessageGoneError(locator);
      const ok = flags.seen
        ? await this.client.messageFlagsAdd([uid], ["\\Seen"], { uid: true })
        : await this.client.messageFlagsRemove([uid], ["\\Seen"], { uid: true });
      if (!ok) throw new MessageGoneError(locator);
    } finally {
      lock.release();
    }
  }

  async watch(onSignal: () => void): Promise<() => Promise<void>> {
    const handler = (): void => onSignal();
    this.client.on("exists", handler);
    this.client.on("flags", handler);
    this.client.on("expunge", handler);
    // Open INBOX and leave it open; imapflow auto-idles (disableAutoIdle defaults false) and renews IDLE.
    await this.client.mailboxOpen(this.toServerPath("INBOX"));
    return async () => {
      this.client.removeListener("exists", handler);
      this.client.removeListener("flags", handler);
      this.client.removeListener("expunge", handler);
    };
  }

  /**
   * The Sent folder for a WRITE. **CREATING ONE IS THE LAST RESORT, AFTER BOTH LOOKUPS FAIL.**
   *
   * ── WHY THE ORDER IS THE WHOLE METHOD ───────────────────────────────────────────────────
   *
   * This used to be SPECIAL-USE, then `mailboxCreate("Sent")`. Creating a folder is the most
   * destructive thing anything on this path can do: it puts a directory into somebody's real
   * mailbox, beside the one they already use, which their own client does not show as Sent —
   * in a product whose promise is to organize a mailbox in place and leave it intact. It was
   * the FIRST fallback. Meanwhile {@link findSentForScan} has matched {@link SENT_BY_NAME}
   * for some time, so one adapter could find `Sent Mail` to READ from and create `Sent` to
   * WRITE into. The read path was right; this one now uses the same rule before it reaches for
   * CREATE.
   *
   * ── `ListResponse.specialUse` IS NOT THE SERVER'S FLAG, AND THAT IS NOT OUR GUARANTEE ───
   *
   * Measured against GreenMail 2.1.3 (`IDLE IMAP4rev1 LITERAL+ MOVE QUOTA SORT
   * UIDPLUS` — no SPECIAL-USE): a folder named `Sent Messages` came back as
   * `{ specialUse: "\Sent", specialUseSource: "name" }`. imapflow resolves the field itself —
   * the server's flag when the connection advertises SPECIAL-USE or XLIST, otherwise a guess
   * against a 103-name localized table (`imapflow/lib/special-use.js`). That table is why the
   * old code had not yet damaged a real mailbox, and it is not a property of this repo:
   * `imapflow` is pinned `^1.0.164` and resolves to 1.5.0, so the guarantee was a caret range's
   * to withdraw. `Sent Mail` — Gmail's own name for the folder, and what a mailbox migrated off
   * Gmail keeps — is absent from that table and present in `SENT_BY_NAME`, so it was live.
   *
   * The name match is deliberately cached onto `this.sentFolder`, unlike the scan's: this IS
   * the send path, so deciding where sent mail is filed is exactly its business.
   */
  private async resolveSentFolder(): Promise<string> {
    if (this.sentFolder) return this.sentFolder;
    const list = await this.client.list();
    const special = this.findSent(list);
    if (special) { this.sentFolder = special; return special; }
    // Same filter as the read path: a `\Noselect` node cannot be APPENDed to, and treating one
    // as the Sent folder turns "this server files sent mail oddly" into a failed send.
    const byName = list.find(
      (f) => !(f.flags?.has("\\Noselect") ?? false) && SENT_BY_NAME.test(this.toCanonical(f.path)),
    );
    if (byName) { this.sentFolder = this.toCanonical(byName.path); return this.sentFolder; }
    // Nothing to reuse. Compare CANONICALLY and case-insensitively before creating — the old
    // check was `f.path === "Sent"` against the raw server path, so a server that answers
    // `sent` would have been given a second one.
    const fallback = "Sent";
    if (!list.some((f) => this.toCanonical(f.path).toLowerCase() === fallback.toLowerCase())) {
      try { await this.client.mailboxCreate(this.toServerPath(fallback)); } catch { /* already exists */ }
    }
    this.sentFolder = fallback;
    return fallback;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.transporter) throw new Error("send(): SMTP not configured (ImapConfig.smtp is required)");
    const messageId = msg.messageId ?? `<${randomUUID()}@${this.config.sentDomain ?? "trafficflow.ch"}>`;
    // ONE options object drives BOTH the SMTP delivery and the Sent-folder copy, on purpose: the
    // envelope nodemailer computes for `sendMail` and the raw bytes `buildRaw` appends to Sent are
    // built from the same `bcc`, so a bcc recipient is on the RCPT list AND absent from the Sent
    // copy's headers — there is no way for the two to disagree about who was blind-copied.
    const mail = outboundToMail(msg, messageId);

    // OAUTH SMTP IS A PER-MESSAGE OVERRIDE, NOT TRANSPORTER STATE. The transporter (built at
    // `connect()`) carries NO static auth for an OAuth config — see `smtpTransportOptions`, whose
    // `auth` is undefined when `smtp.auth` is — because a transporter outlives any access token. A
    // token is fetched HERE, at send time, and handed to nodemailer as message-level auth
    // (`mail.data.auth`, honoured by `smtp-transport` `getAuth`), which issues XOAUTH2 for this one
    // send. A password config leaves the transporter's static auth in place and adds nothing.
    if (isOAuthAuth(this.config.auth)) {
      const accessToken = await this.config.auth.fetchAccessToken();
      (mail as MailWithOAuth).auth = { type: "OAuth2", user: this.config.auth.user, accessToken };
    }

    await this.transporter.sendMail(mail);
    const raw = await buildRaw(mail);

    const sentCanonical = await this.resolveSentFolder();
    const appended = await this.client.append(this.toServerPath(sentCanonical), raw, ["\\Seen"]);
    const sentLocator: NativeLocator = appended && typeof appended !== "boolean" && appended.uid != null && appended.uidValidity != null
      ? { folder: sentCanonical, ref: makeRef(appended.uidValidity, appended.uid) }
      : { folder: sentCanonical, ref: "0:0" };

    // `raw` rides out with the locator. Both halves are needed together and neither is
    // reconstructable afterwards: the UID is only in the APPEND response, and the bytes are what
    // decides the message's identity. See {@link SendResult.raw}.
    return { providerMessageId: messageId, sentLocator, raw };
  }

  /**
   * Verify-by-Sent: is a message with this Message-ID (RFC 5322)
   * present in the Sent folder? Used for crash recovery — a same-key retry that
   * finds a stale `pending` reservation searches Sent for the pre-minted id to
   * decide FOUND → reconcile to `sent` (no resend) vs NOT FOUND → `unverified`.
   * Mirrors the `uidInFolder` header search: strips `<>` and queries
   * `HEADER message-id`. A missing/unselectable Sent folder ⇒ false (not found).
   */
  async messageInSent(messageId: string): Promise<boolean> {
    const inner = messageId.replace(/[<>]/g, "").trim();
    if (!inner) return false;
    const sentCanonical = await this.resolveSentFolder();
    let lock: { release(): void };
    try {
      lock = await this.client.getMailboxLock(this.toServerPath(sentCanonical));
    } catch {
      return false;
    }
    try {
      const found = await this.client.search({ header: { "message-id": inner } }, { uid: true });
      return Array.isArray(found) && found.length > 0;
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch ONE MIME part's decoded bytes on-demand. `partId` is the
   * IMAP body-part number captured at ingest (mailparser's `partId`); a null part
   * (single-part message) falls back to "1". Streams the part under a mailbox lock
   * and buffers it in memory — the bytes are returned to the caller and NEVER
   * persisted server-side (§13.2/§14). `imapflow.download` decodes the
   * content-transfer-encoding, so the bytes are the real file.
   */
  async fetchPart(locator: NativeLocator, partId: string | null, opts: FetchPartOptions = {}): Promise<FetchedPart> {
    const { uid } = parseRef(locator.ref);
    const serverPath = this.toServerPath(locator.folder);
    const part = partId ?? "1";
    const lock = await this.client.getMailboxLock(serverPath);
    try {
      const dl = await this.client.download(String(uid), part, { uid: true });
      if (!dl || !dl.content) throw new MessageGoneError(locator);
      const chunks: Buffer[] = [];
      // COUNT AS WE GO, and stop the moment the ceiling is crossed.
      //
      // The check has to be INSIDE the loop. Buffering the whole part and measuring afterwards
      // would enforce the same limit on paper while doing none of the work the limit exists for:
      // the memory is already spent, and — worse here — `getMailboxLock` is held for the entire
      // transfer, so a single 90 MB part would hold this mailbox's lock for the whole download and
      // every later fetch on this connection would queue behind it. That is the shape of the bug
      // where one bad message stopped all later mail for a mailbox; the fix is to never start
      // paying for bytes past the ceiling, not to notice afterwards that we did.
      let total = 0;
      for await (const chunk of dl.content) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (opts.maxBytes !== undefined && total > opts.maxBytes) {
          // Abandon the stream. This poisons the connection (see AttachmentTooLargeError) — the
          // caller closes it; that is cheaper than draining bytes we have already refused.
          throw new AttachmentTooLargeError(locator, opts.maxBytes, total);
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);
      return {
        contentType: dl.meta?.contentType ?? "application/octet-stream",
        filename: dl.meta?.filename ?? null,
        body: new Uint8Array(body),
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Re-read ONE message in full, exactly as the server holds it. See
   * {@link MailboxAdapter.fetchRaw} for the contract; this note is about the mechanics.
   *
   * ── THE CEILING IS THE DRIVER'S, DELIBERATELY, AND NOT THE COUNT-AS-WE-GO ABOVE ────────
   *
   * `fetchPart` throws out of its own `for await`, which destroys the stream while the driver may
   * be halfway through reading a FETCH literal — the connection is dead afterwards and its
   * comment says so. That is affordable for a caller holding a per-request connection and fatal
   * here: the only caller runs on the worker's long-lived per-mailbox connection, the one that
   * sits in IDLE and carries every later sync for that mailbox.
   *
   * Handing `maxBytes` to `download` instead stops the fetch at a CHUNK boundary — each chunk is
   * a complete `BODY.PEEK[]<start.length>` response, so the loop simply declines to ask for the
   * next one and the socket is left idle and clean. The cost is that the driver truncates
   * silently, which is exactly what this method must not do, so the size is checked afterwards
   * against `RFC822.SIZE` and a truncated read is turned into a refusal.
   *
   * The stream is drained to its end before that check even when the size is already known to be
   * over: draining is what leaves the connection clean, it is bounded by the ceiling, and the
   * alternative is the abandoned-mid-literal state this whole design exists to avoid.
   */
  async fetchRaw(locator: NativeLocator, opts: FetchRawOptions = {}): Promise<Uint8Array> {
    const maxBytes = opts.maxBytes ?? DEFAULT_FETCH_RAW_MAX_BYTES;
    const { uid } = parseRef(locator.ref);
    const serverPath = this.toServerPath(locator.folder);
    const lock = await this.client.getMailboxLock(serverPath);
    try {
      // `undefined` for the part is what makes this a source fetch, and a source fetch is what
      // makes it `BODY.PEEK[]`. Not `""` — an empty string reaches the same branch by being
      // falsy, which is a property of the driver rather than a thing it promises.
      const dl = await this.client.download(String(uid), undefined, { uid: true, maxBytes });
      if (!dl || !dl.content) throw new MessageGoneError(locator);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of dl.content) {
        const buf = chunk as Buffer;
        total += buf.length;
        chunks.push(buf);
      }
      // `expectedSize` is the server's RFC822.SIZE. A missing one (a server that did not answer
      // the item) is treated as "the read is as long as it is": there is nothing to compare
      // against, and refusing every message on such a server would be worse than trusting a
      // complete-looking read the driver reports no limit on.
      const expected = dl.meta?.expectedSize;
      if (typeof expected === "number" && expected > maxBytes) {
        throw new RawMessageTooLargeError(locator, maxBytes, expected);
      }
      if (typeof expected === "number" && total < expected) {
        // Short of the size the server itself declared, with no ceiling to explain it. Something
        // ended the transfer early; returning these bytes would hand the caller a message whose
        // tail is missing and nothing to notice it by.
        throw new RawMessageTooLargeError(locator, maxBytes, expected);
      }
      return new Uint8Array(Buffer.concat(chunks));
    } finally {
      lock.release();
    }
  }
}

/**
 * An {@link OutboundMessage} as the nodemailer options that build the delivered message AND the
 * Sent-folder copy — pulled out of {@link ImapAdapter.send} so the BCC-ENVELOPE-ONLY invariant is
 * testable without a socket.
 *
 * The load-bearing lines are `cc` and `bcc`. Both are passed straight through, and both reach the
 * SMTP RCPT list because `sendMail`'s envelope is `to + cc + bcc`. The asymmetry that makes bcc
 * blind is nodemailer's default `keepBcc: false`, which this function relies on rather than
 * restates: the compiled message (whether transmitted or handed to `buildRaw` for the Sent append)
 * carries a `Cc:` header and no `Bcc:` header. `keepBcc` is NEVER set here — doing so would write
 * the blind recipients into the delivered headers, which is precisely the leak the feature exists
 * to prevent. The Cc/Bcc round-trip test builds this and asserts both halves,
 * and was watched to go red when `bcc` is spelt as `keepBcc: true` or moved into the headers.
 */
/**
 * `Mail.Options` plus the per-message `auth` nodemailer honours at runtime (`mail.data.auth`) but
 * `@types/nodemailer` omits from the message-options type. Narrowed to the XOAUTH2 shape we set.
 */
type MailWithOAuth = Mail.Options & { auth?: { type: "OAuth2"; user: string; accessToken: string } };

export function outboundToMail(msg: OutboundMessage, messageId: string): Mail.Options {
  return {
    from: msg.from,
    to: msg.to,
    ...(msg.cc !== undefined ? { cc: msg.cc } : {}),
    ...(msg.bcc !== undefined ? { bcc: msg.bcc } : {}),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    messageId,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    // Spread rather than assigned, so a message with no extra headers produces byte-identical
    // options to the ones this function produced before the field existed — `headers: undefined`
    // and an absent key are the same to MailComposer, but not to a test comparing the object.
    ...(msg.headers !== undefined ? { headers: { ...msg.headers } } : {}),
    // ── ATTACHMENTS, zero at rest ────────────────────────────────────────────────────────
    //
    // Mapped onto nodemailer's own `attachments` so the SAME compiled message is what
    // `transporter.sendMail` delivers AND what `buildRaw` turns into the Sent-folder append —
    // there is no second assembly of the bytes and no way for the delivered copy and the Sent
    // copy to carry different files. The bytes live only in `msg.attachments` for this call; they
    // are never written to any table (see `OutboundMessage.attachments`). Omitted entirely when
    // absent so a plain send builds byte-identical options to before this field existed.
    ...(msg.attachments && msg.attachments.length
      ? {
          attachments: msg.attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.content),
            contentType: a.contentType,
            ...(a.cid ? { cid: a.cid } : {}),
          })),
        }
      : {}),
  };
}

function buildRaw(mail: Mail.Options): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err); else resolve(message);
    });
  });
}
