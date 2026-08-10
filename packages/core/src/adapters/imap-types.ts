// `../mail.js`, not `../index.js`: this module needs the mail vocabulary, and the default barrel
// re-exports the model half beside it — so naming it here would put the classifier and the drafter
// into the import graph of every artifact that opens a mailbox.
import type { Change, NativeLocator } from "../mail.js";

/**
 * Canonical folders the worker watches. INBOX = Imbox.
 *
 * These are the six `Destination` strings and nothing else: the set `ensureFolders()` creates,
 * the set a reconcile may MOVE a message into, and the set every list view filters on. It is
 * frozen — changing it is an IMAP data migration in the customer's own mailbox.
 *
 * **The Sent folder is watched too and is deliberately NOT in here.** Its path is
 * server-specific and discovered at login (`ImapAdapter.findSentForScan`), we never create it,
 * we never move anything into or out of it, and a message that lives there matches no view
 * filter — it reaches the product only through its conversation. Putting it in this tuple would
 * have made all four of those false at once. See `ImapAdapter.changesSince`.
 */
export const WATCHED_FOLDERS = [
  "INBOX",
  "ohmail/Screener",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
] as const;

/** `ohmail/*` folders that ensureFolders() creates (INBOX always exists). */
export const OHMAIL_FOLDERS = WATCHED_FOLDERS.filter((f) => f !== "INBOX");

// ─────────────────────────────────────────────────────────────────────────────
// THE TLS FLOOR ON THE ohmail→PROVIDER LEG.
//
// Everything from here to {@link smtpTlsFloor} exists because `ImapConfig.secure` is a
// CALLER-SUPPLIED boolean that originates in the onboarding request body, and until this
// landed it was the *only* thing standing between the user's IMAP password and the wire.
// `secure: false` against a server that does not offer STARTTLS sent that password in
// CLEAR TEXT, from our server, on the user's behalf, on every sync cycle.
//
// `secure` is not the question. Both shapes are legitimate and a provider may offer only
// one — implicit TLS (IMAPS 993 / SMTPS 465) or cleartext-then-STARTTLS (143 / 587). The
// invariant is narrower and is about the wire, not the flag:
//
//     AUTHENTICATION NEVER HAPPENS OVER A CONNECTION THAT DID NOT BECOME ENCRYPTED.
//
// Which is why these are functions of `(host, secure)` returning options, and why the
// TLS-floor guards assert on a server TRANSCRIPT — that no LOGIN and no
// AUTH ever reached it — rather than on the value of a flag. A test that checks
// `secure === true` proves nothing about what crossed the socket.
//
// No runtime imports in this module, deliberately: `packages/services` owes an
// onboarding-time refusal and must be able to import
// {@link loopbackHarnessReason} without pulling `imapflow`/`nodemailer` — or `node:net` —
// into the API bundle. Hence the hand-rolled address matching below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two TLS parameters that must never be left to a default, and the reason why.
 *
 * Both `imapflow@1.5.0` and `nodemailer@6.10.1` pass their `tls` option object STRAIGHT
 * into `tls.connect` and inject nothing of their own (`imap-flow.js` `connect()` /
 * `upgradeToSTARTTLS()`; `smtp-connection/index.js` `_createConnection()` /
 * `_upgradeConnection()`). So the effective default is Node's, and Node's defaults for
 * both of these are PROCESS GLOBALS that something outside this file can flip. Measured on
 * node v23.6.1 against a self-signed local TLS server:
 *
 *   · `rejectUnauthorized` — defaults to true, and `NODE_TLS_REJECT_UNAUTHORIZED=0` turns
 *     that into `connected: true, authorized: false`. One environment variable on the
 *     worker host, set for some unrelated reason, would silently disable certificate
 *     validation on both mail legs. An explicit `rejectUnauthorized: true` STILL FAILS
 *     under that env var (measured) — it is the only form that holds.
 *   · `minVersion` — `tls.DEFAULT_MIN_VERSION` is `TLSv1.2`, and `node --tls-min-v1.0`
 *     makes it `TLSv1`; a client with no explicit `minVersion` then negotiated **TLSv1**
 *     with a TLS1.0-only server (measured). With `minVersion: "TLSv1.2"` set it refused.
 *
 * A security-relevant default that another process's flags can lower is not a floor.
 *
 * **Why TLSv1.2 and not TLSv1.3.** TLS 1.0/1.1 are dead (RFC 8996) and this refuses them.
 * TLS 1.3 as the minimum would refuse mail servers that work today, and the common shape is
 * a host whose IMAP endpoint on 993 offers TLS 1.3 while its SUBMISSION endpoint on 587 tops
 * out at TLS 1.2 — so a 1.3 floor breaks sending on a server whose receiving side is fine. A
 * floor that disconnects a working provider is not a floor either.
 */
