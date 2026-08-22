import { hostname } from "node:os";
import {
  keyProviderFromEnvOptional, kekFingerprint, kekFingerprintFromEnv, kekEnvIdentity,
  makeAnthropicClient, assertAnthropicKey, makeHaikuClassifier, makeSonnetDrafter, makeOpusProposer,
  type KeyProvider, type ClassifierPort, type DraftPort, type WorkflowPort,
  type KekEnvIdentity, type Logger,
} from "@trafficflow/core";
import { transactionPoolerReason, sessionUrlRejection } from "@trafficflow/db";
import {
  DEFAULT_ALERT_THRESHOLDS, msOAuthEnv, WORKER_POOL_MAX, assertWeightedScheduleActive,
  type PostJson,
} from "@trafficflow/db/cloud";
import type { MailboxAdapter, ImapConfig } from "@trafficflow/core/adapters/imap";
import { buildVersionOf } from "./build-version.js";
import type { MailboxSelection } from "./mailboxes.js";
import type { ThreadBackfillPass } from "./thread-backfill.js";

/** One IMAP IDLE connection per mailbox lives in this process — cap it. */
export const DEFAULT_MAX_MAILBOXES = 64;
/** Shipped shard configuration: ONE shard (the seam exists, it is not used yet). */
export const DEFAULT_SHARDS = 1;
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  HOW MANY MAILBOXES ONE CYCLE MAY BE VISITING AT ONCE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `cycle()` used to walk its rotation strictly one mailbox at a time, so EVERY mailbox on the
 * shard waited out every other mailbox's bounded batch. Measured twice in production, both on
 * the same shard:
 *
 *  · during a folder-coverage backfill, most of the shard's mailboxes crossed the 15-minute `sync_lag`
 *    threshold — worst 18 minutes — because one mailbox's deep walk owned the rotation. It
 *    cleared when that mailbox finished, and it comes back on every first enumeration;
 *  · a mailbox went 15.5 minutes between visits while the wake channel that was supposed to
 *    serve it answers in under a second. A sub-second doorbell in front of a 15-minute queue
 *    is a 15-minute doorbell.
 *
 * THREE, and every term of that number is measured rather than preferred:
 *
 *  · the POOL is the ceiling. One worker process owns ONE postgres pool of
 *    {@link WORKER_POOL_MAX} connections, and a cycle holds one of them for the length of each
 *    fenced write group. The pulse and the alert pass run OFF the cycle queue and need their own,
 *    so {@link CYCLE_LANE_POOL_RESERVE} is held back for them. postgres.js QUEUES on an exhausted
 *    pool instead of failing, so going wider does not break — it silently stops being concurrency
 *    while still costing the memory and the provider connections of running wide;
 *  · the SPEEDUP is bounded by the slowest mailbox anyway. A rotation of 3 deep backfills
 *    (~254 s each, at the measured 1.27 s/message over two-hundred-message batches) and 10 quick
 *    mailboxes is ~782 s serial and ~260 s over three lanes — the point at which one mailbox's
 *    own batch, not the rotation, is what a mailbox waits for. Lanes beyond that buy nothing;
 *  · one lane is RESERVED for mailboxes with no backlog ({@link CYCLE_FAST_LANES}), which is what
 *    makes the wake channel's promise reachable rather than merely likelier.
 *
 * `1` restores the earlier serial walk exactly, and is what the ordering guards that predate
 * the lanes are pinned to.
 */
export const DEFAULT_CYCLE_LANES = 3;
/**
 * Pool connections NOT available to the rotation: the pulse (`beat`) and the alert pass, both of
 * which run off the cycle queue and must not queue behind a backfill for their connection —
 * the heartbeat row is the one thing that stays fresh while a cycle is long, and an alert pass
 * that cannot read cannot fire.
 */
export const CYCLE_LANE_POOL_RESERVE = 2;
/**
 * The hard ceiling on {@link WorkerConfig.cycleLanes}, DERIVED from the pool rather than written
 * beside it. A deployment that raises the pool raises this with it; one that sets
 * `TF_CYCLE_LANES=64` gets this number and a refusal, because the alternative is a worker that
 * reports 64-way concurrency while postgres.js serializes it five at a time.
 */
export const MAX_CYCLE_LANES = WORKER_POOL_MAX - CYCLE_LANE_POOL_RESERVE;
/**
 * Lanes a mailbox that OWES A BACKLOG may never occupy — the reservation that makes a fast lane
 * a fast lane.
 *
 * Without it, three cold backfills fill three lanes and a mailbox whose IDLE just fired is behind
 * a deep batch again, which is the 15.5-minute measurement with a smaller constant. With it, a
 * mailbox that has nothing queued is never behind more than the ONE other quick mailbox that
 * might be in the reserved lane.
 *
 * ONE, not more: at three lanes, reserving two would leave a single lane to drain every backfill
 * on the shard and would make the deep-backlog case worse than the serial walk it replaces. The
 * guard asserts BOTH directions for exactly that reason.
 */
export const CYCLE_FAST_LANES = 1;
/**
 * HOW MANY EXTRA TURNS ONE MAILBOX MAY EARN INSIDE A SINGLE CYCLE BY BEING WOKEN.
 *
 * ── WHY A SECOND TURN EXISTS AT ALL ────────────────────────────────────────────────────────
 *
 * Lanes shorten a rotation; they do not shorten a CYCLE. One `cycle()` entry runs until every
 * mailbox has had its turn, and the queue admits one entry at a time, so a mailbox whose doorbell
 * rings after its turn waits for the slowest lane in that cycle — one bounded batch, measured at
 * ~254 s. Four minutes is a large improvement on 15.5 and is still not what the wake channel
 * promises. So a mailbox with an UNSERVED wake may be re-admitted inside the pass it already had
 * a turn in, and because {@link CYCLE_FAST_LANES} holds a lane back for mailboxes that owe
 * nothing, that re-admission is usually immediate.
 *
 * ── AND WHY IT IS BOUNDED ──────────────────────────────────────────────────────────────────
 *
 * `servedIds` — one turn per mailbox per pass — is what keeps a live queue FINITE, and this is a
 * hole in it, so the hole has a floor of its own. A re-admission spends the wake (`wokenAt` is
 * cleared on admission), so another one needs another real signal; that already bounds it by
 * events rather than by policy. This bounds it by policy as well, because "the number of IDLE
 * notifications a chatty mailbox can produce" is not a number this file gets to choose, and a
 * cycle that never ends is a roster pass that never runs.
 *
 * FOUR is deliberately small. Past it the mailbox keeps its wake and is served at the front of
 * the NEXT pass — which is the pre-lane behaviour, i.e. the floor this can degrade to is exactly
 * what shipped.
 */
export const CYCLE_WAKE_REVISITS = 4;
/** Standby lock-retry backoff — a hot spare re-tries every 15 s. */
export const DEFAULT_STANDBY_RETRY_MS = 15_000;
/**
 * How long an instance may SERVE NOTHING before `/health` stops calling it healthy.
 *
 * Two states are measured against it (`evaluateHealth` in `health.ts`): an instance that has
 * been waiting for the leader lock this long, and a leader that has had mailboxes to serve and
 * served none of them this long. Before this bound both answered 200 for ever — the first because a
 * wedge and a hot spare are the same snapshot, the second because the rule required a
 * quarantine to have been recorded — and an eight-minute production outage went unannounced
 * behind a green probe.
 *
 * TWO MINUTES, and the size is load-bearing in both directions:
 *   · a measured deploy handover is ~5 s, so a hot spare during a rolling
 *     deploy is 23× inside the bound and still answers 200 — kill that and no deployment can
 *     ever go active;
 *   · it is above the platform's 60 s health-check timeout, so in the pathological case the
 *     platform's own clock fails the deploy before this bound can be the thing that did. {@link
 *     MIN_SERVING_NOTHING_MAX_MS} keeps that true for any configured value.
 */
