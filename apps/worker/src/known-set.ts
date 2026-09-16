import type { KnownEntry } from "@trafficflow/core/adapters/imap-types";
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
  /** Heap bytes this memo is charged against the process budget, 0 when it holds nothing. */
  retainedBytes: number;
  /** Heap bytes every memo in this process is charged, and the budget they share. */
  processRetainedBytes: number;
  processBudgetBytes: number;
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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE BUDGET EVERY LOCATOR MEMO IN THIS PROCESS SHARES
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What this process retains has to grow with the WORK, not with the roster. A memo per attachment
 * with no eviction makes the ceiling the number of mailboxes served: on the rig's synthetic
 * projections (`test/rigs/known-set-peak-rig.mjs`, heap read at the peak with every memo warm) the
 * retained figure was flatly linear in the attachment count — 128 MiB at four, 1 022 MiB at
 * thirty-two — and a full roster wanted several times the whole heap.
 *
 * THE ARITHMETIC, so the next heap change is a decision and not a surprise:
 *   heap        512 MiB   `apps/worker/Dockerfile` and `Dockerfile.selfhost` (`--max-old-space-size`)
 *   budget      128 MiB   a QUARTER of it — the rest is the scan window, the adapter's fetch
 *                         buffers, the dead-letter ledgers, the postgres pool and the runtime
 *   entry         374 B   one remembered locator, index included — CHARGED; the same entry
 *                         measured 360 bytes against rows a real Postgres minted, so the charge
 *                         sits about 4% above what the heap actually holds
 *   so the budget holds about three hundred and sixty thousand remembered locators IN TOTAL, over
 *   however many mailboxes are attached: the sixty-fifth costs what the fifth costs, which is the
 *   property the per-attachment version lacked.
 * A heap that moves without this fraction moving reddens `known-set-budget.test.ts`, which reads
 * both Dockerfiles: the ceiling is a deploy setting and is asserted where it is set.
 */
export const WORKER_HEAP_MIB = 512;
/** The budget is this fraction of the heap — a quarter. */
export const KNOWN_SET_BUDGET_DIVISOR = 4;
export const KNOWN_SET_BUDGET_BYTES = (WORKER_HEAP_MIB / KNOWN_SET_BUDGET_DIVISOR) * 1024 * 1024;

/**
 * WHAT ONE REMEMBERED LOCATOR COSTS THE HEAP, charged high rather than exactly.
 *
 * Per entry: the `KnownLocator` object with its five fields and its slot in the entries array, a
 * string header plus characters for every string it holds, and the entry's key in the lazily-built
 * membership index with its slot in that `Set`. The index is charged whether or not it has been
 * built, because the charge is what the memo MAY hold — a budget that admits on the smaller figure
 * and then grows into the index is no budget.
 *
 * Characters are charged at two bytes: a folder name that survives IMAP UTF-7 decoding is two-byte
 * in the runtime, so an ASCII-only mailbox is over-charged for its strings. The per-entry constants
 * go the other way and had to be MEASURED rather than reasoned: against rows the driver itself
 * minted (`test/rigs/known-set-real-rows-rig.mjs`, on a lane database) an entry costs 360 bytes,
 * where the first draft of these constants charged 334 — a budget under-charging by 7% is a bound
 * that is quietly exceeded, so they were raised until the charge sits ABOVE the measurement with
 * room. Synthetic rows read lower than real ones; the real figure is the one that governs.
 */
const LOCATOR_OBJECT_BYTES = 128;
const STRING_HEADER_BYTES = 16;
const BYTES_PER_CHAR = 2;
const INDEX_SLOT_BYTES = 24;

export function estimateRetainedBytes(rows: ReadonlyArray<KnownLocator>): number {
  let total = 0;
  for (const r of rows) {
    const uidDigits = String(r.uid).length;
    total += LOCATOR_OBJECT_BYTES
      + STRING_HEADER_BYTES + BYTES_PER_CHAR * r.folder.length
      + STRING_HEADER_BYTES + BYTES_PER_CHAR * r.uidValidity.length
      + (r.messageId === null ? 0 : STRING_HEADER_BYTES + BYTES_PER_CHAR * r.messageId.length)
      // the membership key `folder<NUL>uidValidity:uid` and its slot in the index Set
      + STRING_HEADER_BYTES + BYTES_PER_CHAR * (r.folder.length + r.uidValidity.length + uidDigits + 2)
      + INDEX_SLOT_BYTES;
  }
  return total;
}

/**
 * The byte budget the process's locator memos share, least-recently-used across MAILBOXES.
 *
 * EVICTION HAPPENS ON INSERTION — inside {@link KnownSetCache.list}, at the moment a memo takes a
 * projection, never at the end of a cycle or a pass. A bound enforced at the end of a multi-mailbox
 * pass is no bound during one, and "during one" is where this process meets its heap ceiling.
 *
 * `charged` is a `Map`, so its iteration order is insertion order and the first key is the least
 * recently used; a hit re-inserts (see {@link touch}). Holding the caches strongly is sound because
 * `drop()` releases and every path that retires a runtime drops first — detach, the lock-loss
 * tripwire, promotion and every stand-down (`index.ts`). A runtime removed without a drop would
 * pin its projection here, which is why that door is single and asserted.
 */