export const TLS_FLOOR = { rejectUnauthorized: true, minVersion: "TLSv1.2" } as const;

/** The strict TLS parameter set applied to every non-loopback mail connection. */
export interface TlsFloorOptions { readonly rejectUnauthorized: true; readonly minVersion: "TLSv1.2" }

/**
 * Why `host` is THE LOCAL TEST HARNESS and therefore exempt from the floor, or `null` if
 * it is not — the shape `transactionPoolerReason` in `packages/db/src/session-url.ts`
 * established, for the same reason: a guard that only says "no" teaches the operator
 * nothing about the value in their hand.
 *
 * ── WHY AN EXEMPTION EXISTS AT ALL ─────────────────────────────────────────────────────
 *
 * GreenMail (`docker-compose.yml`, `:3143`/`:3025`) and the dovecot CONDSTORE fallback
 * (`:3144`) speak plaintext and nothing else. The end-to-end suites for the worker, for the
 * local engine and for this adapter all connect to them. The forbidden move is to soften the
 * PRODUCTION rule so those keep passing; the permitted one is an exemption so narrow that
 * production cannot reach it.
 *
 * ── WHY IT CANNOT APPLY IN PRODUCTION ──────────────────────────────────────────────────
 *
 * It is keyed on the host being LOOPBACK, and loopback is the one address family that
 * cannot carry a packet off the machine, so there is no wire for a credential to leak on.
 * A mailbox host arrives from the onboarding request body and is stored in
 * `mailbox_credentials.meta.host`; a real provider's host is a public FQDN, and so is every
 * `PROVIDERS` preset the onboarding screen offers. For any of them this returns null and the
 * floor applies.
 *
 * ── AND WHY IT IS DELIBERATELY MEAN ────────────────────────────────────────────────────
 *
 * `0.0.0.0` is NOT exempt even though connecting to it reaches loopback on Linux and
 * macOS; nor is `::ffff:127.0.0.1`; nor `localhost.evil.com`, `notlocalhost`,
 * `127.0.0.1.attacker.net`, or a bare empty string. Every rejection here fails CLOSED —
 * the consequence of not matching is that the connection is *harder*, never softer — so
 * the cost of being strict is a developer who has to type `127.0.0.1`, and the cost of
 * being generous is a plaintext password. `*.localhost` is admitted because RFC 6761 §6.3
 * reserves the whole name for loopback.
 */
export function loopbackHarnessReason(host: string): string | null {
  // A trailing dot is the fully-qualified form of the same name; anything else is
  // normalised only for case, never for content.
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "the host is the reserved name localhost (RFC 6761)";
  // Bracketed IPv6 literal, as it appears in a URL authority.
  const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  // ::1 in its collapsed and fully-written forms. Not ::ffff:127.0.0.1 — see above.
  if (v6 === "::1" || v6 === "0:0:0:0:0:0:0:1") return "the host is the IPv6 loopback address ::1";
  // 127.0.0.0/8, and only a well-formed dotted quad in it.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const parts = m.slice(1).map(Number);
    if (parts.every((n) => n >= 0 && n <= 255) && parts[0] === 127) {
      return "the host is in the IPv4 loopback range 127.0.0.0/8";
    }
  }
  return null;
}

/** The TLS-relevant slice of `ImapFlowOptions`, and nothing else. */
export interface ImapTlsFloorOptions {
  secure: boolean;
  /**
   * `imapflow@1.5.0`: start cleartext and REQUIRE the STARTTLS upgrade before
   * authenticating. Absent when `secure`, because the library throws
   * *"Misconfiguration: Cannot set both secure=true for TLS and doSTARTTLS=true for
   * STARTTLS."* on the pair.
   */
  doSTARTTLS?: true;
  tls?: TlsFloorOptions;
}

/** The TLS-relevant slice of nodemailer's `SMTPTransport.Options`, and nothing else. */
export interface SmtpTlsFloorOptions {
  secure: boolean;
  /** `nodemailer@6.10.1`: send STARTTLS even if unadvertised, and treat any non-2xx as fatal. */
  requireTLS?: true;
  /** Would skip STARTTLS entirely. Pinned false so the option is visible, not merely absent. */
  ignoreTLS?: false;
  /** Would downgrade a FAILED upgrade to "continue unencrypted". Pinned false for the same reason. */
  opportunisticTLS?: false;
  tls?: TlsFloorOptions;
}

/**
 * IMAP: the options that make `imapflow` refuse to authenticate over cleartext.
 *
 * `secure: true` needs nothing added — the socket is TLS from its first byte. The
 * dangerous case is `secure: false`, where imapflow's DEFAULT is opportunistic: its own
 * docs say *"If not supported, continue unencrypted. This may expose the connection to a
 * downgrade attack."* `doSTARTTLS: true` converts that into a refusal — `_failSTARTTLS()`
 * (`imap-flow.js:1215`) throws `Server does not support STARTTLS` — and it is checked in
 * `startSession()` at `:1038`, one line BEFORE `authenticate()` at `:1040`, which is the
 * ordering the whole guard rests on.
 */
