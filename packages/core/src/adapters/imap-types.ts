// `../mail.js`, not `../index.js`: this module needs the mail vocabulary, and the default barrel
// re-exports the model half beside it — so naming it here would put the classifier and the drafter
// into the import graph of every artifact that opens a mailbox.
import type { Change, NativeLocator } from "../mail.js";
// The runtime imports of this module both come from `types.js`, a module with no imports of its
// own — see the note on the TLS floor below for why that restriction exists and what it is about
// (`imapflow` / `nodemailer` / `node:net`, none of which `types.js` touches).
// `RESERVED_FOLDER_LEAF` is the passive belt's SOURCE since the stage-2 folder verbs: the
// user-facing name validator (`folderNameError`) must refuse exactly what this belt hides, and
// two copies of one regex drift. The import points this way because `types.js` stays import-free.
import { DESTINATIONS as DESTINATIONS_VALUE, RESERVED_FOLDER_LEAF } from "../types.js";

/**
 * The two model types this module's own interfaces are written in, handed on:
 * `MailboxAdapter.move`, `moveMany`, `setFlags`, `fetchPart`, `MoveManyResult` and
 * `SendResult.sentLocator` name {@link NativeLocator}; {@link ChangeBatch} and {@link
 * TargetedFetch} are arrays of {@link Change}. Without the re-export a consumer of
 * `MailboxAdapter` had no name for the argument it must pass (TS2459). `export type { … } from`
 * creates no local binding, so it does not shadow the `import type` above, which the rest of this
 * file still reads.
 */
export type { Change, NativeLocator } from "../mail.js";

/**
 * Canonical folders the worker watches. INBOX = Imbox. These are the six `Destination` strings
 * and nothing else: the set `ensureFolders()` creates, the set a reconcile may move a message
 * into, the set every list view filters on. Frozen — changing it is an IMAP data migration in the
 * customer's own mailbox. The Sent folder is watched too and deliberately NOT here: its path is
 * server-specific and discovered at login (`ImapAdapter.findSentForScan`), we never create it or
 * move anything into or out of it, and it matches no view filter. See `ImapAdapter.changesSince`.
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

/**
 * The ORGANIZE predicate lives in the model (`types.ts#isOrganizedFolder`), not here, and is
 * re-exported so a caller already importing this module does not need two imports.
 *
 * Its docblock says why. In short: several callers that need it must not pull `imapflow` into their
 * import graph, and this module's entry point does.
 */
export { isOrganizedFolder, DESTINATIONS } from "../types.js";

/**
 * `WATCHED_FOLDERS` and `DESTINATIONS` hold the same six strings, and this asserts it at module load
 * — the {@link META_FOLDER_IS_UNWATCHED} idiom.
 *
 * They are two literals rather than one derivation on purpose: the web client's
 * folder-showcase guard parses the `export const WATCHED_FOLDERS = [ … ] as const` literal out of
 * this file's SOURCE to diff the marketing showcase against it, so replacing the literal with an
 * expression makes that guard stop guarding while staying green. The duplication is therefore
 * deliberate and this line is what keeps it honest.
 */
export const WATCHED_FOLDERS_ARE_THE_DESTINATIONS: boolean =
  WATCHED_FOLDERS.length === DESTINATIONS_VALUE.length
  && WATCHED_FOLDERS.every((f, i) => f === DESTINATIONS_VALUE[i]);

/**
 * Passive presence — the customer's own folders, read and never reorganized: enumerated,
 * ingested, searchable, threaded. Held three ways: {@link isOrganizedFolder} answers false,
 * `pipeline.ts#planChange` returns early for a passive arrival, and the row is `last_set_by =
 * 'external'` while moving passes require `'us'`. `\Junk`/`\Trash`/`\Drafts` are never read —
 * none holds mail the customer filed. Three user-commanded writes only: a spam verdict to native
 * `\Junk`, a not-junk rescue back to INBOX, a delete to native `\Trash` (never an expunge);
 * destinations discovered, never created (`no_junk_folder`/`no_trash_folder`). `\All`/`\Flagged`
 * are virtual; `\Sent` has its own watermark; the `ohmail` namespace is excluded whole.
 */
export const PASSIVE_EXCLUDED_SPECIAL_USE: ReadonlySet<string> = new Set([
  "\\inbox", "\\sent", "\\drafts", "\\junk", "\\trash", "\\all", "\\flagged", "\\important",
]);

/**
 * Leaf names that mean one of the excluded classes on a server that names no SPECIAL-USE for them.
 *
 * This is a BELT, not the primary rule, and it earns its place on measured data rather than on
 * caution: a live dovecot deployment reports `INBOX.Trash` carrying the `\Trash` flag and, beside
 * it, `INBOX.Deleted Messages` and `INBOX.Junk` with **no special-use at all** — two former
 * specials a migration left behind, one of them still full. imapflow's own localized name table
 * missed both. The cost of the belt is a customer folder deliberately named `Junk` staying
 * invisible; the cost of not having it is ingesting a stranger's spam into somebody's search.
 */
export const PASSIVE_EXCLUDED_LEAF = RESERVED_FOLDER_LEAF;