export const DEFAULT_SERVING_NOTHING_MAX_MS = 120_000;
/**
 * The floor `loadConfig` enforces on `TF_SERVING_NOTHING_MAX_MS`: the deploy manifest's
 * health-check timeout, in ms.
 *
 * Below it the health bound could fail a deploy that the platform would otherwise have allowed —
 * an instance would start answering 503 inside the window the platform is still waiting for its
 * first 200. The deploy manifest states as a fact that this cannot happen, and a knob that can make
 * a documented claim false is a knob with a floor. A programmatic `WorkerConfig` is NOT
 * clamped: the tests set milliseconds, and they are not deployments.
 */
export const MIN_SERVING_NOTHING_MAX_MS = 60_000;
/**
 * How STALE the leader's last COMPLETED cycle may go, with mailboxes connected, before
 * `/health` reports `degraded` — never unhealthy. The deployment platform gates a deployment on
 * this endpoint
 * and never re-probes a running service, so a slow cycle must not be able to refuse a deploy;
 * what it must stop doing is hiding.
 *
 * The blind spot it closes: `serving_nothing` requires `connected === 0`, so a leader whose
 * mailboxes were all attached but whose cycle had stopped completing read `healthy: true,
 * degraded: false` for ever — measured in production at `lagSeconds: 560` during a cold backfill,
 * green throughout. Now that state answers `degraded: true, degradedReason: "stale_cycle"`.
 *
 * EIGHT MINUTES, and the size is load-bearing in both directions:
 *   · a first post-takeover cycle measured ~5 minutes in production, so the
 *     bound clears the measured shape with margin — and the rule keys on `lastCycleAt`, a
 *     COMPLETED cycle, so that first long cycle cannot trip it at all (a fresh leader has no
 *     completed cycle to be stale about until its first one lands);
 *   · it stays below `DEFAULT_ALERT_THRESHOLDS.syncLagMs` (15 min), so `/health` turns amber
 *     before the pager fires — the endpoint must never know less than the alert pass. Asserted
 *     in `test/health-verdict.test.ts`.
 *
 * Wall clock and not a count of poll intervals, for {@link DEFAULT_SYNC_BLOCK_GRACE_MS}'s
 * reason: at the default 60 s `pollIntervalMs` this is eight cycles, but the property that
 * matters is measured in wall clock, so the knob is too.
 */
export const DEFAULT_STALE_CYCLE_MAX_MS = 480_000;
/** Health-server port when the platform does not inject `PORT`. */
export const DEFAULT_HEALTH_PORT = 8080;
/** How often the leader re-reads the mailbox roster: registrations, disables, deletions. */
export const DEFAULT_ROSTER_INTERVAL_MS = 30_000;
/**
 * HOW LONG A MAILBOX MAY GO UNSERVED BEFORE ITS ROW HAS TO SAY SO (mail migration 0029).
 *
 * ── A DURATION, NOT A COUNT OF PASSES ─────────────────────────────────────────────────────
 *
 * "After N roster passes" is a proxy for time that silently retunes itself whenever
 * {@link DEFAULT_ROSTER_INTERVAL_MS} changes: at N = 4 this threshold is two minutes today and
 * would become eight the day somebody quadrupled the roster interval to cut database load, with no
 * diff anywhere near this line. The property that matters is measured in wall clock, so the knob
 * is measured in wall clock.
 *
 * ── AND IT MUST STAY BELOW `DEFAULT_ALERT_THRESHOLDS.syncLagMs` (15 min) ──────────────────
 *
 * This is the whole of a measured half-hour silence, as a constraint. The `sync_lag` alert fires when an on-duty
 * mailbox has not synced for `syncLagMs`; the row is the only thing that can EXPLAIN that alert.
 * Set the grace above the alert threshold and the page arrives while the row is still pristine —
 * which is precisely the position an operator was in during that incident, and precisely the thing this
 * grace exists to make impossible. Two minutes leaves thirteen minutes of margin.
 *
 * The constraint is ASSERTED, not commented: `test/config.test.ts` compares the two
 * constants, and {@link syncBlockGraceMsFrom} refuses an env value that breaks it — a knob that can
 * make a documented claim false is a knob with a bound, the same rule
 * {@link MIN_SERVING_NOTHING_MAX_MS} exists for.
 */
export const DEFAULT_SYNC_BLOCK_GRACE_MS = 120_000;
/**
 * HOW LONG A CYCLE MAY KEEP FAILING TO READ THE ORGANIZER LEASE BEFORE THE MAILBOX IS DETACHED.
 *
 * ── WHAT IT BOUNDS, MEASURED ──────────────────────────────────────────────────────────────
 *
 * In one production incident every served mailbox emitted over a hundred consecutive
 * `sync_cycle_lease_unavailable` over most of an hour with `causeCode="NoConnection"`, and healed only
 * on a process restart. `LeaseUnavailableError` is exempt from `maxSyncFailures` BY CLASS, which is
 * correct (an infrastructure fault must never write `status='error'` on a customer's mailbox), and
 * with nothing else bounding the exempt arm a PERMANENTLY dead connection was retried for ever.
 * This is the bound. Past it the runtime is DETACHED — not quarantined — and the next roster pass
 * re-attaches on a fresh connection, because attach IS reconnect.
 *
 * ── A DURATION, NOT A COUNT OF CYCLES ─────────────────────────────────────────────────────
 *
 * {@link DEFAULT_SYNC_BLOCK_GRACE_MS}'s argument, restated for the sibling knob: "after N cycles"
 * is a proxy for time that silently retunes itself the day somebody changes `pollIntervalMs`, and a
 * cycle loop that re-kicks itself while `hasBacklog` does not even have a fixed period. The
 * property is wall clock, so the knob is wall clock.
 *
 * ── AND IT MUST STAY BELOW `DEFAULT_ALERT_THRESHOLDS.syncLagMs` (15 min) ──────────────────
 *
 * Same reason as its sibling, one step further: the system must HEAL before the alert that pages
 * about it. At two minutes plus one roster interval the streak self-terminates in ~2.5 minutes
 * against the near-hour measured, so `sync_lag` never fires for this cause at all. Set the bound
 * above the alert threshold and the page arrives while the worker is still in the do-nothing loop —
 * the outage restored, with a knob to blame. Asserted in `test/config.test.ts` and
 * refused by {@link leaseUnavailableDetachMsFrom}.
 */
export const DEFAULT_LEASE_UNAVAILABLE_DETACH_MS = 120_000;
/** How often the leader proves it still HOLDS its advisory lock (split-brain guard). */
export const DEFAULT_LOCK_HEARTBEAT_MS = 10_000;
/** First per-mailbox retry delay after a quarantine; doubles up to 16× (base 1 min → 16 min). */
export const DEFAULT_MAILBOX_RETRY_MS = 60_000;
/** Consecutive runtime sync failures before a mailbox is detached + quarantined. */
export const DEFAULT_MAX_SYNC_FAILURES = 3;
/**
 * How often the LEADER runs the alert pass.
 *
 * A minute, not a cycle: `pollIntervalMs` defaults to 60 s but is tuned per deployment and a
 * fast poll must not turn into a fast pager. The pass is four aggregate queries, so the cost
 * of running it every minute is negligible next to one IMAP cycle.
 */