export function imapTlsFloor(host: string, secure: boolean): {
  options: ImapTlsFloorOptions; exemptReason: string | null;
} {
  const exemptReason = loopbackHarnessReason(host);
  // The exempt path adds NOTHING and removes NOTHING — it declines to add the floor, so
  // the harness gets byte-identical behaviour to before the TLS floor and no new hole is invented.
  if (exemptReason) return { options: { secure }, exemptReason };
  return {
    options: secure ? { secure: true, tls: TLS_FLOOR } : { secure: false, doSTARTTLS: true, tls: TLS_FLOOR },
    exemptReason: null,
  };
}

/**
 * SMTP: the options that make `nodemailer` refuse to authenticate over cleartext.
 *
 * `requireTLS: true` does two things in `smtp-connection/index.js`, both needed:
 * `_actionEHLO` at `:1314` sends STARTTLS **even when the server never advertised it**
 * (`… || this.options.requireTLS`), and at `:1296` a failed EHLO no longer falls back to
 * HELO. `_actionSTARTTLS` at `:1401` then turns any non-2xx reply into a fatal `ETLS`
 * instead of the `opportunisticTLS` "continuing unencrypted" branch. AUTH is only reached
 * after `_upgradeConnection` has set `this.secure = true`.
 */
export function smtpTlsFloor(host: string, secure: boolean): {
  options: SmtpTlsFloorOptions; exemptReason: string | null;
} {
  const exemptReason = loopbackHarnessReason(host);
  if (exemptReason) return { options: { secure }, exemptReason };
  return {
    options: secure
      ? { secure: true, ignoreTLS: false, opportunisticTLS: false, tls: TLS_FLOOR }
      : { secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false, tls: TLS_FLOOR },
    exemptReason: null,
  };
}

/** Password auth as STORED in a config — the historical shape, unchanged. */
export interface ImapPasswordAuth { user: string; pass: string }
/**
 * OAuth2 auth as STORED in a config: a CALLBACK, never a token.
 *
 * An access token is short-lived (minutes) and an `ImapConfig` outlives it — the worker holds one
 * for the life of a connection, the API reuses a transporter across sends. So the token is not a
 * field here; it is resolved at the moment it is needed ({@link ImapAdapter.connect} for IMAP,
 * `ImapAdapter.send` for SMTP) by calling this. On a socket death the existing reconnect builds a
 * FRESH adapter, whose `connect()` calls this again — which is the entire freshness story, with no
 * mid-session re-auth and no token pinning anywhere.
 */
export interface ImapOAuthAuth { user: string; fetchAccessToken: () => Promise<string> }
/** The auth a stored config may carry. The union defaults to the password path byte-for-byte. */
export type ImapAuth = ImapPasswordAuth | ImapOAuthAuth;
/**
 * The RESOLVED wire form handed to imapflow — the {@link ImapOAuthAuth} callback already awaited
 * into a literal `accessToken` (imapflow authenticates XOAUTH2 from `auth.accessToken` natively).
 * Distinct from {@link ImapAuth} so the CALLBACK form can never reach the sync options builder.
 */
export type ResolvedImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

export interface ImapConfig {
  host: string;
  port: number;
  /**
   * IMPLICIT TLS from the first byte (IMAPS 993 / SMTPS 465) — **not** "is this connection
   * encrypted". `false` means cleartext-then-STARTTLS (143 / 587), which is now a
   * MANDATORY upgrade rather than an opportunistic one: see {@link imapTlsFloor}.
   */
  secure: boolean;
  auth: ImapAuth;
  smtp?: { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } };
  sentDomain?: string;
  /**
   * Network deadlines, in ms, for BOTH transports (see {@link DEFAULT_NET_TIMEOUTS}).
   *
   * Neither `imapflow` nor `nodemailer` fails fast by default — a provider that accepts the
   * TCP connection and then stops responding leaves the operation hanging for as long as the
   * caller allows. On the serverless host that ceiling is the platform's `maxDuration` (60 s),
   * and being killed BY the platform is the one failure mode with no error handling at all:
   * no `finally`, no `adapter.close()`, no response. Every deadline here is therefore set well
   * below it, so a hung mailbox produces a normal error inside our own code — and, on the send
   * path, one that can be finalized rather than stranded.
   */
  timeouts?: Partial<NetTimeouts>;
}

/** The four network deadlines shared by the IMAP and SMTP transports. */
export interface NetTimeouts {
  /** TCP + TLS connect. */
  connectionMs: number;
  /** Server greeting after connect. */
  greetingMs: number;
  /** Inactivity on an established socket. */
  socketMs: number;
}