/**
 * Sent-shaped canonical paths — top level or under the INBOX prefix. Re-exported from
 * `../types.js`, now the value's home, because a third reader is a browser bundle: the client
 * mirrors ask whether a row is the account's own sent mail and cannot reach this module. The
 * other two readers keep their stakes: the folders inventory (`packages/services/src/folders.ts`)
 * excludes these from the user-folder class, and the folder delete's stale-residue cleanup must
 * never take a Sent-folder instance row — Sent is scanned by UID watermark, so a deleted stale
 * Sent row is the last evidence its copy exists.
 */
export { SENT_SHAPED_CANONICAL } from "../types.js";

/**
 * Leaf names that mean the provider's Junk folder on a server naming no SPECIAL-USE — the
 * write-side belt for the three user-commanded writes. Split from {@link PASSIVE_EXCLUDED_LEAF}
 * rather than derived because the two belts fail in opposite directions: the passive belt errs
 * toward not reading (a false positive hides a customer folder), this one errs toward not writing
 * — no `bin`, no `deleted`, nothing that could be a customer's own archive. A miss costs nothing
 * destructive: the verdict falls back to `ohmail/Quarantine` under the closed code.
 */
export const JUNK_BY_NAME = /^(junk[ -]?(?:e-?mail)?|spam|bulk[ -]?mail|unerw(?:ü|ue)nscht)$/i;

/**
 * {@link JUNK_BY_NAME}'s pair for the provider's Trash. Narrower than the passive belt's trash
 * class for the same reason — `bin` alone is admitted only in its compound forms, because a
 * customer folder literally named `Bin` is plausible and a delete filed into it is a write into
 * somebody's own filing. A miss refuses the delete (closed code `no_trash_folder`); it never
 * expunges.
 */
export const TRASH_BY_NAME =
  /^(trash|recycle[ -]?bin|deleted[ -](?:items|messages)|gel(?:ö|oe)schte[ -](?:objekte|elemente|nachrichten)|papierkorb)$/i;

/**
 * The two write-side special folders one mailbox resolved, canonical paths or null.
 *
 * `null` is a fact, not an error: the mailbox genuinely has no such folder and the caller takes
 * the documented fallback (Quarantine for a spam verdict, refusal for a delete). Discovery NEVER
 * creates a folder — the Sent path's create-as-last-resort exists because a send has nowhere
 * else to put the copy; a verdict and a delete both have an honest fallback, so creating a
 * directory in somebody's mailbox is a write we have no reason to make.
 */
export interface SpecialFolders {
  junk: string | null;
  trash: string | null;
}

/** The `ohmail` namespace, in canonical (`/`-delimited) form, at any depth. */
const OHMAIL_SEGMENT = /(?:^|\/)ohmail(?:\/|$)/i;

/** One folder as the server described it, reduced to what the passive decision reads. */
export interface ListedFolder {
  /** CANONICAL path — `/`-delimited, `ImapAdapter.toCanonical` applied. */
  path: string;
  /** imapflow's resolved special-use (`"\\Sent"`, …), or null/undefined when it named none. */
  specialUse?: string | null;
  /** The LIST flags, lowercased or not — membership is tested case-insensitively. */
  flags?: ReadonlySet<string>;
}

/**
 * Why this folder is NOT read as passive presence, or `null` when it IS — the
 * {@link loopbackHarnessReason} shape, for the same reason: an operator looking at a folder that
 * did not get ingested needs the sentence, not a boolean.
 *
 * `sentFolder` is the path the adapter resolved for THIS mailbox, which is the only way to exclude
 * a Sent folder on a server that advertises no SPECIAL-USE (`INBOX/Sent`, matched by name).
 */
export function passiveFolderExclusion(
  folder: ListedFolder, sentFolder: string | null,
): string | null {
  const path = folder.path;
  const flags = new Set([...(folder.flags ?? [])].map((f) => String(f).toLowerCase()));
  if (flags.has("\\noselect") || flags.has("\\nonexistent")) {
    return "the server reports it as not selectable";
  }
  if (path.toUpperCase() === "INBOX") return "it is the Imbox and is watched already";
  if (OHMAIL_SEGMENT.test(path)) return "it is inside the ohmail namespace";
  if ((DESTINATIONS_VALUE as readonly string[]).includes(path)) {
    return "it is one of the folders ohmail organizes";
  }
  if (sentFolder !== null && path === sentFolder) {
    return "it is the mailbox's Sent folder, watched on its own watermark";
  }
  const special = (folder.specialUse ?? "").toLowerCase();
  if (special && PASSIVE_EXCLUDED_SPECIAL_USE.has(special)) {
    return `the server reports it as ${special}`;
  }
  const leaf = path.split("/").pop() ?? path;
  if (PASSIVE_EXCLUDED_LEAF.test(leaf)) {
    return `its name (${leaf}) is one of the excluded classes on a server that named none`;
  }
  return null;
}

