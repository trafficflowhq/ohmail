import type { KnownLocator, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/**
 * THE KNOWN-SET, HELD IN MEMORY FOR AS LONG AS NOTHING COULD HAVE CHANGED IT. `buildCursor` reads
 * `listKnownLocators(mailboxId)` (the whole mailbox) every cycle to decide which UIDs the adapter need not
 * re-fetch — thousands of rows re-read, paid for by the row on a hosted install. An in-process copy is
 * sound on three legs read in code: exactly one process organizes a mailbox (the `ohmail/_meta` lease
 * `index.ts#mayOrganize`, the fence `sync.ts#SyncWriteFence`/`mailboxes.ts#makeSyncWriteFence`); every
 * writer of the projection (`message_instances`, mail 0028 — `insertMessage`/`setPrimaryInstance`,
 * `recordInstance`, `updateLocator`, `forgetInstanceAt`; the `observed_seen ?? !messages.unread` baseline)
 * is in-process, and the API's `messages.unread` writes cannot move it; leadership changes are explicit.
 * It is a MEMO — a write DROPS it (eagerly, before the write) and the next cycle re-reads. Dirty-by-default: {@link KNOWN_SET_NEUTRAL} names what cannot move it, everything else drops. */

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
 * The `DataRow` width of one projected row, as postgres.js receives it in TEXT mode. Six columns —
 * `folder`, `uid`, `uidvalidity`, `message_id_header`, `observed_seen`, `unread` — each preceded by a
 * four-byte length, plus the row's field-count and message-length overhead. A NULL column is a bare `-1`
 * length with no data, which is why `message_id_header` contributes only overhead when absent. An
 * ESTIMATE: the payload the server puts on the wire for this projection, ignoring TLS framing and
 * non-`DataRow` protocol messages — it makes the before/after comparable, not an invoice.
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
 * The repo methods that CANNOT move what `listKnownLocators` projects. Everything absent drops the memo.
 * Each entry writes a different table or an unprojected column: pure reads; `mailbox_folders`,
 * `message_failures`, `audit_log`, `change_log`, `threads`, `routing_decisions`, `approvals`, `contacts`,
 * `message_bodies`, `attachments`, `learning_signals`/`graduations`/`rules` — different tables;
 * `upsertFolderState`/`completeFolderState`/`setFolderConflict`/`deferFolderReconcile` — `folder_state`,
 * not joined (`completeFolderState` is on the reconciler's hot path, so it MUST be named or every filing
 * drops the memo); `deferFlagReconcile` — `flag_state` but only `attempts`/`next_attempt_at`, never
 * `observed_seen`; `setMessageThread`/`upgradeDedupKey` — `messages` but `thread_id`/`dedup_key`, not
 * projected. `transaction` is neutral and special: a pass-through whose callback repo is wrapped in turn. */
export const KNOWN_SET_NEUTRAL: ReadonlySet<string> = new Set([
  // reads
  "findByDedupKey", "findByMessageIdHeader", "listMessageFailures", "primaryInstanceVanished",
  "getFolderState", "listRules", "knownSenders", "findThreadParent", "listThreadBacklog",
  // `away_replies`, one column, `LIMIT 1` — a table this projection does not join at all.
  "isOwnAwayReply",
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
  "insertAttachments", "upsertFolderState", "completeFolderState", "setFolderConflict",
  "deferFolderReconcile",
  "deferFlagReconcile", "recordAudit", "recordAuditMany", "recordChange", "upsertThread",
  /* `upsertThread`'s device arm — the same rows, the same reason. It is a separate method rather
     than a branch inside one because the two stores answer "did this insert the row" by different
     mechanisms, not by different spellings; classified here so a reader does not have to find that
     out to know it moves no locator. */
  "upsertThreadOnDeviceStore",
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
  // the folder-op pass's NARROW half (mail 0074): the pending-command read, the create's
  // completion (folder_ops + mailbox_folders.updated_at + change_log), the failure/deferral
  // stamps, the subtree read. None of these touches an instance row or a projected column.
  // `applyFolderRename` and `tombstoneFolderMessages` are DELIBERATELY ABSENT: the first
  // re-spells `message_instances.folder` for a whole subtree and the second deletes instance
  // rows — both move exactly what this projection remembers, so they must drop the memo.
  "listFolderOps", "completeFolderCreate", "failFolderOp", "deferFolderOp", "listFolderSubtree",
  // `removeFolderRow` — mailbox_folders + one change row: the folder's INSTANCES were already
  // dropped by `tombstoneFolderMessages` (dirty, above the projection) before any row removal.
  "removeFolderRow",
  // the thread-join heal's serialization lock (erasure vs. backfill): one
  // pg_advisory_xact_lock, no row written anywhere — a lock cannot move a projection. It
  // landed UNCLASSIFIED and the guard suite sat red in HEAD for a day, the third time the
  // dirty-by-default rule did its job late; classified at the 0.12.0 release gate.
  "lockAccountThreadStructure",
  // the route-override seam's predicate: it READS `messages.from_address` and writes
  // `learning_signals`, the `graduations` counters and `rules.enabled/demotions` — three tables
  // this projection does not touch, and neither projected `messages` column (`unread`,
  // `message_id_header`) is written by it. It sits on the ingest path's `adopt_external` arm,
  // inside the fenced transaction whose repo IS the watched one, so it runs on every externally
  // observed move: unclassified it would drop the memo once per adoption and re-read the whole
  // mailbox's locators.
  "recordExternalOverride",
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

  /** Lazily-built membership index over the warm entries — see {@link coversInstance}. */
  private tupleIndex: Set<string> | null = null;

  /**
   * Whether the warm memo already projects the tuple a `recordInstance(messageId, locator)` names — the
   * value question behind that method's value-dependent neutrality. `recordInstance` is an upsert whose
   * conflict arm updates ONLY `last_seen_at`, and only for the same message (`setWhere`, the
   * anti-re-attribution guard), so no projected column moves on conflict. When the tuple is already IN the
   * projection the write is a timestamp touch and the memo may survive; when it is not, the insert arm
   * adds a projected row and the memo must drop. The memo IS the projection while warm, so membership
   * answers exactly; a cold memo answers `false` (the drop path). This stops a `duplicate` re-assertion
   * from costing a full re-read every cycle — the `droppedBy="updateLocator"`/`recordInstance` storm
   * measured on a Sent folder of byte-twin copies. */
  coversInstance(locator: { folder: string; ref: string } | null | undefined): boolean {
    if (this.entries === null) return false;
    // A shape this cannot read is an UNKNOWN, and an unknown takes the drop path — never the
    // keep path. `typeof` rather than trusting the annotation, because this is called from a
    // Proxy over `unknown[]` arguments.
    if (typeof locator?.ref !== "string" || typeof locator.folder !== "string") return false;
    const sep = locator.ref.indexOf(":");
    if (sep <= 0) return false;
    if (this.tupleIndex === null) {
      const idx = new Set<string>();
      // `\u0000` as the folder/epoch separator — WRITTEN AS AN ESCAPE, never as a raw byte: a
      // literal NUL in source makes `file` classify this module as data and the repository's
      // grep tooling silently skip the whole file (the CLAUDE.md trap, and a review caught this
      // very line carrying the raw byte). The value itself is right because no IMAP folder name
      // can contain NUL, so the key cannot collide with a folder that merely contains spaces.
      for (const e of this.entries) idx.add(`${e.folder}\u0000${e.uidValidity}:${e.uid}`);
      this.tupleIndex = idx;
    }
    return this.tupleIndex.has(
      `${locator.folder}\u0000${locator.ref.slice(0, sep)}:${locator.ref.slice(sep + 1)}`,
    );
  }

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
    this.tupleIndex = null;
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
    this.tupleIndex = null;
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
 * Return `repo` with the known-set memo wired in: `listKnownLocators` served from the memo, every method
 * that could move the projection dropping it first. A `Proxy`, not a hand-written façade, because
 * `WorkerRepo` is ~45 methods and a façade stops covering the one somebody adds next; the proxy carries
 * the classification, so a new method is DIRTY until named neutral, and the suite's classification guard
 * fails until somebody decides which it is. `transaction` is wrapped rather than passed through: the repo
 * it hands its callback is a fresh `DrizzleRepo` over the transaction's connection, so without this the
 * ingest and reconcile groups — nearly every write in `sync.ts` — would write straight past the memo.
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

      // `recordInstance` is neutral BY VALUE, not by name: its conflict arm is a `last_seen_at`
      // touch that cannot move the projection, and the memo itself can tell the two arms apart —
      // a tuple it already projects can only take the conflict arm. See
      // {@link KnownSetCache.coversInstance} for the argument; an unparseable or unknown tuple
      // falls through to the drop, the safe direction. Without this, every re-observation of an
      // already-recorded copy (a `duplicate` re-assertion on a folder mid-first-scan) dropped the
      // memo once per cycle and re-read the whole mailbox's locators — 884 KB per visit, measured.
      if (prop === "recordInstance") {
        return (messageId: string, locator: { folder: string; ref: string }): unknown => {
          if (!cache.coversInstance(locator)) cache.drop(prop);
          return (value as (m: string, l: unknown) => unknown).call(obj, messageId, locator);
        };
      }

      // DIRTY, and dropped BEFORE the call — see the header on why eager is the safe order.
      return (...args: unknown[]): unknown => {
        cache.drop(prop);
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

/**
 * The repo methods that are NOT neutral — the classification, exported so a guard can assert it. READ
 * THROUGH THE DESCRIPTOR, never by indexing the prototype: `typeof proto[n]` INVOKES an accessor with
 * `this` bound to the prototype, and the repository has one (`d`, resolving the dialect from its handle),
 * so reading off the prototype ran that resolution against a non-existent `db` and threw — the
 * classification could not be computed and the guard failed with a message about dialect brands in a test
 * about the known-set memo. A descriptor also gives the right ANSWER: an accessor is not a method, so it
 * has no business in a list of methods that might move the projection.
 */
export function dirtyMethodsOf(proto: object): string[] {
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== "constructor")
    .filter((n) => typeof Object.getOwnPropertyDescriptor(proto, n)?.value === "function")
    .filter((n) => !KNOWN_SET_NEUTRAL.has(n))
    .sort();
}

export type { KnownLocator, WorkerRepo };