/**
 * Deadlines chosen against a 60-second serverless invocation ceiling: a cold IMAP LOGIN costs
 * 1–3 s, so 15 s to connect is generous, and the 25 s socket ceiling leaves room for the
 * reserve→SMTP→finalize sequence of a send to complete (or to fail cleanly) inside one
 * invocation instead of being killed halfway.
 */
export const DEFAULT_NET_TIMEOUTS: NetTimeouts = {
  connectionMs: 15_000,
  greetingMs: 15_000,
  socketMs: 25_000,
};

/**
 * The SAME deadlines for a process that is not serverless — the worker's persistent, IDLE-held
 * connections. Split out on 2026-08-02, because the worker had been silently inheriting a
 * number chosen against that invocation ceiling and a `socketMs` shorter than the legitimate
 * quiet stretches its own cycle produces.
 *
 * ── WHY 25 s WAS A LOADED GUN, AND EXACTLY WHERE IT WENT OFF ───────────────────────────────
 *
 * `socketMs` is Node's socket INACTIVITY timer. imapflow's handler (`_socketTimeout`) is not
 * symmetric: while the client is IDLING it recovers with a NOOP and re-enters IDLE, but when it
 * is NOT idling it calls `emitError`, and after `connect()` has resolved that is a plain
 * `emit("error")` on the client. imapflow also only auto-idles when a mailbox is SELECTED, and
 * only 15 s after the last command (`autoidle()`).
 *
 * So the fatal window is: connection established, no mailbox SELECTED, no command in flight.
 * `connect()` and `ensureFolders()` issue LIST only — which selects nothing — and on a mailbox
 * whose kickstart has already run `runKickstart` returns before touching IMAP. The thread
 * backfill then ran there for minutes on a large backlog: auto-idle was never
 * armed, nothing reset the socket, and at 25 s the client emitted `ETIMEOUT` with no listener.
 * That is the ~26 s crash cadence of the 2026-08-02 outage, and it is also why the small seeded
 * test world never reproduced it.
 *
 * ── WHY 120 s ──────────────────────────────────────────────────────────────────────────────
 *
 * It has to exceed the longest stretch in which the worker legitimately holds a connection with
 * nothing on the wire, and stay under the point where one hung command wedges the shard for
 * longer than an alert takes to notice:
 *   · 8× imapflow's 15 s auto-idle delay, so every window auto-idle DOES eventually cover has
 *     ~105 s of slack rather than 10 s;
 *   · above the bounded DB-only stretches a cycle can now produce — 500 flag applications
 *     ({@link DEFAULT_SYNC_BATCH_MAX_FLAGS}) and a 10 s thread-backfill slice;
 *   · below imapflow's own 300 s default, and far below the 15-minute `sync_lag` alert, so a
 *     provider that accepts a command and never answers still fails inside the window an
 *     operator finds out in.
 *
 * It is NOT the reason the process survives — {@link ImapAdapterOpts.onConnectionError} is.
 * A deadline only decides how often the failure happens; the listener decides what it costs.
 */
export const WORKER_NET_TIMEOUTS: NetTimeouts = {
  connectionMs: 15_000,
  greetingMs: 15_000,
  socketMs: 120_000,
};

export interface ImapCapabilities {
  move: boolean;         // RFC 6851 MOVE (else COPY + EXPUNGE)
  uidplus: boolean;      // RFC 4315 UIDPLUS → COPYUID/APPENDUID
  condstore: boolean;    // RFC 7162 CONDSTORE → changedSince MODSEQ fast path
  qresync: boolean;      // RFC 7162 QRESYNC
  idle: boolean;         // RFC 2177 IDLE
  specialUse: boolean;   // RFC 6154 SPECIAL-USE
  sentFolder: string | null; // resolved \Sent path (canonical name)
}

/**
 * How many messages ONE `changesSince` call may fetch bodies for.
 *
 * The 2026-08-01 outage: the first sync of a real mailbox fetched `source: true` for every
 * unknown UID in a single pass, so a mailbox of several thousand messages materialised itself —
 * bodies and all — in one array. The worker container's limit is 1 000 000 000 B; the process reached
 * 0.914 GB and was SIGKILLed, which logs nothing. It then crash-looped, because the folder
 * cursor is only persisted once a whole batch commits, so no restart ever made progress.
 */
export const DEFAULT_SYNC_BATCH_MAX_MESSAGES = 200;
/**
 * …and the byte budget for the same call, because a count alone does not bound memory:
 * 50 messages carrying 25 MB attachments is still 1.25 GB. Enforced against RFC822.SIZE,
 * which is a cheap pre-fetch, BEFORE any body is pulled.
 */
export const DEFAULT_SYNC_BATCH_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How many Sent messages the connect-time kickstart reads, newest first.
 *
 * ENVELOPE ONLY — no `source: true` — so this is a metadata fetch and not the memory hazard
 * {@link DEFAULT_SYNC_BATCH_MAX_MESSAGES} exists for. 500 is chosen to cover a real
 * correspondence graph on a mailbox with years of history while staying one bounded round of
 * fetches, and it runs ONCE per mailbox for the life of the account.
 */
