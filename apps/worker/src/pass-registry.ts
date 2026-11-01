/**
 * THE WORKER PASS REGISTRY — every pass, heal, backfill, retro and sweep this deployment runs, in one
 * table. The worker accumulated its maintenance work one invariant at a time (each module owns and
 * documents one), but the SET existed nowhere — answering "what runs, when, under which lock, at what wake
 * cost?" meant reading `index.ts`'s tail, `sync.ts`'s visit, four cron entries and nine CLIs. The next
 * pass-touching change starts HERE and adds its row in the same commit; `test/pass-registry.test.ts` fails
 * the build on an unregistered pass and cross-checks each row against the source it names (so a row cannot
 * outlive its pass). A MAP, not a scheduler: nothing imports it at runtime. Triggers: `visit`, `attach`,
 * `cycle-tail`, `interval`, `post-cycle` (queued onto the serialized queue, never beside its cycle),
 * `wake-driven`, `cron-backstop` (a separate CLI, lock-refused while healthy), `cli`, `sidecar-drain` (the desktop engine runs the SAME module — one implementation per invariant). The WAKE PATH is not a pass and is not in the table. */

export type PassTrigger =
  | "visit"
  | "attach"
  | "cycle-tail"
  | "interval"
  | "post-cycle"
  | "wake-driven"
  | "cron-backstop"
  | "cli"
  | "sidecar-drain";

export interface WorkerPass {
  /** The stable name, spelled the way the pass's log events spell it. */
  name: string;
  /** Repo-rooted module path holding the entry (the census reads this file). */
  module: string;
  /** The exported entry the trigger calls (the census greps the module for it). */
  entry: string;
  triggers: readonly PassTrigger[];
  /** The operator CLI file(s) under apps/worker/src that run this pass, when any. */
  cli?: readonly string[];
  /** When it runs — the gate, interval or command, human-stated. */
  cadence: string;
  /** Its bound per run — the reason it cannot eat the wake path. */
  budget: string;
  /** The ONE invariant this pass owns. */
  owns: string;
  /** The lock/fence discipline it runs under. */
  fence: string;
}

const W = "apps/worker/src";
const DB = "packages/db/src";
const CORE = "packages/core/src";

