import {
  planChange, commitChange, isOrganizedFolder, MAX_RAW_MESSAGE_BYTES,
  type Change, type ChangePlan, type ClassifierPort, type CommitDeps, type CreditGate,
  type Logger, type OhboxPolicy, type StorageCap,
} from "@trafficflow/core/mail";
import {
  WATCHED_FOLDERS, MessageGoneError, parseRef, FILING_BATCH_MAX,
  epochOf, epochVerdict, sameEpoch, UNKNOWN_EPOCH, type Epoch,
  type ImapCursor, type KnownEntry, type MailboxAdapter, type PersistedFolderCursor,
} from "@trafficflow/core/adapters/imap";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
// The role vocabulary lives in `@trafficflow/db` (mail 0083) because both the worker and the
// services layer need one spelling of it and the worker may not import services at runtime —
// `stand-down-sends.ts`'s reason, and the module reaches `schema-mail.js` alone. A type-only
// import, so nothing of the db package enters this file's runtime graph.
import type { FilingRefusalClass, OrganizerRole } from "@trafficflow/db";
import type { WorkerRepo, DrizzleRepo, PendingFolderState, PendingFlagState } from "@trafficflow/core/adapters/drizzle-repo";
import { ClassifierFaultError } from "./classifier-fault.js";
import {
  DeadLetterLedger, classifyIngestFault, nextAttemptAfter,
  DETERMINISTIC_MESSAGE_FAILURE_CODES, MAX_MESSAGE_RETRIES_PER_CYCLE,
} from "./dead-letter.js";
import { KnownSetCache, watchKnownSet } from "./known-set.js";
// `./build-version.js` and NOT `./config.js`, which re-exports the same symbol: `config.ts` imports
// the bare `@trafficflow/core` barrel, and `apps/sidecar` imports THIS file as
// `@trafficflow/worker/sync`. Naming config here would put the classifier and the drafter into the
// shipped desktop engine's import closure from three modules away.
import { buildVersionOf } from "./build-version.js";
import {
  completeFiling, junkAuditCode, physicalDestination, specialFoldersOf,
  SPAM_PILE, TOMBSTONE_MAX_PER_CYCLE, type SpecialFolderMap,
} from "./junk-filing.js";
import { junkRestorePass } from "./junk-restore.js";
import { folderOpsPass } from "./folder-ops.js";
import {
  assertMayWriteToMailbox, OrganizerStandDownError,
  type MailboxWriteAuthority, type OrganizerWriteAuthority,
} from "./lease.js";

/**
 * The leader fence over mail-bearing writes. One process at a time organizes a mailbox, under an
 * advisory-lock lease per shard; a lease can end mid-cycle and the loser does not learn synchronously.
 * Until this seam, only the mailbox LIFECYCLE columns were fenced — a worker that had lost its shard
 * kept committing messages, advancing cursors, appending `change_log` and issuing IMAP moves beside a
 * new leader. `SyncDeps.fence` is the seam; ABSENT ⇒ unfenced (the standalone desktop engine has no
 * shard to lose, the reconcile cron runs only while no worker leads). Three rules: every database write
 * rides `fencedWrite`/`fencedIngest`, refusing from a FRESH snapshot even after a lock wait (hence
 * transaction-shaped); every IMAP mutation is preceded by `fenceImapMutation` (a fresh check whose residual converges like a crash); and `lost()` is the SYNCHRONOUS tripwire. A refusal aborts the WHOLE cycle.
 */
export class LeaderFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaderFencedError";
  }
}

/**
 * The mailbox this cycle is reading has been REMOVED — thrown from inside the commit's own
 * transaction by {@link assertMailboxStillHere}, aborting the whole cycle. The lease answers WHO
 * may organize a mailbox, not whether it is still there: a removal landing while an arrival awaited
 * classification left a tombstoned row, an emptied mirror, and the pending ingest committing that
 * message anyway — mail left on the machine. Standalone installs wait the pass out first
 * (`quiesce`); this is the ONLY thing holding on a hosted worker, where the removal happens in
 * another process that cannot wait for anything.
 */
export class MailboxRemovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxRemovedError";
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
  /**
   * What this install is to this mailbox — its ORGANIZER, or a READER of it (mail 0083). Reader sync
   * is a MODE of this one pipeline, never a second loop: same cursor, batch, dedup, commit,
   * `change_log`. What the mode changes is what the cycle is ENTITLED to do. A reader cycle SKIPS
   * `reconcileFolders`, the user-commanded folder-ops pass and the one-time junk sweep (IMAP writes an
   * organizer executes) and — at the composition roots — `ensureFolders`, `sendScheduled`, the
   * kickstart, every retro pass and the profile publish. It KEEPS the ingest (a reader's mirror must
   * GROW), the inbound read-state adopt, the reaper, the dead-letter ledger, every cursor write, and
   * `reconcileFlags` (the reader's ONE IMAP write verb). REQUIRED: an omitted `role` reads as ORGANIZER, and an organizer that is not the organizer is two installs moving one person's mail.
   */
  role: OrganizerRole;
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
   * `providerAuthservIds(<the IMAP host this connection dials>)`, resolved where the adapter is built
   * and threaded into `planChange`. REQUIRED, unlike every optional field around it, because for this
   * one the absent-config default IS the dangerous branch: an empty set makes `authVerdictFromHeaders`
   * answer `"unavailable"` for every message, the demote-only branch never fires, and a forged
   * known-contact `From` inherits that contact's Ohbox admission. Optional-with-a-default is how all
   * five production sites shipped inert; a caller that has genuinely decided to trust nothing types
   * `NO_TRUSTED_AUTHSERV_IDS` — the "somebody has to type the empty set" rule.
   */
  trustedAuthservIds: ReadonlySet<string>;
  /**
   * The account's managed storage cap, threaded into `commitChange` — REQUIRED, on
   * `trustedAuthservIds`'s exact argument one field up: for a storage cap the absent-config
   * default IS the dangerous branch (a wiring refactor that dropped an optional field would
   * silently unmeter the hosted store), so a caller that has genuinely decided not to meter
   * types `UNMETERED_STORAGE_CAP` — the sidecar's local engine, the self-host worker, and
   * every test that is not about the cap. The hosted worker resolves it per account per cycle
   * (`index.ts`, from the subscription row via `storageCapOf`) — one read, not one per
   * message, on `screeningCutoff`'s resolved-once-per-cycle discipline.
   */
  storageCap: StorageCap;
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
   * A found FOREIGN organizer profile's import decision is open for this mailbox, so the consent
   * gate adopts placement instead of re-screening it — see `PlanDeps.importDecisionOpen`
   * (TAKEOVER-RESCREEN) for the defect and the boundaries. ABSENT ⇒ inert ⇒ byte-identical
   * routing for the reconcile backstop and every test. The hosts resolve it per cycle from the
   * profile hold's own state (`profile.ts#OrganizerProfileSync.importDecisionOpen`), the same
   * one-reading discipline as `screeningCutoff` above.
   */
  importDecisionOpen?: boolean;
  /**
   * The per-message terminal-failure ledger, one per attached mailbox. ABSENT ⇒ ONE PER CALL, not "no
   * boundary": `apps/sidecar` imports this loop (the desktop engine and the hosted worker run one
   * pipeline) and several tests call `runSyncCycle` directly, so a boundary that only existed when a
   * caller remembered to inject a ledger would leave the wedge in place for every one of them. What a
   * caller-supplied ledger adds is MEMORY ACROSS CYCLES: attempt counts that accumulate, and skipped
   * UIDs that stay out of the known-set so their bodies are not re-fetched every pass (see {@link
   * DeadLetterLedger}).
   */
  deadLetters?: DeadLetterLedger;
  /**
   * The in-memory memo of this mailbox's known-set — one per attached mailbox, beside {@link
   * deadLetters} and for the same reason: per-attachment state whose lifetime is the design. ABSENT ⇒
   * EVERY CYCLE RE-READS `listKnownLocators`, byte-identically to before this field — the direction an
   * omission must fail in, and what the reconcile backstop and every test rely on. Present ⇒ the read
   * is served from memory for as long as nothing this process wrote could have changed it, and it is
   * DROPPED on every leadership-relevant event (a fence refusal, the lock-loss tripwire, a database
   * fault, any throw, detach and stand-down; see `known-set.ts`). Never served across an organizer
   * handover: `index.ts` re-verifies the lease before every cycle and builds a fresh cache per attach.
   */
  knownSet?: KnownSetCache;
  /**
   * WHAT THIS CYCLE DID, counted — see {@link CycleCensus}. ABSENT ⇒ nothing is counted and every
   * path runs as it did before this field; present ⇒ the caller folds the totals into its own
   * drain line. A measurement seam, never a behaviour one: nothing in this file reads it back.
   */
  census?: CycleCensus;
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
  /**
   * THE ORGANIZER LEASE THIS CYCLE WRITES UNDER — a permit, or the named reason there is none. The
   * fence above answers worker-to-worker; this answers install-to-install, and only this one can
   * stop a process writing to a mailbox its owner has moved to another machine. REQUIRED, on
   * `role`'s exact argument one field down: while it was optional the hosted cycle received none,
   * every boundary inside it read `not_supplied` — which `assertMayWriteToMailbox` ADMITS — and a
   * handover mid-scan left both installs moving one person's mail. A composition that holds no lease
   * types the reason; `lease-write-permit-census.test.ts` refuses a production `runSyncCycle(` call
   * whose own argument list does not name this field.
   */
  writeAuthority: OrganizerWriteAuthority;
  /** Structured log sink. Absent ⇒ a skip is still recorded in `audit_log`, just not logged. */
  log?: Logger;
  /**
   * THE ONE-TIME SWEEP'S COMMAND PORT (FOLDERS-SPEC.md §16.1) — how this cycle learns that
   * the account's user pressed the Quarantine→\Junk offer, runs the sweep, and retires the press.
   * Built where the database handle lives (the hosted worker's composition root, `index.ts`);
   * ABSENT ⇒ no sweep command is ever consumed by this cycle, which is the right answer for every
   * composition that has no such offer (the sidecar's local engine has no folders flag to show it
   * behind; tests). The stamp itself is `mailboxes.junk_sweep_requested_at` (mail 0076).
   */
  junkSweep?: JunkSweepCommandPort;
}

/** See {@link SyncDeps.junkSweep}. */
export interface JunkSweepCommandPort {
  /**
   * The stamp as the SERVER renders it (`::text`), or null when no press is owed. Text, not a
   * Date: the clear compares against exactly this token, and a JS `Date` loses the microseconds
   * a Postgres timestamptz keeps (`sync-kick.ts` measured the miss). A mailbox switched off
   * under "Use folders" since the press answers null too (and the port retires the stale stamp
   * itself): an opted-out mailbox performs no move on the feature's account.
   */
  requested(): Promise<string | null>;
  /**
   * Run ONE BOUNDED SLICE of the sweep — `junkSweepPass` with `execute: true` and a per-cycle
   * limit — under the cycle's fences: `writeAuthority` is what every IMAP mutation asks, `write`
   * the fenced group every completion write rides.
   */
  run(hooks: {
    writeAuthority: MailboxWriteAuthority;
    write: <T>(fn: (repo: WorkerRepo) => Promise<T>) => Promise<T>;
    /**
     * The observed press token — the same text `requested()` answered. Passed in because the scan
     * state that crosses cycles (cursor, moved-since-top, the deferral allowance) belongs to ONE press
     * and the implementation had no way to tell one press from the next. Review found the consequence:
     * a command that exhausted its deferral allowance and retired left the counter at its ceiling on a
     * still-live attachment, so the person's NEXT press inherited a spent allowance and its first barren
     * scan retired it immediately — a fresh command that never got the retries it was entitled to. A
     * re-stamp mid-scan inherited the old cursor for the same reason.
     */
    command: string;
  }): Promise<{
    moved: string[];
    skipped: ReadonlyArray<unknown>;
    junkFolder: string | null;
    /**
     * How many of `skipped` were skipped because the SOURCE LOCATOR WAS STALE rather than because
     * the server refused the move — THIS WINDOW's count, straight from
     * `JunkSweepResult.deferred`, which carries the full argument. Reported for the operator, and
     * deliberately NOT what the retirement decision reads: see {@link deferralsHold}.
     */
    deferred: number;
    /**
     * Whether a deferral should still hold the user's press open. A SEPARATE FIELD FROM THE COUNT,
     * and the split is the point — two different things were being asked of one number and it could
     * not answer both honestly: the count is per WINDOW, and the retirement decision needs the whole
     * SCAN (the cursor moves past a deferred row, so a final window truthfully reports zero while the
     * row it deferred is still in the pile — `SweepScanState.deferredSinceTop`); and the exemption is
     * BOUNDED (`SWEEP_MAX_DEFERRED_SCANS`), so after three barren scans a deferral must stop holding
     * the press even though the count is non-zero. Folding both into the count made the number an
     * operator reads and the number the decision reads the same, and then one of them was a lie.
     */
    deferralsHold: boolean;
    /**
     * TRUE only when this run looked at EVERY remaining candidate (a scan from the top that ran
     * off the end, or a mailbox with no Junk folder to move into). A run that moved nothing
     * WITHOUT this is an unfinished scan — the stamp stands and the mailbox is re-kicked.
     */
    examinedAll: boolean;
  }>;
  /** How many movable candidates the pile still holds AFTER the slice — what decides retirement. */
  remaining(): Promise<number>;
  /** Retire ONLY the observed stamp — a press that landed mid-sweep survives for the next cycle. */
  clear(observed: string): Promise<void>;
}

