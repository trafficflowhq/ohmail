/**
 * THE WORKER PASS REGISTRY — every pass, heal, backfill, retro and sweep this deployment runs,
 * in one table.
 *
 * ── WHY A TABLE, AND WHY HERE ───────────────────────────────────────────────────────────────
 *
 * The worker accumulated its maintenance work one invariant at a time: each pass module owns
 * one invariant and documents it in place — which is right — but the SET of passes existed
 * nowhere. Answering "what runs, when, under which lock, and what can it cost the wake path?"
 * meant reading `index.ts`'s dispatcher tail, `sync.ts`'s visit internals, four cron entry
 * points and nine operator CLIs. That archaeology is what this table retires: the next
 * pass-touching change starts HERE, sees every trigger a pass already has (several run in
 * three places — the cycle tail, a cron backstop, and the desktop's local engine), and adds
 * its own row in the same commit — `test/pass-registry.test.ts` fails the build when a pass
 * exists unregistered, the same way the route and log censuses hold their seams.
 *
 * This is a MAP, not a scheduler: nothing imports this module at runtime, the rows are
 * metadata, and registering a pass changes no behavior. The census cross-checks each row
 * against the source it names, so a row cannot outlive its pass (a deleted or renamed entry
 * goes red — a decorative registry is the failure mode this file must not have).
 *
 * ── THE VOCABULARY ──────────────────────────────────────────────────────────────────────────
 *
 * The WAKE PATH — a mailbox wake through `runSyncCycle` to the mirror — is not a pass and is
 * deliberately not in this table (it is what every budget below exists to protect). Triggers:
 *
 *  · `visit`        inside a mailbox visit, on the visit's own connection and fence;
 *  · `attach`       once, when a mailbox attaches to the runtime;
 *  · `cycle-tail`   the per-account maintenance tail after the dispatcher settles a cycle;
 *  · `interval`     its own timer in the worker process (`setInterval`), independent of a cycle;
 *  · `post-cycle`   queued by `cycle()` itself onto the same serialized queue — NOT a timer, so
 *                   it can never run beside the cycle that scheduled it;
 *  · `wake-driven`  a subscription to the change-wake hub: it fires when an account's log
 *                   advances, debounced, with no schedule of its own;
 *  · `cron-backstop` a separate CLI process for the same pass — a manual/scheduled backstop
 *                   for a dead worker, normally lock-refused while the worker is healthy;
 *  · `cli`          an operator-run repair (idempotent, resumable, safe to kill);
 *  · `sidecar-drain` the desktop's local engine runs the SAME module at the tail of its drain
 *                   (one implementation per invariant — the dual-mode rule).
 */

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
    name: "junk_restore",
    module: `${W}/junk-restore.ts`, entry: "junkRestorePass",
    triggers: ["visit"],
    cadence: "at the visit's tail, only when the cycle deferred nothing",
    budget: "JUNK_RESTORE_MAX_PAGES / JUNK_RESTORE_FETCHES_PER_CYCLE / JUNK_RESTORE_MAX_BYTES per visit",
    owns: "a junk-filed husk whose message is alive again in a watched folder gets its body back",
    fence: "the visit's leased adapter; writes through the fenced group",
  },
  {
    name: "junk_sweep",
    module: `${W}/junk-sweep.ts`, entry: "junkSweepPass",
    triggers: ["visit", "cli"], cli: ["run-junk-sweep.ts"],
    cadence: "command-driven: a user press stamps mailboxes.junk_sweep_requested_at; the visit works it off",
    budget: "one bounded keyset window per cycle (JUNK_SWEEP_PER_CYCLE), scan state carried across cycles",
    owns: "the one-time Quarantine→native-Junk migration a mailbox's owner pressed for",
    // This line USED TO SAY the CLI takes the mailbox's own lease, and the CLI did not: it moved
    // mail with no lease acquired or rechecked at all. A registry that answers the question wrongly
    // is worse than one that leaves it open, because a reader stops looking. It is true now — the
    // runner takes a `LeasePermit` under `--execute` and re-verifies it at every chunk boundary —
    // and the two fences are named separately because they answer different questions: the leader
    // fence is worker-to-worker, the organizer lease is install-to-install.
    // AND THE PRECONDITION, added 2026-09-01 — the entry named the permit and stopped there, which
    // was true and incomplete in the way this line has now been wrong twice. The permit alone is not
    // what makes it safe for this CLI to wear the always-on worker's install id: without the live-twin
    // check the gate reads the running worker's own claim as this process's, adopts the mailbox and
    // expunges it. The check is the thing that has to happen FIRST, so it is named first.
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
    name: "kickstart",
    module: `${W}/kickstart.ts`, entry: "runKickstart",
    triggers: ["attach"],
    cadence: "once per mailbox attach, ahead of the first drain",
    budget: "KICKSTART_BATCH rows × KICKSTART_MAX_PAGES",
    owns: "a virgin mailbox's Screener backlog exists before the first cycle files anything",
    fence: "the attach arm's adapter, pre-dispatch",
  },

  /* ── CYCLE-TAIL (per served account, after the dispatcher settles a cycle) ───────────── */
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
    budget: "STALE_CLAIM_MS re-claims; the drafter is circuit-gated (ai-circuit.ts)",
    owns: "queued workflow executions drain to their outcomes exactly once (claim rows race-proof the pair)",
    fence: "leader lock + claim rows; NOT wrapped in asDatabaseFault (a model outage is not a DB fault)",
  },
  {
    name: "rule_retro",
    module: `${W}/rule-retro.ts`, entry: "ruleRetroPass",
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, per account, while retro-apply commands are pending",
    budget: "RULE_RETRO_BATCH / RULE_RETRO_WRITES_PER_CYCLE / RULE_RETRO_MAX_PAGES",
    owns: "a rule's retroactive apply reaches the existing backlog, resumably",
    fence: "leader lock; desired-state writes only (the reconciler carries them to IMAP)",
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
    cadence: "time-gated THREAD_JOIN_HEAL_EVERY_MS (6 h) in the tail",
    budget: "THREAD_JOIN_HEAL_MAX_GROUPS / _MAX_THREADS_PER_GROUP / _MAX_MESSAGES_PER_THREAD / witness spread cap",
    owns: "conversations a forward's fresh header chain split in two are merged (core's join verdict, one implementation)",
    fence: "leader lock; per-account isolation",
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
    budget: "SCREENER_AUTO_BATCH / SCREENER_AUTO_WRITES_PER_CYCLE / SCREENER_AUTO_MAX_PAGES",
    owns: "accepted screener suggestions become decisions without a press, exactly as the press would",
    fence: "leader lock; the decision path is the service's own (one decide implementation)",
  },
  {
    name: "screener_auto_suggest",
    module: `${W}/screener-auto-suggest.ts`, entry: "screenerAutoSuggestPass",
    triggers: ["cycle-tail", "sidecar-drain"],
    cadence: "every cycle tail, per account with suggestions on, watermark-resumed",
    budget: "AUTO_SUGGEST_BATCH per run; spend-gated through the caller-supplied credits gate",
    owns: "new screener senders get a suggestion as they arrive (same watermark/cap/order as the surface)",
    fence: "leader lock; the ledger is reached only through the injected gate (the local engine injects none)",
  },
  {
    name: "away_responder",
    module: `${W}/away-responder.ts`, entry: "awayResponderPass",
    triggers: ["cycle-tail"],
    cadence: "every cycle tail, per account with an active away window",
    budget: "AWAY_BATCH candidates, AWAY_SENDS_PER_CYCLE sends",
    owns: "one away reply per correspondent per window, suppressions stated",
    fence: "leader lock; sends go through the send machine's reservation",
  },
  {
    name: "global_maintenance",
    module: `${W}/index.ts`, entry: "MAINTENANCE_EVERY_MS",
    triggers: ["cycle-tail"],
    cadence: "time-gated MAINTENANCE_EVERY_MS (~hourly), leader-only, global (not per account)",
    budget: "pruneIdempotencyKeys + pruneAiAttemptClaims (packages/db) + sweepExpiredStagingFor pages until drained",
    owns: "expired idempotency keys, abandoned AI claims and expired staged-attachment bytes actually go away",
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
    budget: "one indexed scan for sync_requested_at stamps",
    owns: "a client's POST /sync/pull doorbell reaches the dispatcher as a priority within seconds",
    fence: "leader lock; only reorders/wakes attached runtimes",
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
    name: "api_cron",
    module: `${W}/api-cron.ts`, entry: "startApiCron",
    triggers: ["interval"],
    cadence: "per API_CRON_TARGETS: billing_reconcile 1 h, sessions_reap 24 h, smtp_size, scheduled_send ~1 min (+jitter)",
    budget: "one authenticated HTTP poke per target per period, timeoutMs each",
    owns: "the API-side internal passes (billing reconcile, session reap, scheduled sends, SMTP size probe) get their heartbeat",
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
    budget: "one workflowDrainPass sweep",
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
    cadence: "runProposalCron process (a reconcile-cron sibling); pass runs per account",
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
    name: "read_retro",
    module: `${W}/read-retro.ts`, entry: "readStateRetroPass",
    triggers: ["cli"], cli: ["run-read-retro.ts"],
    cadence: "operator-run, per mailbox",
    budget: "READ_RETRO_BATCH / READ_RETRO_WRITES_PER_CYCLE / READ_RETRO_MAX_PAGES",
    owns: "unread mail already demoted to the two read-retro folders gets its desired-seen intent (flag-intent.ts, the one spelling)",
    fence: "row locks (FOR UPDATE OF messages); idempotent — unread=false leaves the candidate set",
  },
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
    name: "trial_credit_backfill",
    module: `${W}/trial-credit-backfill.ts`, entry: "runTrialCreditBackfill",
    triggers: ["cli"], cli: ["run-trial-credit-backfill.ts"],
    cadence: "operator-run, once",
    budget: "one pass over trial accounts missing their grant",
    owns: "trial accounts created before the credit grant existed receive it exactly once",
    fence: "DB-only; the grant's own uniqueness is the idempotency",
  },
  {
    name: "trial_grant_dedup",
    module: `${W}/trial-grant-dedup.ts`, entry: "runTrialGrantDedup",
    triggers: ["cli"], cli: ["run-trial-grant-dedup.ts"],
    cadence: "operator-run, once",
    budget: "one pass over duplicated grants",
    owns: "accounts double-granted by the pre-dedup backfill keep exactly one grant",
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