export const DEFAULT_SENT_SCAN_MESSAGES = 500;

/**
 * How much of the Sent folder ohmail ever ingests, newest first.
 *
 * ── WHY THERE IS A CEILING AT ALL ───────────────────────────────────────────────────────────
 *
 * Watching Sent is what puts the user's own replies in their conversations. Ingesting a Sent
 * folder the way INBOX is ingested would also copy fifteen years of outbound mail — bodies and
 * all — into `messages`/`message_bodies` for conversations nobody will ever open. That is
 * storage the account pays for against no product surface (cost must be proportional to
 * value), and it is precisely the question the threading incident existed to teach: not "is it right?"
 * but "does it fit?". The conversation value lives in recent correspondence; the tail does not.
 *
 * 2 000 is roughly two years of a working correspondence at a handful of sends a day, and at
 * the shared per-cycle create budget ({@link DEFAULT_SYNC_BATCH_MAX_MESSAGES}) it drains in
 * about ten bounded cycles — the same shape as the message backfill the worker already re-kicks
 * itself through, on the serial queue, off the attach path.
 *
 * **The residual limit, stated:** a conversation whose outbound half is older than the newest
 * 2 000 Sent messages shows the other side only. Nothing on screen claims otherwise.
 *
 * ── HOW IT IS ENFORCED, AND WHY IT IS NOT A WINDOW EVERY CYCLE ──────────────────────────────
 *
 * FIRST scan only: enumerate the newest N by SEQUENCE number (`${exists-N+1}:*`), the same
 * mechanism `scanSentRecipients` uses. Every cycle after that, the folder's persisted `uidNext`
 * is the WATERMARK — `UID FETCH ${uidNext}:*`, filtered `uid >= uidNext` — so steady state
 * costs one UID enumeration of what has arrived since the last pass, not of the whole
 * {@link DEFAULT_SENT_HISTORY_MESSAGES} window.
 *
 * The watermark is load-bearing for more than cost. `own_copy` (see `dedup.ts`) deliberately
 * writes NO row for the Sent twin of a message we already store, so that UID never joins the
 * known-set. Under the known-set diff every self-CC'd message would be an unknown UID for ever
 * and its full RFC822 body would be re-fetched on every cycle, permanently, for the life of the
 * account. A UID is behind the watermark whether or not it produced a row, which is the only
 * property that closes that loop without persisting a second kind of row.
 */
export const DEFAULT_SENT_HISTORY_MESSAGES = 2_000;

/**
 * How many FLAG changes one `changesSince` call may report.
 *
 * The creates budget above bounds MEMORY. This one bounds TIME, and it was missing: the
 * CONDSTORE fast path pushed every changed UID with no cap, and the worker consumes each one as
 * its own database transaction (`apps/worker/src/sync.ts`). "Mark all as read" across a large
 * mailbox in Apple Mail therefore produced one sequential transaction per changed message
 * inside ONE cycle — minutes on the worker's single serial queue, during which no other
 * mailbox syncs, no roster pass runs, and `stop()` cannot complete inside the platform's 30 s
 * `drainingSeconds` before SIGKILL.
 *
 * 500 is ~7 s of database round trips: comfortably inside imapflow's 15 s auto-idle arming
 * delay, so the connection is protected by IDLE for the rest of the drain, and well inside
 * {@link WORKER_NET_TIMEOUTS}. A truncated flag pass sets `hasBacklog`, so the worker re-kicks
 * rather than waiting out a poll interval and 8 792 flags drain in about a minute.
 */
export const DEFAULT_SYNC_BATCH_MAX_FLAGS = 500;

