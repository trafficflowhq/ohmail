import {
  planChange, commitChange, MAX_RAW_MESSAGE_BYTES,
  type Change, type ClassifierPort, type CreditGate, type Logger, type OhboxPolicy,
} from "@trafficflow/core/mail";
import {
  WATCHED_FOLDERS, MessageGoneError, parseRef, FILING_BATCH_MAX,
  type ImapCursor, type MailboxAdapter, type PersistedFolderCursor,
} from "@trafficflow/core/adapters/imap";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import type { WorkerRepo, DrizzleRepo, PendingFolderState } from "@trafficflow/core/adapters/drizzle-repo";
import { ClassifierFaultError } from "./classifier-fault.js";
import {
  DeadLetterLedger, classifyIngestFault, nextAttemptAfter,
  MAX_MESSAGE_RETRIES_PER_CYCLE,
} from "./dead-letter.js";
// `./build-version.js` and NOT `./config.js`, which re-exports the same symbol: `config.ts` imports
// the bare `@trafficflow/core` barrel, and `apps/sidecar` imports THIS file as
// `@trafficflow/worker/sync`. Naming config here would put the classifier and the drafter into the
// shipped desktop engine's import closure from three modules away.
import { buildVersionOf } from "./build-version.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE LEADER FENCE OVER MAIL-BEARING WRITES
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One process at a time organizes a mailbox, and the hosted worker holds that role per shard
 * under an advisory-lock lease. A lease can end mid-cycle — the lock's session drops, a standby
 * takes the shard over — and the loser does not learn about it synchronously. Until this seam
 * existed only the mailbox LIFECYCLE columns were fenced against that: a worker that had already
 * lost its shard kept committing messages, advancing folder cursors, appending `change_log` rows
 * and issuing IMAP moves for the rest of its cycle, beside a new leader doing the same work. Two
 * organizers writing one mailbox is exactly what every lease in this product exists to prevent —
 * and the existence of a fence for the lifecycle writes made it easy to believe these were
 * covered. They were not.
 *
 * `SyncDeps.fence` is the seam. ABSENT ⇒ unfenced, byte-identically the behaviour before the
 * seam existed: the standalone desktop engine imports this loop and its single process has no
 * shard to lose (its organizer boundary is the mailbox-side lease), and the reconcile cron runs
 * only while no worker leads. The hosted worker passes a fence built over its durable
 * leadership record — the same one its mailbox lifecycle writes are already fenced on.
 *
 * Three rules, each load-bearing:
 *
 *  · EVERY database write in this module rides `fencedWrite`/`fencedIngest`, which refuse —
 *    writing NOTHING — once the heartbeat row stops naming this instance as the leader. The
 *    refusal must be answered from a FRESH snapshot even when the write had to wait on a row
 *    lock (under READ COMMITTED, a statement that blocks is otherwise answered with the
 *    leadership it began with — the fence would fail open in exactly the handover it exists
 *    for). The fence implementation owns that: it claims the mailbox row first, absorbing the
 *    wait, and only then verifies leadership. That is why the fence is transaction-shaped
 *    rather than a boolean checked before the write.
 *  · EVERY IMAP mutation is preceded by `fenceImapMutation`. An IMAP command cannot ride a
 *    database transaction, so this is a fresh check rather than a guarantee — a mutation the
 *    check admits can still land after a takeover that commits in the same instant. That
 *    residual CONVERGES: a move that landed on the server whose database write was then fenced
 *    out is byte-identical to a crash between the move and the write, which `changesSince`
 *    already adopts on the next leader's cycle.
 *  · `lost()` is the SYNCHRONOUS tripwire. The worker flips it the moment it observes losing
 *    the lock, so an in-flight cycle stops at its next write site instead of running out its
 *    batch — without it, the teardown queued behind this cycle would wait on work the process
 *    has no authority to finish.
 *
 * A refused write surfaces as {@link LeaderFencedError} and deliberately aborts the WHOLE
 * cycle: the fence keys on the shard, not the mailbox, so one refusal means every later write
 * would be refused too — and the caller treats it as what it is, proof of lost leadership,
 * never as evidence against the mailbox or the message.
 */
export class LeaderFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaderFencedError";
  }
}

/** See the block above. Implemented by the hosted worker; absent everywhere else. */
export interface SyncWriteFence {
  /** TRUE once this process has observed losing its lease — synchronous, checked before work. */
  lost(): boolean;
  /** A fresh read of the leadership record, for mutations that cannot ride a transaction (IMAP). */
  stillLeader(): Promise<boolean>;
  /**
   * Run one write group inside a transaction that has verified — AFTER absorbing any lock
   * wait — that this process still leads its shard. `fenced` ⇒ nothing was written.
   */
  transaction<T>(fn: (repo: DrizzleRepo) => Promise<T>): Promise<{ fenced: true } | { fenced: false; result: T }>;
}

export interface SyncDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** Optional AI classifier (design §5.3). Absent ⇒ Phase-0 routing (no AI branch). */
  classifier?: ClassifierPort;
  /**
   * The AI spend gate for THIS mailbox's account. Absent ⇒ unmetered.
   *
   * It is per-account and built by the worker's entry point from the MAILBOX ROW's `accountId`,
   * never from config: one worker process serves many accounts, and a gate bound to the wrong
   * one would charge the wrong customer.
   */
  credits?: CreditGate;
  /**
   * The authserv-ids this MAILBOX's own provider signs `Authentication-Results` with —
   * `providerAuthservIds(<the IMAP host this connection dials>)`, resolved where the adapter is
   * built and threaded into `planChange`.
   *
   * REQUIRED, deliberately, unlike every optional field around it — because for this one the
   * absent-config default IS the dangerous branch. An empty set makes `authVerdictFromHeaders`
   * answer `"unavailable"` for every message, the demote-only branch never fires, and a forged
   * known-contact `From` inherits that contact's Ohbox admission. Optional-with-a-default is how
   * all five production sites shipped inert; a required field makes the composition root that
   * forgets it a compile error instead. A caller that has genuinely decided to trust nothing
   * (a test, an unknown provider) types `NO_TRUSTED_AUTHSERV_IDS` — the same "somebody has to
   * type the empty set" rule `UnsubscribeDeps` established.
   */
  trustedAuthservIds: ReadonlySet<string>;
  /**
   * The account's Ohbox posture, resolved from `account_settings.ohbox_policy` and threaded into
   * `planChange`. ABSENT ⇒ `planChange` resolves it to the lenient `DEFAULT_OHBOX_POLICY`, so a
   * caller that does not set it (a reconcile/restart pass, a test) routes byte-identically to before
   * this field existed. The main sync loop resolves it per account and passes it; see
   * `index.ts#screeningFor`.
   */
  ohboxPolicy?: OhboxPolicy;
  /** The account's free-text Ohbox bar, resolved from `account_settings.ohbox_bar`, into the
   * classifier's user turn only. Absent ⇒ omitted. */
  ohboxBar?: string;
  /**
   * The screening cutoff, resolved from `account_settings.screening_baseline_at` and
   * `dormancy_days` and threaded into `planChange`. Mail that arrived before it keeps its arrival
   * folder instead of being held at the consent gate — see `core/src/pipeline.ts#PlanDeps`.
   *
   * ABSENT ⇒ no cutoff ⇒ `planChange` routes byte-identically to before mail 0056, which is what a
   * NULL baseline, a failed settings read, a reconcile/restart pass and every test all produce.
   * The main sync loop resolves it per account; see `index.ts#screeningFor`.
   */
  screeningCutoff?: Date;
  /**
   * The per-message terminal-failure ledger, one per attached mailbox.
   *
   * ABSENT ⇒ ONE PER CALL, not "no boundary". `apps/sidecar` imports this loop — the desktop
   * engine and the hosted worker run one pipeline, never two implementations — and several tests
   * call `runSyncCycle` directly; a boundary that only existed when a caller remembered to inject
   * a ledger would leave the wedge in place for every one of them. What a caller-supplied ledger
   * adds is MEMORY ACROSS CYCLES: attempt
   * counts that accumulate, and skipped UIDs that stay out of the known-set so their bodies are
   * not re-fetched every pass. See {@link DeadLetterLedger}.
   */
  deadLetters?: DeadLetterLedger;
  /**
   * WHICH BUILD is running — the second arm of the durable ledger's due predicate.
   *
   * Absent ⇒ resolved from the environment by {@link buildVersionOf}, the same three sources
   * `/health` publishes. NOT a required field and NOT plumbed from the composition root,
   * deliberately: a version that only arrived when a caller remembered to pass it would leave the
   * retry silently disarmed for `reconcile-cron.ts`, for `apps/sidecar`, and for every test — and
   * "the absent config selects the dangerous branch" is the trap this repository keeps paying for.
   * Present only as a test seam, so a suite can simulate a deploy without touching `process.env`.
   */
  buildVersion?: string;
  /**
   * The leader fence over this mailbox's mail-bearing writes — see {@link SyncWriteFence}.
   *
   * ABSENT ⇒ unfenced, deliberately: the standalone desktop engine and the reconcile cron have
   * no shard leadership to lose, and every unfenced write runs byte-identically to before this
   * seam existed. The hosted worker is the one caller that passes it.
   */
  fence?: SyncWriteFence;
  /** Structured log sink. Absent ⇒ a skip is still recorded in `audit_log`, just not logged. */
  log?: Logger;
}

