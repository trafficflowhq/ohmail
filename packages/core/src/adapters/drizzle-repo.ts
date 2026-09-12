import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { accountStorage, changeLog, messages, messageInstances, messageFailures, folderOps, folderState, flagState, mailboxes, mailboxCredentials, mailboxFolders, threads, rules as rulesTbl, contacts as contactsTbl, auditLog, messageBodies, attachments as attachmentsTbl, routingDecisions, approvals, graduations, recordRouteOverride, routeOverrideActionId, awayReplies, recordChange as recordChangeTx, recordChanges as recordChangesTx, bodyBytesOf, reserveBodyBytes, reserveBodyBytesEvicting, releaseBodyBytes, type ChangeInput, type LedgerTx, type Tx, type EntityType, ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS, dueNow as sharedDueNow, type FilingRefusalClass } from "@trafficflow/db";
import type {
  RepoPort, RoutingPort, ExternalOverrideInput, ExternalOverrideOutcome,
  StoredMessage, InsertedMessage, InsertMessageInput, FolderStateRow, FlagStateRow,
  FolderAttribution,
  Rule, NativeLocator, EmailAddress,
  MessageBodyInput, BodyStorageContext, BodyStorageOutcome, RepoChangeInput, RoutingDecisionInput, ApprovalInput, AttachmentMeta,
  ThreadParent, ThreadUpsertInput, ThreadUpsertResult, ThreadMergeInput,
  // `../mail.js`, not `../index.js`: the repository adapter needs the mail vocabulary, and the
  // default barrel re-exports the model half beside it — so naming it here would put the
  // classifier and the drafter into the import graph of every artifact that stores a message.
} from "../mail.js";
import type { NormalizedMessage } from "../types.js";
import {
  unhuskJunkFiledBody as unhuskJunkFiledBodyTx,
  type JunkHuskIdentity, type JunkUnhuskOutcome,
} from "../husk-restore.js";
import { dialect, pgOnly, type Dialect } from "@trafficflow/db/dialect";
import { effectForDestination } from "../rules.js";
// The Sent shape's single source — the stale-residue cleanup must never take a Sent row (its
// export in imap-types.ts carries the watermark argument).
import { SENT_SHAPED_CANONICAL } from "./imap-types.js";
import { providerAuthservIds } from "../authserv-ids.js";

export interface PersistedFolderCursor {
  uidValidity: string; uidNext: number; highestModseq: string;
  /** Mail 0083 — the folder's `EXISTS`. Absent ⇒ the stored value is LEFT ALONE, not nulled. */
  serverExists?: number;
}
/**
 * One message this mailbox already stores, as the adapter's known-set needs it.
 *
 * `uidValidity` IS PART OF THE IDENTITY, and dropping it was a real defect a review caught. A UID
 * number is only meaningful inside one server epoch: a folder that resets its UIDVALIDITY commonly
 * re-allocates from low numbers, so `uid: 2` under the old epoch and `uid: 2` under the new one are
 * two different messages. Handing the adapter a bare number let a new-epoch message whose number
 * had been reused be treated as already known — its body was never fetched, and once the
 * enumeration drained, the new epoch's cursor was persisted past it. Permanently.
 */
export interface KnownLocator {
  folder: string; uid: number; uidValidity: string; messageId: string | null;
  /**
   * The `\Seen` state the database last observed at this locator — `flag_state.observed_seen`
   * when a flag row exists, otherwise the read state ingest derived from the server's own flags
   * (`!messages.unread`). This is the baseline the adapter's no-CONDSTORE flag fallback diffs
   * the server against; see `KnownEntry.seen`.
   */
  seen: boolean | null;
}
export interface PendingFolderState {
  messageId: string; desiredFolder: string; observedFolder: string;
  lastSetBy: FolderAttribution; nativeLocator: NativeLocator | null;
  /**
   * Refusals already on record for this move (mail 0058), which the reconciler's bounded backoff
   * reads to decide how long to defer the next attempt.
   *
   * OPTIONAL on the port, unlike every field beside it, because the absent value is the SAFE one:
   * a repo that does not report it (a fake, an older implementation) reads as zero refusals, so
   * the next failure earns the FIRST and shortest deferral rather than the last and longest. The
   * failure mode of guessing wrong here is a mutation retried a minute later instead of six hours
   * later — never a mutation dropped.
   */
  attempts?: number;
  /**
   * `messages.deleted_at` as the cycle read it, so a landed move can skip the un-delete when
   * there is no tombstone to clear (`junk-filing.ts#completeFiling`).
   *
   * THREE STATES, and the third is why this is not a boolean: a `Date` is tombstoned, `null` is
   * positively not, and ABSENT is a producer that does not report it (a fake, the sweep's
   * synthesised rows). Absent must behave as today — attempt the clear — because skipping an
   * un-delete that was owed leaves a live message missing from every mirror, while attempting one
   * that is not owed costs a round trip. So only an explicit `null` skips.
   */
  deletedAt?: Date | null;
}
/**
 * ONE message the re-route pass may reconsider: still desired into `ohmail/Screener`, and
 * carrying everything `evaluateRules` needs to decide again — no IMAP, only persisted headers.
 */
export interface ScreenerBacklogRow {
  messageId: string;
  fromAddress: string;
  subject: string;
  /** `message_bodies.headers`, lowercased names → raw values. `{}` when the body row is absent. */
  headers: Record<string, string[]>;
  observedFolder: string;
}
/**
 * ONE message the thread backfill has to resolve: still `thread_id IS NULL`, and carrying
 * everything `resolveThread` reads — all of it from disk, no IMAP and no MIME re-parse.
 */
export interface ThreadBacklogRow {
  messageId: string;
  messageIdHeader: string | null;
  subject: string;
  fromAddress: string;
  date: Date | null;
  /** `message_bodies.headers`, lowercased names → raw values. `{}` when the body row is absent. */
  headers: Record<string, string[]>;
}

/**
 * ONE `junk_filed` husk the worker's restore pass may refill: the husk row's identity (what the
 * verify witness checks against) plus the live PRIMARY instance's locator — the watched copy the
 * scan observed, which is where the bytes are re-read from. See {@link WorkerRepo.listJunkFiledHusks}.
 */
export interface JunkFiledHuskRow {
  messageId: string;
  dedupKey: string;
  messageIdHeader: string | null;
  /** The primary instance's site — the folder the message is demonstrably alive in. */
  folder: string;
  uidValidity: string;
  uid: number;
}

/** A `flag_state` row still owed an IMAP write, joined to the locator the write needs. */
export interface PendingFlagState {
  messageId: string; desiredSeen: boolean; observedSeen: boolean;
  lastSetBy: FolderAttribution; nativeLocator: NativeLocator | null;
  /** Refusals on record for this `\Seen` write — see {@link PendingFolderState.attempts}. */
  attempts?: number;
}
/** What `applyExternalFlag` did — `null` when no message sits at that locator. */
export interface ExternalFlagOutcome {
  messageId: string;
  /** False when OUR write is still pending: the user's intent wins and nothing was touched. */
  applied: boolean;
  /** `messages.unread` actually moved → the caller owes a `change_log` row. */
  changed: boolean;
}

/**
 * ONE UID the sync loop could not ingest — the durable half of the dead-letter decision.
 *
 * Content-free by construction: a coordinate, a closed-set reason and three counters. See
 * `message_failures` in `packages/db/src/schema-mail.ts` for why nothing else may ever be added,
 * and for why the table is never granted to the console's role.
 */
export interface MessageFailureRow {
  folder: string;
  uidValidity: string;
  uid: number;
  code: string;
  attempts: number;
}

/** What {@link WorkerRepo.recordMessageFailure} is told about one failure. */
export interface MessageFailureInput {
  accountId: string;
  folder: string;
  uidValidity: string;
  uid: number;
  code: string;
  /** The build recording it. `IS DISTINCT FROM` the running one is what makes a row due again. */
  version: string;
  /**
   * When a CLOCK-scheduled retry is due, or `null` for "no clock-retry — the version arm only".
   *
   * Deterministic failures are born `null`: `mime_too_large` and `mime_unparseable` are
   * deterministic in the raw bytes by the contract on `mime.ts`'s two typed errors, so a clock can
   * never change their answer and every timed attempt would re-download the body it is about to
   * refuse. See `apps/worker/src/dead-letter.ts#nextAttemptAfter`.
   */
  nextAttemptAt: Date | null;
}

/**
 * ONE pending user command on a folder (`folder_ops`, mail 0074), subject path joined in — the
 * worker's pass never re-derives it, so a command always executes against the row's CURRENT spelling
 * (an earlier rename in the same queue has already re-spelt it by the time this one runs).
 */
export interface FolderOpRow {
  id: string;
  accountId: string;
  mailboxId: string;
  /** The subject `mailbox_folders` row — the `folder` entity's id on the wire. */
  folderId: string;
  /** The subject's canonical path, read in the same query. */
  folder: string;
  op: "create" | "rename" | "delete";
  /** The rename's target canonical path; null for the other two. */
  toFolder: string | null;
  attempts: number;
}

/**
 * What a landed IMAP move may write back — {@link WorkerRepo.completeFolderState}'s argument,
 * deliberately not a {@link FolderStateRow}. A FolderStateRow states an intent; a completion
 * records where the message physically IS after a move that was decided earlier, possibly by
 * another writer. The desired folder appears only as `expectDesiredFolder` — the witness the move
 * was computed against, read back live and compared, never itself written.
 */
export interface FolderCompletion {
  /**
   * The desired folder this completion was COMPUTED AGAINST. Never written — see
   * {@link WorkerRepo.completeFolderState} — but always READ live and compared: it decides
   * whether this call's caller gets credit for the row (a matched witness) or whether
   * {@link observedFolder} may STILL be recorded on a miss, per {@link physicalObservation}.
   */
  expectDesiredFolder: string;
  /**
   * Where the server now holds the message — OR, when {@link physicalObservation} is false, a
   * value that only matters if this call turns out to MATCH (a miss ignores it entirely). Never
   * write a stale echo here with `physicalObservation: true`; see that flag's own doc.
   */
  observedFolder: string;
  lastSetBy: FolderAttribution;
  /**
   * See {@link FolderStateRow.satisfiedBy} — derives the status, never stored (there is no
   * column), and only ever credited when {@link expectDesiredFolder} still matches the row's live
   * desire: a stale witness may not claim satisfaction of a desire it no longer describes.
   */
  satisfiedBy?: string | null;
  /**
   * Whether {@link observedFolder} carries a fresh physical fact — a location the server just
   * confirmed from a landed `adapter.move`/`moveMany`. `true` (junk-filing.ts's `settle`, the
   * only caller with a landed move) makes a miss still write
   * `observed_folder`/`reconcile_status`/`conflict`, so a superseded completion's physical fact
   * is not lost. `false` (the default) keeps a miss writing nothing: the status repair in
   * `reconcileFolders` and {@link voidGoneFiling} pass a stale echo of `PendingFolderState`, and
   * writing it on a miss would overwrite what a fresher writer had just committed.
   */
  physicalObservation?: boolean;
}