/**
 * Reconstruct the adapter cursor from the DB each cycle (never reuse an in-memory UID across a move).
 * The folder list is the UNION, not `WATCHED_FOLDERS`: the adapter also reads the mailbox's own Sent
 * folder, whose server-specific path cannot be a constant, and `changesSince` persists a cursor row
 * for it — so if this only rebuilt the six frozen names, that row would be written every cycle and
 * read by none, and the Sent branch would fall back to its FIRST-SCAN path every cycle, re-enumerating
 * (and re-FETCHING) the whole history window. The known-set is EPOCH-PURE: a UID means nothing outside
 * the server epoch that issued it, and reducing locators to `{uid, messageId}` discarded that — a
 * reused UID under a new epoch looked already-known and its body was never fetched. So the cursor's `uidValidity` is the epoch its remembered UIDs belong to, and only those entries are handed over.
 */
/**
 * WHAT ONE CYCLE ACTUALLY DID. Measurement, not behaviour: absent ⇒ nothing is counted and every
 * path is unchanged. `cursorBuilds` counts {@link buildCursor} calls, `locatorReads` the ones that
 * went to the store for the whole projection and `locatorRows` the rows those returned — the
 * QUERIES and the ROWS TOUCHED; `cursorFolders` the per-folder arrays rebuilt, the DERIVATIONS;
 * `observed` what the adapter handed over. A tick over a mailbox where nothing changed reads zero,
 * touches zero rows, derives nothing and observes nothing. Anything else is a mailbox that moved,
 * or a gate that stopped working.
 */
export interface CycleCensus {
  cursorBuilds: number;
  locatorReads: number;
  locatorRows: number;
  cursorFolders: number;
  observed: number;
}

/** A zeroed {@link CycleCensus} — one per drain, folded into the caller's own log line. */
export function newCycleCensus(): CycleCensus {
  return { cursorBuilds: 0, locatorReads: 0, locatorRows: 0, cursorFolders: 0, observed: 0 };
}

export async function buildCursor(
  repo: WorkerRepo, mailboxId: string, deadLetters?: DeadLetterLedger, census?: CycleCensus,
  memo?: KnownSetCache,
): Promise<ImapCursor> {
  const folderRows = await repo.getMailboxFolders(mailboxId);
  const names = new Set<string>(WATCHED_FOLDERS);
  for (const r of folderRows) names.add(r.folder);
  if (census !== undefined) census.cursorBuilds += 1;

  /**
   * THE PROJECTION IS READ ONLY WHEN THE ANSWER IS NOT ALREADY DERIVED. Grouping the whole
   * projection by folder and filtering each group to its folder's epoch is proportional to the
   * MAILBOX, and it ran every cycle to produce, for a settled mailbox, the arrays it produced last
   * time. {@link KnownSetCache} holds them against the generation of the set they came from. The
   * precondition is narrow: every folder's ROW EPOCH must match what it was, because that is the
   * input the resolution was taken from. Anything else takes the read — what this function did on
   * every cycle before there was a memo, and what every caller without one still does.
   */
  const derived = memo?.derivedFolders() ?? null;
  const epochs = new Map<string, string>();
  const rowEpochs = new Map<string, string | null>();
  for (const f of names) {
    const e = epochOf(folderRows.find((r) => r.folder === f)?.uidValidity);
    rowEpochs.set(f, e.known ? e.value : null);
  }
  let readOwed = true;
  if (derived !== null && derived.rowEpochs.size === rowEpochs.size) {
    readOwed = false;
    for (const [f, cur] of rowEpochs) {
      // The row epoch is the INPUT the resolution was taken from — equal inputs over a locator set
      // that has not moved give the same answer, and anything else is a read. A folder whose row
      // names NO epoch is included by this: its answer was derived from the entries, and the same
      // entries derive it again.
      if (derived.rowEpochs.get(f) !== cur) { readOwed = true; break; }
      const was = derived.resolved.get(f);
      if (was === undefined) { readOwed = true; break; }
      epochs.set(f, was);
    }
  }

  const knownByFolder = new Map<string, Array<{ uid: number; uidValidity: string; messageId: string | null; seen: boolean | null }>>();
  if (readOwed) {
    epochs.clear();
    /* WARM IS READ BEFORE THE READ, not after it: the read is what makes it warm, so asking
       afterwards answers "yes" every time and the counter says nothing. */
    const servedFromMemory = memo?.warm === true;
    const known = await repo.listKnownLocators(mailboxId);
    if (census !== undefined) {
      if (!servedFromMemory) census.locatorReads += 1;
      census.locatorRows += known.length;
    }
    for (const k of known) {
      const arr = knownByFolder.get(k.folder) ?? [];
      arr.push({ uid: k.uid, uidValidity: k.uidValidity, messageId: k.messageId, seen: k.seen });
      knownByFolder.set(k.folder, arr);
    }
    for (const f of names) {
      epochs.set(f, rowEpochs.get(f) ?? soleEpochOf(knownByFolder.get(f) ?? []));
    }
  }

  const fresh = new Map<string, KnownEntry[]>();
  const folders: ImapCursor["folders"] = {};
  for (const f of names) {
    const row = folderRows.find((r) => r.folder === f);
    const epoch = epochs.get(f) ?? "0";
    folders[f] = {
      uidValidity: epoch,
      uidNext: row?.uidNext ?? 0,
      highestModseq: row?.highestModseq ?? "0",
      known: knownFor(f, epoch, knownByFolder.get(f) ?? [], derived?.byFolder ?? null, fresh, deadLetters, census),
    };
  }
  // A derivation is remembered only when it was built from a READ — a pass that reused the last
  // one has nothing new to say, and rewriting it would stamp old arrays with a new generation.
  if (readOwed) memo?.rememberFolders(fresh, rowEpochs, epochs);
  return { folders };
}

/**
 * One folder's known list: the epoch-matched locators, then the UIDs this process has written off.
 *
 * `seen` rides along as the flag baseline the no-CONDSTORE fallback diffs against
 * (`KnownEntry.seen`). Dead-letter entries carry none, which is correct: nothing was ever ingested
 * for them, so no baseline can be stated and none may be diffed. Leaving them out is what made one
 * poison message cost a full body fetch on every cycle for ever; they are epoch-matched for the
 * same reason the real locators are. See `DeadLetterLedger`.
 */
function knownFor(
  folder: string, epoch: string,
  entries: ReadonlyArray<{ uid: number; uidValidity: string; messageId: string | null; seen: boolean | null }>,
  derived: Map<string, KnownEntry[]> | null,
  fresh: Map<string, KnownEntry[]>,
  deadLetters?: DeadLetterLedger,
  census?: CycleCensus,
): KnownEntry[] {
  // An UNNAMED epoch means nothing remembered may be presented as known — the adapter would read a
  // bare number as belonging to whatever epoch it is looking at. `!== "0"` missed the
  // `String(undefined)` a silent server persists, so those UIDs were handed over as facts.
  if (!epochOf(epoch).known) return [];
  const key = `${folder}\u0000${epoch}`;
  const reused = derived?.get(key);
  if (reused === undefined && census !== undefined) census.cursorFolders += 1;
  const locators = reused
    ?? entries.filter((e) => sameEpoch(epochOf(e.uidValidity), epochOf(epoch)))
      .map((e) => ({ uid: e.uid, messageId: e.messageId, seen: e.seen }));
  fresh.set(key, locators);
  const dead = deadLetters?.knownFor(folder, epoch) ?? [];
  // Handed over AS IT STANDS when there is nothing to append — the adapter treats the cursor as
  // read-only, and a copy per folder per cycle is the very cost this derivation was memoized to
  // stop paying.
  return dead.length === 0 ? locators : [...locators, ...dead];
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
  let sole: Epoch = UNKNOWN_EPOCH;
  for (const e of entries) {
    const cur = epochOf(e.uidValidity);
    if (!cur.known) return "0";
    if (!sole.known) sole = cur;
    else if (!sameEpoch(sole, cur)) return "0";
  }
  return sole.known ? sole.value : "0";
}

/** The folder + epoch a change was observed at. */
function siteOf(ch: Change): { folder: string; uidValidity: string; uid: number } {
  const { uidValidity, uid } = parseRef(ch.locator.ref);
  return { folder: ch.locator.folder, uidValidity, uid };
}

type FenceScope = Pick<SyncDeps, "repo" | "fence" | "knownSet">;

/** {@link FenceScope} plus the mailbox the removal fence asks about — see {@link fencedLiveGroup}. */
type LiveScope = FenceScope & Pick<SyncDeps, "mailboxId">;

/**
 * `repo.transaction`, fenced: the ingest and flag transactions run INSIDE the fence's own
 * transaction, so the leadership verdict and the writes it authorizes commit or vanish together.
 */
async function fencedIngest<T>(deps: FenceScope, fn: (repo: DrizzleRepo) => Promise<T>): Promise<T> {
  if (!deps.fence) return deps.repo.transaction(fn);
  return underFence(deps, fn);
}

/**
 * A group of writes that must not tear — transactional whether or not there is a fence, and reached only
 * through {@link fencedLiveGroup} now. A second helper beside this one routed a SINGLE write with no
 * transaction when unfenced, and a bare statement cannot carry the removal fence: a status read outside
 * the write's own transaction proves nothing about it. The bookkeeping after an IMAP mutation is not one
 * statement, and unfenced those were separate top-level awaits — a crash between two left a
 * `folder_state` still pending while the locator named the destination, or a move with no audit row. So
 * a group commits or it does not exist. IMAP leads and the database records what was observed; the
 * opposite order shows a message in a folder it is not in, for ever.
 */
async function fencedGroup<T>(deps: FenceScope, fn: (repo: WorkerRepo) => Promise<T>): Promise<T> {
  if (!deps.fence) return deps.repo.transaction(fn);
  return underFence(deps, fn);
}

/**
 * And this is where the known-set memo meets the fence. Two things happen here `deps.repo` alone
 * cannot: the repo the FENCE hands its callback is built over the transaction's own connection, so it
 * is not the object `runSyncCycle` wrapped — it is wrapped HERE instead, which puts the ingest and
 * reconcile groups (nearly every write) under the memo's classification. And a refusal DROPS the memo:
 * both refusal arms prove this process may no longer be the organizer, and an in-memory copy of a
 * mailbox's known-set is exactly what must not survive a handover (the successor is free to write those
 * rows). Dropping costs one query on the next cycle this process is allowed to run — and if it never
 * runs one, nothing at all.
 */
async function underFence<T>(deps: FenceScope, fn: (repo: DrizzleRepo) => Promise<T>): Promise<T> {
  const fence = deps.fence as SyncWriteFence;
  if (fence.lost()) {
    deps.knownSet?.drop("lease-lost");
    throw new LeaderFencedError("the leader lease is gone — this write is refused before it is attempted");
  }
  const cache = deps.knownSet;
  const out = await fence.transaction(cache ? (r) => fn(watchKnownSet(r, cache)) : fn);
  if (out.fenced) {
    deps.knownSet?.drop("fenced");
    throw new LeaderFencedError("the heartbeat no longer names this instance as the shard leader — the write was refused");
  }
  return out.result;
}

/**
 * The LEADERSHIP half — see the fence block at the top of this file for what its admission can and
 * cannot promise, and why the residual it cannot close converges. Reached only through
 * {@link writeAuthorityOf}, so no write site asks leadership without asking the lease.
 */
async function fenceImapMutation(deps: Pick<SyncDeps, "fence">): Promise<void> {
  const { fence } = deps;
  if (!fence) return;
  if (fence.lost() || !(await fence.stillLeader())) {
    throw new LeaderFencedError("this instance no longer leads its shard — the IMAP mutation is not issued");
  }
}

/**
 * THIS CYCLE'S WRITE AUTHORITY — the two halves assembled for {@link assertMayWriteToMailbox}.
 *
 * Built per ask rather than once per cycle: `deps.fence` and `deps.writeAuthority` are read off the
 * deps object every time, so a re-dialled or re-gated cycle is served by what it now holds.
 */
function writeAuthorityOf(deps: Pick<SyncDeps, "fence" | "writeAuthority">): MailboxWriteAuthority {
  const { fence } = deps;
  return {
    ...(fence ? { fence: (): Promise<void> => fenceImapMutation({ fence }) } : {}),
    // The field is REQUIRED, so this coalesce is reached only by a FIXTURE — the same reading
    // `role`'s omission gets, and named rather than silent. A production root that omitted it is
    // refused by `lease-write-permit-census.test.ts`, not by this line.
    lease: deps.writeAuthority ?? { noLease: "not_supplied" },
  };
}

/** The passes a cycle writes in — the vocabulary its stand-down verdict names a place with. */
export type CyclePass = "folder_ops" | "junk_sweep" | "filing" | "flags";

/**
 * WHERE THIS CYCLE WAS WHEN IT LAST ASKED THE LEASE — one mutable cursor per cycle, advanced at the
 * head of every page of writes and read once, by the cycle's own stand-down catch.
 *
 * A PAGE is the unit the permit is re-asked at: for filing one `moveMany` group (or one message of a
 * group that fell back to the per-message path), for flags one `\Seen` STORE. The two user-commanded
 * passes ask inside themselves and report as ONE page each, the slice they run per cycle. That is the
 * whole bound this carries: no write in a cycle is more than one page past a lease that has gone.
 */
export interface CyclePageCursor {
  /** The pass whose page is open, or `null` before the cycle's first page of writes. */
  pass: CyclePass | null;
  /** The 1-based page within that pass; 0 before the first page opens. */
  page: number;
}

/** A cursor for one cycle. A caller that runs `reconcileMailbox` alone gets its own. */
export const freshCyclePages = (): CyclePageCursor => ({ pass: null, page: 0 });

