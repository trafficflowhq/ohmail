import { randomUUID } from "node:crypto";
import {
  ImapFlow, type ImapFlowOptions, type ListResponse, type MailboxObject, type StatusObject,
} from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

/**
 * The longest subject ingest will keep, and it CLAMPS rather than refuses. A `Subject:` is
 * sender-chosen with no RFC 5322 ceiling (the 998 octets bound a line, and headers fold), and it
 * reaches a column, a snippet, the search index and every list DTO. It clamps because the mailbox
 * is the master and this is inbound — refusing would lose delivered mail to defend a number;
 * outbound refuses instead, since the caller composed the value. The clamp is also what keeps
 * `DRAFT_SUBJECT_MAX_CHARS` (8 192) safe: a reply inherits the subject plus `Re: `, and without
 * an ingest ceiling a sender could make their own message unrepliable. 2 000 is far above
 * anything real and far below a cost.
 */
export const INGEST_SUBJECT_MAX_CHARS = 2000;

/** A received subject, clamped. See {@link INGEST_SUBJECT_MAX_CHARS}. */
export function ingestSubject(v: string | null | undefined): string {
  const s = v ?? "";
  return s.length > INGEST_SUBJECT_MAX_CHARS ? s.slice(0, INGEST_SUBJECT_MAX_CHARS) : s;
}

/**
 * The longest display name ingest will keep — the subject's rule, one field along. A plain Reply
 * copies the parent's `from`, name included, into the draft's recipient, and
 * `RECIPIENT_NAME_MAX_CHARS` bounds a name on the way out — so a sender using a longer display
 * name would make their own message unrepliable through the ordinary UI, with the refusal naming
 * a limit on a value the user never typed. Clamp what arrives, refuse what is authored. The
 * number restates `RECIPIENT_NAME_MAX_CHARS` rather than importing it because `packages/core`
 * does not depend on `packages/services`; the census pins the two together.
 */
export const INGEST_DISPLAY_NAME_MAX_CHARS = 100;

/** A received display name, clamped. `null` stays `null` — absent is not the same as empty. */
export function ingestDisplayName(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v.length > INGEST_DISPLAY_NAME_MAX_CHARS ? v.slice(0, INGEST_DISPLAY_NAME_MAX_CHARS) : v;
}
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
  // The one spelling of this adapter's "not at that locator any more" code. It lives on a leaf so
  // the service layer can recognise the refusal without importing this file (and `imapflow` with
  // it); `MessageGoneError` is built from it here so the class and the predicate cannot drift.
  MESSAGE_GONE_CODE,
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
// The SSRF gate's other half. `pinned-fetch.ts` owns it because a pin and a gate are one
// mechanism (its header says so); this file is the mail-leg consumer — see `ImapConfig.pin`.
import { pinnedLookup } from "../net/pinned-lookup.js";
import {
  AmbiguousMetaFolderError,
  makeLeaseIo, makeLeasePeekIo, makeRequestReaderIo, makeRequestOrganizerIo, personalNamespacesOf,
  resolveOhmailFolder,
  type LeaseImapClient, type LeaseIo, type LeasePeekIo, type MetaNamespaceSource,
  type RequestReaderIo, type RequestOrganizerIo,
} from "./organizer-lease.js";
import { makeProfileIo, type ProfileImapClient, type ProfileIo } from "./organizer-profile.js";
// The HARD per-message ceiling `normalizeMime` enforces after a download — imported so
// `fetchCapped` can enforce the same number BEFORE the download, from RFC822.SIZE alone.
import { MAX_RAW_MESSAGE_BYTES } from "../mime.js";
// THE CEILINGS ON SERVER-CHOSEN VALUES. `imap-bounds.ts` carries the whole argument — the short
// version is that the user picks their own mail server and the worker process is shared, so every
// count, size and wait this file accepts from that server is a lever on other people's mail.
import {
  ImapBoundExceeded, ImapDeadline, boundedCollect, boundListResponse, boundSearchResult,
  boundEnvelopeAddresses, bodyOverrunCeiling, minOf,
  IMAP_ENUM_MAX_UIDS, IMAP_CANDIDATE_BODY_PROBES_MAX,
  IMAP_FLAG_SCAN_MAX_ROWS, IMAP_SAMPLE_MAX_ROWS,
  IMAP_READ_DEADLINE_MS, IMAP_CYCLE_DEADLINE_MS,
} from "./imap-bounds.js";
import type { MetaIdentity } from "./meta-memo.js";

// Re-export the adapter types + folder constants so consumers can import them from this entrypoint.
export * from "./imap-types.js";
// …and the server-value ceilings, so a consumer bounding its own IMAP read reaches for the same
// numbers rather than inventing a second set.
export * from "./imap-bounds.js";
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
 * A bounded search answer over one folder — the Junk window's search-append half
 * ({@link ImapAdapter.searchFolderPage}). Newest matches first, at most {@link FOLDER_PAGE_MAX}.
 */