/**
 * How many of the customer's own folders one mailbox may have read — two numbers, because the
 * cost is not the folder count. Each scanned folder is a SELECT per cycle on a worker serial
 * across the shard; with RFC 5819 LIST-STATUS the steady state is one LIST plus a SELECT per
 * changed folder (`ImapAdapter.unchangedPassive`), so that ceiling sits far higher than on a
 * server asked folder by folder. The lower number is not the safe default: past a ceiling mail is
 * invisible, cut alphabetically. Overflow is reported by `passiveFolderReport()` and read by
 * nothing — a bounded, nameable gap. The order is deterministic, by path, so the overflow set
 * does not oscillate.
 */
export const DEFAULT_PASSIVE_FOLDERS_MAX = 256;

/**
 * …and the ceiling for a server that cannot answer LIST-STATUS, where every folder in the scan is a
 * SELECT on every cycle.
 *
 * 32 at ~2 round trips each is a few seconds of IMAP per cycle — inside the
 * {@link WORKER_NET_TIMEOUTS} socket ceiling and far inside the 15-minute `sync_lag` alert.
 */
export const PASSIVE_FOLDERS_MAX_NO_STATUS = 32;

// The TLS floor on the ohmail-to-provider leg. `ImapConfig.secure` is a caller-supplied boolean
// from the onboarding request body, and it used to be the only thing between the user's IMAP
// password and the wire — `secure: false` against a server without STARTTLS sent it in clear
// text. Both connection shapes are legitimate (implicit TLS 993/465, STARTTLS 143/587); the
// invariant is narrower: authentication never happens over a connection that did not become
// encrypted. Hence functions of `(host, secure)` returning options, and guards that assert on a
// server TRANSCRIPT — no LOGIN or AUTH reached it — rather than on a flag. No runtime imports:
// `packages/services` must import {@link loopbackHarnessReason} without pulling
// imapflow/nodemailer or `node:net` into the API bundle.

/**
 * The two TLS parameters that must never be left to a default. `imapflow@1.5.0` and
 * `nodemailer@6.10.1` pass their `tls` object straight into `tls.connect`, so the effective
 * defaults are Node's — and both are process globals: `NODE_TLS_REJECT_UNAUTHORIZED=0` silently
 * disables certificate validation unless `rejectUnauthorized: true` is explicit (measured: the
 * explicit form still fails under the env var, the only form that holds), and `node
 * --tls-min-v1.0` lowers `minVersion` so an unpinned client negotiated TLSv1 (measured). TLSv1.2,
 * not 1.3: the common shape is IMAP on 993 offering 1.3 while submission on 587 tops out at 1.2 —
 * a 1.3 floor breaks sending on a server whose receiving side is fine.
 */
export const TLS_FLOOR = { rejectUnauthorized: true, minVersion: "TLSv1.2" } as const;

/** The strict TLS parameter set applied to every non-loopback mail connection. */
export interface TlsFloorOptions { readonly rejectUnauthorized: true; readonly minVersion: "TLSv1.2" }

/**
 * Is `host` a literal IP address rather than a DNS name? Hand-rolled for the same reason
 * {@link loopbackHarnessReason} is: this module may not import `node:net`. A dotted quad is v4;
 * anything containing a colon can only be a v6 literal (RFC 952/1123 names cannot carry one).
 */
const isIpLiteral = (host: string): boolean => {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (h.includes(":")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((n) => Number(n) >= 0 && Number(n) <= 255);
};

/**
 * The SNI name for a dial, or undefined when SNI must be omitted. RFC 6066 §3 forbids an IP
 * literal in SNI, and both `imapflow@1.5.0` and `nodemailer@6.10.1` apply exactly this rule when
 * deriving their own default. Pinned here because the derivation lives inside two dependencies'
 * internals: a multi-vhost server presents its default certificate to a dial with no SNI, which
 * fails hostname validation — indistinguishable from a wrong certificate. An explicit
 * `servername` is the difference between what a library happens to do and a floor the guards can
 * watch.
 */
export const sniServername = (host: string): string | undefined =>
  isIpLiteral(host) ? undefined : host;

/**
 * Why `host` is the local test harness and therefore exempt from the floor, or `null` — the
 * `transactionPoolerReason` shape: a guard that only says no teaches the operator nothing.
 * GreenMail (`:3143`/`:3025`) and the dovecot CONDSTORE fallback (`:3144`) speak plaintext only,
 * and the exemption is so narrow production cannot reach it: keyed on the host being LOOPBACK,
 * the one address family that cannot carry a packet off the machine. Deliberately mean —
 * `0.0.0.0`, `::ffff:127.0.0.1`, `localhost.evil.com` and an empty string all fail CLOSED (the
 * connection gets harder, never softer); `*.localhost` is admitted because RFC 6761 §6.3 reserves
 * it for loopback.
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
   * STARTTLS."* on the pair. ALSO absent on the consent branch (see {@link imapTlsFloor}),
   * where its absence is what makes imapflow's upgrade opportunistic.
   */
  doSTARTTLS?: true;
  /** SNI, pinned. See {@link sniServername}; absent only for an IP-literal host. */
  servername?: string;
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
  /** SNI, pinned — `smtp-connection/index.js:61` reads it. See {@link sniServername}. */
  servername?: string;
  tls?: TlsFloorOptions;
}