/**
 * Open the next page of a pass. Called IMMEDIATELY BEFORE the write predicate at every boundary and
 * never through a wrapper around it: `lease-write-permit-census.test.ts` asserts the predicate has
 * exactly one spelling and reads its call inside each writing function, so a helper that asked it on
 * their behalf would satisfy that census by proxy. Two lines, in this order, so a refusal names the
 * page it refused rather than the last one it admitted.
 */
function openPage(at: CyclePageCursor, pass: CyclePass): void {
  at.page = at.pass === pass ? at.page + 1 : 1;
  at.pass = pass;
}

/**
 * Rethrow a REFUSAL out of a catch arm that would otherwise swallow it or read it as a message fault.
 * Four classes the arms cannot tell from an ordinary failure: `LeaderFencedError` is proof this process
 * no longer leads the shard, `MailboxRemovedError` that the mailbox is gone, and the permit's own two —
 * `OrganizerStandDownError` (another install holds this mailbox now) and `LeaseUnavailableError` (the
 * lease could not be read, which is not a stand-down and equally not evidence about a message). None is
 * evidence about the message or the pass, all four mean every later write in this cycle would be
 * illegitimate, and all are terminal for it — `index.ts` and `reconcile-cron.ts` read them as a skip,
 * not a failing mailbox. ONE PLACE DECIDES, because the swallowing arms are many: three reconcile groups
 * logged a removal as bookkeeping that "did not commit" and carried on writing into a mailbox that had
 * gone, and `fileOne`/`reconcileFlags` recorded a stand-down as the MESSAGE's refusal — a deferral, an
 * audit row blaming the mail server, and the pass filing every row behind it on somebody else's mailbox.
 */
function rethrowRefusal(err: unknown): void {
  if (
    err instanceof LeaderFencedError || err instanceof MailboxRemovedError
    || err instanceof OrganizerStandDownError || err instanceof LeaseUnavailableError
  ) throw err;
}

/**
 * THE MAILBOX IS STILL HERE — asked inside the commit's transaction, never before it. `planChange`
 * reads and classifies outside any transaction, so a removal can land between planning a message
 * and committing it. The row is taken at `share` strength so the two transactions ORDER rather than
 * overlap: this commit holds the row and the removal waits, or the removal holds it and this reads
 * the tombstone. REFUSED on `disabled` (a removal or plan-disable) and on NO ROW (the erasure
 * sweep's answer); admitted on everything else. `error` is admitted deliberately — it means ohmail
 * cannot currently REACH the mailbox, the ordinary state a recovering cycle commits from, and
 * refusing there would turn a transient outage into mail this pass never writes.
 */
async function assertMailboxStillHere(repo: WorkerRepo, mailboxId: string): Promise<void> {
  refuseRemovedMailbox(await repo.mailboxStatusForWrite(mailboxId));
}

/**
 * THE ONE PLACE THAT DECIDES what a status means for a write — the read above and the folded
 * read inside the change-log allocation both end here, so the two cannot drift into two answers.
 */
function refuseRemovedMailbox(status: string | null): void {
  if (status !== null && status !== "disabled") return;
  throw new MailboxRemovedError(
    `this mailbox is ${status === null ? "gone" : status} — the write is refused rather than `
    + "committed into a mailbox that has been removed",
  );
}

/**
 * ONE PLANNED MESSAGE, COMMITTED BEHIND THE FENCE — the only door the ingest commits through. A
 * `new` message FOLDS the fence into the change-log allocation the branch already sends, so it pays
 * no round trip for it. Sound THERE AND ONLY THERE: that branch's first write is the `messages`
 * INSERT, whose foreign key takes the mailbox row before anything else in the transaction, so
 * asking at the allocation cannot invert the lock order against `MailboxService.delete`. Every
 * other shape asks FIRST — a repair holds a `messages` row well before the allocation, and an
 * erasing removal waiting on it would deadlock (measured: 40P01, the erasure as victim). A lost
 * upsert is asked afterwards all the same, so every commit asks exactly once.
 */
async function commitFenced(plan: ChangePlan, txRepo: DrizzleRepo, deps: CommitDeps): Promise<void> {
  const mailboxId = deps.mailboxId;
  if (plan.outcome !== "new") {
    await assertMailboxStillHere(txRepo, mailboxId);
    await commitChange(plan, deps);
    return;
  }
  let asked: string | null | undefined;
  await commitChange(plan, {
    ...deps,
    mailboxMustBeLive: {
      mailboxId,
      answer: (status) => { asked = status; refuseRemovedMailbox(status); },
    },
  });
  if (asked === undefined) await assertMailboxStillHere(txRepo, mailboxId);
}

/**
 * EVERY OTHER WRITE THE CYCLE MAKES, BEHIND THE SAME FENCE — {@link commitFenced} is the door for a
 * PLANNED message and this is the door for everything else: junk restores, locators, `folder_state`,
 * `flag_state`, audit rows, delete evidence, cursors, failure records. Two passes used to write without
 * asking, planning from reads taken outside every transaction, so a removal in that gap committed into a
 * mailbox just removed; a check at the head of the cycle would not close it, which is why the question
 * belongs INSIDE the writing transaction. ASKED FIRST IS THE LOCK ORDER: `MailboxService.delete` takes
 * the mailbox row `FOR UPDATE` first, so a writer holding a message row and then asking would be its
 * deadlock partner (40P01), not its refusal. ONE READ PER TRANSACTION, not per row.
 */
async function fencedLiveGroup<T>(deps: LiveScope, fn: (repo: WorkerRepo) => Promise<T>): Promise<T> {
  return fencedGroup(deps, async (repo) => {
    await assertMailboxStillHere(repo, deps.mailboxId);
    return fn(repo);
  });
}

/**
 * One sync pass. Returns whether the adapter still owes a backlog: a first sync is drained in bounded
 * batches (`DEFAULT_SYNC_BATCH_MAX_MESSAGES`) and the caller re-kicks instead of waiting out
 * `pollIntervalMs` — the difference between one opaque multi-hour cycle and a series of short
 * observable ones. TWO backlogs, deliberately not one flag: `hasBacklog` is INBOUND mail the adapter
 * has not handed over; `owesFiling` is OUTBOUND intent not yet on the server (filing that hit {@link
 * RECONCILE_MOVES_PER_CYCLE}). The caller re-kicks on either, turning the filing budget into a rotation
 * rather than a delay. They are separate because ONE also means "the first import is finished":
 * `stampInitialImportComplete` fires on `!hasBacklog`, and a filing queue holding the flag high would read a mid-triage mailbox as permanently partial for a reason that has nothing to do with importing.
 */
export async function runSyncCycle(input: SyncDeps): Promise<{ hasBacklog: boolean; owesFiling: boolean }> {
  const at = freshCyclePages();
  try {
    return await cycleWithKnownSet(input, at);
  } catch (err) {
    // ── THE CYCLE'S VERDICT WHEN THE MAILBOX CHANGED HANDS UNDER IT ────────────────────────────
    //
    // Once, here, and then rethrown: both callers already read this class as a stand-down rather
    // than a failing mailbox, and a line per refusing boundary would be one per message. The moves
    // this cycle had already applied stand — each was made under a lease this install held at the
    // page it was made on — and the new organizer's own cycle takes it from there, which is what
    // "leave anytime" promises. Closed-set fields only: no address, and no count of anybody's mail.
    if (err instanceof OrganizerStandDownError) {
      input.log?.info("stood_down_mid_cycle", {
        mailboxId: input.mailboxId, accountId: input.accountId,
        // `phase` and `page` are WHERE, `disabledReason` and `state` are the lease's own verdict as
        // the throw carried it. Not `heldBy`: the winning claim's display name is a name somebody
        // gave their own machine, and this line has no need of it.
        phase: at.pass, page: at.page, disabledReason: err.reason, state: err.state,
        reason: "another install holds this mailbox now — the cycle stopped at this page and "
          + "issued no further move, flag or folder write",
      });
    }
    throw err;
  }
}

/** {@link runSyncCycle}'s body, with the known-set memo's cycle bracket around it. */
async function cycleWithKnownSet(
  input: SyncDeps, at: CyclePageCursor,
): Promise<{ hasBacklog: boolean; owesFiling: boolean }> {
  const cache = input.knownSet;
  // NO CACHE ⇒ NOT ONE LINE OF THIS RUNS. The loop below is reached with the caller's own repo and
  // reads `listKnownLocators` exactly as it always did.
  if (!cache) return syncCycleWithin(input, at);
  cache.beginCycle();
  try {
    const out = await syncCycleWithin({ ...input, repo: watchKnownSet(input.repo, cache) }, at);
    const census = cache.census();
    // Logged only on a cycle that actually went to the database, which is the cycle where the memo
    // cost something. An idle cycle is SILENT: a host serving many mailboxes at a short poll
    // interval would otherwise emit one line per mailbox per interval, for ever, to say that
    // nothing happened.
    if (census.dbReads > 0) {
      input.log?.info("known_set_read", {
        mailboxId: input.mailboxId, accountId: input.accountId,
        rows: census.rows, bytes: census.bytes, bytesSaved: census.bytesSaved,
        droppedBy: census.droppedBy,
        reason: "the in-memory known-set was cold or had been dropped, so this cycle re-read it " +
          "from the database. `droppedBy` names the repo write (or the leadership event) that " +
          "dropped it; `bytesSaved` is the estimated wire bytes this attachment has not read " +
          "since it began",
      });
    }
    return out;
  } catch (err) {
    // ANY throw, and deliberately without inspecting it. A cycle that died may have died between a
    // write and its own record of that write — a `DatabaseFaultError` most of all, where the true
    // outcome of the statement is exactly what is unknown. The conservative rule is the whole
    // contract of this object: any ambiguity, drop it and re-read.
    cache.drop("cycle-threw");
    throw err;
  }
}