export interface ImapAdapterOpts {
  /** Inject a preconstructed (or fake) client for tests; when set, connect() does not dial. */
  client?: unknown;
  /** Force capability values (e.g. condstore:false to exercise the fallback path). */
  capabilityOverrides?: Partial<Omit<ImapCapabilities, "sentFolder">>;
  logger?: boolean;
  /** Per-call message cap. Default {@link DEFAULT_SYNC_BATCH_MAX_MESSAGES}. Test seam. */
  maxBatchMessages?: number;
  /** Per-call byte cap. Default {@link DEFAULT_SYNC_BATCH_MAX_BYTES}. Test seam. */
  maxBatchBytes?: number;
  /** Per-call flag cap. Default {@link DEFAULT_SYNC_BATCH_MAX_FLAGS}. Test seam. */
  maxBatchFlags?: number;
  /** Sent-folder history depth. Default {@link DEFAULT_SENT_HISTORY_MESSAGES}. Test seam. */
  sentHistoryMessages?: number;
  /**
   * The connection died ASYNCHRONOUSLY — the one failure this class cannot report by throwing.
   *
   * `ImapFlow` is an EventEmitter and signals a dead socket, a server `BYE`, or an `ETIMEOUT`
   * by emitting `error`. Node turns an `error` event with NO listener into an uncaught
   * exception, and the worker's entrypoint exits the process on those BY DESIGN. That is
   * the entire kill mechanism of the 2026-08-02 outage: a `try/catch` around the slow code
   * could never have caught it, because the throw did not come out of the call it wrapped.
   *
   * The adapter therefore ALWAYS attaches a listener (see `ImapAdapter.connect`), whether or
   * not this callback is supplied — containment must not depend on a caller remembering. This
   * is how the OWNER of the connection finds out: the worker detaches and quarantines just
   * that mailbox, and every other account keeps syncing.
   *
   * It must not throw. Anything it does throw is swallowed at the emit site, because a handler
   * that rethrows inside an `error` listener reproduces the crash it exists to prevent.
   */
  onConnectionError?: (err: unknown) => void;
}

export interface PersistedFolderCursor { uidValidity: string; uidNext: number; highestModseq: string; }
export interface KnownEntry { uid: number; messageId: string | null; }
export interface FolderCursor extends PersistedFolderCursor { known: KnownEntry[]; }
export interface ImapCursor { folders: Record<string, FolderCursor>; }

export interface ChangeBatch {
  creates: Change[];
  moves: Change[];
  flagChanges: Change[];
  deletes: Change[];
  newCursor: { folders: Record<string, PersistedFolderCursor> };
  /**
   * At least one folder's backlog was TRUNCATED by the batch budget — another pass is owed.
   *
   * A truncated folder's cursor is deliberately held at its previous value (see
   * {@link DEFAULT_SYNC_BATCH_MAX_MESSAGES}), so the worker cannot rely on the cursor moving
   * to know it is done. It re-kicks its cycle on this flag instead of waiting out the poll
   * interval, which is what turns a big first sync from "one 3-hour cycle that looks dead"
   * into a series of short, observable ones.
   *
   * Optional so every existing fake adapter keeps compiling; absent ⇒ `false`.
   */
  hasBacklog?: boolean;
}

export interface OutboundMessage {
  from: string; to: string | string[]; subject: string;
  /**
   * Carbon and blind-carbon recipients, both DELIVERED (nodemailer flattens to+cc+bcc into the
   * SMTP RCPT list). The difference is in the HEADERS of the built message, not here: `cc` is
   * written as a `Cc:` header on both the delivered message and the Sent-folder copy; `bcc` is
   * written into NEITHER (nodemailer's default `keepBcc: false`). That header asymmetry — not any
   * omission at this seam — is what makes a Bcc blind. See `imap.ts#send` / `outboundToMail`.
   */
  cc?: string | string[]; bcc?: string | string[];
  text: string; html?: string;
  messageId?: string; inReplyTo?: string; references?: string | string[];
  /**
   * FILES TO SEND — and the whole reason ohmail can attach without storing a byte.
   *
   * `outboundToMail` maps these straight onto nodemailer's own `attachments`, so the ONE compiled
   * message drives BOTH the SMTP delivery AND the raw bytes appended to the Sent folder
   * (`imap.ts#send` → `buildRaw`). The bytes therefore exist only in this in-memory object for the
   * life of the send: they arrive in the send request, ride here, and are gone when the request
   * returns — never a row in `attachments`, `drafts` or anywhere else (§13.2/§14, and the
   * zero-at-rest guard in `mail-send-attach.test.ts`). Two producers fill it: the compose form's
   * own files (bytes uploaded with the send), and a FORWARD's original parts, which the server
   * streams from IMAP via `fetchPart` at send time and hands here without ever persisting them.
   *
   * `content` is the decoded bytes. nodemailer accepts a Buffer/Uint8Array for an attachment's
   * `content`, and `cid` (set only for a forwarded inline part) lets a related image keep resolving
   * against the quoted HTML.
   */
  attachments?: OutboundAttachment[];
}
export interface OutboundAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  /** A `related` inline part's Content-ID, carried so a forwarded body's `cid:` refs still resolve. */
  cid?: string;
}
export interface SendResult { providerMessageId: string; sentLocator: NativeLocator; }

/** One attachment BLOB fetched on-demand from IMAP — bytes are NEVER persisted (§13.2/§14). */
export interface FetchedPart { contentType: string; filename: string | null; body: Uint8Array; }

/**
 * What a TARGETED re-read of named UIDs found — see {@link MailboxAdapter.fetchByUid}.
 *
 * The three outcomes are disjoint and every named UID lands in exactly one of them, because the
 * caller has to close a durable record for each and "nothing came back" is not an answer it can
 * act on.
 */