/**
 * IMAP: the options that make `imapflow` refuse to authenticate over cleartext. `secure: true`
 * needs nothing — TLS from the first byte. The dangerous case is `secure: false`, where
 * imapflow's default is opportunistic STARTTLS; `doSTARTTLS: true` converts that into a refusal
 * (`Server does not support STARTTLS`), checked in `startSession()` one line before
 * `authenticate()` — the ordering the whole guard rests on.
 */
export function imapTlsFloor(host: string, secure: boolean, allowInsecure = false): {
  options: ImapTlsFloorOptions; exemptReason: string | null;
} {
  const exemptReason = loopbackHarnessReason(host);
  // The exempt path adds NOTHING and removes NOTHING — it declines to add the floor, so
  // the harness gets byte-identical behaviour to before the TLS floor and no new hole is invented.
  if (exemptReason) return { options: { secure }, exemptReason };
  const servername = sniServername(host);
  const sni = servername ? { servername } : {};
  /**
   * The consent branch — the one way authentication may cross an unencrypted socket, reachable
   * only with `secure: false` AND an explicit `allowInsecure`, which callers derive from a stored
   * per-mailbox consent marker written after the probe proved the server offers no TLS at all and
   * the user opted in over copy saying the password and all mail travel unencrypted. It does not
   * abandon the upgrade: `doSTARTTLS` is simply absent (imapflow's opportunistic mode), so a
   * consented server that later gains STARTTLS is upgraded on the next dial, {@link TLS_FLOOR}
   * still validating the certificate. A `secure: true` config ignores the flag: there is nothing
   * to consent away.
   */
  if (!secure && allowInsecure) {
    return { options: { secure: false, ...sni, tls: TLS_FLOOR }, exemptReason: null };
  }
  return {
    options: secure
      ? { secure: true, ...sni, tls: TLS_FLOOR }
      : { secure: false, doSTARTTLS: true, ...sni, tls: TLS_FLOOR },
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
  const servername = sniServername(host);
  const sni = servername ? { servername } : {};
  // NO consent branch here, deliberately. The connect-time probe proves facts about the IMAP
  // endpoint only, so a consent marker earned there licenses nothing about a different server on
  // a different port. A consented no-TLS provider whose SMTP also lacks STARTTLS fails at send
  // time with the tls taxonomy — the bounded, honest direction.
  return {
    options: secure
      ? { secure: true, ignoreTLS: false, opportunisticTLS: false, ...sni, tls: TLS_FLOOR }
      : { secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false, ...sni, tls: TLS_FLOOR },
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
  /**
   * The user CONSENTED, at connect time, to authenticating this one mailbox over a socket that
   * never became encrypted — offered only after the probe proved the server has no TLS at all,
   * and honored only with `secure: false`. See the consent branch in {@link imapTlsFloor} for
   * exactly what it changes (a mandatory STARTTLS becomes an opportunistic one) and what it
   * does not (certificate validation of any upgrade that does happen). Every dialler that
   * builds a config from stored credential meta must thread `meta.insecureConsent` through
   * here, or a mailbox the probe admitted will strand on its first sync.
   */
  allowInsecure?: boolean;
  auth: ImapAuth;
  /**
   * The addresses this dial may connect to — the SSRF gate's clearance, carried to the socket.
   * `assertPublicHost` resolves a caller-supplied hostname; if the dial resolves the name a
   * second time, a DNS-rebinding server answers the gate with a public address and the socket
   * with `169.254.169.254` (the argument is at the top of `net/pinned-fetch.ts`). Only the IP
   * changes: `host` stays the NAME on both transports, so SNI and certificate validation still
   * see what the user typed. Absent means dial by name — every stored-credential dialler leaves
   * it undefined; it is set on the add-time probe under the hosted policy only. An empty array
   * reads as absent: the pin narrows a dial, never a second refusal mechanism.
   */
  pin?: readonly string[];
  smtp?: {
    host: string; port: number; secure: boolean; auth?: { user: string; pass: string };
    /** The submission leg's own pin — see {@link ImapConfig.pin}. Resolved separately because the
     * submission host is a different name from the IMAP host and was cleared by its own check. */
    pin?: readonly string[];
  };
  sentDomain?: string;
  /**
   * Network deadlines, in ms, for both transports (see {@link DEFAULT_NET_TIMEOUTS}). Neither
   * `imapflow` nor `nodemailer` fails fast by default — a provider that accepts the TCP
   * connection and then stops responding hangs the operation indefinitely. On the serverless host
   * the ceiling is the platform's 60 s `maxDuration`, and being killed by the platform is the one
   * failure with no error handling at all: no `finally`, no `adapter.close()`, no response. Every
   * deadline here sits well below it, so a hung mailbox produces a normal error inside our own
   * code.
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
 * The same deadlines for the worker's persistent, IDLE-held connections. `socketMs` is Node's
 * inactivity timer, and imapflow's handler recovers with a NOOP only while IDLING; otherwise it
 * emits `error`. imapflow auto-idles only when a mailbox is SELECTED, 15 s after the last command
 * — so the fatal window is connected, nothing selected, no command in flight, which is where the
 * thread backfill ran for minutes and a 25 s timer emitted ETIMEOUT with no listener. 120 s: 8x
 * the auto-idle delay, above the bounded DB-only stretches a cycle produces, below imapflow's 300
 * s default and the 15-minute `sync_lag` alert. Survival is {@link
 * ImapAdapterOpts.onConnectionError}'s job, not this number's.
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
  /**
   * The Sent path the scan actually watches — `sentFolder` when SPECIAL-USE answered, otherwise
   * the memoised name-fallback (`findSentForScan`). Optional for adapter fakes; absence reads as
   * `sentFolder`. A separate field because `sentFolder` is where the SEND path appends and a read
   * must never redirect it. The reader that needs this one is the delete completion's Sent
   * exclusion: on a no-SPECIAL-USE server the watched Sent lives only in the fallback, and
   * excluding against `sentFolder` alone would leave those providers open to the stale-Sent-row
   * retry wedge.
   */
  watchedSentFolder?: string | null;
}

/**
 * How many messages ONE `changesSince` call may fetch bodies for.
 *
 * The unbounded-fetch outage: the first sync of a real mailbox fetched `source: true` for every
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
 * How many messages one {@link MailboxAdapter.moveMany} call may carry. The destination pre-check
 * is a single `OR HEADER MESSAGE-ID …` command with one term per member: at 50 roughly 3 KB, at a
 * real screening session's thousand-plus members about 70 KB — which a command-line-capping
 * server refuses, and only on large backlogs, precisely the case the batched path exists for. The
 * `UID MOVE` set has the same shape. 50 is not tuned and need not be: ~5 commands per chunk means
 * 0.1 commands per message already; it keeps both commands comfortably small on the least
 * accommodating server.
 */
export const FILING_BATCH_MAX = 50;

/**
 * What {@link MailboxAdapter.moveMany} answers. `batched: false` means NOTHING WAS WRITTEN and
 * the caller owes the whole group to {@link MailboxAdapter.move}; there is no partial outcome.
 *
 * `moved` is keyed by the SOURCE locator's `ref` — the caller holds locators, not bare UIDs, and
 * a ref is the only key that stays meaningful across the epoch it names.
 */
export interface MoveManyResult {
  /** True ⇒ `moved` and `gone` together account for every locator passed in. */
  batched: boolean;
  /** Source `ref` → the locator the message now has at the destination. */
  moved: Map<string, NativeLocator>;
  /** Members the source folder no longer holds — the batch's `MessageGoneError`. */
  gone: NativeLocator[];
}

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
 * How much of the Sent folder is ever ingested, newest first. Full ingestion would copy fifteen
 * years of outbound mail into `messages`/`message_bodies` for conversations nobody opens; the
 * value lives in recent correspondence. 2 000 is roughly two years at a few sends a day, drained
 * in about ten bounded cycles. Residual, stated: a conversation whose outbound half is older
 * shows the other side only. First scan enumerates the newest N by sequence; afterwards the
 * persisted `uidNext` is the watermark. The watermark also closes the `own_copy` loop: that dedup
 * writes no row for the Sent twin, and a UID is behind the watermark whether or not it produced a
 * row — otherwise every self-CC'd message would be re-fetched for ever.
 */
export const DEFAULT_SENT_HISTORY_MESSAGES = 2_000;

/**
 * How many FLAG changes one `changesSince` call may report. The creates budget bounds memory;
 * this bounds TIME: the CONDSTORE fast path pushed every changed UID uncapped, and the worker
 * consumes each as its own transaction — mark-all-as-read across a large mailbox meant minutes on
 * the single serial queue, no other mailbox syncing, and `stop()` unable to finish inside the
 * platform's 30 s drain before SIGKILL. 500 is ~7 s of database round trips, inside imapflow's 15
 * s auto-idle delay and {@link WORKER_NET_TIMEOUTS}. A truncated pass sets `hasBacklog`, so the
 * worker re-kicks and 8 792 flags drain in about a minute.
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
   * The connection died asynchronously — the one failure this class cannot report by throwing.
   * `ImapFlow` signals a dead socket, a server BYE or an ETIMEOUT by emitting `error`; with no
   * listener Node turns that into an uncaught exception and the worker's entrypoint exits by
   * design — a `try/catch` around the slow code could never catch it. The adapter therefore
   * ALWAYS attaches a listener (`ImapAdapter.connect`), supplied or not: containment must not
   * depend on a caller remembering. The worker detaches and quarantines just that mailbox. It
   * must not throw — a handler that rethrows inside an `error` listener reproduces the crash it
   * prevents.
   */
  onConnectionError?: (err: unknown) => void;
  /**
   * The clock the adapter's wall-clock ceilings read (`imap-bounds.ts`: {@link
   * IMAP_READ_DEADLINE_MS}, {@link IMAP_CYCLE_DEADLINE_MS}). A test seam: the slow-server
   * ceilings are minutes, so proving them against the real clock means sleeping minutes, and
   * lowering them means testing numbers the product does not ship. Handing the adapter its clock
   * lets a hostile-server test drive the SHIPPING constants to the millisecond. Defaults to
   * `Date.now`; nothing in production supplies it.
   */
  nowMs?: () => number;
}

export interface PersistedFolderCursor {
  uidValidity: string;
  uidNext: number;
  highestModseq: string;
  /**
   * The folder's `EXISTS` as this SELECT reported it — the first pull's denominator (mail 0083).
   * The adapter always read `mb.exists` and always discarded it, so no truthful total existed
   * anywhere: the import progress strip had a numerator with nothing to divide it by. Remaining
   * is the sum of this over watched folders minus the mirror count. Optional; absent means this
   * pass did not open the folder (the passive fast path, every fake adapter), and the writer
   * leaves the stored value alone rather than nulling it. A count, not a cursor: nothing decides
   * on it and it may go backwards.
   */
  serverExists?: number;
}
/**
 * One UID the adapter must not re-fetch, plus the `\Seen` state the database last observed for
 * it (`flag_state.observed_seen`, or the ingest-time flags before any flag row exists).
 *
 * `seen` is the PRIOR FLAGS the no-CONDSTORE fallback diffs against: a server that cannot
 * answer `changedSince` (Office 365 advertises no CONDSTORE) still answers a plain FLAGS fetch,
 * and a divergence from this baseline is exactly a flag change. `null`/absent means the repo
 * could not state a baseline (a dead-lettered UID, a pre-migration cursor) — such an entry is
 * never diffed, only protected from re-fetch.
 */
export interface KnownEntry { uid: number; messageId: string | null; seen?: boolean | null; }
export interface FolderCursor extends PersistedFolderCursor { known: KnownEntry[]; }
export interface ImapCursor { folders: Record<string, FolderCursor>; }

export interface ChangeBatch {
  creates: Change[];
  moves: Change[];
  flagChanges: Change[];
  deletes: Change[];
  newCursor: { folders: Record<string, PersistedFolderCursor> };
  /**
   * Folders whose PERSISTED cursor this build could not read, and which were therefore scanned
   * from cold. Reported rather than logged here because the adapter has no logger; the caller
   * owes the fact a line. Absent ⇒ none.
   */
  rebootstrapped?: readonly string[];
  /**
   * At least one folder's backlog was truncated by the batch budget — another pass is owed. A
   * truncated folder's cursor is held at its previous value (see {@link
   * DEFAULT_SYNC_BATCH_MAX_MESSAGES}), so the worker cannot rely on cursor movement to know it is
   * done; it re-kicks on this flag instead of waiting out the poll interval — a big first sync
   * becomes short observable cycles instead of one three-hour cycle that looks dead. Optional so
   * every fake adapter keeps compiling; absent reads as `false`.
   */
  hasBacklog?: boolean;
  /**
   * UIDs this pass asked the server for and did not get back — the caller owes each a durable
   * failure row BEFORE writing the folder cursor. RFC 3501 lets `UID FETCH` return fewer messages
   * than named, with no error, so did-not-arrive is indistinguishable from does-not-exist. The
   * cursor is published advanced — safe only because `message_failures` holds the UID,
   * `buildCursor` merges it into the known-set, and the targeted retry re-reads it on every
   * deploy; ignoring this field publishes a watermark over mail nothing will enumerate again
   * (`sync.ts`). iCloud omits the row for a quoted-string `Message-ID` under ENVELOPE;
   * `fetchCapped` re-asks without the suspect field. Optional; absent means nothing withheld.
   */
  unanswered?: ReadonlyArray<{ folder: string; uidValidity: string; uid: number }>;
  /**
   * UIDs whose RFC822.SIZE already exceeds `MAX_RAW_MESSAGE_BYTES`, so the body was deliberately
   * never fetched — the caller owes each a durable `mime_too_large` row before writing the
   * cursor, exactly as for {@link unanswered}. The anti-stall rule in `fetchCapped` admits the
   * first candidate past the BATCH byte budget, but a message past the MIME ceiling is refused by
   * `normalizeMime` deterministically AFTER download — admitting it buys a 100+ MiB transfer
   * whose outcome was already known from the metadata fetch. So the ceiling is enforced pre-fetch
   * from RFC822.SIZE, writing the same durable row; the targeted retry probes by size once per
   * build. Optional; absent means nothing refused on size.
   */
  oversize?: ReadonlyArray<{ folder: string; uidValidity: string; uid: number; size: number }>;
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
   * Extra RFC 5322 header fields, written onto both the delivered message and the Sent-folder
   * copy (one `Mail.Options` builds both — `outboundToMail`). Exists for one caller and one
   * header: an automatic reply must carry `Auto-Submitted: auto-replied` (RFC 3834 §5), which
   * stops another responder answering ours; a hand-composed send never sets it. Names pass to
   * nodemailer's `headers` verbatim and may NOT restate a field this seam owns
   * (From/To/Cc/Bcc/Subject/Message-ID/In-Reply-To/References): MailComposer would emit it twice,
   * and a duplicated `Message-ID` breaks the verify-by-Sent probe the crash-safe send depends on.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * Files to send — the reason ohmail can attach without storing a byte. `outboundToMail` maps
   * these onto nodemailer's `attachments`, so one compiled message drives both the SMTP delivery
   * and the raw bytes appended to Sent (`imap.ts#send` → `buildRaw`). The bytes exist only in
   * this in-memory object for the life of the send — never a row in `attachments`, `drafts` or
   * anywhere else (§13.2/§14). Two producers: the compose form's own files, and a forward's
   * original parts, streamed from IMAP via `fetchPart` at send time. `content` is decoded bytes;
   * `cid` (forwarded inline parts only) keeps a related image resolving against the quoted HTML.
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
export interface SendResult {
  providerMessageId: string;
  sentLocator: NativeLocator;
  /**
   * The exact bytes appended to the Sent folder — `MailComposer`'s output, the same Buffer handed
   * to `client.append`. One consumer, and the reason is an identity rule:
   * `identity.ts#messageFingerprint` derives identity from content via `normalizeMime` over raw
   * source, so `sent-record.ts#recordSentMessage` must fingerprint THESE bytes. Rebuilding from
   * the `OutboundMessage` drifts by a byte — a boundary string, a header fold — which is a
   * different fingerprint and a second `messages` row when the Sent copy is observed,
   * permanently. Not optional, deliberately: `raw?` would let a future adapter opt out of the
   * rule silently.
   */
  raw: Buffer;
}

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
  /**
   * An IMAP NOOP: ask this connection whether it still answers. A half-open link — socket up,
   * every command hanging, no `close`, no `error` — is invisible to {@link
   * ImapAdapterOpts.onConnectionError}, and the other detectors are clocks in minutes.
   * Deliberately unbounded: the caller owns the window, because a heartbeat's purpose is a
   * deadline shorter than every other command's. Abandoning the call leaves the command
   * outstanding, so pair it with {@link forceClose}. Optional: an adapter without it cannot be
   * probed, which is not the same fact as a connection that failed to answer.
   */
  noop?(): Promise<void>;
  /**
   * End this connection now, without a LOGOUT. IMAP commands are serialized, so {@link close}
   * queues its LOGOUT behind a hung command and waits out the hang it was escaping; destroying
   * the socket is also the only thing that ends that command. Optional, like {@link noop}.
   */
  forceClose?(): void;
  /**
   * The last moment this connection was heard from — the server's own bytes, not our writes. A
   * heartbeat alone cannot tell a busy link from a dead one: imapflow writes one command at a
   * time, so a NOOP issued during a long FETCH is not on the wire yet. What tells them apart is
   * whether the server is still talking — a streaming FETCH answers continuously, a half-open
   * link answers nothing. `null` means nothing heard yet — unknown, not silence. Optional, like
   * {@link noop}.
   */
  lastServerActivityAt?(): Date | null;
  capabilities(): Promise<ImapCapabilities>;
  ensureFolders(): Promise<void>;
  changesSince(cursor: ImapCursor): Promise<ChangeBatch>;
  move(locator: NativeLocator, toFolder: string): Promise<NativeLocator>;
  /**
   * File a group of messages sharing a source folder and destination in a handful of round trips
   * instead of a handful per message. `batched: true` means the folders end in the state
   * per-member {@link move} would have produced, `moved` naming where each landed; `batched:
   * false` means NOTHING WAS WRITTEN and the caller owes the whole group to `move` — the
   * implementation refuses before it writes; no partial outcome. `gone` carries members whose UID
   * the source no longer holds ({@link MessageGoneError} reported, not thrown), so one vanished
   * message does not cost the group; `changesSince` adopts what happened. The group must not
   * exceed {@link FILING_BATCH_MAX}. Optional; fakes keep compiling.
   */
  moveMany?(locators: readonly NativeLocator[], toFolder: string): Promise<MoveManyResult>;
  /* ── The USER-COMMANDED folder verbs (FOLDERS-SPEC.md stage 2) — executed only by the
   * worker's `folderOpsPass`, only from a recorded `folder_ops` command, under the organizer
   * lease. ohmail never creates, renames or deletes a folder on its own initiative. All four
   * OPTIONAL on `scanSentRecipients`' rule: an adapter without them simply cannot execute the
   * verbs (the pass fails the command honestly), and every fake keeps compiling. Canonical
   * `/`-joined paths throughout; the adapter owns the delimiter translation. */
  /** The mailbox's real hierarchy delimiter, discovered at connect — the folder-op pass's last name check. */
  hierarchyDelimiter?(): string;
  /**
   * IMAP CREATE, answering the canonical path that now EXISTS — a personal-namespace server
   * files a root-named CREATE under INBOX, and the caller must record where it landed.
   * Idempotent: "already exists" is the asked-for state.
   */
  createFolder?(canonical: string): Promise<string>;
  /**
   * IMAP RENAME with the idempotent-completion arm: `"already"` when the source is gone AND the
   * target exists (a crash between the RENAME and the database swap, or the user's own client
   * did it) — the caller proceeds to the swap. `"conflict"`/`"gone"` are the honest refusals.
   */
  renameFolder?(from: string, to: string): Promise<"renamed" | "already" | "conflict" | "gone">;
  /**
   * IMAP DELETE of a VERIFIED-EMPTY folder only — the adapter re-verifies emptiness because
   * RFC 3501's DELETE takes messages with it, and never-expunge is the product rule, not a
   * convention. `"unverified"` fails closed when the server will not answer STATUS.
   */
  deleteFolder?(canonical: string): Promise<"deleted" | "already" | "not_empty" | "unverified">;
  /** The folder delete's sweep: move EVERYTHING in `folder` to `toFolder` (native \Trash). */
  moveAll?(folder: string, toFolder: string): Promise<number>;
  /**
   * Write the `\Seen` flag on one message — the other half of organize-in-place; without it
   * read-state never reached the mailbox in either direction. Called only by the worker's
   * `reconcileMailbox`, from a pending `flag_state` row, outside any transaction — the API never
   * opens IMAP. Idempotent by construction: STORE +FLAGS/-FLAGS on a message already carrying the
   * flag is a no-op on every server, so a crash between the IMAP write and the `observed_seen`
   * update costs one redundant STORE. `{ seen }` rather than a flag bag: `\Seen` is the only flag
   * the product has an opinion about. Throws {@link MessageGoneError} when the locator no longer
   * resolves — the same signal `move` raises.
   */
  setFlags(locator: NativeLocator, flags: { seen: boolean }): Promise<void>;
  /**
   * Distinct recipient addresses of the newest `limit` messages in the resolved Sent folder — the
   * raw material of the connect-time kickstart. People you have written to are people you know,
   * and `contacts` IS `knownSenders` (`drizzle-repo.ts`); importing them is the single move that
   * stops a virgin mailbox screening every thread reply. Read-only and non-creating, both
   * deliberately: it fetches envelopes under a mailbox lock, never moves, flags or appends, and
   * unlike the send path's `resolveSentFolder` it will NOT create a Sent folder — a mailbox
   * without one yields an empty list. Optional: the worker treats absence as no kickstart
   * available.
   */
  scanSentRecipients?(limit?: number): Promise<string[]>;
  /**
   * Re-read named UIDs of one folder — the targeted retry of the durable failure ledger. Not a
   * rescan, and it cannot be: a written-off UID is behind the Sent watermark, and holding the
   * watermark below it for ever grows the enumeration range without bound, pulling the poison
   * body every cycle. Naming the UID makes the retry cost one fetch and lets the watermark
   * advance. Not {@link fetchRaw}: the ingest path needs the bytes AND the server's `\Seen` —
   * guess `false` on the user's own sent mail and it comes back unread. Returns the same {@link
   * Change} the create path carries, so a retried message runs `planChange`/`commitChange`
   * byte-identically. Read-only (`BODY.PEEK[]`). Optional; absence degrades, never errors.
   */
  fetchByUid?(
    folder: string, uids: readonly number[], opts?: FetchByUidOptions,
  ): Promise<TargetedFetch>;
  /**
   * Resolve the provider's native `\Junk` and `\Trash` for the three user-commanded writes — see
   * the product rule above {@link PASSIVE_EXCLUDED_SPECIAL_USE}. SPECIAL-USE first, then the
   * {@link JUNK_BY_NAME}/{@link TRASH_BY_NAME} belts on the canonical leaf, `\Noselect` and the
   * `ohmail` namespace excluded, and nothing is ever created — see {@link SpecialFolders} for why
   * a null answer is the honest one. Read-only: one LIST and no other command. Optional; a caller
   * treats absence as both null, the documented fallbacks.
   */
  findSpecialFolders?(): Promise<SpecialFolders>;
  watch(onSignal: () => void): Promise<() => Promise<void>>;
  /**
   * Re-establish what {@link watch} set up — INBOX selected, IDLE running — after other
   * operations moved the selection. The worker calls this at the end of every cycle visit;
   * without it the IDLE sits on whichever folder the last SELECT landed on and an INBOX arrival
   * emits nothing — a dead push channel that looks exactly like a slow one (measured: p50 194 s
   * arrival to mirror while watching). Optional; a backend without it relies on its own `watch`
   * semantics. A no-op before `watch` and after its unwatch.
   */
  rearmWatch?(): Promise<void>;
  send(msg: OutboundMessage): Promise<SendResult>;
  /**
   * Fetch a single MIME part's BLOB on-demand. Bytes are NEVER persisted.
   *
   * `opts.maxBytes` aborts the transfer mid-stream and POISONS THE CONNECTION — see
   * {@link FetchPartOptions.maxBytes}. Optional third parameter so existing fakes keep compiling.
   */
  fetchPart(locator: NativeLocator, partId: string | null, opts?: FetchPartOptions): Promise<FetchedPart>;
  /**
   * The whole RFC822 message, exactly as the server holds it. Read-only, never persisted. Its own
   * method because {@link fetchPart} is per-MIME-part; `download(uid, "")` reaches the right
   * branch only through an undocumented property of imapflow's internals. Never marks anything
   * read: imapflow emits `BODY.PEEK[]` for a source fetch, the only wire form it can produce. The
   * ceiling REFUSES — a short read is never returned; a message missing its tail biases a
   * sensitivity decision toward nothing-to-see-here. The connection survives: unlike {@link
   * FetchPartOptions.maxBytes}, this stops at a chunk boundary, safe on the worker's IDLE
   * connection. Optional; absence means the backend cannot re-read a message.
   */
  fetchRaw?(locator: NativeLocator, opts?: FetchRawOptions): Promise<Uint8Array>;
}