async function syncCycleWithin(
  deps: SyncDeps, at: CyclePageCursor,
): Promise<{ hasBacklog: boolean; owesFiling: boolean }> {
  const { repo, adapter, accountId, mailboxId, classifier, credits, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff, importDecisionOpen, storageCap, log } = deps;
  /**
   * THE ONE DERIVATION. See {@link SyncDeps.role}.
   *
   * `=== "reader"` and not `!== "organizer"`, so a value this build does not recognise reads as
   * ORGANIZER — which is the pre-0083 behaviour of every caller that predates the field, and is
   * what keeps the existing test call sites routing byte-identically. The safety is not this
   * default; it is the census over product source, which is the only place a wrong role could
   * come from.
   */
  const readerMode = deps.role === "reader";
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

  // ── USER-COMMANDED FOLDER OPERATIONS, FIRST (FOLDERS-SPEC.md stage 2) ──────────────────────
  //
  // Before the cursor is even built, so this same cycle's `changesSince` already observes the
  // result: a created folder is scanned, a renamed subtree's swapped cursors line up with the
  // server's renamed tree, a deleted folder is simply absent from the LIST. The pass runs inside
  // this mailbox's serial cycle (one organizer — nothing else can touch the tree beside it), its
  // consequences ride the fenced group, and only fence refusals leave it: a command that fails
  // for any other reason is deferred or failed ON ITS OWN ROW (`folder_ops.status`), never by
  // wedging the mailbox's mail flow behind it.
  let folderOpsOweMore = false;
  /* Both user-commanded passes are the organizer's, and this gate was missing. `SyncDeps.role`'s own
   * doc says a reader skips the folder-ops pass and the one-time junk sweep — it said so before this
   * line existed, a FALSE CLAIM in a file where a comment is the claim under test, and the gap it
   * described was the more exploitable half of the reader mode. Both passes execute COMMANDS RECORDED
   * EARLIER by an install that was the organizer when the person pressed (a `folder_ops` row, or
   * `mailboxes.junk_sweep_requested_at`), and neither is refused at the API once recorded — so a
   * demotion between the press and the cycle turned a queued command into a real IMAP mutation on a
   * mailbox another install now organizes, with nobody at the screen. They are SKIPPED, not deferred:
   * the rows stand and the organizer's own cycle serves them, like `reconcileFolders`. */
  if (!readerMode) {
  try {
    // ONE SLICE, ONE PAGE. The pass asks the lease before every mutation it issues; what the cursor
    // records is that a refusal inside it belongs to the folder-ops page of this cycle.
    openPage(at, "folder_ops");
    const opsOut = await folderOpsPass({
      repo, adapter, accountId, mailboxId,
      ...(log !== undefined ? { log } : {}),
      write: (fn) => fencedLiveGroup(deps, fn),
      // The check before EVERY IMAP mutation the pass issues — the same fresh leadership read
      // every other mutation site in this file takes (see the fence block up top). The fenced
      // `write` covers only the database half; without this a stale worker could CREATE or
      // sweep a mailbox another worker has taken over.
      writeAuthority: writeAuthorityOf(deps),
    });
    // A folder delete that ran out its per-cycle chunk budget still owes work: report it the
    // way the filing budget does, so the caller re-kicks and the mailbox rotates to the back
    // of the queue instead of monopolizing it or waiting out a poll interval.
    folderOpsOweMore = opsOut.owesMore;
  } catch (err) {
    rethrowRefusal(err);
    log?.warn("folder_ops_pass_failed", { mailboxId, accountId, err });
  }
  }

  // The one-time sweep, when its press is recorded (FOLDERS-SPEC.md §16.1). Same slot as the folder
  // verbs and for the same reason: a USER-COMMANDED act executed by the organizer inside its serial
  // cycle before the cursor is built, so this cycle's `changesSince` already observes the moves. The
  // pass is `junkSweepPass` — the operator CLI's exact function — with every IMAP mutation behind the
  // same fresh leadership read (`guard`) and every completion write inside the fenced group (`write`).
  // ONE BOUNDED SLICE PER CYCLE, retired only when the pile is drained: the pass takes a per-cycle
  // limit so a large pile rotates through the queue instead of monopolizing it, and the stamp is
  // retired ONLY when nothing is movable — or when a run that EXAMINED EVERY remaining candidate moved
  // NOTHING (a pile the server refuses). The clear compares the OBSERVED token; a pass that throws
  // leaves the stamp standing (the sweep is idempotent). While the pile drains, `owesFiling` re-kicks.
  let sweepOwesMore = false;
  // `!readerMode &&` — see the block above the folder-ops pass; the same argument, the same
  // recorded-earlier command, and the same answer (skip, the stamp stands, the organizer serves it).
  if (!readerMode && deps.junkSweep !== undefined) {
    try {
      const observed = await deps.junkSweep.requested();
      if (observed !== null) {
        // The sweep's one bounded window is this cycle's junk_sweep page — see the folder-ops note.
        openPage(at, "junk_sweep");
        const res = await deps.junkSweep.run({
          writeAuthority: writeAuthorityOf(deps),
          write: (fn) => fencedLiveGroup(deps, fn),
          // The press this slice belongs to — see the port's own note. The same token the clear
          // below compares, so a press that lands mid-sweep is served by the next cycle with its
          // own fresh scan state rather than inheriting this one's.
          command: observed,
        });
        const left = await deps.junkSweep.remaining();
        const drained = left === 0;
        // `!res.deferralsHold` IS PART OF "STUCK", the difference between retiring a command and
        // consuming it. The other three conjuncts say "a full scan of a non-empty pile moved
        // nothing", read as a server that refuses every member — the one reading that licenses
        // throwing the press away. A member skipped because its SOURCE LOCATOR WAS STALE is not
        // evidence for that and is close to evidence against it: the message is still there under a
        // different UID, the next `changesSince` re-finds it by Message-ID, and the sweep then moves
        // it. A recycled folder makes EVERY member skip at once — the shape of a fully-refused pile
        // and not one — so without this clause the press was retired by a condition that clears on its
        // own. A cycle with any deferral keeps the stamp and re-kicks, terminating as adoption repoints them.
        const stuck = !drained && res.moved.length === 0 && !res.deferralsHold && res.examinedAll;
        if (drained || stuck) {
          await deps.junkSweep.clear(observed);
        } else {
          sweepOwesMore = true;
        }
        log?.info("junk_sweep_command_ran", {
          mailboxId, accountId, moved: res.moved.length, skipped: res.skipped.length,
          deferred: res.deferred,
          junkFolder: res.junkFolder, remaining: left,
          retired: drained || stuck,
          // The retired-while-nonempty line must not name a cause it did not observe. There are TWO
          // ways to reach `stuck` with opposite diagnoses, so one sentence for both is wrong half the
          // time: a pile the server refuses is a provider problem; a pile whose members are not at the
          // locators the mirror holds is our bookkeeping, and the exemption for it has just run out.
          // This line said "the server refused every member" for both — an operator reading it on the
          // second case would go interrogate a mail server that refused nothing. `res.deferred > 0` is
          // the discriminator and the honest one: the per-window count is still reported truthfully
          // even on the scan where the exemption stops holding the press, which is why the count and
          // the gate were split into two fields.
          reason: drained
            ? "the account's user pressed the one-time Quarantine→Junk offer; the pile is drained and the command retired"
            : stuck
              ? res.deferred > 0
                ? "a full scan moved nothing and its members were not at the locators the mirror holds; the deferral allowance is spent, so the command is retired rather than re-kicking for ever; the offer returns with what is left"
                : "a full scan moved nothing — the server refused every member — so the command is retired rather than retried every cycle; the offer returns with what is left"
              : res.deferralsHold
                ? "some members are no longer at the locator the mirror holds; the command stands and the mailbox is re-kicked, so the next window sweeps them if the next scan re-finds them"
                : "one bounded window ran; the command stands and the mailbox is re-kicked for the next window",
        });
      }
    } catch (err) {
      rethrowRefusal(err);
      log?.warn("junk_sweep_command_failed", { mailboxId, accountId, err });
    }
  }

  const cursor = await buildCursor(repo, mailboxId, deadLetters, deps.census, deps.knownSet);
  const batch = await adapter.changesSince(cursor);
  if (deps.census !== undefined) {
    deps.census.observed += batch.creates.length + batch.moves.length
      + batch.flagChanges.length + batch.deletes.length;
  }
  // A folder whose STORED cursor this build could not read was scanned from cold — the adapter has
  // no logger and reports the names instead, and a re-bootstrap that nobody records is the
  // silent state the row is about. One line per folder, labelled: a folder a person made carries
  // their own words.
  for (const folder of batch.rebootstrapped ?? []) {
    log?.warn("folder_cursor_unreadable", {
      mailboxId, accountId, folderLabel: folderLabel(folder),
      reason: "the stored cursor for this folder is not a shape this build can read, so the "
        + "folder was scanned from cold and its cursor rewritten",
    });
  }

  /**
   * Folders holding a change that FAILED and was NOT consumed. Their cursor is not written and
   * the cycle ends by rethrowing, so nothing is acknowledged past work still owed.
   */
  const deferred = new Set<string>();
  let firstDeferredError: unknown = null;

  /**
   * Per-change failure boundary. The three outcomes are the whole fix. `applied` continues. `skip`
   * records the item durably as evidence, declares it consumed, and continues — the batch reaches B.
   * `retry` holds the folder's cursor and remembers the error to rethrow after the batch, leaving the
   * mailbox's existing failure counting and quarantine cadence exactly as it was.
   * `ClassifierFaultError` and `LeaseUnavailableError` are rethrown IMMEDIATELY and by class, as at the
   * caller's own catch arms: a model outage or an unreadable lease is not evidence about the message,
   * and counting attempts against it would eventually write off good mail because somebody else had an incident.
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
      // The two REFUSALS leave here too, and `MailboxRemovedError` is one of them: counting an
      // attempt against a lost lease would spend a customer's mail on our own handover, and
      // writing a `message_failures` row for a removed mailbox would leave a record of somebody's
      // mail behind in a mailbox they removed. Through {@link rethrowRefusal} rather than the
      // list above, so the class is decided in ONE place for every arm in this file.
      rethrowRefusal(err);
      const fault = classifyIngestFault(err);
      if (fault.domain === "infrastructure") {
        // Ours, not the message's. Fail the cycle the way a bare throw did before this boundary: no
        // attempt counted, no cursor written for this folder, nothing written off. There was a
        // `deferred.add(site.folder)` here and it was DEAD, which matters because it read as
        // load-bearing: the throw is what holds every cursor (the `await attempt(...)` call sites have
        // no `catch` between them and the `deferred.has(folder)` read in the cursor loop), so this
        // throw leaves the function and that read is never reached this cycle. Deferring one folder was
        // unobservable — and narrower than the truth, since an infrastructure fault must hold ALL
        // folders' cursors. Do not re-add it: it would suggest the cycle continues past this point.
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
        attempts = await fencedLiveGroup(deps, (r) => r.recordMessageFailure(mailboxId, {
          accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
          code: fault.code, version,
          nextAttemptAt: nextAttemptAfter(fault.code, 1, new Date()),
        }));
      } catch (writeErr) {
        deadLetters.revoke(ch.locator);
        // Revoked FIRST, then the fence refusal propagates: the in-memory terminal decision must
        // not outlive a durable record that was refused, whoever refused it.
        rethrowRefusal(writeErr);
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
        await fencedLiveGroup(deps, (r) => r.recordAudit(
          accountId, "sync.message_skipped",
          {
            mailboxId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
            code: fault.code,
          },
          null,
        ));
      } catch (auditErr) {
        rethrowRefusal(auditErr);
        log?.warn("sync_message_skip_audit_failed", {
          mailboxId, accountId, folder: site.folder, uid: site.uid, err: auditErr,
        });
      }
    }
  }

  // Disappearances first, and that order is the point. `batch.deletes` was consumed by NOTHING —
  // described as a cursor-only signal, which left `classifyDedup` unable to tell a user's move from a
  // stranger's delivery: a sender can make a locator APPEAR, only the user can make a stored locator
  // DISAPPEAR, and the disappearance was thrown away. Recorded BEFORE the ingest loop, so this cycle's
  // deletes are evidence for this cycle's creates (covering the two shapes `correlateMoves` cannot
  // pair — a message with no Message-ID, and a delete and create in different batches). THE EPOCH
  // GUARD: the adapter emits every prior UID as a delete when a folder's epoch changes, but those UIDs
  // were renumbered, not lost, so a delete is only believed when its epoch is the one the server
  // reports NOW (`epochsObserved`, read off the locators minted this pass; neither available ⇒ skip).
  const observedEpochs = epochsObserved(batch);
  let deletesCapped = false;
  let deletesRecorded = 0;
  for (const ch of batch.deletes) {
    const site = siteOf(ch);
    const live = observedEpochs.get(site.folder) ?? batch.newCursor.folders[site.folder]?.uidValidity;
    if (live === undefined || !sameEpoch(epochOf(live), epochOf(site.uidValidity))) continue;
    // BOUNDED — see {@link DELETE_EVIDENCE_PER_CYCLE}. The cap is counted over the deletes this
    // cycle BELIEVES, not over everything the adapter reported: a UIDVALIDITY reset's prior-epoch
    // refs are skipped above and must not spend a budget meant for real disappearances.
    if (deletesRecorded >= DELETE_EVIDENCE_PER_CYCLE) { deletesCapped = true; break; }
    await fencedLiveGroup(deps, (r) => r.forgetInstanceAt(mailboxId, ch.locator));
    deletesRecorded++;
  }
  if (deletesCapped) {
    log?.info("sync_delete_evidence_capped", {
      mailboxId, accountId, considered: deletesRecorded,
      reason: "this cycle recorded its budget of disappearances and stopped; the rest are still "
        + "in the known-set, are reported again next cycle, and the cycle re-kicks rather than "
        + "waiting for the poll",
    });
  }

  // The reaper (mail 0065): a message whose every watched instance is gone leaves the mirror.
  // `forgetInstanceAt` above removes instances and promotes survivors, and until this pass that was
  // the END of the story — the `messages` row stayed live in every view for ever, describing mail the
  // server no longer holds (`forgetInstanceAt` left "the last known locator on the row FOR THE REAPER
  // TO FIND", and no reaper existed). This is it: bounded per cycle, it stamps `deleted_at`, husks the
  // body (the account stops paying for bytes of a gone message), and emits the `change_log` `delete`
  // clients tombstone on. A cross-batch external move is tombstoned here and RESURRECTED by the adopt
  // path (`clearDeletedOnAdopt` + the move change) — the client contract's "a LATER create resurrects"
  // end to end. Junk-parked rows are excluded in the query; optional-guarded so every fake repo works.
  if (typeof repo.tombstoneInstanceless === "function") {
    const reaped = await fencedLiveGroup(deps, (r) =>
      typeof r.tombstoneInstanceless === "function"
        ? r.tombstoneInstanceless(accountId, mailboxId, TOMBSTONE_MAX_PER_CYCLE)
        : Promise.resolve(0));
    if (reaped > 0) {
      log?.info("sync_tombstoned_expunged", {
        mailboxId, accountId, reaped,
        reason: "every watched instance of these messages is gone from the server — the mirror " +
          "rows are tombstoned so clients stop presenting mail the mailbox no longer holds",
      });
    }
  }

  // Two-phase, transaction-safe ingest. PLAN performs the reads +
  // optional classifier network call OUTSIDE any transaction; COMMIT persists the
  // entity rows + change_log inside ONE short transaction (tx-scoped repo, no
  // network). The physical IMAP move runs afterwards in reconcileMailbox, outside
  // the transaction. Only content-bearing changes (create/move carrying RFC822) are
  // ingested; a FLAG is a cursor-only signal, and a DELETE is the move evidence recorded above.
  for (const ch of [...batch.creates, ...batch.moves]) {
    await attempt(ch, async () => {
      const plan = await planChange(ch, { repo, accountId, mailboxId, classifier, credits, routing: repo, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff, importDecisionOpen, readerMode });
      await fencedIngest(deps, async (txRepo) => {
        // The mailbox is asked about INSIDE this transaction, never before it: `planChange` above
        // ran outside any transaction and may have spent a classifier call there, which is exactly
        // the gap a removal lands in. See {@link commitFenced} for which statement carries the
        // question and {@link assertMailboxStillHere} for what it is.
        await commitFenced(plan, txRepo, {
          repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap,
        });
      });
    });
  }

  // Inbound read-state — the inbound half of read-state mirroring. `flagChanges` was produced by the
  // adapter and consumed by nothing, so a message read in another client stayed bold in ohmail for
  // ever. Each is its own short transaction — the entity write and its `change_log` row commit
  // together, and one unresolvable locator cannot roll back the whole batch. `applyExternalFlag` owns
  // the user-wins decision: it declines while OUR write is still pending, so the value the server is
  // about to be told is never overwritten by the value it is still reporting. A locator with no message
  // behind it (a create this batch truncated) is skipped — the next cycle sees the flag again. Behind
  // the SAME boundary as ingest, for the same reason: one throwing flag exited this loop too, so every
  // later flag in the slice went unapplied and the mailbox retried the same one for ever.
  for (const ch of batch.flagChanges) {
    await attempt(ch, async () => {
      await fencedIngest(deps, async (txRepo) => {
        // THE SAME QUESTION AS THE INGEST ABOVE, for the same reason. A flag write updates a row
        // rather than creating one, so a removed mailbox's sweep has usually taken the row out
        // from under it already — but "usually" is the wrong word for a write, and the two
        // transactions may not be ordered differently just because one of them is smaller.
        await assertMailboxStillHere(txRepo, mailboxId);
        const outcome = await txRepo.applyExternalFlag(mailboxId, ch.locator, ch.seen ?? false);
        if (!outcome?.changed) return;
        await txRepo.recordChange({
          accountId, entityType: "message", entityId: outcome.messageId, op: "update", meta: null,
        });
      });
    });
  }

  // UIDs the server withheld — recorded here, before any cursor moves. `batch.unanswered` is the set
  // the adapter asked for and did not receive; no `Change` was ever produced for them, so the
  // `attempt` boundary never saw them and their dead-letter path was unreachable — they were crossed in
  // SILENCE, the one thing the cursor rule forbids (a folder's cursor may advance over a UID only once
  // a durable row for it is committed, so that row is written here). `unclassified` is the honest code:
  // the closed set names failures we can attribute to the MESSAGE, and this is not one — the bytes were
  // never seen — and it is also the right RETRY behaviour (a doubling clock capped at a day, re-read
  // once per deploy), so a server that starts answering recovers on its own. Same failure semantics as
  // ingest: a row that cannot be written DEFERS the folder, or losing the write while advancing the watermark is mail loss.
  for (const site of batch.unanswered ?? []) {
    try {
      const attempts = await fencedLiveGroup(deps, (r) => r.recordMessageFailure(mailboxId, {
        accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        code: "unclassified", version,
        nextAttemptAt: nextAttemptAfter("unclassified", 1, new Date()),
      }));
      log?.warn("sync_uid_unanswered", {
        mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        attempts,
        reason: "the server listed this UID and returned nothing for it, twice — once for the " +
          "batch fetch and once for the envelope-free retry. Recorded as owed so the cursor may " +
          "cross it and the targeted retry keeps re-reading it",
      });
    } catch (writeErr) {
      rethrowRefusal(writeErr);
      deferred.add(site.folder);
      if (firstDeferredError === null) firstDeferredError = writeErr;
      log?.error("sync_uid_unanswered_unrecordable", {
        mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        err: writeErr,
        reason: "the server withheld this UID AND the durable record of that could not be written " +
          "— the folder's cursor is held rather than advanced past mail nothing would ever " +
          "enumerate again",
      });
    }
  }

  // ── UIDS REFUSED ON SIZE, PRE-FETCH — THE SAME OBLIGATION, WITH THE HONEST CODE ─────────────
  //
  // `batch.oversize` is the adapter declining to download a body whose RFC822.SIZE already
  // exceeds the hard MIME ceiling (see `ChangeBatch.oversize` for why the download would have
  // been pure waste and a memory hazard). The row is exactly the one `normalizeMime`'s
  // post-download rejection would have produced — `mime_too_large`, deterministic, so
  // `next_attempt_at` is NULL and its next look is a new build's size probe, never a later hour —
  // and it MUST land before the cursor writes below, for the unanswered loop's reason: the cursor
  // advances over the UID, and only this row keeps it enumerable (the targeted retry) at all.
  for (const site of batch.oversize ?? []) {
    try {
      const attempts = await fencedLiveGroup(deps, (r) => r.recordMessageFailure(mailboxId, {
        accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        code: "mime_too_large", version,
        nextAttemptAt: nextAttemptAfter("mime_too_large", 1, new Date()),
      }));
      log?.warn("sync_uid_oversize_skipped", {
        mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        size: site.size, attempts,
        reason: "RFC822.SIZE exceeds the hard MIME ceiling, so the body was never fetched — " +
          "recorded as mime_too_large so the cursor may cross it; a build with a bigger ceiling " +
          "recovers it via the targeted retry",
      });
    } catch (writeErr) {
      rethrowRefusal(writeErr);
      deferred.add(site.folder);
      if (firstDeferredError === null) firstDeferredError = writeErr;
      log?.error("sync_uid_oversize_unrecordable", {
        mailboxId, accountId, folder: site.folder, uidValidity: site.uidValidity, uid: site.uid,
        err: writeErr,
        reason: "the oversize refusal could not be recorded — the folder's cursor is held rather " +
          "than advanced past mail nothing would ever enumerate again",
      });
    }
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
    await fencedLiveGroup(deps, (r) => r.upsertMailboxFolder(mailboxId, folder, epochAware(fc, observedEpochs.get(folder))));
  }

  // AFTER the cursor writes, and skipped entirely when anything is deferred — see
  // `retryFailedMessages` for both reasons.
  if (deferred.size === 0) await retryFailedMessages(deps, deadLetters, version);

  // THE SECOND DOOR OUT OF JUNK — refill `junk_filed` husks whose message this scan can see
  // alive in a watched folder (the user moved it back in another client, or the provider
  // un-junked it, and the adoption-time refill did not close it). Same placement rules as the
  // targeted retry above, same verify/rewrite as the API's rescue (`core/husk-restore.ts`);
  // the module header carries the whole argument. Never throws except a fence refusal, which
  // must stop the cycle unreclassified.
  if (deferred.size === 0) {
    try {
      await junkRestorePass({
        repo, adapter, accountId, mailboxId, storageCap,
        ...(log !== undefined ? { log } : {}),
        write: (fn) => fencedLiveGroup(deps, fn),
      });
    } catch (err) {
      // NAMED BEFORE IT IS RETHROWN. The pass's `write` is the fenced live group, so a removal
      // landing between `listJunkFiledHusks` and a rewrite refuses here — and reported as
      // `junk_restore_pass_failed` it would read as a pass that broke, on a mailbox that is
      // simply gone. Once per pass: the first refusal leaves the pass, so there is no second.
      if (err instanceof MailboxRemovedError) {
        log?.info("junk_restore_mailbox_removed", {
          mailboxId, accountId,
          reason: "the mailbox was removed while this pass was reading it, so the husk rewrite "
            + "was refused rather than committed into a mailbox that is gone",
        });
        throw err;
      }
      rethrowRefusal(err);
      log?.warn("junk_restore_pass_failed", { mailboxId, accountId, err });
    }
  }

  // The reconciler's own refusal gets the pass's name for the junk restore's reason — its arms
  // otherwise report a removal as bookkeeping that "did not commit", which is a sentence about
  // our database when the fact is that the mailbox has gone. Rethrown: terminal for the cycle,
  // like every other refusal, and both production callers read it as a skip.
  let owesMore: boolean;
  try {
    ({ owesMore } = await reconcileMailbox(deps, at));
  } catch (err) {
    if (err instanceof MailboxRemovedError) {
      log?.info("reconcile_mailbox_removed", {
        mailboxId, accountId,
        reason: "the mailbox was removed while the reconcile pass was reading it, so its moves, "
          + "folder_state, flag_state and audit writes were refused rather than committed into a "
          + "mailbox that is gone; the mail is wherever the server put it",
      });
    }
    throw err;
  }
  if (firstDeferredError !== null) throw firstDeferredError;
  return {
    hasBacklog: (batch.hasBacklog ?? false) || deletesCapped,
    owesFiling: owesMore || folderOpsOweMore || sweepOwesMore,
  };
}

/**
 * The targeted retry — re-read written-off UIDs BY UID, never by rescanning a folder. Such a UID is
 * behind the Sent watermark and inside every folder's known-set, so nothing in the ordinary batch
 * offers it again and this asks by name. Inside the cycle, not on a cron (a cron needs its own IMAP
 * connection, colliding with the one-organizer lease). After the cursor writes, since a retry must
 * never hold a watermark, and skipped when anything is deferred. Every failure ABOUT THE MESSAGE is
 * recorded and swallowed — this is mail already declared consumed — and exactly two refusals leave
 * it unreclassified, neither about the message: a lost lease, and a mailbox removed under the
 * re-read, both meaning every later write in the cycle would be illegitimate.
 */
async function retryFailedMessages(
  deps: SyncDeps, deadLetters: DeadLetterLedger, version: string,
): Promise<void> {
  const { repo, adapter, accountId, mailboxId, classifier, credits, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff, importDecisionOpen, storageCap, log } = deps;
  // The retry runs THE SAME two-phase ingest as the ordinary path, so it derives the mode the
  // same way — see {@link SyncDeps.role}. A reader's owed message is re-ingested as a reader.
  const readerMode = deps.role === "reader";
  // A backend that cannot re-read one message degrades to the pre-0041 behaviour rather than
  // erroring: the rows stay owed and a later deploy (or a real adapter) picks them up.
  if (!adapter.fetchByUid) return;

  const now = new Date();
  let claimed: Awaited<ReturnType<WorkerRepo["claimMessageFailures"]>>;
  try {
    claimed = await fencedLiveGroup(deps, (r) => r.claimMessageFailures(mailboxId, {
      version, now, limit: MAX_MESSAGE_RETRIES_PER_CYCLE,
      // The NEXT clock instant is written by the claim, so a process that dies mid-fetch does not
      // leave the row due on every subsequent cycle. `null` for the deterministic codes: their next
      // look is a new build, not a later hour — and the claim itself enforces that per code via
      // `holdScheduleForCodes`. This sentence used to be a promise the call did not keep: the
      // hourly instant below was stamped onto EVERY claimed row regardless of code, so a
      // `mime_too_large` message was size-probed once an hour for ever (a production row reached
      // 297 attempts before the 2026-08-26 review caught it).
      nextAttemptAt: nextAttemptAfter("unclassified", 1, now),
      holdScheduleForCodes: DETERMINISTIC_MESSAGE_FAILURE_CODES,
    }));
  } catch (err) {
    rethrowRefusal(err);
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
      await fencedLiveGroup(deps, (r) => r.resolveMessageFailure(mailboxId, { folder, uidValidity: row.uidValidity, uid: row.uid }));
      deadLetters.forget(folder, row.uidValidity, row.uid);
      log?.info("message_retry_closed", {
        mailboxId, accountId, folder, uidValidity: row.uidValidity, uid: row.uid, reason: why,
      });
    };

    for (const row of rows) {
      // ── THE EPOCH GUARD. A UID NUMBER MEANS NOTHING OUTSIDE THE EPOCH THAT ISSUED IT ──────
      //
      // Three answers, not two. A CONTRADICTION voids the record: re-ingesting `uid` would take
      // whatever the server RENUMBERED onto that number and then resolve the record as though the
      // original had arrived. Closing loses nothing — a reset re-enumerates the folder and offers
      // the message again as an unknown UID. An epoch NOBODY NAMED proves neither, so the record
      // is held and re-read. Read as strings, `"0"` skipped the guard and re-ingested under an
      // unnamed epoch, and `"undefined"` contradicted every epoch and closed a record whose
      // message is still on the server.
      const verdict = epochVerdict(epochOf(row.uidValidity), epochOf(found.uidValidity));
      if (verdict === "unknown") {
        log?.warn("message_retry_epoch_unknown", {
          mailboxId, folder, uid: row.uid,
          reason: "the server named no UIDVALIDITY for this folder, so the record is held and re-read",
        });
        continue;
      }
      if (verdict === "stale") {
        try { await close(row, "uidvalidity_changed"); }
        catch (err) { rethrowRefusal(err); log?.warn("message_retry_close_failed", { mailboxId, folder, uid: row.uid, err }); }
        continue;
      }

      if (found.absent.includes(row.uid)) {
        // Expunged, or moved by the user out of this folder. There is no message here to lose, and
        // a move surfaces through the ordinary enumeration of wherever it went.
        try { await close(row, "gone_from_server"); }
        catch (err) { rethrowRefusal(err); log?.warn("message_retry_close_failed", { mailboxId, folder, uid: row.uid, err }); }
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
        const plan = await planChange(change, { repo, accountId, mailboxId, classifier, credits, routing: repo, trustedAuthservIds, ohboxPolicy, ohboxBar, screeningCutoff, importDecisionOpen, readerMode });
        // THROUGH THE INGEST'S OWN COMMIT DOOR, and never a second fence. `planChange` above ran
        // outside every transaction exactly as the ordinary path's does, so a removal lands in the
        // same gap and this commit needs the same question asked inside the same transaction —
        // {@link commitFenced} puts it on whichever statement this plan's shape already sends.
        await fencedIngest(deps, (txRepo) =>
          commitFenced(plan, txRepo, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap }),
        );
      } catch (err) {
        // BOTH REFUSALS STOP THE CYCLE where the two arms below return, and the removal is NAMED
        // before it leaves — which is why it is read here rather than left to `rethrowRefusal`,
        // whose job is the arms that have nothing to say about the class.
        if (err instanceof MailboxRemovedError) {
          /* THE MAILBOX WENT WHILE THIS MESSAGE WAS BEING RE-READ — terminal for the cycle, as it
             is where the ingest raises it, and NOT the outage arm below. Two passes still to come
             in this cycle write to the mailbox and neither asks this question (the junk restore's
             rewrites, `reconcileMailbox`'s moves and flag writes), so swallowing the refusal would
             shut one door and leave two open on a mailbox that is gone. Nothing is recorded
             against the message either: it is fine, and a `message_failures` row rewritten now is
             somebody's mail left behind one table along. Both callers already read this class as a
             benign skip rather than a failing mailbox. */
          log?.info("message_retry_mailbox_removed", {
            mailboxId, accountId, folder, uidValidity: row.uidValidity, uid: row.uid,
            reason: "this mailbox was removed while a written-off message was being re-read, so " +
              "the commit was refused rather than written into a mailbox that is gone — the " +
              "record stays owed and the cycle stops here",
          });
          throw err;
        }
        // And the other refusal, which has no sentence of its own to add here: lost leadership is
        // not evidence about the message and not an outage to wait out — the whole cycle stops.
        rethrowRefusal(err);
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
          await fencedLiveGroup(deps, (r) => r.recordMessageFailure(mailboxId, {
            accountId, folder, uidValidity: row.uidValidity, uid: row.uid,
            code: fault.code, version,
            nextAttemptAt: nextAttemptAfter(fault.code, row.attempts, new Date()),
          }));
        } catch (writeErr) {
          rethrowRefusal(writeErr);
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
        rethrowRefusal(err);
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
    // Only a NAMED epoch is an observation. `!== "0"` let a silent server's `String(undefined)`
    // through and it was persisted as the folder's epoch, which then matched nothing for ever.
    if (epochOf(uidValidity).known) out.set(folder, uidValidity);
  }
  return out;
}

/**
 * Record the observed epoch even while the watermarks are held. A truncated batch holds its folder's
 * cursor at the PREVIOUS value — right for `uidNext`/`highestModseq`, wrong for `uidValidity`, which is
 * an identity, not a watermark. With the old epoch persisted, the next pass hands the adapter a stale
 * cursor, the adapter treats every old-epoch UID as meaningless, and returns the same newest slice —
 * for ever. So the epoch advances and the watermarks do not (`uidNext: 0`/`highestModseq: "0"` loses
 * nothing under the new epoch, and is the cursor the adapter itself computes for an unseen folder). A
 * `"0" → V` PROMOTION is NOT a reset: on it the watermarks were computed under `V` this pass, so
 * zeroing them discards work that was never wrong (and pinned a permanently-truncating folder at `"0"`, killing flags and inbound read-state per folder). Only a genuine `V → V′` reset zeroes; the kept values are the ADAPTER's, and no shape can raise a Sent watermark past mail nobody fetched.
 */
function epochAware(fc: PersistedFolderCursor, observed: string | undefined): PersistedFolderCursor {
  if (observed === undefined || sameEpoch(epochOf(observed), epochOf(fc.uidValidity))) return fc;
  // A PROMOTION, not a reset — see above. Record the epoch, keep the watermarks. An UNNAMED
  // stored epoch is promoted, never reset: there was no epoch to contradict.
  if (!epochOf(fc.uidValidity).known) return { ...fc, uidValidity: observed };
  return { uidValidity: observed, uidNext: 0, highestModseq: "0" };
}

/**
 * Execute OUR intended moves (desired != observed, lastSetBy === 'us') and OUR intended `\Seen`
 * writes. External divergences are left untouched (user always wins). Idempotent + crash-safe:
 * if the message already left its expected source (a prior run moved it before crashing), we
 * defer to the next changesSince, which adopts the completed move.
 */
export async function reconcileMailbox(
  deps: SyncDeps, at: CyclePageCursor = freshCyclePages(),
): Promise<{ owesMore: boolean }> {
  /* A reader reconciles flags and nothing else. See {@link SyncDeps.role}. The two halves of this
   * function are the two halves of the reader's entitlement: `reconcileFolders` carries OUR intended
   * MOVES to the server, and a reader has none — `planChange`'s reader arm writes every row
   * `last_set_by: 'external'`, so the pending-moves query returns nothing even if this ran. It is
   * skipped anyway rather than left to return empty, because a demoted organizer's rows SURVIVE
   * demotion (the mirror is kept), so `desired ≠ observed` with `last_set_by: 'us'` IS reachable on a
   * reader — moves it decided while still the organizer — and running the pass would execute them on
   * somebody else's mailbox after the handover, the seize-back the lease forbids. Those rows are not
   * lost: the ORGANIZER's own cycle adopts. `reconcileFlags` DOES run — `\Seen` is the one verb that
   * keeps a reader's mirror honest in both directions. */
  const owesMore = deps.role === "reader" ? false : await reconcileFolders(deps, at);
  /* The flag queue reports its own backlog, and a READER's counts: this pass runs for a reader by
   * design (`\Seen` is the one verb that keeps its mirror honest), so a reader that has just been
   * handed ten thousand read marks owes outbound intent exactly as an organizer does. The `false`
   * above is about MOVES, which a reader may not make. */
  const owesFlags = await reconcileFlags(deps, at);
  return { owesMore: owesMore || owesFlags };
}

/**
 * Pending moves ONE CYCLE MAY FILE, and the reason this queue finally has a bound.
 * `listPendingFolderStates` had no limit for its whole life. Measured on a production mailbox: one
 * screening session left 1 137 rows pending, and draining them took 583 seconds inside the worker's
 * SERIAL cycle, during which twelve other mailboxes received no mail. The per-message IMAP cost is
 * what made it expensive and batching fixes it; the bound is what stops it being a monopoly again the
 * day somebody triages ten thousand messages. A budget rotates the queue without touching the
 * one-organizer-per-mailbox invariant: the cycle files what it can, reports it still owes work, and the
 * caller re-kicks. 500 is the batched path's ten chunks — a few seconds of IMAP, short enough that no other mailbox waits, large enough that an ordinary day's filing finishes in one pass.
 */
export const RECONCILE_MOVES_PER_CYCLE = 500;

/**
 * Pending `\Seen` writes ONE CYCLE MAY PUSH. `listPendingFlagStates` had no limit at all, and each
 * row is one IMAP STORE — the same per-message round trip that made the folder queue a 583-second
 * monopoly on a serial cycle — so the queue that fills fastest (a select-all-and-mark-read in
 * another client, a retro pass) handed the worker unbounded work. 500, the filing budget's number
 * for its reason (the delete-evidence cap took the same): a few seconds of IMAP, short enough that
 * no other mailbox waits, large enough that an ordinary day finishes in one pass. Nothing is
 * dropped — the rows stay `pending`, the pass reports it still owes work, and the caller re-kicks
 * rather than waiting out `pollIntervalMs`.
 */
export const RECONCILE_FLAGS_PER_CYCLE = 500;

/**
 * How many DISAPPEARANCES one cycle may record. Each is its own fenced write, and a bulk expunge in
 * the live epoch produces one per previously known UID — thousands of sequential writes ahead of the
 * ingest loop, so a mailbox stops receiving new mail until the backlog drains. Nothing is lost by
 * capping: an instance this cycle did not forget is still in the next cursor's known-set and is
 * reported again, and the cap raises `hasBacklog` so the caller re-kicks instead of waiting out the
 * poll. 500, the filing budget's number for the filing budget's reason: a few seconds of database
 * work, short enough that no other mailbox waits on it.
 */
export const DELETE_EVIDENCE_PER_CYCLE = 500;

/**
 * A folder name for a LOG LINE: ours as written, anyone else's as `"other"`.
 *
 * A folder a person made carries their own words, and the structured logger's field census exists
 * to keep those out of a log. The six ohmail organizes are names this codebase chose, so they are
 * the whole admissible set; a provider's special folder and a customer folder are both `"other"`,
 * which is what a layer trace needs to distinguish a filing that happened from one that did not.
 */
const folderLabel = (folder: string): string => (isOrganizedFolder(folder) ? folder : "other");

/**
 * The bounded retry for a mutation the server refuses — minutes, then hours, then for ever. Per-item
 * isolation stops one refused mutation abandoning the pass; it does NOT stop that item being attempted
 * again every cycle, which is what the reconciler did for every stuck row for its whole life. Two
 * costs, the second the one that hurts uninvolved users: one IMAP round trip per stuck row per cycle,
 * and — because `listPendingFolderStates` is ordered OLDEST FIRST under a fixed allowance — a
 * permanently refused row sits at the head of the budget every cycle, so 500 of them eat the whole
 * budget while fresh mail never reaches the server (head-of-line blocking by BUDGET, unreachable from
 * any `try`/`catch`). So a refusal buys widening silence with a six-hour FLOOR, never an end: there is no give-up, because this records the USER's instruction, not our failure to read mail. `attempts` rides the audit row, so "failed 40 times" is a value somebody can select.
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
 * Is this throw evidence about THIS MUTATION, or about the pipes? The distinction decides whether a
 * failure earns a deferral, and getting it backwards is expensive both ways (it reuses
 * `classifyIngestFault` rather than growing a second opinion): call a HOST OUTAGE per-message and a
 * mailbox unreachable for ten minutes comes back with its whole filing queue deferred for an hour;
 * call a PER-MESSAGE refusal infrastructure and nothing is ever deferred, back to one round trip per
 * stuck row per cycle and the budget starvation. The infrastructure domain covers both sockets in play
 * (the customer's IMAP host and our own database), because neither is the message's fault, and leaves
 * the row EXACTLY as it was (due now, attempts unchanged, no audit row) — the pass continues, and the backlog drains the moment the host is back (`reconcile-resume.pg.test.ts`).
 */
function isTransportFailure(err: unknown): boolean {
  return classifyIngestFault(err).domain === "infrastructure";
}

/**
 * What the server refused, as a class somebody can act on (mail 0097). The deferral above records the
 * SCHEDULE; what it could not record is WHY, so the client had a number and a retry time and nothing
 * else — and the honest sentence cannot be written from those ("1 message waits · retrying at 14:20"
 * tells a person nothing to do, where "the folder is not there" names the one screen that fixes it).
 * The output is FOUR WORDS, the whole safety argument: `folder_state`'s schema forbids an error column
 * ("what went wrong is free text from someone else's mail server"), and this MAY read the error and may
 * never store it — the server's wording goes only to the `reconcile.move.failed` audit row. STRUCTURED
 * evidence only (`serverResponseCode`), no message probe; `refused` is a real member (a bare `NO` to a `UID MOVE` is a refusal). Nothing for a transport failure — `isTransportFailure` returns first.
 */
function classifyMoveRefusal(err: unknown): FilingRefusalClass {
  const code = typeof (err as { serverResponseCode?: unknown } | null)?.serverResponseCode === "string"
    ? String((err as { serverResponseCode: string }).serverResponseCode).toUpperCase()
    : "";
  // `[TRYCREATE]` is the server saying the destination does not exist and it would accept a
  // CREATE — the same fact as `[NONEXISTENT]` from a person's point of view, and the same remedy.
  if (code === "NONEXISTENT" || code === "TRYCREATE") return "no_such_folder";
  if (code === "OVERQUOTA") return "over_quota";
  // `[NOPERM]` is "you may not write here" and `[READ-ONLY]` is "this mailbox is not writable
  // right now": one is a permission and the other a mode, and both are the same sentence to
  // whoever filed the mail — the folder will not take it. A provider's own maintenance window
  // produces the second one, which is why the ladder's early rungs are minutes.
  if (code === "NOPERM" || code === "READ-ONLY") return "read_only";
  return "refused";
}

/**
 * Execute our intended moves, grouped by (source folder → destination) and filed in batches. Returns
 * whether the budget was reached with rows still pending, which the caller turns into a re-kick (see
 * {@link RECONCILE_MOVES_PER_CYCLE} and {@link MailboxAdapter.moveMany}). THE FALLBACK IS THE DESIGN,
 * not a safety net: `moveMany` answers `declined` — before writing anything — for every group it
 * cannot prove equivalent, and that group goes through the untouched per-message path. Its third
 * answer, `moved_unmapped`, is the one shape the fallback must NOT take: the mail moved and the
 * server did not say where, so nothing is recorded and nothing is re-issued. Never a half-filed
 * group either way. A throw takes the per-message path, where a message earns its own verdict.
 */
async function reconcileFolders(deps: SyncDeps, at: CyclePageCursor): Promise<boolean> {
  const { repo, accountId, mailboxId } = deps;
  // One row over the budget, so "there is more" is a fact about the queue rather than a guess
  // from a full page.
  const pending = await repo.listPendingFolderStates(mailboxId, RECONCILE_MOVES_PER_CYCLE + 1);
  const owesMore = pending.length > RECONCILE_MOVES_PER_CYCLE;
  const work = owesMore ? pending.slice(0, RECONCILE_MOVES_PER_CYCLE) : pending;

  // Mail 0065 — where a spam verdict physically files. Read once per pass; a repo without the
  // discovery answers "neither exists", which keeps the pre-0065 behaviour byte-for-byte.
  // The adapter's resolved \Sent path is overlaid where it has one: the delete completion's
  // survivor branch must never re-open a move onto a Sent instance (the watermark folder's
  // deletes are never reported, so a recorded Sent row is the one kind the enumeration cannot
  // keep honest — see `completeFiling`). A capabilities() that is absent or throws reads as
  // "unknown", which merely disables that exclusion.
  const special = { ...(await specialFoldersOf(repo, mailboxId)), ...(await sentFolderOf(deps)) };
  // ── ONLY USER-COMMANDED VERDICTS MAY FILE INTO THE PROVIDER'S JUNK ─────────────────────────
  //
  // `desired_folder = 'ohmail/Quarantine'` has three authors: a press, a rule (promoted by a
  // press, or written by the user — both standing verdicts), and an AI AUTO-APPLY, which is a
  // graduated pattern acting per message with no hand on it. The amended product rule
  // (imap-types.ts) licenses user-commanded writes only, so the auto-applied placements are
  // excluded from the mapping — they keep the pre-0065 behaviour (the pile itself), which is
  // the conservative direction: excluding too much files into our own folder; excluding too
  // little trains a provider's filter and husks a mirror body on the organizer's own initiative.
  // One indexed read for the whole pass, only when a junk folder exists to map to.
  const spamCandidates = special.junkFolder === null ? [] : work.filter(
    (p) => p.lastSetBy === "us" && p.desiredFolder === SPAM_PILE
      && p.desiredFolder !== p.observedFolder && p.nativeLocator,
  );
  const aiAuthored: ReadonlySet<string> =
    spamCandidates.length > 0 && typeof repo.listAiAutoAppliedQuarantine === "function"
      ? new Set(await repo.listAiAutoAppliedQuarantine(accountId, spamCandidates.map((p) => p.messageId)))
      : new Set<string>();

  /**
   * Rows that need an IMAP move, keyed by the (source folder → PHYSICAL destination) they
   * share — physical, not desired, because one desire can map to two destinations under the
   * exclusion above, and a chunk issues ONE `UID MOVE` for its whole membership.
   */
  const groups = new Map<string, PendingPhysical[]>();
  for (const p of work) {
    if (p.lastSetBy !== "us") continue;                       // user-wins: never revert an external move
    if (p.desiredFolder === p.observedFolder) {
      // A status repair, not an intent: the pair already agrees and only `reconcile_status` is
      // stale. `completeFolderState` and not `upsertFolderState` for the reason the method's own
      // doc gives — this write is derived from a row read before the pass's network work, so it
      // may not put `p.desiredFolder` back over a decision committed since. Nothing is written
      // when the desire moved on; the row is then genuinely pending and the next loop files it.
      await fencedLiveGroup(deps, (r) => r.completeFolderState(p.messageId, {
        expectDesiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us",
      }));
      continue;
    }
    if (!p.nativeLocator) continue;
    const physical = physicalDestination(p.desiredFolder, special, {
      aiAuthored: aiAuthored.has(p.messageId),
    });
    // `JSON.stringify` of the PAIR, not the two names joined by a separator. A folder name comes
    // from the mail server and may contain any character a delimiter could be chosen from, so a
    // joined key can collide across two different pairs — and the obvious unambiguous separator is
    // a NUL, which cannot be written here: a single raw NUL anywhere in a source file makes every
    // grep-family tool skip the WHOLE file silently, which this repository has already paid for
    // once. The array form is unambiguous and printable.
    const key = JSON.stringify([p.nativeLocator.folder, physical]);
    const row: PendingPhysical = { ...p, physical };
    const bucket = groups.get(key);
    if (bucket) bucket.push(row); else groups.set(key, [row]);
  }

  // A completion that RE-OPENED its row (the delete-survivor branch) has just created more due
  // filing work inside this very pass. It has to reach the return value: `owesMore` was computed
  // from the queue length BEFORE the pass, so without this a two-copy delete answers "nothing
  // owed" and the surviving copy waits for the next poll — or, in a drain that stops on backlog
  // alone, is never reached at all.
  let reopened = false;
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += FILING_BATCH_MAX) {
      const chunk = group.slice(i, i + FILING_BATCH_MAX);
      const batched = await fileChunk(deps, chunk, special, at);
      if (batched !== null) { reopened = reopened || batched.reopened; continue; }
      for (const p of chunk) reopened = (await fileOne(deps, p, special, at)) || reopened;
    }
  }
  return owesMore || reopened;
}