export const DEFAULT_ALERT_INTERVAL_MS = 60_000;

export interface WorkerConfig {
  databaseUrl: string;          // session-mode / direct URL (NOT the transaction pooler)
  // ── accountId + mailboxId + imap are BOOTSTRAP-ONLY. The worker syncs
  // ALL enabled mailboxes of ALL accounts in its shard, reading credentials from
  // `mailbox_credentials`.
  //
  // `accountId` (`TF_ACCOUNT_ID`) CANNOT narrow the roster. It used to, and a stale
  // production value would then leave every other account permanently unsynced — the
  // silently-unsynced-second-account defect wearing a different hat. It now only (a) pairs with `mailboxId` to VALIDATE the
  // legacy env mailbox during the one-shot creds bootstrap and (b) scopes the
  // single-mailbox `reconcile-cron` backstop. `selectionOf()` ignores it entirely.
  //
  // `mailboxId` + `imap`, when present, seed the legacy single mailbox's DB creds exactly
  // once, then are never read again.
  accountId?: string;
  mailboxId?: string;
  imap?: { host: string; port: number; secure: boolean; user: string; pass: string };
  smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  /** Envelope-encryption provider used to DECRYPT per-mailbox creds. Injected
   *  in tests; otherwise built from the KEK env. The worker host holds KEK material
   *  (same trust level as the API). */
  keyProvider?: KeyProvider;
  /** The host's KEK RING identity — `{ active, count, fingerprint }`, surfaced verbatim
   *  by `/health` so the API host's and the worker host's key material can be COMPARED
   *  without either revealing any of it (a KEK drift is otherwise
   *  invisible until a mailbox is touched). All three fields must match; see
   *  `KekEnvIdentity` in `@trafficflow/core`. */
  kek?: KekEnvIdentity;
  pollIntervalMs: number;
  sentDomain: string;
  /** Max mailboxes this process serves; the rest are logged LOUDLY and left unsynced. */
  maxMailboxes?: number;
  /**
   * How many mailboxes one `cycle()` may be visiting AT ONCE. Default
   * {@link DEFAULT_CYCLE_LANES}; `1` is the serial rotation exactly.
   *
   * CLAMPED on both paths by {@link resolveCycleLanes} — see there for why this knob, unlike the
   * millisecond ones on this interface, is not honoured verbatim for a programmatic config.
   * `loadConfig` refuses an out-of-range `TF_CYCLE_LANES` outright.
   */
  cycleLanes?: number;
  /** Shard seam: total shards, and which one this process is. Defaults 1 / 0. */
  shards?: number;
  shardIndex?: number;
  /** Health server port. 0 ⇒ an ephemeral port (tests). */
  healthPort?: number;
  /** Standby lock-retry interval. */
  standbyRetryMs?: number;
  /** How long an instance may serve nothing before `/health` reports 503.
   *  Default {@link DEFAULT_SERVING_NOTHING_MAX_MS}; `loadConfig` floors it at
   *  {@link MIN_SERVING_NOTHING_MAX_MS}, a direct config (tests) is unclamped. */
  servingNothingMaxMs?: number;
  /** How stale the last COMPLETED cycle may go, with mailboxes connected, before `/health`
   *  reports `degraded` (never unhealthy). Default {@link DEFAULT_STALE_CYCLE_MAX_MS}. */
  staleCycleMaxMs?: number;
  /** How often the leader RE-READS the roster so a mailbox registered (or disabled)
   *  after startup is picked up (or dropped) without a restart. */
  rosterIntervalMs?: number;
  /** How often the leader proves it still holds its advisory lock (split-brain guard). */
  lockHeartbeatMs?: number;
  /**
   * Mail migration 0029: how long a mailbox this process is NOT serving may stay unexplained before the
   * worker writes `sync_blocked_reason` on its row.
   *
   * Default {@link DEFAULT_SYNC_BLOCK_GRACE_MS}. It exists as a grace at all so a rolling deploy,
   * a leader handoff or one slow first `ensureFolders` does not stamp a reason onto a mailbox that
   * is about to attach perfectly well; it is bounded above by
   * `DEFAULT_ALERT_THRESHOLDS.syncLagMs`, because a reason that lands after the alert cannot
   * explain it. `loadConfig` REFUSES an env value at or above that bound; a programmatic config
   * (the tests, which set milliseconds) is unclamped.
   */
  syncBlockGraceMs?: number;
  /**
   * How long `cycle()` may keep failing to READ the organizer lease for one mailbox
   * before that mailbox's runtime is detached so the next roster pass re-dials it.
   *
   * Default {@link DEFAULT_LEASE_UNAVAILABLE_DETACH_MS}. It is a grace at all because a lease read
   * genuinely does fail transiently — a provider blip, a `FETCH` refused once — and detaching on the
   * first one would cost a reconnect per hiccup. It is bounded above by
   * `DEFAULT_ALERT_THRESHOLDS.syncLagMs` because the system has to heal before the page. `loadConfig`
   * REFUSES an env value at or above that bound; a programmatic config (the tests, which set
   * milliseconds) is unclamped.
   */
  leaseUnavailableDetachMs?: number;
  /**
   * Exchange/M365 OAuth2 app-registration credentials, read from `MS_OAUTH_CLIENT_ID` /
   * `MS_OAUTH_CLIENT_SECRET` / `MS_OAUTH_TENANT`.
   *
   * Optional as a whole, and every field may be empty: a password-only deployment sets none of
   * them, and the worker still boots and syncs. The refusal for a MISSING client secret is
   * DEFERRED to the moment an oauth mailbox actually needs a token ({@link MicrosoftTokenProvider}),
   * where it is a NAMED `OAuthConfigError` rather than a boot failure — booting is not the place to
   * refuse, because a deployment with no oauth mailboxes yet has nothing wrong with it.
   */
  msOAuth?: { clientId: string; clientSecret: string; tenant: string; redirectUri?: string };
  /**
   * THE STAGING BUCKET THIS WORKER SWEEPS — or absent on a deployment with no object storage.
   *
   * The hosted send stages attachment bytes into a private bucket on a signed URL and references
   * them from the send request; `attachment_staging` rows carry a 24-hour `expires_at` and this is
   * the other half — the bytes and the rows actually going away. It belongs to this process for
   * the reason `pruneIdempotencyKeys` already does: the worker is the single ELECTED writer, so
   * exactly one process runs the sweep.
   *
   * ABSENT ⇒ no sweep runs and nothing else changes. That is correct on a worker whose API has no
   * staging either — there is nothing to sweep — and it is a REPORTED state rather than a silent
   * one: a deployment that stages and does not sweep grows a bucket forever, so the worker logs
   * the skip once per maintenance pass rather than passing over it.
   *
   * The variables are the API host's exactly, KIND FOR KIND — `TF_STORAGE_KIND` selects
   * `supabase` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TF_ATTACHMENT_STAGING_BUCKET`) or
   * `s3` (the `S3_*` block) — and each kind's block is read all-or-nothing for the same reason:
   * half a configuration is a sweep that cannot delete. The worker MUST speak every kind the API
   * can mint into, because the worker is the only process that ever deletes: a kind the API
   * stages into and this process cannot sweep is a bucket that grows forever behind a quota that
   * deliberately counts unexpired rows only (an independent review caught exactly that gap when
   * the second kind landed API-side first). The kind-less legacy shape — the SUPABASE trio with
   * no `TF_STORAGE_KIND` at all — stays valid because it is the DEPLOYED managed contract.
   */
  attachmentStaging?: WorkerStagingStorage;
  /** Base per-mailbox retry delay after a quarantine (exponential, capped at 16×). */
  mailboxRetryMs?: number;
  /** Consecutive runtime sync failures before a mailbox is detached + quarantined. */
  maxSyncFailures?: number;
  /** TEST SEAM (never populated by `loadConfig`): build the mailbox adapter. Production
   *  always gets a real `ImapAdapter`. Tests inject a fake so post-connect failures,
   *  connection-count assertions and total sync death are drivable deterministically. */
  adapterFactory?: (
    cfg: ImapConfig,
    ctx: {
      accountId: string;
      mailboxId: string;
      /**
       * Hand this to the adapter so an ASYNCHRONOUS connection failure reaches the worker
       * instead of the process. It is on `ctx` rather than baked into the default factory
       * because a fake adapter has to be able to fire it: "the socket died and the OTHER
       * mailbox kept syncing" is the assertion an early crash-loop outage was missing, and it
       * cannot be written against a factory that never receives the callback.
       */
      onConnectionError: (err: unknown) => void;
    },
  ) => MailboxAdapter;
  /** TEST SEAM (never populated by `loadConfig`): the thread backfill the cycle slices.
   *  Production always gets `runThreadBackfill`. A guard needs to hand the worker a pass that
   *  sleeps past the IMAP socket timeout, or one that throws, and watch neither reach the
   *  attach path nor the process's exit code — the two properties the placement fix exists for. */
  threadBackfill?: ThreadBackfillPass;
  /**
   * The INJECTED ClassifierPort the routing pipeline's AI branch calls.
   *
   * The field an earlier comment said did not exist yet ("today `config.classifier` does not exist"). Absent ⇒
   * rules-only routing: no AI branch, no debit — which is still the shipped behaviour
   * of any deployment without an `ANTHROPIC_API_KEY`.
   *
   * It is NOT handed to `runSyncCycle` directly. `index.ts` wraps it in the per-process
   * CIRCUIT BREAKER (`ai-circuit.ts`) and passes `circuit.port()` per cycle, so a model outage
   * degrades to rules-only instead of stalling ingest and quarantining mailboxes.
   */
  classifier?: ClassifierPort;
  /** The INJECTED DraftPort the workflow runtime's `draft_reply` tool calls.
   *  A live model needs an Anthropic key = deployment config (like classify/draft),
   *  so this is optional: absent ⇒ a `draft_reply` step fails cleanly (reversible
   *  steps still drain). Tests inject a mock; a real drafter is wired by deployment. */
  drafter?: DraftPort;
  /** The INJECTED WorkflowPort the proposal cron uses to generate automation
   *  suggestions. A live Opus model = deployment config (like the drafter),
   *  so this is optional: absent ⇒ `unconfiguredProposer` proposes nothing (the cron
   *  runs cleanly, no suggestions). Tests inject a mock port. */
  proposer?: WorkflowPort;