export interface FolderSearchPage {
  /** The folder's UIDVALIDITY at read time — every row's epoch. */
  uidValidity: string;
  items: FolderPageItem[];
  /** The server matched MORE than the page carried — the answer is the newest slice of the hits. */
  truncated: boolean;
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
 * How old is this message — the one number the backfill orders by. Not INTERNALDATE alone: a
 * migration tool that APPENDs without one stamps every message with the import time, and a
 * constant key orders nothing — the backfill falls back to UID order, the defect. Not the `Date:`
 * header alone: it is sender-written, and trusting it hands the head of every backfill to whoever
 * stamps `Date: 2099`. The rule: a message cannot be newer than the moment the server received it
 * — the sender's date when earlier than the server's, otherwise the server's; no `Date:` falls
 * through to INTERNALDATE; neither present sorts as 0, oldest, never a throw.
 */
export function arrivalKey(internalDate: unknown, headerDate: unknown): number {
  const internal = toMs(internalDate);
  const header = toMs(headerDate);
  if (internal === null) return header ?? 0;
  if (header === null) return internal;
  return header < internal ? header : internal;
}

/**
 * The backfill's selection order: newest arrival first, UID descending to break ties. Pure and
 * exported so the rule is testable without a server. The tiebreak is not cosmetic: on
 * second-granular dates, and on the flattened migration {@link arrivalKey} describes where every
 * key is identical, it is the only discriminator left — and falling back to UID descending is
 * exactly the prior behaviour, so the worst case of this change is the behaviour before it.
 */
export function orderCandidates(uids: readonly number[], dates: ReadonlyMap<number, number>): number[] {
  return [...uids].sort((a, b) => (dates.get(b) ?? 0) - (dates.get(a) ?? 0) || b - a);
}

/**
 * The complete `ImapFlow` option set for a config — the whole thing, not just the TLS part. One
 * place where a `secure: false` from the onboarding request body becomes a socket, and it cannot
 * be reached without the TLS floor: {@link imapTlsFloor} is spread in here, not at the call site,
 * so reverting to an inline option literal is caught by the TLS-floor guard with a server
 * transcript containing the plaintext password. Exported because the guards assert the whole
 * assembled set, and `packages/services` owes an onboarding-time refusal that should reject what
 * the adapter would refuse anyway.
 */
export function imapFlowOptions(
  config: Omit<ImapConfig, "auth"> & { auth: ResolvedImapAuth },
  opts: Pick<ImapAdapterOpts, "logger"> = {},
): ImapFlowOptions {
  const t: NetTimeouts = { ...DEFAULT_NET_TIMEOUTS, ...(config.timeouts ?? {}) };
  const floor = imapTlsFloor(config.host, config.secure, config.allowInsecure === true).options;
  const pin = dialPin(config.pin);
  return {
    // `config.auth` is the RESOLVED wire form: `{ user, pass }` or `{ user, accessToken }`. This
    // function stays pure/sync — the OAuth CALLBACK is awaited by `connect()` BEFORE it reaches here,
    // so the TLS-floor guards can keep asserting the whole assembled option set. imapflow reads
    // `auth.accessToken` and issues XOAUTH2 with no password on the wire.
    host: config.host, port: config.port,
    ...floor,
    /**
     * The pin, merged into the floor and never replacing it (see {@link ImapConfig.pin}). `tls`
     * is the one option bag imapflow forwards to `tls.connect`/`net.connect`, so a `lookup` here
     * reaches the socket on both the implicit-TLS and STARTTLS rungs; a top-level `lookup` would
     * be read by neither. The spread is `{ ...floor.tls, lookup }`, so every key of {@link
     * TLS_FLOOR} survives — a pin that quietly dropped `rejectUnauthorized` would be a worse hole
     * than the one it closes. `host` and `servername` are untouched: certificate validation still
     * runs against the name, only the dialled address is fixed.
     */
    ...(pin ? { tls: { ...floor.tls, lookup: pinnedLookup(pin) } } : {}),
    auth: config.auth, qresync: true, logger: opts.logger ? undefined : false,
    /* THE ONLY WAY TO SEE THE SERVER TALK WITHOUT WAITING FOR A COMMAND TO FINISH.
       `on("response")` fires only for TAGGED responses (`imap-flow.js:704-718`), i.e. command
       completion, so a 45-second FETCH emits nothing until its last line; `emitLogs` emits one
       entry per server line, which is what {@link ImapAdapter.lastServerActivityAt} counts.
       Independent of `logger`: the emit sits outside the `logger !== false` branch
       (`imap-flow.js:4045-4069`), so this adds an event and no output. */
    emitLogs: true,
    connectionTimeout: t.connectionMs, greetingTimeout: t.greetingMs, socketTimeout: t.socketMs,
    /**
     * Never negotiate compression. The client offers COMPRESS whenever the server advertises it,
     * and compression needs a whole library: the desktop has one, a phone's engine does not and
     * its stand-in throws — so the option's absence would turn a server that happens to advertise
     * DEFLATE into a mailbox that cannot be opened. The saving was never worth it: mail arrives
     * once, the body budget bounds a fetch, and the bandwidth saved is small next to the memory a
     * second stream costs on a device.
     */
    disableCompression: true,
  };
}

/**
 * A config's pin, normalised: the addresses to dial, or `undefined` for "dial by name".
 *
 * An EMPTY array is `undefined` and not "connect to nothing". The pin narrows a dial that the
 * SSRF gate has already permitted; it is not a second refusal mechanism, and a caller that
 * threaded an empty list would otherwise turn a permitted probe into an unexplainable connect
 * failure at the socket layer, far from the check that produced it.
 */
function dialPin(pin: readonly string[] | undefined): readonly string[] | undefined {
  return pin !== undefined && pin.length > 0 ? pin : undefined;
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

/**
 * The complete nodemailer transport option set for a config's SMTP block — see {@link
 * imapFlowOptions}. The submission leg's pin is a different mechanism from the IMAP leg's:
 * `lookup` is useless because nodemailer resolves the name itself before connecting
 * (`shared.resolveHostname` replaces `opts.host`), which is the second lookup the pin exists to
 * remove. So the DIAL HOST becomes the cleared address (`resolveHostname` short-circuits on an
 * IP) while `servername` carries the NAME, so both TLS rungs validate the certificate against
 * what the user typed. One address is dialled where IMAP pins the whole set — nodemailer's host
 * is a scalar; every address was cleared, so the choice is arbitrary, not weaker.
 */
export function smtpTransportOptions(config: ImapConfig): SMTPTransport.Options {
  const smtp = config.smtp;
  if (!smtp) throw new Error("smtpTransportOptions(): ImapConfig.smtp is not configured");
  const t: NetTimeouts = { ...DEFAULT_NET_TIMEOUTS, ...(config.timeouts ?? {}) };
  const pin = dialPin(smtp.pin);
  return {
    host: pin ? pin[0]! : smtp.host, port: smtp.port,
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
 * Dial an SMTP submission endpoint and authenticate, without sending — the connect-time proof the
 * SMTP probe needs. Runs the full sequence (connect, EHLO, mandatory STARTTLS where `secure` is
 * false, AUTH) against the option set from {@link smtpTransportOptions}, so what it proves is
 * byte-identical to a later send. It transcribes `SMTPTransport.verify()` arm for arm rather than
 * calling it because the EHLO carries the server's `SIZE`, which `verify()` parses into a local
 * connection and discards. The private `_maxAllowedSize` read survives its disappearance:
 * anything not a positive number reads as `null` — no ceiling learned — which callers treat as
 * the strict fallback, never as unbounded. Nothing here logs; the config carries a password.
 */
/**
 * Whether to ask a submission server for its `SIZE` at all. `mailboxes.smtp_max_size_bytes` is
 * the RFC 1870 `SIZE`, written at mailbox create and SMTP re-dial, so an older mailbox announces
 * nothing and reads as the strict product constant. This is the decision half of the back-fill.
 * Four bounds: one dial per mailbox per process, `attempted` marked BEFORE the dial so a failure
 * counts; an oauth transport is dialled with a TOKEN via the send's own freshness callback, never
 * the stored refresh token — no token, no dial (`token_unavailable`); never throws and never
 * repeats the server's words ({@link SmtpSizeFailure}); silence is not a ceiling — no `SIZE`, a
 * bare keyword and `SIZE 0` all record nothing.
 */

/**
 * The authentication a probe dial presents — a static password, or a bearer access token. A union
 * rather than one optional-field shape so no site can hand a token to the password seat by
 * forgetting a branch. The oauth member carries a TOKEN and never a refresh token: the refresh
 * token stays behind {@link ImapOAuthAuth.fetchAccessToken}, which {@link learnSmtpMaxSize}
 * awaits exactly as `ImapAdapter.send` awaits it per message.
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
 * Why a failure is a code and not a message — a privacy boundary. nodemailer's error text embeds
 * the SMTP server's own response line, which on an AUTH failure routinely contains the username
 * and can contain an echoed credential or arbitrary provider text. Callers log `reason` as an
 * allowlisted field, and the value scrubber only redacts strings that label themselves as secrets
 * — so a raw message here would be a path from a third party's socket to a log drain. The closed
 * set derives from nodemailer's `code`, never its prose.
 */
export type SmtpSizeFailure =
  /** The server refused the credentials (nodemailer `EAUTH`). */
  | "auth_refused"
  /** Never got a usable connection: timeout, DNS, refused socket. */
  | "unreachable"
  /** The connection was made and TLS would not come up on the floor this product requires. */
  | "tls_refused"
  /**
   * An oauth mailbox, and no access token could be obtained — so no dial was made. One member for
   * every reason, deliberately: distinguishing a dead refresh token from a down endpoint here
   * would carry a provider's error text one step closer to a log line. The distinction lives
   * where it belongs — the token client raises named classes (`OAuthReauthRequiredError`,
   * `OAuthProviderUnavailableError`, `OAuthConfigError`) and the sync path classifies on them. A
   * back-fill probe needs one bit: no token, nothing to learn today.
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
 * The oauth auth — a user plus the freshness callback — or `null` for anything else. Structural,
 * like {@link staticSmtpAuth}, because `SmtpSizeCreds.auth` is deliberately `unknown`: three
 * hosts assemble the credential themselves, and a nominal type would only be as strong as the
 * weakest cast. The two predicates are mutually exclusive on the shapes {@link buildImapAuth}
 * produces, and the password branch is tested first at the call site — it fails towards the
 * password the caller explicitly stored, never towards a secret it did not.
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

  // Which authentication this mailbox's send would present. Password FIRST — the order is the
  // safety property: a shape that somehow carried both dials the password the caller stored,
  // never routing an unchosen secret into an AUTH command. The oauth arm used to be absent, and
  // its absence was not neutral: an oauth mailbox could never be probed and kept the strict
  // constant for ever. It cannot dial the stored secret — that is a REFRESH TOKEN — so the access
  // token comes through THE SAME callback the send uses: one token path, one cache, one
  // rotation-persist. A probe minting its own token would be a second one, and a second one is a
  // second thing to get wrong.
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
 * What `SMTPConnection.login` is handed — password credentials, or an XOAUTH2 authenticator. The
 * shape is `getAuth()`'s own OAUTH2 branch, arm for arm, transcribed for the reason {@link
 * verifySmtpLogin} transcribes `verify()`: the EHLO's `SIZE` only exists on a connection this
 * module owns. nodemailer's own `XOAuth2` and not a hand-rolled SASL string: constructing it with
 * an `accessToken` and nothing else is exactly what a send does, so the bytes on the wire match a
 * later send's. The retry is safe by construction — with no `refreshToken`, `clientId` or
 * `serviceClient`, `generateToken` refuses locally, no request reaches any token endpoint, and
 * the refusal surfaces as `EAUTH` → `auth_refused`: the honest answer.
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
  smtp: {
    host: string; port: number; secure: boolean; auth: SmtpSizeDialAuth;
    /** The submission host's cleared addresses — see {@link ImapConfig.pin}. The add-time probe
     * sets it (its host came from a request body and has just been through the SSRF gate); every
     * stored-credential caller leaves it undefined and dials by name exactly as before. */
    pin?: readonly string[];
  },
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
      // The pin travels on the SUBMISSION block, because that is the block `smtpTransportOptions`
      // dials from. The top-level fields above are the IMAP half and it reads none of them.
      ...(smtp.pin ? { pin: smtp.pin } : {}),
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
 * The connection ended — imapflow's `close` event, as something a caller can act on. A
 * synthesised class rather than the raw event (which carries no argument) and rather than
 * imapflow's `NoConnection` (what the NEXT command throws — keying policy on it is keying on a
 * driver's internals). `name` and `code` are the whole payload: `log.ts` reduces any `err` to
 * exactly those two, so `errorClass="ImapConnectionClosedError" errorCode="EIMAPCLOSED"` is the
 * complete, greppable record — distinguishable from the `errorCode="ETIMEOUT"` a genuine socket
 * failure produces.
 */
export class ImapConnectionClosedError extends Error {
  readonly code = "EIMAPCLOSED";
  constructor() {
    super("the IMAP connection closed");
    this.name = "ImapConnectionClosedError";
  }
}

/**
 * The message is not at this locator any more — expunged, moved by another client, or addressed
 * under a UIDVALIDITY epoch the folder has since left (see `ImapAdapter#assertLocatorEpoch`).
 *
 * `code` and `name` are carried for the same reason every sibling error here carries them: a
 * consumer outside `@trafficflow/core` must be able to recognise this WITHOUT importing the
 * adapter, which would drag imapflow into the service layer and break the `openAdapter` seam.
 * `instanceof` remains correct inside core and the worker, which do import it.
 */
export class MessageGoneError extends Error {
  /**
   * ONE spelling, shared with the duck-typed predicate every consumer outside this package uses —
   * see `gone.ts#MESSAGE_GONE_CODE`. A second literal here would be a predicate that quietly stops
   * matching, which on this seam reads exactly like "a gone locator never happens".
   */
  readonly code = MESSAGE_GONE_CODE;
  constructor(public locator: NativeLocator) {
    super(`message not at source locator ${locator.folder}#${locator.ref}`);
    this.name = "MessageGoneError";
  }
}

/**
 * One folder's PERSISTED cursor as this build can use it, or `null` when the stored shape is
 * foreign — written by another build, hand-edited, or truncated JSON. Every field is checked
 * because the type is a claim about what SHOULD be there and this value comes off disk.
 *
 * A rejected cursor is not repaired field by field: a half-read cursor is a cursor nobody can
 * reason about, and re-reading the folder from cold is bounded, correct and self-clearing.
 */
function usableFolderCursor(v: unknown): FolderCursor | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Partial<FolderCursor>;
  if (typeof c.uidValidity !== "string" || typeof c.highestModseq !== "string") return null;
  if (typeof c.uidNext !== "number" || !Number.isFinite(c.uidNext) || c.uidNext < 0) return null;
  if (!Array.isArray(c.known)) return null;
  if (!c.known.every((k) => typeof k === "object" && k !== null && typeof k.uid === "number")) {
    return null;
  }
  return c as FolderCursor;
}

/**
 * The server did not say which UIDVALIDITY epoch the selected folder is at — so no ref can be
 * proved to name the message it was written for, and every locator-addressed command is refused.
 * RFC 3501 requires `[UIDVALIDITY n]` on a successful SELECT and forbids zero, so both are the
 * same fact: the epoch is unknown. Deliberately not {@link MessageGoneError} — one of its
 * readings is terminal, and a silent-epoch mailbox would hand that reading a message that is
 * still there. The mailbox's condition, not the message's; `classifyIngestFault` reads its `code`
 * as infrastructure like `EIMAPBOUND`.
 */
export class EpochUnknownError extends Error {
  readonly code = "EIMAPEPOCHUNKNOWN";
  constructor(public locator: NativeLocator) {
    super(
      `the mail server did not report a UIDVALIDITY for ${locator.folder}, so the reference `
      + `${locator.ref} cannot be proved to name this message and the command was refused`,
    );
    this.name = "EpochUnknownError";
  }
}

/**
 * A part exceeded the byte ceiling {@link ImapAdapter.fetchPart} was given, and the download was
 * abandoned mid-stream. `bytesSoFar` is what had accumulated when the ceiling tripped —
 * deliberately not the part's real size, which nobody has, because we stopped reading; show the
 * stored metadata size instead. THE CONNECTION IS DEAD after this error: abandoning `dl.content`
 * leaves imapflow's parser mid-literal, so the next command reads the tail as its own reply. A
 * caller must close the adapter — which is why `AttachmentsService.fetchBytes` may pass a ceiling
 * (per-request connection, closed in `finally`) and `downloadAll` must not.
 */
export class AttachmentTooLargeError extends Error {
  readonly code = "EATTACHTOOLARGE";
  constructor(public locator: NativeLocator, public limitBytes: number, public bytesSoFar: number) {
    super(`attachment part at ${locator.folder}#${locator.ref} exceeds the ${limitBytes} byte ceiling`);
    this.name = "AttachmentTooLargeError";
  }
}
/**
 * A whole message exceeded the ceiling {@link ImapAdapter.fetchRaw} was given, so nothing was
 * returned — see {@link MailboxAdapter.fetchRaw} for why a short read is not an option.
 * `sizeBytes` is the server's own `RFC822.SIZE`, a real number: the ceiling is enforced by
 * declining to keep the bytes, not by abandoning the transfer. THE CONNECTION IS STILL USABLE —
 * the whole difference from {@link AttachmentTooLargeError}: nothing was abandoned mid-literal,
 * the loop stopped at a chunk boundary with the socket idle.
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
 * The `Message-ID` of a raw message (RFC 5322), read from the HEADER BLOCK ONLY — for messages
 * whose envelope the server will not produce (the recovery fetch in {@link
 * ImapAdapter.fetchCapped}). Three details that change the answer: the header block only, because
 * scanning the whole message would match a `Message-ID:` quoted in a forwarded body and hand back
 * the wrong identity for `correlateMoves` to pair a delete against; unfolded first, because RFC
 * 5322 §2.2.3 wraps long headers onto continuation lines; `latin1`, not `utf8`, because header
 * bytes above 0x7F are not valid UTF-8 and a Message-ID is ASCII — a byte-preserving decode
 * cannot corrupt the scan.
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
 * Where a bounded flag drain has got to, per folder — in memory, deliberately. Creates resume for
 * free (an ingested UID joins the known-set); flags do not — the server re-reports the identical
 * set for the identical `changedSince`, so take-first-N with no resume point hands back the same
 * N for ever. Not persisted, and that is the safe direction: the folder cursor is held at its
 * previous modseq for the whole drain, so a process dying mid-drain re-reports from the start and
 * re-applies idempotent changes (`applyExternalFlag` answers `changed: false`). Losing this map
 * costs repeated work; it can never lose a flag.
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
   * every chunked fetch pay a full inventory LIST (round 2's fix covered only
   * the positive path). The TTL keeps discovery honest: a Sent folder created mid-connection
   * reaches the `ownAuthored` stamp within {@link ImapAdapter.TARGETED_SENT_TTL_MS}.
   */
  private targetedSent: { value: string | null; at: number } | null = null;
  private static readonly TARGETED_SENT_TTL_MS = 5 * 60 * 1000;
  /** {@link findSpecialFolders}' memo — positive answers only, a null is re-asked. */
  private specialJunk: string | null = null;
  private specialTrash: string | null = null;
  /**
   * The customer's own folders, canonical, sorted, capped — see {@link
   * PASSIVE_EXCLUDED_SPECIAL_USE}. Derived from the LIST `connect()` and `ensureFolders()`
   * already issue, so discovery costs nothing on the ordinary path; `changesSince` refreshes it
   * every {@link ImapAdapter.PASSIVE_RELIST_CYCLES} passes, which makes a folder created
   * mid-connection visible without a reconnect. `null` means never computed, distinct from
   * computed-and-empty: a server with no user folders answers `[]`, and only a caller that
   * skipped `connect()` sees null.
   */
  private passiveFolders: string[] | null = null;
  /** Folders LIST offered and the passive rule declined, path → reason. Reported, never read. */
  private passiveExcluded = new Map<string, string>();
  /** Customer folders beyond {@link DEFAULT_PASSIVE_FOLDERS_MAX} — reported, never read. */
  private passiveOverflow: string[] = [];
  /** `changesSince` passes since the folder inventory was LISTed. See `PASSIVE_RELIST_CYCLES`. */
  private passiveCycle = 0;

  /**
   * Whether {@link watch} has registered a wake callback that is still wanted. Read by
   * {@link rearmWatch} so a re-arm after unwatch (or before any watch) is a no-op instead of a
   * pointless SELECT on a connection nobody is listening to.
   */
  private watchArmed = false;

  /** The callback {@link watch} registered — {@link rearmWatch} rings it for the blind-window catch-up. */
  private watchSignal: (() => void) | null = null;

  /**
   * INBOX as the last {@link changesSince} scan actually SAW it on the server (never the
   * held-back cursor value). `null` until the first scan. See the write site in `changesSince`
   * and the read in {@link rearmWatch}.
   */
  private lastInboxSeen: { uidValidity: string; uidNext: number } | null = null;
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
   * Folder → the arrival dates this drain has learned, and the epoch they belong to. See {@link
   * ImapAdapter.arrivalDatesFor}; the ordering rule is {@link arrivalKey}. Keyed by `uidValidity`
   * rather than invalidated by a side effect: a UIDVALIDITY change renumbers every UID, and the
   * obvious invalidation hook (`flagDrain.delete` in `changesSince`) runs AFTER the `fetchCapped`
   * call that would already have read the stale entry — comparing the epoch on read cannot be
   * sequenced wrong. In memory only, for {@link FlagDrain}'s reason: losing it costs one metadata
   * refetch, never mail.
   */
  private readonly dateCache = new Map<string, { uidValidity: string; dates: Map<number, number> }>();
  /**
   * `true` once {@link connect} has fully returned — the guard on the `close` arm of {@link
   * guardAsyncErrors}. The listener is attached BEFORE the dial, so without this flag a
   * connection that never came up would report a fault out of band in addition to rejecting the
   * `await connect()` its caller is holding — one dead mailbox logged as two failures, one at
   * error level with no owner. A `close` before `connect()` returns belongs to the awaited path;
   * only one after it is the out-of-band death this listener exists for.
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

  /* ══ THE SERVER-VALUE CEILINGS ═══════════════════════════════════════════════════════════════
   *
   * Ceilings on what an arbitrary mail server may make this process do.
   * `imap-bounds.ts` holds the constants and the argument for each; what
   * lives here is the plumbing — a clock, a per-pass budget, and the two helpers every read in
   * this class goes through instead of calling `list()` or `search()` raw.
   */

  /**
   * The clock every ceiling in this class reads. See {@link ImapAdapterOpts.nowMs}.
   *
   * A METHOD, not a field initialised from `this.opts`. Parameter properties and class-field
   * initialisers do not have a stable relative order across TypeScript's `useDefineForClassFields`
   * settings, so a field reading `this.opts` at construction is a `undefined is not a function`
   * waiting for a compiler-option change. A method reads it at call time and cannot be sequenced
   * wrong.
   */
  private now(): number { return (this.opts.nowMs ?? Date.now)(); }

  /**
   * WHEN THE SERVER LAST SAID ANYTHING — see {@link MailboxAdapter.lastServerActivityAt}.
   *
   * A timestamp and nothing else. The entries this is stamped from carry the masked IMAP
   * transcript, and none of it is read or kept: `src` decides, the rest is dropped where it
   * arrives.
   */
  private serverActivityMs: number | null = null;

  lastServerActivityAt(): Date | null {
    return this.serverActivityMs === null ? null : new Date(this.serverActivityMs);
  }

  /**
   * The budget for the `changesSince` pass currently running, or `undefined` outside one.
   *
   * Set on entry and cleared in a `finally` so it can never leak into the NEXT pass — a stale
   * deadline would make a healthy cycle refuse instantly, which is a self-inflicted outage
   * wearing this row's error message.
   */
  private cycleDeadline: ImapDeadline | undefined;

  /**
   * The clock for one read: the per-read ceiling, or the remainder of the pass budget when that
   * is tighter. Composing them is not optional — see {@link IMAP_CYCLE_DEADLINE_MS}: a per-read
   * ceiling alone lets a server be slow once per read, and a pass makes a dozen reads. The
   * refusal names the CLOCK that fired (`read_deadline`/`cycle_deadline`), not the read — the
   * read is already in `folder`, and naming it instead made a COUNT breach and a TIME breach
   * report the same `bound`, hiding which fault an operator is looking at.
   */
  private readDeadline(): ImapDeadline {
    return ImapDeadline.soonest(
      ImapDeadline.in(IMAP_READ_DEADLINE_MS, "read_deadline", () => this.now()),
      this.cycleDeadline,
    );
  }

  /**
   * Retire this connection because a command was abandoned while the server may still be filling
   * it. Neither a fired deadline nor a ceiling that breaks out of a generator CANCELS anything:
   * ImapFlow keeps draining, its queue stays owned by a command nobody reads, and the next SELECT
   * queues behind a response that may be endless. Leaving cleanup to the caller was tried — the
   * worker closes the adapter in its catch arm, but it RETAINS adapters across generic failures,
   * and a `"stop"` truncation does not throw at all. `forceClose()` is the teardown; `closing`
   * marks it deliberate so the connection-error listener stays quiet.
   */
  /**
   * The breach this adapter was retired for, or `null` while usable. A breach must end the
   * connection AND mark the mailbox, or a server that breaches every cycle is reconnected for
   * ever: closing silently never marked it, reporting a connection-ENDED reset the tally, and
   * refusing without closing wedged the lease read and teardown behind the hung command. So:
   * close, and report the BREACH ITSELF — the handler reads it as this mailbox's fault and
   * detaches and quarantines on the spot. Stricter than a failure threshold, deliberately: a
   * breach is not flaky, and quarantine is backoff, not a closed door. `retiredBecause` is the
   * fast-refusal belt for anything still holding this adapter.
   */
  private retiredBecause: ImapBoundExceeded | null = null;

  /**
   * Refuse immediately if this adapter has been retired. Called by every method that would
   * otherwise reach for a connection that is gone.
   *
   * A belt, not the mechanism: the connection is already destroyed, so a call that got past this
   * would fail anyway — just less legibly, and one layer further from the cause.
   */
  private assertUsable(): void {
    if (this.retiredBecause !== null) throw this.retiredBecause;
  }

  /**
   * End this connection because a command was abandoned while the server may still be filling it,
   * and tell whoever owns the adapter what happened.
   *
   * `forceClose` and not `close`: the polite path issues a LOGOUT, imapflow serialises commands,
   * and the abandoned command is exactly what a LOGOUT would queue behind — so the courteous
   * teardown would hang for precisely as long as the hang it is escaping. Destroying the socket is
   * also the only thing that actually ends the abandoned command.
   */
  private retireConnection(breach: ImapBoundExceeded): void {
    // REQUIRED, and it used to be optional with a `read_deadline` fallback. The truncating
    // ceilings pass no error of their own, so they fabricated a deadline that had not fired —
    // reported to the consumer, and rethrown by every later call, as a clock that ran out when the
    // real cause was a server over-answering. The report IS how a mailbox gets marked, so the
    // condition it names is not a diagnostic nicety: it is what an operator reads and what
    // bound-specific handling branches on. A code that names the wrong condition is worse than
    // none.
    const first = this.retiredBecause === null;
    this.retiredBecause ??= breach;
    this.closing = true;
    try { this.forceClose(); } catch { /* the socket is going away regardless */ }
    // Once only. A second report for the same dead connection would be a second detach for a
    // mailbox already gone — harmless, because the consumer's handler is de-duplicated, and still
    // not worth emitting.
    if (!first) return;
    try { this.opts.onConnectionError?.(breach); }
    catch { /* a handler that throws here is the crash that listener exists to prevent */ }
  }

  /**
   * Await one server command under the composed clock, retiring the connection if it does not
   * answer in time. Everything that awaits the server goes through here, not just LIST and
   * SEARCH: the first version raced only those two as the unbounded-response commands, which is
   * true about SIZE and irrelevant to TIME — `getMailboxLock`, `status`, `fetchOne` and
   * `download` all return fixed-size results and can all be left unanswered for ever by a server
   * that stops talking mid-response, parking a pass where no `deadline.check()` is reached.
   */
  private async bounded<T>(op: Promise<T>, folder?: string): Promise<T> {
    // Silent: `race` rejects, so the caller propagates and the failure is counted there — and
    // the adapter stays retired, so the NEXT cycle's refusal is counted too.
    this.assertUsable();
    return this.readDeadline().race(op, folder, (because) => this.retireConnection(because));
  }

  /**
   * EVERY LIST in this class goes through here.
   *
   * Ten call sites issued `this.client.list()` raw and each one then did something O(n) with the
   * answer — a `Set` of every path, a `map` of every path, a canonicalise-sort-retain. One
   * ceiling in one place is what keeps the eleventh call site from being unbounded again; see
   * {@link IMAP_LIST_MAX_FOLDERS} for the count, and for the honest note that the driver has
   * already buffered the response by the time this runs, which is why the deadline is doing the
   * load-bearing work on this particular read.
   */
  private async listBounded(
    opts?: { statusQuery: { messages: boolean; uidNext: boolean; highestModseq: boolean } },
  ): Promise<ListResponse[]> {
    const list = await this.bounded(
      opts === undefined ? this.client.list() : this.client.list(opts),
    );
    return boundListResponse(list);
  }

  /**
   * EVERY SEARCH in this class goes through here — the ceiling applied BEFORE the caller copies,
   * sorts or iterates the result. See {@link IMAP_SEARCH_MAX_UIDS}.
   *
   * The `false` imapflow answers for a refused SEARCH is passed straight through: distinguishing
   * "refused" from "no matches" is the caller's obligation and several of them do it differently.
   */
  private async searchBounded(
    query: Parameters<ImapFlow["search"]>[0],
    // `{ uid?: boolean }` written out rather than `Parameters<…>[1]`: `ImapFlow.search` is
    // OVERLOADED and `Parameters<>` resolves to the LAST overload, whose `returnOptions` is
    // required — so the inferred type rejects the `{ uid: true }` every call site here passes.
    opts: { uid?: boolean },
    folder?: string,
  ): Promise<number[] | false> {
    const found = await this.bounded(this.client.search(query, opts), folder);
    return boundSearchResult(found as number[] | false);
  }

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
    const list = await this.listBounded();
    /**
     * One alphabet for the whole adapter, and the NAMESPACE wins. Reading the LIST alone let the
     * adapter and the lease resolution disagree: `resolveOhmailFolder` takes the first personal
     * namespace's delimiter above everything, while `toServerPath` took the LIST's. When they
     * disagree the adapter builds a second folder tree — `ensureFolders` creates at one spelling
     * and every other call site addresses the other, so a message filed into `ohmail/Reads` goes
     * to a path that does not exist. The namespace is read first so one spelling serves both; the
     * LIST row stays as the second source.
     */
    /* ONE character, from whichever source answers — the same filter `metaAlphabet` applies with
       its own `one()`. Guarding only the namespace half (as the first version of this did) leaves
       a server whose LIST reports an empty or multi-character delimiter handing the adapter one
       alphabet and the resolution another, which is the exact divergence this line exists to end.
       Total, or it is not an invariant. */
    const one = (d: unknown): string | undefined =>
      (typeof d === "string" && d.length === 1 ? d : undefined);
    const ns = personalNamespacesOf(this.client as unknown as MetaNamespaceSource);
    this.delimiter = one(ns[0]?.delimiter)
      ?? one(list.find((f) => f.path.toUpperCase() === "INBOX")?.delimiter)
      ?? one(list[0]?.delimiter) ?? "/";
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
   * The two listeners that make an asynchronous connection death observable. `error`: Node throws
   * when it is emitted unheard and the worker exits on that — one mailbox's timeout once killed a
   * shard; attached UNCONDITIONALLY, and {@link ImapAdapterOpts.onConnectionError} is only how
   * the caller is told. `close`: a socket that ENDS emits `close`, never `error`, and with nothing
   * listening a deployment stopped syncing in silence — so `close` routes to the same callback,
   * guarded by {@link closing} and {@link established}. Fakes without an event surface bypass
   * this, so the worker also bounds by duration; a test drives both arms through an injected
   * EventEmitter.
   */
  private guardAsyncErrors(): void {
    const emitter = this.client as unknown as { on?: (ev: string, fn: (e: unknown) => void) => void };
    if (typeof emitter.on !== "function") return;   // an injected fake without an event surface
    /* THE ACTIVITY STAMP. `src: "s"` is a line READ from the server, `"c"` one we wrote; only the
       first is evidence about the link. Nothing but the moment is taken — see
       {@link serverActivityMs} — and a fake with no `emitLogs` simply never stamps, which
       `lastServerActivityAt` reports as `null` rather than as silence. */
    emitter.on("log", (entry: unknown) => {
      if (typeof entry === "object" && entry !== null && (entry as { src?: unknown }).src === "s") {
        this.serverActivityMs = this.now();
      }
    });
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
    // A RETIRED adapter is already destroyed, and its LOGOUT would queue behind the very command
    // that retired it — so a caller tearing down after a breach would wait out the hang it was
    // escaping. On the quarantine path that matters twice over: the status write happens AFTER
    // the detach, so a teardown that never returns is a mailbox that is never marked.
    if (this.retiredBecause !== null) { this.transporter?.close(); this.established = false; return; }
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

  /**
   * IMAP NOOP — see {@link MailboxAdapter.noop}. Raw, NOT through {@link bounded}: the caller
   * supplies a window an order of magnitude shorter than the read deadline, which is the point
   * of a heartbeat. A retired connection still refuses.
   */
  async noop(): Promise<void> {
    this.assertUsable();
    await this.client.noop();
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
    const list = await this.listBounded();
    this.sentFolder = this.findSent(list);
    this.learnPassiveFolders(list);
    /**
     * A prefixed server's own folders are ours, and used to be invisible: on a personal-namespace
     * server `toServerPath("ohmail/Reads")` is `ohmail.Reads` while the LIST row reads
     * `INBOX.ohmail.Reads`, so all five were re-CREATEd on every connect — swallowed as "already
     * exists", five round trips for ever. The lease's resolution answers EXISTENCE ONLY, never
     * the create path: creating at the prefixed path made the adapter write one name and read
     * another, landing organize moves on NONEXISTENT. The CREATE keeps the adapter's own
     * spelling; `connect()` reads the namespace delimiter first for the same reason.
     */
    const namespaces = personalNamespacesOf(this.client as unknown as MetaNamespaceSource);
    for (const canonical of OHMAIL_FOLDERS) {
      /* `const`: the CREATE address is the adapter's own spelling and nothing may re-point it.
         A mutable binding here is the shape the defect had — `path = at.path` — so the next
         person to reach for it has to change the declaration first and think about why. */
      const path = this.toServerPath(canonical);
      try {
        const at = resolveOhmailFolder({ list, bare: path, namespaces, canonical });
        /**
         * A match is not enough to skip a CREATE — whose folder is it? The resolution's
         * no-NAMESPACE branch accepts a prefix whose parent the server merely LISTs (a customer's
         * `Backup.ohmail.Reads` is adopted), which is an accepted trade for a lease READ: a wrong
         * answer there is one wrong answer. It does not transfer to create-if-absent: a CREATE
         * that never happens leaves the folder missing for the life of the account, and every
         * later move into it lands on NONEXISTENT. So the skip takes the strict half — ours is
         * the root, or the personal namespace's own root — and anything else is created under our
         * own name, where "already exists" still absorbs a race.
         */
        if (at.row !== null && this.isOwnFolderPath(at.path, path, namespaces)) continue;
      } catch (err) {
        /* NARROW, and named. A bare `catch` here swallowed every throw out of the resolution
           identically — including a programming error inside it — and then proceeded to a
           root-named CREATE as if nothing had happened, where "already exists" absorbed the
           second symptom too. Only the ambiguity is survivable; everything else is a fault. */
        if (!(err instanceof AmbiguousMetaFolderError)) throw err;
        /* AmbiguousMetaFolderError — two credible candidates for one of our names. It is the
           honest refusal where a LEASE is at stake, because reading a claim from the wrong
           folder breaks the single-organizer invariant. Here nothing is being read: this is a
           create-if-absent, and refusing to connect over it would be a worse answer than the
           behaviour this replaced. Fall through to the root-named CREATE the server will file
           under its own prefix anyway, and let "already exists" absorb it as it always did. */
      }
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
    this.assertUsable();
    const list = await this.listBounded();
    return list
      .filter((f) => !(f.flags?.has("\\Noselect") ?? false))
      .map((f) => this.toCanonical(f.path));
  }

  /* ══ USER-COMMANDED FOLDER OPERATIONS (FOLDERS-SPEC.md stage 2) ═══════════════════════════
   *
   * The four verbs the worker's `folderOpsPass` executes. Every one is an explicit human press
   * recorded in `folder_ops` — ohmail never creates, renames or deletes a folder on its own
   * initiative (imap-types.ts carries the product rule). All four speak CANONICAL `/`-joined
   * paths; the delimiter translation happens here, which is also where a leaf that contains
   * the mailbox's REAL delimiter is refused — the one name rule only a live connection knows
   * (`folderNameError` in types.ts covers everything knowable without one).
   */

  /** The mailbox's real hierarchy delimiter — `folderOpsPass`'s `bad_name` check reads it. */
  hierarchyDelimiter(): string {
    return this.delimiter;
  }

  /**
   * CREATE, answering the canonical path of the folder that now EXISTS — which is not always
   * the one asked for: a server with a personal-namespace prefix files a root-named CREATE
   * under INBOX (measured live: canonical "X" landed as "INBOX/X" and discovery adopted the
   * prefixed row while the commanded row went stale). The server's own answer is the truth
   * where it gives one; on "already exists" the LIST is asked — the exact name first, then
   * the INBOX-prefixed form. Idempotent either way: a folder that already exists is the
   * asked-for state, not a failure.
   */
  async createFolder(canonical: string): Promise<string> {
    const path = this.toServerPath(canonical);
    try {
      const info = await this.client.mailboxCreate(path);
      const landed = (info as { path?: string } | undefined)?.path;
      if (typeof landed === "string" && landed.length > 0) return this.toCanonical(landed);
    } catch (err) {
      // `ensureFolders`' own idiom: "already exists" is success for a CREATE.
      if (!/already ?exists/i.test(String((err as Error).message))) throw err;
    }
    const list = await this.listBounded();
    const paths = new Set(list.map((f) => this.toCanonical(f.path)));
    if (paths.has(canonical)) return canonical;
    const prefixed = `INBOX/${canonical}`;
    if (paths.has(prefixed)) return prefixed;
    return canonical;
  }

  /**
   * RENAME, with the crash-recovery arm that makes the two-phase command (IMAP first, database
   * swap second) idempotent: when the source is GONE and the target EXISTS, the rename already
   * happened — a crash between the RENAME and the swap, or the user's own client got there
   * first; either way the asked-for tree is the tree, and the caller proceeds to the swap.
   * `"conflict"` (target exists AND source still exists) and `"gone"` (neither path exists) are
   * the two honest refusals — a RENAME issued in either state would move or manufacture
   * something the user did not name.
   */
  async renameFolder(from: string, to: string): Promise<"renamed" | "already" | "conflict" | "gone"> {
    const list = await this.listBounded();
    const paths = new Set(list.map((f) => f.path));
    const src = this.toServerPath(from);
    const dst = this.toServerPath(to);
    const srcThere = paths.has(src);
    const dstThere = paths.has(dst);
    if (!srcThere && dstThere) return "already";
    if (!srcThere) return "gone";
    if (dstThere) return "conflict";
    await this.client.mailboxRename(src, dst);
    return "renamed";
  }

  /**
   * DELETE — of a verified-empty folder only, the last line of the never-expunge rule: RFC 3501's
   * DELETE takes a folder's messages with it, so the guard refuses (`"not_empty"`) rather than
   * trusting the caller's sweep, and FAILS CLOSED (`"unverified"`) when the server will not
   * answer STATUS — deleting on an unknown count would be the expunge this rule forbids. A
   * missing folder is `"already"`. The residual, stated: a message delivered between the
   * zero-count STATUS and the DELETE is taken by the server — a one-round-trip window IMAP offers
   * no primitive to close, the same one every mail client's folder delete carries.
   */
  async deleteFolder(canonical: string): Promise<"deleted" | "already" | "not_empty" | "unverified"> {
    const path = this.toServerPath(canonical);
    const list = await this.listBounded();
    if (!list.some((f) => f.path === path)) return "already";
    const st = await this.bounded(this.client.status(path, { messages: true })).catch(() => null);
    if (!st || typeof st.messages !== "number") return "unverified";
    if (st.messages > 0) return "not_empty";
    await this.client.mailboxDelete(path);
    return "deleted";
  }

  /**
   * Move EVERYTHING in one folder to another — the folder delete's sweep, at folder level
   * rather than per known message, because the mailbox may hold mail the mirror never ingested
   * (the ingest window, declined outcomes, mail that arrived a second ago) and every one of
   * them must reach Trash before the folder may go. One `MOVE 1:*` on the warm connection;
   * imapflow's own fallback (COPY + \Deleted + EXPUNGE) covers servers without MOVE — the
   * standard move mechanics, not an expunge of mail (the copy lands first). Returns how many
   * messages the sweep found; a source that no longer exists is 0 — nothing to move.
   */
  async moveAll(folder: string, toFolder: string): Promise<number> {
    const src = this.toServerPath(folder);
    const dst = this.toServerPath(toFolder);
    let lock: { release(): void };
    try {
      lock = await this.bounded(this.client.getMailboxLock(src));
    } catch (err) {
      // A CEILING BREACH IS NOT "THIS FOLDER IS NOT THERE". The arm below turns any SELECT
      // failure into an honest "no such folder / nothing to do" answer, which is right for a
      // missing or unselectable mailbox and WRONG for a deadline: it would report a server that
      // stopped answering as an empty result, which is the silent degrade this whole file exists
      // to replace with a refusal. See `imap-bounds.ts`.
      if (err instanceof ImapBoundExceeded) throw err;
      return 0;
    }
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      const count = mb && typeof mb.exists === "number" ? mb.exists : 0;
      if (count === 0) return 0;
      await this.client.messageMove("1:*", dst);
      return count;
    } finally {
      lock.release();
    }
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
      lock = await this.bounded(this.client.getMailboxLock(serverPath));
    } catch (err) {
      // A CEILING BREACH IS NOT "THIS FOLDER IS NOT THERE". The arm below turns any SELECT
      // failure into an honest "no such folder / nothing to do" answer, which is right for a
      // missing or unselectable mailbox and WRONG for a deadline: it would report a server that
      // stopped answering as an empty result, which is the silent degrade this whole file exists
      // to replace with a refusal. See `imap-bounds.ts`.
      if (err instanceof ImapBoundExceeded) throw err;
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
      // An OPEN-ENDED range whose exit condition is `limit` DISTINCT addresses — which a server
      // answering a million rows with one address, or none, never satisfies. Truncating a sample
      // is not a wrong answer; see {@link IMAP_SAMPLE_MAX_ROWS}.
      let examined = 0;
      const sampleDeadline = this.readDeadline();
      for await (const m of this.client.fetch(range, { envelope: true })) {
        sampleDeadline.check(folder);
        // Truncating a sample is still an honest answer — but the FETCH behind it keeps
        // running, so the connection cannot be handed on. See `retireConnection`.
        if (++examined > IMAP_SAMPLE_MAX_ROWS) {
          this.retireConnection(
            new ImapBoundExceeded("sample_rows", IMAP_SAMPLE_MAX_ROWS, examined, folder),
          );
          break;
        }
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
   * One bounded header page of a named folder, newest first — the Junk window's list read
   * (FOLDERS-SPEC.md §16.2; {@link fetchByUid} is the body-on-open half). Read-only by
   * construction: one mailbox lock, one UID SEARCH, one envelope/flags FETCH — and it writes
   * nothing anywhere: Junk never enters `messages` or any mirror, and this returns plain header
   * facts, not `Change`s, so a caller cannot ingest the answer even by mistake. The page is
   * `limit` (capped at {@link FOLDER_PAGE_MAX}) newest UIDs, optionally below `beforeUid` (per
   * uidValidity, carried in the answer). `null` for a folder the server refuses to open —
   * distinct from an empty folder, which answers a real page of zero items.
   */
  async listFolderPage(
    folder: string,
    opts: { limit?: number; beforeSeq?: number; expectUidValidity?: string } = {},
  ): Promise<FolderPage | null> {
    const limit = Math.max(1, Math.min(opts.limit ?? FOLDER_PAGE_MAX, FOLDER_PAGE_MAX));
    let lock: { release(): void };
    try {
      lock = await this.bounded(this.client.getMailboxLock(this.toServerPath(folder)));
    } catch (err) {
      // Only a live connection's refusal of the SELECT means "no such window" (missing folder,
      // `\Noselect`). A transport failure propagates, so the caller can tell "this mailbox has no
      // Junk folder" from "the mailbox could not be read just now" (the §16.2 rule). A ceiling
      // breach is not "no such window" either: the rule below would render a deadline or a
      // retired connection as "you have no Junk folder", and the `usable` check does not cover it
      // — a throwing retirement deliberately leaves the socket for the caller to close, so the
      // client still reports itself usable.
      if (err instanceof ImapBoundExceeded) throw err;
      if (!(this.client as unknown as { usable?: boolean }).usable) throw err;
      return null;
    }
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      const uidValidity = mb && mb.uidValidity != null ? String(mb.uidValidity) : "0";
      const total = mb ? mb.exists : 0;
      if (!mb || total === 0) return { uidValidity, total: 0, items: [], nextBeforeSeq: null };

      /**
       * A sequence window, and no SEARCH — the whole read is bounded by `limit`, not merely the
       * response. The first version ran `SEARCH ALL` and sorted every UID in the folder: "one
       * bounded page" true of the answer, false of the work. Sequence numbers are 1..exists with
       * no holes, so the newest `limit` messages are exactly `exists-limit+1 : exists` — one
       * FETCH of at most `limit` envelopes. The cursor is therefore a SEQ, meaningful only within
       * one epoch and one connection's view; `expectUidValidity` is the caller's cursor epoch,
       * and on a mismatch the cursor is DISCARDED and the top page served — paging a renumbered
       * folder would silently skip everything above the stale watermark.
       */
      const paged =
        opts.expectUidValidity !== undefined && opts.expectUidValidity !== uidValidity
          ? undefined
          : opts.beforeSeq;
      const end = Math.min(paged !== undefined ? paged - 1 : total, total);
      if (end < 1) return { uidValidity, total, items: [], nextBeforeSeq: null };
      const start = Math.max(1, end - limit + 1);

      const rows: FolderPageItem[] = [];
      // The range names at most `limit` messages, so an answer longer than that is the SERVER
      // over-answering a bounded page. Rows past it are declined rather than retained — the page
      // is `limit` items by contract either way, so nothing honest is lost.
      const pageDeadline = this.readDeadline();
      for await (const m of this.client.fetch(
        `${start}:${end}`, { uid: true, envelope: true, flags: true, internalDate: true },
      )) {
        pageDeadline.check(folder);
        // Reached only when the server answers a bounded range with MORE rows than it names;
        // the FETCH is still running, so the connection is retired rather than reused.
        if (rows.length >= limit) {
          this.retireConnection(
            new ImapBoundExceeded("page_rows", limit, rows.length + 1, folder),
          );
          break;
        }
        const from = m.envelope?.from?.[0];
        const date = m.envelope?.date ?? m.internalDate;
        rows.push({
          uid: m.uid,
          seq: m.seq,
          subject: ingestSubject(m.envelope?.subject),
          from: { name: ingestDisplayName(from?.name), address: from?.address?.trim().toLowerCase() ?? "" },
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
   * One bounded SEARCH of a named folder — the Junk window's search-append (FOLDERS-SPEC.md
   * §16.2). Read-only exactly as {@link listFolderPage}: one mailbox lock, one `UID SEARCH` (`OR
   * FROM SUBJECT`, the server's own scan, one round trip), one envelope/flags FETCH of at most
   * `limit` of the NEWEST matching UIDs — never a fetch proportional to the match count;
   * `truncated` says when the cap bit. Header facts only, no `Change`. `null` for a folder the
   * server refuses to SELECT; a transport failure propagates so the caller can say "could not be
   * searched" rather than "no folder".
   */
  async searchFolderPage(
    folder: string,
    query: string,
    opts: { limit?: number } = {},
  ): Promise<FolderSearchPage | null> {
    const limit = Math.max(1, Math.min(opts.limit ?? FOLDER_PAGE_MAX, FOLDER_PAGE_MAX));
    const term = query.trim();
    let lock: { release(): void };
    try {
      lock = await this.bounded(this.client.getMailboxLock(this.toServerPath(folder)));
    } catch (err) {
      // A CEILING BREACH IS NOT "THIS MAILBOX HAS NO SUCH WINDOW", and this arm would have said
      // so. The rule below turns a SELECT refusal into the honest `null` degrade — right for a
      // missing or `\Noselect` folder, and wrong for a deadline or a retired connection, which
      // would be rendered to the person as "you have no Junk folder". It is also not covered by
      // the `usable` check: a throwing retirement deliberately leaves the socket for the caller
      // to close, so the client still reports itself usable.
      if (err instanceof ImapBoundExceeded) throw err;
      if (!(this.client as unknown as { usable?: boolean }).usable) throw err;
      return null;
    }
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      const uidValidity = mb && mb.uidValidity != null ? String(mb.uidValidity) : "0";
      if (!mb || mb.exists === 0 || term.length === 0) return { uidValidity, items: [], truncated: false };

      // BOUNDED BEFORE THE SORT, and the sort one line below is why this matters. The docblock
      // above this method promised "never a fetch proportional to the match count" — true of the
      // FETCH, and false of `[...found].sort()`, which copied and sorted the server's entire
      // match set to take 50 of it. A common word over a decade of junk is a six-figure array
      // that a caller asking for one page has no idea it paid for. See {@link IMAP_SEARCH_MAX_UIDS}.
      const found = await this.searchBounded(
        { or: [{ from: term }, { subject: term }] }, { uid: true }, folder,
      );
      // imapflow does NOT reject a refused SEARCH — it answers `false` (its declared return is
      // `number[] | false`). Reading that as "no matches" would make a failed provider search
      // an honest-looking empty answer; it is a failure, and the caller states it as one.
      if (!Array.isArray(found)) throw new Error("the server refused the SEARCH");
      const uids = [...found].sort((a, b) => b - a);
      if (uids.length === 0) return { uidValidity, items: [], truncated: false };
      const wanted = uids.slice(0, limit);

      const rows: FolderPageItem[] = [];
      // `wanted` names at most `limit` UIDs; a longer answer is the server over-answering. Same
      // rule as {@link listFolderPage}.
      const pageDeadline = this.readDeadline();
      for await (const m of this.client.fetch(
        wanted, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true },
      )) {
        pageDeadline.check(folder);
        // Reached only when the server answers a bounded range with MORE rows than it names;
        // the FETCH is still running, so the connection is retired rather than reused.
        if (rows.length >= limit) {
          this.retireConnection(
            new ImapBoundExceeded("page_rows", limit, rows.length + 1, folder),
          );
          break;
        }
        const from = m.envelope?.from?.[0];
        const date = m.envelope?.date ?? m.internalDate;
        rows.push({
          uid: m.uid,
          seq: m.seq,
          subject: ingestSubject(m.envelope?.subject),
          from: { name: ingestDisplayName(from?.name), address: from?.address?.trim().toLowerCase() ?? "" },
          date: date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
          messageIdHeader: m.envelope?.messageId ?? null,
          seen: m.flags?.has("\\Seen") ?? false,
        });
      }
      rows.sort((a, b) => b.seq - a.seq);
      return { uidValidity, items: rows, truncated: uids.length > wanted.length };
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
      lock = await this.bounded(this.client.getMailboxLock(this.toServerPath(folder)));
    } catch (err) {
      // A CEILING BREACH IS NOT "THIS FOLDER IS NOT THERE". The arm below turns any SELECT
      // failure into an honest "no such folder / nothing to do" answer, which is right for a
      // missing or unselectable mailbox and WRONG for a deadline: it would report a server that
      // stopped answering as an empty result, which is the silent degrade this whole file exists
      // to replace with a refusal. See `imap-bounds.ts`.
      if (err instanceof ImapBoundExceeded) throw err;
      return [];   // not present / not selectable — the kickstart simply has no material
    }
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      if (!mb || mb.exists === 0) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      const start = Math.max(1, mb.exists - limit + 1);
      // The same open-ended range and the same non-terminating exit condition as
      // {@link sampleSenders} — see {@link IMAP_SAMPLE_MAX_ROWS}.
      let examined = 0;
      const scanDeadline = this.readDeadline();
      outer:
      for await (const m of this.client.fetch(`${start}:*`, { envelope: true })) {
        scanDeadline.check(folder);
        if (++examined > IMAP_SAMPLE_MAX_ROWS) {
          this.retireConnection(
            new ImapBoundExceeded("sample_rows", IMAP_SAMPLE_MAX_ROWS, examined, folder),
          );
          break outer;
        }
        // TRUNCATED PER LIST, not after the spread. The docblock above says `limit` "bounds BOTH
        // the messages scanned and the addresses returned, so a single mail with a 4 000-address
        // To: header cannot turn a bounded scan into an unbounded result" — true of the RESULT,
        // and false of this line, which materialised all 4 000 before the loop looked at one.
        // See {@link IMAP_ENVELOPE_ADDRESSES_MAX}: a sample's inputs may be trimmed.
        const rcpts = [
          ...boundEnvelopeAddresses(m.envelope?.to ?? []),
          ...boundEnvelopeAddresses(m.envelope?.cc ?? []),
          ...boundEnvelopeAddresses(m.envelope?.bcc ?? []),
        ];
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
   * Learn the customer's own folders from a LIST response — see {@link
   * ImapAdapter.passiveFolders}. Called from `connect()`, `ensureFolders()` and `foldersToScan`;
   * writes three fields, issues no command. The Sent path it excludes against is `this.sentFolder
   * ?? this.scanSentFolder` — the one the scan will use, since a no-SPECIAL-USE server resolves
   * Sent by name; getting it wrong reads Sent twice per cycle and hands every message the
   * customer wrote to the Screener. On `connect()` a negative Sent answer is not yet known, so
   * this can admit Sent for one pass — `foldersToScan` re-filters every call and is the
   * authority.
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
    const list = await this.listBounded();
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
   * SPECIAL-USE first, then {@link JUNK_BY_NAME}/{@link TRASH_BY_NAME} on the canonical leaf —
   * the same two-step `findSentForScan` runs, because plenty of live servers advertise no
   * SPECIAL-USE and imapflow's `specialUse` is a localized-name guess on those. `\Noselect` and
   * the `ohmail` namespace are excluded. Positive answers are memoised for the connection; a null
   * is re-asked, so a mailbox that gains a Junk folder is picked up on the next connect.
   * Read-only: one LIST.
   */
  async findSpecialFolders(): Promise<SpecialFolders> {
    if (this.specialJunk !== null && this.specialTrash !== null) {
      return { junk: this.specialJunk, trash: this.specialTrash };
    }
    const list = await this.listBounded();
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
   * The organizer lease's IO, bound to this adapter's live login. The lease needs APPEND,
   * FETCH-headers, STORE `\Deleted` + EXPUNGE, CREATE and UNSUBSCRIBE — none of which belong on
   * `MailboxAdapter`: they are one feature's needs. It reuses the connection rather than opening
   * its own: a second login per mailbox per cycle is how a provider decides to throttle a user,
   * and it would double every deployment's connection count for a message the size of a postcard.
   * Callable only after {@link connect} — `toServerPath` depends on the delimiter discovered at
   * login.
   */
  leaseIo(identity: MetaIdentity): LeaseIo {
    // The lease and profile reads run BEFORE the cycle and on the raw client, so without this a
    // retired adapter's next visit would reach for a destroyed connection here — and that failure
    // is wrapped as a lease fault, which is deliberately not this mailbox's fault. Refuse with the
    // breach instead, so the cause survives the trip.
    this.assertUsable();
    return makeLeaseIo(this.client as unknown as LeaseImapClient, (c) => this.toServerPath(c), identity);
  }

  /**
   * The portable organizer profile's IO, bound to this adapter's live login — the lease's
   * arrangement, for the lease's reasons. A third accessor rather than a widening of {@link
   * leaseIo} because the two read different things at different costs: the lease fetches headers
   * only, every cycle, and must stay that cheap; the profile fetches full sources, rarely —
   * folding `source: true` into the lease's fetch would make the gate's per-cycle cost scale with
   * the profile document's size.
   */
  profileIo(identity: MetaIdentity): ProfileIo {
    // The lease and profile reads run BEFORE the cycle and on the raw client, so without this a
    // retired adapter's next visit would reach for a destroyed connection here — and that failure
    // is wrapped as a lease fault, which is deliberately not this mailbox's fault. Refuse with the
    // breach instead, so the cause survives the trip.
    this.assertUsable();
    return makeProfileIo(this.client as unknown as ProfileImapClient, (c) => this.toServerPath(c), identity);
  }

  /**
   * The organizer lease, READ-ONLY, for a surface that reports who holds a mailbox rather than
   * competing for it. A second accessor rather than a flag on {@link leaseIo} because the
   * difference must be visible at the call site and unreachable from it: `leaseIo()` hands out
   * APPEND and EXPUNGE, and an API process holding that object is one line away from becoming an
   * organizer — a failure that would look like a settings pane quietly standing the user's own
   * laptop down. This object has one method, and it reads. It never CREATEs `ohmail/_meta` — see
   * {@link makeLeasePeekIo}.
   */
  leasePeekIo(): LeasePeekIo {
    // The lease and profile reads run BEFORE the cycle and on the raw client, so without this a
    // retired adapter's next visit would reach for a destroyed connection here — and that failure
    // is wrapped as a lease fault, which is deliberately not this mailbox's fault. Refuse with the
    // breach instead, so the cause survives the trip.
    this.assertUsable();
    return makeLeasePeekIo(this.client as unknown as LeaseImapClient, (c) => this.toServerPath(c));
  }

  /**
   * A reader's decision, waiting for the organizer — the reader's half of the request channel,
   * bound to this adapter's live login. A fourth accessor beside {@link leaseIo}, {@link
   * leasePeekIo} and {@link profileIo}: the capability must be visible at the call site. And it
   * is a PAIR, not one object — a single `requestIo()` once handed out list, append AND expunge
   * together, so a reader's accessor could reach the organizer's remove, separated only by which
   * method the caller happened to call. Two roles now get two types: this one has no `remove` to
   * reach for, and the compiler says so.
   */
  requestReaderIo(): RequestReaderIo {
    // The lease, profile and request reads all run BEFORE the cycle and on the raw client, so
    // without this a retired adapter's next visit would reach for a destroyed connection here —
    // and that failure would be wrapped as a request fault, which is deliberately not this
    // mailbox's fault. Refuse with the breach instead, so the cause survives the trip.
    this.assertUsable();
    return makeRequestReaderIo(this.client as unknown as LeaseImapClient, (c) => this.toServerPath(c));
  }

  /**
   * THE ORGANIZER'S HALF — look, acknowledge what was handled, and remove it. See
   * {@link requestReaderIo} for why the two are separate objects rather than one.
   */
  requestOrganizerIo(identity: MetaIdentity): RequestOrganizerIo {
    this.assertUsable();
    return makeRequestOrganizerIo(this.client as unknown as LeaseImapClient, (c) => this.toServerPath(c), identity);
  }

  /**
   * Is this LIST row our folder, or somebody else's directory that happens to end in our name?
   * When the client declared namespaces, `resolveOhmailFolder`'s authoritative branch answers —
   * it accepts only the first personal namespace's prefix. The derived branch is the loose one:
   * with no NAMESPACE it accepts any prefix whose parent the server LISTs, the right trade for a
   * lease read and the wrong one for deciding not to create a folder at all. So on that branch
   * the prefix must be the personal ROOT — empty, or `INBOX` + delimiter; `Backup.` is refused
   * and the folder is created under our own name.
   */
  private isOwnFolderPath(
    found: string, bare: string,
    namespaces: readonly { prefix?: string; delimiter?: string | null }[],
  ): boolean {
    if (namespaces.length > 0) return true;
    const prefix = found.slice(0, found.length - bare.length);
    if (prefix === "") return true;
    const parent = prefix.slice(0, prefix.length - this.delimiter.length);
    /**
     * The literal `INBOX` is a deliberate trade. The LIST-derived test reintroduces the defect
     * this function exists for: `Backup` IS a listed mailbox, so the derived test accepts
     * `Backup.ohmail.Reads`, the CREATE is skipped, and our folder is never made. The rules
     * differ because the failures differ: a wrong lease READ is one bounded wrong answer; a
     * create-if-absent answering wrongly is a folder that never exists. With no NAMESPACE the
     * only nameable root is `INBOX`, the one name RFC 3501 mandates. The cost, stated: a
     * no-NAMESPACE server whose root is not `INBOX` re-CREATEs all five per connect — swallowed
     * as "already exists", the benign side.
     */
    return parent.toUpperCase() === "INBOX";
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

  /**
   * Enumerate current UIDs of the open mailbox (delete + fallback create detection). Bounded at
   * the READ: this walked `1:*` into an array, then a `Set` and a `filter` — three retained
   * copies of a number the SERVER picks; {@link DEFAULT_SYNC_BATCH_MAX_MESSAGES} bounds only the
   * bodies fetched afterwards. {@link boundedCollect} stops PULLING at the ceiling and checks the
   * clock as it goes ({@link IMAP_ENUM_MAX_UIDS}). It THROWS rather than truncating: a short
   * enumeration reads downstream as "those UIDs are gone", the durable lie the `unanswered`
   * machinery exists to prevent.
   */
  private async enumerateUids(folder?: string): Promise<number[]> {
    const mb = this.client.mailbox as MailboxObject | false;
    if (!mb || mb.exists === 0) return [];
    return boundedCollect(this.client.fetch("1:*", { uid: true }), {
      max: IMAP_ENUM_MAX_UIDS, bound: "enumerate_uids",
      deadline: this.readDeadline(), folder,
      // `notify` is true only for the non-throwing ("stop") disposition.
      onAbandon: (_notify, because) => this.retireConnection(because),
      map: (m) => m.uid,
    });
  }

  /**
   * UIDs of the newest `count` messages of the OPEN mailbox, by SEQUENCE number.
   *
   * The Sent folder's FIRST scan. Sequence numbers, not UIDs, because "the newest
   * N" is a position question and UIDs are not contiguous after deletes — `scanSentRecipients`
   * asks the same question the same way.
   */
  private async enumerateNewestUids(count: number, folder?: string): Promise<number[]> {
    const mb = this.client.mailbox as MailboxObject | false;
    if (!mb || mb.exists === 0) return [];
    const start = mb.exists > count ? mb.exists - count + 1 : 1;
    // The sequence range asks for `count`; the SERVER decides what it actually sends back, and a
    // range is not a promise. Same ceiling and same clock as {@link enumerateUids}.
    return boundedCollect(this.client.fetch(`${start}:*`, { uid: true }), {
      max: IMAP_ENUM_MAX_UIDS, bound: "enumerate_uids",
      deadline: this.readDeadline(), folder,
      // `notify` is true only for the non-throwing ("stop") disposition.
      onAbandon: (_notify, because) => this.retireConnection(because),
      map: (m) => m.uid,
    });
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
  private async enumerateUidsFrom(fromUid: number, folder?: string): Promise<number[]> {
    const mb = this.client.mailbox as MailboxObject | false;
    if (!mb || mb.exists === 0) return [];
    // The ceiling counts what the server SENDS, not what survives the `uid >= fromUid` filter —
    // otherwise a server answering `UID FETCH n:*` with every UID it has, below the watermark and
    // all (the reversed-range behaviour this filter exists for), would stream without limit while
    // the array stayed empty and the bound never fired.
    const kept: number[] = [];
    await boundedCollect(this.client.fetch(`${fromUid}:*`, { uid: true }, { uid: true }), {
      max: IMAP_ENUM_MAX_UIDS, bound: "enumerate_uids",
      deadline: this.readDeadline(), folder,
      // `notify` is true only for the non-throwing ("stop") disposition.
      onAbandon: (_notify, because) => this.retireConnection(because),
      map: (m) => { if (m.uid >= fromUid) kept.push(m.uid); return 0; },
    });
    return kept;
  }

  /**
   * The arrival date of every candidate UID, cached per (folder, epoch). A separate fetch from
   * the RFC822.SIZE one: sizes are needed only for messages past the count cap, dates for every
   * CANDIDATE — widening the size fetch would silently unbound it. Chunked, because
   * `ImapFlow.fetch` serialises an array with `range.join(',')` — thousands of UIDs make a
   * command tens of KB (measured), and date ordering fragments the unknown set so it cannot be a
   * range. Cached, because re-asking a shrinking set every pass is O(n²/batch) over a drain: read
   * once, later passes ask only about new arrivals, pruned to the live candidate set.
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
   * The memory bound of the whole worker: every path that pulls `source: true` goes through here
   * ({@link DEFAULT_SYNC_BATCH_MAX_MESSAGES}). "Newest first" used to mean "highest UID first",
   * and a UID is an arrival counter, not a clock — this sort decides page 1 of a fresh account's
   * bootstrap (commits allocate `change_log.seq` in array order), and measured, the newest mail
   * did not arrive until page 4 of 34. {@link arrivalKey} is the sort key. Sizes still come from
   * a bounded RFC822.SIZE pre-fetch; the byte cap and anti-stall rule are untouched; at least one
   * message is always taken.
   */
  private async fetchCapped(
    uids: number[],
    folder: string,
    curUidValidity: bigint,
    budget: { messages: number; bytes: number },
  ): Promise<{
    fetched: InternalCreate[]; truncated: boolean; unanswered: number[];
    oversize: Array<{ uid: number; size: number }>;
  }> {
    const fetched: InternalCreate[] = [];
    if (uids.length === 0) return { fetched, truncated: false, unanswered: [], oversize: [] };

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
    /** Refused from RFC822.SIZE alone — see {@link ChangeBatch.oversize}. Never fetched. */
    const oversize: Array<{ uid: number; size: number }> = [];
    let bytes = 0;
    for (const uid of slice) {
      const size = sizes.get(uid) ?? 0;
      // The hard ceiling is enforced before the body moves, not after. The anti-stall rule admits
      // the first message past the BATCH byte budget, and until this gate a message whose
      // RFC822.SIZE already exceeded `MAX_RAW_MESSAGE_BYTES` was downloaded whole so
      // `normalizeMime` could refuse it — a transfer whose only outcome was known before it
      // started. Refusing here writes the same durable `mime_too_large` row (the caller's
      // obligation, `ChangeBatch.oversize`), so the UID joins the known-set and is size-probed
      // once per build. NOT counted as `truncated`: this message is not deferred, its outcome is
      // decided — marking it backlog would re-kick the mailbox for ever over a message no cycle
      // will admit.
      if (size > MAX_RAW_MESSAGE_BYTES) {
        oversize.push({ uid, size });
        continue;
      }
      // `take.length === 0` is the anti-stall rule: the first message is always admitted past the
      // BATCH budget, so the drain can never wedge on one large-but-storable mail. `continue`,
      // NOT `break` — measured: a `break` made one large message a plug for everything behind it
      // (a production Sent folder held a 26 MB message third in newest-first order; the two ahead
      // dedup'd to existing rows, so every cycle broke on it and never reached the hundreds
      // behind — a first scan that could not finish). Skipping keeps filling the batch with what
      // fits: the pass stays truncated, the unknown set strictly shrinks, and the skipped message
      // is admitted the moment it reaches the front.
      if (take.length > 0 && bytes + size > budget.bytes) { truncated = true; continue; }
      take.push(uid);
      bytes += size;
    }
    if (take.length === 0) return { fetched, truncated, unanswered: [], oversize };

    /**
     * The byte budget above trusts a number the server chose — the literal-length arm. Everything
     * above is bounded against `RFC822.SIZE`, and the fetch below had no byte accounting of its
     * own: a server answering `RFC822.SIZE 1` for two hundred messages and streaming a gigabyte
     * each satisfies every ceiling on paper. So the bytes that ARRIVE are counted — per message
     * against what it declared, in total against what the batch declared — and the loop STOPS at
     * the first crossing. The honest limit, stated: `ImapFlow.fetch` yields a `source` already
     * buffered, so refusing here bounds what is retained and fetched AFTER the liar; it cannot
     * un-buffer the liar itself. {@link IMAP_BODY_OVERRUN_FACTOR} carries the numbers.
     */
    const declaredTotal = take.reduce((sum, uid) => sum + (sizes.get(uid) ?? 0), 0);
    const batchCeiling = bodyOverrunCeiling(declaredTotal);
    let streamedBytes = 0;
    const bodyDeadline = this.readDeadline();

    for await (const m of this.client.fetch(
      take,
      { uid: true, flags: true, envelope: true, source: true, internalDate: true },
      { uid: true },
    )) {
      bodyDeadline.check(folder);
      const arrived = ((m.source ?? Buffer.alloc(0)) as Buffer).length;
      const declared = sizes.get(m.uid);
      // Throwing out of a `for await` leaves the FETCH outstanding — see `retireConnection`.
      if (arrived > bodyOverrunCeiling(declared)) {
        const because = new ImapBoundExceeded(
          "body_overrun", bodyOverrunCeiling(declared), arrived, folder,
        );
        this.retireConnection(because);
        throw because;
      }
      streamedBytes += arrived;
      if (streamedBytes > batchCeiling) {
        const because = new ImapBoundExceeded("body_overrun", batchCeiling, streamedBytes, folder);
        this.retireConnection(because);
        throw because;
      }
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
       * Not `dates.set(...)` here, though the body fetch carries both fields. Every UID in `take`
       * came out of `arrivalDatesFor`, so its key is already cached — and writing it again would
       * OVERWRITE the value the selection was made with, so if the two ever disagreed the page
       * would be emitted in a different order from the one it was chosen in. They cannot disagree
       * against a real server, which is exactly why the hazard would never show in production; a
       * test fake answering the two fetches differently is what caught it.
       */
    }

    /**
     * Sorted again, after the fetch, and this is not redundant. `ImapFlow.fetch` yields in the
     * order the SERVER streams — ascending sequence number — not the order the UIDs were asked
     * for. Selecting `take` newest-first bought the right two hundred messages and then handed
     * them over oldest-first; this array is committed in order and each commit allocates the next
     * `change_log.seq`, so the client received each page of its own mailbox backwards. Found by a
     * test expecting emitted order to match requested order on a batch of identical dates — it
     * failed against the original code too.
     */
    // The server may answer with fewer messages than asked — RFC 3501 allows it, no error, no
    // per-UID signal. `fetchByUid` derives its `absent` set by subtraction for that reason; this
    // function read a short answer as complete, so a withheld UID left no create, no
    // `hasBacklog`, no ledger row, while the cursor published `mb.uidNext` as though the folder
    // had drained. Not hypothetical: iCloud cannot serialize an ENVELOPE for a quoted-string
    // `Message-ID` and omits the row — measured live, one folder imported ZERO mail while its
    // cursor read complete. So ask again WITHOUT the field the server cannot produce: the
    // envelope is wanted for one value, the Message-ID, and the raw source carries it. A UID
    // still absent after that is returned to the caller, which must record it durably BEFORE the
    // cursor crosses it (`ChangeBatch.unanswered`).
    const answered = new Set(fetched.map((f) => f.uid));
    const withheld = take.filter((u) => !answered.has(u));
    let unanswered: number[] = [];
    if (withheld.length > 0) {
      for await (const m of this.client.fetch(
        withheld,
        { uid: true, flags: true, source: true, internalDate: true },
        { uid: true },
      )) {
        // ── THE RETRY IS A BODY FETCH TOO, AND IT WAS THE HOLE IN THE ACCOUNTING ────────────
        //
        // The byte accounting above was applied to the FIRST body fetch only, which left the
        // cleanest bypass in the slice: a server declares a tiny `RFC822.SIZE`, OMITS the row from
        // the first fetch — the exact iCloud behaviour this retry exists for, so it is a shape the
        // adapter already expects rather than a contrived one — and then returns an arbitrarily
        // large body here, past every size ceiling. Same per-message and batch-total rules, same
        // clock.
        bodyDeadline.check(folder);
        const arrivedRetry = ((m.source ?? Buffer.alloc(0)) as Buffer).length;
        const declaredRetry = sizes.get(m.uid);
        if (arrivedRetry > bodyOverrunCeiling(declaredRetry)) {
          const becauseRetry = new ImapBoundExceeded(
            "body_overrun", bodyOverrunCeiling(declaredRetry), arrivedRetry, folder,
          );
          this.retireConnection(becauseRetry);
          throw becauseRetry;
        }
        streamedBytes += arrivedRetry;
        if (streamedBytes > batchCeiling) {
          const becauseBatch = new ImapBoundExceeded("body_overrun", batchCeiling, streamedBytes, folder);
          this.retireConnection(becauseBatch);
          throw becauseBatch;
        }
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
    return { fetched, truncated, unanswered, oversize };
  }

  /**
   * The folders one `changesSince` pass reads: the frozen six, the mailbox's own Sent folder, and
   * the customer's own folders LAST. `sent` is null on a server with no Sent folder, and dropped
   * when it collides with a watched folder — a Sent path resolving to `INBOX` must be read once
   * and must not tag INBOX creates own-authored. Passive folders last is the cost answer: one
   * budget spent in this order, so fifteen years of archives cannot delay this cycle's inbound
   * mail — they drain through `hasBacklog` re-kicks. Sent is re-filtered here, not only at
   * discovery: `learnPassiveFolders` runs before the name fallback, so its field is a candidate
   * list and this is the authority.
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
    // The LIST is per-cycle when the server can answer it in one command. With RFC 5819
    // LIST-STATUS the server returns every folder's UIDNEXT/MESSAGES/HIGHESTMODSEQ inside the
    // LIST, so asking every cycle costs one command and buys the `unchangedPassive` skip — what
    // keeps a 110-folder mailbox from paying 110 SELECTs to learn nothing happened; both
    // production providers advertise it. Without it, imapflow issues a STATUS per listed folder
    // to satisfy `statusQuery` — 137 commands where the point was saving round trips — so the
    // query is not sent and the LIST falls back to once per {@link PASSIVE_RELIST_CYCLES} passes.
    // Correct either way; only the cost differs.
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
        this.learnPassiveFolders(await this.listBounded(
          wantStatus
            ? { statusQuery: { messages: true, uidNext: true, highestModseq: true } }
            : undefined,
        ));
      } catch (err) {
        // ── A CEILING BREACH IS NOT "ONE BAD COMMAND" ────────────────────────────────────────
        //
        // This arm exists so a transient LIST failure costs the refresh and nothing else. A
        // {@link ImapBoundExceeded} is the opposite kind of event: the server answered, and the
        // answer was past a ceiling this mailbox's cycle is not allowed to pay. Swallowed here it
        // would be re-paid every cycle for ever, and on the FIRST pass (`passiveFolders === null`)
        // the `??= []` below would additionally drop every customer folder out of the scan
        // silently — a hostile LIST rendered as "you have no folders". So it propagates and
        // fails this mailbox's cycle, which is the whole isolation story (`imap-bounds.ts`).
        if (err instanceof ImapBoundExceeded) throw err;
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
   * Is this PASSIVE folder provably unchanged — may the pass skip the SELECT? Three equalities,
   * all needed, failing CLOSED (any missing field reads normally): `highestModseq` — no flag
   * change, no arrival (RFC 7162 §3.1); `uidNext` — no arrival, redundant on a correct server and
   * kept because iCloud's CHANGEDSINCE is inert; `messages` (EXISTS) — the expunge half the
   * others cannot cover, since CONDSTORE does not raise HIGHESTMODSEQ for an EXPUNGE. A folder
   * holding a permanently-unknown UID never satisfies the third and is read every cycle — the
   * safe direction. Passive folders only: INBOX and the organized five are where the product
   * happens.
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

  /**
   * The pass has a wall-clock budget — the per-mailbox time budget, the TIME arm of the
   * server-value ceilings. A per-read ceiling ({@link IMAP_READ_DEADLINE_MS}) bounds one command,
   * and a pass issues a dozen: each stopping just short of the per-read ceiling is a cycle
   * measured in hours, so the pass carries {@link IMAP_CYCLE_DEADLINE_MS} and every read takes
   * the earlier of the two. Placed here rather than in the worker's scheduler: this method is
   * where the pass begins and ends, so the budget needs a clock and a check, while the scheduler
   * would need rebuilding. `finally`, not a trailing assignment: a pass that throws must still
   * clear the budget, or the next pass inherits an expired clock and refuses instantly.
   */
  async changesSince(cursor: ImapCursor): Promise<ChangeBatch> {
    this.assertUsable();
    this.cycleDeadline = ImapDeadline.in(
      IMAP_CYCLE_DEADLINE_MS, "cycle_deadline", () => this.now(),
    );
    try {
      return await this.changesSinceInner(cursor);
    } finally {
      this.cycleDeadline = undefined;
    }
  }

  private async changesSinceInner(cursor: ImapCursor): Promise<ChangeBatch> {
    const caps = await this.capabilities();
    // ── THE PERSISTED CURSOR IS VALIDATED HERE, NEVER TRUSTED FROM ITS TYPE ─────────────────
    //
    // `ImapCursor` says `known` is always present; the STORED value is JSON written by another
    // build, hand-edited, or partial, and `(p?.known.length ?? 0)` guarded the wrong dereference —
    // it throws for a row that exists without the array, which core's src-only tsconfig cannot
    // see. A folder whose stored shape this
    // build cannot read is re-bootstrapped: no `prev` means cold, which is the one honest reading,
    // and the names are reported on the batch so the caller can say so out loud.
    const stored = new Map<string, FolderCursor>();
    const unreadableCursors: string[] = [];
    for (const [name, value] of Object.entries(cursor.folders ?? {})) {
      const ok = usableFolderCursor(value);
      if (ok) stored.set(name, ok);
      else unreadableCursors.push(name);
    }
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
    /** UIDs refused pre-fetch on RFC822.SIZE — see {@link ChangeBatch.oversize}. */
    const oversize: Array<{ folder: string; uidValidity: string; uid: number; size: number }> = [];
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

    // The flag budget is shared, so it needs a SCHEDULE, not a queue. Spending it in
    // `scanFolders` order is FIFO, and FIFO on a shared resource starves the tail — measured: one
    // folder owed 5 101 known UIDs (sixteen cycles of budget) and the five behind it were never
    // reached, so every cursor was held, `hasBacklog` pinned true, and the first-import stamp
    // stayed NULL for days on a mailbox doing no work. Fairness comes from scheduling, never the
    // cursor: ROTATION — `flagCycle` picks which owing folder leads, so no folder is permanently
    // last; OWED SHARE — a folder may take `ceil(remaining / claimants-from-here-on)`, the
    // divisor shrinking so unused share passes backward and the whole budget is spent. The leader
    // is exempt down to `flagFloor` per folder behind it. `scanFolders` order is untouched — it
    // is the CREATES order, a mail-latency guarantee; only the allowance rotates.
    const flagTotal = budget.flags;
    // Eligible: could run a flag pass at all this cycle. With CONDSTORE that means a modseq
    // baseline exists; without it (the FALLBACK — Office 365 advertises no CONDSTORE) it means
    // the known-set carries seen baselines to diff against, and the Sent folder is out — see the
    // fallback block below for both. A folder that never reaches the fetch must not have budget
    // reserved for it, which would be reserving it for nobody.
    const flagEligible = scanFolders.filter((f) => {
      const p = stored.get(f);
      if (caps.condstore) return !!p && p.highestModseq !== "0";
      return f !== sentFolder && p !== undefined && p.known.length > 0;
    });
    // Claimants: the folders KNOWN to owe — before the fetch, "has an in-flight drain".
    // Eligibility is not a claim: every watched folder is eligible on a healthy mailbox, so
    // reserving a share for each would hand INBOX a sixth of the budget on a quiet cycle — held
    // for folders that never spend it, slower than the FIFO it replaced (watched:
    // `imap.changes.flagdrain-starvation.test.ts` reported `['1:*', '6:*', '16:*']` for a drain
    // that must read ten at a time). With nothing in flight this degenerates to FIFO exactly; a
    // folder that then owes more than the budget truncates, records a drain, and is a claimant
    // from the next cycle — the transient is one cycle.
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
      const prev = stored.get(folder);
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
        lock = await this.bounded(this.client.getMailboxLock(serverPath));
      } catch (err) {
        // ── A CEILING BREACH IS THE ONE THING THIS ARM MUST NOT ABSORB ────────────────────────
        //
        // This is the most consequential of the SELECT catches. "The folder is not there" is a
        // legitimate, common state and carrying the cursor forward is exactly right for it. A
        // DEADLINE reaching here would be read the same way: the folder is silently reported as
        // having no changes, `hasBacklog` stays false, and the pass ends looking complete — so a
        // server that simply stopped answering one folder's SELECT would present as a healthy,
        // fully-drained cycle. That is the shape `initial_import_completed_at` is written on.
        if (err instanceof ImapBoundExceeded) throw err;
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
        // The fallback: flag changes without CONDSTORE. Office 365 advertises none (measured
        // live), so `canFastPath` is false for ever there — and until this branch existed no flag
        // change was derived: mail read in Outlook stayed bold here permanently. The prior flags
        // are in the known-set (`KnownEntry.seen`), so the fallback fetches FLAGS for the known
        // range, no `changedSince`, and emits a change only where the server DISAGREES with that
        // baseline; agreement is free, so a clean folder costs one flags-only fetch — the price
        // every no-CONDSTORE client pays. SENT is excluded: `pipeline.ts` ingests own-sent mail
        // `seen: true` regardless of the server, so an unflagged Sent row's state is a POLICY,
        // not an observation — diffing it would flip the user's own sent mail unread. The
        // user-wins decision stays in `applyExternalFlag`; this diff is a cost filter.
        const canFlagFallback =
          !caps.condstore && !isSent && !uidValidityChanged && effectiveKnown.size > 0;

        // Enumeration: whole folder, or the Sent watermark. Every watched folder is enumerated
        // end to end, because the known-set diff is what detects creates. Sent cannot use that,
        // for two independent reasons the watermark answers: COST — the folder is unbounded and
        // mostly historical, so `DEFAULT_SENT_HISTORY_MESSAGES` bounds what is ingested and the
        // watermark bounds what is re-read; CORRECTNESS — `own_copy` (`dedup.ts`) stores no row
        // for the Sent twin of a message we already hold, so its UID never enters the known-set
        // and a plain diff would re-fetch its body for ever. A UID is behind the watermark
        // whether or not it produced a row. `enumFloorUid` is what this pass actually looked at:
        // below it, "not in currentSet" means "not enumerated", not "expunged".
        let currentUids: number[];
        let enumFloorUid = 0;
        if (!isSent) {
          currentUids = await this.enumerateUids(folder);
        } else {
          const watermark = uidValidityChanged ? 0 : (prev?.uidNext ?? 0);
          if (watermark > 0) {
            currentUids = await this.enumerateUidsFrom(watermark, folder);
            enumFloorUid = watermark;
          } else {
            // First scan (or a UIDVALIDITY reset): the newest N by sequence number.
            currentUids = await this.enumerateNewestUids(sentHistory, folder);
            // A UIDVALIDITY reset keeps the ordinary full-delete semantics: every prior UID is
            // meaningless, so the floor stays 0 and `knownMap` is emitted wholesale below.
            enumFloorUid = uidValidityChanged
              ? 0
              // ITERATIVE, NOT `Math.min(...currentUids)`.
              //
              // The spread passes one ARGUMENT per element, and the JavaScript engine throws
              // `RangeError: Maximum call stack size exceeded` at roughly 125 000 of them — well
              // below {@link IMAP_ENUM_MAX_UIDS}. So the enumeration ceiling was admitting arrays
              // this line could not then process, which is a ceiling that does not keep its
              // promise: every array the bound accepts has to remain workable, or the bound is
              // just a larger number to crash at.
              : minOf(currentUids, Number.MAX_SAFE_INTEGER);
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
          fetched, truncated, unanswered: withheldUids, oversize: refusedOnSize,
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
        // Same contract, decided from RFC822.SIZE instead of a withheld answer — see
        // {@link ChangeBatch.oversize}: the caller records `mime_too_large` before the cursor
        // crosses these, and the body was deliberately never transferred.
        for (const o of refusedOnSize) {
          oversize.push({ folder, uidValidity: String(curUidValidity), uid: o.uid, size: o.size });
        }

        // A UIDVALIDITY reset makes every remembered UID meaningless, including a drain's
        // resume point. Drop it before anything can read it.
        if (uidValidityChanged) this.flagDrain.delete(folder);

        const drain = this.flagDrain.get(folder);
        let flagsTruncated = false;
        if (canFastPath || canFlagFallback) {
          // Flags only — no bodies, no envelopes: known UIDs are the only ones that can produce a
          // flag change; unknown ones are creates, handled above. Bounded, and resumable by UID:
          // `changedSince` is a fixed query that re-reports the identical set until the cursor
          // moves, so truncating at N without a resume point hands back the same N for ever. The
          // range starts at the drain's resume UID; the modseq stays the one the drain began on.
          // The FALLBACK runs this same loop with two differences: no `changedSince` (the server
          // cannot answer one), and a row is a change only when it diverges from the known-set
          // baseline. The resume machinery is shared, so "mark all read in Outlook" drains across
          // cycles; `sinceModseq`/`advanceTo` are inert in that mode — the folder cursor's
          // `highestModseq` is pinned "0" for a no-CONDSTORE server.
          const from = drain?.resumeUid ?? 1;
          const since = drain?.sinceModseq ?? prev!.highestModseq;
          // The resume point is what this pass EXAMINED, not what it accepted. Seeded at `from -
          // 1` so `resumeUid: lastFlagUid + 1` reads "no progress" when nothing was accepted;
          // seeded at 0 the same expression wrote `resumeUid: 1` — START OVER, discarding every
          // UID earlier cycles reported. That mattered because the budget is shared: a folder
          // reaching this loop with the budget spent by INBOX rewound to 1, and a drain needing
          // four clean cycles, reset every third by an INBOX burst, never finishes — `hasBacklog`
          // true for ever, the first-import stamp never written. The starved-every-cycle residual
          // was real; the schedule above closes it — progress is guaranteed per cycle by
          // `allowance`. `allowance` can be 0 after rounding, so `flagsTruncated` does not imply
          // anything was accepted — a share bounds from above.
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
          // ── THE FLAG BUDGET COUNTS CHANGES; THIS COUNTS ROWS, AND THEY ARE NOT THE SAME ────
          //
          // `taken` and `budget.flags` bound flag CHANGES. The two dispositions below that are
          // not changes — an unknown UID, and a row agreeing with the baseline — `continue`
          // without spending either, and on a provider whose CHANGEDSINCE is inert (iCloud, as
          // the note below records) EVERY row is one of those. So the drain streamed the whole
          // folder with no ceiling engaged at all. See {@link IMAP_FLAG_SCAN_MAX_ROWS} for why
          // this one truncates instead of refusing: the drain has a resume point, so stopping is
          // a bounded degrade that keeps every flag rather than a failed cycle.
          let examined = 0;
          const flagDeadline = this.readDeadline();
          for await (const m of this.client.fetch(
            `${from}:*`,
            { uid: true, flags: true },
            canFastPath ? { uid: true, changedSince: BigInt(since) } : { uid: true },
          )) {
            flagDeadline.check(folder);
            // This used to truncate, and the premise was false. It set `flagsTruncated` and
            // broke, arguing the drain's resume point keeps every flag — the resume point is
            // real; the stopping was not. Breaking out of an ImapFlow generator does not cancel
            // the FETCH: the driver keeps draining and the next folder's SELECT queues behind a
            // response nobody is reading, so a server willing to stream for ever wedged the cycle
            // while the pass reported a tidy truncation. A breach is now what it is: this server
            // sent an unreasonable number of rows, the connection is finished, this mailbox's
            // cycle fails. The ordinary truncation below (`taken >= allowance`) is untouched — a
            // response the server is finishing normally is a different event.
            if (++examined > IMAP_FLAG_SCAN_MAX_ROWS) {
              const becauseFlags = new ImapBoundExceeded(
                "flag_scan_rows", IMAP_FLAG_SCAN_MAX_ROWS, examined, folder,
              );
              this.retireConnection(becauseFlags);
              throw becauseFlags;
            }
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
            // Agreement with the baseline is not a change, on BOTH paths. A baseline the repo
            // could not state (`seen` null) is the only split: the fallback skips it — inventing
            // a divergence adopts a value nobody observed; the fast path reports it — CONDSTORE
            // named the row. This used to exempt the CONDSTORE path, a claim about the server
            // that is false on one people use: iCloud's CHANGEDSINCE is INERT, answering the
            // folder's own HIGHESTMODSEQ with every message, so every row was a "change", every
            // folder truncated every cycle, and the first-import stamp was unreachable for ever.
            // Why this cannot lose a flag: `KnownEntry.seen` IS `flag_state.observed_seen`, what
            // `applyExternalFlag` compares against — a suppressed row is one whose application
            // would answer `changed: false`. Monotone: it only suppresses no-ops.
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

        // The cursor is held PER FIELD — the three fields are held for different reasons.
        // `uidValidity`: an identity, not a watermark — held while anything is owed; the "0" → V
        // promotion in `sync.ts` is a first-time set. `uidNext`: held whenever creates were
        // truncated — the mail-safety one: Sent reads it, and a watermark above unfetched mail is
        // mail never enumerated again while `own_copy` guarantees no row exists to notice; the
        // only safe watermark is min(unknown UID not fetched). `highestModseq`: held only when
        // the FLAG pass truncated (or no CONDSTORE) — holding it for creates-truncation meant no
        // first baseline was ever published and no flag pass ever ran. A completed drain advances
        // only to where it BEGAN (`FlagDrain.advanceTo`). Residual: a `\Seen` toggled between a
        // create and the first baseline is never reported.
        const advanceTo = drain && !flagsTruncated
          ? drain.advanceTo
          : String(mb.highestModseq ?? 0n);
        newFolders[folder] = {
          // ── THE EPOCH IS NOT A PROGRESS CURSOR, AND HOLDING IT BACK IS A WEDGE ────────────
          //
          // A truncated page holds `uidNext` and `highestModseq` because a cursor that advances
          // past unread work loses mail. UIDVALIDITY is not that kind of value: it names WHICH
          // numbering the other two live in. Held back across a reset, the next cycle sees the
          // change again, empties the known-set again, re-emits every prior UID as a delete
          // again — the same slice for ever. Publishing it means the
          // two epoch-scoped cursors must go cold with it: `prev.uidNext` counts UIDs that no
          // longer exist, and the Sent watermark reads it, so carrying it into a new epoch would
          // strand every message below it.
          uidValidity: uidValidityChanged || !(truncated || flagsTruncated)
            ? String(curUidValidity)
            : (prev?.uidValidity ?? "0"),
          uidNext: uidValidityChanged && truncated ? 0 : truncated ? (prev?.uidNext ?? 0) : mb.uidNext,
          // …AND THE MODSEQ BASELINE IS EPOCH-SCOPED TOO, which the uidNext line above learned
          // first. A modseq remembered under the old epoch names nothing in the new one, and it
          // is the value `canFastPath` asks `changedSince` for — so it goes cold with the epoch
          // exactly where `prev` would otherwise be carried. A value read from the SERVER THIS
          // PASS is fine and is published unchanged.
          highestModseq: flagsTruncated || !caps.condstore
            ? (uidValidityChanged ? "0" : (prev?.highestModseq ?? "0"))
            : advanceTo,
          // THE SERVER'S OWN COUNT, which this SELECT already answered and which was discarded
          // here for the whole life of the adapter . It is deliberately NOT held back
          // under truncation the way the three cursors above are: a cursor that advances past
          // unread work loses mail, so truncation must hold it — but a COUNT is just what the
          // folder holds right now, and reporting last cycle's total for a folder that is
          // visibly growing is the one thing a progress strip must not do.
          ...(typeof mb.exists === "number" ? { serverExists: mb.exists } : {}),
        };
        // What the SERVER said about INBOX at the moment this scan read it — NOT the cursor value
        // above, which deliberately holds back under truncation. {@link rearmWatch} compares the
        // re-arm SELECT's uidNext against this to close the scan→re-arm blind window: a message
        // that arrives after this read and before the visit's last folder op emits `exists` into
        // whatever folder is then selected (or into nothing), and the re-arm's own SELECT absorbs
        // it into a fresh baseline — silently, without this record to diff against.
        if (folder === "INBOX") {
          this.lastInboxSeen = { uidValidity: String(curUidValidity), uidNext: mb.uidNext ?? 0 };
        }
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
        // Passive presence, stamped by the only component that knows. `Change.passive` is on
        // `ownAuthored`'s precedent: the pipeline cannot derive it, because "is this one of the
        // customer's own folders" is a fact about the server's folder inventory and this class is
        // the only thing that has LISTed it — guessing from the folder name would re-implement
        // `passiveFolderExclusion` and get Sent wrong on every no-SPECIAL-USE server. Stamped on
        // pure creates only: a correlated MOVE into a passive folder is the customer filing mail
        // we already hold, and `adopt_external` already answers that — it follows their hand and
        // writes `last_set_by = 'external'` itself.
        ...(passiveFolders.has(c.folder) ? { passive: true } : {}),
      })),
      moves: correlated.moves,
      flagChanges,
      deletes: correlated.deletes.map((d): Change => ({ type: "delete", locator: { folder: d.folder, ref: makeRef(d.uidValidity, d.uid) } })),
      newCursor: { folders: newFolders },
      hasBacklog,
      unanswered,
      oversize,
      ...(unreadableCursors.length > 0 ? { rebootstrapped: unreadableCursors } : {}),
    };
  }

  /**
   * Re-read named UIDs of one folder — see {@link MailboxAdapter.fetchByUid}; these notes are
   * mechanics. Every named UID gets an answer: `creates ∪ absent ∪ oversize` is exactly the set
   * asked about, `absent` derived by subtraction because RFC 3501 lets a `UID FETCH` return fewer
   * with no signal. Not through `fetchCapped`, deliberately: that is the worker's memory bound,
   * and a handful of retry UIDs would evict `arrivalDatesFor`'s cache, making the next
   * `changesSince` re-fetch metadata for the whole unknown set. The size pre-check is not an
   * optimisation: a UID over `opts.maxBytes` is reported without its body — the reachable
   * failures are deterministic in the raw bytes.
   */
  async fetchByUid(
    folder: string, uids: readonly number[], opts: FetchByUidOptions = {},
  ): Promise<TargetedFetch> {
    const wanted = [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0);
    // The Sent path BEFORE the lock: `findSentForScan` may issue LIST, and imapflow's mailbox lock
    // is not re-entrant. Resolved DIRECTLY rather than through `foldersToScan`, whose LIST-STATUS
    // arm re-lists the whole folder inventory on every call — a caller that fetches in chunks
    // (the junk-restore pass) was paying one full LIST per four messages for a
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

    const lock = await this.bounded(this.client.getMailboxLock(this.toServerPath(folder)));
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
      // A UID the body fetch withheld is not necessarily gone. This used to read "expunged
      // between the two commands" and let the subtraction drop it into `absent` — a durable lie:
      // `sync.ts` closes an `absent` UID as `gone_from_server` and deletes its failure row, so a
      // message still on the server stops being owed by anything. The premise is false on a real
      // server: iCloud answers `RFC822.SIZE` for a quoted-string `Message-ID` and omits that
      // message from any fetch requesting ENVELOPE. So ask again without the field, as the batch
      // path does; only a UID still missing after the envelope-free retry is treated as gone — it
      // failed two different commands, the strongest evidence this protocol offers.
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
   * one destination lock: the UID validity, the UIDs sharing the message's `Message-ID`, and the
   * subset that are byte-for-byte OUR message by full fingerprint. `candidates` and `matches` are
   * returned separately because the gap between them is the whole signal: a shared `Message-ID`
   * means nothing (anyone may name one the mailbox holds), a fingerprint match covers every field
   * a sender chooses. With `sourceFingerprint` null, `matches` is empty by construction — the
   * safe direction at both call sites: a refusal rather than a guess.
   */
  private async destinationLook(
    dstPath: string, messageId: string | null, sourceFingerprint: string | null,
  ): Promise<{ uidValidity: bigint; candidates: number[]; matches: number[] }> {
    const lock = await this.bounded(this.client.getMailboxLock(dstPath), dstPath);
    try {
      const uidValidity = (this.client.mailbox as MailboxObject).uidValidity;
      const inner = messageId ? messageId.replace(/[<>]/g, "").trim() : "";
      const found = inner
        ? await this.searchBounded({ header: { "message-id": inner } }, { uid: true }, dstPath)
        : [];
      const candidates = Array.isArray(found) ? found : [];
      const matches: number[] = [];
      if (sourceFingerprint !== null) {
        // The worst count-to-bytes multiplier in this file: the loop below fetches a full message
        // body per candidate. Message-IDs are meant to be unique, so the honest count is 0 or 1 —
        // but the count comes from a SEARCH the server answers, and ten thousand UIDs turn one
        // move into ten thousand body downloads on the worker's shared connection. {@link
        // IMAP_SEARCH_MAX_UIDS} bounds the array and is far too loose to bound this, hence the
        // second, tighter ceiling ({@link IMAP_CANDIDATE_BODY_PROBES_MAX}). Past it the move
        // REFUSES rather than adopting a prefix: with more identically-identified candidates than
        // the probe budget, the pre-check cannot establish which message it is looking at.
        if (candidates.length > IMAP_CANDIDATE_BODY_PROBES_MAX) {
          throw new ImapBoundExceeded(
            "candidate_body_probes", IMAP_CANDIDATE_BODY_PROBES_MAX, candidates.length, dstPath,
          );
        }
        // And the count ceiling alone is not enough, because one body is unbounded: a candidate
        // count of ONE satisfies the ceiling and says nothing about bytes, and `fetchOne(..., {
        // source: true })` materialises the whole literal before this code sees it. `download`
        // with `maxBytes` instead — {@link fetchRaw}'s instrument, for the same reason: it stops
        // at a CHUNK boundary, the loop declines to ask for the next one, the socket stays clean.
        // A body that reaches the ceiling cannot be the message we are looking for (ours was
        // refused above that size before it was stored), so it is skipped rather than
        // fingerprinted — a truncated body would fingerprint to a value that matches nothing, the
        // same outcome by accident, and an accident is not a guard.
        for (const candidate of candidates) {
          // `+ 1`, and it is the difference between a ceiling and a silent truncation. Asking for
          // exactly `MAX_RAW_MESSAGE_BYTES` makes the driver emit exactly that many bytes and
          // stop, so `total > MAX` can never be true and the read looks complete. The truncated
          // prefix is then fingerprinted — and a prefix can MATCH: a source whose meaningful
          // content ends before the cap fingerprints identically to its own truncation. The
          // consequence is not a slow move but the WRONG one: `move` adopts a stranger's
          // destination UID and then expunges the real source. One extra byte makes saturation
          // observable, and a saturated read is treated as UNVERIFIABLE rather than as evidence.
          const probe = await this.bounded(this.client.download(
            String(candidate), undefined, { uid: true, maxBytes: MAX_RAW_MESSAGE_BYTES + 1 },
          ), dstPath);
          if (!probe || !probe.content) continue;
          const chunks: Buffer[] = [];
          let total = 0;
          let over = false;
          for await (const chunk of probe.content) {
            const buf = chunk as Buffer;
            total += buf.length;
            if (total > MAX_RAW_MESSAGE_BYTES) { over = true; break; }
            chunks.push(buf);
          }
          // Drained to the end even when already over, exactly as `fetchRaw` argues: draining is
          // what leaves the connection usable, and it is bounded by the ceiling. Saturation is
          // `over`, and nothing else — the `+ 1` above makes that exact. This read `>=
          // MAX_RAW_MESSAGE_BYTES` for one round, reasoning a read stopping AT the cap might be
          // cut short; with the limiter asked for `MAX + 1` a genuine body of exactly the maximum
          // ends normally with a byte still available, so it is COMPLETE and `normalizeMime`
          // accepts that size. Discarding it made a legitimate 64 MiB message permanently
          // unverifiable — and on the COPY fallback every retry would leave the source in place
          // and add another 64 MiB copy.
          if (over) continue;
          const declared = probe.meta?.expectedSize;
          if (typeof declared === "number" && declared > MAX_RAW_MESSAGE_BYTES) continue;
          const fp = await ImapAdapter.fingerprintOf(Buffer.concat(chunks));
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
  private async sourceFingerprintOf(locator: NativeLocator, srcPath: string, uid: number): Promise<string | null> {
    const lock = await this.bounded(this.client.getMailboxLock(srcPath));
    try {
      // THE THIRD SOURCE SELECTION, and it is a locator-consuming read like any other — see
      // {@link assertLocatorEpoch}. `move` releases its lock to look at the destination and
      // re-acquires it here, so a folder recreated in that window would be fingerprinted at the
      // recycled UID. The later step-3/step-5 checks would still refuse the WRITE, so nothing
      // lands on the wrong message either way; what this stops is the ADOPT/REFUSE decision
      // being taken against a stranger's bytes — and it is what makes "under every source lock"
      // true rather than nearly true.
      this.assertLocatorEpoch(locator);
      const one = await this.client.fetchOne(
        String(uid), { uid: true, source: true }, { uid: true },
      );
      return one ? await ImapAdapter.fingerprintOf(one.source as Buffer | undefined) : null;
    } finally {
      lock.release();
    }
  }

  /**
   * A UID names a message only within one UIDVALIDITY epoch — the one epoch guard for every
   * locator-consuming command, called UNDER THE LOCK for `locator.folder`: `this.client.mailbox`
   * is the epoch the next command runs against. A recreated folder re-issues UIDs, so a ref
   * committed under epoch V addresses a different message under V′ — unguarded, a move, flag,
   * expunge or body read lands on somebody else's mail. The refusal is {@link MessageGoneError};
   * adoption re-finds the message. `refEpoch === "0"` passes — the sentinel a cold drain
   * persists. An unreported or zero CURRENT epoch refuses with {@link EpochUnknownError}: both
   * mean UNKNOWN, and unknown identity fails closed. Unconditional, no opt-out.
   */
  private assertLocatorEpoch(locator: NativeLocator): void {
    const verdict = this.locatorEpochVerdict(locator);
    if (verdict === "unknown") throw new EpochUnknownError(locator);
    if (verdict === "stale") throw new MessageGoneError(locator);
  }

  /**
   * The same comparison as {@link assertLocatorEpoch}, as a question rather than a refusal —
   * for {@link moveMany}, whose contract is to DECLINE a group it cannot prove equivalent
   * (`batched: false`) rather than to throw one error for fifty messages. Same call discipline:
   * only meaningful under the lock for `locator.folder`.
   */
  private locatorEpochStale(locator: NativeLocator): boolean {
    return this.locatorEpochVerdict(locator) !== "usable";
  }

  /**
   * The three answers the comparison can have, kept apart because they want different refusals:
   * `usable` (the ref's epoch matches, or the ref claims none), `stale` (a contradiction — the
   * message is not at this locator), `unknown` (the server named no epoch, or named zero, so
   * nothing can be proved). See {@link assertLocatorEpoch} for why the last is not the second.
   */
  private locatorEpochVerdict(locator: NativeLocator): "usable" | "stale" | "unknown" {
    const { uidValidity: refEpoch } = parseRef(locator.ref);
    if (refEpoch === "0") return "usable";
    const mb = this.client.mailbox as MailboxObject | false;
    const reported = mb && mb.uidValidity != null ? String(mb.uidValidity) : null;
    if (reported === null || reported === "0") return "unknown";
    return refEpoch === reported ? "usable" : "stale";
  }

  /**
   * Ordered around two silent defects in the no-COPYUID fallback. It adopted the attacker's bytes
   * — the destination UID came from a Message-ID search and `Math.max(...found)`, and a
   * Message-ID is sender-chosen; candidates are now verified by FULL FINGERPRINT, ambiguity
   * raises {@link MoveVerifyError}. And it expunged the source before knowing where the copy went
   * — the delete now runs in phase 3, so a failed verify leaves a reconciled duplicate. The
   * destination is read FIRST: one fingerprint match — skip the COPY, go to the expunge; two or
   * more, or no source fingerprint — refuse without copying; nothing of ours — copy as normal.
   * Needed on UIDPLUS too: COPYUID says where a copy landed, not that none was made.
   */
  async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
    const caps = await this.capabilities();
    const { uid } = parseRef(locator.ref);
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
     * The epoch guard, called UNDER EVERY SOURCE LOCK this move takes — see
     * {@link assertLocatorEpoch}.
     *
     * Once is not enough: the locks are released between steps (imapflow locks are not
     * re-entrant across the destination look), so a folder deleted and recreated mid-move would
     * pass a step-1-only check and still reach `messageMove`/`messageDelete` addressing a
     * recycled UID. Each re-acquisition re-opens the mailbox, so each check reads the epoch the
     * NEXT command will actually run against.
     */
    const assertEpoch = (): void => this.assertLocatorEpoch(locator);

    // Step 1: under the SOURCE lock — probe existence and capture identity. NOTHING is written
    // here any more; the decision to write comes after the destination has been read.
    {
      const lock = await this.bounded(this.client.getMailboxLock(srcPath));
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
      sourceFingerprint = await this.sourceFingerprintOf(locator, srcPath, uid);
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
      const lock = await this.bounded(this.client.getMailboxLock(srcPath));
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
      const lock = await this.bounded(this.client.getMailboxLock(srcPath));
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
   * File a GROUP sharing a source folder and destination in a handful of round trips instead of
   * per message — see {@link MailboxAdapter.moveMany} and {@link FILING_BATCH_MAX}. Measured:
   * {@link move} is five commands per message — 1 137 decisions took 583 s of IMAP time; a batch
   * pays the five once per chunk. It refuses (`batched: false`, nothing written, before the `UID
   * MOVE`) whenever it cannot prove equivalence: no MOVE or UIDPLUS; a destination Message-ID
   * hit; COPYUID not naming every message. Crash states are exactly `move`'s: a
   * moved-but-uncommitted message turns up in `gone` and `changesSince` adopts it. The Message-ID
   * search is one `OR HEADER` tree — ~70 KB at 1 137 ids, which capping hosts refuse.
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

    // The batch is one UID set, so it is one epoch or it is not a batch: `UID MOVE 1,2,3`
    // addresses whatever the SELECTed mailbox currently numbers, so a set from two epochs cannot
    // be right about more than one. Declining (`batched: false`) rather than throwing: the caller
    // re-files one at a time and `move`'s epoch guard gives each row its own verdict. Sentinel
    // `"0"` refs are excluded, per {@link assertLocatorEpoch}. The representative is a
    // NON-SENTINEL member, never `locators[0]`: `{0:10, 7:11, 7:12}` passes the set test and then
    // checks `0:10`, which never reports stale — a folder now at epoch 8 would relocate three
    // strangers. Every non-sentinel member carries the same epoch, so any one speaks for all;
    // `undefined` means the whole chunk is sentinels.
    let epochRep: NativeLocator | undefined;
    {
      const epochs = new Set(
        locators.map((l) => parseRef(l.ref).uidValidity).filter((e) => e !== "0"),
      );
      if (epochs.size > 1) return empty;
      epochRep = locators.find((l) => parseRef(l.ref).uidValidity !== "0");
    }

    // Step 1: the existence probe and the Message-IDs, for the whole set, under one source lock.
    const present = new Map<number, string | null>();
    {
      const lock = await this.bounded(this.client.getMailboxLock(srcPath));
      try {
        // UNDER THE LOCK, BEFORE THE FETCH — the group shares one real epoch (above), so checking
        // the representative checks the set. A mismatch here means every ref in the chunk is stale.
        if (epochRep && this.locatorEpochStale(epochRep)) return empty;
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
      const lock = await this.bounded(this.client.getMailboxLock(dstPath));
      try {
        dstUidValidity = (this.client.mailbox as MailboxObject).uidValidity;
        if (ids.length > 0) {
          const found = await this.searchBounded(
            ids.length === 1
              ? { header: { "message-id": ids[0]! } }
              : { or: ids.map((id) => ({ header: { "message-id": id } })) },
            { uid: true },
            dstPath,
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
      const lock = await this.bounded(this.client.getMailboxLock(srcPath));
      try {
        // THE RECHECK, for `move`'s reason one folder over: the source lock was released while
        // the destination was inspected, and imapflow re-selects the mailbox on each
        // re-acquisition — so this reads the epoch `UID MOVE` will actually run against. A step-1
        // check alone would let a folder recycled in that window take the write.
        if (epochRep && this.locatorEpochStale(epochRep)) return empty;
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
   * Write `\Seen` on one message — see {@link MailboxAdapter.setFlags}. One `getMailboxLock`
   * around the whole thing: one folder, and imapflow's locks are not re-entrant. THE EXISTENCE
   * PROBE IS NOT BELT-AND-BRACES: GreenMail answers `true` to a `UID STORE` whose UID set matched
   * nothing — measured, and RFC 3501 permits it. `!ok` alone would report success for a message
   * never touched, the reconciler would flip `observed_seen` to a value no server confirmed, and
   * the row would read converged for ever. `fetchOne` costs one round trip under a held lock and
   * raises the {@link MessageGoneError} the reconciler's skip-and-retry branch is written for;
   * `!ok` stays as a second signal.
   */
  async setFlags(locator: NativeLocator, flags: { seen: boolean }): Promise<void> {
    const { uid } = parseRef(locator.ref);
    const lock = await this.bounded(this.client.getMailboxLock(this.toServerPath(locator.folder)));
    try {
      // UNDER THE LOCK, BEFORE THE PROBE — see {@link assertLocatorEpoch}. A recycled folder
      // re-issues low UIDs, and `UID STORE` on a stale ref marks a STRANGER'S message read (or
      // unread) in the user's own mailbox. One lock, so one check is enough here: unlike `move`
      // there is no window in which it is released.
      this.assertLocatorEpoch(locator);
      const present = await this.bounded(
        this.client.fetchOne(String(uid), { uid: true }, { uid: true }));
      if (!present) throw new MessageGoneError(locator);
      const ok = flags.seen
        ? await this.client.messageFlagsAdd([uid], ["\\Seen"], { uid: true })
        : await this.client.messageFlagsRemove([uid], ["\\Seen"], { uid: true });
      if (!ok) throw new MessageGoneError(locator);
    } finally {
      lock.release();
    }
  }

  /**
   * The wake channel is `exists`-on-INBOX, and nothing else. It listened to `exists` + `flags` +
   * `expunge` with no path filter, and both halves were wrong: imapflow emits for the CURRENT
   * mailbox only and every cycle re-selects, so the "INBOX watch" watched the last folder a scan
   * touched (the measured p50 of 194 s arrival to mirror); and `flags`/`expunge` turned our own
   * reconciliation into wakes, spending the revisit budget on echoes of our own writes. Other
   * devices' flag changes reach the mirror at the poll cadence, as before; a Not-junk rescue into
   * INBOX still counts. Selection goes through `getMailboxLock`; `idle()` starts explicitly
   * because auto-idle waits 15 s. {@link rearmWatch} re-arms after each visit.
   */
  async watch(onSignal: () => void): Promise<() => Promise<void>> {
    const inboxPath = this.toServerPath("INBOX");
    const handler = (info?: { path?: string }): void => {
      if (info?.path === inboxPath) onSignal();
    };
    this.client.on("exists", handler);
    this.watchArmed = true;
    this.watchSignal = onSignal;
    const lock = await this.bounded(this.client.getMailboxLock(inboxPath));
    lock.release();
    this.startIdle();
    return async () => {
      this.watchArmed = false;
      this.watchSignal = null;
      this.client.removeListener("exists", handler);
    };
  }

  /**
   * Put the connection back where {@link watch} left it — INBOX selected, IDLE running — and ring
   * the wake callback ourselves if INBOX grew unheard. Called at the end of every cycle visit:
   * the visit's folder work re-SELECTs elsewhere, after which an INBOX arrival emits nothing. One
   * SELECT per visit; a no-op until `watch` is established. The blind-window catch-up: imapflow's
   * SELECT handler seeds fresh state WITHOUT emitting `exists`, so the SELECTed uidNext is
   * compared against {@link lastInboxSeen}; growth under the same UIDVALIDITY rings {@link
   * watchSignal} once and the baseline moves. Throws what the SELECT throws — connection trouble.
   */
  async rearmWatch(): Promise<void> {
    if (!this.watchArmed) return;
    this.assertUsable();
    // The one throwing path that still has to notify, because its caller swallows.
    // `retireConnection` is silent for throwing paths — the throw is the report — but the worker
    // catches `rearmWatch()` and only logs, expecting the adapter's own close listener to detach.
    // A silent retirement here therefore reports to nobody: the connection is dead, the runtime
    // still holds it, and the mailbox is poll-only until something unrelated notices. It stays
    // silent about failure counting, which is the point of the split: this notifies as a
    // connection that ENDED, detaching without walking the mailbox toward `status=error` — a
    // re-arm that could not SELECT is not evidence against the mailbox.
    let lock: { release(): void };
    try {
      lock = await this.bounded(this.client.getMailboxLock(this.toServerPath("INBOX")));
    } catch (err) {
      if (err instanceof ImapBoundExceeded) this.retireConnection(err);
      throw err;
    }
    let grew = false;
    try {
      const mb = this.client.mailbox as MailboxObject | false;
      const seen = this.lastInboxSeen;
      if (
        mb && seen
        && String(mb.uidValidity ?? "") === seen.uidValidity
        && typeof mb.uidNext === "number" && mb.uidNext > seen.uidNext
      ) {
        grew = true;
        this.lastInboxSeen = { uidValidity: seen.uidValidity, uidNext: mb.uidNext };
      }
    } finally {
      lock.release();
    }
    this.startIdle();
    if (grew) this.watchSignal?.();
  }

  /** Start IDLE now instead of waiting out imapflow's 15 s auto-idle inactivity delay. */
  private startIdle(): void {
    // Fire-and-forget: `idle()` resolves only when the NEXT command interrupts it, so awaiting
    // it here would hang the visit that called this. It no-ops when IDLE is already running,
    // and a failure is the connection dying — which the `close`/`error` listeners own.
    void this.client.idle().catch(() => { /* the connection's own listeners handle it */ });
  }

  /**
   * The Sent folder for a WRITE — creating one is the LAST resort, after both lookups fail. It
   * used to be SPECIAL-USE then `mailboxCreate("Sent")`: creating a folder is the most
   * destructive thing on this path, and it was the FIRST fallback — while {@link findSentForScan}
   * matched {@link SENT_BY_NAME}, so one adapter could find `Sent Mail` to read and create `Sent`
   * to write. `ListResponse.specialUse` is not the server's flag: measured against GreenMail (no
   * SPECIAL-USE), imapflow guesses from a 103-name localized table — a caret-range guarantee, and
   * `Sent Mail` (Gmail's own name) is absent from it and present in `SENT_BY_NAME`. The name
   * match is cached onto `this.sentFolder`: this IS the send path.
   */
  private async resolveSentFolder(): Promise<string> {
    if (this.sentFolder) return this.sentFolder;
    const list = await this.listBounded();
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
      lock = await this.bounded(this.client.getMailboxLock(this.toServerPath(sentCanonical)));
    } catch (err) {
      // A CEILING BREACH IS NOT "THIS FOLDER IS NOT THERE". The arm below turns any SELECT
      // failure into an honest "no such folder / nothing to do" answer, which is right for a
      // missing or unselectable mailbox and WRONG for a deadline: it would report a server that
      // stopped answering as an empty result, which is the silent degrade this whole file exists
      // to replace with a refusal. See `imap-bounds.ts`.
      if (err instanceof ImapBoundExceeded) throw err;
      return false;
    }
    try {
      const found = await this.searchBounded(
        { header: { "message-id": inner } }, { uid: true }, sentCanonical,
      );
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
    const lock = await this.bounded(this.client.getMailboxLock(serverPath));
    try {
      // Not a mutation, and it is here for the same reason all the same — see
      // {@link assertLocatorEpoch}. A recycled folder makes this download part `n` of whatever
      // message now wears the UID, and there is no witness downstream: the bytes go straight to
      // the requester as their own attachment. `move` and `setFlags` corrupt the mailbox; this
      // one hands one person's file to another.
      this.assertLocatorEpoch(locator);
      const dl = await this.bounded(this.client.download(String(uid), part, { uid: true }));
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
   * Re-read one message in full, exactly as the server holds it — see {@link
   * MailboxAdapter.fetchRaw}; this note is mechanics. The ceiling is the DRIVER's (`maxBytes` to
   * `download`): `fetchPart` throws out of its own `for await`, destroying the stream mid-literal
   * — affordable per-request, fatal on the worker's long-lived IDLE connection, the only
   * caller's. `maxBytes` stops at a CHUNK boundary, so the socket stays clean; the cost is silent
   * truncation, exactly what this method must not do, so the size is checked afterwards against
   * `RFC822.SIZE` and a truncated read becomes a refusal. The stream is drained to its end even
   * when already over — draining leaves the connection clean, bounded by the ceiling.
   */
  async fetchRaw(locator: NativeLocator, opts: FetchRawOptions = {}): Promise<Uint8Array> {
    const maxBytes = opts.maxBytes ?? DEFAULT_FETCH_RAW_MAX_BYTES;
    const { uid } = parseRef(locator.ref);
    const serverPath = this.toServerPath(locator.folder);
    const lock = await this.bounded(this.client.getMailboxLock(serverPath));
    try {
      // Both callers of this method WRITE what it returns into the message's own row
      // (`redacted-restore.ts`, `sensitive-backfill.ts`), so a stale-epoch read is how one
      // person's mail gets stored as another message's body. Both already refuse on their own
      // `isSameMessage` witness AFTER the fetch; this refuses BEFORE it, which costs the round
      // trip rather than spending it — and, unlike the witness, it also covers a message whose
      // recycled twin happens to look identical. Defence in depth, not a replacement:
      // {@link assertLocatorEpoch} is blind whenever the server does not report `uidValidity`,
      // and the witness is what covers that.
      this.assertLocatorEpoch(locator);
      // `undefined` for the part is what makes this a source fetch, and a source fetch is what
      // makes it `BODY.PEEK[]`. Not `""` — an empty string reaches the same branch by being
      // falsy, which is a property of the driver rather than a thing it promises.
      const dl = await this.bounded(
        this.client.download(String(uid), undefined, { uid: true, maxBytes }));
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
 * Sent-folder copy — pulled out of {@link ImapAdapter.send} so the BCC-envelope-only invariant is
 * testable without a socket. The load-bearing lines are `cc` and `bcc`: both reach the SMTP RCPT
 * list (`sendMail`'s envelope is `to + cc + bcc`), and bcc stays blind through nodemailer's
 * default `keepBcc: false`, relied on rather than restated — the compiled message carries `Cc:`
 * and no `Bcc:`. `keepBcc` is never set here: doing so would write the blind recipients into the
 * delivered headers. The Cc/Bcc round-trip test asserts both halves and was watched to go red on
 * `keepBcc: true`.
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