/** A pending row plus the physical destination its group was keyed on (mail 0065). */
type PendingPhysical = PendingFolderState & { physical: string };

/**
 * The adapter's resolved \Sent path as a one-field overlay for {@link SpecialFolderMap} —
 * `{}` when the adapter does not answer (a fake, a pre-capabilities adapter, a throw), so the
 * spread at the call site leaves `sentFolder: null` standing.
 */
async function sentFolderOf(deps: SyncDeps): Promise<{ sentFolder?: string | null }> {
  const { adapter } = deps;
  if (typeof adapter.capabilities !== "function") return {};
  try {
    const caps = await adapter.capabilities();
    // `watchedSentFolder` first: on a no-SPECIAL-USE server the Sent path the scan watches is
    // resolved by NAME (`findSentForScan`) and lives only there — reading `sentFolder` alone
    // would leave exactly those providers open to the stale-Sent-row wedge the exclusion
    // closes. The fallback is warm by the time this runs: `changesSince` resolves it, and the
    // reconcile pass runs after ingest in every cycle.
    return { sentFolder: caps.watchedSentFolder ?? caps.sentFolder ?? null };
  } catch {
    return {};
  }
}

/**
 * File one chunk in a batch, or report that it was not filed at all. `null` means NOTHING WAS WRITTEN
 * TO THE DATABASE for this chunk and the caller owes every member to {@link fileOne} — true even when
 * the adapter threw after moving some of them: the per-message retry finds those gone from the source,
 * raises {@link MessageGoneError}, and leaves the row pending for `changesSince` to adopt, the same
 * convergence the per-message path relies on for a crash between the move and the write. A non-null
 * answer carries `reopened` — whether any member's completion re-opened its row (the delete-survivor
 * branch), which the caller owes to the scheduler.
 */