  // ── Observability ───────────────────────────────────────────────────────────────────
  /**
   * Which process this is, in log lines and in the `worker_heartbeats` row. The platform supplies
   * `RAILWAY_REPLICA_ID`; falls back to the hostname, then to a random suffix, because an
   * unidentified instance makes "which one wrote this beat" unanswerable during a deploy —
   * the exact window in which two instances exist.
   */
  instanceId?: string;
  /** `production` / `staging` — the first word of every alert, so nobody pages on staging. */
  environment?: string;
  /**
   * WHICH BUILD THIS PROCESS IS. The commit sha, or `"dev"` when nothing said.
   *
   * Published by `/health` so "is the fix actually running?" is answerable from OUTSIDE the
   * process. Before this the only claim available after a worker deploy was "the tree I
   * uploaded contained it" — the webapp is provable per chunk and the API echoes
   * `TF_BUILD_VERSION`, and the worker had neither, so confirming a deploy meant matching a
   * deployment UUID out of the platform CLI's listing against its own upload output. That is the deploy
   * TOOL agreeing with itself, which is the thing a build identity exists to stop accepting as evidence.
   */
  buildVersion?: string;
  /**
   * Why {@link buildVersion} is unknown, or null. Reported, never thrown — see
   * {@link buildIdentityError}.
   */
  buildError?: string | null;
  /**
   * Generic alert webhook (`TF_ALERT_WEBHOOK_URL`): ntfy.sh, a Slack/Discord incoming hook,
   * PagerDuty Events v2 — anything that accepts a JSON POST.
   *
   * This is how the WORKER pages a human. It cannot use the product's own mailer: the worker may import
   * core + db only, and `MailService` lives in `packages/services`. A JSON POST needs
   * nothing but `fetch`, which is why the alert sink seam is shaped the way it is.
   *
   * Unset ⇒ the worker still evaluates and LOGS alerts (structured, one line each) but pages
   * nobody, and `alerts_undeliverable` says so at warn level rather than failing silently.
   */
  alertWebhookUrl?: string;
  /**
   * The MAIL arm of the pager (`TF_ALERT_EMAIL`, armed with `RESEND_API_KEY` + `MAIL_FROM`).
   *
   * Added when the webhook arm's endpoint (ntfy.sh) turned out to blackhole the hosting
   * platform's egress IPs — measured from inside this worker's own container, 2026-08-21,
   * while `api.resend.com` answered 200 from the same place. The product IS mail; the mailer
   * the API host already sends transactional mail through is one JSON POST away, so the
   * "core + db only" import rule holds: `resendAlertSink` lives in `packages/db`, not in
   * `packages/services` next to `MailService`.
   *
   * `TF_ALERT_EMAIL` is the ARMING variable: unset ⇒ no mail arm, quietly. Set with either
   * mailer half missing ⇒ a sink that refuses every delivery naming the missing variable, so
   * the escalation reports the misconfiguration instead of a silent hole. The spellings are
   * the API host's own (`msOAuthEnv` rule).
   */
  alertEmail?: string;
  /** `MAIL_FROM` — the From the product already sends transactional mail as. */
  mailFrom?: string;
  /** `RESEND_API_KEY` — the mail arm's bearer credential. Scoped, sending-only. */
  resendApiKey?: string;
  /**
   * The PUSH arm of the pager — the pager's SECOND VENDOR
   * (`TF_ALERT_TELEGRAM_BOT_TOKEN` + `TF_ALERT_TELEGRAM_CHAT_ID`).
   *
   * The mail arm above left the pager single-vendor: one transactional-mail account carrying
   * every page there is, so that account's outage, suspension or revoked key takes the pager
   * with it at the moment something is wrong. This arm shares nothing with it — different
   * company, different network, different credential, and a push to a device rather than a
   * message into a mailbox that this very product serves.
   *
   * Reachability was probed from inside this worker's own container rather than assumed, which
   * is how the webhook arm's host was found to be blackholed: `api.telegram.org` answered 200
   * in 86 ms from the same shell where `ntfy.sh` still times out.
   *
   * Either variable present arms the arm; the missing half is then a NAMED fault rather than a
   * quiet disarm — unlike `TF_ALERT_EMAIL`, neither of these exists for any other purpose, so
   * one of them being set can only mean somebody meant to arm this. `alert-push.ts` rules the
   * states.
   */
  alertTelegramBotToken?: string;
  /** Where the push arm posts — a numeric chat id, or an `@channelusername`. */
  alertTelegramChatId?: string;
  /** How often the leader runs the alert pass. Default {@link DEFAULT_ALERT_INTERVAL_MS}. */
  alertIntervalMs?: number;
  /**
   * THE API-CRON ARM (`TF_API_CRON_URL` + `TF_API_CRON_SECRET`) — this worker as the schedule
   * for the API host's internal passes (`api-cron.ts` has the whole argument: the platform
   * cron layer those routes were written for was measured dark for three weeks of deploys).
   *
   * `baseUrl` is the API origin (`https://api.ohmail.app`); `secret` is presented as
   * `Authorization: Bearer …` and must match the API host's `TF_ALERT_SECRET` or `CRON_SECRET`.
   *
   * Both-or-neither, enforced in `loadConfig`: neither ⇒ quiet disarm (a self-hosted compose
   * where the API sits beside a cron-capable host has no use for this), exactly one ⇒ a
   * NAMED refusal — like the Telegram pair, neither variable exists for any other purpose,
   * so one being set can only mean somebody meant to arm this, and a half-armed schedule
   * that quietly does nothing is precisely the dark-cron failure this arm replaces.
   */
  apiCron?: { baseUrl: string; secret: string };
  // ── The organizer lease (mail migration 0027) ───────────────────────────────────────
  /**
   * Who this Cloud deployment is, as an organizer of a mailbox.
   *
   * Every field has a safe default and none of them is normally set. `installId` in particular
   * MUST stay stable across restarts, deploys and database migrations — read the block above
   * `cloudInstallId` in `lease.ts` before overriding it, because the failure mode of an unstable
   * one is that every leader failover disables a customer's mailbox.
   *
   * `TF_ORGANIZER_INSTALL_ID` exists for the one case the default cannot serve: a self-hosted
   * Cloud organizing the same mailbox as ours. `TF_LEASE_STALE_MS` exists for tests, which
   * cannot wait out a ten-minute window.
   */
  organizer?: {
    installId?: string;
    displayName?: string;
    staleAfterMs?: number;
    /**
     * How often the portable organizer profile is re-serialized and compared against what the
     * mailbox holds, at most (`apps/worker/src/profile.ts`). `TF_PROFILE_FLUSH_MS` exists for
     * tests, which cannot wait out the five-minute default.
     */
    profileFlushIntervalMs?: number;
  };
  /** TEST SEAM: injected logger. Absent ⇒ a real JSON-lines logger on stdout. */
  logger?: Logger;
  /** TEST SEAM: injected webhook transport, so the suite never opens a socket. */
  alertPost?: PostJson;
}