/**
 * Reconstruct the adapter cursor from the DB each cycle (never reuse an in-memory UID across a
 * move).
 *
 * ── THE FOLDER LIST IS THE UNION, NOT `WATCHED_FOLDERS` ────────────────────────────────────
 *
 * The adapter also reads the mailbox's own Sent folder, whose path is server-specific and
 * therefore cannot be a compile-time constant. `changesSince` persists a cursor row for it like
 * any other folder — and if this function only ever rebuilt the six frozen names, that row would
 * be written every cycle and read by none of them. The consequence is not cosmetic: with no
 * `prev`, the Sent branch falls back to its FIRST-SCAN path every single cycle, re-enumerating
 * (and, for anything the `own_copy` rule declines to store, re-FETCHING the body of) the whole
 * history window for the life of the process.
 *
 * Unioning with the persisted rows also means a folder the product stops watching keeps its
 * cursor rather than silently resetting if it is ever watched again.
 *
 * ── THE KNOWN-SET IS EPOCH-PURE, AND THE CURSOR NAMES AN EPOCH ─────────────────────────────
 *
 * A UID number means nothing outside the server epoch that issued it, and this function used to
 * reduce every locator to `{uid, messageId}` — discarding the epoch each one carries. Two
 * independent failures came out of that, and neither needs a race or a Postgres quirk:
 *
 *  1. A locator committed under an epoch V, presented inside a known-set the adapter reads as a
 *     later epoch V′, makes a V′ message whose server REUSED that UID number look already-known.
 *     Its body is never fetched, and once the enumeration drains, the V′ cursor is persisted past
 *     it. Permanent, silent, and likely — a new epoch commonly allocates again from low numbers.
 *  2. The sentinel `uidValidity: "0"` that a cold or truncated drain deliberately persists cannot
 *     express an epoch mismatch AT ALL, so the adapter's `uidValidityChanged` test is blind for
 *     the whole of that drain. When the row is the sentinel the epoch is therefore taken from the
 *     LOCATORS, which do carry one.
 *
 * So: the cursor's `uidValidity` is the epoch this folder's remembered UIDs actually belong to,
 * and only the entries of that epoch are handed over. Entries of any other epoch are dropped —
 * the safe direction, because a dropped entry is re-enumerated and re-fetched, while a wrongly
 * kept one silences real mail.
 */
export async function buildCursor(
  repo: WorkerRepo, mailboxId: string, deadLetters?: DeadLetterLedger,
): Promise<ImapCursor> {
  const folderRows = await repo.getMailboxFolders(mailboxId);
  const known = await repo.listKnownLocators(mailboxId);
  const knownByFolder = new Map<string, Array<{ uid: number; uidValidity: string; messageId: string | null; seen: boolean | null }>>();
  for (const k of known) {
    const arr = knownByFolder.get(k.folder) ?? [];
    arr.push({ uid: k.uid, uidValidity: k.uidValidity, messageId: k.messageId, seen: k.seen });
    knownByFolder.set(k.folder, arr);
  }
  const names = new Set<string>(WATCHED_FOLDERS);
  for (const r of folderRows) names.add(r.folder);
  const folders: ImapCursor["folders"] = {};
  for (const f of names) {
    const row = folderRows.find((r) => r.folder === f);
    const entries = knownByFolder.get(f) ?? [];
    const rowEpoch = row?.uidValidity ?? "0";
    const epoch = rowEpoch !== "0" ? rowEpoch : soleEpochOf(entries);
    folders[f] = {
      uidValidity: epoch,
      uidNext: row?.uidNext ?? 0,
      highestModseq: row?.highestModseq ?? "0",
      // `epoch === "0"` means no epoch can be named for this folder, so NOTHING remembered may be
      // presented as known — the adapter would read a bare number as belonging to whatever epoch
      // it is looking at.
      known: epoch === "0" ? [] : [
        // `seen` rides along as the flag baseline the no-CONDSTORE fallback diffs against
        // (`KnownEntry.seen`). Dead-letter entries below carry none, which is correct: nothing
        // was ever ingested for them, so no baseline can be stated and none may be diffed.
        ...entries.filter((e) => e.uidValidity === epoch).map((e) => ({ uid: e.uid, messageId: e.messageId, seen: e.seen })),
        // The UIDs this process has written off. They are "known" in the only sense the adapter
        // uses the word — do not fetch this again — and leaving them out is what made one poison
        // message cost a full body fetch on every cycle for ever. Epoch-matched for the same
        // reason the real locators are. See `DeadLetterLedger`.
        ...(deadLetters?.knownFor(f, epoch) ?? []),
      ],
    };
  }
  return { folders };
}

/**
 * The one epoch every remembered locator of a folder agrees on, or `"0"` when there is no such
 * epoch.
 *
 * `"0"` for "none" and for "several" alike, because both mean the same thing to the caller: this
 * folder cannot name an epoch, so no remembered UID may be trusted. "Several" arises in exactly one
 * window — a reset that landed between a truncated drain's per-message commits and its cursor
 * write — and it costs one pass of re-enumeration, because `runSyncCycle` then persists the epoch
 * it observed and the next pass can name it.
 */
function soleEpochOf(entries: ReadonlyArray<{ uidValidity: string }>): string {
  let sole = "";
  for (const e of entries) {
    if (e.uidValidity === "0") return "0";
    if (sole === "") sole = e.uidValidity;
    else if (sole !== e.uidValidity) return "0";
  }
  return sole === "" ? "0" : sole;
}

/** The folder + epoch a change was observed at. */
function siteOf(ch: Change): { folder: string; uidValidity: string; uid: number } {
  const { uidValidity, uid } = parseRef(ch.locator.ref);
  return { folder: ch.locator.folder, uidValidity, uid };
}

type FenceScope = Pick<SyncDeps, "repo" | "fence">;

/**
 * Route one bare write through the fence when there is one; unfenced callers run it directly on
 * the repo — no transaction wrapper, so their statement shape is exactly what it always was.
 */
async function fencedWrite<T>(deps: FenceScope, fn: (repo: WorkerRepo) => Promise<T>): Promise<T> {
  if (!deps.fence) return fn(deps.repo);
  return underFence(deps.fence, fn);
}

/**
 * `repo.transaction`, fenced: the ingest and flag transactions run INSIDE the fence's own
 * transaction, so the leadership verdict and the writes it authorizes commit or vanish together.
 */