/** Worker-facing repo: everything the pipeline needs (RepoPort + RoutingPort) plus enumeration for sync/reconcile. */
export interface WorkerRepo extends RepoPort, RoutingPort {
  /**
   * The completion write, and why it is not {@link RepoPort.upsertFolderState}: a filing reads a
   * pending row, dials the network, and writes back minutes later, while `desired_folder` has six
   * other writers — completing through `upsertFolderState` would write the stale desire back, a
   * lost update. `desired_folder` is not in this SET list at all. A caller with a fresh physical
   * fact (`c.physicalObservation`) gets `observed_folder` written on every call; others write
   * nothing on a miss. `reconcile_status` is derived from the row's live desire; a divergent row
   * stays pending and re-enters {@link listPendingFolderStates}. Returns true when the desire
   * still matched, false when a newer intent owns the row.
   */
  completeFolderState(messageId: string, c: FolderCompletion): Promise<boolean>;
  getMailbox(mailboxId: string): Promise<
    { id: string; accountId: string; address: string; kickstartAt: Date | null } | null
  >;
  /** Record that the kickstart COMPLETED. Returns false when it had already run. */
  markKickstarted(mailboxId: string, at: Date): Promise<boolean>;
  /**
   * Upsert known correspondents. Returns how many rows were genuinely NEW, which is what makes
   * "a second connect does not re-import" observable rather than merely asserted.
   */
  upsertContacts(accountId: string, addresses: readonly string[]): Promise<number>;
  /**
   * One page of the Screener backlog the re-route pass may reconsider, locked FOR UPDATE. Both
   * halves of the never-override-a-user-decision rule live in the statement: the sender (or
   * domain) has no enabled, un-narrowed rule — a rule carrying `subject_contains`/`body_contains`
   * (mail 0050, 0052) is a conjunction about a subset of that sender's mail and rules on nothing
   * else — and `last_set_by = 'us'`, so placements the user or a peer install made are never
   * reconsidered. `FOR UPDATE OF folder_state` serializes two workers mid-leader-handover: the
   * loser re-evaluates against the committed row, so a message is re-routed once.
   */
  listScreenerBacklog(
    mailboxId: string, opts: { limit: number; afterId?: string },
  ): Promise<ScreenerBacklogRow[]>;
  /**
   * One page of the threading backlog for an ACCOUNT — messages with no `thread_id`, oldest
   * first, locked. Account-scoped and not mailbox-scoped because the threading key is: a reply
   * delivered to one mailbox may answer mail that arrived in another.
   */
  listThreadBacklog(accountId: string, limit: number): Promise<ThreadBacklogRow[]>;
  /**
   * `pg_advisory_xact_lock(ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS, hashtext(accountId))` — taken
   * before {@link listThreadBacklog} in every batch. Serializes the backfill against account
   * erasure, the one other writer that locks a whole account's `threads`/`messages` in bulk and
   * in the OPPOSITE order (see the constant's own doc). Nothing else needs it: every other
   * writer of a thread touches only the few rows one message or merge group involves.
   */
  lockAccountThreadStructure(accountId: string): Promise<void>;
  getMailboxFolders(mailboxId: string): Promise<Array<{ folder: string } & PersistedFolderCursor>>;
  upsertMailboxFolder(mailboxId: string, folder: string, cursor: PersistedFolderCursor): Promise<void>;
  /* ── USER-COMMANDED FOLDER OPERATIONS (`folder_ops`, mail 0074; FOLDERS-SPEC.md stage 2) ─────
   * The worker's repo half (apps/worker/src/folder-ops.ts drives these, fenced). The API
   * records commands; these apply their database consequences beside the IMAP writes. */
  /** Pending commands of one mailbox, FIFO by request time — failed rows wait for dismissal. */
  listFolderOps(mailboxId: string): Promise<FolderOpRow[]>;
  /**
   * A create landed on the server: retire the command, emit the settled entity — re-spelt to
   * `landed` when a personal-namespace server filed it elsewhere, or retired in favour of the
   * row discovery already adopted there. One tx.
   */
  completeFolderCreate(op: Pick<FolderOpRow, "id" | "accountId" | "mailboxId" | "folder" | "folderId">, landed: string): Promise<void>;
  /**
   * The rename swap: everything that spells the old path, re-spelt under the new one, in one
   * transaction beside the IMAP RENAME — the inventory subtree with cursors intact,
   * `folder_state` desired and observed, `messages.native_locator`, `message_instances.folder`,
   * `message_failures.folder`, plus the change rows that carry the swap to every mirror through
   * `recordChanges`. All-or-nothing is the contract the pg test kills a transaction to prove: a
   * crash mid-swap leaves the old spelling everywhere and the command still pending, and the
   * pass's idempotent-completion arm re-enters.
   */
  applyFolderRename(op: Pick<FolderOpRow, "id" | "accountId" | "mailboxId" | "folder"> & { toFolder: string }): Promise<{ folders: number; messages: number }>;
  /** The subtree (subject included) of one canonical path, leaf-deepest FIRST — delete order. */
  listFolderSubtree(mailboxId: string, folder: string): Promise<Array<{ id: string; folder: string }>>;
  /**
   * One CHUNK of the folder delete's mirror consequences, after the server sweep moved the
   * folder's mail to native `\Trash`: tombstone up to `limit` undeleted messages whose rendered
   * folder is exactly `folder` — `deleted_at` + husk (the delete verb's own mirror semantics),
   * instances of the swept folder dropped, any pending `folder_state` row retired, one `message`
   * delete change each. Idempotent (the picked set excludes tombstoned rows), one tx per chunk,
   * so a crash between chunks re-enters. Returns how many it took; 0 ⇒ the folder's mirror side
   * is clean and the row itself may go.
   */
  tombstoneFolderMessages(accountId: string, mailboxId: string, folder: string, limit: number, sentFolder?: string | null): Promise<number>;
  /** The folder left the server: drop its inventory row (CASCADE takes a subject op) + tombstone. */
  removeFolderRow(accountId: string, folderId: string): Promise<void>;
  /** The honest refusal: `status='failed'` + the closed code, carried on the entity until dismissed. */
  failFolderOp(op: Pick<FolderOpRow, "id" | "accountId" | "folderId">, error: string): Promise<void>;
  /** A transient miss: count the attempt, keep the command pending for the next cycle. */
  deferFolderOp(opId: string, attempts: number): Promise<void>;
  listKnownLocators(mailboxId: string): Promise<KnownLocator[]>;
  /**
   * Record that a locator disappeared — the worker's half of the move-evidence rule. On
   * `WorkerRepo` and not `RepoPort` because only the sync loop can observe it: a disappearance
   * arrives as the adapter's `deletes`. See {@link MoveEvidence} for why it alone authorises an
   * adoption. Answers the promoted survivor's locator when removing the primary instance promoted
   * a surviving watched copy, `null` otherwise — a promoted survivor means the message is still
   * in watched space, so a delete filing is not done (`junk-filing.ts#completeFiling`).
   */
  forgetInstanceAt(mailboxId: string, locator: NativeLocator): Promise<NativeLocator | null>;
  /**
   * The mailbox's discovered native `\Junk`/`\Trash` paths (mail 0065) — what the reconciler
   * reads to know where a spam verdict physically files. OPTIONAL on {@link scanSentRecipients}'
   * rule: a repo that does not answer reads as "neither exists", which is the documented
   * fallback (Quarantine / refusal) and never a destructive write.
   */
  getMailboxSpecialFolders?(mailboxId: string): Promise<{ junkFolder: string | null; trashFolder: string | null }>;
  /**
   * Persist the connect-time discovery ({@link MailboxAdapter.findSpecialFolders} → these two
   * columns), re-written on every attach so a renamed folder heals. OPTIONAL, as above.
   */
  setMailboxSpecialFolders?(mailboxId: string, f: { junkFolder: string | null; trashFolder: string | null }): Promise<void>;
  /**
   * Empty one stored body the way the storage cap does — real headers kept, `text=''`,
   * `html=NULL`, the closed marker, bytes released — for the two 0065 reasons. A row already
   * withheld keeps its first reason (see the column's doc). Returns whether content was freed.
   * OPTIONAL so every fake keeps compiling; the caller treats absence as "cannot husk here".
   */
  huskBody?(accountId: string, messageId: string, reason: "junk_filed" | "expunged"): Promise<boolean>;
  /**
   * The reaper: tombstone messages whose every watched instance is gone (mail 0065), bounded by
   * `limit`. Each victim gets `deleted_at`, the `'expunged'` husk and a `change_log` `delete` in
   * the caller's transaction, so every client tombstones the row. Skipped deliberately: rows
   * already tombstoned; rows that never had an instance (`native_locator IS NULL`); and rows
   * whose `folder_state` is reconciled-while-divergent — the junk-parked signature only the
   * `satisfiedBy` completion writes, where no watched instance is the design. Optional; returns
   * how many rows were tombstoned.
   */
  tombstoneInstanceless?(accountId: string, mailboxId: string, limit: number): Promise<number>;
  /**
   * Which of these messages owe their `ohmail/Quarantine` placement to an AI AUTO-APPLY (mail
   * 0065) — a graduated pattern's per-message act, not a user's press and not a rule. The
   * amended product rule allows only USER-COMMANDED writes into the provider's \Junk, so the
   * reconciler's junk mapping excludes these: they file to `ohmail/Quarantine` exactly as
   * before, the conservative direction. OPTIONAL; a repo without it excludes nothing, which is
   * wrong ONLY toward the narrower action (fakes never junk-file at all unless they opt in).
   */
  listAiAutoAppliedQuarantine?(accountId: string, messageIds: readonly string[]): Promise<string[]>;
  /**
   * `junk_filed` husks whose message is alive in watched space — a live primary instance row,
   * `deleted_at` clear — the population the rescue verb never touched. Instances exist only for
   * enumerated folders and the filing completion forgets the parked junk locator, so having a
   * primary instance IS being alive outside Junk; no junk-path comparison to drift. Ordered by
   * message id, bounded, keyset-paged on `afterId`: a refused row keeps its husk and stays a
   * candidate, so a cursorless page would re-offer the same refusals for ever. Optional; absence
   * reads as no candidates, never a wrong restore.
   */
  listJunkFiledHusks?(
    accountId: string, mailboxId: string, opts: { limit: number; afterId?: string },
  ): Promise<JunkFiledHuskRow[]>;
  /**
   * VERIFY + REWRITE one `junk_filed` husk from bytes the caller re-read off the mail server —
   * the shared seam (`husk-restore.ts`) both restore doors end at; see its header for the
   * identity witness, the lock-and-recheck idempotency and the at-cap posture. On the repo so
   * the worker's fence transaction is the one it runs inside. OPTIONAL, as above.
   */
  unhuskJunkFiledBody?(
    accountId: string, husk: JunkHuskIdentity, fresh: NormalizedMessage, capBytes: number | null,
  ): Promise<JunkUnhuskOutcome>;
  /**
   * Every UID of this mailbox that is still owed — failed, and neither ingested nor written off as
   * void. Read at the top of every cycle and merged into the adapter's known-set, which is what
   * stops the poison body being re-fetched on every pass.
   */
  listMessageFailures(mailboxId: string): Promise<MessageFailureRow[]>;
  /**
   * Record (or re-record) one failure, and return the row's attempt count after the write.
   *
   * NOT best-effort at the call site, unlike the `audit_log` row beside it, and that is the whole
   * reason this method exists: the folder cursor may only cross a UID once this row is committed.
   * A caller that swallows a throw here is the mail-loss defect, restored.
   */
  recordMessageFailure(mailboxId: string, input: MessageFailureInput): Promise<number>;
  /**
   * Claim the failures this cycle may retry, atomically, and say what was claimed. One
   * conditional UPDATE: two workers mid-leader-handover both run this, the claim is the decision,
   * the loser blocks on the row lock and matches nothing. Due is `resolved_at IS NULL AND
   * (next_attempt_at <= now() OR attempted_version IS DISTINCT FROM version)`; the version arm
   * self-disarms, so a deploy carrying a parser fix wakes every owed UID once.
   * `holdScheduleForCodes` names codes whose claim writes `next_attempt_at = NULL` —
   * deterministic failures, due again only on a new build, never a later hour (one production row
   * reached 297 hourly attempts).
   */
  claimMessageFailures(
    mailboxId: string,
    opts: {
      version: string; now: Date; limit: number; nextAttemptAt: Date | null;
      holdScheduleForCodes?: readonly string[];
    },
  ): Promise<MessageFailureRow[]>;
  /**
   * Close a failure: it was ingested, or it is gone from the server, or its epoch was renumbered.
   *
   * Idempotent and outside any ingest transaction, deliberately. A crash between the commit and
   * this write leaves the row owed, the next cycle re-reads the same UID, and `planChange`'s
   * dual-key lookup answers `duplicate` — so the replay converges instead of writing a second row.
   */
  resolveMessageFailure(
    mailboxId: string, site: { folder: string; uidValidity: string; uid: number },
  ): Promise<void>;
  /**
   * Desired-state rows still owed an IMAP move. `limit` is the reconciler's per-cycle budget and
   * comes with an ORDER BY: an unordered LIMIT reads physical row order, which moves under UPDATE
   * and VACUUM, so the same rows could be handed over pass after pass. Oldest first — the mail
   * filed first reaches the server first; absent means unbounded. Due rows only (mail 0058): a
   * deferred row is omitted, or the fixed oldest-first allowance would spend every cycle on the
   * same stuck row and starve fresh mail. The row is not retired — it stays `pending` and
   * `MailboxDTO.pendingMoves` still counts it. See {@link deferFolderReconcile}.
   */
  listPendingFolderStates(mailboxId: string, limit?: number): Promise<PendingFolderState[]>;
  /**
   * Defer one refused move: record the refusal and when it may be attempted again (mail 0058).
   * Writes `attempts`, `next_attempt_at` and `error_class`, nothing else: touching the intent
   * columns would let a server's refusal edit what the user asked for; touching
   * `reconcile_status` would invent a terminal state — the row is still owed; touching
   * `updated_at` would move its place in the oldest-first queue. `attempts` is absolute because
   * one organizer writes one mailbox, so the caller's read-then-write is not a race. `errorClass`
   * (mail 0097) is a `FILING_REFUSAL_CLASSES` member the caller mapped — never the server's own
   * words, which stay in the `reconcile.move.failed` audit row.
   */
  deferFolderReconcile(
    messageId: string,
    next: { attempts: number; nextAttemptAt: Date; errorClass: FilingRefusalClass },
  ): Promise<void>;
  /** {@link deferFolderReconcile}, one flag over: defer a refused `\Seen` write. */
  deferFlagReconcile(
    messageId: string, next: { attempts: number; nextAttemptAt: Date },
  ): Promise<void>;
  /**
   * Append MANY audit rows in one INSERT.
   *
   * Same rows, same columns, same order as `recordAudit` would have written them one at a time —
   * this exists only because the batched filing path produces up to a chunk's worth at once and a
   * round trip each is the cost it was written to remove. OPTIONAL on the port so alternative
   * repos and test fakes keep compiling; a caller that does not find it falls back to the loop.
   */
  recordAuditMany?(
    accountId: string, rows: ReadonlyArray<{ action: string; payload: unknown; inverse: unknown }>,
  ): Promise<void>;
  /**
   * Read-state rows still owed an IMAP `\Seen` write (mail 0024), DUE ONES ONLY.
   *
   * The due filter is {@link listPendingFolderStates}'s, for the reason that survives without a
   * budget: this queue is unbounded, so a permanently refused STORE costs one IMAP round trip per
   * cycle for the life of the account with nothing to show for it.
   */
  listPendingFlagStates(mailboxId: string): Promise<PendingFlagState[]>;
  upsertFlagState(messageId: string, s: FlagStateRow): Promise<void>;
  /**
   * Adopt an EXTERNAL `\Seen` change observed on the server — the inbound half of read-state reconciliation.
   *
   * Account-scoped by the mailbox, and USER-WINS in the one direction that matters: if our own
   * write is still pending (`last_set_by = 'us'` and desired ≠ observed) the external value is
   * IGNORED and `applied` comes back false. Without that check a reconcile cycle would read the
   * pre-write flag back off the server and overwrite the intent the user expressed two seconds
   * ago — the optimistic flip would visibly snap back.
   */
  applyExternalFlag(
    mailboxId: string, locator: NativeLocator, seen: boolean,
  ): Promise<ExternalFlagOutcome | null>;
  /**
   * Run `fn` inside ONE database transaction with a tx-scoped repo:
   * `recordChange`/`allocateSeq` and every entity write commit atomically. The
   * caller MUST keep all network (IMAP/Anthropic) OUT of this callback.
   */
  transaction<T>(fn: (repo: DrizzleRepo) => Promise<T>): Promise<T>;
}

// A query runner: either a top-level db handle (postgres-js in prod, PGlite in
// tests) or an ambient transaction handle. Both satisfy `Tx` (PgDatabase), so the
// repo is driver-agnostic and always operates on the handle it was
// constructed with (a fresh one per transaction).
type Db = Tx;

function rowToStored(r: typeof messages.$inferSelect): StoredMessage {
  return {
    id: r.id,
    dedupKey: r.dedupKey,
    nativeLocator: (r.nativeLocator as NativeLocator | null) ?? { folder: "", ref: "0:0" },
    threadId: r.threadId ?? null,
    // The four columns the dual-key lookup verifies a legacy hit against. Already
    // selected — this row is a `SELECT *` — and previously discarded.
    messageIdHeader: r.messageIdHeader ?? null,
    bodyHash: r.bodyHash,
    subject: r.subject,
    fromAddress: r.fromAddress,
  };
}

function parseUid(ref: string): number {
  const uid = Number(ref.split(":")[1]);
  return Number.isFinite(uid) ? uid : 0;
}

/**
 * The server epoch half of a `makeRef` locator, or `"0"` when the ref does not carry one.
 *
 * `"0"` is the sentinel the folder cursor already uses for "no epoch known", and returning it for
 * a malformed ref is the safe direction: `buildCursor` keeps only the entries whose epoch MATCHES
 * the folder's, so an unnameable epoch drops the entry out of the known-set and the message is
 * re-enumerated rather than silently assumed present.
 */
function parseUidValidity(ref: string): string {
  const v = ref.split(":")[0];
  return v !== undefined && /^[0-9]+$/.test(v) ? v : "0";
}

/** desired === observed → we are converged; otherwise a move is still owed. */
function reconcileStatusFor(s: FolderStateRow): "pending" | "reconciled" {
  if (s.desiredFolder === s.observedFolder) return "reconciled";
  // The spam verdict's completion: the pile stays `ohmail/Quarantine` (what views project), the
  // server's truth is the native junk path, and `satisfiedBy` — set ONLY by that completion
  // write — says the difference is fulfilment, not divergence. See `FolderStateRow.satisfiedBy`.
  return s.satisfiedBy != null && s.satisfiedBy === s.observedFolder ? "reconciled" : "pending";
}

/** The same derivation for read-state: never set by hand, so a row cannot lie about converging. */
function flagStatusFor(s: FlagStateRow): "pending" | "reconciled" {
  return s.desiredSeen === s.observedSeen ? "reconciled" : "pending";
}

/**
 * The shared due predicate for deferred mutations (mail 0058), now defined in
 * `packages/db/src/folder-state-pending.ts` — this is one line over it. That module owns every
 * predicate over the table's pending set and states why this queue stays wider than the strip's
 * count: it must keep carrying the status-repair rows and the external rows the user-wins rule
 * skips, or every status repair would strand pending for ever, invisibly. The instant comes from
 * the application clock, matching `deferFolderReconcile`'s write side, so database/worker clock
 * skew cannot stretch or shrink a deferral.
 */
function dueNow(col: AnyPgColumn): SQL | undefined {
  return sharedDueNow(col, new Date());
}

/**
 * Canonical-path SUBTREE membership, as exact string functions — never LIKE: a folder name may
 * contain `_` (the validator refuses only the LIST wildcards `%`/`*`), and an unescaped LIKE
 * pattern would let `a_b` claim `axb/…`. Module-level rather than a repo method so the known-set
 * census (`known-set-cache.test.ts`) enumerates operations, not fragment builders.
 */
/** Rows per `recordChanges` INSERT inside the rename swap — see the chunk note at the call. */
const RENAME_CHANGE_CHUNK = 2000;

function inSubtree(col: unknown, path: string) {
  // `length(${path})` in SQL and never a JS `path.length`: both stores count CHARACTERS here while
  // `String.length` counts UTF-16 code units, so any astral character in a folder name (an emoji is
  // one character and two JS units) would shear the prefix arithmetic and leave descendants under
  // the old path.
  //
  // `substr(x, 1, n)` and `length(x)` rather than `left(x, n)` and `char_length(x)`: the pairs are
  // the same functions, and only the second spelling of each exists on the device store — where
  // this ran as written it would have answered `no such function: left`.
  return sql`(${col} = ${path} or substr(${col}, 1, length(${path}) + 1) = ${path + "/"})`;
}

export class DrizzleRepo implements WorkerRepo, RoutingPort {
  /**
   * The dialect is resolved on first use, deliberately. Resolving in the constructor was tried
   * and found two real latent sites — but 149 test files build handles with a bare `drizzle(sql,
   * { schema })` and never brand them, so 156 cases failed at construction while every production
   * factory (`makeDb`, `makeOwnedDb`, `makePooledDb`) brands correctly. So the seam refuses an
   * unbranded handle at the first statement that actually needs a dialect instead. `carried` is
   * how a transaction inherits its parent's dialect: the transaction object has no brand of its
   * own, and the parent's value is known right.
   */
  private carriedDialect: Dialect | null;