/**
 * A configuration failure, NAMED — so the crash handler can report which variable is wrong
 * without printing the message.
 *
 * `packages/core/src/log.ts` reduces a thrown value to class + code and refuses the message,
 * for reasons that apply here too: `DATABASE_URL_SESSION` is a connection string and several of
 * these messages quote their input. But "the worker did not boot, class Error, code null" is not
 * an operational answer either, and a boot failure is exactly when there is nothing else to go
 * on. The variable's NAME is safe (we chose it, it is in the deploy manifest) and is the whole
 * of what a human needs, so it rides on the error as a field the handler can log deliberately.
 * The `message` keeps its original wording for a developer reading a stack locally.
 */
export class WorkerConfigError extends Error {
  /** Always this — `describeError` reads `code`, and the class is the taxonomy. */
  readonly code = "TF_CONFIG_INVALID";
  /** The offending environment variable, e.g. `TF_SHARD_INDEX`. Never its value. */
  readonly configVar: string;
  constructor(configVar: string, message: string) {
    super(message);
    this.name = "WorkerConfigError";
    this.configVar = configVar;
  }
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || v.trim() === "") throw new WorkerConfigError(key, `missing required env var ${key}`);
  return v;
}

/** An optional non-negative integer env var with a default (worker sizing knobs). */
function optInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new WorkerConfigError(key, `${key} must be a non-negative integer (got ${raw})`);
  }
  return n;
}

/**
 * THE ONE PLACE A LANE COUNT BECOMES A NUMBER OF CONCURRENT CYCLES.
 *
 * Both entry points go through it — `loadConfig` for a deployment and `startWorkerWithLock` for a
 * programmatic `WorkerConfig` — and it CLAMPS rather than trusting, which is deliberate and is
 * different from how the millisecond knobs in this file treat a programmatic value. Those knobs
 * bound a CLAIM (a row that explains an alert, a deploy the platform is still waiting on) and a test
 * setting an absurd one only makes its own assertions strange. This one bounds a RESOURCE that is
 * shared with the pulse, the alert pass and the customer's provider, and the failure mode of
 * exceeding it is invisible: postgres.js queues, so a worker configured 32 lanes wide would report
 * 32 cycles in flight while five of them make progress and 32 IMAP connections stream at once.
 *
 * A clamp and not a throw HERE because the throw belongs at the env boundary, where the operator
 * who typed the number can be told which variable to change ({@link cycleLanesFrom}).
 */
export function resolveCycleLanes(requested: number | undefined): number {
  const want = requested ?? DEFAULT_CYCLE_LANES;
  if (!Number.isInteger(want) || want < 1) return 1;
  return Math.min(want, MAX_CYCLE_LANES);
}

/**
 * `TF_CYCLE_LANES`, with the ceiling the pool imposes.
 *
 * A REFUSAL TO BOOT and not a silent clamp, for {@link servingNothingMaxMsFrom}'s reason: an
 * operator who set 16 because a shard felt slow must be told that the number cannot be honoured
 * and why, rather than shipping a deployment whose behaviour does not match its own manifest.
 */
function cycleLanesFrom(env: NodeJS.ProcessEnv): number {
  const lanes = optInt(env, "TF_CYCLE_LANES", DEFAULT_CYCLE_LANES);
  if (lanes < 1) {
    throw new WorkerConfigError("TF_CYCLE_LANES", "TF_CYCLE_LANES must be >= 1 (1 is the serial rotation)");
  }
  if (lanes > MAX_CYCLE_LANES) {
    throw new WorkerConfigError("TF_CYCLE_LANES",
      `TF_CYCLE_LANES must be <= ${MAX_CYCLE_LANES} — this process owns one postgres pool of ` +
      `${WORKER_POOL_MAX} connections and holds ${CYCLE_LANE_POOL_RESERVE} back for the pulse and ` +
      `the alert pass, which run off the cycle queue. Wider does not fail, it queues: the extra ` +
      `lanes would pay for IMAP connections and memory while the database serialized them ` +
      `anyway (got ${lanes})`);
  }
  return lanes;
}

/**
 * `TF_SERVING_NOTHING_MAX_MS`, with the floor that keeps the deploy manifest's claim true.
 *
 * A REFUSAL TO BOOT and not a clamp, for `loadAiPorts`' reason: silently raising somebody's 20 s
 * to 60 s leaves a deployment whose behaviour does not match its own manifest, and the variable
 * is named in the error so the fix is one line rather than a hunt.
 */
function servingNothingMaxMsFrom(env: NodeJS.ProcessEnv): number {
  const ms = optInt(env, "TF_SERVING_NOTHING_MAX_MS", DEFAULT_SERVING_NOTHING_MAX_MS);
  if (ms < MIN_SERVING_NOTHING_MAX_MS) {
    throw new WorkerConfigError("TF_SERVING_NOTHING_MAX_MS",
      `TF_SERVING_NOTHING_MAX_MS must be >= ${MIN_SERVING_NOTHING_MAX_MS} (the deploy ` +
      `health-check timeout); a shorter bound can 503 inside the window the platform is still waiting ` +
      `for the deployment's first 200 (got ${ms})`);
  }
  return ms;
}

