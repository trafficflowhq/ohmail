import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { messages, messageInstances, messageFailures, folderState, flagState, mailboxes, mailboxFolders, threads, rules as rulesTbl, contacts as contactsTbl, auditLog, messageBodies, attachments as attachmentsTbl, routingDecisions, approvals, graduations, recordChange as recordChangeTx, type LedgerTx, type Tx, type EntityType } from "@trafficflow/db";
import type {
  RepoPort, RoutingPort, StoredMessage, InsertedMessage, InsertMessageInput, FolderStateRow, FlagStateRow,
  Rule, NativeLocator, EmailAddress,
  MessageBodyInput, RepoChangeInput, RoutingDecisionInput, ApprovalInput, AttachmentMeta,
  ThreadParent, ThreadUpsertInput, ThreadUpsertResult, ThreadMergeInput,
  // `../mail.js`, not `../index.js`: the repository adapter needs the mail vocabulary, and the
  // default barrel re-exports the model half beside it — so naming it here would put the
  // classifier and the drafter into the import graph of every artifact that stores a message.
} from "../mail.js";
import { effectForDestination } from "../rules.js";

export interface PersistedFolderCursor { uidValidity: string; uidNext: number; highestModseq: string; }
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
export interface KnownLocator { folder: string; uid: number; uidValidity: string; messageId: string | null; }
export interface PendingFolderState {
  messageId: string; desiredFolder: string; observedFolder: string;
  lastSetBy: "us" | "external"; nativeLocator: NativeLocator | null;
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

/** A `flag_state` row still owed an IMAP write, joined to the locator the write needs. */
export interface PendingFlagState {
  messageId: string; desiredSeen: boolean; observedSeen: boolean;
  lastSetBy: "us" | "external"; nativeLocator: NativeLocator | null;
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

/** Worker-facing repo: everything the pipeline needs (RepoPort + RoutingPort) plus enumeration for sync/reconcile. */
export interface WorkerRepo extends RepoPort, RoutingPort {
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
   * One page of the Screener backlog the re-route pass may reconsider, LOCKED FOR UPDATE.
   *
   * Two predicates carry the whole "never override a user decision" rule, and both are in the
   * statement rather than in the caller:
   *
   *  · the sender (or its domain) has NO enabled rule. `rules` is the record of the user's
   *    screener decisions (`screener-service.ts` writes one per decide), so a sender with a rule
   *    has been ruled on and is not ours to re-route.
   *  · `last_set_by = 'us'`. A row set `external` is a placement the user performed in their own
   *    mail client, and the folder reconciler already refuses to revert those.
   *
   * `FOR UPDATE OF folder_state` is the concurrency half: two workers mid-leader-handover both
   * running this pass block on the same rows, and the loser re-evaluates the predicate against
   * the committed row and finds it no longer desired into the Screener — so a message is
   * re-routed once, not twice, and `change_log` gains one `move` and not two.
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
  getMailboxFolders(mailboxId: string): Promise<Array<{ folder: string } & PersistedFolderCursor>>;
  upsertMailboxFolder(mailboxId: string, folder: string, cursor: PersistedFolderCursor): Promise<void>;
  listKnownLocators(mailboxId: string): Promise<KnownLocator[]>;
  /**
   * Record that a locator DISAPPEARED — the worker's half of the move-evidence rule.
   *
   * On `WorkerRepo` and not `RepoPort` because only the sync loop can observe it: a disappearance
   * arrives as the adapter's `deletes`, which the API tier never sees. See
   * {@link MoveEvidence} for why it is the only thing that authorises an adoption.
   */
  forgetInstanceAt(mailboxId: string, locator: NativeLocator): Promise<void>;
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
   * CLAIM the failures this cycle may retry, atomically, and say what was claimed.
   *
   * One conditional UPDATE, because two workers mid-leader-handover both run this: the claim IS the
   * decision, exactly as `runAlertPass` claims a notification. The winner gets rows back; the loser
   * blocks on the row lock, re-reads the committed `attempted_version` and matches nothing.
   *
   * Due is `resolved_at IS NULL AND (next_attempt_at <= now() OR attempted_version IS DISTINCT FROM
   * version)`. The version arm is self-disarming — this statement stamps `attempted_version` — so a
   * deploy carrying a parser fix wakes every owed UID exactly once.
   */
  claimMessageFailures(
    mailboxId: string, opts: { version: string; now: Date; limit: number; nextAttemptAt: Date | null },
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
  listPendingFolderStates(mailboxId: string): Promise<PendingFolderState[]>;
  /** Read-state rows still owed an IMAP `\Seen` write (mail 0024). */
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
  return s.desiredFolder === s.observedFolder ? "reconciled" : "pending";
}

/** The same derivation for read-state: never set by hand, so a row cannot lie about converging. */
function flagStatusFor(s: FlagStateRow): "pending" | "reconciled" {
  return s.desiredSeen === s.observedSeen ? "reconciled" : "pending";
}

export class DrizzleRepo implements WorkerRepo, RoutingPort {
  constructor(private readonly db: Db) {}