  constructor(private readonly db: Db, carried?: Dialect) {
    this.carriedDialect = carried ?? null;
  }

  /**
   * The spelling of every construct the two stores disagree about, read from the handle because
   * this class is constructed once per request against whichever store the program has. Row locks
   * are the case that matters: on the device store they are the identity, since one serialized
   * connection leaves no second writer to exclude. Carried rather than looked up every time
   * because a transaction is a different object with no brand of its own — {@link transaction}
   * hands the child its parent's dialect, the only correct reading: a transaction cannot be on a
   * different store from the handle that opened it.
   */
  private get d(): Dialect {
    return (this.carriedDialect ??= dialect(this.db));
  }

  async findByDedupKey(mailboxId: string, dedupKey: string): Promise<StoredMessage | null> {
    const rows = await this.db.select().from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.dedupKey, dedupKey))).limit(1);
    return rows[0] ? rowToStored(rows[0]) : null;
  }

  /**
   * The own-sent twin lookup — see `RepoPort.findByMessageIdHeader` for the contract, including
   * why only the `ownAuthored` gate in `resolveExisting` may call it. `accountId` is in the
   * predicate so the `(account_id, message_id_header)` index serves the read; `created_at, id`
   * makes "oldest row wins" deterministic when a mailbox already holds several rows under one id
   * (the pre-fix doubles this lookup exists to stop collapsing onto a stable one of them).
   */
  async findByMessageIdHeader(accountId: string, mailboxId: string, messageIdHeader: string): Promise<StoredMessage | null> {
    const rows = await this.db.select().from(messages)
      .where(and(
        eq(messages.accountId, accountId),
        eq(messages.mailboxId, mailboxId),
        eq(messages.messageIdHeader, messageIdHeader),
      ))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(1);
    return rows[0] ? rowToStored(rows[0]) : null;
  }

  async insertMessage(input: InsertMessageInput): Promise<InsertedMessage> {
    const inserted = await this.db.insert(messages).values({
      accountId: input.accountId, mailboxId: input.mailboxId,
      messageIdHeader: input.canonical.messageIdHeader,
      bodyHash: input.canonical.bodyHash,
      dedupKey: input.dedupKey,
      subject: input.subject, fromAddress: input.fromAddress, date: input.date,
      // `?? null` reproduces the column's own default (nullable, no default expression) — the
      // recipients' rule one line down, applied to the sender's display name (mail 0057).
      fromName: input.fromName ?? null,
      // `?? []` reproduces the two columns' own `'[]'::jsonb` default, on the same argument as
      // `unread ?? true` below: this is the ONE place the ingest mapping for recipients is
      // visible, and a caller with nothing to report writes what the database would have written.
      // The value is an `EmailAddress[]`, stored as jsonb — the shape
      // `materialize.ts#messageRowToDTO` reads and the shape `cloud-mirror.ts` writes from the
      // DTO into the same columns of the local mail database.
      toAddresses: input.to ?? [],
      ccAddresses: input.cc ?? [],
      nativeLocator: input.nativeLocator,
      noAi: input.flags.no_ai, noForward: input.flags.no_forward,
      noKb: input.flags.no_kb, priority: input.flags.priority,
      snippet: input.snippet ?? "",
      sensitivityCategory: input.sensitivityCategory ?? null,
      hasAttachments: input.hasAttachments ?? false,
      attachmentCount: input.attachmentCount ?? 0,
      // `?? true` reproduces the column default for a caller that has no read-state to report,
      // so this is the ONE place the default is spelled out and the ingest mapping is visible.
      unread: input.unread ?? true,
      // `?? null` and NOT a `"unauthenticated"` literal. The column is nullable with no default
      // precisely so "nobody stated a verdict" is distinguishable on disk from "a caller looked
      // and stated `unauthenticated`", and `rules.ts#AuthVerdict` fixes the reading of NULL. A
      // literal here would fabricate the second from the first.
      //
      // `ON CONFLICT DO NOTHING` below means a racing LOSER never reaches this write: the
      // winner's verdict is the one on the row, and the loser returns `created: false` and
      // writes nothing. That is the correct outcome — both computed the same verdict from the
      // same bytes — and it is why this needs no conflict clause of its own.
      authVerdict: input.authVerdict ?? null,
    }).onConflictDoNothing({ target: [messages.mailboxId, messages.dedupKey] }).returning();
    if (inserted[0]) {
      // Every message row gets its primary instance here, and only here:
      // `messages.native_locator` is a mirror of the primary `message_instances` row, so the two
      // are born together inside the caller's transaction. Doing it in `commitChange` instead
      // would let other callers create a message with no instance — invisible to
      // `listKnownLocators`, its body re-fetched every cycle for ever. Only on a genuine insert:
      // `onConflictDoNothing` returning nothing means the row already existed, and re-asserting
      // its primary instance would drag it back to an arrival locator that may no longer exist.
      await this.setPrimaryInstance(inserted[0].id, input.nativeLocator);
      return { ...rowToStored(inserted[0]), created: true };
    }
    // AN EMPTY `RETURNING` IS THE ANSWER, and it is now reported instead of discarded — see
    // {@link InsertedMessage}. `ON CONFLICT DO NOTHING` returns no row exactly when somebody else
    // already owns this `(mailbox_id, dedup_key)`, so `created: false` tells `commitChange` that
    // the winner owns every child row too. Discarding it is what let a racing loser write a second
    // `attachments` row and a second `create` delta for one message.
    const existing = await this.findByDedupKey(input.mailboxId, input.dedupKey);
    if (!existing) throw new Error(`insertMessage: conflict but no existing row for ${input.dedupKey}`);
    return { ...existing, created: false };
  }

  // ── PHYSICAL IDENTITY: `message_instances` ────────────────────────────────────────────────
  //
  // One logical message, N physical locators. The table's three constraints carry the whole
  // model: `UNIQUE (mailbox_id, folder, uidvalidity, uid)` because one UID inside one epoch is one
  // place; `UNIQUE (message_id) WHERE is_primary` because exactly one of a message's instances is
  // the one `messages.native_locator` mirrors and the one we act on; `INDEX (message_id)` because
  // every read here is by message.

  /**
   * Point the message's primary instance at `locator`, creating it if none. Three statements, and
   * the order is the correctness: the destination tuple is vacated first because a non-primary
   * instance of this same message can already sit there (exactly what an `external_copy`
   * recorded); without the vacate the UPDATE raises 23505 on `message_instances_locator_uq` and
   * takes the ingest transaction with it. The vacate is scoped to this message: a tuple claimed
   * by a different message is an anomaly, and deleting it would be a write an attacker could aim
   * — it is left alone, the UPDATE fails loudly, the cycle retries.
   */
  private async setPrimaryInstance(messageId: string, locator: NativeLocator): Promise<void> {
    const uid = parseUid(locator.ref);
    const uidValidity = BigInt(parseUidValidity(locator.ref));
    await this.db.delete(messageInstances).where(and(
      eq(messageInstances.messageId, messageId),
      eq(messageInstances.folder, locator.folder),
      eq(messageInstances.uidvalidity, uidValidity),
      eq(messageInstances.uid, uid),
      eq(messageInstances.isPrimary, false),
    ));
    const moved = await this.db.update(messageInstances).set({
      folder: locator.folder, uidvalidity: uidValidity, uid, lastSeenAt: new Date(),
    }).where(and(
      eq(messageInstances.messageId, messageId), eq(messageInstances.isPrimary, true),
    )).returning({ id: messageInstances.id });
    if (moved.length > 0) return;
    await this.db.insert(messageInstances).values({
      // The account and mailbox come from the MESSAGE, not from the caller: an instance is a
      // physical fact about a row that already exists, and a caller-supplied account id would be a
      // second place the account-isolation boundary could be got wrong.
      accountId: sql`(select account_id from ${messages} where id = ${messageId})`,
      mailboxId: sql`(select mailbox_id from ${messages} where id = ${messageId})`,
      messageId, folder: locator.folder, uidvalidity: uidValidity, uid, isPrimary: true,
    }).onConflictDoNothing();
  }

  /** See {@link RepoPort.recordInstance}. Never re-attributes a locator another message claims. */
  async recordInstance(messageId: string, locator: NativeLocator): Promise<void> {
    const uid = parseUid(locator.ref);
    const uidValidity = BigInt(parseUidValidity(locator.ref));
    await this.db.insert(messageInstances).values({
      accountId: sql`(select account_id from ${messages} where id = ${messageId})`,
      mailboxId: sql`(select mailbox_id from ${messages} where id = ${messageId})`,
      messageId, folder: locator.folder, uidvalidity: uidValidity, uid, isPrimary: false,
    }).onConflictDoUpdate({
      target: [
        messageInstances.mailboxId, messageInstances.folder,
        messageInstances.uidvalidity, messageInstances.uid,
      ],
      set: { lastSeenAt: new Date() },
      // `setWhere` is the anti-re-attribution guard. A conflict whose existing row belongs to a
      // DIFFERENT message is left completely alone: the alternative is repointing a physical
      // locator on the strength of a delivery, which is a write chosen by whoever sent the mail.
      setWhere: eq(messageInstances.messageId, messageId),
    });
  }

  // ── THE DURABLE PER-MESSAGE FAILURE LEDGER (mail 0041) ──────────────────────────────────────
  //
  // Four statements, and every one of them is mailbox-scoped in the WHERE clause rather than by the
  // caller having remembered to be: a `(folder, uid)` pair repeats across every mailbox on the
  // planet, so an unscoped read here would let one account's IMAP server decide what another
  // account's sync loop treats as already-known.

  async listMessageFailures(mailboxId: string): Promise<MessageFailureRow[]> {
    const rows = await this.db.select({
      folder: messageFailures.folder,
      uid: messageFailures.uid,
      uidvalidity: messageFailures.uidvalidity,
      code: messageFailures.code,
      attempts: messageFailures.attempts,
    }).from(messageFailures)
      .where(and(eq(messageFailures.mailboxId, mailboxId), isNull(messageFailures.resolvedAt)));
    return rows.map((r) => ({
      folder: r.folder,
      uid: r.uid,
      uidValidity: r.uidvalidity != null ? String(r.uidvalidity) : "0",
      code: r.code,
      attempts: r.attempts,
    }));
  }

  /**
   * See {@link WorkerRepo.recordMessageFailure}. `attempts` starts at 1 and the conflict path
   * does not touch it: a repeated failure of the same UID inside one build is the same attempt
   * observed twice — `claimMessageFailures` is what counts a genuine retry, and letting this
   * statement increment would make an ordinary cycle look like exhausted patience. `resolved_at`
   * is cleared on conflict: a UID that failed again after being closed is owed again, and the
   * alternative is a resolved row silently shadowing a live failure.
   */
  async recordMessageFailure(mailboxId: string, input: MessageFailureInput): Promise<number> {
    const now = new Date();
    const [row] = await this.db.insert(messageFailures).values({
      accountId: input.accountId,
      mailboxId,
      folder: input.folder,
      uidvalidity: BigInt(/^[0-9]+$/.test(input.uidValidity) ? input.uidValidity : "0"),
      uid: input.uid,
      code: input.code,
      attempts: 1,
      attemptedVersion: input.version,
      firstFailedAt: now,
      lastFailedAt: now,
      nextAttemptAt: input.nextAttemptAt,
    }).onConflictDoUpdate({
      target: [
        messageFailures.mailboxId, messageFailures.folder,
        messageFailures.uidvalidity, messageFailures.uid,
      ],
      set: {
        code: input.code,
        lastFailedAt: now,
        attemptedVersion: input.version,
        nextAttemptAt: input.nextAttemptAt,
        resolvedAt: null,
      },
    }).returning({ attempts: messageFailures.attempts });
    return row?.attempts ?? 1;
  }

  async claimMessageFailures(
    mailboxId: string,
    opts: {
      version: string; now: Date; limit: number; nextAttemptAt: Date | null;
      holdScheduleForCodes?: readonly string[];
    },
  ): Promise<MessageFailureRow[]> {
    if (opts.limit <= 0) return [];
    /**
     * Due = not closed, and either the clock has come round or the code changed under it.
     * `lte(column, date)` and never a raw `sql` fragment holding a `Date`: postgres.js describes
     * a bare parameter as TEXT and `Bind` throws; the column on the left makes drizzle bind
     * `timestamptz`. `IS DISTINCT FROM` rather than `<>` because `attempted_version` is nullable
     * and `NULL <> 'x'` is NULL — a row nobody stamped would never be due.
     */
    const isDue = or(
      lte(messageFailures.nextAttemptAt, opts.now),
      sql`${messageFailures.attemptedVersion} is distinct from ${opts.version}`,
    );
    const due = this.db.select({ id: messageFailures.id }).from(messageFailures)
      .where(and(eq(messageFailures.mailboxId, mailboxId), isNull(messageFailures.resolvedAt), isDue))
      // NULLS FIRST: a deterministic failure carries no instant, and it is the one waiting for the
      // build that just arrived. Sorting it last would let a backlog of clock-scheduled rows starve
      // exactly the rows a deploy was supposed to rescue.
      .orderBy(sql`${messageFailures.nextAttemptAt} nulls first`)
      .limit(opts.limit);

    // One statement, with the due predicate repeated in the UPDATE's own WHERE — that repetition
    // makes the handover safe. Two workers can select the same id; the loser blocks on the
    // winner's row lock, and under READ COMMITTED the UPDATE's qual is re-evaluated against the
    // committed row, so the loser matches nothing. `attempts + 1` is written by the claim, not
    // the retry's outcome: a process that dies mid-fetch must still have spent an attempt, or a
    // poison message retries for ever and never escalates. The schedule is per code inside the
    // claim statement: deterministic rows keep NULL, everything else gets the caller's clock
    // instant as ISO text plus a cast.
    const holds = opts.holdScheduleForCodes ?? [];
    const nextAttemptAt = holds.length === 0
      ? opts.nextAttemptAt
      : sql`case when ${inArray(messageFailures.code, [...holds])} then null
             else ${opts.nextAttemptAt === null ? sql`null` : this.d.ts(opts.nextAttemptAt)} end`;
    const rows = await this.db.update(messageFailures)
      .set({
        attempts: sql`${messageFailures.attempts} + 1`,
        attemptedVersion: opts.version,
        nextAttemptAt,
      })
      .where(and(
        inArray(messageFailures.id, due),
        isNull(messageFailures.resolvedAt),
        isDue,
      ))
      .returning({
        folder: messageFailures.folder,
        uid: messageFailures.uid,
        uidvalidity: messageFailures.uidvalidity,
        code: messageFailures.code,
        attempts: messageFailures.attempts,
      });
    return rows.map((r) => ({
      folder: r.folder,
      uid: r.uid,
      uidValidity: r.uidvalidity != null ? String(r.uidvalidity) : "0",
      code: r.code,
      attempts: r.attempts,
    }));
  }

  async resolveMessageFailure(
    mailboxId: string, site: { folder: string; uidValidity: string; uid: number },
  ): Promise<void> {
    await this.db.update(messageFailures)
      .set({ resolvedAt: new Date(), nextAttemptAt: null })
      .where(and(
        eq(messageFailures.mailboxId, mailboxId),
        eq(messageFailures.folder, site.folder),
        eq(messageFailures.uidvalidity, BigInt(/^[0-9]+$/.test(site.uidValidity) ? site.uidValidity : "0")),
        eq(messageFailures.uid, site.uid),
      ));
  }

  /**
   * See {@link RepoPort.primaryInstanceVanished}. One statement, so it cannot answer half. The
   * subquery is parameterised, not correlated: written against an aliased `message_instances mi`,
   * the outer reference resolved to `mi`'s own `id` column, the predicate became `mi.message_id =
   * mi.id` — never true — so every message read as vanished and the adoption attack was back
   * through a column name. Binding `messageId` as a parameter leaves no unqualified name to
   * resolve wrongly. PGlite never saw this; a message-identity test against real Postgres did.
   */
  async primaryInstanceVanished(messageId: string): Promise<boolean> {
    const [row] = await this.db.select({
      // BOTH halves in SQL. `native_locator IS NOT NULL` is what stops a row that never had an
      // instance (a seeded backlog row, a fixture) from reading as a DISAPPEARANCE and thereby
      // manufacturing adoption evidence out of an incomplete record.
      vanished: sql<boolean>`(${messages.nativeLocator} is not null) and not exists (
        select 1 from ${messageInstances}
         where ${messageInstances.messageId} = ${messageId} and ${messageInstances.isPrimary}
      )`,
    }).from(messages).where(eq(messages.id, messageId)).limit(1);
    return row?.vanished === true;
  }

  /**
   * Forget the instance at `locator` — the only place a disappearance is written. Called from the
   * sync loop for each adapter delete, only when the folder's epoch matches the server's: a new
   * epoch renumbers, so an absence at the old epoch is silence, not a fact. A DELETE, because the
   * row's existence IS the claim the locator exists; removing it also leaves `listKnownLocators`.
   * If the vanished instance was primary, the oldest survivor (`first_seen_at`) is promoted — a
   * stable choice — restoring the invariant that `messages.native_locator` names an instance that
   * exists. No-op when the deleted row was not primary or nothing survives; returns the promoted
   * survivor's locator, else `null`.
   */
  async forgetInstanceAt(mailboxId: string, locator: NativeLocator): Promise<NativeLocator | null> {
    const removed = await this.db.delete(messageInstances).where(and(
      eq(messageInstances.mailboxId, mailboxId),
      eq(messageInstances.folder, locator.folder),
      eq(messageInstances.uidvalidity, BigInt(parseUidValidity(locator.ref))),
      eq(messageInstances.uid, parseUid(locator.ref)),
    )).returning({ messageId: messageInstances.messageId, isPrimary: messageInstances.isPrimary });
    const orphaned = removed.find((r) => r.isPrimary);
    if (!orphaned) return null;
    const [survivor] = await this.db.select({
      id: messageInstances.id,
      folder: messageInstances.folder,
      uidvalidity: messageInstances.uidvalidity,
      uid: messageInstances.uid,
    }).from(messageInstances)
      .where(eq(messageInstances.messageId, orphaned.messageId))
      .orderBy(asc(messageInstances.firstSeenAt), asc(messageInstances.uid))
      .limit(1);
    if (!survivor) return null;
    const promoted: NativeLocator = {
      folder: survivor.folder,
      ref: `${String(survivor.uidvalidity)}:${survivor.uid}`,
    };
    await this.db.update(messageInstances)
      .set({ isPrimary: true }).where(eq(messageInstances.id, survivor.id));
    await this.db.update(messages).set({ nativeLocator: promoted })
      .where(eq(messages.id, orphaned.messageId));
    return promoted;
  }

  /** Mail 0065 — the two discovery columns, read as one pair. See the interface doc. */
  async getMailboxSpecialFolders(mailboxId: string): Promise<{ junkFolder: string | null; trashFolder: string | null }> {
    const [row] = await this.db.select({ junkFolder: mailboxes.junkFolder, trashFolder: mailboxes.trashFolder })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
    return { junkFolder: row?.junkFolder ?? null, trashFolder: row?.trashFolder ?? null };
  }

  /** Mail 0065 — persist the connect-time discovery, both columns every time (re-written on attach). */
  async setMailboxSpecialFolders(
    mailboxId: string, f: { junkFolder: string | null; trashFolder: string | null },
  ): Promise<void> {
    await this.db.update(mailboxes)
      .set({ junkFolder: f.junkFolder, trashFolder: f.trashFolder })
      .where(eq(mailboxes.id, mailboxId));
  }

  /**
   * Mail 0065 — empty one stored body under a closed marker, the storage cap's exact husk shape
   * (`storage.ts#evictOldestBodies`): SELECT the octets first — `RETURNING` reports the NEW row,
   * which is the zero we are about to write — then update, then release the counter under the
   * same rules every other movement uses. `withheld_reason IS NULL` in both statements keeps a
   * row's FIRST reason and makes the pair idempotent: a husk is never re-husked, its bytes are
   * never released twice.
   */
  async huskBody(accountId: string, messageId: string, reason: "junk_filed" | "expunged"): Promise<boolean> {
    // THE ACCOUNT COUNTER ROW IS LOCKED FIRST — `evictOldestBodies`' exact idiom, and for the
    // same two reasons: it serializes every concurrent husk/evict of this account (two callers
    // that both selected the same unwithheld row would otherwise both release its bytes — the
    // loser's UPDATE hits zero rows but its release still ran), and it keeps the lock ORDER
    // consistent with ingest and the repair passes (counter row, then anything else) so no
    // ordering inversion can deadlock against the eviction path.
    await this.db.insert(accountStorage).values({ accountId, bytes: 0 }).onConflictDoNothing();
    await this.d.forUpdate(
      this.db.select({ bytes: accountStorage.bytes }).from(accountStorage)
        .where(eq(accountStorage.accountId, accountId)),
    );
    const [victim] = await this.db.select({
      id: messageBodies.id,
      freed: sql<string>`octet_length(${messageBodies.text}) + coalesce(octet_length(${messageBodies.html}), 0)`,
    }).from(messageBodies).where(and(
      eq(messageBodies.messageId, messageId),
      isNull(messageBodies.withheldReason),
    )).limit(1);
    if (!victim) return false;
    await this.db.update(messageBodies)
      .set({ text: "", html: null, withheldReason: reason })
      .where(and(eq(messageBodies.id, victim.id), isNull(messageBodies.withheldReason)));
    const freed = Number(victim.freed);
    if (freed > 0) await releaseBodyBytes(this.db, this.d, accountId, freed);
    return true;
  }

  /**
   * Mail 0065: the AI-auto-applied Quarantine placements to exclude. Account-scoped because the
   * only index is `(account_id, message_id)` — a bare `message_id IN (…)` cannot seek its leading
   * key and would scan every account's routing history. Superseded by any later user move: a
   * `change_log` `move` row whose `meta.to` is the pile and whose timestamp postdates the
   * decision means the user authored the placement — every user path to the pile records one, the
   * auto-apply arm records only the message `create` — and the verdict then files to native Junk
   * as the user commanded.
   */
  async listAiAutoAppliedQuarantine(accountId: string, messageIds: readonly string[]): Promise<string[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db.select({ messageId: routingDecisions.messageId })
      .from(routingDecisions)
      .where(and(
        eq(routingDecisions.accountId, accountId),
        inArray(routingDecisions.messageId, [...messageIds]),
        eq(routingDecisions.inputProvenance, "ai"),
        eq(routingDecisions.status, "auto_applied"),
        eq(routingDecisions.destination, "ohmail/Quarantine"),
        sql`not exists (
          select 1 from ${changeLog} cl
           where cl."account_id" = ${accountId}
             and cl."entity_type" = 'message'
             and cl."entity_id" = ${routingDecisions.messageId}
             and cl."op" = 'move'
             and cl."meta" ->> 'to' = 'ohmail/Quarantine'
             and cl."created_at" > ${routingDecisions.createdAt}
        )`,
      ));
    return [...new Set(rows.map((r) => r.messageId))];
  }

  /** Mail 0065 — refill a junk_filed/expunged husk from an arrival's bytes. See RepoPort's doc. */
  async restoreWithheldBody(
    messageId: string, body: MessageBodyInput, storage: BodyStorageContext,
  ): Promise<boolean> {
    const [row] = await this.db.select({ id: messageBodies.id, reason: messageBodies.withheldReason })
      .from(messageBodies).where(eq(messageBodies.messageId, messageId)).limit(1);
    if (!row || (row.reason !== "junk_filed" && row.reason !== "expunged")) return false;
    const bytes = bodyBytesOf(body);
    // The rolling-window reserve — counter row locked here, before the caller's seq writes.
    const reserved = await reserveBodyBytesEvicting(this.db, this.d, storage.accountId, bytes, storage.capBytes);
    if (!reserved) return false;   // at the pathological ceiling the husk stands, honestly
    const updated = await this.db.update(messageBodies)
      .set({ text: body.text, html: body.html, withheldReason: null })
      .where(and(
        eq(messageBodies.id, row.id),
        inArray(messageBodies.withheldReason, ["junk_filed", "expunged"]),
      ))
      .returning({ id: messageBodies.id });
    if (updated.length === 0) {
      // A concurrent writer beat this restore: give the reserve back on the lock it holds.
      await releaseBodyBytes(this.db, this.d, storage.accountId, bytes);
      return false;
    }
    return true;
  }

  /** See the interface doc — the instance witness is the predicate, mail 0071's index the read. */
  async listJunkFiledHusks(
    accountId: string, mailboxId: string, opts: { limit: number; afterId?: string },
  ): Promise<JunkFiledHuskRow[]> {
    const rows = await this.db.select({
      messageId: messages.id,
      dedupKey: messages.dedupKey,
      messageIdHeader: messages.messageIdHeader,
      folder: messageInstances.folder,
      uidValidity: messageInstances.uidvalidity,
      uid: messageInstances.uid,
    }).from(messageBodies)
      .innerJoin(messages, eq(messages.id, messageBodies.messageId))
      .innerJoin(messageInstances, and(
        eq(messageInstances.messageId, messages.id),
        eq(messageInstances.isPrimary, true),
      ))
      .where(and(
        eq(messageBodies.withheldReason, "junk_filed"),
        eq(messages.accountId, accountId),
        eq(messages.mailboxId, mailboxId),
        isNull(messages.deletedAt),
        ...(opts.afterId !== undefined ? [sql`${messages.id} > ${this.d.castUuid(opts.afterId)}`] : []),
      ))
      .orderBy(asc(messages.id))
      .limit(opts.limit);
    return rows.map((r) => ({
      messageId: r.messageId,
      dedupKey: r.dedupKey,
      messageIdHeader: r.messageIdHeader,
      folder: r.folder,
      uidValidity: String(r.uidValidity),
      uid: r.uid,
    }));
  }

  /** The shared verify/rewrite, on this repo's connection — the worker's fence tx when fenced. */
  async unhuskJunkFiledBody(
    accountId: string, husk: JunkHuskIdentity, fresh: NormalizedMessage, capBytes: number | null,
  ): Promise<JunkUnhuskOutcome> {
    return unhuskJunkFiledBodyTx(this.db, { accountId, husk, fresh, capBytes });
  }

  /**
   * Mail 0065 — the reaper `forgetInstanceAt`'s doc promised. See the interface doc for the
   * predicate and each exclusion; the husk runs BEFORE the `change_log` row on the lock-order
   * rule (`insertMessageBody` step 1 — counter row, then seq row, in that order everywhere).
   */
  async tombstoneInstanceless(accountId: string, mailboxId: string, limit: number): Promise<number> {
    const victims = await this.db.select({ id: messages.id }).from(messages)
      .where(and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.accountId, accountId),
        isNull(messages.deletedAt),
        sql`${messages.nativeLocator} is not null`,
        sql`not exists (select 1 from ${messageInstances}
              where ${messageInstances.messageId} = ${messages.id})`,
        // The junk-parked signature — reconciled while divergent — which only the `satisfiedBy`
        // completion writes: there, "no watched instance" is the design, not a disappearance.
        sql`not exists (select 1 from ${folderState}
              where ${folderState.messageId} = ${messages.id}
                and ${folderState.reconcileStatus} = 'reconciled'
                and ${folderState.desiredFolder} <> ${folderState.observedFolder})`,
      ))
      .orderBy(asc(messages.id))
      .limit(limit);
    for (const v of victims) {
      await this.db.update(messages).set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(messages.id, v.id));
      await this.huskBody(accountId, v.id, "expunged");
      await this.recordChange({ accountId, entityType: "message", entityId: v.id, op: "delete", meta: null });
    }
    return victims.length;
  }

  /** Mail 0065 — a re-appearance un-deletes: the adopt path's half of "a LATER create resurrects". */
  async clearDeletedOnAdopt(messageId: string): Promise<boolean> {
    const rows = await this.db.update(messages).set({ deletedAt: null, updatedAt: new Date() })
      .where(and(eq(messages.id, messageId), sql`${messages.deletedAt} is not null`))
      .returning({ id: messages.id });
    return rows.length > 0;
  }

  /**
   * Rewrite a verified legacy `dedup_key` to `fp1:` — see {@link RepoPort.upgradeDedupKey}.
   *
   * The `NOT EXISTS` is not decoration. `UNIQUE (mailbox_id, dedup_key)` is still the constraint
   * (the ruling forbids moving it), so if a concurrent ingest has already written the `fp1:` row
   * for this mailbox a bare UPDATE raises 23505 — and 23505 inside the ingest transaction aborts
   * the whole commit, losing the message for that cycle rather than merely skipping an upgrade.
   */
  async upgradeDedupKey(messageId: string, from: string, to: string): Promise<boolean> {
    const rows = await this.db.update(messages).set({ dedupKey: to, updatedAt: new Date() })
      .where(and(
        eq(messages.id, messageId),
        eq(messages.dedupKey, from),
        sql`not exists (
          select 1 from ${messages} other
           where other.mailbox_id = ${messages.mailboxId} and other.dedup_key = ${to}
        )`,
      ))
      .returning({ id: messages.id });
    return rows.length > 0;
  }

  /**
   * Persist the body — or, at the storage cap, its honest husk — and keep the account's byte
   * counter true, in the ambient transaction. Order: (1) `reserveBodyBytes` first, before any
   * `recordChange`, so ingest and the repair passes take the counter row and the seq row in the
   * same order (`capBytes: null` still counts — accounting is not billing); (2) one
   * values-builder for both outcomes — a declined body keeps its real headers with
   * `text=''`/`html=null` and the marker; (3) the compensation: a reserve whose insert hit the
   * 1:1 conflict gives the bytes back, clamped, on the lock the reserve holds — counter moves
   * only with content stored, whoever calls.
   */
  async insertMessageBody(
    messageId: string, body: MessageBodyInput, storage: BodyStorageContext,
  ): Promise<BodyStorageOutcome> {
    const bytes = bodyBytesOf(body);
    // A DUPLICATE must not evict. The 1:1 conflict below is how this method learns the body
    // already exists — but by then the evicting reserve would have husked up to 64 old bodies
    // to make room for content that is never stored (review finding). One primary-key read
    // settles it first: an existing row takes the ORIGINAL shape — plain reserve, conflict,
    // compensation — and the rolling window runs only for a body that will actually land.
    // The probe-to-insert race window readmits the old behaviour at worst (a conflict after a
    // plain reserve), never a wrongful eviction.
    const dupe = await this.db.select({ id: messageBodies.id })
      .from(messageBodies).where(eq(messageBodies.messageId, messageId)).limit(1);
    // `reserveBodyBytesEvicting` (the 2026-08-21 rolling window): at cap it husks the oldest
    // stored bodies to fit THIS one — bounded, same transaction — and only past that bound does
    // it answer `false`, which is the old decline-new shape kept as the pathological ceiling.
    const reserved = dupe.length > 0
      ? await reserveBodyBytes(this.db, this.d, storage.accountId, bytes, storage.capBytes)
      : await reserveBodyBytesEvicting(this.db, this.d, storage.accountId, bytes, storage.capBytes);
    const rows = await this.db.insert(messageBodies).values({
      messageId,
      text: reserved ? body.text : "",
      html: reserved ? body.html : null,
      withheldReason: reserved ? null : ("storage_cap" as const),
      /**
       * `{ ...body.headers }` — the spread is load-bearing; this is the database boundary
       * `mime.ts` names when it says the null-prototype guarantee does not survive a round trip.
       * The parser builds the map with `Object.create(null)` so a `__proto__:` header cannot
       * throw, but drizzle 0.36.4's `is()` reflects on every insert value's prototype — TypeError
       * on null, so the map that stopped one hostile message broke all ingest. Spread copies an
       * own `__proto__` key as a plain property instead of invoking the setter. Do not simplify
       * to `body.headers`: the failure is elsewhere and only an e2e catches it.
       */
      headers: { ...body.headers },
    }).onConflictDoNothing({ target: messageBodies.messageId })
      .returning({ id: messageBodies.id });
    if (reserved && rows.length === 0) {
      await releaseBodyBytes(this.db, this.d, storage.accountId, bytes);
    }
    return reserved ? "stored" : "withheld";
  }

  /** Persist attachment metadata (never bytes) in the ambient tx. No-op when empty. */
  async insertAttachments(messageId: string, accountId: string, rows: AttachmentMeta[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(attachmentsTbl).values(rows.map((a) => ({
      accountId, messageId,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      partId: a.partId,
      contentId: a.contentId,
      inline: a.inline,
      // The content digest computed at parse. Persisted so an operator can answer
      // "are these two attachments the same file" without the bytes — which we do not have and
      // must not store (§13.2/§14). The FINGERPRINT reads the in-memory value, never this column,
      // for the reason the ruling prohibits a backfill: a stored column is not what ingest hashes.
      contentSha256: a.contentSha256,
    })));
  }

  async getFolderState(messageId: string): Promise<FolderStateRow | null> {
    const rows = await this.db.select().from(folderState).where(eq(folderState.messageId, messageId)).limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      desiredFolder: r.desiredFolder,
      observedFolder: r.observedFolder,
      lastSetBy: r.lastSetBy as FolderAttribution,
    };
  }

  /**
   * The backoff reset is part of this write (mail 0058): `attempts: 0, nextAttemptAt: null` on
   * every call, like `conflict: false` — this method expresses intent, and a deferral schedule
   * belongs to the intent it was earned against. The case that requires it: a move refused four
   * times is deferred an hour; the user then moves the message elsewhere — a new mutation the
   * server may happily accept, which must not inherit an hour of silence. Equally right on the
   * completion write, where the row leaves the pending set anyway. The one write that must not
   * reset is the refusal itself — {@link deferFolderReconcile} is a separate statement for that
   * reason.
   */
  async upsertFolderState(messageId: string, s: FolderStateRow): Promise<void> {
    const reconcileStatus = reconcileStatusFor(s);
    await this.db.insert(folderState).values({
      messageId, desiredFolder: s.desiredFolder, observedFolder: s.observedFolder,
      lastSetBy: s.lastSetBy, reconcileStatus, conflict: false,
    }).onConflictDoUpdate({
      target: folderState.messageId,
      set: {
        desiredFolder: s.desiredFolder, observedFolder: s.observedFolder, lastSetBy: s.lastSetBy,
        reconcileStatus, conflict: false, updatedAt: new Date(),
        attempts: 0, nextAttemptAt: null,
      },
    });
  }

  /**
   * {@link WorkerRepo.completeFolderState}. `desired_folder` is never in the SET, so a completion
   * cannot write back a desire read before the network round trip. A caller with a fresh physical
   * fact (`c.physicalObservation`, junk-filing's `settle`) gets `observed_folder` written on
   * every call: a declined completion after `updateLocator` once left a converged `reconciled`
   * row lying about the location. Stale-echo callers (the status repair, `voidGoneFiling`) write
   * nothing on a miss. `reconcile_status` derives from the live desire; a divergent row stays
   * pending and self-heals. Returns whether the witness matched — the caller's own intent
   * proceeds only then.
   */
  async completeFolderState(messageId: string, c: FolderCompletion): Promise<boolean> {
    // `physical` gates whether a MISS may still touch `observed_folder`/`reconcile_status`/
    // `conflict`/`updated_at` — see {@link FolderCompletion.physicalObservation}'s own doc for
    // the round-3 finding this guards: a caller with no fresh physical fact (the status repair in
    // `reconcileFolders`, `voidGoneFiling`) must not overwrite a fresher writer's observation with
    // a stale echo just because ITS OWN witness happened to miss. `attempts`/`next_attempt_at`/
    // `last_set_by` are gated on the match ALONE, on both arms, for the reason `upsertFolderState`
    // states: that schedule and that authorship belong to whichever intent WON the row, never to
    // an observation write, physical or not.
    const physical = c.physicalObservation === true;
    /**
     * The physical gate is decided here, not by the database. It used to be `desired_folder = $x
     * OR $physical::boolean`; `physical` is a constant by the time the statement is composed, so
     * both branches are expressible without binding a boolean — which matters because the device
     * store's driver takes no JavaScript boolean parameter and the cast was not portable. Four
     * occurrences, one fragment.
     */
    const matched = sql`desired_folder = ${c.expectDesiredFolder}`;
    const gate = physical ? sql`TRUE` : matched;
    const satisfiedBy = this.d.castText(c.satisfiedBy ?? null);
    const result = await this.d.exec(this.db, sql`
      UPDATE ${folderState} SET
        observed_folder = CASE
          WHEN ${gate}
            THEN ${c.observedFolder}
          ELSE observed_folder
        END,
        last_set_by = CASE WHEN ${matched}
          THEN ${c.lastSetBy} ELSE last_set_by END,
        reconcile_status = CASE
          WHEN ${gate} THEN
            CASE
              WHEN desired_folder = ${c.observedFolder} THEN 'reconciled'
              WHEN ${satisfiedBy} IS NOT NULL
                   AND ${matched}
                   AND ${satisfiedBy} = ${c.observedFolder}
                THEN 'reconciled'
              ELSE 'pending'
            END
          ELSE reconcile_status
        END,
        conflict = CASE WHEN ${gate}
          THEN FALSE ELSE conflict END,
        updated_at = CASE WHEN ${gate}
          THEN ${this.d.now()} ELSE updated_at END,
        attempts = CASE WHEN ${matched}
          THEN 0 ELSE attempts END,
        next_attempt_at = CASE WHEN ${matched}
          THEN NULL ELSE next_attempt_at END
      WHERE message_id = ${this.d.castUuid(messageId)}
      RETURNING desired_folder AS "desiredFolder"
    `);
    // The two drivers behind `Db` disagreed about what `execute` returns (array subclass vs
    // `{rows}`), and `junk-sweep.test.ts` — the one worker suite driving this method through the
    // real repo on PGlite — read `rows[0]` as `undefined`. The split is gone: `d.exec` hands back
    // rows positionally on both stores, one column is selected, so position 0 is it. Comparing
    // `desired_folder` itself (a string this module owns) rather than a computed boolean removes
    // the other variable.
    return String(result[0]?.[0] ?? "") === c.expectDesiredFolder;
  }

  /** {@link upsertFolderState}'s read-state twin, backoff reset included and for its reasons. */
  async upsertFlagState(messageId: string, s: FlagStateRow): Promise<void> {
    const reconcileStatus = flagStatusFor(s);
    await this.db.insert(flagState).values({
      messageId, desiredSeen: s.desiredSeen, observedSeen: s.observedSeen,
      lastSetBy: s.lastSetBy, reconcileStatus, conflict: false,
    }).onConflictDoUpdate({
      target: flagState.messageId,
      set: {
        desiredSeen: s.desiredSeen, observedSeen: s.observedSeen, lastSetBy: s.lastSetBy,
        reconcileStatus, conflict: false, updatedAt: new Date(),
        attempts: 0, nextAttemptAt: null,
      },
    });
  }

  /**
   * Set `folder_state.conflict` and nothing else — the whole observable effect of an
   * `external_copy`. A separate method rather than a field on `FolderStateRow` because {@link
   * upsertFolderState} writes `conflict: false` unconditionally, so expressing the conflict
   * through it would let the next reconcile pass silently clear the record. The `set` names
   * `conflict` and `updated_at` only, so a second delivery cannot change where the user's message
   * belongs. The insert branch seeds a message with no `folder_state` row yet from what the plan
   * read, so the flag always has somewhere to live.
   */
  async setFolderConflict(messageId: string, s: FolderStateRow): Promise<void> {
    await this.db.insert(folderState).values({
      messageId, desiredFolder: s.desiredFolder, observedFolder: s.observedFolder,
      lastSetBy: s.lastSetBy, reconcileStatus: reconcileStatusFor(s), conflict: true,
    }).onConflictDoUpdate({
      target: folderState.messageId,
      set: { conflict: true, updatedAt: new Date() },
    });
  }

  /**
   * Repoint the message: `messages.native_locator` and its primary instance, together.
   * `native_locator` is the primary instance's mirror — every read path keeps working off the
   * jsonb column while `listKnownLocators`, the one read that decides what gets re-fetched, works
   * off the table. Two writes in one method because a call site that forgot the instance would
   * fail silently: a stale primary makes the adapter treat a dead UID as known and never fetch
   * the live one.
   */
  async updateLocator(messageId: string, locator: NativeLocator): Promise<void> {
    await this.db.update(messages).set({ nativeLocator: locator }).where(eq(messages.id, messageId));
    await this.setPrimaryInstance(messageId, locator);
  }

  /**
   * The ORDER BY is the audit trail, not the correctness: `evaluateRules` resolves conflicts by a
   * total order in TypeScript (`rules.ts#compareRules`), but without an ORDER BY this query
   * returned physical row order, so nobody could run one SELECT in psql and see which rule the
   * router would pick — and PGlite's stable insertion order hid the class from every test not on
   * real Postgres. The clauses mirror `compareRules` step for step, deny-over-allow included; a
   * pg test sorts this output with the exported comparator and requires that nothing moves.
   */
  async listRules(accountId: string): Promise<Rule[]> {
    const rows = await this.db.select().from(rulesTbl).where(eq(rulesTbl.accountId, accountId))
      .orderBy(
        desc(rulesTbl.priority),
        sql`case when ${rulesTbl.destination} in ('ohmail/Screener', 'ohmail/Screened', 'ohmail/Quarantine') then 0 else 1 end`,
        sql`case ${rulesTbl.kind} when 'sender' then 0 when 'domain' then 1 else 2 end`,
        // A subject term outranks its absence within one kind — `subjectRank` in `rules.ts`, in
        // the same position. A regex and not `IS NOT NULL` or `btrim`: the TypeScript side reads
        // `''` and blank as absent, and one-argument `btrim` trims spaces only, so a tab-only
        // term would rank as narrow in SQL and as bare in the evaluator — a rule matching
        // everything. The class is `SUBJECT_TERM_TRIM` spelled in SQL, backslashes doubled so the
        // text Postgres receives is byte-identical to the migration's CHECK; the pg test checks
        // agreement over all six characters.
        sql`case when ${this.d.hasNonBlank(rulesTbl.subjectContains)} then 0 else 1 end`,
        // THE BODY TERM'S CLAUSE (mail 0052), directly below the subject one — `bodyRank` in
        // `rules.ts`, in the same position. Everything the comment above establishes applies
        // verbatim: the predicate is this REGEX and not `IS NOT NULL` or `btrim`, the backslashes
        // are DOUBLED so the text Postgres receives is byte-identical to the migration's CHECK,
        // and the character class is the evaluator's trim class spelled in SQL. The subject
        // clause ranking first is `bodyRank`'s documented decision: a rule with both terms
        // outranks subject-only outranks body-only outranks bare, here and in `compareRules`,
        // or the two statements of one order disagree and the router picks a winner `psql` does
        // not show.
        sql`case when ${this.d.hasNonBlank(rulesTbl.bodyContains)} then 0 else 1 end`,
        // Every value spelled out, none left to the `else`. `PROVENANCE_RANK` in `rules.ts` is
        // the same order and ranks an UNKNOWN value last; an `else 2` here would rank a value
        // this list forgot as though it were `promoted`, and the server and the client would
        // order the same two rules differently. The `else 4` is for a value neither knows.
        sql`case ${rulesTbl.provenance} when 'manual' then 0 when 'migrated' then 1 when 'promoted' then 2 when 'seeded-from-sent' then 3 else 4 end`,
        asc(rulesTbl.id),
      );
    return rows.map((r) => {
      const destination = r.destination as Rule["destination"];
      return {
        id: r.id, kind: r.kind as Rule["kind"], match: r.match,
        destination,
        // The ONE place a folder name is read as the user's yes/no. See `rules.ts#RuleEffect`:
        // `rules` has no `effect` column, so the destination is the only expression of intent the
        // writers have, and this is the line an `effect` column would replace.
        effect: effectForDestination(destination),
        priority: r.priority,
        provenance: r.provenance as Rule["provenance"], enabled: r.enabled,
        // The second term (mail 0050). Carried VERBATIM — the folding and the empty/whitespace
        // reading are `rules.ts#subjectTermOf`'s job and belong in one place, next to the matcher
        // that depends on them. `?? null` because drizzle types a nullable text as `string | null`
        // already; the coalesce is for the day somebody widens the select.
        subjectContains: r.subjectContains ?? null,
        // The third term (mail 0052), carried VERBATIM for the same reasons: the folding and the
        // blank reading are `rules.ts#bodyTermOf`'s job, in one place next to the matcher.
        bodyContains: r.bodyContains ?? null,
      };
    });
  }

  async knownSenders(accountId: string): Promise<Set<string>> {
    const rows = await this.db.select({ address: contactsTbl.address }).from(contactsTbl).where(eq(contactsTbl.accountId, accountId));
    return new Set(rows.map((r) => r.address.toLowerCase()));
  }

  async recordAudit(accountId: string, action: string, payload: unknown, inverse: unknown): Promise<void> {
    await this.db.insert(auditLog).values({
      accountId, action, payload: payload ?? null, inverse: inverse ?? null,
    });
  }

  /** {@link WorkerRepo.recordAuditMany} — the same rows, one INSERT. */
  async recordAuditMany(
    accountId: string, rows: ReadonlyArray<{ action: string; payload: unknown; inverse: unknown }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(auditLog).values(rows.map((r) => ({
      accountId, action: r.action, payload: r.payload ?? null, inverse: r.inverse ?? null,
    })));
  }

  /**
   * Append a delta-log row in the ambient transaction: allocateSeq + insert. The cast is
   * deliberate: `recordChange` takes `LedgerTx` so no caller can hand it an autocommit handle —
   * on one, the seq allocation commits and releases the counter lock before the log row lands,
   * and a poller in that window advances past a seq that is not there yet. This class holds one
   * `db` field that is legitimately either scope, so the guarantee moves to runtime for this seam
   * only: `assertLedgerTx` inside `allocateSeqRange` throws `NotInTransactionError` when the repo
   * was not built from a transaction — loud, never a silent reordering.
   */
  async recordChange(input: RepoChangeInput): Promise<bigint> {
    return recordChangeTx(this.db as LedgerTx, {
      accountId: input.accountId,
      entityType: input.entityType as EntityType,
      entityId: input.entityId,
      op: input.op,
      meta: input.meta ?? null,
    });
  }

  // ── Threading (mail 0026) ──

  /**
   * The closest already-ingested ancestor named by `candidates`, in candidate order. One
   * statement for the whole chain — a 4-deep `References` walk would otherwise be four round
   * trips per message — with priority applied in TypeScript, because SQL's `IN` has no order:
   * `In-Reply-To` first, then `References` right-to-left. `eq(messages.accountId, …)` is the
   * account-isolation boundary: a Message-ID is chosen by the sender, so without it a stranger
   * could adopt another account's conversation; it is also the leading column of
   * `messages_account_message_id_header_idx`. Ties break towards a row that already has a thread,
   * so an un-backfilled duplicate cannot hide the copy that has one.
   */
  async findThreadParent(accountId: string, candidates: readonly string[]): Promise<ThreadParent | null> {
    if (candidates.length === 0) return null;
    const rows = await this.db.select({
      id: messages.id, header: messages.messageIdHeader, threadId: messages.threadId,
    }).from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.messageIdHeader, [...candidates])));
    if (rows.length === 0) return null;

    const byHeader = new Map<string, { id: string; threadId: string | null }>();
    for (const r of rows) {
      if (!r.header) continue;
      const prev = byHeader.get(r.header);
      if (!prev || (prev.threadId === null && r.threadId !== null)) {
        byHeader.set(r.header, { id: r.id, threadId: r.threadId ?? null });
      }
    }
    for (const candidate of candidates) {
      const hit = byHeader.get(candidate);
      if (hit) return { messageId: hit.id, threadId: hit.threadId };
    }
    return null;
  }

  /**
   * One indexed-by-account probe over the away ledger, `LIMIT 1`, run only for a message already
   * DSN-shaped, so ordinary mail pays nothing. `lower()` on both sides: the ledger stores what
   * `mintMessageId` produced, whose domain comes from `mailboxes.address` unnormalised, while the
   * candidates were lower-cased by `parseMessageIds` — an exact match misses in silence for a
   * mixed-case mailbox and reads as no responder ever wrote to them. `lower()` is in both
   * dialects. `mintedMessageId` is NULL for a row that never dialled, so those cannot match and
   * no outcome filter is needed.
   */
  async isOwnAwayReply(accountId: string, candidates: readonly string[]): Promise<boolean> {
    if (candidates.length === 0) return false;
    const rows = await this.db.select({ id: awayReplies.id })
      .from(awayReplies)
      .where(and(
        eq(awayReplies.accountId, accountId),
        inArray(sql`lower(${awayReplies.mintedMessageId})`, candidates.map((c) => `<${c}>`)),
      ))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Find-or-create the conversation anchored at `(account_id, root_message_id_header)`. On the
   * server: one `ON CONFLICT DO UPDATE` whose SET is a deliberate no-op — its job is the row lock
   * and `RETURNING`, since `DO NOTHING` returns no row on conflict; `subject` is never written
   * here, because a rename is a user write ingest may not undo. `created` comes from `xmax = 0`,
   * cast to int because a boolean's wire shape differs between drivers. `xmax` does not exist on
   * the device store, so that arm is a branch: a SELECT then one of two writes, safe there
   * because one serialized connection leaves no second writer. A NULL header anchors nothing and
   * always creates, on both stores.
   */
  async upsertThread(input: ThreadUpsertInput): Promise<ThreadUpsertResult> {
    // THROUGH `this.d`, never `dialectOf(this.db)`. A transaction is a different object built by
    // the query builder and inherits no brand, so asking the handle directly throws inside exactly
    // the block this method is normally called from — the ingest's persist transaction. The getter
    // above says this in its own words; it was written here the other way first and three pipeline
    // cases said so.
    if (this.d.name === "sqlite") return this.upsertThreadOnDeviceStore(input);

    const rows = await this.db.insert(threads).values({
      accountId: input.accountId,
      rootMessageIdHeader: input.rootMessageIdHeader,
      subject: input.subject,
      participants: input.participants,
      lastMessageAt: input.lastMessageAt,
    }).onConflictDoUpdate({
      target: [threads.accountId, threads.rootMessageIdHeader],
      set: { updatedAt: sql`${threads.updatedAt}` },
    }).returning({ id: threads.id, inserted: pgOnly(sql<number>`(xmax = 0)::int`) });

    const row = rows[0];
    if (!row) throw new Error("upsertThread: ON CONFLICT DO UPDATE returned no row");
    return { id: row.id, created: Number(row.inserted) === 1 };
  }

  /** {@link upsertThread}'s device arm. See that method's own note for why it is a branch. */
  private async upsertThreadOnDeviceStore(input: ThreadUpsertInput): Promise<ThreadUpsertResult> {
    const insert = async (): Promise<ThreadUpsertResult> => {
      const [created] = await this.db.insert(threads).values({
        accountId: input.accountId,
        rootMessageIdHeader: input.rootMessageIdHeader,
        subject: input.subject,
        participants: input.participants,
        lastMessageAt: input.lastMessageAt,
      }).returning({ id: threads.id });
      if (!created) throw new Error("upsertThread: the insert returned no row");
      return { id: created.id, created: true };
    };

    if (input.rootMessageIdHeader === null) return insert();

    const [existing] = await this.db.select({ id: threads.id }).from(threads)
      .where(and(
        eq(threads.accountId, input.accountId),
        eq(threads.rootMessageIdHeader, input.rootMessageIdHeader),
      )).limit(1);
    if (!existing) return insert();

    // The no-op the server's conflict arm performs, kept so both arms leave the row in the same
    // state: the merge is `mergeThreadMessage`, and `subject` is never written here because a
    // rename is a person's decision that ingest may not undo.
    await this.db.update(threads).set({ updatedAt: sql`${threads.updatedAt}` })
      .where(eq(threads.id, existing.id));
    return { id: existing.id, created: false };
  }

  /**
   * Fold a joining message into an existing thread: union its sender into `participants`, advance
   * `last_message_at` if newer. Returns whether anything moved, so the caller does not record a
   * `change_log` row for a write that did not happen. `FOR UPDATE` plus read-modify-write rather
   * than a jsonb aggregate because the union is by address — `jsonb_agg(DISTINCT …)` compares
   * whole objects and would keep two display names for one address. The lock holds to commit, so
   * two mailboxes of one account folding into the same thread serialize.
   */
  async mergeThreadMessage(threadId: string, input: ThreadMergeInput): Promise<boolean> {
    const rows = await this.d.forUpdate(
      this.db.select({
        participants: threads.participants, lastMessageAt: threads.lastMessageAt,
      }).from(threads).where(eq(threads.id, threadId)).limit(1),
    );
    const row = rows[0];
    if (!row) return false;

    const current = (row.participants as EmailAddress[] | null) ?? [];
    const byAddress = new Map(current.map((p) => [p.address.toLowerCase(), p]));
    let grew = false;
    for (const p of input.participants) {
      const key = p.address.toLowerCase();
      if (!key || byAddress.has(key)) continue;
      byAddress.set(key, p);
      grew = true;
    }
    const advance = input.lastMessageAt !== null
      && (row.lastMessageAt === null || input.lastMessageAt.getTime() > row.lastMessageAt.getTime());
    if (!grew && !advance) return false;

    await this.db.update(threads).set({
      ...(grew ? { participants: [...byAddress.values()] } : {}),
      ...(advance ? { lastMessageAt: input.lastMessageAt } : {}),
      updatedAt: new Date(),
    }).where(eq(threads.id, threadId));
    return true;
  }

  /**
   * Attach a message to a thread, ONLY if it has none.
   *
   * The `thread_id IS NULL` predicate is what makes the backfill re-runnable and a concurrent
   * second resolver a no-op — and it is also the rule that a resolved thread is never silently
   * reassigned, which matters because `POST /threads/merge` is a user decision that a later
   * ingest of an out-of-order sibling must not undo.
   */
  async setMessageThread(messageId: string, threadId: string): Promise<boolean> {
    const rows = await this.db.update(messages)
      .set({ threadId, updatedAt: new Date() })
      .where(and(eq(messages.id, messageId), sql`${messages.threadId} is null`))
      .returning({ id: messages.id });
    return rows.length > 0;
  }

  /**
   * One page of the threading backlog — messages with no thread yet, oldest first, locked FOR
   * UPDATE. `ORDER BY date ASC NULLS FIRST, id` makes the pass mostly single-pass: a parent
   * resolves before its replies. No cursor, unlike `listScreenerBacklog`: every examined row
   * leaves the candidate set by gaining a `thread_id`, so an empty page is a genuine end. `of:
   * messages` and not the whole join, because `message_bodies` sits on the nullable side of a
   * LEFT JOIN and Postgres refuses to lock that; the LEFT JOIN itself is deliberate — a message
   * with no body row still deserves a thread.
   */
  async lockAccountThreadStructure(accountId: string): Promise<void> {
    await this.d.advisoryLock(this.db, ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS, accountId);
  }

  async listThreadBacklog(accountId: string, limit: number): Promise<ThreadBacklogRow[]> {
    const backlog = this.db.select({
      messageId: messages.id,
      messageIdHeader: messages.messageIdHeader,
      subject: messages.subject,
      fromAddress: messages.fromAddress,
      date: messages.date,
      headers: messageBodies.headers,
    }).from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), sql`${messages.threadId} is null`))
      .orderBy(sql`${messages.date} asc nulls first`, messages.id)
      .limit(limit);
    const rows = await this.d.forUpdate(backlog, { of: messages });

    return rows.map((r) => ({
      messageId: r.messageId,
      messageIdHeader: r.messageIdHeader ?? null,
      subject: r.subject,
      fromAddress: r.fromAddress,
      date: r.date ?? null,
      headers: (r.headers as Record<string, string[]> | null) ?? {},
    }));
  }

  // ── RoutingPort ──

  async recordRoutingDecision(d: RoutingDecisionInput): Promise<{ id: string }> {
    const [row] = await this.db.insert(routingDecisions).values({
      accountId: d.accountId,
      messageId: d.messageId,
      inputProvenance: d.inputProvenance,
      matchedRuleId: d.matchedRuleId ?? null,
      destination: d.destination,
      confidence: d.confidence ?? null,
      rationale: d.rationale ?? null,
      spam: d.spam ?? false,
      status: d.status,
    }).returning({ id: routingDecisions.id });
    return { id: row!.id };
  }

  async isGraduated(accountId: string, patternKey: string, action: "route"): Promise<boolean> {
    const rows = await this.db.select({ graduated: graduations.graduated }).from(graduations)
      .where(and(
        eq(graduations.accountId, accountId),
        eq(graduations.patternKey, patternKey),
        eq(graduations.action, action),
        eq(graduations.graduated, true),
      )).limit(1);
    return rows.length > 0;
  }

  /**
   * The override, resolved against the message's OWN sender rather than a sender the caller
   * carries down: the pipeline's adopt arm holds the folder state and the id, and reading the
   * two columns here is what keeps the seam from having to thread an address through it.
   *
   * The predicate itself is `@trafficflow/db#recordRouteOverride` — one definition, reachable
   * from the worker, which may not import the services package.
   */
  async recordExternalOverride(
    input: ExternalOverrideInput,
  ): Promise<ExternalOverrideOutcome | null> {
    const [msg] = await this.db
      .select({ from: messages.fromAddress })
      .from(messages)
      .where(and(eq(messages.accountId, input.accountId), eq(messages.id, input.messageId)))
      .limit(1);
    const from = msg?.from ?? "";
    const at = from.lastIndexOf("@");
    const outcome = await recordRouteOverride(this.db as unknown as Tx, input.accountId, {
      senderAddress: from || null,
      senderDomain: at > 0 ? from.slice(at + 1) : null,
      filedTo: input.filedTo,
      triggeringActionId: routeOverrideActionId(input.messageId, input.seq),
    });
    return outcome;
  }

  async enqueueApproval(a: ApprovalInput): Promise<{ id: string }> {
    const [row] = await this.db.insert(approvals).values({
      accountId: a.accountId,
      kind: a.kind,
      messageId: a.messageId ?? null,
      routingDecisionId: a.routingDecisionId ?? null,
      action: a.action,
      summary: a.summary ?? "",
      payload: a.payload ?? null,
      confidence: a.confidence ?? null,
      status: "pending",
      expiresAt: a.expiresAt ?? null,
    }).returning({ id: approvals.id });
    return { id: row!.id };
  }

  async transaction<T>(fn: (repo: DrizzleRepo) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txdb) => {
      // The transaction speaks this handle's dialect by construction: the driver's transaction
      // object carries no brand, and passing the resolved value is what spares every caller of this
      // method the carry that direct construction has to do for itself.
      const inner = new DrizzleRepo(txdb as Db, this.d);
      return fn(inner);
    });
  }

  async getMailbox(mailboxId: string) {
    const rows = await this.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
    return rows[0]
      ? {
        id: rows[0].id, accountId: rows[0].accountId, address: rows[0].address,
        kickstartAt: rows[0].kickstartAt ?? null,
      }
      : null;
  }

  /**
   * Stamp `mailboxes.kickstart_at` — the one-shot kickstart marker (mail 0025).
   *
   * `WHERE kickstart_at IS NULL` and `.returning()`, so the answer is the DATABASE's and not a
   * read-then-write this process performed: two workers mid-leader-handover both finishing the
   * pass produce exactly one `true`. Deliberately NOT fenced on the leader epoch the way
   * `markMailboxFailed` is — this is not a lifecycle claim that a stale leader could get wrong,
   * it is "the work happened", and the work HAS happened whoever performed it.
   */
  async markKickstarted(mailboxId: string, at: Date): Promise<boolean> {
    const rows = await this.db.update(mailboxes).set({ kickstartAt: at })
      .where(and(eq(mailboxes.id, mailboxId), sql`${mailboxes.kickstartAt} is null`))
      .returning({ id: mailboxes.id });
    return rows.length > 0;
  }

  /** Known correspondents, deduped and lowercased. Returns the count of genuinely NEW rows. */
  async upsertContacts(accountId: string, addresses: readonly string[]): Promise<number> {
    const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes("@")))];
    if (unique.length === 0) return 0;
    const rows = await this.db.insert(contactsTbl)
      .values(unique.map((address) => ({ accountId, address })))
      .onConflictDoNothing({ target: [contactsTbl.accountId, contactsTbl.address] })
      .returning({ id: contactsTbl.id });
    return rows.length;
  }

  async listScreenerBacklog(
    mailboxId: string, opts: { limit: number; afterId?: string },
  ): Promise<ScreenerBacklogRow[]> {
    const filters = [
      eq(messages.mailboxId, mailboxId),
      eq(folderState.desiredFolder, "ohmail/Screener"),
      eq(folderState.lastSetBy, "us"),
      // The user's decisions are off limits: a `rules` row for this sender (or domain) is what
      // `POST /screener/:id` writes. Un-narrowed rules only — `subject_contains`/`body_contains`
      // (mail 0050, 0052) are conjunctions that can only make a rule fire less often, so matching
      // on `kind`/`match` alone let one narrow rule remove every other message from that sender
      // from this backlog. Those messages now reach `evaluateRules`, which is the licence for
      // narrowing here: this backlog is handed to a pass that runs the evaluator.
      // `apps/worker/src/screener-auto.ts` keeps the identical predicate un-narrowed because it
      // has no evaluator downstream. This method's one caller, the connect-time re-route, was
      // retired — corrected anyway, because a wrong predicate on a live interface traps its next
      // caller.
      sql`not exists (
        select 1 from ${rulesTbl} r
         where r.account_id = ${messages.accountId}
           and r.enabled = true
           and r.subject_contains is null
           and r.body_contains is null
           and (
             (r.kind = 'sender' and lower(r.match) = lower(${messages.fromAddress}))
             or (r.kind = 'domain' and lower(r.match) = split_part(lower(${messages.fromAddress}), '@', 2))
           )
      )`,
    ];
    if (opts.afterId) filters.push(sql`${messages.id} > ${this.d.castUuid(opts.afterId)}`);

    const page = this.db.select({
      messageId: messages.id,
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      observedFolder: folderState.observedFolder,
      headers: messageBodies.headers,
    }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(...filters))
      .orderBy(messages.id)
      .limit(opts.limit);
    // `of: folderState` and not the whole join: `message_bodies` is on the NULLABLE side of a
    // LEFT JOIN, which the server refuses to lock, and locking `messages` would serialize the
    // pass against ordinary ingest for no benefit.
    const rows = await this.d.forUpdate(page, { of: folderState });

    return rows.map((r) => ({
      messageId: r.messageId,
      fromAddress: r.fromAddress,
      subject: r.subject,
      headers: (r.headers as Record<string, string[]> | null) ?? {},
      observedFolder: r.observedFolder,
    }));
  }

  async getMailboxFolders(mailboxId: string) {
    const rows = await this.db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mailboxId));
    return rows.map((r) => ({
      folder: r.folder,
      uidValidity: r.uidvalidity != null ? String(r.uidvalidity) : "0",
      uidNext: r.uidnext != null ? Number(r.uidnext) : 0,
      highestModseq: r.highestmodseq != null ? String(r.highestmodseq) : "0",
      // Mail 0083. Carried on the read so `buildCursor`'s round trip preserves it — without this
      // the value written by one cycle would be absent from the cursor the NEXT cycle hands back
      // to `upsertMailboxFolder`, which is harmless only because the writer skips an absent one.
      // Carrying it keeps the cursor a faithful round trip of the row.
      ...(r.serverExists == null ? {} : { serverExists: r.serverExists }),
    }));
  }

  async upsertMailboxFolder(mailboxId: string, folder: string, cursor: PersistedFolderCursor): Promise<void> {
    /**
     * `server_exists` is spread, not assigned (mail 0083). Absent means this pass did not open
     * the folder — the passive fast path skips the SELECT on a provably unchanged folder, and
     * every fake adapter omits it. Assigning `?? null` would erase the last count somebody
     * actually observed, once per cycle, collapsing the strip's denominator to folders that
     * happened to change. An absent value writes nothing on both arms of the upsert; the column
     * is nullable because NULL means never opened under this build, a different fact from zero.
     */
    const exists = cursor.serverExists;
    await this.db.insert(mailboxFolders).values({
      mailboxId, folder,
      uidvalidity: BigInt(cursor.uidValidity), uidnext: BigInt(cursor.uidNext), highestmodseq: BigInt(cursor.highestModseq),
      ...(exists === undefined ? {} : { serverExists: exists }),
    }).onConflictDoUpdate({
      target: [mailboxFolders.mailboxId, mailboxFolders.folder],
      set: {
        uidvalidity: BigInt(cursor.uidValidity), uidnext: BigInt(cursor.uidNext),
        highestmodseq: BigInt(cursor.highestModseq), updatedAt: new Date(),
        ...(exists === undefined ? {} : { serverExists: exists }),
      },
    });
  }

  /**
   * User-commanded folder operations (`folder_ops`, mail 0074) — the folder-op pass's repo half,
   * driven by `apps/worker/src/folder-ops.ts` inside the mailbox's serial cycle, fenced. Two
   * string-prefix idioms recur below, both deliberate: subtree membership is `col = path OR
   * substr(col, 1, len+1) = path || '/'` — exact string functions, never LIKE, since a folder
   * name may contain `_` and an unescaped pattern would let `a_b` claim `axb/...`; the swap is
   * `to || substr(col, len(from)+1)` — the subject maps to `to` exactly, a descendant keeps its
   * relative path.
   */

  async listFolderOps(mailboxId: string): Promise<FolderOpRow[]> {
    const rows = await this.db.select({
      id: folderOps.id, accountId: folderOps.accountId, mailboxId: folderOps.mailboxId,
      folderId: folderOps.folderId, folder: mailboxFolders.folder,
      op: folderOps.op, toFolder: folderOps.toFolder, attempts: folderOps.attempts,
    }).from(folderOps)
      .innerJoin(mailboxFolders, eq(mailboxFolders.id, folderOps.folderId))
      .where(and(eq(folderOps.mailboxId, mailboxId), eq(folderOps.status, "pending")))
      .orderBy(asc(folderOps.requestedAt), asc(folderOps.id));
    return rows.map((r) => ({ ...r, op: r.op as FolderOpRow["op"] }));
  }

  async completeFolderCreate(
    op: Pick<FolderOpRow, "id" | "accountId" | "mailboxId" | "folder" | "folderId">,
    /**
     * Where the CREATE actually LANDED (the adapter's answer) — a personal-namespace server
     * files a root-named create under INBOX, so the commanded row must be re-spelt to the real
     * path or it stands as a phantom whose rename/delete answer "gone" for ever (measured
     * live). Three shapes: landed = commanded (the ordinary case — touch and settle); landed
     * elsewhere with no row there yet (re-spell the row); landed where DISCOVERY already
     * adopted a row (the discovered row IS the folder — the commanded row retires with a
     * tombstone, and the entity the rail keeps is the one every join already works against).
     */
    landed: string,
  ): Promise<void> {
    await this.db.delete(folderOps).where(eq(folderOps.id, op.id));
    if (landed !== op.folder) {
      const [existing] = await this.db.select({ id: mailboxFolders.id }).from(mailboxFolders)
        .where(and(eq(mailboxFolders.mailboxId, op.mailboxId), eq(mailboxFolders.folder, landed)))
        .limit(1);
      if (existing) {
        await this.db.delete(mailboxFolders).where(eq(mailboxFolders.id, op.folderId));
        await this.recordChange({
          accountId: op.accountId, entityType: "folder", entityId: op.folderId, op: "delete", meta: null,
        });
        await this.recordChange({
          accountId: op.accountId, entityType: "folder", entityId: existing.id, op: "update", meta: null,
        });
        return;
      }
      await this.db.update(mailboxFolders).set({ folder: landed, updatedAt: new Date() })
        .where(eq(mailboxFolders.id, op.folderId));
      await this.recordChange({
        accountId: op.accountId, entityType: "folder", entityId: op.folderId, op: "update", meta: null,
      });
      return;
    }
    await this.db.update(mailboxFolders).set({ updatedAt: new Date() })
      .where(eq(mailboxFolders.id, op.folderId));
    await this.recordChange({
      accountId: op.accountId, entityType: "folder", entityId: op.folderId, op: "update", meta: null,
    });
  }

  async applyFolderRename(
    op: Pick<FolderOpRow, "id" | "accountId" | "mailboxId" | "folder"> & { toFolder: string },
  ): Promise<{ folders: number; messages: number }> {
    const { accountId, mailboxId, folder: from, toFolder: to } = op;
    // SQL `length`, not JS `.length` — inSubtree's argument, one screen up. `||` here is string
    // concatenation, which both stores spell that way.
    const swap = (col: unknown) => sql`${to} || substr(${col}, length(${from}) + 1)`;
    const now = new Date();
    const changes: ChangeInput[] = [];

    // 1. Anything squatting a target path is a PHANTOM by definition: enqueue refused a real
    //    collision, and the IMAP RENAME just succeeded, so the server has nothing there. Its row
    //    goes, tombstoned, before the subtree swap would trip UNIQUE(mailbox_id, folder).
    const squatters = await this.db.select({ id: mailboxFolders.id }).from(mailboxFolders)
      .where(and(eq(mailboxFolders.mailboxId, mailboxId), inSubtree(mailboxFolders.folder, to)));
    for (const s of squatters) {
      await this.db.delete(mailboxFolders).where(eq(mailboxFolders.id, s.id));
      changes.push({ accountId, entityType: "folder", entityId: s.id, op: "delete", meta: null });
    }

    // 2. The message ids whose RENDERED folder string moves — read BEFORE the swap, with the
    //    exact derivation `MessageDTO.folder` uses (`folder_state.desired`, else the locator),
    //    so the change rows cover precisely the DTOs that changed. Tombstoned rows are already
    //    deleted on every mirror; their strings still swap below, but no row travels for them.
    const moved = await this.db.select({ id: messages.id }).from(messages)
      .leftJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.accountId, accountId),
        isNull(messages.deletedAt),
        inSubtree(sql`coalesce(${folderState.desiredFolder}, ${messages.nativeLocator}->>'folder')`, from),
      ));

    // 3. The inventory subtree, cursors riding along untouched.
    const subtree = await this.db.select({ id: mailboxFolders.id }).from(mailboxFolders)
      .where(and(eq(mailboxFolders.mailboxId, mailboxId), inSubtree(mailboxFolders.folder, from)));
    await this.db.update(mailboxFolders)
      .set({ folder: swap(mailboxFolders.folder) as unknown as string, updatedAt: now })
      .where(and(eq(mailboxFolders.mailboxId, mailboxId), inSubtree(mailboxFolders.folder, from)));
    for (const f of subtree) {
      changes.push({ accountId, entityType: "folder", entityId: f.id, op: "update", meta: null });
    }

    // 4. Every other spelling of the old path. `folder_state` desired and observed move
    //    INDEPENDENTLY (a pending move INTO the subtree retargets; its source stays put), and
    //    both sides scope through the mailbox's own messages.
    const ofThisMailbox = sql`${folderState.messageId} in
      (select ${messages.id} from ${messages} where ${messages.mailboxId} = ${mailboxId})`;
    await this.db.update(folderState)
      .set({ desiredFolder: swap(folderState.desiredFolder) as unknown as string, updatedAt: now })
      .where(and(ofThisMailbox, inSubtree(folderState.desiredFolder, from)));
    await this.db.update(folderState)
      .set({ observedFolder: swap(folderState.observedFolder) as unknown as string, updatedAt: now })
      .where(and(ofThisMailbox, inSubtree(folderState.observedFolder, from)));
    await this.db.update(messages)
      .set({
        /* ONE TOP-LEVEL KEY, through the seam. `jsonb_set(doc, '{folder}', to_jsonb(v))` is the
           server's single-key setter and the device store has no such function; a shallow merge of
           a one-key object is the same write, and the `is not null` below is what keeps it the
           same on a NULL locator — the server's setter answers NULL there and the merge would
           create a row. */
        nativeLocator: this.d.jsonMergeShallow(
          messages.nativeLocator,
          this.d.jsonObject({
            folder: sql`${to} || substr(${messages.nativeLocator}->>'folder', length(${from}) + 1)`,
          }),
        ) as unknown as NativeLocator,
        updatedAt: now,
      })
      .where(and(
        eq(messages.mailboxId, mailboxId),
        sql`${messages.nativeLocator} is not null`,
        inSubtree(sql`${messages.nativeLocator}->>'folder'`, from),
      ));
    await this.db.update(messageInstances)
      .set({ folder: swap(messageInstances.folder) as unknown as string, lastSeenAt: now })
      .where(and(eq(messageInstances.mailboxId, mailboxId), inSubtree(messageInstances.folder, from)));
    await this.db.update(messageFailures)
      .set({ folder: swap(messageFailures.folder) as unknown as string })
      .where(and(eq(messageFailures.mailboxId, mailboxId), inSubtree(messageFailures.folder, from)));

    // 5. The command retires with the swap — same transaction, so a crash leaves it pending and
    //    the pass's idempotent-completion arm re-enters.
    await this.db.delete(folderOps).where(eq(folderOps.id, op.id));

    for (const m of moved) {
      changes.push({ accountId, entityType: "message", entityId: m.id, op: "update", meta: null });
    }
    // Batched through `recordChanges` — one seq-range allocation and one wake per CHUNK rather
    // than a per-row lock acquisition (the 30-second class of defect §17.1 measured on this
    // feature's enable path) — and CHUNKED because one unbounded multi-row INSERT crosses
    // PostgreSQL's 65 535 bind-parameter ceiling around ten thousand rows: the IMAP RENAME has
    // already happened by now, so a failed insert would strand the command in a retry loop
    // whose database half can never succeed. All chunks ride THIS transaction — the swap stays
    // all-or-nothing; only the statement size is bounded.
    for (let i = 0; i < changes.length; i += RENAME_CHANGE_CHUNK) {
      await recordChangesTx(this.db as LedgerTx, changes.slice(i, i + RENAME_CHANGE_CHUNK));
    }

    return { folders: subtree.length, messages: moved.length };
  }

  async listFolderSubtree(mailboxId: string, folder: string): Promise<Array<{ id: string; folder: string }>> {
    const rows = await this.db.select({ id: mailboxFolders.id, folder: mailboxFolders.folder })
      .from(mailboxFolders)
      .where(and(eq(mailboxFolders.mailboxId, mailboxId), inSubtree(mailboxFolders.folder, folder)));
    // Leaf-deepest first — the folder delete's order: children leave the server before their
    // parent, so no IMAP DELETE ever targets a folder with inferiors.
    return rows.sort((a, b) => (b.folder.length - a.folder.length) || (a.folder < b.folder ? -1 : 1));
  }

  async tombstoneFolderMessages(
    accountId: string, mailboxId: string, folder: string, limit: number,
    /**
     * The mailbox's RESOLVED Sent path (`capabilities().watchedSentFolder`), when the caller
     * holds a live adapter — the stale-residue guard's primary comparison. The shape belt
     * below stays as the fallback (and the belt for UNRESOLVED Sent-shaped siblings an old
     * mailbox can carry): both err toward PRESERVING, because lost Sent evidence never heals
     * while a lingering stale row is re-taught by the next end-to-end enumeration.
     */
    sentFolder?: string | null,
  ): Promise<number> {
    const now = new Date();
    const changes: ChangeInput[] = [];

    /**
     * The EPOCH-VALID survivor of one message, or null — the promotion target when a swept
     * copy was the primary. Valid means: a watched instance in another folder whose
     * UIDVALIDITY matches that folder's CURRENT inventory epoch (an epochless inventory row —
     * the "0"/null cold sentinel — vetoes nothing). Reset-orphaned rows of a dead epoch can
     * coexist with current ones, and promoting one would write a locator the server no longer
     * has, permanently, while the real copy stays "known" and can never repair it. Answered by
     * ROW ID so the promotion updates exactly one row — a folder that reused a UID across
     * epochs would otherwise match two and trip the primary uniqueness mid-transaction.
     */
    const survivorOf = async (messageId: string) => {
      // TIER 1 — a CONFIRMED survivor: a folder the inventory knows, in that folder's current
      // epoch (an epochless cursor — the "0"/null cold sentinel — vetoes nothing). Reset
      // residue of a dead epoch can coexist with the live row, and promoting it would write a
      // locator the server no longer has while the real copy stays known.
      const [confirmed] = await this.db.select({
        id: messageInstances.id, folder: messageInstances.folder,
        uidvalidity: messageInstances.uidvalidity, uid: messageInstances.uid,
      }).from(messageInstances)
        .innerJoin(mailboxFolders, and(
          eq(mailboxFolders.mailboxId, messageInstances.mailboxId),
          eq(mailboxFolders.folder, messageInstances.folder),
        ))
        .where(and(
          eq(messageInstances.messageId, messageId),
          sql`(${mailboxFolders.uidvalidity} is null or ${mailboxFolders.uidvalidity} in (0, ${messageInstances.uidvalidity}))`,
        ))
        .orderBy(sql`${messageInstances.isPrimary} desc`, asc(messageInstances.firstSeenAt))
        .limit(1);
      if (confirmed) return confirmed;
      // TIER 2 — a MISSING-CURSOR copy ONLY: an instance whose folder has no cursor row at all
      // (ingest commits per message and the cursor lands after the batch, so a crash window
      // leaves real copies cursor-less). A missing cursor is UNKNOWN, never evidence of
      // deletion — tombstoning would hide a message the server still shows, permanently — and
      // a stale promotion self-heals (a dead locator answers MessageGoneError; enumeration
      // adopts the real copy). A cursor that EXISTS with a different epoch is the opposite
      // case and stays rejected: that row is KNOWN dead (old-epoch deletes are deliberately
      // ignored after a UIDVALIDITY reset, so the residue lingers), and promoting it would
      // pin a locator the server can never resolve.
      const [cursorless] = await this.db.select({
        id: messageInstances.id, folder: messageInstances.folder,
        uidvalidity: messageInstances.uidvalidity, uid: messageInstances.uid,
      }).from(messageInstances)
        .leftJoin(mailboxFolders, and(
          eq(mailboxFolders.mailboxId, messageInstances.mailboxId),
          eq(mailboxFolders.folder, messageInstances.folder),
        ))
        .where(and(
          eq(messageInstances.messageId, messageId),
          sql`${mailboxFolders.id} is null`,
        ))
        .orderBy(sql`${messageInstances.isPrimary} desc`, asc(messageInstances.firstSeenAt))
        .limit(1);
      return cursorless ?? null;
    };

    /** Promote one survivor row: primary flag + the message's locator, an update on the wire. */
    const promote = async (messageId: string, survivor: NonNullable<Awaited<ReturnType<typeof survivorOf>>>) => {
      await this.db.update(messageInstances).set({ isPrimary: true, lastSeenAt: now })
        .where(eq(messageInstances.id, survivor.id));
      await this.db.update(messages).set({
        nativeLocator: { folder: survivor.folder, ref: `${survivor.uidvalidity}:${survivor.uid}` } as NativeLocator,
        updatedAt: now,
      }).where(eq(messages.id, messageId));
    };

    // ── The RENDERED residents: messages every view shows in this folder ──────────────────
    const victims = await this.db.select({ id: messages.id }).from(messages)
      .leftJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.accountId, accountId),
        isNull(messages.deletedAt),
        sql`coalesce(${folderState.desiredFolder}, ${messages.nativeLocator}->>'folder') = ${folder}`,
      ))
      .orderBy(asc(messages.id))
      .limit(limit);
    for (const v of victims) {
      // The swept folder's instance rows go FIRST, so "what remains" below is the survivor
      // question `forgetInstanceAt` asks: a logical message whose primary copy lived here may
      // hold another WATCHED copy elsewhere, and tombstoning it whole would hide a message the
      // server still shows (the known-set would keep its UID known, so nothing would ever
      // resurrect it).
      await this.db.delete(messageInstances)
        .where(and(eq(messageInstances.messageId, v.id), eq(messageInstances.folder, folder)));
      const survivor = await survivorOf(v.id);
      if (survivor) {
        // PROMOTE, never tombstone: the message lives on in watched space. The pending
        // folder_state row (if any) is retired — its move was into a folder that is going away
        // — and the mirror hears an update whose rendered folder is now the survivor's.
        await promote(v.id, survivor);
        await this.db.delete(folderState).where(eq(folderState.messageId, v.id));
        changes.push({ accountId, entityType: "message", entityId: v.id, op: "update", meta: null });
        continue;
      }
      // No copy left anywhere watched — the delete verb's own mirror semantics
      // (`tombstoneInstanceless` is the template): the header row stays (identity, attribution,
      // the resurrect-on-return path), its body is husked, and the locator is dropped because
      // the server sweep moved the copy to Trash by folder, so no per-message locator survives
      // to point anywhere true.
      await this.db.update(messages).set({ deletedAt: now, updatedAt: now, nativeLocator: null })
        .where(eq(messages.id, v.id));
      await this.huskBody(accountId, v.id, "expunged");
      await this.db.delete(folderState).where(eq(folderState.messageId, v.id));
      changes.push({ accountId, entityType: "message", entityId: v.id, op: "delete", meta: null });
    }

    // ── The STRAGGLERS: instance rows still in the swept folder whose message RENDERS
    // elsewhere — a pending move OUT (`desired_folder` points away), or an already-tombstoned
    // row. Their copies left the server with the sweep too, and each is processed through the
    // SAME survivor question — a bulk delete here once removed a message's only primary row
    // without promotion, leaving a permanent locator into a deleted folder. Only entered once
    // the victims pick has drained (< limit), and bounded like it.
    let stragglerCount = 0;
    if (victims.length < limit) {
      // Paged by MESSAGE, never by instance row: a row-level page could split one message's
      // copies across pages — its primary unselected while the per-message delete below takes
      // every row, bypassing promotion — and could under-fill while unselected messages
      // remain, letting the caller read "clean" off a folder that still holds instances.
      const group = await this.db.selectDistinct({ messageId: messageInstances.messageId })
        .from(messageInstances)
        .where(and(eq(messageInstances.mailboxId, mailboxId), eq(messageInstances.folder, folder)))
        .orderBy(asc(messageInstances.messageId))
        .limit(limit);
      stragglerCount = group.length;
      for (const st of group) {
        const removed = await this.db.delete(messageInstances)
          .where(and(eq(messageInstances.messageId, st.messageId), eq(messageInstances.folder, folder)))
          .returning({ isPrimary: messageInstances.isPrimary });
        const hadPrimary = removed.some((r) => r.isPrimary);
        if (!hadPrimary) continue;
        const [m] = await this.db.select({ deletedAt: messages.deletedAt }).from(messages)
          .where(eq(messages.id, st.messageId));
        if (!m || m.deletedAt !== null) continue;
        const survivor = await survivorOf(st.messageId);
        if (survivor) {
          await promote(st.messageId, survivor);
          const [fs] = await this.db.select({ desiredFolder: folderState.desiredFolder })
            .from(folderState).where(eq(folderState.messageId, st.messageId)).limit(1);
          if (fs && fs.desiredFolder !== survivor.folder) {
            // The user's pending move STANDS — its subject copy is gone, but the message lives
            // on at the survivor, so reconciliation continues from there: observed moves to
            // the survivor's folder, desired stays the user's own word (pending user moves are
            // never discarded — the folder_state contract).
            await this.db.update(folderState)
              .set({ observedFolder: survivor.folder, updatedAt: now })
              .where(eq(folderState.messageId, st.messageId));
          } else if (fs) {
            // The survivor IS the destination — the move is done in effect. Kept, the row
            // would drive a same-folder move whose destination precheck expunges the "old"
            // copy: the survivor itself.
            await this.db.delete(folderState).where(eq(folderState.messageId, st.messageId));
          }
          changes.push({ accountId, entityType: "message", entityId: st.messageId, op: "update", meta: null });
          continue;
        }
        // No admissible survivor. TWO sub-cases, split on whether a move was IN FLIGHT:
        const [pending] = await this.db.select({ desiredFolder: folderState.desiredFolder })
          .from(folderState).where(eq(folderState.messageId, st.messageId)).limit(1);
        if (pending && pending.desiredFolder !== folder) {
          // A pending move out whose IMAP half may already have succeeded, its completion lost
          // (this pass runs before changesSince, so no survivor row exists yet). Tombstoning
          // would hide real server mail for ever, so defer instead, preserving the adoption
          // evidence `primaryInstanceVanished` reads: if the move landed, the destination copy is
          // adopted on ingest; if not, the row parks under the reconciler's bounded retry.
          // Known-stale residue goes first: a dead-epoch instance row would keep the message out
          // of every terminal check for ever. Except Sent: it is scanned by UID watermark, never
          // enumerated whole, so after a UIDVALIDITY reset a stale Sent row is the last evidence
          // its copy exists — deleting it would let the phantom reaper tombstone real mail.
          const staleRows = await this.db.select({
            id: messageInstances.id, folder: messageInstances.folder,
          }).from(messageInstances)
            .innerJoin(mailboxFolders, and(
              eq(mailboxFolders.mailboxId, messageInstances.mailboxId),
              eq(mailboxFolders.folder, messageInstances.folder),
            ))
            .where(and(
              eq(messageInstances.messageId, st.messageId),
              sql`${mailboxFolders.uidvalidity} is not null and ${mailboxFolders.uidvalidity} not in (0, ${messageInstances.uidvalidity})`,
            ));
          const removable = staleRows
            .filter((r) => r.folder !== (sentFolder ?? null) && !SENT_SHAPED_CANONICAL.test(r.folder))
            .map((r) => r.id);
          if (removable.length > 0) {
            await this.db.delete(messageInstances).where(inArray(messageInstances.id, removable));
          }
          changes.push({ accountId, entityType: "message", entityId: st.messageId, op: "update", meta: null });
          continue;
        }
        // No move in flight: the user's folder delete swept this message's only copy to Trash,
        // so it takes the delete verb's own tombstone — never a retired state that would
        // rematerialize it in the Imbox.
        await this.db.update(messages).set({ deletedAt: now, updatedAt: now, nativeLocator: null })
          .where(eq(messages.id, st.messageId));
        await this.huskBody(accountId, st.messageId, "expunged");
        await this.db.delete(folderState).where(eq(folderState.messageId, st.messageId));
        changes.push({ accountId, entityType: "message", entityId: st.messageId, op: "delete", meta: null });
      }
    }

    await recordChangesTx(this.db as LedgerTx, changes);
    return victims.length + stragglerCount;
  }
  async removeFolderRow(accountId: string, folderId: string): Promise<void> {
    await this.db.delete(mailboxFolders).where(eq(mailboxFolders.id, folderId));
    await this.recordChange({
      accountId, entityType: "folder", entityId: folderId, op: "delete", meta: null,
    });
  }

  async failFolderOp(op: Pick<FolderOpRow, "id" | "accountId" | "folderId">, error: string): Promise<void> {
    await this.db.update(folderOps).set({ status: "failed", error, updatedAt: new Date() })
      .where(eq(folderOps.id, op.id));
    await this.recordChange({
      accountId: op.accountId, entityType: "folder", entityId: op.folderId, op: "update", meta: null,
    });
  }

  async deferFolderOp(opId: string, attempts: number): Promise<void> {
    await this.db.update(folderOps).set({ attempts, updatedAt: new Date() })
      .where(eq(folderOps.id, opId));
  }

  /**
   * This reads `message_instances`, and that terminates the re-fetch loop. Built from
   * `messages.native_locator` it named one locator per logical message, so every locator the
   * pipeline declined to make primary was re-enumerated, re-fetched and re-classified every cycle
   * for ever. `own_copy` escaped by accident behind the Sent UID watermark; INBOX has no
   * watermark, and `external_copy` declines there — the second delivery of a forged message would
   * have its body re-fetched on every poll. The epoch is a column now, an indexable `bigint`;
   * `buildCursor` still drops epoch-0 entries. `messages.message_id_header` stays a property of
   * the logical message — `correlateMoves` pairs on it.
   */
  async listKnownLocators(mailboxId: string): Promise<KnownLocator[]> {
    const rows = await this.db.select({
      folder: messageInstances.folder,
      uid: messageInstances.uid,
      uidvalidity: messageInstances.uidvalidity,
      messageIdHeader: messages.messageIdHeader,
      // The seen baseline, for the adapter's no-CONDSTORE flag fallback (see `KnownLocator.seen`).
      // `observed_seen` is what the server was last SEEN holding; `!unread` is what ingest
      // derived from the server's flags before any flag row existed. Both are observations of
      // the server, which is what a diff against the server needs — `desired_seen` is not, and
      // using it would report the user's own pending write back as an external change.
      observedSeen: flagState.observedSeen,
      unread: messages.unread,
    }).from(messageInstances)
      .innerJoin(messages, eq(messages.id, messageInstances.messageId))
      .leftJoin(flagState, eq(flagState.messageId, messageInstances.messageId))
      .where(eq(messageInstances.mailboxId, mailboxId));
    return rows.map((r) => ({
      folder: r.folder,
      uid: r.uid,
      uidValidity: r.uidvalidity != null ? String(r.uidvalidity) : "0",
      messageId: r.messageIdHeader ?? null,
      seen: r.observedSeen ?? !r.unread,
    }));
  }

  async listPendingFolderStates(mailboxId: string, limit?: number): Promise<PendingFolderState[]> {
    const base = this.db.select({
      messageId: folderState.messageId, desiredFolder: folderState.desiredFolder, observedFolder: folderState.observedFolder,
      lastSetBy: folderState.lastSetBy, nativeLocator: messages.nativeLocator,
      attempts: folderState.attempts,
      // One more column on the join this select already makes — never a second query, which
      // would spend the round trip it exists to save.
      deletedAt: messages.deletedAt,
    }).from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(
        eq(messages.mailboxId, mailboxId), eq(folderState.reconcileStatus, "pending"),
        dueNow(folderState.nextAttemptAt),
      ))
      // ORDERED WHETHER OR NOT IT IS LIMITED — see the port's doc. A LIMIT over physical row
      // order is a queue that can starve, and the ordering costs nothing on the unbounded call.
      .orderBy(asc(folderState.updatedAt), asc(folderState.messageId));
    const rows = await (limit != null ? base.limit(limit) : base);
    return rows.map((r) => ({
      messageId: r.messageId, desiredFolder: r.desiredFolder, observedFolder: r.observedFolder,
      lastSetBy: r.lastSetBy as FolderAttribution, nativeLocator: (r.nativeLocator as NativeLocator | null) ?? null,
      attempts: r.attempts,
      deletedAt: r.deletedAt,
    }));
  }

  async listPendingFlagStates(mailboxId: string): Promise<PendingFlagState[]> {
    const rows = await this.db.select({
      messageId: flagState.messageId, desiredSeen: flagState.desiredSeen, observedSeen: flagState.observedSeen,
      lastSetBy: flagState.lastSetBy, nativeLocator: messages.nativeLocator,
      attempts: flagState.attempts,
    }).from(flagState).innerJoin(messages, eq(messages.id, flagState.messageId))
      .where(and(
        eq(messages.mailboxId, mailboxId), eq(flagState.reconcileStatus, "pending"),
        dueNow(flagState.nextAttemptAt),
      ));
    return rows.map((r) => ({
      messageId: r.messageId, desiredSeen: r.desiredSeen, observedSeen: r.observedSeen,
      lastSetBy: r.lastSetBy as FolderAttribution, nativeLocator: (r.nativeLocator as NativeLocator | null) ?? null,
      attempts: r.attempts,
    }));
  }

  async deferFolderReconcile(
    messageId: string,
    next: { attempts: number; nextAttemptAt: Date; errorClass: FilingRefusalClass },
  ): Promise<void> {
    // THREE COLUMNS AND NO OTHERS — see the port's doc for why each omission matters, `updated_at`
    // most of all: it is this row's place in the oldest-first queue, and a refusal is not a
    // re-filing. The class is the third and it moves with the pair, never on its own.
    await this.db.update(folderState)
      .set({
        attempts: next.attempts,
        nextAttemptAt: next.nextAttemptAt,
        lastErrorClass: next.errorClass,
      })
      .where(eq(folderState.messageId, messageId));
  }

  async deferFlagReconcile(
    messageId: string, next: { attempts: number; nextAttemptAt: Date },
  ): Promise<void> {
    await this.db.update(flagState)
      .set({ attempts: next.attempts, nextAttemptAt: next.nextAttemptAt })
      .where(eq(flagState.messageId, messageId));
  }

  /**
   * Locate the message at `locator` inside this mailbox and adopt the server's `\Seen`. The
   * lookup is on the jsonb locator because there is no UID column — `messages.native_locator` is
   * the only record of where a message sits, and `listKnownLocators` reads it the same way; flag
   * changes arrive only on the CONDSTORE fast path, so this is a bounded per-cycle cost. The
   * mailbox scoping is the account-isolation boundary: a `(folder, uid)` pair repeats across
   * every mailbox on the planet, and without `mailbox_id` one account's IMAP server could dictate
   * another account's read state.
   */
  async applyExternalFlag(
    mailboxId: string, locator: NativeLocator, seen: boolean,
  ): Promise<ExternalFlagOutcome | null> {
    const [row] = await this.db.select({
      id: messages.id,
      unread: messages.unread,
      desiredSeen: flagState.desiredSeen,
      observedSeen: flagState.observedSeen,
      lastSetBy: flagState.lastSetBy,
    }).from(messages)
      .leftJoin(flagState, eq(flagState.messageId, messages.id))
      .where(and(
        eq(messages.mailboxId, mailboxId),
        sql`${messages.nativeLocator}->>'folder' = ${locator.folder}`,
        sql`${messages.nativeLocator}->>'ref' = ${locator.ref}`,
      )).limit(1);
    if (!row) return null;

    // OUR write is still in flight → the user's intent outranks the stale value the server is
    // still reporting. Leave everything; the reconcile pass below this one will push it.
    const ourWritePending =
      row.lastSetBy === "us" && row.desiredSeen != null && row.desiredSeen !== row.observedSeen;
    if (ourWritePending) return { messageId: row.id, applied: false, changed: false };

    const changed = row.unread !== !seen;
    if (changed) {
      /**
       * This branch adopts a `\Seen` the server reports — someone read the message in another
       * client. IMAP carries the flag, not when it was set, so the stamp is when we first saw it,
       * which can lag the real reading by a sync cycle. Accepted, because the alternative errs
       * worse: leaving the column NULL files mail read minutes ago in another client below
       * everything read here, under the rule that unstamped rows sort last. Within one sync cycle
       * the two orderings agree.
       */
      await this.db.update(messages)
        .set({ unread: !seen, lastReadAt: seen ? new Date() : null, updatedAt: new Date() })
        .where(eq(messages.id, row.id));
    }
    // The flag row is written either way: an unchanged value still RECORDS that the server has
    // been observed at `seen`, which is what a later user-wins decision reads.
    await this.upsertFlagState(row.id, { desiredSeen: seen, observedSeen: seen, lastSetBy: "external" });
    return { messageId: row.id, applied: true, changed };
  }
}