/**
 * `TF_SYNC_BLOCK_GRACE_MS`, with the bound that keeps "the row explains the alert" true.
 *
 * A REFUSAL TO BOOT rather than a clamp, for {@link servingNothingMaxMsFrom}'s reason: silently
 * lowering somebody's 20 minutes to 15 leaves a deployment whose behaviour does not match what its
 * operator configured, and the variable is named in the error so the fix is one line.
 *
 * The comparison is against `DEFAULT_ALERT_THRESHOLDS.syncLagMs` — the SAME constant the alert pass
 * evaluates — so tuning one of the two numbers can never quietly invert the relationship between
 * them. The config suite asserts the same inequality about the DEFAULT, which is
 * the half an env-var check cannot cover.
 */
function syncBlockGraceMsFrom(env: NodeJS.ProcessEnv): number {
  const ms = optInt(env, "TF_SYNC_BLOCK_GRACE_MS", DEFAULT_SYNC_BLOCK_GRACE_MS);
  const lag = DEFAULT_ALERT_THRESHOLDS.syncLagMs;
  if (ms >= lag) {
    throw new WorkerConfigError("TF_SYNC_BLOCK_GRACE_MS",
      `TF_SYNC_BLOCK_GRACE_MS must be < ${lag} (DEFAULT_ALERT_THRESHOLDS.syncLagMs); a longer ` +
      `grace means the sync_lag alert fires while the mailbox row still says nothing, which is ` +
      `a measured half-hour production silence restored (got ${ms})`);
  }
  return ms;
}

/**
 * `TF_LEASE_UNAVAILABLE_DETACH_MS`, with the bound that keeps "the system heals before the page"
 * true.
 *
 * A REFUSAL TO BOOT rather than a clamp, for {@link syncBlockGraceMsFrom}'s reason. The comparison
 * is against the SAME `DEFAULT_ALERT_THRESHOLDS.syncLagMs` the alert pass evaluates, so tuning
 * either number cannot quietly invert the relationship: a detach bound at or above the alert
 * threshold means the measured hour-long do-nothing loop is reachable again from configuration
 * alone, with a green suite. `test/config.test.ts` asserts the same inequality about the
 * DEFAULT, which is the half an env-var check cannot cover.
 */
function leaseUnavailableDetachMsFrom(env: NodeJS.ProcessEnv): number {
  const ms = optInt(env, "TF_LEASE_UNAVAILABLE_DETACH_MS", DEFAULT_LEASE_UNAVAILABLE_DETACH_MS);
  const lag = DEFAULT_ALERT_THRESHOLDS.syncLagMs;
  if (ms >= lag) {
    throw new WorkerConfigError("TF_LEASE_UNAVAILABLE_DETACH_MS",
      `TF_LEASE_UNAVAILABLE_DETACH_MS must be < ${lag} (DEFAULT_ALERT_THRESHOLDS.syncLagMs); a ` +
      `longer bound means a dead connection is still being retried when the sync_lag alert fires ` +
      `about it, which is a measured hour-long production outage restored (got ${ms})`);
  }
  return ms;
}

// ── KEK loading: ONE implementation, in `@trafficflow/core`. ───────────────────
// The worker used to own a private `TF_KEK_V1`-only parser, and the API host had
// none — the two could silently disagree about the key that decrypts every mailbox
// credential. `@trafficflow/core/crypto` now owns the env contract (`TF_KEK_V1..Vn`,
// contiguous, highest active) and BOTH hosts import it; `apps/api-vercel` uses
// the same symbols. Re-exported under the worker's historical names so `index.ts`,
// `supervisor.ts` and the worker tests keep importing them from here.
export { kekFingerprint, kekFingerprintFromEnv, kekEnvIdentity };

/**
 * The worker's KeyProvider, or `undefined` when no `TF_KEK_V*` is configured — the
 * caller (`index.ts`) turns that into the loud "worker requires a KeyProvider" boot
 * failure unless a provider was injected. A MALFORMED KEK still throws here.
 */
export const keyProviderFromKekEnv: (env: NodeJS.ProcessEnv) => KeyProvider | undefined =
  keyProviderFromEnvOptional;

/**
 * The mailbox selection implied by a config: THE SHARD, and nothing else. `config.accountId`
 * is deliberately not consulted — see the `accountId` note on `WorkerConfig`. A worker's
 * roster is always its shard's full duty, so there is no configuration in which a
 * registered account is silently served by nobody.
 */
export function selectionOf(config: WorkerConfig): MailboxSelection {
  return {
    shards: config.shards ?? DEFAULT_SHARDS,
    shardIndex: config.shardIndex ?? 0,
  };
}

/**
 * WHICH BUILD THIS IS. Moved to `./build-version.js` and re-exported here, so that
 * `sync.ts` can name the running build without dragging this module's `@trafficflow/core` barrel
 * into `apps/sidecar`'s import graph. The three-source order and the reason for it are in that
 * file; every existing importer of `buildVersionOf` is unaffected.
 */
export { buildVersionOf };

/**
 * Why the build identity is unknown, or null.
 *
 * REPORTED, NEVER THROWN, AND NEVER FOLDED INTO `healthy` — and here the worker must NOT copy
 * the API, which answers `/health` 503 for exactly this. The API's serverless platform does not
 * gate a deployment on
 * `/health`; the worker's platform DOES (the deploy manifest's health-check path, and the whole argument in
 * `health.ts`'s `evaluateHealth` header about why the bounds are generous). A 503 over a missing
 * LABEL would mean a worker that cannot say which build it is can never be deployed — turning a
 * bookkeeping gap into a refusal to ship the fix for whatever the real incident was. So this
 * rides in the JSON beside `version` and changes no verdict. `health-bounds.e2e.test.ts` pins
 * that: a snapshot with `version: "dev"` and this set is still `healthy`.
 */
export const buildIdentityErrorOf = (environment: string, version: string): string | null =>
  environment === "production" && version === "dev"
    ? "no build identity: apps/worker/BUILD_VERSION is absent from this image " +
      "(the deploy script writes it) and neither RAILWAY_GIT_COMMIT_SHA nor TF_BUILD_VERSION is set"
    : null;

/**
 * `TF_API_CRON_URL` + `TF_API_CRON_SECRET` — both-or-neither, and the URL must parse as an
 * absolute http(s) origin. The states and the argument are on {@link WorkerConfig.apiCron};
 * what is enforced HERE is that a half-set pair refuses the boot by NAME instead of quietly
 * disarming the schedule, because "configured and silently not running" is the exact failure
 * this arm exists to replace. Error messages never include the values.
 */