export const WORKER_PASSES: readonly WorkerPass[] = [
  /* ── IN-VISIT (the mailbox's own connection, inside the sync write fence) ────────────── */
  {
    name: "folder_ops",
    module: `${W}/folder-ops.ts`, entry: "folderOpsPass",
    triggers: ["visit"],
    cadence: "every visit, before the change scan — pending user folder create/rename/delete ops",
    budget: "FOLDER_OP_MAX_ATTEMPTS per op; deletes tombstone FOLDER_DELETE_TOMBSTONE_CHUNK rows × FOLDER_DELETE_CHUNKS_PER_CYCLE",
    owns: "user folder operations reach the real mailbox exactly once, refusals stated per op",
    fence: "the visit's leased adapter + sync write fence",
  },
  {
    name: "junk_rescue",
    module: `${W}/junk-rescue.ts`, entry: "junkRescuePass",
    // "visit" alone, and that IS the dual-mode claim rather than a narrowing of it: the pass runs
    // inside `runSyncCycle`, which the desktop engine imports as `@trafficflow/worker/sync` — one
    // implementation per invariant, reached by every composition that syncs. `sidecar-drain` names
    // a pass the engine calls SEPARATELY, and this is not one.
    triggers: ["visit"],
    cadence: "command-driven: a \"not junk\" press records a junk_rescues row; every visit works the due ones off, before the change scan so the same cycle ingests the arrival",
    budget: "JUNK_RESCUES_PER_CYCLE per visit, one move each; JUNK_RESCUE_MAX_ATTEMPTS then the row answers `refused`",
    owns: "a queued \"not junk\" reaches the real mailbox exactly once, and the API never opens IMAP to apply it",
    fence: "the visit's leased adapter + a fresh organizer-lease read before every move; every row write through the fenced group",
  },
  {
    name: "news_fold",
    module: `${W}/news-fold.ts`, entry: "newsFoldPass",
    // "visit": inside `runSyncCycle`, which the desktop and phone engines import too.
    triggers: ["visit"],
    cadence: "every organizer visit whose last LIST named the legacy Reads folder beside ohmail/News, before the change scan; "
      + "a fold that moved nothing and could not delete waits for a LIST stating letters there, or the next attach",
    budget: "one MOVE 1:*, one EXAMINE, at most one DELETE and one LIST per visit",
    owns: "letters in the legacy Reads folder beside News reach News, the folder ensureFolders' merge would otherwise sweep only at attach",
    fence: "the visit's leased adapter, the lease asked before the fold; the same lease-only door as ensureFolders; a reader folds nothing",
  },
  {
    name: "news_repair",
    module: `${W}/news-repair.ts`, entry: "legacyNewsRepairPass",
    // "visit": inside `runSyncCycle`, which the desktop and phone engines import too.
    triggers: ["visit"],
    cadence: "every organizer visit, before the filing and the cursor, until the store holds no pre-0.22 News spelling; "
      + "once clean, checked again only after the next attach (a rename or merge there re-arms it)",
    budget: "database only: one bounded chunk (LEGACY_NEWS_REPAIR_PER_VISIT) and its audit rows per visit, no IMAP command",
    owns: "a pre-0.22 store's old-spelling News locators, instances and folder_state spellings re-pointed onto the News copies "
      + "a re-read recorded; a letter with no live copy kept and marked missing on the server",
    fence: "the visit's fenced group: the chunk and its audit rows commit together; a reader repairs nothing",
  },
  {
    name: "junk_restore",
    module: `${W}/junk-restore.ts`, entry: "junkRestorePass",
    triggers: ["visit"],
    cadence: "at the visit's tail, only when the cycle deferred nothing",
    budget: "JUNK_RESTORE_MAX_PAGES / JUNK_RESTORE_FETCHES_PER_CYCLE / JUNK_RESTORE_MAX_BYTES per visit",
    owns: "a junk-filed husk whose message is alive again in a watched folder gets its body back",
    fence: "the visit's leased adapter; writes through the fenced group",
  },
  {
    name: "junk_gone",
    module: `${W}/junk-gone.ts`, entry: "junkGonePass",
    triggers: ["visit"],
    cadence: "at the visit's tail beside junk_restore, only when the cycle deferred nothing; skipped while the Junk folder's keys equal the last proof",
    budget: "one STATUS (or the pass's LIST-STATUS) and bounded UID SEARCHes over one page of JUNK_GONE_PAGE rows per visit",
    owns: "a letter ohmail filed into Junk that another client deleted there is tombstoned",
    fence: "the visit's leased adapter, read-only; writes through the fenced group",
  },
  {
    name: "storage_refill",
    module: `${W}/storage-refill.ts`, entry: "storageRefillPass",
    triggers: ["visit"],
    cadence: "at the visit's tail after junk_gone, only when the cycle deferred nothing; a mailbox at most every REFILL_EVERY_MS, "
      + "on a numeric cap with room under the trim's mark, while no mailbox of the account is erasing or on its first import",
    budget: "REFILL_FETCHES_PER_RUN letters, REFILL_RUN_BUDGET_MS and REFILL_MAX_PAGES pages per run; REFILL_BYTES_PER_DAY raw bytes "
      + "per mailbox per rolling day; REFILL_MAX_BYTES per letter",
    owns: "letters whose text the trim emptied for space get it back from the mail server, newest first, while the counter stays "
      + "at or under nine tenths of the cap",
    fence: "the visit's leased adapter, read-only (BODY.PEEK); each rewrite and the recount through the fenced group, the counter "
      + "row locked before the room is read",
  },
  {
    name: "blank_repair",
    module: `${W}/blank-repair.ts`, entry: "blankRepairPass",
    // "visit" is every door that runs `runSyncCycle`: the worker, the reconcile backstop, and the
    // desktop and phone engines, which import it as `@trafficflow/worker/sync` (junk_rescue's
    // reasoning). Each composition hands the cycle its one OHMAIL_BLANK_REPAIR mode
    // (`sync-role-census.test.ts`).
    triggers: ["visit", "cli"], cli: ["run-blank-repair.ts"],
    cadence: "at the visit's tail, only when the cycle deferred nothing; OHMAIL_BLANK_REPAIR off | dry | apply (unset: apply)",
    budget: "BLANK_REPAIR_PLACES_PER_VISIT places per visit, each downloaded at most once per process under "
      + "BLANK_REPAIR_MAX_BYTES; a place left unread, deferred or with a failed move waits "
      + "BLANK_REPAIR_RETRY_BASE_MS, doubling to BLANK_REPAIR_RETRY_MAX_MS",
    owns: "a blank message an older build stored in a letter's place gives the place back, and a letter its move filed away returns to INBOX",
    fence: "the visit's leased adapter, the lease asked before the one move; writes through the fenced group; a reader moves nothing",
  },
  {
    name: "own_mail_release",
    module: `${DB}/own-mail.ts`, entry: "releaseOwnMailAtGate",
    // Called through the visit's repo (`WorkerRepo.releaseOwnMailAtGate`); the desktop engine runs
    // the same visit, so both doors release.
    triggers: ["visit"],
    cadence: "every organizer visit, before the reconcile; a no-op once nothing of the account's own sits at the gate",
    budget: "OWN_MAIL_RELEASE_BATCH rows per visit",
    owns: "own-address mail a router (this install's or the previous organizer's) filed into ohmail/Screener before it stopped doing so goes back to INBOX, once",
    fence: "the fenced live group (desired-state only); the visit's reconcile makes the moves under the lease",
  },
  {
    name: "junk_sweep",
    module: `${W}/junk-sweep.ts`, entry: "junkSweepPass",
    triggers: ["visit", "cli"], cli: ["run-junk-sweep.ts"],
    cadence: "command-driven: a user press stamps mailboxes.junk_sweep_requested_at; the visit works it off",
    budget: "one bounded keyset window per cycle (JUNK_SWEEP_PER_CYCLE), scan state carried across cycles",
    owns: "the one-time Quarantine→native-Junk migration a mailbox's owner pressed for",
    // This line USED TO SAY the CLI takes the mailbox's own lease, and the CLI did not: it moved mail with
    // no lease acquired or rechecked. A registry that answers wrongly is worse than one that leaves it open,
    // because a reader stops looking. It is true now — the runner takes a `LeasePermit` under `--execute`
    // and re-verifies it at every chunk — and the two fences are named separately (the leader fence is
    // worker-to-worker, the organizer lease is install-to-install). AND THE PRECONDITION, added 2026-09-01:
    // the permit alone is not what makes it safe for this CLI to wear the always-on worker's install id —
    // without the live-twin check the gate reads the running worker's own claim as this process's, adopts
    // the mailbox and expunges it. The check has to happen FIRST, so it is named first.
    fence: "visit: the leased adapter + fenced writes + a fresh leader read per chunk; CLI: a "
      + "live-twin refusal (`assertNoLiveTwin`) BEFORE the gate, then an organizer-lease permit "
      + "re-verified per chunk and before every individual move, and the same per-chunk desire "
      + "re-read both get",
  },
  {
    name: "sensitive_fp_backfill",
    module: `${W}/sensitive-backfill.ts`, entry: "sensitiveBackfillPass",
    triggers: ["visit"],
    cadence: "after a SUCCESSFUL sync, until the per-mailbox completion marker is written",
    budget: "SENSITIVE_FP_BATCH / SENSITIVE_FP_FETCHES_PER_CYCLE / SENSITIVE_FP_MAX_PAGES / SENSITIVE_FP_MAX_BYTES",
    owns: "bodies a sensitivity false-positive redacted are re-read and restored",
    fence: "shares the visit's connection; a failure never counts toward the mailbox's failure budget",
  },
  {
    name: "search_index_backfill",
    module: `${CORE}/message-search.ts`, entry: "searchIndexBackfillPass",
    // The SAME module the desktop engine's composition imports from `@trafficflow/core/mail`,
    // gated there on idle and power; here it runs in the cycle tail.
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, for this shard's accounts with living mail and no account_settings.search_index_built_at, or one older than "
      + "SEARCH_DOCUMENT_SHAPE_AT — synced or not, parked or not",
    budget: "SEARCH_INDEX_ACCOUNTS_PER_TAIL accounts × SEARCH_INDEX_ROUNDS_PER_CYCLE rounds × SEARCH_INDEX_BATCH rows, one transaction per round",
    owns: "every living message has its search document in the present shape (an older document of a letter with a file name gets its head again without "
      + "the names, the names whole and in parts appended to its text, and the substring corpus with the names behind its mark), from the store alone (no mailbox read)",
    fence: "store-only — no adapter, no lease; the document's FK refuses a row whose message is gone, and a failure is logged and never fails the tail",
  },
  {
    name: "html_words_backfill",
    module: `${W}/html-words-backfill.ts`, entry: "htmlWordsBackfillPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "every cycle tail, for this shard's accounts with living mail and no account_settings.html_words_backfill_at; on a device, an idle round on power",
    budget: "HTML_WORDS_ACCOUNTS_PER_TAIL accounts × one page of HTML_WORDS_SCAN_ROWS rows under the tail slice; a device round HTML_WORDS_LOCAL_SCAN_ROWS rows / HTML_WORDS_LOCAL_BUDGET_MS",
    owns: "a stored html-only letter with a blank text has its html's words as its text, preview and search document, as ingest stores them",
    fence: "store-only — no adapter, no lease; each page's writes, cursor and stamp in one fencedAccountWrite; every body UPDATE guarded on the blank text it read",
  },
  {
    name: "kickstart",
    module: `${W}/kickstart.ts`, entry: "runKickstart",
    triggers: ["attach"],
    cadence: "once per mailbox attach, ahead of the first drain",
    budget: "KICKSTART_BATCH rows × KICKSTART_MAX_PAGES",
    owns: "a virgin mailbox's Screener backlog exists before the first cycle files anything",
    fence: "the attach arm's adapter, pre-dispatch",
  },

  /* ── CYCLE-TAIL (per served account: the queue entry behind each rotation, walked as the
        `cycle-tail-plan.ts` sections with one cursor, yielding between slices to a wake) ── */
  {
    name: "bubble_up",
    module: `${W}/bubble-up-pass.ts`, entry: "bubbleUpPass",
    triggers: ["cycle-tail", "cron-backstop", "sidecar-drain"],
    cadence: "time-gated BUBBLE_UP_EVERY_MS (60 s) in the tail; bubble-up-cron.ts is the dead-worker backstop",
    budget: "one query per account per gate; flips only rows whose bubble_up_at is due",
    owns: "a due `bubbled_up` message_state becomes `resurfaced` and emits its change_log pair",
    fence: "leader lock (the cron takes the SAME per-shard lock, so exactly one runs)",
  },
  {
    name: "workflow_time_scan",
    module: `${W}/workflow-cron.ts`, entry: "workflowTimeScanPass",
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, per account, before the drain (a due resurface may satisfy a time trigger)",
    budget: "bounded by the account's due time-trigger rows",
    owns: "time-triggered workflow rules notice their moment",
    fence: "leader lock; per-account isolation (one account's error skips only that account)",
  },
  {
    name: "workflow_drain",
    module: `${W}/workflow-cron.ts`, entry: "workflowDrainPass",
    triggers: ["cycle-tail", "cron-backstop"],
    cadence: "every cycle tail, per account; workflow-cron.ts (runWorkflowCron) is the backstop",
    budget: "WORKFLOW_DRAIN_MAX_PER_PASS runs per pass, oldest enqueue first, on the reaper's read too; WORKFLOW_DRAIN_PASS_DEADLINE_MS stops it claiming new runs; STALE_CLAIM_MS re-claims; the drafter is circuit-gated (ai-circuit.ts)",
    owns: "queued workflow executions drain to their outcomes exactly once (claim rows race-proof the pair)",
    fence: "leader lock + claim rows; NOT wrapped in asDatabaseFault (a model outage is not a DB fault)",
  },
  {
    name: "agree_sweep",
    module: `${CORE}/unscreened-set.ts`, entry: "agreeSweepRun",
    // The desktop and phone engine call the same function at the head of each organizing drain while it runs.
    triggers: ["visit", "attach"],
    cadence: "after the promotion that spends the stamp written with a person's first agree from the window step, then every organizing visit until its cursor is done",
    budget: "AGREE_SWEEP_SLICES_PER_DRAIN slices a visit, each OHBOX_UNSCREENED_MESSAGES_MAX letters and the walk's 25 pages in its own transaction",
    owns: "agreeing screens the in-window mail of never-decided senders, the set the agree screen counted",
    fence: "the mailbox row FOR UPDATE, then FOR UPDATE OF folder_state; desired-state writes only (the reconciler moves)",
  },
  {
    name: "rule_retro",
    module: `${W}/rule-retro.ts`, entry: "ruleRetroPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "every cycle tail, per account, while retro-apply commands are pending; on a standalone install at the head of every organizer drain",
    budget: "RULE_RETRO_BATCH / RULE_RETRO_WRITES_PER_CYCLE / RULE_RETRO_MAX_PAGES",
    owns: "a rule's retroactive apply reaches the existing backlog, resumably",
    fence: "leader lock; desired-state writes only (the reconciler carries them to IMAP)",
  },
  {
    name: "gap_catchup",
    module: `${W}/gap-catchup.ts`, entry: "gapCatchupPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "every cycle tail, per account, while a mailbox this install organizes has its gap window open (mailboxes.gap_since) and its rules are settled; on a standalone install at the head of an organizer drain, after a quiet one",
    budget: "GAP_CATCHUP_BATCH / GAP_CATCHUP_WRITES_PER_CYCLE / GAP_CATCHUP_MAX_PAGES",
    owns: "mail that arrived while nothing organized the mailbox is filed by the person's rules, and a new sender's put in the Screener, once, on the person's press",
    fence: "leader lock; desired-state writes only (the reconciler carries them to IMAP); the window closes in the last page's transaction",
  },
  {
    name: "gate_release",
    module: `${W}/gate-release.ts`, entry: "gateReleasePass",
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, per account, until account_settings.gate_release_done_at is stamped",
    budget: "GATE_RELEASE_BATCH rules armed and gate rows released per account per cycle",
    owns: "an account that confirmed its seed before 0.19.0 gets the mail stuck at its gate back, once",
    fence: "leader lock; arms rules for rule_retro and writes desired-state only",
  },
  {
    name: "sender_check_backfill",
    module: `${W}/sender-check-backfill.ts`, entry: "senderCheckBackfillPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "every cycle tail, per account, until both its sets answer empty; then one read per tail re-arms an account a row re-entered (mail 0148); on a standalone install once per drain until empty",
    budget: "SENDER_CHECK_BACKFILL_BATCH rows x SENDER_CHECK_BACKFILL_PAGES pages per account per call",
    owns: "a message ingested before mail 0148 that sits in the Ohbox or the Screener gets its identity fact, once, and a marked one a message delta",
    fence: "leader lock; the account erasure fence per page; writes the fact and a delta, never a move",
  },
  {
    name: "list_address_backfill",
    module: `${W}/list-address-backfill.ts`, entry: "listAddressBackfillPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "every cycle tail, per account, until account_settings.list_addresses_scanned_at is stamped (mail 0150), then one indexed read; on a standalone install once per launch, before the correspondent retro",
    budget: "one DISTINCT read of the account's stored List-Post values, then LIST_ADDRESS_CHUNK addresses per write",
    owns: "every address a stored message's List-Post names is a list address, once, so no contact or rule consents a claim under it",
    fence: "leader lock; the account erasure fence per chunk and for the stamp; writes list_addresses and the stamp, never a contact or a move",
  },
  {
    name: "ohbox_tidy",
    module: `${W}/ohbox-tidy.ts`, entry: "ohboxTidyPass",
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, per account, while a tidy command is pending",
    budget: "OHBOX_TIDY_BATCH / OHBOX_TIDY_WRITES_PER_CYCLE / OHBOX_TIDY_MAX_PAGES",
    owns: "the one-press Ohbox tidy (screened-out mail out of the Ohbox) completes, resumably",
    fence: "leader lock; desired-state writes only",
  },
  {
    name: "thread_join_heal",
    module: `${W}/thread-join-heal.ts`, entry: "threadJoinHealPass",
    triggers: ["cycle-tail", "cli", "sidecar-drain"], cli: ["run-thread-join-heal.ts"],
    cadence: "time-gated THREAD_JOIN_HEAL_EVERY_MS (6 h) in the tail; a slice cut by its clock resumes in the next tail walks",
    budget: "THREAD_JOIN_HEAL_MAX_GROUPS and THREAD_JOIN_HEAL_WALK_MS per account per walk / _MAX_THREADS_PER_GROUP / _MAX_MESSAGES_PER_THREAD / witness spread cap, read once per account per walk; TAIL_SLICE_BUDGET_MS per slice, checked between groups",
    owns: "conversations a forward's fresh header chain split in two are merged (core's join verdict, one implementation)",
    fence: "leader lock; per-account isolation",
  },
  /**
   * A REPAIR WITH AN END, and the row says so: once a release carrying
   * `MessageDTO.autoReplyByUs` has reached every client this pass and its sweep can be deleted
   * outright. Nothing else depends on it.
   */
  {
    name: "away_reply_flag_redeliver",
    module: `${W}/away-reply-flag-redeliver.ts`, entry: "awayReplyFlagRedeliverPass",
    triggers: ["cycle-tail"],
    cadence: "ONCE PER WORKER PROCESS, on the first cycle tail after start — the gate belongs to `away-reply-sweep.ts#makeAwayReplySweep`, which closes it only on an attempt where every account walked to exhaustion, and is retried every AWAY_REPLY_REDELIVER_RETRY_MS (15 min) while any account is still owed. No CLI and no sidecar: the desktop carries the flag through its own sync, not by running this",
    budget: "AWAY_REPLY_REDELIVER_BATCH (200/page) / AWAY_REPLY_REDELIVER_MAX_PAGES (5000, a safety bound rather than a budget — the walk is meant to reach the end of the candidate set, and a short page is what ends it)",
    owns: "responder replies written BEFORE the auto-reply flag existed are re-delivered once, so a warm mirror stops presenting them in the Ohbox as the person's own mail",
    fence: "leader lock; writes change_log rows ONLY — no message, no folder_state, nothing moved",
  },
  {
    name: "inbound_quiet",
    module: `${W}/inbound-quiet.ts`, entry: "inboundQuietPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "time-gated INBOUND_QUIET_EVERY_MS (6 h) in the tail",
    budget: "one aggregate read per mailbox per gate",
    owns: "a healthily-syncing mailbox with zero genuine inbound for the window gets the quiet forwarding notice",
    fence: "leader lock; writes only the notice state",
  },
  {
    name: "mailbox_erasure",
    module: `${W}/mailbox-erasure-pass.ts`, entry: "mailboxErasurePass",
    triggers: ["cycle-tail"],
    cadence: "every cycle, leader-only, over this shard's owed stamps (mailboxes_erasure_owed_idx)",
    budget: "MAILBOX_ERASURE_STEPS_PER_PASS steps of ERASE_BATCH messages and MAILBOX_ERASURE_PASS_BUDGET_MS of wall clock; one indexed read, empty when nothing is owed; one read of finished erasures still holding a signature, each cleared by its own one-row update",
    owns: "a \"Remove and erase\" press erases ohmail's copy of that mailbox's mail — every row, its signature included, one receipt, erasure_done_at set — and nothing on the mail server",
    fence: "per step: the account row FOR SHARE, the thread-structure advisory lock, the mailbox row FOR UPDATE — the order every erasure holds",
  },
  {
    name: "storage_evict",
    module: `${W}/storage-evict.ts`, entry: "storageEvictPass",
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, per account over its cap",
    budget: "EVICT_ROUNDS_PER_CYCLE",
    owns: "an account over its storage cap sheds stored bodies oldest-first, husks kept",
    fence: "leader lock; DB-only (bodies are re-fetchable from the mailbox)",
  },
  {
    name: "screener_auto_apply",
    module: `${W}/screener-auto.ts`, entry: "screenerAutoApplyPass",
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, per account with auto-apply on",
    budget: "SCREENER_AUTO_BATCH / SCREENER_AUTO_WRITES_PER_CYCLE / SCREENER_AUTO_MAX_PAGES; a TAIL_SLICE_BUDGET_MS `until` clock in the tail, the walk resuming at its cursor",
    // THIS ROW SAID "accepted screener suggestions become decisions without a press, exactly as
    // the press would" and the pass has never read a suggestion: it judges each held message
    // itself with the strong-bulk floor and files to News/Receipts only. What the row described
    // is `screener_auto_act` below, which is why a Spam verdict at 0.95 waited for ever.
    owns: "obvious strong-bulk mail leaves the Screener by the deterministic floor — no model, no spend, no rule",
    fence: "leader lock; folder_state + change_log + an audit inverse, never IMAP",
  },
  {
    name: "screener_auto_act",
    module: `${W}/screener-auto-act.ts`, entry: "screenerAutoActPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    // Never armed by `screener_auto_apply_at`, the switch that promises "no AI": its own consent is
    // `screener_auto_act_at`, read with `accounts.ai_enabled` by `screenerActConsentFrom`.
    cadence: "every cycle tail and every local drain tail, per account that turned on acting on confident suggestions",
    budget: "SCREENER_ACT_SENDERS_PER_CYCLE senders per account per cycle; one transaction each; a TAIL_SLICE_BUDGET_MS `until` clock in the tail",
    owns: "a waiting sender whose stored suggestion is at or above the bar is filed exactly as the press files them",
    fence: "leader lock; the decision path is `applyScreenerDecision` — the manual Apply's and the drain's one implementation",
  },
  {
    name: "screener_correspondent_retro",
    module: `${W}/screener-correspondent-retro.ts`, entry: "screenerCorrespondentRetroPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "CORRESPONDENT_RETRO_EVERY_MS (hourly) per served account, due at a new leader's first cycle; on a standalone install at a drain tail behind the organizer gate, the first drain of a launch included",
    budget: "CORRESPONDENT_RETRO_SENDERS held senders and auto-act rules per run; CORRESPONDENT_SCAN_ROWS Sent copies; one transaction per sender",
    owns: "nobody this account wrote to after its consent point waits at the gate or stays under a spam rule the auto-act promoted",
    fence: "leader lock; folder_state + change_log + an audit inverse per message, one rule delta per retired rule, never IMAP",
  },
  {
    name: "screener_auto_suggest",
    module: `${W}/screener-auto-suggest.ts`, entry: "screenerAutoSuggestPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "every cycle tail, per account with suggestions on, watermark-resumed",
    budget: "AUTO_SUGGEST_BATCH per run; spend-gated through the caller-supplied credits gate; a TAIL_SLICE_BUDGET_MS `until` clock in the tail",
    owns: "new screener senders get a suggestion as they arrive (same watermark/cap/order as the surface)",
    fence: "leader lock; the ledger is reached only through the injected gate (the local engine injects none)",
  },
  {
    name: "global_maintenance",
    module: `${W}/index.ts`, entry: "MAINTENANCE_EVERY_MS",
    triggers: ["cycle-tail"],
    cadence: "time-gated MAINTENANCE_EVERY_MS (~hourly), leader-only, global (not per account)",
    budget: "pruneIdempotencyKeys + pruneSendFingerprints + pruneAuthThrottle (packages/db) + sweepExpiredStagingFor pages until drained",
    owns: "expired idempotency keys, spent send-content claims, abandoned AI claims, sign-in throttle rows past retention and expired staged-attachment bytes actually go away (the send-content sweep is hygiene: the duplicate window is compared against the request clock in the send path, never enforced by this)",
    fence: "leader lock (the worker is the single elected writer); each sweep failure is logged, never a cycle abort",
  },

  /* ── OFF THE CYCLE: own timer, the cycle's own queue, or the wake hub ─────────────────── */
  {
    name: "thread_backfill",
    module: `${W}/thread-backfill.ts`, entry: "runThreadBackfill",
    triggers: ["post-cycle"],
    cadence: "`kickThreadBackfill()` at the tail of a cycle that drained its MESSAGE backlog — one "
      + "slice per kick on the serialize queue, round-robin over duty accounts; no timer anywhere",
    budget: "THREAD_BACKFILL_SLICE_PAGES pages / THREAD_BACKFILL_SLICE_MS deadline per slice",
    owns: "historical mail with thread_id IS NULL gets threaded; the predicate is its own resume marker",
    fence: "the cycle queue (never concurrent with a cycle); failures cost the cycle nothing",
  },
  {
    name: "sync_kick",
    module: `${W}/sync-kick.ts`, entry: "syncKickPass",
    triggers: ["interval"],
    cadence: "every SYNC_KICK_EVERY_MS (3 s)",
    budget: "an indexed scan of the served set's stamps, and one read of at most "
      + "SYNC_KICK_UNSERVED_MAX unserved stamps, newest first, that writes nothing",
    owns: "a client's POST /sync/pull doorbell reaches the dispatcher as a priority within seconds",
    fence: "leader lock; wakes attached runtimes, and asks the roster for a stamped mailbox none is",
  },
  {
    name: "alerts",
    module: `${DB}/alerts.ts`, entry: "runAlertPass",
    triggers: ["interval"],
    cadence: "every alertIntervalMs (DEFAULT_ALERT_INTERVAL_MS)",
    budget: "the alert table's own dedupe/cooldown windows",
    owns: "operator alerts (stale reconciliation, sync-blocked mailboxes, …) fire once per condition, to mail/push sinks",
    fence: "leader lock",
  },
  {
    name: "api_fault_prune",
    module: `${W}/api-fault-prune.ts`, entry: "apiFaultPrunePass",
    triggers: ["interval"],
    cadence: "on the alert pass's own cadence, immediately after it",
    budget: "one indexed range scan on api_faults.at (api_faults_at_idx), empty when nothing is due",
    owns: "api_faults keeps seven days and no more — the table the reliability rules read",
    fence: "leader lock (it rides the alert pass, which holds it)",
  },
  {
    name: "alert_gap_prune",
    module: `${W}/alert-gap-prune.ts`, entry: "alertGapPrunePass",
    triggers: ["interval"],
    cadence: "on the alert pass's own cadence, immediately after it",
    budget: "one DELETE over alert_driver_gaps (two rows per day, a hundred days kept), empty when nothing is due",
    owns: "alert_driver_gaps keeps a hundred days and no more — the per-driver gap history",
    fence: "leader lock (it rides the alert pass, which holds it)",
  },
  {
    name: "alert_drill",
    module: `${W}/alert-drill-pass.ts`, entry: "alertDrillPass",
    triggers: ["interval"],
    cadence: "on the alert pass's own cadence, as its last step; shard 0's leader only",
    budget: "at most one queued drill run per pass: one claim UPDATE, one INSERT of its per-sink rows, one message per sink",
    owns: "a drill the API queued for the worker driver is delivered once, through the worker's own arms, and recorded",
    fence: "leader lock (it rides the alert pass, which holds it); the claim's `fired_at IS NULL` guard against a second worker",
  },
  {
    name: "retention_prune",
    module: `${W}/retention-prune.ts`, entry: "retentionPrunePass",
    triggers: ["interval"],
    cadence: "on the maintenance cadence (MAINTENANCE_EVERY_MS, ~hourly), leader-only",
    budget: "RETENTION_ACCOUNTS_PER_TICK accounts round-robin, each at most RETENTION_BATCHES_PER_ACCOUNT DELETEs of RETENTION_DELETE_BATCH rows; the audit/auth prunes are indexed range scans, empty when nothing is due",
    owns: "change_log is compacted below the explicit 410 floor (each live entity's first row and the user-wins moves stay — the desktop mirror's since=0 bootstrap replays complete); audit_log keeps a year and auth_events 180 days, no more — the horizons stated once in db/src/retention.ts",
    fence: "leader lock (it rides the maintenance block); the floor is raised before anything is deleted",
  },
  {
    name: "sign_in_retention",
    module: `${W}/retention-prune.ts`, entry: "signInRetentionPass",
    triggers: ["interval"],
    cadence: "on the maintenance cadence (MAINTENANCE_EVERY_MS, ~hourly), leader-only, after retention_prune",
    budget: "per table at most RETENTION_BATCHES_PER_ACCOUNT DELETEs of RETENTION_DELETE_BATCH rows; sessions and device addresses SIGN_IN_SESSION_BATCH per statement; the whole pass SIGN_IN_RETENTION_DEADLINE_MS",
    owns: "sign-in records, OAuth and pairing codes, staff sessions and unused invitations go SIGN_IN_RECORD_RETENTION_MS after they end; a session SIGN_IN_RECORD_RETENTION_MS after its sign-out, or once the erasure's keep past its window has run out, never while the account erasure would still name a token of it (erasureStillNamesSession) nor while its family is live; a device's address goes once its last session's record is gone; expired ceremonies stop waiting for the next ceremony",
    fence: "leader lock (it rides the maintenance block); sessions locked in id order FOR UPDATE SKIP LOCKED under a 2 s lock timeout, so an erasure or a rotation holding one is passed over",
  },
  {
    name: "refund_obligation_drain",
    module: `${W}/refund-obligation-drain.ts`, entry: "refundObligationDrainPass",
    triggers: ["interval"],
    cadence: "on the maintenance cadence (MAINTENANCE_EVERY_MS, ~hourly), leader-only",
    budget: "one claim statement on credit_refund_obligations_pending_idx plus at most REFUND_OBLIGATION_BATCH releases, and both are empty when nothing is owed",
    owns: "a spend that bought nothing is refunded — the obligation rows cloud 0036 holds are turned back into credits, exactly once",
    fence: "leader lock, and the row's own lease (claimed_until) so two workers never dial for one debt",
  },
  {
    name: "api_cron",
    module: `${W}/api-cron.ts`, entry: "startApiCron",
    triggers: ["interval"],
    cadence: "per API_CRON_TARGETS: sessions_reap and smtp_size 24 h, unsubscribe_drain 1 h, scheduled_send / send_reconcile / away_responder ~1 min (+jitter), platform_signals 5 min",
    budget: "one authenticated HTTP poke per target per period, timeoutMs each",
    owns: "the API-side internal passes (session reap, SMTP size probe, scheduled sends, send reconcile, away replies, platform signals, the screened-out unsubscribe drain) get their heartbeat — unsubscribe_drain's cadence is read here by UNSUB_DRAIN_WINDOW_MS, which derives its look-back from it",
    fence: "leader lock (one poker); the API routes hold their own idempotency",
  },
  {
    name: "push_wake",
    module: `${W}/push-wake.ts`, entry: "startPushWake",
    triggers: ["wake-driven"],
    cadence: "event-driven off the change-log NOTIFY hub, debounced WAKE_DEBOUNCE_MS, floor WAKE_MIN_INTERVAL_MS",
    budget: "WAKE_BODY_BYTES content-free pushes, WAKE_TIMEOUT_MS per endpoint",
    owns: "a mobile device's push endpoint learns 'your log advanced' without content leaving the server",
    fence: "leader lock; endpoints guarded by pushEndpointGuardFromEnv",
  },

  /* ── CRON-BACKSTOP PROCESSES (cron-log.ts CLI bottoms; lock-refused while the worker lives) ── */
  {
    name: "cron_bubble_up",
    module: `${W}/bubble-up-cron.ts`, entry: "runBubbleUpCron",
    triggers: ["cron-backstop"],
    cadence: "operator/scheduler invocation; exits 0 ran-or-skipped",
    budget: "one bubbleUpPass sweep over served accounts",
    owns: "the resurface flip still happens when the worker is dead",
    fence: "acquireLeaderLock(leaderLockKeyFor(shard)) — the worker's own lock, so it cannot double-run",
  },
  {
    name: "cron_workflow",
    module: `${W}/workflow-cron.ts`, entry: "runWorkflowCron",
    triggers: ["cron-backstop"],
    cadence: "operator/scheduler invocation",
    budget: "one workflowDrainPass sweep — WORKFLOW_DRAIN_MAX_PER_PASS runs and WORKFLOW_DRAIN_PASS_DEADLINE_MS per account",
    owns: "queued workflow executions still drain when the worker is dead",
    fence: "the worker's leader lock, as cron_bubble_up",
  },
  {
    name: "cron_reconcile",
    module: `${W}/reconcile-cron.ts`, entry: "runReconcileCron",
    triggers: ["cron-backstop"],
    cadence: "operator/scheduler invocation (pnpm -F @trafficflow/worker reconcile)",
    budget: "one reconcile sweep over pending desired-state rows",
    owns: "desired folder/flag state still converges to IMAP when the worker is dead",
    fence: "the worker's leader lock",
  },
  {
    name: "proposal_generate",
    module: `${W}/proposal-cron.ts`, entry: "proposalGeneratePass",
    triggers: ["cron-backstop"],
    cadence: "operator invocation; unscheduled in production",
    budget: "spend-gated through the AI credit gate; per-account isolation",
    owns: "AI proposals are generated between visits without a user press",
    fence: "the worker's leader lock",
  },
  {
    name: "cron_proposals",
    module: `${W}/proposal-cron.ts`, entry: "runProposalCron",
    triggers: ["cron-backstop"],
    cadence: "operator/scheduler invocation",
    budget: "one proposalGeneratePass sweep",
    owns: "the proposal pass's process entry (config, logger, exit codes — cron-log.ts's ceremony)",
    fence: "the worker's leader lock",
  },

  /* ── OPERATOR CLI REPAIRS (idempotent, resumable, safe to kill) ───────────────────────── */
  {
    name: "redacted_restore",
    module: `${W}/redacted-restore.ts`, entry: "redactedRestorePass",
    triggers: ["cli"], cli: ["run-redacted-restore.ts"],
    cadence: "operator-run, per mailbox",
    budget: "REDACTED_RESTORE_BATCH / _FETCHES_PER_CYCLE / _MAX_PAGES / _MAX_BYTES",
    owns: "historically over-redacted bodies are re-fetched and restored",
    // Also a line that was not true when written: the runner took no lease at all. The FETCHES
    // never needed one — they read — but `ensureFolders()` on the way in CREATES the `ohmail/*`
    // tree, and that is a write into somebody else's mailbox. One check before the one mutation.
    // Same addition as `junk_sweep`'s, for the same reason: this runner shares the always-on
    // worker's install id too, so the twin refusal is what makes the lease check safe rather than
    // an extra layer on top of it.
    fence: "a live-twin refusal (`assertNoLiveTwin`) and then an organizer-lease check before "
      + "`ensureFolders()` (its only server write — up to five `mailboxCreate` commands, with no "
      + "re-check between them, which is written down at the call site); the fetches and body "
      + "writes are reads plus our own database, and the dry run never connects",
  },
  {
    name: "sender_name_backfill",
    module: `${W}/sender-name-backfill.ts`, entry: "runSenderNameBackfill",
    triggers: ["cli", "sidecar-drain"], cli: ["run-sender-name-backfill.ts"],
    cadence: "operator-run (hosted) / bounded visits at the sidecar's drain tail (local)",
    budget: "SENDER_NAME_BACKFILL_BATCH per run",
    owns: "historical rows re-parse their stored header bag into the sender/recipient columns ingest now writes",
    fence: "DB-only; the values must equal what ingest would write (one parser)",
  },
  {
    name: "thread_subject_heal",
    module: `${W}/thread-subject-heal.ts`, entry: "runThreadSubjectHeal",
    triggers: ["cli"], cli: ["run-thread-subject-heal.ts"],
    cadence: "operator-run",
    budget: "SUBJECT_HEAL_BATCH per run",
    owns: "threads whose subject snapshot predates the subject rules are re-derived",
    fence: "DB-only",
  },
  {
    name: "kek_rewrap",
    module: `${DB}/kek-rewrap.ts`, entry: "runKekRewrap",
    triggers: ["cli"], cli: ["run-kek-rewrap.ts"],
    cadence: "operator-run during KEK rotation; census-only without --apply",
    budget: "two SELECTs per site when finished; verify-decrypt-in-transaction per row otherwise",
    owns: "every stored envelope moves onto the current KEK version so an old version can actually be retired",
    fence: "DB-only, dry-run by default; a value that will not decrypt is reported and skipped, never blanked",
  },
] as const;