async function fencedIngest<T>(deps: FenceScope, fn: (repo: DrizzleRepo) => Promise<T>): Promise<T> {
  if (!deps.fence) return deps.repo.transaction(fn);
  return underFence(deps.fence, fn);
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A GROUP OF WRITES THAT MUST NOT TEAR — TRANSACTIONAL WHETHER OR NOT THERE IS A FENCE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * {@link fencedWrite} routes ONE statement. It is deliberately not transactional when there is no
 * fence, and for a single statement that is exactly right — a `BEGIN`/`COMMIT` round trip around
 * an UPDATE buys nothing.
 *
 * The bookkeeping that follows an IMAP mutation is not one statement. Filing a message writes the
 * new locator (itself two statements: `messages.native_locator` and the primary
 * `message_instances` row), then the converged `folder_state`, then the audit row. Under a fence
 * those already committed together, because `SyncWriteFence.transaction` is a transaction. WITHOUT
 * one — the reconcile cron, and the desktop engine, which is every LOCAL install of this product —
 * they were three top-level awaits, and a crash or a failed statement between any two of them left
 * a state that is neither before nor after:
 *
 *   · locator written, `folder_state` not ⇒ the row still says `observed = <source>`, `pending`,
 *     while `native_locator` already names the DESTINATION. The next pass reads that row and asks
 *     the server to move a message from the folder it is already in. A host that refuses a
 *     same-folder MOVE turns this into a permanently stuck row — exactly the shape the deferral
 *     below exists to contain — and a host that accepts it churns the UID for nothing.
 *   · `folder_state` written, audit row not ⇒ the mail moved and the account's history does not
 *     say so. The inverse the admin surface offers to undo the move is the audit row's `inverse`;
 *     no row, no undo, and nothing anywhere records that the message ever left.
 *
 * Neither is visible afterwards. Both halves are individually valid rows, so nothing fails, no
 * constraint fires and the mailbox reports healthy — which is why this is proven by killing the
 * process between the statements against real Postgres (`reconcile-atomicity.pg.test.ts`) and not
 * by reading the code.
 *
 * So a group commits or it does not exist. Unfenced callers get `repo.transaction`; fenced callers
 * get the fence's transaction, which is the same guarantee with the leadership verdict inside it.
 * That makes this byte-identical to {@link fencedIngest} — deliberately, because it is the same
 * requirement — and it is a separate name because the two are separate contracts: one is "the
 * ingest transaction", this one is "these reconcile writes are one fact". A future change to the
 * ingest transaction must not silently retype the reconciler's.
 *
 * **The IMAP mutation is NEVER inside the callback.** A network call in a transaction holds a row
 * lock for the length of somebody else's server, and — the reason that actually matters here — the
 * move cannot be rolled back by the database anyway. Which is the next paragraph.
 *
 * ── WHICH SIDE LEADS, AND WHY THE RE-RUN CONVERGES ──────────────────────────────────────────
 *
 * IMAP leads; the database records what was observed. That is not a preference — the mailbox on
 * the user's own mail server is the master copy of their mail, and everything stored here is a
 * record of what was seen there, which is what makes leaving this product at any time cost the
 * user nothing. It decides the shape of the one seam a transaction cannot
 * cover: between the server's `MOVE` and the group below. A crash there leaves the mail moved on
 * the server and NOTHING written here, which is the direction that converges, because the source
 * copy is gone and the destination copy is enumerated by the next `changesSince`: the pending row
 * survives, the per-message retry raises {@link MessageGoneError}, and adoption rewrites
 * `folder_state` from what the server actually shows. The mailbox teaches us; we never teach it.
 *
 * The opposite order — write the database, then move — would produce the failure this product
 * cannot have: a message the client shows in a folder it is not in, with no event coming to
 * correct it, for ever.
 */
async function fencedGroup<T>(deps: FenceScope, fn: (repo: WorkerRepo) => Promise<T>): Promise<T> {
  if (!deps.fence) return deps.repo.transaction(fn);
  return underFence(deps.fence, fn);
}

async function underFence<T>(fence: SyncWriteFence, fn: (repo: DrizzleRepo) => Promise<T>): Promise<T> {
  if (fence.lost()) {
    throw new LeaderFencedError("the leader lease is gone — this write is refused before it is attempted");
  }
  const out = await fence.transaction(fn);
  if (out.fenced) {
    throw new LeaderFencedError("the heartbeat no longer names this instance as the shard leader — the write was refused");
  }
  return out.result;
}

/**
 * The check before every IMAP mutation — see the fence block at the top of this file for what
 * its admission can and cannot promise, and why the residual it cannot close converges.
 */
async function fenceImapMutation(deps: Pick<SyncDeps, "fence">): Promise<void> {
  const { fence } = deps;
  if (!fence) return;
  if (fence.lost() || !(await fence.stillLeader())) {
    throw new LeaderFencedError("this instance no longer leads its shard — the IMAP mutation is not issued");
  }
}

/**
 * Rethrow a fence refusal out of a catch arm that would otherwise swallow it or read it as a
 * message fault. A refusal is proof of lost leadership and must reach the caller unreclassified.
 */
function rethrowFenced(err: unknown): void {
  if (err instanceof LeaderFencedError) throw err;
}

/**
 * One sync pass. Returns whether the adapter still owes a backlog: a first sync of a real
 * mailbox is now drained in bounded batches (see `DEFAULT_SYNC_BATCH_MAX_MESSAGES`), and the
 * caller re-kicks instead of waiting out `pollIntervalMs` — which for a mailbox of any size is
 * the difference between one opaque multi-hour cycle and a series of short, observable ones.
 *
 * ── TWO BACKLOGS, AND THEY ARE DELIBERATELY NOT ONE FLAG ────────────────────────────────────
 *
 * `hasBacklog` is about INBOUND mail the adapter has not handed over. `owesFiling` is about
 * OUTBOUND intent this mailbox has not put on its server — filing that hit
 * {@link RECONCILE_MOVES_PER_CYCLE}. The caller re-kicks on either, which is what turns the
 * filing budget into a rotation rather than a delay: the mailbox goes to the back of the serial
 * queue and comes round again after every other one has had its turn, instead of holding the
 * queue until its whole backlog drains (a 583-second monopoly, measured) or waiting a full poll
 * interval per 500 messages.
 *
 * They are separate because ONE of them also means "the first import is finished".
 * `stampInitialImportComplete` fires on `!hasBacklog`, and a mailbox whose owner is mid-triage
 * would never have earned that stamp if a filing queue could hold the flag high — the import
 * would read as permanently partial for a reason that has nothing to do with importing.
 */
export async function runSyncCycle(deps: SyncDeps): Promise<{ hasBacklog: boolean; owesFiling: boolean }> {
  const { repo, adapter, accountId, mailboxId, classifier, credits, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff, log } = deps;
  const deadLetters = deps.deadLetters ?? new DeadLetterLedger();
  const version = deps.buildVersion ?? buildVersionOf(process.env);
  deadLetters.beginCycle();
  // ── THE DURABLE LEDGER IS READ BEFORE THE CURSOR IS BUILT, AND IT MAY THROW ────────────────
  //
  // `buildCursor` merges the ledger into every folder's known-set, so hydrating after it would
  // publish a cursor computed as though nothing were owed. And the throw is not caught: a cycle that
  // cannot read `message_failures` does not know which UIDs are outstanding, and the failure mode of
  // guessing "none" is advancing a Sent watermark over mail it has no record of — which is the loss
  // this table exists to stop. An unreadable table is an infrastructure fault and is handled like
  // one: no cursor written, the mailbox's ordinary failure counting takes over.
  deadLetters.hydrate(await repo.listMessageFailures(mailboxId));
  const cursor = await buildCursor(repo, mailboxId, deadLetters);
  const batch = await adapter.changesSince(cursor);

  /**
   * Folders holding a change that FAILED and was NOT consumed. Their cursor is not written and
   * the cycle ends by rethrowing, so nothing is acknowledged past work still owed.
   */
  const deferred = new Set<string>();
  let firstDeferredError: unknown = null;

  /**
   * Per-change failure boundary.
   *
   * The three outcomes are the whole fix. `applied` continues. `skip` records the item durably as
   * evidence, declares it consumed, and continues — the batch reaches B. `retry` holds the
   * folder's cursor and remembers the error to rethrow after the batch, which leaves the mailbox's
   * existing failure counting and quarantine cadence exactly as it was.
   *
   * `ClassifierFaultError` and `LeaseUnavailableError` are rethrown IMMEDIATELY and by class, as
   * they are at the caller's own catch arms: a model outage or an unreadable lease is not evidence
   * about the message, and counting attempts against it would eventually write off good mail
   * because somebody else had an incident.
   */
  async function attempt(ch: Change, run: () => Promise<void>): Promise<void> {
    const site = siteOf(ch);
    if (deadLetters.has(site.folder, site.uidValidity, site.uid)) return;
    // The fence's synchronous tripwire, BEFORE the work: `planChange` may spend a classifier
    // call on this message, and a process that has already observed losing its lease must not
    // spend anything on mail it no longer organizes. The commit below would be refused anyway;
    // this line is what makes the refusal cost nothing.
    if (deps.fence?.lost()) {
      throw new LeaderFencedError("the leader lease is gone — this cycle stops before the next message");
    }
    try {
      await run();
    } catch (err) {
      if (err instanceof ClassifierFaultError || err instanceof LeaseUnavailableError) throw err;
      // A fence refusal is proof of lost leadership, never evidence about the message: counting
      // an attempt against it — let alone writing it off — would spend a customer's mail on our
      // own handover.
      rethrowFenced(err);
      const fault = classifyIngestFault(err);
      if (fault.domain === "infrastructure") {
        // Ours, not the message's. Fail the cycle the way a bare throw did before this boundary
        // existed: no attempt counted, no cursor written for this folder, nothing written off.
        //
        // There was a `deferred.add(site.folder)` here and it was DEAD, which matters
        // because it read as load-bearing. The throw is what holds every cursor: the `await
        // attempt(...)` call sites (the `for` loops below) have no `catch` between them and the
        // `deferred.has(folder)` read in the cursor loop, so this throw leaves the function and
        // that read is never reached in this cycle. Deferring one folder was therefore
        // unobservable — and narrower than the truth, since an infrastructure fault must hold
        // ALL folders' cursors, not just this one's. Do not re-add it: it would suggest the
        // cycle continues past this point, and it does not.
        throw err;
      }
      const verdict = deadLetters.record(ch.locator, fault);
      if (verdict === "retry") {
        deferred.add(site.folder);
        if (firstDeferredError === null) firstDeferredError = err;
        log?.warn("sync_message_deferred", {
          mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
          code: fault.code, err,
          reason: "this message failed but has not exhausted its attempts — the folder's cursor is " +
            "held and the cycle fails, so nothing is acknowledged past it",
        });
        return;
      }
      // ── THE DURABLE RECORD, AND IT IS *NOT* BEST-EFFORT ──────────────────────────────────
      //
      // This write is the only reason the cursor is allowed to cross this UID. On the Sent folder
      // the cursor IS a UID watermark, so a skip whose row is missing is a message nothing will ever
      // enumerate again — the mail-loss defect, reachable through a database hiccup instead of
      // through a restart. So a failure here REVOKES the terminal decision and takes the `retry`
      // arm: the folder's cursor is held, the cycle fails, and the mailbox's ordinary quarantine
      // cadence makes the problem loud. Content-free, exactly as the audit row below is: folder,
      // epoch, UID, closed-set code, and nothing a sender chose.
      let attempts: number;
      try {
        attempts = await fencedWrite(deps, (r) => r.recordMessageFailure(mailboxId, {
          accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
          code: fault.code, version,
          nextAttemptAt: nextAttemptAfter(fault.code, 1, new Date()),
        }));
      } catch (writeErr) {
        deadLetters.revoke(ch.locator);
        // Revoked FIRST, then the fence refusal propagates: the in-memory terminal decision must
        // not outlive a durable record that was refused, whoever refused it.
        rethrowFenced(writeErr);
        deferred.add(site.folder);
        if (firstDeferredError === null) firstDeferredError = writeErr;
        log?.error("sync_message_skip_unrecordable", {
          mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
          code: fault.code, err: writeErr,
          reason: "this message could not be processed AND the durable record of that could not be " +
            "written — the folder's cursor is held rather than advanced past mail nothing would " +
            "ever enumerate again",
        });
        return;
      }
      log?.error("sync_message_skipped", {
        mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        code: fault.code, skipped: deadLetters.skipped, attempts, err,
        reason: "this message cannot be processed and has been declared consumed — the rest of the " +
          "batch and all later mail continue, which is what one poison message used to prevent. It " +
          "is recorded durably and re-read by UID on a schedule; the cursor may cross it",
      });
      // The USER-FACING evidence, best-effort and content-free: their own tooling reads `audit_log`,
      // and unlike the row above this one carries no recovery, so a bookkeeping failure here must not
      // resurrect the wedge the skip decision exists to end.
      try {
        await fencedWrite(deps, (r) => r.recordAudit(
          accountId, "sync.message_skipped",
          {
            mailboxId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
            code: fault.code,
          },
          null,
        ));
      } catch (auditErr) {
        rethrowFenced(auditErr);
        log?.warn("sync_message_skip_audit_failed", {
          mailboxId, accountId, folder: site.folder, uid: site.uid, err: auditErr,
        });
      }
    }
  }

  // ── DISAPPEARANCES FIRST, AND THAT ORDER IS THE POINT ───────────────────────────────────────
  //
  // `batch.deletes` was consumed by NOTHING. It was described as a cursor-only signal, and that
  // description is what left `classifyDedup` unable to tell a user's move from a stranger's
  // delivery: a sender can make a locator APPEAR, only the user can make a stored locator
  // DISAPPEAR, and the disappearance was being thrown away.
  //
  // Recorded BEFORE the ingest loop, so this cycle's deletes are evidence for this cycle's
  // creates. That covers the two shapes `correlateMoves` cannot pair — a message carrying no
  // Message-ID at all (`imap.ts` pairs on it), and a delete and a create landing in different
  // batches — which is exactly the case where requiring a correlated move alone would refuse a
  // REAL user move and `reconcileFolders` would drag it back.
  //
  // ── THE EPOCH GUARD IS "ALL EVIDENCE IS VOID ON A UIDVALIDITY CHANGE" ───────────────────────
  //
  // The adapter emits every prior UID as a delete when a folder's epoch changes, carrying the
  // PRIOR epoch in the ref. Those UIDs did not vanish — they were renumbered, and the adapter
  // re-enumerates every one of them in the same batch. Recording them as disappearances would
  // hand a whole folder's worth of adoption evidence to whatever create is processed first, so a
  // delete is only believed when its epoch is the one the server is reporting NOW.
  //
  // `epochsObserved` is the server's live answer, read off the locators the adapter minted this
  // pass. It has no entry for a folder that produced no create, move or flag — the ordinary case
  // for the SOURCE folder of an external move — so the cursor the adapter just computed is the
  // fallback. Neither available ⇒ no epoch can be named ⇒ skip, which loses evidence rather than
  // inventing it.
  const observedEpochs = epochsObserved(batch);
  for (const ch of batch.deletes) {
    const site = siteOf(ch);
    const live = observedEpochs.get(site.folder) ?? batch.newCursor.folders[site.folder]?.uidValidity;
    if (live === undefined || live === "0" || live !== site.uidValidity) continue;
    await fencedWrite(deps, (r) => r.forgetInstanceAt(mailboxId, ch.locator));
  }

  // Two-phase, transaction-safe ingest. PLAN performs the reads +
  // optional classifier network call OUTSIDE any transaction; COMMIT persists the
  // entity rows + change_log inside ONE short transaction (tx-scoped repo, no
  // network). The physical IMAP move runs afterwards in reconcileMailbox, outside
  // the transaction. Only content-bearing changes (create/move carrying RFC822) are
  // ingested; a FLAG is a cursor-only signal, and a DELETE is the move evidence recorded above.
  for (const ch of [...batch.creates, ...batch.moves]) {
    await attempt(ch, async () => {
      const plan = await planChange(ch, { repo, accountId, mailboxId, classifier, credits, routing: repo, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff });
      await fencedIngest(deps, (txRepo) =>
        commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId }),
      );
    });
  }

  // INBOUND READ-STATE — the inbound half of read-state mirroring. `flagChanges` was produced by
  // the adapter and consumed by nothing, so a message read in another mail client stayed bold in
  // ohmail forever. Each one is its own short transaction — the entity write and its `change_log`
  // row commit together, and one unresolvable locator cannot roll back the whole batch.
  //
  // `applyExternalFlag` owns the user-wins decision: it declines while OUR write is still
  // pending, so the value the server is about to be told is never overwritten by the value it
  // is still reporting. A locator with no message behind it (a create this batch truncated) is
  // simply skipped — the next cycle sees the flag again.
  //
  // Behind the SAME boundary as ingest, for the same reason ingest has one: one throwing flag
  // exited this loop too, so every later flag in the slice went unapplied and the mailbox
  // retried the same one for ever.
  for (const ch of batch.flagChanges) {
    await attempt(ch, async () => {
      await fencedIngest(deps, async (txRepo) => {
        const outcome = await txRepo.applyExternalFlag(mailboxId, ch.locator, ch.seen ?? false);
        if (!outcome?.changed) return;
        await txRepo.recordChange({
          accountId, entityType: "message", entityId: outcome.messageId, op: "update", meta: null,
        });
      });
    });
  }

  // AFTER the commit loop, deliberately. The adapter holds a truncated folder's cursor at its
  // previous value, so this writes the ADVANCED cursor only for folders that genuinely
  // drained; advancing mid-loop would put `highestModseq` past mail this process has not
  // committed yet, and a crash there loses it permanently. The per-message `commitChange`
  // transactions above are the incremental checkpoint — `buildCursor` rebuilds the known-set
  // from them, so a restart resumes rather than restarting the mailbox.
  //
  // A folder in `deferred` is skipped entirely: it holds a change that failed and was not
  // declared consumed, and a cursor written across that is an acknowledgement of work still owed.
  for (const [folder, fc] of Object.entries(batch.newCursor.folders)) {
    if (deferred.has(folder)) continue;
    await fencedWrite(deps, (r) => r.upsertMailboxFolder(mailboxId, folder, epochAware(fc, observedEpochs.get(folder))));
  }

  // AFTER the cursor writes, and skipped entirely when anything is deferred — see
  // `retryFailedMessages` for both reasons.
  if (deferred.size === 0) await retryFailedMessages(deps, deadLetters, version);

  const { owesMore } = await reconcileMailbox(deps);
  if (firstDeferredError !== null) throw firstDeferredError;
  return { hasBacklog: batch.hasBacklog ?? false, owesFiling: owesMore };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE TARGETED RETRY — re-read written-off UIDs BY UID, and never by rescanning a folder
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This is the half of mail 0041 that turns a durable record into recovered mail. A written-off UID
 * is, by the time it is written off, behind the Sent folder's watermark and inside every other
 * folder's known-set, so nothing in the ordinary batch will ever offer it again. This asks for it by
 * name.
 *
 * ── WHERE IT RUNS, AND WHY EVERY PART OF THAT IS LOAD-BEARING ─────────────────────────────────
 *
 *  · **Inside the cycle, not on a cron.** A cron would need its own IMAP connection, which collides
 *    with the exactly-one-organizer lease; and `reconcile-cron.ts` runs only when no worker holds the
 *    leader lock, so a retry cron beside it would never execute in production at all. Riding the
 *    cycle means it runs under the lease `cycle()` re-verified moments earlier.
 *  · **After the cursor writes.** A retry must never be able to hold a watermark: the mailbox has to
 *    keep draining whether or not history can be recovered. Running before the writes would let a
 *    throw here strand the cursor of a folder that drained perfectly.
 *  · **Skipped when anything is deferred.** A deferred folder means live mail failed and was not
 *    consumed; the cycle is about to fail. Spending IMAP round trips on history in that state
 *    competes with the mailbox's own recovery.
 *  · **It never throws.** Every failure is recorded and swallowed. This work is about mail the
 *    product has ALREADY declared consumed, so failing the cycle over it would re-wedge the mailbox —
 *    which is the exact defect the dead-letter ledger was written to end.
 *
 * ── AND WHY THE CLAIM IS A CONDITIONAL UPDATE ─────────────────────────────────────────────────
 *
 * Two workers mid-leader-handover both reach this. `claimMessageFailures` stamps the rows it selects
 * in one statement, so the loser blocks on the row lock, re-reads a committed `attempted_version`
 * equal to its own, and claims nothing. Even if both did claim, the retry is idempotent — the second
 * ingest's `planChange` finds the row the first committed and answers `duplicate` — but a lost race
 * here would double the IMAP traffic of every handover, and the claim is one statement either way.
 */
