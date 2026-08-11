import { randomUUID } from "node:crypto";
import { ImapFlow, type ImapFlowOptions, type ListResponse, type MailboxObject } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
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
  imapTlsFloor, smtpTlsFloor,
  type ImapConfig, type ImapAdapterOpts, type ImapCapabilities, type MailboxAdapter,
  type ImapCursor, type ChangeBatch, type PersistedFolderCursor, type KnownEntry,
  type OutboundMessage, type SendResult, type FetchedPart, type FetchPartOptions,
  type FetchRawOptions, type NetTimeouts, type FetchByUidOptions, type TargetedFetch,
  type ImapAuth, type ImapOAuthAuth, type ResolvedImapAuth,
  FILING_BATCH_MAX, type MoveManyResult,
} from "./imap-types.js";
import {
  makeLeaseIo, makeLeasePeekIo,
  type LeaseImapClient, type LeaseIo, type LeasePeekIo,
} from "./organizer-lease.js";

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
 * Dial an SMTP submission endpoint and AUTHENTICATE, without sending anything — the connect-time
 * proof the SMTP probe needs, kept here because this package owns nodemailer and the TLS floor.
 * `verify()` runs the full sequence (connect, EHLO, mandatory STARTTLS where `secure` is false,
 * AUTH) against the complete option set from {@link smtpTransportOptions}, so what it proves is
 * byte-identical to what a later send will do. Resolves on a completed login; throws nodemailer's
 * error otherwise. The caller classifies; nothing here logs — the config carries a password.
 */