  async findByDedupKey(mailboxId: string, dedupKey: string): Promise<StoredMessage | null> {
    const rows = await this.db.select().from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.dedupKey, dedupKey))).limit(1);
    return rows[0] ? rowToStored(rows[0]) : null;
  }

  async insertMessage(input: InsertMessageInput): Promise<InsertedMessage> {
    const inserted = await this.db.insert(messages).values({
      accountId: input.accountId, mailboxId: input.mailboxId,
      messageIdHeader: input.canonical.messageIdHeader,
      bodyHash: input.canonical.bodyHash,
      dedupKey: input.dedupKey,
      subject: input.subject, fromAddress: input.fromAddress, date: input.date,
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
      // ── EVERY MESSAGE ROW GETS ITS PRIMARY INSTANCE HERE, AND ONLY HERE ────────────────────
      //
      // `messages.native_locator` is now a MIRROR of the primary `message_instances` row, so the
      // two are born together in one statement pair inside the caller's transaction. Doing it in
      // `commitChange` instead would leave every other caller of `insertMessage` — and every
      // future one — able to create a message with no instance, and a message with no instance is
      // invisible to `listKnownLocators`: its body would be re-fetched on every cycle for ever.
      //
      // Only on a GENUINE insert. `onConflictDoNothing` returning nothing means the row was
      // already there, and its primary instance is wherever the user's own history left it —
      // re-asserting it from a re-ingest would drag the row back to an arrival locator that may
      // no longer exist.
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
   * Point the message's PRIMARY instance at `locator`, creating it if there is none.
   *
   * Three statements and the ORDER is the correctness. The destination tuple is vacated first,
   * because a NON-primary instance of this same message can already be sitting there — that is
   * exactly what an `external_copy` recorded, and it is the shape a user's own move into a folder
   * we already saw a copy in produces. Without the vacate, the UPDATE raises 23505 on
   * `message_instances_locator_uq` and takes the ingest transaction with it.
   *
   * The vacate is scoped to THIS message. A tuple claimed by a DIFFERENT message is an anomaly —
   * UIDs are not reused inside an epoch — and deleting another message's instance to make room
   * would be a write an attacker could aim by choosing when to deliver. It is left alone, the
   * UPDATE then fails loudly, and the cycle retries.
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
   * See {@link WorkerRepo.recordMessageFailure}.
   *
   * `attempts` starts at 1 and the conflict path does NOT touch it, which is the one thing worth
   * saying here: a repeated failure of the same UID inside one build is the same attempt observed
   * twice (the ingest loop offers it once per cycle and the in-memory ledger's attempt budget
   * already governs that), while `claimMessageFailures` is what counts a genuine RETRY. Letting
   * this statement increment would make an ordinary cycle look like exhausted patience and escalate
   * a message nobody has retried yet.
   *
   * `resolved_at` is cleared on conflict: a UID that failed again after being closed is owed again,
   * and the alternative is a resolved row silently shadowing a live failure.
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
    mailboxId: string, opts: { version: string; now: Date; limit: number; nextAttemptAt: Date | null },
  ): Promise<MessageFailureRow[]> {
    if (opts.limit <= 0) return [];
    /**
     * DUE = not closed, and either the clock has come round or the code has changed under it.
     *
     * `lte(column, date)` and never a `sql` fragment holding a `Date`, which is the rule
     * `runAlertPass` states at length and which this statement learned the same way: postgres.js
     * describes a bare parameter as TEXT, and `Bind` then throws
     * *"The 'string' argument must be of type string … Received an instance of Date"*. The column on
     * the left is what makes drizzle bind it as `timestamptz`.
     *
     * `IS DISTINCT FROM` rather than `<>`, because `attempted_version` is nullable and `NULL <> 'x'`
     * is NULL — a row nobody has stamped would never be due.
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

    // ONE statement, and THE DUE PREDICATE IS REPEATED IN THE UPDATE'S OWN `WHERE` — which is the
    // part that makes the handover safe rather than merely likely to be safe.
    //
    // Two workers mid-leader-handover run this at the same time. Both sub-selects can return the
    // same id; the second UPDATE then blocks on the winner's row lock, and under READ COMMITTED
    // Postgres re-evaluates the UPDATE's qual against the COMMITTED new row. With the predicate
    // present, the loser reads its own `version` in `attempted_version` and a `next_attempt_at` the
    // winner has already pushed forward (or nulled), matches nothing, and claims nothing. Relying on
    // the sub-select alone would make the outcome depend on whether the planner re-executes that
    // subplan — which is precisely the kind of question an in-memory Postgres answers differently.
    //
    // `attempts + 1` is written by the CLAIM and not by the retry's outcome, deliberately: a process
    // that dies mid-fetch must still have spent an attempt, or a poison message that reliably kills
    // the worker is retried for ever and never escalates.
    const rows = await this.db.update(messageFailures)
      .set({
        attempts: sql`${messageFailures.attempts} + 1`,
        attemptedVersion: opts.version,
        nextAttemptAt: opts.nextAttemptAt,
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
   * See {@link RepoPort.primaryInstanceVanished}. ONE statement, so it cannot answer half.
   *
   * ── THE SUBQUERY IS PARAMETERISED, NOT CORRELATED, AND THAT IS A BUG FIX ─────────────────────
   *
   * It was first written as `... where mi.message_id = ${messages.id} and mi.is_primary` against an
   * aliased `message_instances mi`. `message_instances` has an `id` column of its OWN, so the
   * reference resolved inside the subquery instead of to the outer `messages` row: the predicate
   * became `mi.message_id = mi.id`, which is never true, so `NOT EXISTS` was ALWAYS true and every
   * message read as VANISHED. That is the adoption branch — `external_copy` became `external_move`
   * and the adoption attack was back, through a column name rather than through the logic.
   *
   * Binding `messageId` as a parameter removes the possibility: there is no unqualified name left
   * for the planner to resolve, and no alias for one to hide behind. **PGlite never saw this** — it
   * was found by a message-identity test running against real Postgres, which is the fourth time
   * that has happened in this repository.
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
   * Forget the instance at `locator` — the ONLY place a DISAPPEARANCE is written.
   *
   * Called from `apps/worker/src/sync.ts` for each of the adapter's `deletes`, and only when the
   * folder's epoch matches the one the server just reported. That guard is the "on a UIDVALIDITY
   * change all evidence is void" rule: a new epoch renumbers, so an absence at the old epoch is
   * silence rather than a fact.
   *
   * A DELETE and not a flag, because the table has no absent column and does not need one: the
   * row's existence IS the claim that the locator exists. Removing it also takes the locator out
   * of `listKnownLocators`, which is correct — the server no longer has it to enumerate.
   */
  async forgetInstanceAt(mailboxId: string, locator: NativeLocator): Promise<void> {
    await this.db.delete(messageInstances).where(and(
      eq(messageInstances.mailboxId, mailboxId),
      eq(messageInstances.folder, locator.folder),
      eq(messageInstances.uidvalidity, BigInt(parseUidValidity(locator.ref))),
      eq(messageInstances.uid, parseUid(locator.ref)),
    ));
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

  async insertMessageBody(messageId: string, body: MessageBodyInput): Promise<void> {
    await this.db.insert(messageBodies).values({
      messageId, text: body.text, html: body.html,
      /**
       * `{ ...body.headers }` — the spread is LOAD-BEARING and this is the database boundary
       * `packages/core/src/mime.ts` names when it says the null-prototype guarantee "does not
       * survive a database round trip".
       *
       * The header parser builds that map with `Object.create(null)` so a `__proto__:` header cannot make
       * `(headers[name] ??= []).push(value)` throw — a two-byte email that wedged a mailbox
       * forever, because the folder cursor only advances after a whole batch. Correct fix, wrong
       * blast radius: **drizzle 0.36.4's `is()` calls `Object.getPrototypeOf(value).constructor`
       * on every insert value**, and on a null-prototype object that is `TypeError: Cannot read
       * properties of null`. So the map that stops one hostile message from breaking ingest broke
       * ALL ingest — the end-to-end sync test and every real-adapter path threw identically.
       *
       * Spreading here keeps both properties: the map is prototype-less for the whole of its
       * construction, where the attack lives, and an ordinary object by the time an ORM reflects
       * on it. Spread and not `Object.assign({}, …)` because spread uses CreateDataProperty, so
       * an own `__proto__` key is copied as a plain own property rather than invoking the setter.
       *
       * Do not "simplify" this to `body.headers`. The failure is not in this file and the test
       * that catches it is an e2e, so a unit run stays green.
       */
      headers: { ...body.headers },
    }).onConflictDoNothing({ target: messageBodies.messageId });
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
      lastSetBy: r.lastSetBy as "us" | "external",
    };
  }

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
      },
    });
  }

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
      },
    });
  }

  /**
   * Set `folder_state.conflict` and NOTHING else — the whole observable effect of an
   * `external_copy`.
   *
   * A separate method rather than a field on `FolderStateRow`, because {@link upsertFolderState}
   * writes `conflict: false` unconditionally on every call: expressing the conflict through it
   * would mean the next reconcile pass silently cleared the record. The `set` here names
   * `conflict` and `updated_at` only, so `desired_folder`, `observed_folder` and `last_set_by`
   * cannot move — which is the entire point, since a second delivery must not be able to change
   * where the user's message belongs.
   *
   * The insert branch exists for a message with no `folder_state` row yet; `s` seeds it with what
   * the plan read, so the flag always has somewhere to live.
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
   * Repoint the message: `messages.native_locator` AND its primary instance, together.
   *
   * `native_locator` is the primary instance's MIRROR (the ruling: "do not touch any read path in
   * this slice"), so every read path keeps working off the jsonb column while
   * `listKnownLocators` — the one read that decides what gets re-fetched — works off the table.
   * Two writes, one method, because the three call sites (`commitChange`,
   * `applyReconcileAction`, `reconcileFolders`) already funnel through here and a fourth that
   * forgot the instance would fail silently: a stale primary makes the adapter treat a dead UID as
   * known and never fetch the live one.
   */
  async updateLocator(messageId: string, locator: NativeLocator): Promise<void> {
    await this.db.update(messages).set({ nativeLocator: locator }).where(eq(messages.id, messageId));
    await this.setPrimaryInstance(messageId, locator);
  }

  /**
   * ── THE `ORDER BY` IS THE AUDIT TRAIL, NOT THE CORRECTNESS ────────────────────────────────
   *
   * `evaluateRules` resolves conflicts by a total order in TypeScript (`rules.ts#compareRules`),
   * so it is correct whatever order this returns. It was not AUDITABLE: this query had no
   * `ORDER BY` at all, so the array `evaluateRules` received was in PostgreSQL's **physical row
   * order**, which moves under UPDATE and VACUUM. Nobody could run one `SELECT` in `psql` and see
   * which rule the router would pick, and — before the total order landed — the same message
   * routed differently on different days with no rule change. PGlite returns stable insertion
   * order, so the whole class was invisible to every test that did not run against real Postgres.
   *
   * The clauses MIRROR `compareRules` step for step, deny-over-allow included, via the same
   * destination→effect mapping `effectForDestination` applies. A test against real Postgres
   * asserts the two agree by sorting this output with the exported comparator and requiring that
   * nothing moves — a `CASE` arm that drifts from the TypeScript is caught there, not in
   * production.
   */
  async listRules(accountId: string): Promise<Rule[]> {
    const rows = await this.db.select().from(rulesTbl).where(eq(rulesTbl.accountId, accountId))
      .orderBy(
        desc(rulesTbl.priority),
        sql`case when ${rulesTbl.destination} in ('ohmail/Screener', 'ohmail/Screened', 'ohmail/Quarantine') then 0 else 1 end`,
        sql`case ${rulesTbl.kind} when 'sender' then 0 when 'domain' then 1 else 2 end`,
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

  /**
   * Append a delta-log row in the AMBIENT transaction: allocateSeq + insert.
   *
   * THE CAST IS THE ONE PLACE THE TYPE CANNOT HELP, and it is deliberate rather than lazy.
   * `recordChange` takes `LedgerTx` precisely so that no caller can hand it an autocommit handle
   * — on one, the seq allocation commits and releases the counter row lock BEFORE the log row is
   * inserted, and a client polling in that window advances past a seq that is not there yet.
   * This class, though, holds ONE `db` field that is legitimately either scope: a top-level
   * handle for every read, and a transaction handle inside `transaction(...)`. Narrowing the
   * field would break every read-only construction site.
   *
   * So the guarantee moves to runtime for this seam only: `assertLedgerTx` inside
   * `allocateSeqRange` throws `NotInTransactionError` if this repo was NOT built from a
   * transaction. Calling it on a top-level repo is a loud failure, never a silent reordering.
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
   * The closest already-ingested ancestor named by `candidates`, in CANDIDATE ORDER.
   *
   * ONE statement for the whole chain, not one per candidate: a 4-deep `References` walk would
   * otherwise be four round trips per message, and the backfill does this once per row over
   * 8 792 of them. The candidate PRIORITY is then applied in TypeScript, because SQL's `IN`
   * has no order and the order is the ruling — `In-Reply-To` first, then `References`
   * right-to-left, nearest ancestor wins.
   *
   * `eq(messages.accountId, …)` is not a tidiness predicate. A Message-ID is chosen by whoever
   * sends the mail, so without it a stranger could name a header belonging to another account
   * and have their message adopt that account's conversation — which `materializeThread` then
   * renders as one thread — the account-isolation boundary. It is also the leading column of
   * `messages_account_message_id_header_idx`, so the index cannot even be probed cross-account.
   *
   * Several rows can share one header inside an account: the same mail delivered to two of the
   * user's mailboxes dedups per MAILBOX, not per account. They are the same message, so any of
   * them answers the question — the tie is broken towards a row that already HAS a thread, so
   * a duplicate that has not been backfilled yet cannot hide the copy that has.
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
   * Find-or-create the conversation anchored at `(account_id, root_message_id_header)`.
   *
   * ONE statement, `ON CONFLICT DO UPDATE`, and both halves of that matter:
   *
   *  · `DO UPDATE` and not `DO NOTHING`, because `DO NOTHING` returns no row on conflict and
   *    the follow-up `SELECT` would not see a concurrent INSERT that has not committed —
   *    under READ COMMITTED the loser gets neither the row nor an error and has to retry.
   *    `DO UPDATE` blocks on the conflicting row, then returns it.
   *  · the SET is deliberately a no-op (`updated_at = threads.updated_at`). Its job is to take
   *    the row lock and make `RETURNING` fire, not to merge — the merge is
   *    {@link mergeThreadMessage}, so ingest and adoption fold a message in through ONE code
   *    path instead of two that must be kept identical. In particular `subject` is never
   *    written here: `POST /threads/:id/rename` is a user write and ingest may not undo one.
   *
   * `created` comes from `xmax = 0` — the DATABASE's answer to "did I insert this", not this
   * process's guess — cast to int because a boolean's wire representation differs between
   * drivers and `Boolean("f")` is `true`.
   */
  async upsertThread(input: ThreadUpsertInput): Promise<ThreadUpsertResult> {
    const rows = await this.db.insert(threads).values({
      accountId: input.accountId,
      rootMessageIdHeader: input.rootMessageIdHeader,
      subject: input.subject,
      participants: input.participants,
      lastMessageAt: input.lastMessageAt,
    }).onConflictDoUpdate({
      target: [threads.accountId, threads.rootMessageIdHeader],
      set: { updatedAt: sql`${threads.updatedAt}` },
    }).returning({ id: threads.id, inserted: sql<number>`(xmax = 0)::int` });

    const row = rows[0];
    if (!row) throw new Error("upsertThread: ON CONFLICT DO UPDATE returned no row");
    return { id: row.id, created: Number(row.inserted) === 1 };
  }

  /**
   * Fold a joining message into an existing thread: union its sender into `participants`,
   * advance `last_message_at` if it is newer. Returns whether anything actually moved, so the
   * caller does not record a `change_log` row for a write that did not happen.
   *
   * `FOR UPDATE` and a read-modify-write rather than a jsonb aggregate in SQL, because the
   * union is BY ADDRESS and two rows for one address with different display names must collapse
   * to one — `jsonb_agg(DISTINCT …)` compares whole objects and would keep both. The lock is
   * held to COMMIT, so two mailboxes of one account folding into the same thread serialize
   * instead of losing one another's participant.
   */
  async mergeThreadMessage(threadId: string, input: ThreadMergeInput): Promise<boolean> {
    const rows = await this.db.select({
      participants: threads.participants, lastMessageAt: threads.lastMessageAt,
    }).from(threads).where(eq(threads.id, threadId)).limit(1).for("update");
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
   * ONE page of the threading backlog for an account, LOCKED FOR UPDATE — messages that have
   * no thread yet, oldest first.
   *
   * `ORDER BY date ASC NULLS FIRST, id` is the ruling's date-ascending order, and it is what
   * makes the pass mostly-single-pass: a parent is resolved before its replies, so each reply
   * hits the fast path (`parent.threadId` is already set) instead of the anchor path.
   *
   * No cursor, unlike `listScreenerBacklog`. Every row this pass examines LEAVES the candidate
   * set (it gains a `thread_id`), so paging from the start each time is correct and an empty
   * page is a genuine end condition. `FOR UPDATE OF messages` gives the concurrency half: a
   * second pass blocks on the locked rows and, when it re-reads, they no longer satisfy
   * `thread_id IS NULL` and drop out — one thread per conversation, one change per message.
   *
   * `of: messages` and not the whole join, because `message_bodies` is on the NULLABLE side of
   * a LEFT JOIN and Postgres refuses to lock that. The LEFT JOIN itself is deliberate: a
   * message whose body row is missing still deserves a thread (its own), and an INNER JOIN
   * would silently leave it out of the backlog for ever.
   */
  async listThreadBacklog(accountId: string, limit: number): Promise<ThreadBacklogRow[]> {
    const rows = await this.db.select({
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
      .limit(limit)
      .for("update", { of: messages });

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
    return this.db.transaction(async (txdb) => fn(new DrizzleRepo(txdb as Db)));
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
      // THE USER'S DECISIONS ARE OFF LIMITS. A `rules` row for this sender (or its domain) is
      // exactly what `POST /screener/:id` writes when somebody screens them in or out.
      sql`not exists (
        select 1 from ${rulesTbl} r
         where r.account_id = ${messages.accountId}
           and r.enabled = true
           and (
             (r.kind = 'sender' and lower(r.match) = lower(${messages.fromAddress}))
             or (r.kind = 'domain' and lower(r.match) = split_part(lower(${messages.fromAddress}), '@', 2))
           )
      )`,
    ];
    if (opts.afterId) filters.push(sql`${messages.id} > ${opts.afterId}::uuid`);

    const rows = await this.db.select({
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
      .limit(opts.limit)
      // `of: folderState` and not the whole join: `message_bodies` is on the NULLABLE side of a
      // LEFT JOIN, which Postgres refuses to lock, and locking `messages` would serialize the
      // pass against ordinary ingest for no benefit.
      .for("update", { of: folderState });

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
    }));
  }

  async upsertMailboxFolder(mailboxId: string, folder: string, cursor: PersistedFolderCursor): Promise<void> {
    await this.db.insert(mailboxFolders).values({
      mailboxId, folder,
      uidvalidity: BigInt(cursor.uidValidity), uidnext: BigInt(cursor.uidNext), highestmodseq: BigInt(cursor.highestModseq),
    }).onConflictDoUpdate({
      target: [mailboxFolders.mailboxId, mailboxFolders.folder],
      set: {
        uidvalidity: BigInt(cursor.uidValidity), uidnext: BigInt(cursor.uidNext),
        highestmodseq: BigInt(cursor.highestModseq), updatedAt: new Date(),
      },
    });
  }

  /**
   * ── THIS READS `message_instances`, AND THAT IS WHAT TERMINATES THE RE-FETCH LOOP ───────────
   *
   * The known-set is the adapter's answer to "which UIDs do I not need to fetch again". It used to
   * be built from `messages.native_locator`, which names ONE locator per logical message — so
   * every locator the pipeline declined to make primary was, cycle after cycle, an unknown UID:
   * enumerated, its RFC822 source pulled, parsed, classified, declined, forgotten. For ever.
   *
   * `own_copy` was the only declined outcome before this slice and it escaped by ACCIDENT: the
   * Sent folder is read behind a UID watermark (`DEFAULT_SENT_HISTORY_MESSAGES`), so a Sent UID is
   * behind the mark whether or not it produced a row. **INBOX has no watermark.** `external_copy`
   * declines in INBOX, so without this change the second delivery of a forged message would have
   * its body re-fetched on every single poll of that mailbox — turning a consent fix into an
   * unbounded cost, which is the shape of bug that took production down on 2026-08-01.
   *
   * The epoch is a COLUMN now instead of a parse of the ref's left half. Same value, but a
   * `bigint` the database can index and compare, and no `"0"` sentinel for a ref nobody could
   * parse — the migration wrote 0 for those, and `buildCursor` drops epoch-0 entries exactly as it
   * did before.
   *
   * `messages.message_id_header` still comes from the message: it is a property of the logical
   * message, and `correlateMoves` pairs on it.
   */
  async listKnownLocators(mailboxId: string): Promise<KnownLocator[]> {
    const rows = await this.db.select({
      folder: messageInstances.folder,
      uid: messageInstances.uid,
      uidvalidity: messageInstances.uidvalidity,
      messageIdHeader: messages.messageIdHeader,
    }).from(messageInstances)
      .innerJoin(messages, eq(messages.id, messageInstances.messageId))
      .where(eq(messageInstances.mailboxId, mailboxId));
    return rows.map((r) => ({
      folder: r.folder,
      uid: r.uid,
      uidValidity: r.uidvalidity != null ? String(r.uidvalidity) : "0",
      messageId: r.messageIdHeader ?? null,
    }));
  }

  async listPendingFolderStates(mailboxId: string): Promise<PendingFolderState[]> {
    const rows = await this.db.select({
      messageId: folderState.messageId, desiredFolder: folderState.desiredFolder, observedFolder: folderState.observedFolder,
      lastSetBy: folderState.lastSetBy, nativeLocator: messages.nativeLocator,
    }).from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.mailboxId, mailboxId), eq(folderState.reconcileStatus, "pending")));
    return rows.map((r) => ({
      messageId: r.messageId, desiredFolder: r.desiredFolder, observedFolder: r.observedFolder,
      lastSetBy: r.lastSetBy as "us" | "external", nativeLocator: (r.nativeLocator as NativeLocator | null) ?? null,
    }));
  }

  async listPendingFlagStates(mailboxId: string): Promise<PendingFlagState[]> {
    const rows = await this.db.select({
      messageId: flagState.messageId, desiredSeen: flagState.desiredSeen, observedSeen: flagState.observedSeen,
      lastSetBy: flagState.lastSetBy, nativeLocator: messages.nativeLocator,
    }).from(flagState).innerJoin(messages, eq(messages.id, flagState.messageId))
      .where(and(eq(messages.mailboxId, mailboxId), eq(flagState.reconcileStatus, "pending")));
    return rows.map((r) => ({
      messageId: r.messageId, desiredSeen: r.desiredSeen, observedSeen: r.observedSeen,
      lastSetBy: r.lastSetBy as "us" | "external", nativeLocator: (r.nativeLocator as NativeLocator | null) ?? null,
    }));
  }

  /**
   * Locate the message at `locator` inside THIS mailbox and adopt the server's `\Seen`.
   *
   * The lookup is on the jsonb locator rather than a UID column because there is no UID column
   * — `messages.native_locator` is the only record of where a message physically sits, and
   * `listKnownLocators` already reads it the same way. Flag changes only arrive on the
   * CONDSTORE fast path, in `changedSince` batches, so this is a bounded per-cycle cost and not
   * a hot query.
   *
   * The mailbox scoping is the account-isolation boundary: a locator is a `(folder, uid)` pair
   * that repeats across every mailbox on the planet, so a lookup without `mailbox_id` would let
   * one account's IMAP server dictate another account's read state.
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
       * THE READ ORDER GETS THE OBSERVATION TIME, AND THAT IS THE HONEST ANSWER AVAILABLE.
       *
       * This branch adopts a `\Seen` the mail server reports — someone read the message in
       * another client. The instant they read it is not on the wire: IMAP carries the flag, not
       * when it was set. So what is stamped is when WE first saw it, which is the reconcile pass
       * that noticed, and which can lag the real reading by up to a sync cycle.
       *
       * That is accepted rather than worked around, because the alternative is worse in the
       * direction that matters. Leaving the column NULL would file mail read minutes ago in
       * another client BELOW everything read here — under the rule that unstamped rows sort last
       * — which is a bigger error than a stamp that is a few minutes late. Within one sync cycle
       * the two orderings agree; across one, a message read elsewhere appears at the moment this
       * client learned about it, which is also the moment it stopped being bold on screen.
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