function apiCronFrom(env: NodeJS.ProcessEnv): { baseUrl: string; secret: string } | undefined {
  const url = env.TF_API_CRON_URL?.trim();
  const secret = env.TF_API_CRON_SECRET?.trim();
  if (!url && !secret) return undefined;
  if (!url || !secret) {
    const missing = url ? "TF_API_CRON_SECRET" : "TF_API_CRON_URL";
    throw new WorkerConfigError(missing,
      `${missing} is missing while its pair is set — TF_API_CRON_URL and TF_API_CRON_SECRET ` +
      "arm the API-cron schedule together (both or neither)");
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    throw new WorkerConfigError("TF_API_CRON_URL", "TF_API_CRON_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WorkerConfigError("TF_API_CRON_URL", "TF_API_CRON_URL must be an absolute http(s) URL");
  }
  return { baseUrl: url.replace(/\/+$/, ""), secret };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const environment = env.TF_ENV ?? env.RAILWAY_ENVIRONMENT_NAME ?? "production";
  const buildVersion = buildVersionOf(env);
  const url = req(env, "DATABASE_URL_SESSION");
  // ONE definition, imported — not the same two regexes copied here "verbatim", which is
  // how both copies went stale together. On some hosted poolers the mode is a PORT (6543 = transaction),
  // and the legitimate session URL is itself a `pooler.` host, so the old hostname shape test
  // could neither reject the wrong URL nor accept the right one for the right reason.
  const poolerReason = transactionPoolerReason(url);
  if (poolerReason) {
    throw new WorkerConfigError("DATABASE_URL_SESSION", sessionUrlRejection(poolerReason));
  }
  // env IMAP creds are optional now (bootstrap-only). Present ⇒ require the full set.
  const imap = env.IMAP_HOST ? {
    host: req(env, "IMAP_HOST"), port: Number(env.IMAP_PORT ?? 993), secure: env.IMAP_SECURE !== "false",
    user: req(env, "IMAP_USER"), pass: req(env, "IMAP_PASS"),
  } : undefined;
  const shards = optInt(env, "TF_SHARDS", DEFAULT_SHARDS);
  if (shards < 1) throw new WorkerConfigError("TF_SHARDS", "TF_SHARDS must be >= 1");
  const shardIndex = optInt(env, "TF_SHARD_INDEX", 0);
  if (shardIndex >= shards) {
    throw new WorkerConfigError("TF_SHARD_INDEX", `TF_SHARD_INDEX must be < TF_SHARDS (got ${shardIndex} of ${shards})`);
  }
  return {
    databaseUrl: url,
    // BOOTSTRAP-ONLY. It pairs with TF_MAILBOX_ID for the one-shot env-creds seed and
    // scopes the single-mailbox reconcile backstop; it can NOT shrink the worker's roster.
    accountId: env.TF_ACCOUNT_ID,
    mailboxId: env.TF_MAILBOX_ID,
    imap,
    smtp: env.SMTP_HOST ? {
      host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === "true",
      user: env.SMTP_USER, pass: env.SMTP_PASS,
    } : undefined,
    keyProvider: keyProviderFromKekEnv(env),
    kek: kekEnvIdentity(env),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 60000),
    sentDomain: env.TF_SENT_DOMAIN ?? "trafficflow.ch",
    maxMailboxes: optInt(env, "TF_MAX_MAILBOXES", DEFAULT_MAX_MAILBOXES),
    cycleLanes: cycleLanesFrom(env),
    shards,
    shardIndex,
    healthPort: optInt(env, "PORT", DEFAULT_HEALTH_PORT),
    standbyRetryMs: optInt(env, "TF_STANDBY_RETRY_MS", DEFAULT_STANDBY_RETRY_MS),
    servingNothingMaxMs: servingNothingMaxMsFrom(env),
    rosterIntervalMs: optInt(env, "TF_ROSTER_INTERVAL_MS", DEFAULT_ROSTER_INTERVAL_MS),
    lockHeartbeatMs: optInt(env, "TF_LOCK_HEARTBEAT_MS", DEFAULT_LOCK_HEARTBEAT_MS),
    syncBlockGraceMs: syncBlockGraceMsFrom(env),
    leaseUnavailableDetachMs: leaseUnavailableDetachMsFrom(env),
    mailboxRetryMs: optInt(env, "TF_MAILBOX_RETRY_MS", DEFAULT_MAILBOX_RETRY_MS),
    maxSyncFailures: optInt(env, "TF_MAX_SYNC_FAILURES", DEFAULT_MAX_SYNC_FAILURES),
    // Exchange/M365 OAuth2 — the ENV BOOTSTRAP for the application registration. The authority is
    // the `oauth_provider_config` row when there is one; these values are what a deployment with no
    // row (or an operator locked out of the console) falls back to, and `resolveOAuthProviderConfig`
    // owns that precedence for BOTH this process and the API.
    //
    // Read through `msOAuthEnv`, which is also what the API host calls, so the two accept exactly the
    // same variable names — including the `MICROSOFT_*` aliases. A worker that accepted only
    // `MS_OAUTH_CLIENT_SECRET` while the API accepted `MICROSOFT_CLIENT_SECRET` is the same
    // split-brain as a precedence disagreement, arrived at through spelling.
    //
    // All of them default to empty; the token client names the one that is missing only when an oauth
    // mailbox needs it. NOT validated here, for the same reason — an unset value is legitimate on a
    // password-only deployment.
    msOAuth: {
      ...msOAuthEnv(env as Record<string, string | undefined>),
      tenant: msOAuthEnv(env as Record<string, string | undefined>).tenant || "common",
    },
    instanceId: instanceIdFrom(env),
    environment,
    buildVersion,
    buildError: buildIdentityErrorOf(environment, buildVersion),
    organizer: {
      ...(env.TF_ORGANIZER_INSTALL_ID ? { installId: env.TF_ORGANIZER_INSTALL_ID } : {}),
      ...(env.TF_LEASE_STALE_MS ? { staleAfterMs: optInt(env, "TF_LEASE_STALE_MS", 0) } : {}),
      ...(env.TF_PROFILE_FLUSH_MS ? { profileFlushIntervalMs: optInt(env, "TF_PROFILE_FLUSH_MS", 0) } : {}),
    },
    alertWebhookUrl: env.TF_ALERT_WEBHOOK_URL,
    alertEmail: env.TF_ALERT_EMAIL,
    alertTelegramBotToken: env.TF_ALERT_TELEGRAM_BOT_TOKEN,
    alertTelegramChatId: env.TF_ALERT_TELEGRAM_CHAT_ID,
    mailFrom: env.MAIL_FROM,
    resendApiKey: env.RESEND_API_KEY,
    alertIntervalMs: optInt(env, "TF_ALERT_INTERVAL_MS", DEFAULT_ALERT_INTERVAL_MS),
    apiCron: apiCronFrom(env),
    ...loadAttachmentStagingConfig(env),
    ...loadAiPorts(env),
  };
}

/** The staging store this worker sweeps — the API host's `StorageConfig`, kind for kind. */
export type WorkerStagingStorage =
  | { kind: "supabase"; url: string; serviceKey: string; bucket: string }
  | { kind: "s3"; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string };

/**
 * The staging store's variables, spelled exactly as the API host spells them — the same rule
 * `msOAuthEnv` exists to enforce for the OAuth registration. Two hosts that accepted different
 * names for one bucket is a split-brain reached through spelling: the API would mint grants into
 * a bucket the worker never sweeps.
 *
 * Three shapes, and the asymmetry between them is deliberate:
 *
 *  · **Kind-less legacy** — the SUPABASE trio with no `TF_STORAGE_KIND` — keeps its DEPLOYED
 *    semantics untouched: all-or-nothing detection, a malformed URL degrades to "no staging"
 *    (the maintenance pass reports the skip). This is the managed environment as it runs today.
 *  · **An explicit kind** refuses a partial or malformed block instead of degrading, exactly as
 *    the API host does — under an explicit kind, "somebody configured this and got it wrong" is
 *    the only reading, and a worker that silently swept nothing while the API minted happily
 *    would be the unbounded-bucket failure this loader exists to prevent.
 *  · **`S3_*` variables with NO kind refuse** rather than being ignored: there is no legacy s3
 *    shape, so that state is always a configuration error naming the fix.
 */