export interface TargetedFetch {
  /** The epoch the server is reporting for this folder RIGHT NOW, as a decimal string. */
  uidValidity: string;
  /** Ingestable creates, in the same shape `changesSince` emits, `ownAuthored` stamped alike. */
  creates: Change[];
  /** Named, and the server has no message there any more. Expunged, or moved by the user. */
  absent: number[];
  /**
   * Named, present, and REFUSED WITHOUT DOWNLOADING — `RFC822.SIZE` is over `opts.maxBytes`.
   *
   * The point of the pre-check is that the two reachable failures are deterministic in the bytes,
   * so re-pulling a body only to have `normalizeMime` refuse it again costs the whole transfer for
   * an answer the size already gave.
   */
  oversize: number[];
}

/** Per-call controls for {@link MailboxAdapter.fetchByUid}. */
export interface FetchByUidOptions {
  /**
   * Report a UID as `oversize` rather than fetching it, from `RFC822.SIZE` alone. Omitted ⇒ every
   * named UID is fetched.
   */
  maxBytes?: number;
}

/** Per-call controls for {@link MailboxAdapter.fetchRaw}. */
export interface FetchRawOptions {
  /**
   * Refuse a message larger than this many bytes, rather than return part of one.
   *
   * Unlike {@link FetchPartOptions.maxBytes} this does NOT abandon the stream, and the
   * difference is the whole reason the two options are separate types — see
   * {@link MailboxAdapter.fetchRaw}. Omitted ⇒ 8 MiB.
   */
  maxBytes?: number;
}

/** Per-call controls for {@link MailboxAdapter.fetchPart}. */
export interface FetchPartOptions {
  /**
   * Abandon the download and throw `AttachmentTooLargeError` once this many bytes have arrived.
   *
   * Omitted ⇒ unbounded, which is the ONLY safe setting on a connection the caller intends to
   * reuse: tripping the ceiling abandons the stream mid-literal and leaves the socket unusable.
   * Pass it from a caller that owns a per-request connection and closes it; never from one
   * fetching several parts down the same socket.
   */
  maxBytes?: number;
}