export function makeDrizzleRepo(db: Db): DrizzleRepo {
  return new DrizzleRepo(db);
}

/**
 * The authserv-ids a mailbox's own provider signs `Authentication-Results` with, resolved from
 * the IMAP host on its credential row. The one sanctioned bridge from a mailbox id to
 * `authserv-ids.ts#providerAuthservIds` for consumers holding a database handle but not the live
 * config — the unsubscribe service and the three re-derivation passes; seams that hold the config
 * call `providerAuthservIds(host)` on the host they dial, so the two paths cannot disagree.
 * `meta` is the credential row's non-secret half; `secret_enc` is never selected. No `imap` row
 * or no host resolves to the empty set: verdicts stay `"unavailable"` and nothing is demoted.
 */
export async function mailboxProviderAuthservIds(
  db: Db, mailboxId: string,
): Promise<ReadonlySet<string>> {
  const [row] = await db.select({ meta: mailboxCredentials.meta })
    .from(mailboxCredentials)
    .where(and(
      eq(mailboxCredentials.mailboxId, mailboxId),
      eq(mailboxCredentials.transport, "imap"),
    ))
    .limit(1);
  const meta = row?.meta as { host?: unknown } | null | undefined;
  return providerAuthservIds(typeof meta?.host === "string" ? meta.host : null);
}