function loadAttachmentStagingConfig(
  env: NodeJS.ProcessEnv,
): Pick<WorkerConfig, "attachmentStaging"> {
  const t = (k: string): string => (env[k] ?? "").trim();
  const kind = t("TF_STORAGE_KIND");

  const S3_VARS = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"] as const;

  if (kind === "") {
    const strayS3 = S3_VARS.filter((v) => t(v) !== "");
    if (strayS3.length > 0) {
      throw new Error(
        `storage variables are set but TF_STORAGE_KIND is not (set it to "supabase" or "s3"): ${strayS3.join(", ")}`,
      );
    }
    // The legacy managed shape, byte for byte: silent degradation, never a refusal.
    const url = t("SUPABASE_URL").replace(/\/+$/, "");
    const serviceKey = t("SUPABASE_SERVICE_ROLE_KEY");
    const bucket = t("TF_ATTACHMENT_STAGING_BUCKET");
    if (!url || !serviceKey || !bucket) return {};
    if (!/^https:\/\/[^/?#]+$/.test(url)) return {};
    return { attachmentStaging: { kind: "supabase", url, serviceKey, bucket } };
  }

  const requireAll = (vars: readonly string[]): void => {
    const missing = vars.filter((v) => t(v) === "");
    if (missing.length > 0) {
      throw new Error(`TF_STORAGE_KIND=${kind} needs all of ${vars.join(", ")} — missing: ${missing.join(", ")}`);
    }
  };

  if (kind === "supabase") {
    requireAll(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TF_ATTACHMENT_STAGING_BUCKET"]);
    const url = t("SUPABASE_URL").replace(/\/+$/, "");
    if (!/^https:\/\/[^/?#]+$/.test(url)) throw new Error("SUPABASE_URL must be a bare https origin");
    return {
      attachmentStaging: {
        kind: "supabase", url,
        serviceKey: t("SUPABASE_SERVICE_ROLE_KEY"),
        bucket: t("TF_ATTACHMENT_STAGING_BUCKET"),
      },
    };
  }

  if (kind === "s3") {
    requireAll(S3_VARS);
    // Same boot-time endpoint validation as the API host, same reason restated for the sweep:
    // the client is a local signer, so a malformed endpoint would construct fine and then fail
    // every DELETE — a sweep that runs hourly and removes nothing.
    const endpoint = t("S3_ENDPOINT");
    let endpointUrl: URL | null = null;
    try {
      endpointUrl = new URL(endpoint);
    } catch { /* refused below */ }
    if (!endpointUrl || (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:")
      || endpointUrl.hostname === "") {
      throw new Error("S3_ENDPOINT must be an absolute http(s) URL, e.g. http://minio:9000");
    }
    return {
      attachmentStaging: {
        kind: "s3", endpoint,
        region: t("S3_REGION"),
        accessKeyId: t("S3_ACCESS_KEY_ID"),
        secretAccessKey: t("S3_SECRET_ACCESS_KEY"),
        bucket: t("S3_BUCKET"),
      },
    };
  }

  throw new Error('TF_STORAGE_KIND must be "supabase" or "s3" (or unset for no object storage)');
}

/**
 * The AI block — **all three ports, or none**, from one variable.
 *
 * ## Why one key gives three ports and not a choice of three
 *
 * The three model calls are not independently useful. Classify without draft is a router that
 * cannot answer; draft without classify is an assistant on a mailbox nobody sorted. The plan
 * card sells "AI actions", one allowance across all of them, and the ledger meters them through
 * one gate — so "which of the three is on" was never a deployment decision anybody should be
 * able to make by accident. One variable, three ports, and the only two states are the two that
 * make sense: managed AI on, or a rules-only deployment.
 *
 * ## Why a bad key is a REFUSAL TO BOOT, not a degradation
 *
 * The same argument `loadBillingConfig` makes about a half-configured Stripe block. **Absent**
 * is a legitimate deployment — a preview, a local run, the desktop tier's engine — so it yields
 * `{}` and the worker syncs mail with no AI, exactly as it does today. **Present but malformed**
 * is a deployment somebody tried to configure and got wrong, and the failure it produces is
 * invisible: every classify would throw, the circuit breaker would (correctly) degrade to
 * rules-only, and the deployment would look healthy while silently selling an AI product that
 * never runs. `assertAnthropicKey` names the variable and never the value.
 *
 * `onUsage` is wired to the worker's own logger at construction in `index.ts`, so every metered
 * call's token counts and estimated cost land in the structured log.
 */
export function loadAiPorts(
  env: NodeJS.ProcessEnv,
  log?: Logger,
): Pick<WorkerConfig, "classifier" | "drafter" | "proposer"> {
  const raw = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (raw === "") return {};
  // ── THE ARMING GUARD: managed AI does not come up against a FLAT debit schedule ────────────
  //
  // The rule is older than the mechanism — managed AI must not arm before the weighted prices
  // land — and while it lived only in prose it was one revert away from being untrue. This is
  // the worker's half of it, placed where the key is parsed rather than where a spend happens,
  // because the whole point is to refuse at BOOT: a guard at first spend would let the process
  // come up healthy, sync mail, and only then start under-charging.
  //
  // The worker is the metered arm for three of the four priced reasons (classify, workflow steps,
  // the proposer pass), so a flat schedule here would meter a workflow draft at a fifteenth of
  // what it costs — an allowance that costs more than the tier earns, with every gate working
  // perfectly. It throws for the reason `loadAiPorts` already throws on a malformed key: a
  // deployment somebody configured wrong must fail loudly, not sell an AI product whose
  // metering is quietly wrong. After the weighted schedule shipped this passes by construction.
  assertWeightedScheduleActive();
  const client = makeAnthropicClient({
    apiKey: assertAnthropicKey(raw),
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    // A hung model call blocks the worker's SERIAL cycle queue, and therefore every other
    // mailbox in this process — so the per-attempt deadline here is a liveness property of the
    // whole worker, not a per-request nicety. Two retries at 30 s bounds one classify at ~90 s
    // plus backoff, and the circuit opens after two of those.
    timeoutMs: optInt(env, "TF_AI_TIMEOUT_MS", 30_000),
    log,
  });
  return {
    classifier: makeHaikuClassifier({ client }),
    drafter: makeSonnetDrafter(client),
    proposer: makeOpusProposer(client),
  };
}

/**
 * A stable-per-process identity for logs and for the heartbeat row.
 *
 * The platform-injected `RAILWAY_REPLICA_ID` first (it survives a restart of the same replica and is what
 * the platform's dashboard shows), then the container hostname, then a random suffix. The last fallback
 * matters more than it looks: during a rolling deploy two instances exist, and two beats
 * written under the identity `"unknown"` are indistinguishable — which would make the one
 * genuinely useful line ("who is the leader right now") a coin flip.
 */
export function instanceIdFrom(env: NodeJS.ProcessEnv = process.env): string {
  const railway = env.RAILWAY_REPLICA_ID ?? env.RAILWAY_DEPLOYMENT_ID;
  if (railway && railway.trim() !== "") return railway.trim().slice(0, 64);
  try {
    const host = hostname();
    if (host && host.trim() !== "") return host.trim().slice(0, 64);
  } catch { /* no hostname in this sandbox — fall through */ }
  return `worker-${Math.random().toString(36).slice(2, 10)}`;
}