export async function verifySmtpLogin(
  smtp: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } },
  timeouts?: Partial<NetTimeouts>,
): Promise<void> {
  const transporter = nodemailer.createTransport(smtpTransportOptions({
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: { user: smtp.auth.user, pass: smtp.auth.pass },
    smtp,
    ...(timeouts ? { timeouts } : {}),
  }));
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
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
 * them was ever visible before 2026-08-04.
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

interface InternalCreate { folder: string; uidValidity: bigint; uid: number; raw: Buffer; seen: boolean; messageId: string | null; }
interface InternalDelete { folder: string; uidValidity: bigint; uid: number; messageId: string | null; }

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
   * ── `error`: THE 2026-08-02 OUTAGE ──────────────────────────────────────────────────────
   *
   * `ImapFlow` is an EventEmitter, and Node throws when `error` is emitted with no listener —
   * an uncaught exception, which the worker's entrypoint answers with `exit(1)`. On
   * 2026-08-02 that turned one mailbox's socket timeout into eight minutes with the whole
   * shard dead and the platform restarting the container every ~26 s. Nothing in the call stack
   * could have caught it: the emit happens on a timer, not inside an `await`.
   *
   * So this is attached UNCONDITIONALLY — not only when a caller supplies
   * {@link ImapAdapterOpts.onConnectionError} — because the property being defended is "this
   * process stays alive", and that must not be contingent on a construction option somebody
   * remembered to pass. The optional callback is only how the OWNER of the connection gets
   * told, so it can detach and quarantine one mailbox instead of losing all of them.
   *
   * ── `close`: THE 2026-08-04 OUTAGE, AND WHY `error` ALONE WAS NEVER ENOUGH ───────────────
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
    };
    return { ...base, ...this.opts.capabilityOverrides };
  }

  async ensureFolders(): Promise<void> {
    const list = await this.client.list();
    const existing = new Set(list.map((f) => f.path));
    this.sentFolder = this.findSent(list);
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
   * goes through this function, because the alternative — one unbounded fetch — is what
   * killed production on 2026-08-01 (see {@link DEFAULT_SYNC_BATCH_MAX_MESSAGES}).
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
  ): Promise<{ fetched: InternalCreate[]; truncated: boolean }> {
    const fetched: InternalCreate[] = [];
    if (uids.length === 0) return { fetched, truncated: false };

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
    if (take.length === 0) return { fetched, truncated };

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
    fetched.sort((a, b) => (dates.get(b.uid) ?? 0) - (dates.get(a.uid) ?? 0) || b.uid - a.uid);
    return { fetched, truncated };
  }

  /**
   * The folders ONE `changesSince` pass reads: the frozen six, plus the mailbox's own Sent
   * folder when the server has one.
   *
   * `sent` is null on a server with no Sent folder at all, and is dropped when it collides with
   * a watched folder — a mailbox whose Sent path somehow resolved to `INBOX` must be read once,
   * not twice, and must not have its INBOX creates tagged as own-authored.
   */
  private async foldersToScan(): Promise<{ folders: string[]; sent: string | null }> {
    const resolved = await this.findSentForScan();
    const watched = new Set<string>(WATCHED_FOLDERS);
    const sent = resolved && !watched.has(resolved) ? resolved : null;
    return { folders: sent ? [...WATCHED_FOLDERS, sent] : [...WATCHED_FOLDERS], sent };
  }

  async changesSince(cursor: ImapCursor): Promise<ChangeBatch> {
    const caps = await this.capabilities();
    const { folders: scanFolders, sent: sentFolder } = await this.foldersToScan();
    const sentHistory = this.opts.sentHistoryMessages ?? DEFAULT_SENT_HISTORY_MESSAGES;
    const creates: InternalCreate[] = [];
    const flagChanges: Change[] = [];
    const deletes: InternalDelete[] = [];
    const newFolders: Record<string, PersistedFolderCursor> = {};
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
      // …and FLAGS, which had no budget at all until 2026-08-02. See
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
      const serverPath = this.toServerPath(folder);
      const prev = cursor.folders[folder];
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
        const { fetched, truncated } = await this.fetchCapped(unknownUids, folder, curUidValidity, budget);
        creates.push(...fetched);
        budget.messages -= fetched.length;
        for (const f of fetched) budget.bytes -= f.raw.length;
        if (truncated) hasBacklog = true;

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
          // folder ahead cannot eat the budget for ever". A folder ahead with 5 101 owed UIDs eats
          // it for sixteen consecutive cycles, which is long enough to look exactly like for ever;
          // measured on a real mailbox four days after this line was written. Progress is now
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
            // The fallback's whole filter: agreement with the baseline is not a change, and a
            // baseline the repo could not state (`seen` null/absent — a dead-lettered UID) is
            // never diffed. Free to step over for the resume point exactly like an unknown UID:
            // an agreement examined is an agreement answered. The fast path takes no part —
            // CONDSTORE already said these rows changed, and its cursor semantics own them.
            if (!canFastPath && (known.seen == null || known.seen === seen)) {
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
        ...(sentFolder !== null && c.folder === sentFolder ? { ownAuthored: true } : {}),
      })),
      moves: correlated.moves,
      flagChanges,
      deletes: correlated.deletes.map((d): Change => ({ type: "delete", locator: { folder: d.folder, ref: makeRef(d.uidValidity, d.uid) } })),
      newCursor: { folders: newFolders },
      hasBacklog,
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
    // is not re-entrant.
    const { sent } = await this.foldersToScan();
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
            // The SAME stamp `changesSince` applies, from the same resolution. Omitting it would
            // route a retried Sent message through `new` instead of `own_copy` and file the user's
            // own reply as an inbound message.
            ...(sent !== null && folder === sent ? { ownAuthored: true } : {}),
          });
        }
      }
      // A UID in `take` that the body fetch did not answer for was expunged between the two
      // commands. It belongs in `absent` with the rest, which the subtraction below handles.
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

    // Step 1: under the SOURCE lock — probe existence and capture identity. NOTHING is written
    // here any more; the decision to write comes after the destination has been read.
    {
      const lock = await this.client.getMailboxLock(srcPath);
      try {
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
      // Step 3: nothing of ours at the destination, so write. Under the SOURCE lock again.
      const lock = await this.client.getMailboxLock(srcPath);
      try {
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
   * Measured 2026-08-04 against GreenMail 2.1.3 (`IDLE IMAP4rev1 LITERAL+ MOVE QUOTA SORT
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

    return { providerMessageId: messageId, sentLocator };
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