async function fileChunk(
  deps: SyncDeps, chunk: PendingPhysical[], special: SpecialFolderMap, at: CyclePageCursor,
): Promise<{ reopened: boolean } | null> {
  const { adapter, accountId, mailboxId, log } = deps;
  if (typeof adapter.moveMany !== "function") return null;
  const first = chunk[0]!;
  const srcFolder = first.nativeLocator!.folder;
  // Mail 0065: the group was KEYED on its physical destination (a spam-pile desire maps to the
  // provider's Junk unless the placement was AI-authored), so its members share this by
  // construction.
  const toFolder = first.physical;
  // A locator already sitting at its destination is the per-message path's problem to reason
  // about, not a batch's: `moveMany` refuses a same-folder group outright.
  if (srcFolder === toFolder) return null;
  // Two rows naming ONE locator would collapse to a single UID in the batch and both would be
  // told they landed at the same place. It cannot arise from one mailbox's data, and if it ever
  // does, the per-message path gives each row its own answer.
  const refs = new Set(chunk.map((p) => p.nativeLocator!.ref));
  if (refs.size !== chunk.length) return null;

  // BEFORE the IMAP command — the whole batch is one mutation, and one filing page. Outside the
  // `try` below deliberately: its refusal must abort the cycle, never degrade to the per-message path.
  openPage(at, "filing");
  await assertMayWriteToMailbox(writeAuthorityOf(deps));
  let result;
  try {
    result = await adapter.moveMany(chunk.map((p) => p.nativeLocator!), toFolder);
  } catch {
    return null;
  }
  // THE THREE ANSWERS, and the third is the one this used to get wrong. `declined` is a refusal
  // taken BEFORE any command, so the group is owed to the per-message path. `moved_unmapped` says
  // the mail HAS moved and the server would not name where — sending those members to `fileOne`
  // spends a round trip each rediscovering the source is gone, so the chunk answers HANDLED with
  // nothing written: every row stays pending and due, and the next `changesSince` adopts what the
  // server shows, exactly as the uncommitted-bookkeeping path below already does.
  if (result.outcome === "declined") return null;
  if (result.outcome === "moved_unmapped") {
    log?.warn("reconcile_move_batch_unmapped", {
      mailboxId, accountId, size: chunk.length, to: folderLabel(toFolder),
      reason: "the mail server moved this group and did not say where each message landed; " +
        "nothing was recorded, every row stays pending, and the next scan adopts the moves",
    });
    return { reopened: false };
  }

  // ONE WRITE GROUP for the whole chunk's bookkeeping — a transaction whether or not there is a fence
  // (see {@link fencedGroup}). It has to be: a chunk's locator/state/audit writes that half-commit
  // leave some members claiming a destination their `folder_state` disagrees with, and the batched
  // path has no per-member retry to notice. A failure of the group is contained rather than rethrown,
  // and the chunk still answers HANDLED (non-null): the moves LANDED (`moveMany` reports `batched`
  // only for a group it performed whole and mapped), so sending the members to `fileOne` would spend one round
  // trip each rediscovering the source is gone. Nothing was written, every row is still pending and
  // due, and the next `changesSince` adopts what the server shows — the same convergence a crash takes.
  let reopened = false;
  let landed = 0;
  try {
    await fencedLiveGroup(deps, async (r) => {
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
        if (!newLoc) { await voidGoneFiling(r, accountId, p, special); continue; }
        // Mail 0065: ONE completion writer for every path that lands a move — the ordinary
        // converge, the junk filing's satisfied/parked/husked shape, and the delete's park.
        // Written ONLY here, after `moveMany` reported the batch whole: the claim follows the
        // move (see junk-filing.ts's header, and the guard that reddens the other ordering).
        landed++;
        reopened = (await completeFiling(r, accountId, mailboxId, p, newLoc, special)) || reopened;
        // The audit rows are written together, AFTER the state they describe. One INSERT instead of
        // fifty, and the same rows a per-message pass would have written — the admin surface and the
        // inverse both read this table and neither can tell which path filed the mail.
        const junk = junkAuditCode(p.desiredFolder, newLoc.folder, special);
        audits.push({
          action: "reconcile.move",
          payload: {
            messageId: p.messageId, from: p.nativeLocator, to: newLoc.folder, newLocator: newLoc,
            ...(junk ? { junk } : {}),
          },
          inverse: { action: "move", locator: newLoc, toFolder: p.nativeLocator!.folder },
        });
      }
      if (audits.length > 0) await recordAudits(r, accountId, audits);
    });
  } catch (err) {
    rethrowRefusal(err);
    log?.error("reconcile_move_batch_uncommitted", {
      mailboxId, accountId, size: chunk.length, to: toFolder, err,
      reason: "the batched IMAP move succeeded and its bookkeeping did not commit; every row " +
        "stays pending and due, and the next cycle adopts the completed moves",
    });
  }
  // THE RECEIPT FOR AN APPLIED FILING — one line per IMAP command, not per message. A whole layer
  // trace of a live move used to produce no apply-side event at all, so "never dispatched" and
  // "moved silently" read identically. Folder names go through {@link folderLabel}; no address,
  // subject or recipient exists on this path to leak.
  if (landed > 0) {
    log?.info("reconcile_move_batched", {
      mailboxId, accountId, moved: landed,
      fromFolder: folderLabel(srcFolder), toFolder: folderLabel(toFolder),
    });
  }
  return { reopened };
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
 * The terminal check for a GONE member: void the filing if the message no longer exists anywhere this
 * mailbox's record knows of. "Gone from the source" has two readings needing opposite treatment. A
 * message MID-MOVE (a prior run's crash before the DB write, or an external move whose create is a
 * batch behind its delete) must stay pending — `changesSince` adopts, and writing here would race it. A
 * message EXPUNGED OUTRIGHT has no adoption event coming, and before this branch such a row stayed
 * `pending` for good, holding the "Filing N messages…" count up indefinitely with no audit row.
 * `primaryInstanceVanished` tells them apart — the SAME predicate ingest treats as adoption evidence,
 * true only once the DELETE is durably observed under a matching epoch. The write is the COMPLETION write (`observed := desired`), and `native_locator` is left alone deliberately (clearing it would erase the adoption evidence). Takes the repo it must write through, because one caller is already fenced.
 */