async function retryFailedMessages(
  deps: SyncDeps, deadLetters: DeadLetterLedger, version: string,
): Promise<void> {
  const { repo, adapter, accountId, mailboxId, classifier, credits, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff, log } = deps;
  // A backend that cannot re-read one message degrades to the pre-0041 behaviour rather than
  // erroring: the rows stay owed and a later deploy (or a real adapter) picks them up.
  if (!adapter.fetchByUid) return;

  const now = new Date();
  let claimed: Awaited<ReturnType<WorkerRepo["claimMessageFailures"]>>;
  try {
    claimed = await fencedWrite(deps, (r) => r.claimMessageFailures(mailboxId, {
      version, now, limit: MAX_MESSAGE_RETRIES_PER_CYCLE,
      // The NEXT clock instant is written by the claim, so a process that dies mid-fetch does not
      // leave the row due on every subsequent cycle. `null` for the deterministic codes: their next
      // look is a new build, not a later hour.
      nextAttemptAt: nextAttemptAfter("unclassified", 1, now),
    }));
  } catch (err) {
    rethrowFenced(err);
    log?.warn("message_retry_claim_failed", { mailboxId, accountId, err });
    return;
  }
  if (claimed.length === 0) return;
  // Fold the claim's POST-INCREMENT attempt counts back into the ledger. Without this the
  // in-memory view lags the table by exactly one claim, so `escalated` — which is what `/health`
  // publishes — would report a message as fine on the very cycle that exhausted its third attempt.
  // `hydrate` takes the max, so this can only ever move the count forward.
  deadLetters.hydrate(claimed);

  const byFolder = new Map<string, typeof claimed>();
  for (const row of claimed) {
    const arr = byFolder.get(row.folder) ?? [];
    arr.push(row);
    byFolder.set(row.folder, arr);
  }

  for (const [folder, rows] of byFolder) {
    let found: Awaited<ReturnType<NonNullable<MailboxAdapter["fetchByUid"]>>>;
    try {
      found = await adapter.fetchByUid(folder, rows.map((r) => r.uid), {
        maxBytes: MAX_RAW_MESSAGE_BYTES,
      });
    } catch (err) {
      // The folder is unselectable, or the connection died. The rows keep their claim's schedule.
      log?.warn("message_retry_fetch_failed", { mailboxId, accountId, folder, err });
      continue;
    }

    const close = async (row: { uidValidity: string; uid: number }, why: string): Promise<void> => {
      await fencedWrite(deps, (r) => r.resolveMessageFailure(mailboxId, { folder, uidValidity: row.uidValidity, uid: row.uid }));
      deadLetters.forget(folder, row.uidValidity, row.uid);
      log?.info("message_retry_closed", {
        mailboxId, accountId, folder, uidValidity: row.uidValidity, uid: row.uid, reason: why,
      });
    };

    for (const row of rows) {
      // ── THE EPOCH GUARD. A UID NUMBER MEANS NOTHING OUTSIDE THE EPOCH THAT ISSUED IT ──────
      //
      // The record was written under epoch V; the server is reporting V′. Re-ingesting `uid` now
      // would ingest whatever message the server has RENUMBERED onto that number — a different
      // message entirely — and would then resolve the record as though the original had arrived. So
      // the record is void, and closing it loses nothing: a UIDVALIDITY change makes the adapter
      // emit every prior UID as a delete and re-enumerate the whole folder, so the original message
      // is offered again as an ordinary unknown UID.
      if (found.uidValidity !== "0" && found.uidValidity !== row.uidValidity) {
        try { await close(row, "uidvalidity_changed"); }
        catch (err) { rethrowFenced(err); log?.warn("message_retry_close_failed", { mailboxId, folder, uid: row.uid, err }); }
        continue;
      }

      if (found.absent.includes(row.uid)) {
        // Expunged, or moved by the user out of this folder. There is no message here to lose, and
        // a move surfaces through the ordinary enumeration of wherever it went.
        try { await close(row, "gone_from_server"); }
        catch (err) { rethrowFenced(err); log?.warn("message_retry_close_failed", { mailboxId, folder, uid: row.uid, err }); }
        continue;
      }

      if (found.oversize.includes(row.uid)) {
        // Refused from `RFC822.SIZE` alone — the body was never pulled. Still failing, and still
        // deterministic, so the record simply keeps its place and waits for a build with a bigger
        // ceiling.
        log?.warn("message_retry_still_oversize", {
          mailboxId, accountId, folder, uid: row.uid, attempts: row.attempts,
          escalated: deadLetters.escalated,
        });
        continue;
      }

      const change = found.creates.find((c) => parseRef(c.locator.ref).uid === row.uid);
      if (!change) {
        log?.warn("message_retry_no_answer", { mailboxId, accountId, folder, uid: row.uid });
        continue;
      }

      // THE SAME TWO-PHASE INGEST the ordinary path runs, byte for byte, which is what makes a
      // retry idempotent rather than a second ingest with its own dedup story: `planChange`'s
      // dual-key lookup answers `duplicate` for a message a previous attempt already committed, and
      // `own_copy` for a Sent twin of mail we hold.
      try {
        const plan = await planChange(change, { repo, accountId, mailboxId, classifier, credits, routing: repo, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff });
        await fencedIngest(deps, (txRepo) =>
          commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId }),
        );
      } catch (err) {
        // Lost leadership is not evidence about the message and not an outage to wait out —
        // the whole cycle must stop, so this one arm rethrows where the two below return.
        rethrowFenced(err);
        if (err instanceof ClassifierFaultError || err instanceof LeaseUnavailableError) {
          // Not evidence about the message. Leave the row exactly as the claim left it and stop —
          // continuing would spend the rest of this cycle's retries against the same outage.
          log?.warn("message_retry_deferred", { mailboxId, accountId, folder, uid: row.uid, err });
          return;
        }
        const fault = classifyIngestFault(err);
        if (fault.domain === "infrastructure") {
          log?.warn("message_retry_infrastructure", { mailboxId, accountId, folder, uid: row.uid, err });
          return;
        }
        // Still failing, and possibly for a NEW reason (a bigger ceiling turned `mime_too_large`
        // into `mime_unparseable`), so the code is re-recorded. `recordMessageFailure` does not
        // touch `attempts` — the claim already counted this one.
        try {
          await fencedWrite(deps, (r) => r.recordMessageFailure(mailboxId, {
            accountId, folder, uidValidity: row.uidValidity, uid: row.uid,
            code: fault.code, version,
            nextAttemptAt: nextAttemptAfter(fault.code, row.attempts, new Date()),
          }));
        } catch (writeErr) {
          rethrowFenced(writeErr);
          log?.warn("message_retry_rerecord_failed", { mailboxId, folder, uid: row.uid, err: writeErr });
        }
        log?.error("message_retry_failed", {
          mailboxId, accountId, folder, uidValidity: row.uidValidity, uid: row.uid,
          code: fault.code, attempts: row.attempts, escalated: deadLetters.escalated, err,
          reason: row.attempts >= 3
            ? "this message has now failed on three separate attempts — it is reported on /health " +
              "as an escalated failure and is still probed once per deployed build"
            : "this message failed again; it stays recorded and will be re-read by UID",
        });
        continue;
      }

      try { await close(row, "ingested"); }
      catch (err) {
        rethrowFenced(err);
        // The message IS committed. A failed resolve leaves the row owed, the next cycle re-reads
        // the same UID, and `planChange` answers `duplicate` — so the replay converges rather than
        // writing a second message.
        log?.warn("message_retry_close_failed", { mailboxId, folder, uid: row.uid, err });
      }
    }
  }
}

