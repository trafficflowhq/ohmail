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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  PASSIVE PRESENCE — the customer's OWN folders, read and never reorganized
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mail the customer filed themselves — `Archive`, `Private/Family`, `_archive/Clients/…`,
 * fifteen years of nested folders made in Apple Mail — was invisible to ohmail entirely: the only
 * folders ever enumerated were {@link WATCHED_FOLDERS} plus the resolved Sent folder, so a message
 * living anywhere else was in no `messages` row, in no thread, and in no search result. Measured on
 * a real mailbox whose server listed well over a hundred folders, of which seven were read.
 *
 * These folders are now ENUMERATED, INGESTED, SEARCHABLE and THREADED, and they are never
 * REORGANIZED. The distinction is enforced in three independent places rather than by intention:
 *
 *  1. {@link isOrganizedFolder} answers false, so no rule, no Screener decision, no AI proposal and
 *     no retro pass has them in its candidate set.
 *  2. `pipeline.ts#planChange` returns before `listRules`/`knownSenders` and before the classifier
 *     for a passive arrival — the same early return the Sent folder already has — so `desired` IS
 *     the arrival folder, the reconciler answers `none`, and no IMAP move is ever issued.
 *  3. the row is written `folder_state.last_set_by = 'external'`: a placement the USER made. Every
 *     pass that moves mail requires `'us'`.
 *
 * ── WHAT IS EXCLUDED, AND WHY EACH ONE ─────────────────────────────────────────────────────────
 *
 * `\Junk` / `\Trash` / `\Drafts` are excluded from READING on one shared argument: none of the
 * three holds mail the customer FILED. Junk is the provider's verdict, Trash is mail they deleted,
 * Drafts is mail they have not finished writing; putting any of it into their history and their
 * search results would be inventing a decision rather than reading one. The organizer therefore
 * never watches these folders and never acts there ON ITS OWN INITIATIVE — no rule, no retro pass,
 * no AI proposal and no reconcile may name them as a destination or enumerate them as a source.
 *
 * WRITING is governed by a narrower rule than it used to be (amended 2026-08-22, owner-ratified).
 * The old sentence — "never watched and never written to" — treated the write side as one case,
 * and it is two. A write on OUR initiative into somebody's Junk or Trash invents a decision,
 * exactly as reading one out would; that stays forbidden. A write that EXECUTES the user's own
 * explicit verdict is the opposite of inventing a decision — refusing it would mean overriding
 * the user in their own mailbox, which is the deeper rule this file exists to protect. Three
 * user-commanded writes are allowed, and only these:
 *
 *  1. A SPAM VERDICT (the screener's spam press, or the rule that press promoted) files the
 *     message to the provider's native `\Junk` folder — where their other clients and the
 *     provider's own filter expect spam to live — instead of parking it in `ohmail/Quarantine`.
 *  2. A NOT-JUNK RESCUE moves a message OUT of `\Junk`, back to INBOX. Same authorship: the user
 *     is reversing their own verdict (or the provider's), and both directions belong to them.
 *  3. A DELETE moves a message to the provider's native `\Trash`. NEVER an expunge: Trash is the
 *     provider's own undo surface, and leave-anytime means the mail stays recoverable by the
 *     user's other clients for as long as the provider keeps it.
 *
 * The destination is discovered per mailbox — SPECIAL-USE first, then the {@link JUNK_BY_NAME} /
 * {@link TRASH_BY_NAME} belts, never created (see {@link MailboxAdapter.findSpecialFolders}). A
 * mailbox with NO native `\Junk` keeps the prior behaviour byte-for-byte: the verdict files to
 * `ohmail/Quarantine` and the fallback is recorded under a closed code (`no_junk_folder`). A
 * mailbox with no `\Trash` refuses the delete the same way (`no_trash_folder`) — falling back to
 * an expunge is exactly the destructive write this rule forbids.
 *
 * The reading rule is unchanged by all of this, and one residual follows from it, stated rather
 * than hidden: a message we filed into `\Junk`/`\Trash` is in a folder we never enumerate, so a
 * later change made there by another client (a restore, a provider purge) is observed only when
 * its copy next appears in a folder we do watch — see `forgetInstanceAt`'s evidence rule for how
 * that re-appearance is adopted.
 *
 * `\All` and `\Flagged` (Gmail's *All Mail* and *Starred*) are excluded because they are VIRTUAL:
 * every message in the account appears in `\All` a second time, so ingesting it would double the
 * whole mailbox and give every message a second physical instance in a folder nobody filed it into.
 *
 * `\Sent` is excluded HERE because it is watched by its own path, with the UID watermark
 * {@link DEFAULT_SENT_HISTORY_MESSAGES} exists for. It is not less covered; it is covered already.
 *
 * The `ohmail` NAMESPACE is excluded whole — every path with an `ohmail` segment, which covers the
 * five organized folders, the unsubscribed `ohmail/_meta` lease, and the namespace-prefixed forms a
 * server with a personal prefix reports (`INBOX/ohmail/_meta` on a `.`-delimited server, measured).
 * A watched `_meta` would ingest the organizer lease's own bookkeeping as mail.
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
 * Sent-shaped CANONICAL paths — top level or under the INBOX prefix: the English resolver
 * family plus the localized German one the SPECIAL-USE resolver can surface. The single source
 * for two readers with two different stakes: the folders inventory (`packages/services/
 * src/folders.ts`) excludes these from the user-folder class, and the folder delete's
 * stale-residue cleanup (`drizzle-repo.ts#tombstoneFolderMessages`) must NEVER take a
 * Sent-folder instance row — Sent is scanned by UID WATERMARK, not enumerated end to end, so
 * after a UIDVALIDITY reset an old message's renumbered copy is never re-learned and a deleted
 * "stale" Sent row is the last evidence that copy exists.
 */
export const SENT_SHAPED_CANONICAL =
  /^(inbox\/)?(sent([ -](items|messages|mail))?|gesendet(e[ -](objekte|elemente|nachrichten))?)$/i;

/**
 * Leaf names that mean the provider's Junk folder on a server that names no SPECIAL-USE — the
 * WRITE-side belt for the three user-commanded writes (see the product rule above).
 *
 * The vocabulary is the junk subset of {@link PASSIVE_EXCLUDED_LEAF}, split out rather than
 * derived because the two belts fail in opposite directions and must be tuned separately: the
 * passive belt errs toward NOT READING (a false positive hides a customer folder), this one errs
 * toward NOT WRITING (a false positive would file the user's spam verdict into a folder that
 * merely happens to be named `Spam`, which is why the alternation here is narrower — no `bin`,
 * no `deleted`, nothing that could be a customer's own archive). A miss costs nothing destructive:
 * the verdict falls back to `ohmail/Quarantine` under the closed code.
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
 * How many of the customer's own folders one mailbox may have read — and it is TWO numbers, because
 * the cost this bounds is not the folder count.
 *
 * ── WHAT IS ACTUALLY EXPENSIVE ──────────────────────────────────────────────────────────────────
 *
 * A folder in the scan costs a SELECT per cycle, and the worker's cycle is SERIAL across every
 * mailbox on the shard — so an unbounded folder count is one customer's filing habit setting every
 * other customer's sync latency. A mailbox with a hundred-odd folders, most of them the customer's
 * own, is an ordinary shape rather than a pathological one.
 *
 * But with RFC 5819 LIST-STATUS the steady-state cost is not one SELECT per FOLDER — it is one LIST
 * for the whole mailbox plus a SELECT per folder that actually CHANGED (see
 * `ImapAdapter.unchangedPassive`). On a settled mailbox that is one command for all 126. So the
 * ceiling that matters there is far higher than the one that matters on a server which must be asked
 * folder by folder, and collapsing the two into one number prices every customer as though their
 * provider were the worst one.
 *
 * ── AND WHY THE LOWER NUMBER IS NOT THE SAFE DEFAULT ────────────────────────────────────────────
 *
 * A ceiling here is not a throttle, it is INVISIBLE MAIL: everything past it is in no `messages`
 * row, no thread and no search result, and the customer is told nothing. A ceiling low enough to
 * bite lands its cut-line alphabetically, which is to say arbitrarily — it takes half of one branch
 * of somebody's filing and leaves the other half. Choosing the conservative number "just in case"
 * is choosing to hide their mail to save round trips their provider does not charge for.
 *
 * Both production providers, measured, advertise LIST-STATUS.
 *
 * The residual is stated rather than hidden: past either ceiling the overflow is reported by
 * `ImapAdapter.passiveFolderReport()` and read by nothing. That is a bounded, nameable gap; an
 * unbounded per-cycle SELECT count is not.
 *
 * **The order is deterministic** — by path — so the SAME folders are read on every cycle and the
 * overflow set does not oscillate. Sorting by activity would need a STATUS per folder to compute,
 * which is exactly the cost the lower ceiling exists to bound.
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
 * The SNI name for a dial, or undefined when SNI must be omitted.
 *
 * RFC 6066 §3 forbids an IP literal in SNI, and both `imapflow@1.5.0` (`imap-flow.js:290`) and
 * `nodemailer@6.10.1` (`smtp-connection/index.js:61`) apply exactly this rule when deriving their
 * own default. It is PINNED here rather than inherited because the derivation lives inside two
 * dependencies' internals: a multi-vhost mail server presents its DEFAULT certificate to a dial
 * with no SNI, which then fails hostname validation — a refusal indistinguishable from a genuinely
 * wrong certificate, on a mailbox that every other client connects to fine. An explicit
 * `servername` on the assembled option set is the difference between "the library happens to do
 * this today" and a floor the guards can watch.
 */
export const sniServername = (host: string): string | undefined =>
  isIpLiteral(host) ? undefined : host;

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
   * THE CONSENT BRANCH — the ONE way authentication may cross an unencrypted socket, and it is
   * reachable only with `secure: false` AND an explicit `allowInsecure`, which every caller
   * derives from a stored per-mailbox consent marker written by the connect flow after the
   * PROBE PROVED the server offers no TLS at all (no implicit TLS, no STARTTLS) and the user
   * opted in over copy that says the password and all mail travel unencrypted.
   *
   * It does NOT abandon the upgrade: `doSTARTTLS` is simply absent, which is imapflow's
   * OPPORTUNISTIC mode — a consented server that later gains STARTTLS is upgraded on the next
   * dial, with {@link TLS_FLOOR} still validating the certificate it presents. So the consented
   * state heals toward encryption on its own and can never mask a working TLS deployment.
   * A `secure: true` config ignores the flag entirely: an implicit-TLS dial is already
   * encrypted from its first byte and there is nothing to consent away.
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
 * connections. Split out because the worker had been silently inheriting a
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
 * That is the crash cadence of the no-error-listener outage, and it is also why the small seeded
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
  /**
   * The Sent path the SCAN actually watches — `sentFolder` when SPECIAL-USE answered, otherwise
   * the name-fallback resolution (`findSentForScan`), which is memoised on the first
   * `changesSince`. OPTIONAL, for adapter fakes; consumers treat absence as `sentFolder`.
   *
   * A SEPARATE field rather than folding the fallback into `sentFolder`, because that field is
   * where the SEND path appends and a read must never redirect it (the adapter's own rule at
   * `scanSentFolder`). The reader that needs THIS one is the delete completion's Sent exclusion:
   * on a no-SPECIAL-USE server the watched Sent lives only in the fallback, and excluding
   * against `sentFolder` alone would leave exactly those providers open to the stale-Sent-row
   * retry wedge the exclusion closes.
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
 * How many messages one {@link MailboxAdapter.moveMany} call may carry.
 *
 * ── WHY THERE IS A CEILING AT ALL, WHEN A BIGGER ONE IS STRICTLY FASTER ────────────────────
 *
 * The destination pre-check is a single `OR HEADER MESSAGE-ID …` command holding one term per
 * member. At 50 that command is roughly 3 KB; at over a thousand — the size of a real screening
 * session measured against a production mailbox — it would be about 70 KB, and a server that caps the
 * command line refuses it. That failure would appear ONLY on large backlogs, which is precisely
 * the case the batched path exists for, so the ceiling is the difference between a fast path and
 * a fast path that breaks when it matters. The `UID MOVE` set has the same shape and the same
 * ceiling covers it.
 *
 * 50 is not a tuned number and does not need to be: the cost is ~5 commands per CHUNK, so at 50
 * the per-message cost is already 0.1 commands and doubling the chunk halves a number that has
 * stopped mattering. It is chosen to keep both commands comfortably small on the least
 * accommodating server rather than to squeeze the last round trip out of the most capable one.
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
   * the entire kill mechanism of the no-error-listener outage: a `try/catch` around the slow code
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
  /**
   * UIDs this pass ASKED THE SERVER FOR AND DID NOT GET BACK — and the caller owes each one a
   * durable failure row BEFORE it writes the folder cursor.
   *
   * RFC 3501 lets a `UID FETCH` return fewer messages than the UID set names, with no error and no
   * per-UID signal, so "the message did not arrive" is indistinguishable from "the message does not
   * exist" at the protocol level. The adapter cannot tell the difference either; what it CAN do is
   * refuse to be silent about it, which is what this field is.
   *
   * The cursor for such a folder is published ADVANCED, exactly as it is for a message that was
   * fetched and then failed to parse. That is safe for the same reason and only for the same
   * reason: `message_failures` holds the UID, `buildCursor` merges it into the known-set, and the
   * targeted retry re-reads it by UID on a schedule and on every deploy. A caller that ignores this
   * field instead publishes a watermark over mail nothing will ever enumerate again — see
   * `sync.ts`, which records these and DEFERS the folder's cursor when the record cannot be written.
   *
   * Empty on almost every cycle. It is populated by servers that cannot serialize some field of a
   * particular message (measured: iCloud omits the row for a quoted-string `Message-ID` when
   * ENVELOPE is requested), which is why `fetchCapped` first re-asks without the field it suspects
   * before giving up on the UID — most of what would land here is recovered instead.
   *
   * Optional so every existing fake adapter keeps compiling; absent ⇒ nothing was withheld.
   */
  unanswered?: ReadonlyArray<{ folder: string; uidValidity: string; uid: number }>;
  /**
   * UIDs whose RFC822.SIZE already exceeds the hard MIME ceiling (`MAX_RAW_MESSAGE_BYTES`), so
   * their body was DELIBERATELY NEVER FETCHED — and the caller owes each one a durable
   * `mime_too_large` row BEFORE it writes the folder cursor, exactly as it does for
   * {@link unanswered}.
   *
   * The anti-stall rule in `fetchCapped` admits the first candidate past the BATCH byte budget so
   * one large mail cannot wedge the drain — but a message past the MIME ceiling is refused by
   * `normalizeMime` deterministically AFTER the download, so admitting it buys a full-source
   * transfer (measured shape: 100+ MiB into one Buffer) whose only possible outcome was already
   * known from the size the metadata fetch had in hand. That transfer can monopolize the
   * connection or take the process past its memory budget before the failure ledger ever hears
   * about the message. So the ceiling is enforced from RFC822.SIZE, pre-fetch, and the outcome is
   * the SAME durable row the post-download rejection would have written — the targeted retry then
   * probes it by size once per deployed build, never re-downloading it.
   *
   * Optional so every existing fake adapter keeps compiling; absent ⇒ nothing was refused on size.
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
   * Extra RFC 5322 header fields, written onto BOTH the delivered message and the Sent-folder copy
   * (one `Mail.Options` builds both — see `outboundToMail`).
   *
   * It exists for ONE caller and one header: an automatic reply must carry
   * `Auto-Submitted: auto-replied` (RFC 3834 §5), which is what stops another mail system's
   * responder answering ours and the two of them filling a mailbox each. A hand-composed send
   * never sets this — `SendService` does not pass it — so there is no path by which a message a
   * person typed acquires an automation marker.
   *
   * Names are passed through to nodemailer's `headers` verbatim and may NOT restate a field this
   * seam already owns (`From`/`To`/`Cc`/`Bcc`/`Subject`/`Message-ID`/`In-Reply-To`/`References`):
   * MailComposer would emit the field twice, and a duplicated `Message-ID` breaks the
   * verify-by-Sent probe the crash-safe send path depends on. The away responder's own test suite
   * asserts the single header it passes, so the restriction above is a rule about this seam rather
   * than a hope about its callers.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * FILES TO SEND — and the whole reason ohmail can attach without storing a byte.
   *
   * `outboundToMail` maps these straight onto nodemailer's own `attachments`, so the ONE compiled
   * message drives BOTH the SMTP delivery AND the raw bytes appended to the Sent folder
   * (`imap.ts#send` → `buildRaw`). The bytes therefore exist only in this in-memory object for the
   * life of the send: they arrive in the send request, ride here, and are gone when the request
   * returns — never a row in `attachments`, `drafts` or anywhere else (§13.2/§14). Two halves of that
   * are guarded separately: that one compiled message carries the file into both the delivery and
   * the Sent-folder copy, and that no row anywhere holds a byte of it. The citation that used to
   * stand here named a test file that was never added on any branch, which reads as coverage and is
   * not. Two producers fill it: the compose form's
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
export interface SendResult {
  providerMessageId: string;
  sentLocator: NativeLocator;
  /**
   * THE EXACT BYTES THAT WERE APPENDED TO THE SENT FOLDER — `MailComposer`'s output, the same
   * Buffer handed to `client.append`, carried out rather than dropped on the floor.
   *
   * It exists for ONE consumer and the reason is an identity rule, not a convenience:
   * `identity.ts#messageFingerprint` derives a message's identity from its CONTENT, computed by
   * `normalizeMime` over the raw source. So a caller that wants to record this send as a
   * `messages` row before the mailbox is re-read (`sent-record.ts#recordSentMessage`) must
   * fingerprint THESE bytes. Rebuilding an equivalent message from the `OutboundMessage` instead
   * drifts by a byte — a boundary string, a header fold, a transfer encoding — which is a
   * different fingerprint, which is a SECOND `messages` row the first time the Sent copy is
   * observed, in every client, permanently, with no delta that removes either.
   *
   * Not optional, deliberately: an adapter that appends and cannot say what it appended has no
   * business on this seam, and a `raw?` would let a future adapter opt out of the rule silently.
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
  capabilities(): Promise<ImapCapabilities>;
  ensureFolders(): Promise<void>;
  changesSince(cursor: ImapCursor): Promise<ChangeBatch>;
  move(locator: NativeLocator, toFolder: string): Promise<NativeLocator>;
  /**
   * File a GROUP of messages that share a source folder and a destination, in a handful of round
   * trips instead of a handful PER MESSAGE.
   *
   * ── WHAT THE CALLER IS PROMISED, STATED AS AN EQUIVALENCE ─────────────────────────────────
   *
   * When `batched` is true, the server's folders end up in the state calling {@link move} once
   * per member would have produced, and `moved` names where each one landed. When `batched` is
   * false, **NOTHING WAS WRITTEN** and the caller must fall back to {@link move} for every member
   * of the group — the implementation refuses whenever it cannot prove the equivalence, and it
   * always refuses before it writes. There is deliberately no third answer: a partial batch would
   * make the caller reason about which half it still owes, which is the bookkeeping this method
   * exists to remove.
   *
   * `gone` carries the members whose UID the source folder no longer holds — the batch's form of
   * {@link MessageGoneError}, reported rather than thrown so one vanished message does not cost
   * the rest of the group. The caller leaves those rows pending exactly as it does for the throw,
   * and `changesSince` adopts whatever really happened to them.
   *
   * The group must not exceed {@link FILING_BATCH_MAX}; the caller chunks. A source folder equal
   * to the destination, or a group spanning two source folders, is a caller bug and throws.
   *
   * OPTIONAL on the interface, on `scanSentRecipients`' rule: a backend that does not implement it
   * simply never gets the fast path, and every fake adapter keeps compiling.
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
  /** IMAP CREATE. Idempotent: "already exists" is the asked-for state. */
  createFolder?(canonical: string): Promise<void>;
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
  /**
   * Resolve the provider's native `\Junk` and `\Trash` folders for the three user-commanded
   * writes — see the product rule above {@link PASSIVE_EXCLUDED_SPECIAL_USE}.
   *
   * SPECIAL-USE first, then the {@link JUNK_BY_NAME}/{@link TRASH_BY_NAME} belts on the canonical
   * leaf, `\Noselect` and the `ohmail` namespace excluded, and NOTHING IS EVER CREATED — see
   * {@link SpecialFolders} for why a null answer is the honest one. Read-only: one LIST and no
   * other command.
   *
   * OPTIONAL on the interface, on {@link scanSentRecipients}' rule: every existing fake adapter
   * keeps compiling, and a caller treats its absence as "both null" — the documented fallbacks.
   */
  findSpecialFolders?(): Promise<SpecialFolders>;
  watch(onSignal: () => void): Promise<() => Promise<void>>;
  /**
   * Re-establish what {@link watch} set up — INBOX selected, IDLE running — after other
   * operations on the same connection moved the selection elsewhere. The worker calls this at
   * the end of every cycle visit; without it the IDLE sits on whichever folder the visit's last
   * `SELECT` landed on and an INBOX arrival emits nothing, which is a dead push channel that
   * looks exactly like a slow one (measured: p50 194 s arrival→mirror while "watching").
   *
   * OPTIONAL on the interface, on {@link scanSentRecipients}' rule: every existing fake adapter
   * keeps compiling, and a backend without it simply relies on its own `watch` semantics.
   * A no-op before `watch` and after its unwatch.
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