async function voidGoneFiling(
  repo: WorkerRepo, accountId: string, p: PendingFolderState, special: SpecialFolderMap,
): Promise<void> {
  if (!(await repo.primaryInstanceVanished(p.messageId))) return;
  /* A RESTORE OUT OF TRASH IS VOIDED AGAINST THE OBSERVATION, NEVER `observed := desired`.
   * A mail server empties its own Trash on its own schedule, so between the delete's move and the
   * restore's the copy can be gone — and completing the restore would say the message is back in
   * INBOX with the server holding nothing anywhere. The observation is what is true: it is still
   * where it last was, and there is no copy left to carry. The tombstone stands (nothing here
   * clears `deleted_at`; only a LANDED move does), the row leaves the queue converged on the
   * truth, and the restore verb refuses at the door rather than queueing a move that cannot run. */
  const trash = special.trashFolder;
  if (trash !== null && p.observedFolder === trash && p.desiredFolder !== trash) {
    const adopted = await repo.adoptFolderState(
      p.messageId,
      { desiredFolder: p.observedFolder, observedFolder: p.observedFolder, lastSetBy: p.lastSetBy },
      p.desiredFolder,
    );
    /* `reconcile.move.voided` and not a word of its own: `audit_log.action` is a CLOSED SET
       (`auditAction` refuses anything outside it, which is how this arm was caught writing one),
       and a purged restore IS a voided move. What makes it this kind of void is the reason below,
       which is where the fact belongs. */
    await repo.recordAudit(
      accountId,
      adopted ? "reconcile.move.voided" : "reconcile.move.superseded",
      {
        messageId: p.messageId, from: p.nativeLocator, to: p.desiredFolder,
        reason: adopted
          ? "the copy this restore would have carried is no longer on the mail server — the "
            + "message stays deleted, and the restore is not offered again"
          : "the gone-restore void was computed against a desired folder that has since changed; "
            + "nothing was written and the newer intent stands",
      },
      null,
    );
    return;
  }
  // CONDITIONAL, for `completeFolderState`'s stated reason: `p` was read before this pass's IMAP
  // work, so voiding through `upsertFolderState` would write a superseded desire back over a
  // decision committed since — and a VOID is the worst place to do it, because the row leaves the
  // reconciler's queue and the newer intent would never be attempted at all. A declined void
  // leaves the new intent pending; the next cycle raises `MessageGoneError` against it and voids
  // that one, so the convergence still terminates, one cycle later and against the right value.
  if (!await repo.completeFolderState(p.messageId, {
    expectDesiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us",
  })) {
    await repo.recordAudit(
      accountId, "reconcile.move.superseded",
      {
        messageId: p.messageId, filedAgainst: p.desiredFolder, to: p.desiredFolder,
        reason: "the gone-message void was computed against a desired folder that has since " +
          "changed (or the row was erased); nothing was written and the newer intent stands",
      },
      null,
    );
    return;
  }
  await repo.recordAudit(
    accountId, "reconcile.move.voided",
    { messageId: p.messageId, from: p.nativeLocator, to: p.desiredFolder },
    null,
  );
}