/**
 * The epoch the SERVER reported for each folder in this batch.
 *
 * Read off the locators the adapter minted — `makeRef(currentUidValidity, uid)` for every create,
 * move and flag change — so it is the server's live answer and not a remembered one. Deletes are
 * excluded deliberately: their refs carry the PRIOR epoch by design.
 */
function epochsObserved(batch: { creates: Change[]; moves: Change[]; flagChanges: Change[] }): Map<string, string> {
  const out = new Map<string, string>();
  for (const ch of [...batch.creates, ...batch.moves, ...batch.flagChanges]) {
    const { folder, uidValidity } = siteOf(ch);
    if (uidValidity !== "0") out.set(folder, uidValidity);
  }
  return out;
}

/**
 * RECORD THE OBSERVED EPOCH EVEN WHILE THE WATERMARKS ARE HELD.
 *
 * A truncated batch holds its folder's cursor at the PREVIOUS value. That is right for
 * `uidNext`/`highestModseq` — advancing them past mail this pass did not return loses it — and
 * wrong for `uidValidity`, which is not a watermark but an identity. Write `V` for the epoch that
 * has just ended and `V′` for the one the server is reporting now. With the old epoch persisted,
 * the next pass hands the adapter a stale `V` cursor, the adapter must again treat every `V` UID
 * as meaningless, and it again returns the same newest `V′` slice. For ever. New mail arrives
 * newest-first and keeps displacing the tail the drain never reaches.
 *
 * So the epoch advances and the watermarks do not. `uidNext: 0` / `highestModseq: "0"` loses
 * nothing: both remembered values were `V` values, meaningless under `V′`, and this is exactly the
 * cursor the adapter itself computes for a folder it has never seen. The next pass then finds
 * `prev.uidValidity === current`, treats the `V′` locators already committed as known, and returns
 * a DISJOINT slice — which is what makes the drain finite instead of a loop.
 *
 * When the cursor the adapter returned already names the epoch it observed — every non-truncated
 * pass, i.e. the ordinary bounded backfill — this is the identity function.
 *
 * ── A `"0" → V` PROMOTION IS NOT A RESET, AND CONFLATING THEM WAS STICKY ────────────────────
 *
 * `observed !== fc.uidValidity` is true for a `V → V′` RESET and equally true for a `"0" → V`
 * PROMOTION — the cursor of a folder that could not yet NAME an epoch. Both used to take the
 * zeroing arm, and the argument above does not cover the second: on `"0" → V` the watermarks are
 * not stale values from a dead epoch, they are values computed under `V` itself this very pass.
 * Zeroing them discards work that was never wrong.
 *
 * Which was not cosmetic. `"0"` is the epoch of the normal COLD START of every mailbox large
 * enough to truncate (the adapter's `prev`-less truncated branch), and `highestModseq: "0"` is the
 * one value at which `canFastPath` is false. Zeroing the baseline the adapter had just published
 * therefore pinned a permanently-truncating folder at `"0"` for ever: no flag pass, no inbound
 * read-state mirror — the inbound read-state defect above, back per folder. So the promotion arm
 * records the epoch and keeps what the adapter handed it; only a genuine `V → V′` reset zeroes.
 *
 * The kept values are the ADAPTER's, not the database's, and neither shape can raise a Sent
 * watermark past mail nobody fetched. Where the adapter published `mb.uidNext` it had left nothing
 * unknown; and where it held `prev.uidNext`, a `fc.uidValidity` of `"0"` means the row named no
 * epoch and no locator could name one either, which in this tree means `uidNext: 0` — the only code
 * that writes these columns is `upsertMailboxFolder` (which persists exactly what this function
 * returns, so a sentinel epoch always arrives beside zeros) and `MailboxService.requestResync`
 * (which nulls `highestmodseq` and touches neither other column); account deletion drops the rows
 * outright. The columns are nullable, so a row written by hand could break that; no code path can.
 */