export class KnownSetBudget {
  private readonly charged = new Map<KnownSetCache, number>();
  private total = 0;

  constructor(readonly limitBytes: number) {}

  /** Heap bytes currently charged across every memo in this process. */
  get chargedBytes(): number { return this.total; }
  /** How many memos hold a projection right now. */
  get warmCount(): number { return this.charged.size; }

  /** A hit makes this memo the most recently used: delete and re-insert moves it to the end. */
  touch(cache: KnownSetCache): void {
    const bytes = this.charged.get(cache);
    if (bytes === undefined) return;
    this.charged.delete(cache);
    this.charged.set(cache, bytes);
  }

  /**
   * Charge `bytes` for `cache`, evicting the least recently used memos until the total fits.
   * Answers whether the memo may keep its projection at all: a single mailbox whose projection
   * exceeds the WHOLE budget is served cold for ever rather than admitted and then evicting
   * everybody else — one mailbox may not spend the process's memory on itself.
   */
  admit(cache: KnownSetCache, bytes: number): boolean {
    this.release(cache);
    if (bytes > this.limitBytes) return false;
    for (const victim of this.charged.keys()) {
      if (this.total + bytes <= this.limitBytes) break;
      // `drop` calls back into `release`, which is what removes the entry and the bytes. Deleting
      // the entry the iterator is on is defined behaviour for a Map iterator.
      victim.drop("evicted: the process locator budget");
    }
    this.charged.set(cache, bytes);
    this.total += bytes;
    return true;
  }

  /** Give back whatever `cache` was charged. Idempotent — `drop` is. */
  release(cache: KnownSetCache): void {
    const bytes = this.charged.get(cache);
    if (bytes === undefined) return;
    this.charged.delete(cache);
    this.total -= bytes;
  }
}

/**
 * The one budget this worker process's memos share, sized by the arithmetic above. It is the
 * DEFAULT rather than an argument the composition root must remember: a memo built without a
 * budget is bounded, and only a caller that says otherwise (the rig, the suite) is not.
 */
export const processKnownSetBudget = new KnownSetBudget(KNOWN_SET_BUDGET_BYTES);

/**
 * The repo methods that CANNOT move what `listKnownLocators` projects. Everything absent drops the memo.
 * Each entry writes a different table or an unprojected column: pure reads; `mailbox_folders`,
 * `message_failures`, `audit_log`, `change_log`, `threads`, `routing_decisions`, `approvals`, `contacts`,
 * `message_bodies`, `attachments`, `learning_signals`/`graduations`/`rules` — different tables;
 * `upsertFolderState`/`completeFolderState`/`adoptFolderState`/`setFolderConflict`/`deferFolderReconcile` — `folder_state`,
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
  /* `away_sender_state.undeliverable_at` — a write, and a table this projection does not join
     either. It is the away responder's own state about a PERSON; no locator, no flag, no
     `messages` column the memo reads. */
  "markAwayReplyUndeliverable",
  "isGraduated", "getMailbox", "listScreenerBacklog", "getMailboxFolders", "listKnownLocators",
  /* `mailboxes.status` and the erasure stamp beside it, locked for the transaction — the ingest's
     own "is this mailbox still here". A read of a table this projection does not join at all. */
  "mailboxStatusForWrite",
  "listPendingFolderStates", "listPendingFlagStates",
  // the mail-0065 junk/delete wave's reads — special-folder discovery, the AI-authored
  // quarantine probe, and the junk-restore pass's candidate read (bodies joined to instances,
  // projecting nothing new). These landed UNCLASSIFIED and the guard suite was red in HEAD from
  // that wave until the 0071 slice ran it again — the dirty-by-default rule did its job late.
  "getMailboxSpecialFolders", "listAiAutoAppliedQuarantine", "listJunkFiledHusks",
  // writes to tables this projection does not read
  "markKickstarted", "upsertContacts", "upsertMailboxFolder", "recordMessageFailure",
  "claimMessageFailures", "resolveMessageFailure", "upgradeDedupKey", "insertMessageBody",
  "insertAttachments", "upsertFolderState", "completeFolderState", "adoptFolderState",
  "setFolderConflict", "deferFolderReconcile",
  "deferFlagReconcile", "recordAudit", "recordAuditMany", "recordChange",
  /* `recordChanges` is `recordChange` for a list — the same two tables (`change_log` and the
     account's seq counter), neither of them in the projection. Named separately because the list
     is what the ingest now calls; the singular stays for every caller that knows one delta. */
  "recordChanges", "upsertThread",
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
 *
 * BOUNDED ACROSS MAILBOXES, not per mailbox: what it may hold is charged to {@link KnownSetBudget},
 * which evicts the least recently used memo the moment this one takes a projection. Holding one
 * whole projection per attachment made the process's ceiling the ROSTER — see the budget's header
 * for the arithmetic and what it is a quarter of.
 */
