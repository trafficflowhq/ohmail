import type { KnownLocator, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE KNOWN-SET, HELD IN MEMORY FOR AS LONG AS NOTHING COULD HAVE CHANGED IT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `buildCursor` reads `listKnownLocators(mailboxId)` at the top of every cycle: the whole mailbox,
 * every folder, no filter. It is the read that decides which UIDs the adapter does not have to
 * fetch again, so it cannot simply be dropped — but it is also state THIS PROCESS WROTE and that
 * nobody else may change while it serves the mailbox, re-read once every poll interval for the
 * life of the attachment. On a mailbox of any real size that is thousands of rows re-read to be
 * told the same thing, indefinitely: for a hosted install they cross a network and are paid for by
 * the row, and for a local one they are a scan and a two-way join against a database sharing the
 * machine with the window the user is looking at.
 *
 * ── WHY AN IN-PROCESS COPY IS SOUND AT ALL ────────────────────────────────────────────────────
 *
 * Three legs, each read in the code rather than assumed:
 *
 *  1. **Exactly one process organizes a mailbox.** The organizer lease in `ohmail/_meta`
 *     (`index.ts#mayOrganize`, re-verified before EVERY cycle, not only at attach), the shard
 *     leader fence over every mail-bearing write (`sync.ts#SyncWriteFence`,
 *     `mailboxes.ts#makeSyncWriteFence`), and the reconcile backstop's own lease + fence together
 *     mean no other process writes this mailbox's rows while this one serves it.
 *  2. **Every writer of the projection is in this process and reachable through one object.**
 *     `listKnownLocators` projects `message_instances` (folder, uid, uidvalidity) joined to
 *     `messages.message_id_header` and the read-state baseline `flag_state.observed_seen ??
 *     !messages.unread`. `message_instances` is written by `insertMessage` (via
 *     `setPrimaryInstance`), `recordInstance`, `updateLocator` (via `setPrimaryInstance`) and
 *     `forgetInstanceAt`, and by NOTHING else — `0028_message_instances.sql` says so in as many
 *     words: *"the WORKER … is the only process that writes `message_instances`"*.
 *     `message_id_header` is written once, by `insertMessage`, and never updated. The read-state
 *     baseline moves through `upsertFlagState` and `applyExternalFlag`.
 *
 *     **The API tier writes `messages.unread` and it CANNOT move this projection**, which is the
 *     one leg that had to be checked rather than argued. Every service that changes `unread` —
 *     `MessageService.patch`, `MessageService.markSeen`, `TriageService` resurface,
 *     `ScreenerService.decide`, and the worker's own `bubbleUpPass` / `readRetroPass` — pairs the
 *     write with a `flag_state` upsert that supplies `observed_seen` **only on the INSERT** and
 *     seeds it from the PRE-CHANGE `unread`, deliberately omitting it from the `ON CONFLICT` set
 *     because *"the worker owns it"*. So: a row that already had a flag row keeps its
 *     `observed_seen`; a row that had none gains one holding exactly the value `!unread` this
 *     projection was already reporting. `observed_seen ?? !unread` is invariant under all six.
 *     The suite drives the real service against a real database rather than leaving that as a
 *     reading of five files, with a bare `UPDATE messages SET unread` beside it as the negative
 *     control — which DOES move the projection, and without which the assertion would be vacuous.
 *  3. **Leadership changes are explicit events.** Detach, stand-down, `LeaderFencedError`, the
 *     lock-loss tripwire and `DatabaseFaultError` all reach code that can drop this object.
 *
 * ── AND WHY IT INVALIDATES INSTEAD OF MIRRORING THE WRITES ────────────────────────────────────
 *
 * A cache that applied each write to its own copy would be a second implementation of
 * `setPrimaryInstance`'s three-statement vacate/move/insert, of `forgetInstanceAt`'s
 * delete-and-promote-the-oldest-survivor, and of the `observed_seen ?? !unread` coalesce — kept in
 * step with SQL it cannot see. The failure it would drift into is the worst one this pipeline has:
 * an entry that says a live UID is already known, whose body is therefore never fetched and whose
 * folder cursor then advances past it. Silent, permanent, and invisible to a type checker, because
 * a mirror that has drifted is still a coherent program.
 *
 * So the copy is a MEMO and nothing more: a write drops it, and the next cycle re-reads. That
 * makes the whole contract one sentence — **the memo is served only for a cycle in which nothing
 * this process wrote could have changed it** — and it costs almost nothing, because the egress
 * being paid for is the IDLE poll. A cycle that ingested a message, moved one, or mirrored a flag
 * has already paid for a body fetch, an IMAP round trip and an ingest transaction; one more SELECT
 * on the next cycle is noise beside them. A mailbox at rest re-reads the set once per attachment.
 *
 * **The drop is EAGER — before the write is attempted, never after it.** That is what makes the
 * rollback question disappear: a transaction that writes and then aborts leaves the memo dropped,
 * which is the safe direction (one wasted read), and there is no window in which a write has
 * landed while the memo still says it is valid. A wrongly-dropped memo costs a query; a wrongly
 * kept one loses mail.
 *
 * ── AND THE CLASSIFICATION IS DIRTY-BY-DEFAULT ────────────────────────────────────────────────
 *
 * {@link KNOWN_SET_NEUTRAL} names the repo methods that CANNOT move the projection; everything
 * else drops the memo. An allowlist of WRITERS would be a list that silently stops covering the
 * method somebody adds next, and here that silence is mail loss. Dirty-by-default fails the other
 * way: a new writer nobody classified makes the memo useless, and the census in the log says so out
 * loud.
 */

/** The per-cycle census this cache contributes to the worker's log. */
export interface KnownSetCensus {
  /** Reads of `listKnownLocators` this cycle that reached Postgres. 0 or 1 in practice. */
  dbReads: number;
  /** Reads this cycle answered from memory. */
  hits: number;
  /** Rows the last database read returned. */
  rows: number;
  /** Estimated wire bytes of the last database read — see {@link estimateWireBytes}. */
  bytes: number;
  /** Estimated wire bytes NOT read since this cache was created, i.e. what the memo has saved. */
  bytesSaved: number;
  /** Why the memo was last dropped, or `null` if it never has been. */
  droppedBy: string | null;
}

/**
 * The `DataRow` width of one projected row, as postgres.js receives it in TEXT mode.
 *
 * Six columns — `folder`, `uid`, `uidvalidity`, `message_id_header`, `observed_seen`, `unread` —
 * each preceded by a four-byte length, plus the row's own field-count and message-length overhead.
 * A NULL column is a bare `-1` length and carries no data, which is why `message_id_header`
 * contributes only its overhead when absent.
 *
 * An ESTIMATE, named as one: it is the payload the server puts on the wire for this projection and
 * it ignores TLS framing and protocol messages that are not `DataRow`. It exists to make the
 * before/after comparable, not to be an invoice.
 */
const ROW_OVERHEAD_BYTES = 6;
const FIELD_OVERHEAD_BYTES = 4;

export function estimateWireBytes(rows: ReadonlyArray<KnownLocator>): number {
  let total = 0;
  for (const r of rows) {
    total += ROW_OVERHEAD_BYTES
      + FIELD_OVERHEAD_BYTES + Buffer.byteLength(r.folder, "utf8")
      + FIELD_OVERHEAD_BYTES + String(r.uid).length
      + FIELD_OVERHEAD_BYTES + r.uidValidity.length
      + FIELD_OVERHEAD_BYTES + (r.messageId === null ? 0 : Buffer.byteLength(r.messageId, "utf8"))
      // `observed_seen` and `unread`, one byte each — the projection selects both and
      // `KnownLocator.seen` is the coalesce of them.
      + FIELD_OVERHEAD_BYTES + 1
      + FIELD_OVERHEAD_BYTES + 1;
  }
  return total;
}

/**
 * The repo methods that CANNOT move what `listKnownLocators` projects.
 *
 * Everything absent from this set drops the memo — see the header. Each entry is here because it
 * writes a different table, or a column this projection does not read:
 *
 *  · pure reads — they write nothing at all;
 *  · `mailbox_folders` (`upsertMailboxFolder`), `message_failures` (`recordMessageFailure`,
 *    `claimMessageFailures`, `resolveMessageFailure`), `audit_log`, `change_log`, `threads`,
 *    `routing_decisions`, `approvals`, `contacts`, `message_bodies`, `attachments` — different
 *    tables entirely;
 *  · `upsertFolderState` / `setFolderConflict` / `deferFolderReconcile` — `folder_state`, which
 *    this projection does not join;
 *  · `deferFlagReconcile` — `flag_state`, but only `attempts` and `next_attempt_at`; it is the one
 *    statement in the file that deliberately does NOT touch `observed_seen`;
 *  · `setMessageThread` / `upgradeDedupKey` — `messages`, but `thread_id` and `dedup_key`, neither
 *    of which is projected. `unread` and `message_id_header` are the only projected columns of that
 *    table and neither is written here.
 *
 * `transaction` is neutral and special: it is a pass-through whose callback repo is wrapped in
 * turn, so writes inside a transaction are classified exactly as writes outside one.
 */
export const KNOWN_SET_NEUTRAL: ReadonlySet<string> = new Set([
  // reads
  "findByDedupKey", "findByMessageIdHeader", "listMessageFailures", "primaryInstanceVanished",
  "getFolderState", "listRules", "knownSenders", "findThreadParent", "listThreadBacklog",
  "isGraduated", "getMailbox", "listScreenerBacklog", "getMailboxFolders", "listKnownLocators",
  "listPendingFolderStates", "listPendingFlagStates",
  // the mail-0065 junk/delete wave's reads — special-folder discovery, the AI-authored
  // quarantine probe, and the junk-restore pass's candidate read (bodies joined to instances,
  // projecting nothing new). These landed UNCLASSIFIED and the guard suite was red in HEAD from
  // that wave until the 0071 slice ran it again — the dirty-by-default rule did its job late.
  "getMailboxSpecialFolders", "listAiAutoAppliedQuarantine", "listJunkFiledHusks",
  // writes to tables this projection does not read
  "markKickstarted", "upsertContacts", "upsertMailboxFolder", "recordMessageFailure",
  "claimMessageFailures", "resolveMessageFailure", "upgradeDedupKey", "insertMessageBody",
  "insertAttachments", "upsertFolderState", "setFolderConflict", "deferFolderReconcile",
  "deferFlagReconcile", "recordAudit", "recordAuditMany", "recordChange", "upsertThread",
  "mergeThreadMessage", "setMessageThread", "recordRoutingDecision", "enqueueApproval",
  // the mail-0065 wave's writes, none of which touch a projected field (the projection is
  // message_instances + messages.unread/message_id_header + flag_state.observed_seen):
  //  · setMailboxSpecialFolders — mailboxes.junk_folder/trash_folder, a discovery stamp
  //  · huskBody / restoreWithheldBody — message_bodies + the storage counter
  //  · clearDeletedOnAdopt / tombstoneInstanceless — messages.deleted_at (+ husk + change_log);
  //    a tombstoned row is by definition INSTANCELESS, so no instance row can be moved by it
  "setMailboxSpecialFolders", "huskBody", "restoreWithheldBody",
  "clearDeletedOnAdopt", "tombstoneInstanceless",
  // the junk-restore rewrite: message_bodies + messages.snippet/updated_at + one change_log row —
  // never a locator, never an instance, so it cannot move the projection. It runs on every cycle
  // that finds a candidate, which is exactly why it must be named here: unclassified it would
  // drop the memo once per restore and re-read listKnownLocators for the whole mailbox.
  "unhuskJunkFiledBody",
  // the pass-through
  "transaction",
]);

/**
 * ONE mailbox's memoized known-set. Built where {@link DeadLetterLedger} is built and for the same
 * reason: it is per-attachment state, and its lifetime IS the design.
 *
 * ABSENT from `SyncDeps` ⇒ byte-identical to before this file existed — every cycle re-reads.
 * Tests, the reconcile backstop and any caller that has not thought about leadership get exactly
 * the old behaviour, which is the direction an omission must fail in.
 */
export class KnownSetCache {
  /** The mailbox this memo belongs to. A read for any other mailbox goes to the database. */
  readonly mailboxId: string;

  private entries: ReadonlyArray<KnownLocator> | null = null;
  private lastRows = 0;
  private lastBytes = 0;
  private bytesSaved = 0;
  private droppedBy: string | null = null;
  private cycleReads = 0;
  private cycleHits = 0;

  constructor(mailboxId: string) {
    this.mailboxId = mailboxId;
  }

  /** Called once at the top of every cycle, so the census below is per cycle. */
  beginCycle(): void {
    this.cycleReads = 0;
    this.cycleHits = 0;
  }

  /** Whether the memo currently holds a set. Read by the guards, not by the loop. */
  get warm(): boolean { return this.entries !== null; }

  /**
   * Drop the memo. Idempotent, and called EAGERLY — before the write that motivated it, and on
   * every leadership-relevant event.
   *
   * `why` is recorded rather than logged here: this runs on the write path and a log line per
   * write would be noise. It reaches the operator through the census on the next database read,
   * which is the moment the drop actually cost something.
   */
  drop(why: string): void {
    if (this.entries !== null) this.droppedBy = why;
    this.entries = null;
  }

  /**
   * The read. Serves the memo when it is warm and the mailbox matches; otherwise reads through and
   * remembers.
   *
   * The mailbox check is not defensive decoration — `SyncDeps.repo` is ONE object shared by every
   * mailbox this worker serves, so a cache handed to the wrong runtime must answer with the
   * database rather than with another mailbox's UIDs. Getting that wrong would let one account's
   * IMAP server decide what another account's sync loop treats as already-known, which is the
   * boundary every mailbox-scoped statement in `drizzle-repo.ts` exists to hold.
   */
  async list(
    read: (mailboxId: string) => Promise<KnownLocator[]>, mailboxId: string,
  ): Promise<KnownLocator[]> {
    if (mailboxId !== this.mailboxId) return read(mailboxId);
    if (this.entries !== null) {
      this.cycleHits++;
      this.bytesSaved += this.lastBytes;
      // A COPY, because the caller owns what it is handed. `buildCursor` only reads, but a memo
      // that hands out its own array makes any future caller's mutation permanent and invisible.
      return [...this.entries];
    }
    const rows = await read(mailboxId);
    this.entries = [...rows];
    this.lastRows = rows.length;
    this.lastBytes = estimateWireBytes(rows);
    this.cycleReads++;
    return rows;
  }

  census(): KnownSetCensus {
    return {
      dbReads: this.cycleReads,
      hits: this.cycleHits,
      rows: this.lastRows,
      bytes: this.lastBytes,
      bytesSaved: this.bytesSaved,
      droppedBy: this.droppedBy,
    };
  }
}

/**
 * Return `repo` with the known-set memo wired into it: `listKnownLocators` served from the memo,
 * every method that could move the projection dropping it first.
 *
 * A `Proxy` and not a hand-written façade, because `WorkerRepo` is ~45 methods and a façade is a
 * list that stops covering the one somebody adds next. The proxy also carries the classification,
 * so the method somebody adds next is DIRTY until it is named neutral — and the suite's
 * classification guard, which names the dirty methods exactly, fails until somebody decides which
 * it is.
 *
 * `transaction` is wrapped rather than passed through: the repo it hands its callback is a fresh
 * `DrizzleRepo` over the transaction's connection, so without this the ingest and reconcile groups
 * — which is where nearly every write in `sync.ts` happens — would write straight past the memo.
 */
export function watchKnownSet<T extends object>(repo: T, cache: KnownSetCache): T {
  return new Proxy(repo, {
    get(obj, prop): unknown {
      const value = Reflect.get(obj, prop);
      if (typeof value !== "function" || typeof prop !== "string") return value;

      if (prop === "transaction") {
        return (fn: (r: object) => unknown, ...rest: unknown[]): unknown =>
          (value as (...a: unknown[]) => unknown).call(
            obj, (r: object) => fn(watchKnownSet(r, cache)), ...rest,
          );
      }

      if (prop === "listKnownLocators") {
        return (mailboxId: string): unknown => cache.list(
          (id) => (value as (id: string) => Promise<KnownLocator[]>).call(obj, id), mailboxId,
        );
      }

      if (KNOWN_SET_NEUTRAL.has(prop)) {
        return (...args: unknown[]): unknown => (value as (...a: unknown[]) => unknown).apply(obj, args);
      }

      // DIRTY, and dropped BEFORE the call — see the header on why eager is the safe order.
      return (...args: unknown[]): unknown => {
        cache.drop(prop);
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

/** The repo methods that are NOT neutral — the classification, exported so a guard can assert it. */
export function dirtyMethodsOf(proto: object): string[] {
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== "constructor")
    .filter((n) => typeof (proto as Record<string, unknown>)[n] === "function")
    .filter((n) => !KNOWN_SET_NEUTRAL.has(n))
    .sort();
}

export type { KnownLocator, WorkerRepo };