function epochAware(fc: PersistedFolderCursor, observed: string | undefined): PersistedFolderCursor {
  if (observed === undefined || observed === fc.uidValidity) return fc;
  // A PROMOTION, not a reset — see above. Record the epoch, keep the watermarks.
  if (fc.uidValidity === "0") return { ...fc, uidValidity: observed };
  return { uidValidity: observed, uidNext: 0, highestModseq: "0" };
}

/**
 * Execute OUR intended moves (desired != observed, lastSetBy === 'us') and OUR intended `\Seen`
 * writes. External divergences are left untouched (user always wins). Idempotent + crash-safe:
 * if the message already left its expected source (a prior run moved it before crashing), we
 * defer to the next changesSince, which adopts the completed move.
 */
export async function reconcileMailbox(deps: SyncDeps): Promise<{ owesMore: boolean }> {
  const owesMore = await reconcileFolders(deps);
  await reconcileFlags(deps);
  return { owesMore };
}

/**
 * Pending moves ONE CYCLE MAY FILE, and the reason this queue finally has a bound.
 *
 * `listPendingFolderStates` had no limit for its whole life, which three separate comments in
 * this tree already called a defect in a shared path. Measured on a production mailbox: one
 * screening session left 1 137 rows pending, and draining them took 583 seconds inside the
 * worker's SERIAL cycle — during which twelve other mailboxes received no mail at all. The
 * per-message IMAP cost is what made that expensive and batching is what fixes it; the bound is
 * what stops it being a monopoly again the day somebody triages ten thousand messages.
 *
 * ── WHY A BUDGET AND NOT MORE CONCURRENCY ────────────────────────────────────────────────────
 *
 * One organizer per mailbox is the product's central invariant and the serial cycle is how this
 * process honours it. A budget rotates the queue without touching that: the cycle files what it
 * can, reports that it still owes work, and the caller re-kicks — so the SAME mailbox comes round
 * again after every other mailbox has had its turn, instead of before any of them has.
 *
 * 500 is the batched path's ten chunks, which at the measured cost is a few seconds of IMAP —
 * short enough that no other mailbox waits on it, large enough that an ordinary day's filing
 * finishes in one pass and never touches the re-kick at all.
 */
export const RECONCILE_MOVES_PER_CYCLE = 500;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE BOUNDED RETRY FOR A MUTATION THE SERVER REFUSES — minutes, then hours, then for ever
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Per-item isolation stops one refused mutation abandoning the pass. It does NOT stop that item
 * being attempted again on the very next cycle, and again on the one after that, which is what the
 * reconciler did for every stuck row for its whole life. Two costs, and the second is the one that
 * hurts users who have nothing to do with the stuck message:
 *
 *  · one IMAP round trip per stuck row per cycle, for ever;
 *  · `listPendingFolderStates` is ordered OLDEST FIRST under {@link RECONCILE_MOVES_PER_CYCLE}, so
 *    a permanently refused row is by construction one of the oldest and sits at the head of that
 *    fixed allowance every single cycle. Accumulate 500 of them and the reconciler's entire budget
 *    goes on re-refusing rows from last month while mail the user filed a minute ago never reaches
 *    their server. Head-of-line blocking by BUDGET rather than by exception — invisible in the
 *    control flow, and unreachable from any `try`/`catch`.
 *
 * So a refusal buys silence, and the silence grows: one minute, five, fifteen, an hour, then a
 * six-hour floor it never passes. The steps are minutes-scale at the start because the common
 * "refusal" is not permanent at all — a folder briefly read-only during the provider's own
 * maintenance, a transient `NO` — and those must not be punished with hours of delay. They widen
 * because a mutation that has been refused five times is not going to be accepted on the sixth,
 * and asking every cycle is how the budget above gets eaten.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────
 *
 * There is no give-up, no terminal code, no write-off, and the schedule has a FLOOR rather than an
 * end. `message_failures` has a `resolved_at` and this deliberately has no equivalent, because the
 * two are about opposite things: that ledger records mail WE could not read, where the failure is
 * ours and the message is still on the server either way. This records an instruction the USER
 * gave — move my mail, mark it read — and their instruction is not ours to discard because a
 * server was difficult. The row stays `pending`, keeps counting toward the "Filing N messages on
 * your mail server…" number the client shows, and converges the day the host relents.
 *
 * `attempts` is what makes it visible rather than merely persistent: it rides the
 * `reconcile.move.failed` / `reconcile.flags.failed` audit row, so "this one has failed 40 times"
 * is a value somebody can select rather than a pattern somebody has to notice across 40 identical
 * log lines.
 */
const RECONCILE_BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60, 360];

/**
 * When a mutation refused for the `attempts`-th time may be attempted again.
 *
 * `attempts` is the count INCLUDING the refusal being recorded now, so the first failure takes the
 * first step. Beyond the last step the schedule stays on it — {@link RECONCILE_BACKOFF_MINUTES}
 * for why the tail is a floor and not a cliff.
 */
export function nextReconcileAttemptAfter(attempts: number, now: Date): Date {
  const step = Math.min(Math.max(1, attempts), RECONCILE_BACKOFF_MINUTES.length) - 1;
  return new Date(now.getTime() + RECONCILE_BACKOFF_MINUTES[step]! * 60_000);
}

/**
 * Is this throw evidence about THIS MUTATION, or about the pipes?
 *
 * The distinction decides whether a failure earns a deferral, and getting it backwards is
 * expensive in both directions — the same trade `classifyIngestFault` documents, which is why this
 * reuses it rather than growing a second opinion:
 *
 *  · Call a HOST OUTAGE per-message and a mailbox that was merely unreachable for ten minutes
 *    comes back with its entire filing queue deferred for an hour, then six. The user's mail sits
 *    unfiled while the server that would accept it is up and answering. Every pending row would
 *    take the deferral, because during an outage every row fails.
 *  · Call a PER-MESSAGE refusal infrastructure and nothing is ever deferred: back to one IMAP
 *    round trip per stuck row per cycle and the budget starvation above.
 *
 * The infrastructure domain covers both sockets in play here — the customer's IMAP host and our
 * own database — which is right, because neither is the message's fault. An infrastructure failure
 * therefore leaves the row EXACTLY as it was: due now, attempts unchanged, no audit row. The pass
 * still continues through the rest of the queue (see the call sites for why an outage is not
 * converted into a mailbox-wide abort here), and the backlog drains the moment the host is back —
 * which is precisely what `reconcile-resume.pg.test.ts` holds this to.
 */
function isTransportFailure(err: unknown): boolean {
  return classifyIngestFault(err).domain === "infrastructure";
}

/**
 * Execute our intended moves, grouped by (source folder → destination) and filed in batches.
 *
 * Returns whether the budget was reached with rows still pending, which the caller turns into a
 * re-kick. See {@link RECONCILE_MOVES_PER_CYCLE} for the bound and
 * {@link MailboxAdapter.moveMany} for what a batch is allowed to assume.
 *
 * ── THE FALLBACK IS THE DESIGN, NOT A SAFETY NET ────────────────────────────────────────────
 *
 * `moveMany` answers `batched: false` for every group it cannot prove equivalent to moving each
 * member on its own, and it answers it BEFORE writing anything. Everything below therefore has
 * exactly two shapes — a batch that fully succeeded, or a group that goes through the untouched
 * per-message path — and never a half-filed group whose remainder someone has to track. A throw
 * takes the same fallback for the same reason: per-message is where a single message earns its
 * own verdict and its own `reconcile.move.failed` row.
 */