export interface MailboxAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  capabilities(): Promise<ImapCapabilities>;
  ensureFolders(): Promise<void>;
  changesSince(cursor: ImapCursor): Promise<ChangeBatch>;
  move(locator: NativeLocator, toFolder: string): Promise<NativeLocator>;
  /**
   * Write the `\Seen` flag on ONE message — the other half of organize-in-place.
   *
   * Originally this interface had `move` and nothing else, so read-state never reached the
   * mailbox in either direction and the promise that read/seen flags survive
   * everything was a claim about a code path that did not exist.
   *
   * Called ONLY by the worker's `reconcileMailbox`, from a pending `flag_state` row, OUTSIDE
   * any transaction — the API never opens IMAP. Idempotent by construction: STORE
   * +FLAGS/-FLAGS on a message that already carries the flag is a no-op on every server, so a
   * crash between the IMAP write and the `observed_seen` update costs one redundant STORE on
   * the next pass and nothing else.
   *
   * `{ seen }` rather than a flag array, deliberately: `\Seen` is the only flag the product has
   * an opinion about, and a general flag-bag would invite writing `\Deleted` or `\Answered`
   * from code that has not thought about what that means in someone's real mailbox.
   *
   * Throws {@link MessageGoneError} when the locator no longer resolves (the message moved or
   * was expunged between the DB read and this call) — the same signal `move` raises, so the
   * reconciler's existing skip-and-re-adopt branch covers it.
   */
  setFlags(locator: NativeLocator, flags: { seen: boolean }): Promise<void>;
  /**
   * DISTINCT recipient addresses of the newest `limit` messages in the resolved Sent folder —
   * the raw material of the connect-time kickstart.
   *
   * People you have written to are people you know, and `contacts` IS `knownSenders`
   * (`drizzle-repo.ts`), so importing them is the single move that stops a virgin mailbox
   * screening every thread reply and every existing correspondent. Measured on the seeded
   * test world before it existed: most of its messages sat in `ohmail/Screener`.
   *
   * READ-ONLY AND NON-CREATING, both deliberately. It fetches envelopes under a mailbox lock and
   * never moves, flags or appends; and unlike the send path's `resolveSentFolder` it will NOT
   * create a `Sent` folder when the server has none — a mailbox with no Sent folder yields an
   * empty list, which degrades the kickstart, while creating a folder in someone's mailbox to
   * read zero messages out of it is a write we have no reason to make.
   *
   * OPTIONAL on the interface: the worker treats its absence as "no kickstart available", so
   * every existing fake adapter and every alternative backend keeps compiling and keeps working.
   */
  scanSentRecipients?(limit?: number): Promise<string[]>;
  /**
   * Re-read NAMED UIDs of one folder — the targeted retry of the durable failure ledger.
   *
   * ── WHY THIS IS NOT A FOLDER RESCAN, AND WHY IT CANNOT BE ──────────────────────────────
   *
   * A UID the ingest loop wrote off is, by then, behind the Sent folder's watermark
   * ({@link DEFAULT_SENT_HISTORY_MESSAGES}), and the watermark is the only enumeration floor that
   * folder has. Reaching the UID by rescanning means holding the watermark below it — for ever,
   * because the message keeps failing — so the enumeration range grows without bound and the poison
   * body is pulled again on every single cycle. Naming the UID is what makes the retry cost one
   * fetch instead of a permanent regression, and it is why the watermark can keep advancing, which
   * is the property that stops one bad message wedging a mailbox.
   *
   * ── WHY NOT {@link fetchRaw} ───────────────────────────────────────────────────────────
   *
   * `fetchRaw` returns bytes. The ingest path needs the bytes AND the server's `\Seen`, and
   * inventing the flag is not a small liberty: guess `false` on the user's own sent mail and it
   * comes back unread. This returns the same {@link Change} the ordinary create path carries,
   * `ownAuthored` stamped by the same Sent-folder resolution, so a retried message runs through
   * `planChange`/`commitChange` byte-identically to one that arrived normally — which is what makes
   * the retry idempotent rather than a second ingest path with its own dedup story.
   *
   * READ-ONLY. Nothing is moved, flagged or appended, and imapflow emits `BODY.PEEK[]` for a source
   * fetch, so re-reading somebody's mail cannot mark it read.
   *
   * OPTIONAL on the interface, on {@link scanSentRecipients}' rule: every existing fake adapter
   * keeps compiling, and a caller treats its absence as "this backend cannot retry by UID" — which
   * degrades to the pre-0041 behaviour rather than to an error.
   */
  fetchByUid?(
    folder: string, uids: readonly number[], opts?: FetchByUidOptions,
  ): Promise<TargetedFetch>;
  watch(onSignal: () => void): Promise<() => Promise<void>>;
  send(msg: OutboundMessage): Promise<SendResult>;
  /**
   * Fetch a single MIME part's BLOB on-demand. Bytes are NEVER persisted.
   *
   * `opts.maxBytes` aborts the transfer mid-stream and POISONS THE CONNECTION — see
   * {@link FetchPartOptions.maxBytes}. Optional third parameter so existing fakes keep compiling.
   */
  fetchPart(locator: NativeLocator, partId: string | null, opts?: FetchPartOptions): Promise<FetchedPart>;
  /**
   * The WHOLE RFC822 message, exactly as the server holds it. Read-only, and never persisted.
   *
   * ── WHY THIS EXISTS AS ITS OWN METHOD ──────────────────────────────────────────────────
   *
   * {@link fetchPart} is per-MIME-part and substitutes `"1"` for a null part, so it cannot ask
   * for a whole message. `download(uid, "")` happens to reach the right branch inside imapflow —
   * an empty part is falsy, and a falsy part makes it fetch the source — but that is an
   * undocumented property of a dependency's internals two layers below this interface, and
   * reading a stranger's mailbox is not a place to rely on one. A method whose name says what it
   * fetches can be tested, and its read-only guarantee can be stated where callers see it.
   *
   * ── IT NEVER MARKS ANYTHING READ ───────────────────────────────────────────────────────
   *
   * imapflow emits `BODY.PEEK[]` for a source fetch, and PEEK is the form of FETCH that does not
   * set `\Seen`. That is not a convention this method follows, it is the only wire form it can
   * produce — so a caller cannot accidentally mark someone's mail read by re-reading it.
   *
   * ── THE CEILING REFUSES; IT DOES NOT TRUNCATE, AND IT DOES NOT ABORT ───────────────────
   *
   * Two failure modes are ruled out here rather than left to callers:
   *
   *  · A SHORT READ IS NEVER RETURNED. Over the ceiling, this throws. The caller re-parses these
   *    bytes and decides something about their content; a message silently missing its tail
   *    re-parses into a message missing text, and every content decision then runs on less
   *    evidence than the real message carries. For a sensitivity decision that bias runs toward
   *    "nothing to see here", which is the one direction that must never happen quietly.
   *  · THE CONNECTION SURVIVES. {@link FetchPartOptions.maxBytes} abandons its stream mid-literal
   *    and leaves the socket unusable, which is why only a caller owning a per-request connection
   *    may pass it. This one stops at a chunk boundary instead, so it is safe on the long-lived
   *    per-mailbox connection the worker keeps in IDLE — which is the only connection its caller
   *    has.
   *
   * OPTIONAL on the interface, on {@link scanSentRecipients}' rule: every existing fake adapter
   * and every alternative backend keeps compiling, and a caller treats its absence as "this
   * backend cannot re-read a message" rather than as an error.
   */
  fetchRaw?(locator: NativeLocator, opts?: FetchRawOptions): Promise<Uint8Array>;
}