/**
 * The per-message path: one move, its own verdict, its own audit row, its own deferral. THE TWO SEAMS
 * ARE HANDLED SEPARATELY: a refused MUTATION and a failed COMPLETION look the same from one `try` and
 * mean opposite things. `adapter.move` threw ⇒ the server did not move it, nothing changed, we still
 * owe it, and asking again immediately eats the filing budget — this earns a DEFERRAL. The write group
 * threw ⇒ the server ALREADY MOVED THE MAIL and only our record failed, so the database and mailbox
 * disagree, and deferring would hold that open for the backoff (the client showing a message in a
 * folder it is not in) — so this is never deferred, the row is left pending and DUE, and the next cycle
 * converges the documented way. Folding them together produced a `reconcile.move.failed` row asserting a move that HAD succeeded was refused, and put the correction to sleep behind it.
 */
async function fileOne(
  deps: SyncDeps, p: PendingPhysical, special: SpecialFolderMap, at: CyclePageCursor,
): Promise<boolean> {
  const { adapter, accountId, mailboxId, log } = deps;
  // Mail 0065: the physical destination was decided when the row was grouped — a spam verdict
  // files into the provider's native Junk when the mailbox has one and the placement was not
  // AI-authored; everything else is already physical.
  const physical = p.physical;
  // Typed off the adapter's own signature rather than by importing `NativeLocator`: this module
  // reaches core through `/mail` and `/adapters/imap` only, and neither exports that name — see the
  // import block's note on what naming the bare barrel here would drag into the desktop engine.
  let newLoc: Awaited<ReturnType<MailboxAdapter["move"]>>;
  try {
    openPage(at, "filing");
    await assertMayWriteToMailbox(writeAuthorityOf(deps));
    newLoc = await adapter.move(p.nativeLocator!, physical);
  } catch (err) {
    // A refusal must not be recorded as this message's failure — it is the process's, or the
    // mailbox's new organizer's. A stand-down taken here used to fall through to the deferral
    // below: an audit row blaming the mail server, and the pass filing the rest of the page.
    rethrowRefusal(err);
    if (err instanceof MessageGoneError) {
      // Already moved (crash between IMAP move and DB update) → leave pending; the next
      // changesSince adopts it. Expunged outright → nothing will ever adopt it; see
      // voidGoneFiling for how the two are told apart.
      await fencedLiveGroup(deps, (r) => voidGoneFiling(r, accountId, p, special));
      return false;
    }
    if (isTransportFailure(err)) {
      // Not evidence about this message — the host is unreachable, or our own database is. The row is
      // left exactly as it was: due now, attempts unchanged, no audit row. So a mailbox whose provider
      // was down for ten minutes files its whole backlog the moment it is back, instead of coming up
      // with every pending move deferred by a failure none of them caused. The pass CONTINUES rather
      // than aborting the cycle, deliberately: an abort here would convert one provider outage into the
      // path that detaches and quarantines a mailbox, blaming it for a fault not its own. The cost of
      // continuing is one refused round trip per pending row for the outage — bounded by the cycle's
      // budget, and self-clearing the moment the host answers.
      log?.warn("reconcile_move_transport_failure", {
        mailboxId, accountId, messageId: p.messageId, to: physical, err,
      });
      return false;
    }
    // One message's refusal must not abandon the pass, and must not repeat for ever. This used to
    // rethrow, taking the whole reconcile pass with it: every OTHER pending move, and (because
    // `reconcileFlags` runs after) every pending `\Seen` push too — one message the server will not
    // move meant nothing else moved either, every cycle, for as long as it stayed pending. That was
    // survivable only while a stuck move erased itself (ingest declared it complete on seeing its
    // destination copy); it no longer does — a move is complete when the source is GONE — so a row
    // whose expunge keeps failing stays in this queue, and rethrowing would make one unhappy message a
    // mailbox-wide outage. Isolation alone left it unbounded in TIME, which this deferral closes: the
    // failure is recorded AND the row is put to sleep on a widening schedule with a floor. Both writes
    // are ONE GROUP — a deferral without its audit row goes quiet with nothing saying why, the reverse is the unbounded retry.
    const attempts = (p.attempts ?? 0) + 1;
    const nextAttemptAt = nextReconcileAttemptAfter(attempts, new Date());
    // The CLASS rides in the same group as the schedule and the audit row — see
    // {@link classifyMoveRefusal} for why the output is four words, and `WorkerRepo.
    // deferFolderReconcile` for why it is an argument to the deferral rather than a write of its
    // own. A class without its schedule is a reason for nothing.
    const errorClass = classifyMoveRefusal(err);
    await fencedLiveGroup(deps, async (r) => {
      await r.recordAudit(
        accountId,
        "reconcile.move.failed",
        {
          messageId: p.messageId,
          from: p.nativeLocator,
          // The PHYSICAL destination the server refused — under the junk mapping that is the
          // native Junk path, and recording the pile instead would blame a folder the command
          // never named.
          to: physical,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          attempts, nextAttemptAt: nextAttemptAt.toISOString(), errorClass,
        },
        null,
      );
      await r.deferFolderReconcile(p.messageId, { attempts, nextAttemptAt, errorClass });
    });
    return false;
  }

  // THE MOVE LANDED. Its completion is ONE FACT — locator, converged state and audit row commit
  // together or not at all. {@link fencedGroup} carries the argument, including which side leads
  // in the seam a transaction cannot cover (the server's, always).
  let reopened = false;
  try {
    await fencedLiveGroup(deps, async (r) => {
      // Mail 0065: the shared completion writer — see junk-filing.ts and fileChunk's note. The
      // claim ("this message is in Junk") is written only here, after the move returned.
      reopened = await completeFiling(r, accountId, mailboxId, p, newLoc, special);
      log?.info("reconcile_move", {
        mailboxId, accountId, messageId: p.messageId, ref: newLoc.ref,
        fromFolder: folderLabel(p.nativeLocator!.folder), toFolder: folderLabel(newLoc.folder),
      });
      const junk = junkAuditCode(p.desiredFolder, newLoc.folder, special);
      await r.recordAudit(
        accountId, "reconcile.move",
        {
          messageId: p.messageId, from: p.nativeLocator, to: newLoc.folder, newLocator: newLoc,
          ...(junk ? { junk } : {}),
        },
        { action: "move", locator: newLoc, toFolder: p.nativeLocator!.folder },
      );
    });
  } catch (err) {
    rethrowRefusal(err);
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
  return reopened;
}

/**
 * A pending `\Seen` with no locator: what it is, and what is owed to it. This arm was
 * `if (!p.nativeLocator) continue;` — the one branch of {@link reconcileFlags} that left the queue
 * without a bound, an audit row or a log line, while every sibling writes at least one. A user's "mark
 * as read" that landed here disappeared in the exact shape "I marked it read on the desktop and the
 * mailbox never saw it". The invariant: a flag intent whose message has no locator cannot be sent and
 * will not become sendable on its own; it is deferred on the shared backoff while a locator could still
 * arrive, then retired with an audit row that names why. The DEFERRAL-first (not immediate void) is
 * because the tombstoned header row survives (identity, resurrect-on-return), so a copy CAN come back. `primaryInstanceVanished` answers FALSE for an absent locator, so this cannot reuse the `MessageGoneError` arm's void — that would fabricate an observation of a server never asked. `RECONCILE_BACKOFF_MINUTES`; the terminal write is paired with `reconcile.flags.retired`.
 */
async function retireLocatorlessFlag(deps: SyncDeps, p: PendingFlagState): Promise<void> {
  const { accountId, mailboxId, log } = deps;
  const attempts = (p.attempts ?? 0) + 1;
  const spent = attempts >= RECONCILE_BACKOFF_MINUTES.length;
  await fencedLiveGroup(deps, async (r) => {
    await r.recordAudit(
      accountId,
      spent ? "reconcile.flags.retired" : "reconcile.flags.no_locator",
      {
        messageId: p.messageId,
        seen: p.desiredSeen,
        attempts,
        reason: spent
          ? "the message has no locator and the deferral schedule is spent, so the read-state " +
            "intent is retired rather than re-read every cycle for ever; the server was never asked"
          : "the message has no locator, so there is no UID to STORE against; the intent is kept " +
            "and deferred in case a copy returns",
      },
      null,
    );
    if (spent) {
      // The ONLY write that takes this row out of `pending` through this port. Paired with the
      // audit row above, and never issued without it — see the header.
      await r.upsertFlagState(p.messageId, {
        desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us",
      });
    } else {
      await r.deferFlagReconcile(p.messageId, {
        attempts, nextAttemptAt: nextReconcileAttemptAfter(attempts, new Date()),
      });
    }
  });
  log?.warn("reconcile_flag_no_locator", {
    mailboxId, accountId, messageId: p.messageId, attempts,
    state: spent ? "retired" : "deferred",
    reason: "a pending read-state intent has no locator to STORE against; the message's only " +
      "watched copy went with a deleted folder",
  });
}

/**
 * Push OUR intended read-state to IMAP — the `\Seen` mirror of `reconcileFolders`, and the reason
 * `PATCH /messages` can write intent and stop. The `lastSetBy !== "us"` guard is the SAME user-wins
 * rule, and not a formality here: an external row is written by `applyExternalFlag` precisely when the
 * server disagreed with us, so pushing one would mark read again a message the user deliberately marked
 * unread in another client — drop this line and the product argues with its user in a loop.
 * Deliberately AFTER the folder pass: a moving message has a locator about to change, and
 * `reconcileFolders` has just written the new one, so this reads the fresh value instead of a UID the
 * STORE would miss.
 */
async function reconcileFlags(deps: SyncDeps, at: CyclePageCursor): Promise<boolean> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  /* ONE MORE THAN THE BUDGET — the folder pass's shape: the extra row is how "there is more" is
   * known without a second COUNT, and it is never worked. See {@link RECONCILE_FLAGS_PER_CYCLE}. */
  const due = await repo.listPendingFlagStates(mailboxId, RECONCILE_FLAGS_PER_CYCLE + 1);
  const owesMore = due.length > RECONCILE_FLAGS_PER_CYCLE;
  const pending = owesMore ? due.slice(0, RECONCILE_FLAGS_PER_CYCLE) : due;
  for (const p of pending) {
    if (p.lastSetBy !== "us") continue;                       // user-wins: never revert an external \Seen
    if (p.desiredSeen === p.observedSeen) {
      await fencedLiveGroup(deps, (r) => r.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us" }));
      continue;
    }
    if (!p.nativeLocator) { await retireLocatorlessFlag(deps, p); continue; }
    try {
      // A READER pushes `\Seen` too and holds no lease, so its authority admits here by naming
      // itself — see `OrganizerWriteAuthority`. An ORGANIZER's `\Seen` is permit-checked like any
      // other write, which it was not before.
      openPage(at, "flags");
      await assertMayWriteToMailbox(writeAuthorityOf(deps));
      await adapter.setFlags(p.nativeLocator, { seen: p.desiredSeen });
    } catch (err) {
      // A lost lease — this shard's or this mailbox's — is never evidence about this message. Those
      // are the throws that still leave this loop, and they must leave it unreclassified.
      rethrowRefusal(err);
      if (err instanceof MessageGoneError) {
        // The message left this locator between the DB read and the STORE. Mid-move, the next
        // changesSince refreshes the locator and this retries. Expunged outright, no refresh is
        // ever coming — voidGoneFiling's argument, one flag over — so the intent is voided the
        // same way rather than re-STOREd (one IMAP round trip per cycle) for ever.
        await fencedLiveGroup(deps, async (r) => {
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
      // The rethrow that used to be here was a mailbox-wide outage per message. Anything that was not
      // a `MessageGoneError` left this loop, so it left `reconcileMailbox`, so it failed the whole
      // cycle: one message whose `\Seen` the server refuses meant no other pending read-state reached
      // the server, the folder pass's `owesMore` re-kick was discarded on the way out, and `index.ts`
      // counted a mailbox failure every cycle until detach and quarantine — and restart reconciliation
      // did it again. The folder pass had per-item isolation for exactly this and this loop did not,
      // the asymmetry that made a refused STORE more destructive than a refused MOVE. Same treatment
      // now, deferral included: record it, sleep it on the widening schedule, keep going. The user's
      // intent survives (`desired_seen` untouched), so a host that starts accepting the STORE converges then.
      const attempts = (p.attempts ?? 0) + 1;
      const nextAttemptAt = nextReconcileAttemptAfter(attempts, new Date());
      await fencedLiveGroup(deps, async (r) => {
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
      await fencedLiveGroup(deps, async (r) => {
        await r.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us" });
        await r.recordAudit(
          accountId, "reconcile.flags",
          { messageId: p.messageId, locator: p.nativeLocator, seen: p.desiredSeen },
          { action: "setFlags", locator: p.nativeLocator, seen: !p.desiredSeen },
        );
      });
    } catch (err) {
      rethrowRefusal(err);
      log?.error("reconcile_flag_uncommitted", {
        mailboxId, accountId, messageId: p.messageId, seen: p.desiredSeen, err,
        reason: "the IMAP STORE succeeded and its bookkeeping did not commit; the row stays " +
          "pending and due, and the server's own flag is adopted on a later cycle",
      });
    }
  }
  return owesMore;
}