async function reconcileFolders(deps: SyncDeps): Promise<boolean> {
  const { repo, mailboxId } = deps;
  // One row over the budget, so "there is more" is a fact about the queue rather than a guess
  // from a full page.
  const pending = await repo.listPendingFolderStates(mailboxId, RECONCILE_MOVES_PER_CYCLE + 1);
  const owesMore = pending.length > RECONCILE_MOVES_PER_CYCLE;
  const work = owesMore ? pending.slice(0, RECONCILE_MOVES_PER_CYCLE) : pending;

  /** Rows that need an IMAP move, keyed by the (source folder → destination) they share. */
  const groups = new Map<string, PendingFolderState[]>();
  for (const p of work) {
    if (p.lastSetBy !== "us") continue;                       // user-wins: never revert an external move
    if (p.desiredFolder === p.observedFolder) {
      await fencedWrite(deps, (r) => r.upsertFolderState(p.messageId, { desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us" }));
      continue;
    }
    if (!p.nativeLocator) continue;
    // `JSON.stringify` of the PAIR, not the two names joined by a separator. A folder name comes
    // from the mail server and may contain any character a delimiter could be chosen from, so a
    // joined key can collide across two different pairs — and the obvious unambiguous separator is
    // a NUL, which cannot be written here: a single raw NUL anywhere in a source file makes every
    // grep-family tool skip the WHOLE file silently, which this repository has already paid for
    // once. The array form is unambiguous and printable.
    const key = JSON.stringify([p.nativeLocator.folder, p.desiredFolder]);
    const bucket = groups.get(key);
    if (bucket) bucket.push(p); else groups.set(key, [p]);
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += FILING_BATCH_MAX) {
      const chunk = group.slice(i, i + FILING_BATCH_MAX);
      if (await fileChunk(deps, chunk)) continue;
      for (const p of chunk) await fileOne(deps, p);
    }
  }
  return owesMore;
}

/**
 * File one chunk in a batch, or report that it was not filed at all.
 *
 * `false` means NOTHING WAS WRITTEN TO THE DATABASE for this chunk and the caller owes every
 * member to {@link fileOne}. That is true even when the adapter threw after moving some of them:
 * the per-message retry finds those gone from the source, raises {@link MessageGoneError}, and
 * leaves the row pending for `changesSince` to adopt — which is the same convergence the
 * per-message path has always relied on for a crash between the IMAP move and the DB write.
 */
async function fileChunk(deps: SyncDeps, chunk: PendingFolderState[]): Promise<boolean> {
  const { adapter, accountId, mailboxId, log } = deps;
  if (typeof adapter.moveMany !== "function") return false;
  const first = chunk[0]!;
  const srcFolder = first.nativeLocator!.folder;
  const toFolder = first.desiredFolder;
  // A locator already sitting at its destination is the per-message path's problem to reason
  // about, not a batch's: `moveMany` refuses a same-folder group outright.
  if (srcFolder === toFolder) return false;
  // Two rows naming ONE locator would collapse to a single UID in the batch and both would be
  // told they landed at the same place. It cannot arise from one mailbox's data, and if it ever
  // does, the per-message path gives each row its own answer.
  const refs = new Set(chunk.map((p) => p.nativeLocator!.ref));
  if (refs.size !== chunk.length) return false;

  // The fence, BEFORE the IMAP command — the whole batch is one mutation. Outside the `try`
  // below deliberately: its refusal must abort the cycle, never degrade to the per-message path.
  await fenceImapMutation(deps);
  let result;
  try {
    result = await adapter.moveMany(chunk.map((p) => p.nativeLocator!), toFolder);
  } catch {
    return false;
  }
  if (!result.batched) return false;

  // ONE WRITE GROUP for the whole chunk's bookkeeping — a transaction whether or not there is a
  // fence (see {@link fencedGroup}). It has to be: a chunk's worth of locator/state/audit writes
  // that half-commits leaves some of its members claiming a destination their `folder_state` still
  // disagrees with, and the batched path has no per-member retry to notice.
  //
  // A failure of the group is contained rather than rethrown, and the chunk still answers TRUE.
  // The moves LANDED — `moveMany` reported `batched`, which it only does for a group it performed
  // whole — so sending the members to `fileOne` would spend one round trip each rediscovering that
  // the source is gone. Nothing was written, every row is still pending and due, and the next
  // `changesSince` adopts what the server shows: the same convergence a crash here takes.
  try {
    await fencedGroup(deps, async (r) => {
      const audits: Array<{ action: string; payload: unknown; inverse: unknown }> = [];
      for (const p of chunk) {
        const ref = p.nativeLocator!.ref;
        const newLoc = result.moved.get(ref);
        // NOT NAMED IN `moved` ⇒ the member was gone from the source, the batch's form of
        // `MessageGoneError` — and the response is the per-message path's, exactly: leave the row
        // pending for `changesSince` to adopt, unless the disappearance is already on durable
        // record, in which case there is nothing left to adopt and the filing is voided. See
        // {@link voidGoneFiling} for why those are the only two readings. Cross-checking
        // `result.gone` as well would be a second reading of one fact, with a branch no test can
        // redden.
        if (!newLoc) { await voidGoneFiling(r, accountId, p); continue; }
        await r.updateLocator(p.messageId, newLoc);
        await r.upsertFolderState(p.messageId, { desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us" });
        // The audit rows are written together, AFTER the state they describe. One INSERT instead of
        // fifty, and the same rows a per-message pass would have written — the admin surface and the
        // inverse both read this table and neither can tell which path filed the mail.
        audits.push({
          action: "reconcile.move",
          payload: { messageId: p.messageId, from: p.nativeLocator, to: p.desiredFolder, newLocator: newLoc },
          inverse: { action: "move", locator: newLoc, toFolder: p.nativeLocator!.folder },
        });
      }
      if (audits.length > 0) await recordAudits(r, accountId, audits);
    });
  } catch (err) {
    rethrowFenced(err);
    log?.error("reconcile_move_batch_uncommitted", {
      mailboxId, accountId, size: chunk.length, to: toFolder, err,
      reason: "the batched IMAP move succeeded and its bookkeeping did not commit; every row " +
        "stays pending and due, and the next cycle adopts the completed moves",
    });
  }
  return true;
}

/** Fan an audit batch out to whichever of the two repo shapes this deployment has. */
async function recordAudits(
  repo: SyncDeps["repo"], accountId: string,
  rows: Array<{ action: string; payload: unknown; inverse: unknown }>,
): Promise<void> {
  if (typeof repo.recordAuditMany === "function") {
    await repo.recordAuditMany(accountId, rows);
    return;
  }
  for (const r of rows) await repo.recordAudit(accountId, r.action, r.payload, r.inverse);
}

/**
 * The terminal check for a GONE member: void the filing if the message no longer exists
 * anywhere this mailbox's record knows of.
 *
 * "Gone from the source" has two readings, and they need opposite treatment. A message MID-MOVE
 * — a prior run's IMAP move that crashed before the DB write, or an external move whose create
 * is a batch behind its delete — must stay pending: `changesSince` adopts the completed move,
 * and writing anything here would race it. A message EXPUNGED OUTRIGHT has no adoption event
 * coming, ever. Before this branch existed such a row stayed `pending` for good — filed, then
 * deleted from the server before the move could apply, it held `MailboxDTO.pendingMoves` (the
 * "Filing N messages on your mail server…" count) up indefinitely, survived sign-out and a full
 * client-mirror wipe because the state is server-side, and left no `reconcile.move.failed` row
 * anywhere, because this skip writes nothing at all. The retry also cost one IMAP round trip
 * per cycle, for ever.
 *
 * `primaryInstanceVanished` is what tells the readings apart, and it is the SAME predicate
 * ingest treats as adoption evidence (`pipeline.ts`): true only once the server's DELETE has
 * been durably observed under a matching epoch (`forgetInstanceAt`) and no re-appearance has
 * been adopted since. Mid-move it is false — the stale primary instance still exists until the
 * source delete is enumerated — so the ordinary crash-convergence path is untouched. The one
 * window where it is true for a message that is NOT expunged is a move whose delete and create
 * land in different batches; voiding inside that window still converges, because adoption keys
 * on the message's dedup identity and rewrites `folder_state` itself — it does not read the row
 * this writes.
 *
 * The write is the COMPLETION write (`observed := desired`) rather than a new status member,
 * because `reconcile_status` is derived from the pair and a row must never claim a convergence
 * shape its columns do not show; what actually happened is in the audit row. `native_locator`
 * is left alone deliberately: clearing it would flip `primaryInstanceVanished` to false and
 * erase the adoption evidence for a copy that does surface later.
 *
 * Takes the repo it must write through rather than `deps`, because one caller (`fileChunk`) is
 * already inside a fenced write group and a second fence opened within the first would wait on
 * the mailbox row its own transaction holds. The other caller wraps this in its own group.
 */
async function voidGoneFiling(repo: WorkerRepo, accountId: string, p: PendingFolderState): Promise<void> {
  if (!(await repo.primaryInstanceVanished(p.messageId))) return;
  await repo.upsertFolderState(p.messageId, {
    desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us",
  });
  await repo.recordAudit(
    accountId, "reconcile.move.voided",
    { messageId: p.messageId, from: p.nativeLocator, to: p.desiredFolder },
    null,
  );
}

/**
 * The per-message path: one move, its own verdict, its own audit row, its own deferral.
 *
 * ── THE TWO SEAMS ARE HANDLED SEPARATELY, AND THAT SPLIT IS THE POINT ───────────────────────
 *
 * A refused MUTATION and a failed COMPLETION look the same from a single `try` and mean opposite
 * things, so they get one `try` each:
 *
 *  · `adapter.move` threw ⇒ the server did not perform the move. Nothing has changed anywhere, we
 *    still owe it, and asking again immediately is what makes a permanently refused mutation eat
 *    the filing budget. This is what earns a DEFERRAL.
 *  · the write group threw ⇒ the server ALREADY MOVED THE MAIL and only our record of it failed.
 *    The database and the mailbox now disagree, and deferring would hold that disagreement open
 *    for the length of the backoff — an hour in which the client shows the message in a folder it
 *    is not in. So this is never deferred and never recorded as the message's failure: the row is
 *    left pending and DUE, and the next cycle converges it the documented way (the source copy is
 *    gone, the retry raises {@link MessageGoneError}, `changesSince` adopts what the server shows).
 *
 * Folding them together — which is what one `try` around both did — produced a
 * `reconcile.move.failed` audit row asserting that a move which HAD succeeded was refused, and put
 * the correction to sleep behind it.
 */
async function fileOne(deps: SyncDeps, p: PendingFolderState): Promise<void> {
  const { adapter, accountId, mailboxId, log } = deps;
  // Typed off the adapter's own signature rather than by importing `NativeLocator`: this module
  // reaches core through `/mail` and `/adapters/imap` only, and neither exports that name — see the
  // import block's note on what naming the bare barrel here would drag into the desktop engine.
  let newLoc: Awaited<ReturnType<MailboxAdapter["move"]>>;
  try {
    await fenceImapMutation(deps);
    newLoc = await adapter.move(p.nativeLocator!, p.desiredFolder);
  } catch (err) {
    // A fence refusal must not be recorded as this message's failure — it is the process's.
    rethrowFenced(err);
    if (err instanceof MessageGoneError) {
      // Already moved (crash between IMAP move and DB update) → leave pending; the next
      // changesSince adopts it. Expunged outright → nothing will ever adopt it; see
      // voidGoneFiling for how the two are told apart.
      await fencedGroup(deps, (r) => voidGoneFiling(r, accountId, p));
      return;
    }
    if (isTransportFailure(err)) {
      // NOT EVIDENCE ABOUT THIS MESSAGE — the host is unreachable, or our own database is. The row
      // is left exactly as it was: due now, attempts unchanged, no audit row. So a mailbox whose
      // provider was down for ten minutes files its whole backlog the moment it is back, instead
      // of coming up with every pending move deferred by a failure none of them caused.
      //
      // The pass CONTINUES rather than aborting the cycle, which is a deliberate choice and not an
      // oversight: an abort here would convert one provider outage into the path that detaches and
      // quarantines a mailbox, and blaming a mailbox for a fault that is not its own is a failure
      // this loop already has to be careful about elsewhere. The cost of continuing is one refused
      // round trip per pending row for the length of the outage — bounded by the cycle's own
      // budget, and self-clearing the moment the host answers.
      log?.warn("reconcile_move_transport_failure", {
        mailboxId, accountId, messageId: p.messageId, to: p.desiredFolder, err,
      });
      return;
    }
    // ── ONE MESSAGE'S REFUSAL MUST NOT ABANDON THE PASS, AND MUST NOT REPEAT FOR EVER ────
    //
    // This used to rethrow, which took the whole reconcile pass with it: every OTHER pending
    // move, and — because `reconcileFlags` runs after this function — every pending `\Seen`
    // push too. One message the server will not let us move meant nothing else moved either,
    // every cycle, for as long as that message stayed pending.
    //
    // That was survivable only while a stuck move erased itself: the ingest path used to
    // declare such a move complete on seeing its destination copy, so the row stopped being
    // pending. It no longer does — a move is complete when the source is GONE — so a row whose
    // expunge keeps failing now stays in this queue, and rethrowing would make one unhappy
    // message a mailbox-wide outage.
    //
    // Isolation alone left it unbounded in TIME, which is the half this deferral closes: the
    // failure is recorded AND the row is put to sleep on a widening schedule, so a message the
    // server will never accept stops eating the per-cycle filing budget that everyone else's mail
    // is queued behind. See {@link RECONCILE_BACKOFF_MINUTES} — the schedule has a floor, never an
    // end, and the intent is never discarded.
    //
    // Both writes are ONE GROUP. A deferral without its audit row is a message that went quiet
    // with nothing saying why; an audit row without its deferral is the unbounded retry, restored.
    const attempts = (p.attempts ?? 0) + 1;
    const nextAttemptAt = nextReconcileAttemptAfter(attempts, new Date());
    await fencedGroup(deps, async (r) => {
      await r.recordAudit(
        accountId,
        "reconcile.move.failed",
        {
          messageId: p.messageId,
          from: p.nativeLocator,
          to: p.desiredFolder,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          attempts, nextAttemptAt: nextAttemptAt.toISOString(),
        },
        null,
      );
      await r.deferFolderReconcile(p.messageId, { attempts, nextAttemptAt });
    });
    return;
  }

  // THE MOVE LANDED. Its completion is ONE FACT — locator, converged state and audit row commit
  // together or not at all. {@link fencedGroup} carries the argument, including which side leads
  // in the seam a transaction cannot cover (the server's, always).
  try {
    await fencedGroup(deps, async (r) => {
      await r.updateLocator(p.messageId, newLoc);
      await r.upsertFolderState(p.messageId, { desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us" });
      await r.recordAudit(
        accountId, "reconcile.move",
        { messageId: p.messageId, from: p.nativeLocator, to: p.desiredFolder, newLocator: newLoc },
        { action: "move", locator: newLoc, toFolder: p.nativeLocator!.folder },
      );
    });
  } catch (err) {
    rethrowFenced(err);
    // The mail moved and we failed to write that down. Nothing was written (the group is a
    // transaction), the row is left pending and DUE — not deferred — and the next cycle converges
    // it: the source copy is gone, so the retry raises `MessageGoneError` and `changesSince`
    // adopts what the server actually shows. This is byte-identical to a crash in the same place,
    // which is the convergence this module has always relied on.
    //
    // Not rethrown, because a bookkeeping failure on one message is not a reason to abandon the
    // filing of every message behind it — the whole finding this arm belongs to.
    log?.error("reconcile_move_uncommitted", {
      mailboxId, accountId, messageId: p.messageId, to: p.desiredFolder, err,
      reason: "the IMAP move succeeded and its bookkeeping did not commit; the row stays pending " +
        "and due, and the next cycle adopts the completed move",
    });
  }
}

/**
 * Push OUR intended read-state to IMAP — the `\Seen` mirror of `reconcileFolders`, and the
 * reason `PATCH /messages` can write intent and stop.
 *
 * The `lastSetBy !== "us"` guard is the SAME user-wins rule, and it is not a formality here: an
 * external row is written by `applyExternalFlag` precisely when the server disagreed with us,
 * so pushing one would mean marking read again a message the user deliberately marked unread
 * in another client. Drop this line and the product argues with its user in a loop.
 *
 * Deliberately AFTER the folder pass: a message that is moving has a locator that is about to
 * change, and `reconcileFolders` has just written the new one, so this reads the fresh value
 * instead of a UID the STORE would miss.
 */
async function reconcileFlags(deps: SyncDeps): Promise<void> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  const pending = await repo.listPendingFlagStates(mailboxId);
  for (const p of pending) {
    if (p.lastSetBy !== "us") continue;                       // user-wins: never revert an external \Seen
    if (p.desiredSeen === p.observedSeen) {
      await fencedWrite(deps, (r) => r.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us" }));
      continue;
    }
    if (!p.nativeLocator) continue;
    try {
      await fenceImapMutation(deps);
      await adapter.setFlags(p.nativeLocator, { seen: p.desiredSeen });
    } catch (err) {
      // A fence refusal is proof of lost leadership, never evidence about this message. It is the
      // ONE throw that still leaves this loop, and it must leave it unreclassified.
      rethrowFenced(err);
      if (err instanceof MessageGoneError) {
        // The message left this locator between the DB read and the STORE. Mid-move, the next
        // changesSince refreshes the locator and this retries. Expunged outright, no refresh is
        // ever coming — voidGoneFiling's argument, one flag over — so the intent is voided the
        // same way rather than re-STOREd (one IMAP round trip per cycle) for ever.
        await fencedGroup(deps, async (r) => {
          if (!(await r.primaryInstanceVanished(p.messageId))) return;
          await r.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us" });
          await r.recordAudit(
            accountId, "reconcile.flags.voided",
            { messageId: p.messageId, locator: p.nativeLocator, seen: p.desiredSeen },
            null,
          );
        });
        continue;
      }
      if (isTransportFailure(err)) {
        // The host or our database, not this message. Row untouched and still due — see the same
        // arm in `fileOne` for why an outage may not be converted into a per-message deferral, and
        // why the pass continues rather than aborting the cycle.
        log?.warn("reconcile_flag_transport_failure", {
          mailboxId, accountId, messageId: p.messageId, seen: p.desiredSeen, err,
        });
        continue;
      }
      // ── THE RETHROW THAT USED TO BE HERE WAS A MAILBOX-WIDE OUTAGE PER MESSAGE ──────────
      //
      // Anything that was not a `MessageGoneError` left this loop, so it left `reconcileMailbox`,
      // so it failed the whole cycle. One message whose `\Seen` the server refuses therefore
      // meant: no other pending read-state reached the server, the folder pass's `owesMore`
      // re-kick was discarded on the way out (it is returned by the call BEFORE this one), and
      // `index.ts` counted a mailbox failure — every cycle, until the mailbox was detached and
      // quarantined. Restart reconciliation reached the same row and did it again. The mailbox
      // never got back to a steady state, and the reason was one flag on one message.
      //
      // The folder pass was given per-item isolation for exactly this and this loop was not, which
      // is the asymmetry that made a refused STORE strictly more destructive than a refused MOVE.
      // Same treatment now, deferral included: record it, sleep it on the widening schedule, keep
      // going. The user's intent survives — `desired_seen` is untouched and the row stays pending
      // — so a host that starts accepting the STORE converges then.
      const attempts = (p.attempts ?? 0) + 1;
      const nextAttemptAt = nextReconcileAttemptAfter(attempts, new Date());
      await fencedGroup(deps, async (r) => {
        await r.recordAudit(
          accountId,
          "reconcile.flags.failed",
          {
            messageId: p.messageId,
            locator: p.nativeLocator,
            seen: p.desiredSeen,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            attempts, nextAttemptAt: nextAttemptAt.toISOString(),
          },
          null,
        );
        await r.deferFlagReconcile(p.messageId, { attempts, nextAttemptAt });
      });
      continue;
    }

    // THE STORE LANDED. Its bookkeeping is one fact — the converged flag and its audit row commit
    // together or not at all — and a failure to write it is NOT the message's failure, so it is
    // never deferred. `fileOne`'s completion arm carries the full argument; one flag over, the
    // convergence is the inbound mirror: the server's `\Seen` is what the next `changesSince`
    // reports, and `applyExternalFlag` adopts it.
    try {
      await fencedGroup(deps, async (r) => {
        await r.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us" });
        await r.recordAudit(
          accountId, "reconcile.flags",
          { messageId: p.messageId, locator: p.nativeLocator, seen: p.desiredSeen },
          { action: "setFlags", locator: p.nativeLocator, seen: !p.desiredSeen },
        );
      });
    } catch (err) {
      rethrowFenced(err);
      log?.error("reconcile_flag_uncommitted", {
        mailboxId, accountId, messageId: p.messageId, seen: p.desiredSeen, err,
        reason: "the IMAP STORE succeeded and its bookkeeping did not commit; the row stays " +
          "pending and due, and the server's own flag is adopted on a later cycle",
      });
    }
  }
}