export class KnownSetCache {
  /** The mailbox this memo belongs to. A read for any other mailbox goes to the database. */
  readonly mailboxId: string;
  /** The process-wide byte budget this memo competes in. */
  private readonly budget: KnownSetBudget;

  private entries: ReadonlyArray<KnownLocator> | null = null;
  private lastRows = 0;
  private lastBytes = 0;
  private retainedBytes = 0;
  private bytesSaved = 0;
  private droppedBy: string | null = null;
  private cycleReads = 0;
  private cycleHits = 0;
  /**
   * BUMPED WHENEVER THE ENTRIES MOVE — replaced by a read-through, or thrown away by a drop. It is
   * the stamp anything DERIVED from the known set is keyed on, so a derivation can tell "the same
   * locators as last cycle" from "a set I have not seen" without comparing them.
   */
  private gen = 0;
  /**
   * THE CURSOR SHAPE, DERIVED ONCE PER SET — `buildCursor`'s per-folder work, which is
   * mailbox-sized and produced the same arrays every cycle. `byFolder` holds them keyed by
   * `folder\u0000epoch`, so a folder whose epoch moved is rebuilt alone; `rowEpochs` is the epoch
   * each folder's ROW named at the time (`null` for none), the input the resolution was taken
   * from; `resolved` is what each folder resolved to, which for a row naming none is derived FROM
   * the entries — same entries and same rows, same answer. Held against {@link gen}, so a set that
   * moved invalidates all of it at once, and dropped with the entries.
   */
  private shape: {
    gen: number;
    byFolder: Map<string, KnownEntry[]>;
    rowEpochs: Map<string, string | null>;
    resolved: Map<string, string>;
  } | null = null;

  constructor(mailboxId: string, budget: KnownSetBudget = processKnownSetBudget) {
    this.budget = budget;
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
    if (this.entries !== null) { this.droppedBy = why; this.gen += 1; }
    this.entries = null;
    this.tupleIndex = null;
    this.shape = null;
    // Give the bytes back on the SAME line that gives the memory back, so the budget cannot come
    // to believe this process holds a projection nobody holds.
    this.retainedBytes = 0;
    this.budget.release(this);
  }

  /**
   * The per-folder known arrays a previous {@link buildCursor} derived from the CURRENT entries, or
   * `null` when there is no such derivation. A caller reads what it finds and rebuilds the rest —
   * a miss is always safe and always means "do the work".
   */
  derivedFolders(): {
    byFolder: Map<string, KnownEntry[]>;
    rowEpochs: Map<string, string | null>;
    resolved: Map<string, string>;
  } | null {
    return this.shape !== null && this.shape.gen === this.gen ? this.shape : null;
  }

  /** Remember a derivation against the set it was taken from. */
  rememberFolders(
    byFolder: Map<string, KnownEntry[]>,
    rowEpochs: Map<string, string | null>,
    resolved: Map<string, string>,
  ): void {
    this.shape = { gen: this.gen, byFolder, rowEpochs, resolved };
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
   *
   * THIS IS WHERE EVICTION HAPPENS — on the insertion, in the middle of the pass, not at the end
   * of one. `admit` charges what this projection may retain and evicts the least recently used
   * memos of OTHER mailboxes until the process fits its budget; a projection too big for the whole
   * budget is not retained at all and this mailbox reads cold every cycle, which costs one read
   * rather than everybody else's memory.
   */
  async list(
    read: (mailboxId: string) => Promise<KnownLocator[]>, mailboxId: string,
  ): Promise<KnownLocator[]> {
    if (mailboxId !== this.mailboxId) return read(mailboxId);
    if (this.entries !== null) {
      this.cycleHits++;
      this.bytesSaved += this.lastBytes;
      this.budget.touch(this);
      // A COPY, because the caller owns what it is handed. `buildCursor` only reads, but a memo
      // that hands out its own array makes any future caller's mutation permanent and invisible.
      return [...this.entries];
    }
    const rows = await read(mailboxId);
    const wants = estimateRetainedBytes(rows);
    if (this.budget.admit(this, wants)) {
      this.entries = [...rows];
      this.retainedBytes = wants;
    } else {
      this.entries = null;
      this.retainedBytes = 0;
      this.droppedBy = "not admitted: one projection over the whole process locator budget";
    }
    this.tupleIndex = null;
    this.shape = null;
    this.gen += 1;
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
      retainedBytes: this.retainedBytes,
      processRetainedBytes: this.budget.chargedBytes,
      processBudgetBytes: this.budget.limitBytes,
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
