import { hostname } from "node:os";
import {
  keyProviderFromEnvOptional, kekFingerprint, kekFingerprintFromEnv, kekEnvIdentity,
  makeAnthropicClient, assertAnthropicKey, makeHaikuClassifier, makeSonnetDrafter, makeOpusProposer,
  callCeilingMs, msDeviceEnv, organizerEnvironment, resolveCloudInstallId,
  type KeyProvider, type ClassifierPort, type DraftPort, type WorkflowPort,
  type KekEnvIdentity, type Logger, type AnthropicCallReport,
} from "@trafficflow/core";
import { transactionPoolerReason, sessionUrlRejection } from "@trafficflow/db";
import { DEFAULT_ALERT_THRESHOLDS, msOAuthEnv, WORKER_POOL_MAX, type PostJson } from "@trafficflow/db/cloud";
import { assertWeightedScheduleActive } from "@trafficflow/db";
import type { MailboxAdapter, ImapConfig } from "@trafficflow/core/adapters/imap";
import { buildIdentityOf, buildVersionOf, type BuildIdentitySource } from "./build-version.js";
import type { MailboxSelection } from "./mailboxes.js";
import type { ThreadBackfillPass } from "./thread-backfill.js";

/** One IMAP IDLE connection per mailbox lives in this process — cap it. */
export const DEFAULT_MAX_MAILBOXES = 64;
/** Shipped shard configuration: ONE shard (the seam exists, it is not used yet). */
export const DEFAULT_SHARDS = 1;
/**
 * How many mailboxes one cycle may be visiting at once. `cycle()` used to walk its rotation one at a
 * time, so EVERY mailbox waited out every other's bounded batch — measured twice on one shard: most
 * of the shard past the 15-minute `sync_lag` threshold during a backfill, and a 15.5-minute gap
 * between visits on a wake channel that answers in under a second. THREE, every term measured: the
 * POOL is the ceiling ({@link WORKER_POOL_MAX} minus {@link CYCLE_LANE_POOL_RESERVE}; postgres.js
 * QUEUES on an exhausted pool, so wider silently stops being concurrency); the SPEEDUP is bounded by
 * the slowest mailbox anyway (~782 s serial → ~260 s over three lanes, past which lanes buy nothing);
 * and one lane is RESERVED for mailboxes with no backlog ({@link CYCLE_FAST_LANES}). `1` restores the earlier serial walk, which the ordering guards that predate the lanes are pinned to.
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
 * Lanes a mailbox that OWES A BACKLOG may never occupy — the reservation that makes a fast lane a
 * fast lane. Without it, three cold backfills fill three lanes and a mailbox whose IDLE just fired is
 * behind a deep batch again (the 15.5-minute measurement with a smaller constant); with it, a mailbox
 * with nothing queued is never behind more than the ONE other quick mailbox in the reserved lane. ONE,
 * not more: at three lanes, reserving two would leave a single lane to drain every backfill and make
 * the deep-backlog case worse than the serial walk it replaces. The guard asserts BOTH directions.
 */
export const CYCLE_FAST_LANES = 1;
/**
 * How many extra turns one mailbox may earn inside a single cycle by being woken. Lanes shorten a
 * rotation, not a CYCLE: one `cycle()` entry runs until every mailbox has had its turn, so a mailbox
 * whose doorbell rings after its turn waits for the slowest lane (~254 s) — a large improvement on
 * 15.5 and still not what the wake channel promises. So an unserved wake may be re-admitted inside the
 * pass it already had a turn in, usually immediately because {@link CYCLE_FAST_LANES} holds a lane
 * back. BOUNDED: `servedIds` keeps a live queue FINITE and this is a hole in it, so a re-admission
 * spends the wake and this floors it too (a cycle that never ends is a roster pass that never runs).
 * FOUR is deliberately small — past it the mailbox keeps its wake and leads the next pass.
 */
export const CYCLE_WAKE_REVISITS = 4;
/** Standby lock-retry backoff — a hot spare re-tries every 15 s. */
export const DEFAULT_STANDBY_RETRY_MS = 15_000;
/**
 * How long an instance may SERVE NOTHING before `/health` stops calling it healthy. Two states are
 * measured against it (`evaluateHealth` in `health.ts`): an instance waiting for the leader lock this
 * long, and a leader with mailboxes to serve that served none this long. Before this bound both
 * answered 200 for ever (a wedge and a hot spare are the same snapshot; the second required a
 * quarantine on record), and an eight-minute outage went unannounced behind a green probe. TWO
 * MINUTES, load-bearing both ways: a measured deploy handover is ~5 s (so a hot spare is 23× inside
 * the bound and still 200 — kill that and no deployment can go active), and it is above the platform's
 * 60 s health-check timeout, so the platform's own clock fails a pathological deploy first ({@link MIN_SERVING_NOTHING_MAX_MS}).
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
 * How stale the leader's last COMPLETED cycle may go, with mailboxes connected, before `/health`
 * reports `degraded` — never unhealthy. The platform gates a deployment on this endpoint and never
 * re-probes, so a slow cycle must not refuse a deploy; what it must stop doing is hiding. The blind
 * spot it closes: `serving_nothing` requires `connected === 0`, so a leader whose mailboxes were all
 * attached but whose cycle had stopped completing read `healthy: true` for ever (measured at
 * `lagSeconds: 560` during a cold backfill). EIGHT MINUTES, both ways: a first post-takeover cycle is
 * ~5 minutes and the rule keys on `lastCycleAt` (a COMPLETED cycle, so it cannot trip on the first),
 * and it stays below `syncLagMs` (15 min) so `/health` turns amber before the pager fires. Wall clock.
 */
export const DEFAULT_STALE_CYCLE_MAX_MS = 480_000;
/** Health-server port when the platform does not inject `PORT`. */
export const DEFAULT_HEALTH_PORT = 8080;
/** How often the leader re-reads the mailbox roster: registrations, disables, deletions. */
export const DEFAULT_ROSTER_INTERVAL_MS = 30_000;
/**
 * How long a mailbox may go unserved before its row has to say so (mail 0029). A DURATION, not a
 * count of passes: "after N roster passes" is a proxy for time that silently retunes itself whenever
 * {@link DEFAULT_ROSTER_INTERVAL_MS} changes (N = 4 is two minutes today, eight the day somebody
 * quadruples the roster interval), so the property measured in wall clock has a knob in wall clock.
 * And it must stay below `DEFAULT_ALERT_THRESHOLDS.syncLagMs` (15 min): the `sync_lag` alert fires when
 * an on-duty mailbox has not synced for `syncLagMs`, and the row is the only thing that can EXPLAIN
 * that alert — set the grace above the threshold and the page arrives while the row is still pristine.
 * The constraint is ASSERTED (`config.test.ts`), and {@link syncBlockGraceMsFrom} refuses an env value that breaks it.
 */
export const DEFAULT_SYNC_BLOCK_GRACE_MS = 120_000;
/**
 * How long a cycle may keep failing to read the organizer lease before the mailbox is detached. In
 * one incident every served mailbox emitted over a hundred `sync_cycle_lease_unavailable` over most
 * of an hour and healed only on restart: `LeaseUnavailableError` is exempt from `maxSyncFailures` BY
 * CLASS (correct — an infrastructure fault must never write `status='error'`), so with nothing
 * bounding the exempt arm a permanently dead connection was retried for ever. Past this the runtime is
 * DETACHED, not quarantined, and the next pass re-attaches (attach IS reconnect). A DURATION, not a
 * count of cycles ({@link DEFAULT_SYNC_BLOCK_GRACE_MS}'s reason), and it must stay below `syncLagMs`
 * so the system heals before the alert (asserted in `config.test.ts`, refused by {@link leaseUnavailableDetachMsFrom}).
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
  /**
   * Where this host asks about money, or `null` on a deployment that meters nothing. The organizer
   * charges AI actions, so it needs the same answer the API host does and reaches it the same way:
   * `ENTITLEMENTS_URL` + `BILLING_PLANE_SECRET`, present or absent as a WHOLE. `null` is a NAMED state,
   * not an unfinished composition — the spend call sites are handed `UNMETERED` and charge nothing, a
   * self-hosted or standalone install's truth. OPTIONAL, and ABSENT means the same as `null`: the one
   * place this interface collapses two states on purpose, because `loadConfig` always writes one of the
   * two and a config assembled in code is a test seam, with no third thing "unfinished" could mean.
   */
  entitlements?: { url: string; secret: string } | null;
  // accountId + mailboxId + imap are BOOTSTRAP-ONLY. The worker syncs ALL enabled mailboxes of ALL
  // accounts in its shard, reading credentials from `mailbox_credentials`. `accountId`
  // (`TF_ACCOUNT_ID`) CANNOT narrow the roster — it used to, and a stale production value would leave
  // every other account permanently unsynced (the silently-unsynced-second-account defect wearing a
  // different hat). It now only pairs with `mailboxId` to VALIDATE the legacy env mailbox during the
  // one-shot creds bootstrap and scopes the single-mailbox `reconcile-cron` backstop; `selectionOf()`
  // ignores it entirely. `mailboxId` + `imap`, when present, seed the legacy single mailbox's DB creds
  // exactly once, then are never read again.
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
   * Mail 0029: how long a mailbox this process is NOT serving may stay unexplained before the worker
   * writes `sync_blocked_reason` on its row. Default {@link DEFAULT_SYNC_BLOCK_GRACE_MS}. It exists as
   * a grace so a rolling deploy, a leader handoff or one slow first `ensureFolders` does not stamp a
   * reason onto a mailbox about to attach perfectly well; it is bounded above by `syncLagMs`, because a
   * reason that lands after the alert cannot explain it. `loadConfig` REFUSES an env value at or above
   * that bound; a programmatic config (the tests, in milliseconds) is unclamped.
   */
  syncBlockGraceMs?: number;
  /**
   * How long `cycle()` may keep failing to READ the organizer lease for one mailbox before that
   * mailbox's runtime is detached so the next roster pass re-dials it. Default {@link
   * DEFAULT_LEASE_UNAVAILABLE_DETACH_MS}. A grace because a lease read genuinely fails transiently (a
   * provider blip, a `FETCH` refused once) and detaching on the first would cost a reconnect per
   * hiccup; bounded above by `syncLagMs` because the system must heal before the page. `loadConfig`
   * REFUSES an env value at or above that bound; a programmatic config (the tests, in milliseconds) is unclamped.
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
   * The public client — `MS_DEVICE_CLIENT_ID`, and why this worker needs it. A mailbox connected
   * through the device-code flow holds a refresh token issued by the PUBLIC application registration,
   * and a refresh token is only renewable by the client that obtained it — and this process is the
   * organizer on a self-hosted install, so it must renew those tokens for ever. Without this field it
   * presents the confidential registration's client id, Microsoft refuses, and `refreshAccessToken`
   * maps a rejected client to "provider unavailable" deliberately: nothing quarantines, nothing pages,
   * the mailbox simply stops receiving mail an hour after connecting. ABSENT is ordinary and not a
   * fault (no public client, no device-connected mailboxes; one that claims otherwise is refused BY NAME). No SECRET here.
   */
  msDevice?: { clientId: string; tenant: string };
  /**
   * The staging bucket this worker sweeps — or absent on a deployment with no object storage. The
   * hosted send stages attachment bytes into a private bucket and references them; `attachment_staging`
   * rows carry a 24-hour `expires_at`, and this is the half that makes the bytes and rows go away. It
   * belongs to this process (the worker is the single ELECTED writer). ABSENT ⇒ no sweep, and a
   * REPORTED state (a deployment that stages and does not sweep grows a bucket forever, logged once).
   * The variables are the API host's exactly, KIND FOR KIND (`TF_STORAGE_KIND` selects `supabase` or
   * `s3`, each block all-or-nothing): the worker MUST speak every kind the API mints into, because it
   * is the only process that deletes. The kind-less legacy SUPABASE trio stays valid (the managed contract).
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
   * The INJECTED ClassifierPort the routing pipeline's AI branch calls. The field an earlier comment
   * said did not exist yet. Absent ⇒ rules-only routing: no AI branch, no debit — still the shipped
   * behaviour of any deployment without an `ANTHROPIC_API_KEY`. It is NOT handed to `runSyncCycle`
   * directly: `index.ts` wraps it in the per-process CIRCUIT BREAKER (`ai-circuit.ts`) and passes
   * `circuit.port()` per cycle, so a model outage degrades to rules-only instead of stalling ingest
   * and quarantining mailboxes.
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
  /**
   * The late-bound usage sink the three ports above report through. It exists because of an ORDERING
   * this app cannot rearrange: the model client is constructed while the CONFIGURATION is parsed
   * (`loadAiPorts`), and the database pool is opened later, inside `startWorkerWithLock`, from a URL
   * that configuration produced — so at the moment `onUsage` is handed to the client, there is nothing
   * to record into. A relay closes that gap without a module-level global: `loadAiPorts` hands the
   * client a dispatcher, the worker body attaches the real recorder once the pool exists, and anything
   * reported in between goes to the logger only. Absent on a rules-only deployment.
   */
  aiUsage?: AiUsageRelay;

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
   * Generic alert webhook (`TF_ALERT_WEBHOOK_URL`): ntfy.sh, a Slack/Discord hook, PagerDuty Events
   * v2 — anything that accepts a JSON POST. This is how the WORKER pages a human. It cannot use the
   * product's own mailer: the worker may import core + db only, and `MailService` lives in
   * `packages/services`; a JSON POST needs nothing but `fetch`, which is why the alert sink seam is
   * shaped this way. Unset ⇒ the worker still evaluates and LOGS alerts (structured, one line each)
   * but pages nobody, and `alerts_undeliverable` says so at warn level rather than failing silently.
   */
  alertWebhookUrl?: string;
  /**
   * The MAIL arm of the pager (`TF_ALERT_EMAIL`, armed with `RESEND_API_KEY` + `MAIL_FROM`). Added
   * when the webhook arm's endpoint (ntfy.sh) turned out to blackhole the hosting platform's egress
   * IPs — measured from inside this worker's container, 2026-08-21, while `api.resend.com` answered
   * 200 from the same place. The product IS mail, and the mailer the API host already uses is one JSON
   * POST away, so the "core + db only" import rule holds (`resendAlertSink` lives in `packages/db`).
   * `TF_ALERT_EMAIL` is the ARMING variable: unset ⇒ no mail arm quietly; set with either mailer half
   * missing ⇒ a sink that refuses every delivery naming the missing variable, so the escalation reports
   * the misconfiguration instead of a silent hole. The spellings are the API host's own.
   */
  alertEmail?: string;
  /** `MAIL_FROM` — the From the product already sends transactional mail as. */
  mailFrom?: string;
  /** `RESEND_API_KEY` — the mail arm's bearer credential. Scoped, sending-only. */
  resendApiKey?: string;
  /**
   * The PUSH arm of the pager — the pager's SECOND VENDOR (`TF_ALERT_TELEGRAM_BOT_TOKEN` +
   * `TF_ALERT_TELEGRAM_CHAT_ID`). The mail arm above left the pager single-vendor: one transactional-
   * mail account carrying every page, so that account's outage, suspension or revoked key takes the
   * pager with it at the moment something is wrong. This arm shares nothing with it — different company,
   * network, credential, and a push to a device rather than a message into the mailbox this product
   * serves. Reachability was probed from inside this worker's container (how ntfy.sh was found
   * blackholed): `api.telegram.org` answered 200 in 86 ms from the same shell. Either variable present
   * arms it; the missing half is a NAMED fault, since neither exists for any other purpose (`alert-push.ts`).
   */
  alertTelegramBotToken?: string;
  /** Where the push arm posts — a numeric chat id, or an `@channelusername`. */
  alertTelegramChatId?: string;
  /** How often the leader runs the alert pass. Default {@link DEFAULT_ALERT_INTERVAL_MS}. */
  alertIntervalMs?: number;
  /**
   * The API-cron arm (`TF_API_CRON_URL` + `TF_API_CRON_SECRET`) — this worker as the schedule for the
   * API host's internal passes (`api-cron.ts` has the whole argument: the platform cron layer those
   * routes were written for was measured dark for three weeks of deploys). `baseUrl` is the API origin
   * (`https://api.ohmail.app`); `secret` is presented as `Authorization: Bearer …` and must match the
   * API host's `TF_ALERT_SECRET` or `CRON_SECRET`. Both-or-neither, enforced in `loadConfig`: neither
   * ⇒ quiet disarm (a self-hosted compose beside a cron-capable host has no use for this), exactly one
   * ⇒ a NAMED refusal — like the Telegram pair, one being set can only mean somebody meant to arm it,
   * and a half-armed schedule that quietly does nothing is the dark-cron failure this replaces.
   */
  apiCron?: { baseUrl: string; secret: string };
  // ── The organizer lease (mail migration 0027) ───────────────────────────────────────
  /**
   * Who this Cloud deployment is, as an organizer of a mailbox. Every field has a safe default and
   * none is normally set. `installId` in particular MUST stay stable across restarts, deploys and
   * migrations — read the block above `cloudInstallId` in `lease.ts` before overriding it, because the
   * failure mode of an unstable one is that every leader failover disables a customer's mailbox.
   * `TF_ORGANIZER_INSTALL_ID` exists for the one case the default cannot serve: a self-hosted Cloud
   * organizing the same mailbox as ours. `TF_LEASE_STALE_MS` exists for tests, which cannot wait out a
   * ten-minute window.
   */
  organizer?: {
    /** ALWAYS SET by `loadConfig`, through `resolveCloudInstallId` — see the note at the read. */
    installId: string;
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
 * A configuration failure, NAMED — so the crash handler can report which variable is wrong without
 * printing the message. `packages/core/src/log.ts` reduces a thrown value to class + code and refuses
 * the message, for reasons that apply here too (`DATABASE_URL_SESSION` is a connection string and
 * several of these messages quote their input) — but "the worker did not boot, class Error, code null"
 * is not an operational answer, and a boot failure is exactly when there is nothing else to go on. The
 * variable's NAME is safe (we chose it, it is in the deploy manifest) and is the whole of what a human
 * needs, so it rides on the error as a field the handler logs deliberately; the `message` keeps its
 * original wording for a developer reading a stack locally.
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
 * The one place a lane count becomes a number of concurrent cycles. Both entry points go through it,
 * and it CLAMPS rather than trusting — different from how the millisecond knobs treat a programmatic
 * value. Those knobs bound a CLAIM (a row that explains an alert, a deploy the platform is waiting on)
 * and a test setting an absurd one only makes its own assertions strange. This one bounds a RESOURCE
 * shared with the pulse, the alert pass and the customer's provider, whose failure mode is invisible:
 * postgres.js queues, so a worker configured 32 lanes wide reports 32 cycles in flight while five make
 * progress and 32 IMAP connections stream at once. A clamp and not a throw HERE because the throw
 * belongs at the env boundary ({@link cycleLanesFrom}).
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
 * `TF_SYNC_BLOCK_GRACE_MS`, with the bound that keeps "the row explains the alert" true. A REFUSAL TO
 * BOOT rather than a clamp, for {@link servingNothingMaxMsFrom}'s reason: silently lowering somebody's
 * 20 minutes to 15 leaves a deployment whose behaviour does not match what its operator configured,
 * and the variable is named in the error so the fix is one line. The comparison is against
 * `DEFAULT_ALERT_THRESHOLDS.syncLagMs` — the SAME constant the alert pass evaluates — so tuning either
 * number cannot quietly invert the relationship. The config suite asserts the same inequality about
 * the DEFAULT, the half an env-var check cannot cover.
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
 * `TF_LEASE_UNAVAILABLE_DETACH_MS`, with the bound that keeps "the system heals before the page" true.
 * A REFUSAL TO BOOT rather than a clamp, for {@link syncBlockGraceMsFrom}'s reason. The comparison is
 * against the SAME `DEFAULT_ALERT_THRESHOLDS.syncLagMs` the alert pass evaluates, so tuning either
 * number cannot quietly invert the relationship: a detach bound at or above the alert threshold makes
 * the measured hour-long do-nothing loop reachable from configuration alone, with a green suite.
 * `test/config.test.ts` asserts the same inequality about the DEFAULT, the half an env-var check cannot cover.
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
export { buildIdentityOf, buildVersionOf };
export type { BuildIdentitySource };

/**
 * Why the build identity is unknown, or null. REPORTED, NEVER THROWN, and never folded into
 * `healthy` — and here the worker must NOT copy the API, which answers `/health` 503 for this. The
 * API's serverless platform does not gate a deployment on `/health`; the worker's DOES (the deploy
 * manifest's health-check path, and `health.ts`'s `evaluateHealth` header on why the bounds are
 * generous). A 503 over a missing LABEL would mean a worker that cannot say which build it is can never
 * be deployed — a bookkeeping gap turned into a refusal to ship the fix for the real incident. So this
 * rides in the JSON beside `version` and changes no verdict (`health-bounds.e2e.test.ts`: a snapshot
 * with `version: "dev"` and this set is still `healthy`).
 */
export const buildIdentityErrorOf = (
  environment: string,
  version: string,
  source: BuildIdentitySource = version === "dev" ? "none" : "file",
): string | null => {
  if (environment !== "production") return null;
  if (source === "none" || version === "dev") {
    return "no build identity: apps/worker/BUILD_VERSION is absent from this image " +
      "(the deploy script writes it) and neither RAILWAY_GIT_COMMIT_SHA nor TF_BUILD_VERSION is set";
  }
  // The arm that had to be added, and the incident that added it. A variable-sourced label is the
  // state this whole module was built to make impossible, and for ten days it was the state production
  // was ACTUALLY in while reporting no fault: the file never reached the image, the variable answered
  // in its place, and `version` named a commit the running image was never built from. The old rule
  // fired only on the literal string `dev`, so the fallback silently DEFEATED the detector it was
  // supposed to trigger — an absent label converted into a present, wrong one, the worse of the two.
  // Reported, never thrown, for the arm above's reason (the platform gates the deployment on this
  // endpoint). `version` still carries the variable's value (the operator's stated intent); what
  // changes is that the JSON no longer presents it as an identity read out of the artifact.
  if (source === "variable") {
    return "build identity came from TF_BUILD_VERSION, not from the image: " +
      "apps/worker/BUILD_VERSION is absent from this container, so `version` names whatever " +
      "the variable was last set to and may name a build this image was never built from";
  }
  return null;
};

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
  // A BARE ORIGIN, refused otherwise — not normalized silently. A path would survive boot and
  // then malform every target (`https://host/base` + `/internal/…` → `/base/internal/…`, 404s
  // for ever, which the /health surface would at least show but nobody should have to read);
  // embedded credentials or a query are copy-paste accidents that must not ride every request.
  if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/"
    || parsed.search !== "" || parsed.hash !== "") {
    throw new WorkerConfigError("TF_API_CRON_URL",
      "TF_API_CRON_URL must be a bare origin (scheme://host[:port]) — no path, query, fragment or credentials");
  }
  // The bearer is a privileged credential and must not cross a public network unencrypted.
  // Plain http is allowed only where TLS is genuinely absent by design: loopback, and
  // single-label DNS hosts (a compose-internal service name like `api` has no dot; a public
  // host does). The IP-literal check comes FIRST, because "no dot" alone would wave a global
  // IPv6 literal through — `[2606:4700:4700::1111]` contains no dot and is not local (review
  // finding, watched red). An IPv6 literal is local only as the loopback itself; any IPv4
  // literal other than 127.0.0.1 carries dots and falls to the refusal below anyway.
  if (parsed.protocol === "http:") {
    const h = parsed.hostname;
    const ipv6Literal = h.includes(":");
    const local = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
      || (!ipv6Literal && !h.includes("."));
    if (!local) {
      throw new WorkerConfigError("TF_API_CRON_URL",
        "TF_API_CRON_URL over plain http is allowed only for loopback or single-label " +
        "(compose-internal) hosts — a public endpoint must be https, or the bearer travels in cleartext");
    }
  }
  // `origin` rather than the raw string: one canonical spelling (no trailing slash, lowercased
  // host), so `${baseUrl}${route}` is well-formed by construction.
  return { baseUrl: parsed.origin, secret };
}

/**
 * The entitlements block — the same two variables and the same all-or-nothing rule the API host
 * validates, because a half-configured host would charge nobody while looking configured.
 *
 * Bare https origin, no path (the client appends `/v1/…`), no credentials, no query.
 */
function loadEntitlements(env: NodeJS.ProcessEnv): { url: string; secret: string } | null {
  const raw = (env.ENTITLEMENTS_URL ?? "").trim();
  if (raw === "") return null;
  const secret = (env.BILLING_PLANE_SECRET ?? "").trim();
  if (secret === "") {
    throw new WorkerConfigError("BILLING_PLANE_SECRET",
      "ENTITLEMENTS_URL is set without BILLING_PLANE_SECRET — the entitlements endpoints are the "
      + "entitlements program's own and its bearer is that secret");
  }
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new WorkerConfigError("ENTITLEMENTS_URL", "ENTITLEMENTS_URL must be an absolute https URL");
  }
  if (url.protocol !== "https:") {
    throw new WorkerConfigError("ENTITLEMENTS_URL", "ENTITLEMENTS_URL must use https — the bearer rides every request");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new WorkerConfigError("ENTITLEMENTS_URL",
      "ENTITLEMENTS_URL must be a bare origin with no path, query, fragment or credentials");
  }
  return { url: url.origin, secret };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  /* ONE DEFINITION, IMPORTED. This was a fourth copy of the same three-way fallback, and copies
     of it had already drifted: two repair commands read `TF_ENVIRONMENT`, a variable spelled
     nowhere else, so on any deployment that is not production they claimed the lease under a
     DIFFERENT organizer identity than the worker they were repairing for. `organizerEnvironment`
     is the only place this chain is written; `no-direct-environment-reads.test.ts` keeps it that
     way. */
  const environment = organizerEnvironment(env);
  const { version: buildVersion, source: buildVersionSource } = buildIdentityOf(env);
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
    entitlements: loadEntitlements(env),
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
    // Exchange/M365 OAuth2 — the ENV BOOTSTRAP for the application registration. The authority is the
    // `oauth_provider_config` row when there is one; these values are what a deployment with no row (or
    // an operator locked out of the console) falls back to, and `resolveOAuthProviderConfig` owns that
    // precedence for BOTH this process and the API. Read through `msOAuthEnv`, which is what the API
    // host calls, so the two accept exactly the same variable names — including the `MICROSOFT_*`
    // aliases (a worker accepting only `MS_OAUTH_CLIENT_SECRET` while the API accepts
    // `MICROSOFT_CLIENT_SECRET` is split-brain through spelling). All default to empty; the token
    // client names the one missing only when an oauth mailbox needs it. NOT validated here — an unset
    // value is legitimate on a password-only deployment.
    msOAuth: {
      ...msOAuthEnv(env as Record<string, string | undefined>),
      tenant: msOAuthEnv(env as Record<string, string | undefined>).tenant || "common",
    },
    // The PUBLIC client, read through the same one reader the API host calls (`msDeviceEnv`), so
    // the two cannot accept different spellings — the `msOAuthEnv` rule applied to the second
    // registration. `null` becomes an absent field: a worker with no public client is the ordinary
    // case, and the refusal for a device mailbox that arrives anyway is named at token time.
    ...(msDeviceEnv(env as Record<string, string | undefined>)
      ? { msDevice: msDeviceEnv(env as Record<string, string | undefined>)! }
      : {}),
    instanceId: instanceIdFrom(env),
    environment,
    buildVersion,
    buildError: buildIdentityErrorOf(environment, buildVersion, buildVersionSource),
    organizer: {
      /* THROUGH THE ONE FUNCTION, and always set rather than spread in when present.
         This read the override with a TRUTHY test while `resolveCloudInstallId` rejects one that
         is only whitespace — so `TF_ORGANIZER_INSTALL_ID=" "` made the worker claim mailboxes as
         `" "` while the API tier and both repair commands identified as `ohmail-cloud:<env>`.
         Two identities in one fleet is the failure the id was added to prevent: live-twin
         detection compares the wrong one, the release refuses, and the claim removal — which
         matches on the id — finds nothing to remove.
         Setting it unconditionally also retires three `?? cloudInstallId(...)` fallbacks that
         each re-derived the identity at their own call site. */
      installId: resolveCloudInstallId(env),
      // How this deployment names itself in somebody's mailbox. `organizer.displayName` has been TYPED
      // since the lease landed and was never read from the environment, so `leaseSelfFor` fell through
      // to `CLOUD_DISPLAY_NAME` — and every self-hosted deployment wrote "ohmail Cloud" into its
      // customers' `ohmail/_meta` and onto the reader banner of every install they own: a person
      // running their own server was told a service they are not a customer of had taken their mailbox.
      // Read here and DEFAULTED FROM THE ORIGIN rather than left empty: an operator who sets nothing
      // gets the host they deployed (`mail.example.com`), true and recognisable, not a false brand
      // name (`deploy/selfhost` sets `TF_ORGANIZER_DISPLAY_NAME` from `OHMAIL_ORIGIN` so it is visible
      // in the compose file). The value ends up in an RFC822 header, so it is bounded at the write site.
      ...(organizerDisplayNameFrom(env) ? { displayName: organizerDisplayNameFrom(env)! } : {}),
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
 * The staging store's variables, spelled exactly as the API host spells them — the `msOAuthEnv` rule
 * for the bucket. Two hosts accepting different names for one bucket is split-brain through spelling:
 * the API would mint grants into a bucket the worker never sweeps. Three shapes, and the asymmetry is
 * deliberate: kind-less LEGACY (the SUPABASE trio with no `TF_STORAGE_KIND`) keeps its DEPLOYED
 * semantics (all-or-nothing detection, a malformed URL degrades to "no staging"); an EXPLICIT KIND
 * refuses a partial or malformed block instead of degrading, because "somebody configured this and got
 * it wrong" is the only reading and a silent no-sweep is the unbounded-bucket failure; and `S3_*`
 * with NO kind refuses (there is no legacy s3 shape, so that state is always a configuration error).
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
 * The AI block — all three ports, or none, from one variable. The three model calls are not
 * independently useful (classify without draft is a router that cannot answer, draft without classify
 * an assistant on a mailbox nobody sorted), the plan card sells "AI actions" as one allowance, and the
 * ledger meters them through one gate — so "which of the three is on" was never a deployment decision
 * anybody should make by accident. A bad key is a REFUSAL TO BOOT, not a degradation: ABSENT is a
 * legitimate deployment (a preview, the desktop engine) and yields `{}`, while PRESENT BUT MALFORMED is
 * invisible — every classify would throw, the breaker would degrade to rules-only, and the deployment
 * would look healthy while selling an AI product that never runs. `assertAnthropicKey` names the variable.
 */
/**
 * The classifier's per-ATTEMPT deadline. Read here rather than inlined at the client so the claim
 * TTL can be sized against the same number: `AI_CLAIM_TTL_MS` was once set against this value
 * MISTAKEN for a whole-call ceiling, and a lease shorter than the call it covers hands a live
 * holder's work to a second caller who then buys a second provider call for one credit.
 * `classifyCallCeilingMs` turns it into the real bound, and this app's own test suite asserts the
 * two stay ordered: raising the timeout past the claim's lifetime fails there rather than in
 * production billing.
 */
export const AI_CLASSIFY_TIMEOUT_MS_DEFAULT = 30_000;

/**
 * The WORST-CASE wall time one worker classification can take, from this deployment's own
 * configuration — every attempt at its full deadline plus every honoured `retry-after`.
 *
 * `maxRetries` is deliberately absent from the client construction below, so the client's default
 * applies and `callCeilingMs` uses the same default. Passing it here explicitly would create a
 * second place for the two to disagree, which is the shape of the defect this exists to prevent.
 */
export function classifyCallCeilingMs(env: NodeJS.ProcessEnv): number {
  return callCeilingMs({ timeoutMs: optInt(env, "TF_AI_TIMEOUT_MS", AI_CLASSIFY_TIMEOUT_MS_DEFAULT) });
}

/**
 * THE USAGE RELAY — a one-slot dispatcher between the model client and a recorder that does not
 * exist yet.
 *
 * Not a global and not a timer: it holds one nullable function and forwards to it. Before
 * `attach`, every report goes to the logger and nowhere else, which is the honest behaviour for
 * the window in question — a handful of calls at most, before the first sync cycle can run.
 */
export interface AiUsageRelay {
  /** The `onUsage` handed to the client at construction. Never throws. */
  readonly onUsage: (report: AnthropicCallReport) => void;
  /** Install the real sink once the database pool exists. */
  attach(sink: (report: AnthropicCallReport) => void): void;
}

function makeAiUsageRelay(log?: Logger): AiUsageRelay {
  let sink: ((report: AnthropicCallReport) => void) | null = null;
  return {
    onUsage(report) {
      // BOTH, and the log line first — it is the per-call forensic record (it carries the
      // provider's `request-id`, the only handle their support can act on) and it must not
      // depend on a recorder having been attached. The claim that this line existed on the
      // worker was FALSE before cloud 0029: `loadAiPorts(env)` was called with one argument, so
      // the client's `log?.info` default resolved to `undefined?.` and the arm that makes most
      // of this product's model calls wrote its costs nowhere at all.
      log?.info("ai_call", { ...report });
      // A sink that throws is not allowed to become the outcome of a model call — the client
      // guards this too, and a second guard here costs nothing and documents the rule at the
      // one place a future sink will be added.
      try { sink?.(report); } catch { /* observability is never load-bearing */ }
    },
    attach(next) { sink = next; },
  };
}

export function loadAiPorts(
  env: NodeJS.ProcessEnv,
  log?: Logger,
): Pick<WorkerConfig, "classifier" | "drafter" | "proposer" | "aiUsage"> {
  const raw = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (raw === "") return {};
  // The arming guard: managed AI does not come up against a FLAT debit schedule. The rule is older
  // than the mechanism — managed AI must not arm before the weighted prices land — and while it lived
  // only in prose it was one revert away from being untrue. This is the worker's half, placed where the
  // key is parsed rather than where a spend happens, because the whole point is to refuse at BOOT: a
  // guard at first spend would let the process come up healthy, sync mail, and only then under-charge.
  // The worker is the metered arm for three of the four priced reasons, so a flat schedule here would
  // meter a workflow draft at a fifteenth of what it costs. It throws for `loadAiPorts`' reason: a
  // deployment configured wrong must fail loudly, not sell an AI product whose metering is quietly
  // wrong. After the weighted schedule shipped this passes by construction.
  assertWeightedScheduleActive();
  const aiUsage = makeAiUsageRelay(log);
  const client = makeAnthropicClient({
    apiKey: assertAnthropicKey(raw),
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    // The base URL decides where the API key and the reader's mail go, so it is gated by the
    // repository's address rules inside `makeAnthropicClient` — a wrong value fails this boot.
    // `=== "1"` exactly, like `TF_PUSH_ALLOW_PRIVATE`: "true"/"yes" must not arm a relaxation.
    allowPrivateBaseUrl: env.TF_AI_ALLOW_PRIVATE?.trim() === "1",
    // A hung model call blocks the worker's SERIAL cycle queue, and therefore every other
    // mailbox in this process — so the per-attempt deadline here is a liveness property of the
    // whole worker, not a per-request nicety. Two retries at 30 s bounds one classify at ~90 s
    // plus backoff, and the circuit opens after two of those.
    timeoutMs: optInt(env, "TF_AI_TIMEOUT_MS", AI_CLASSIFY_TIMEOUT_MS_DEFAULT),
    // `onUsage`, NOT `log`. The relay logs the same line the client's default would have — and
    // then forwards to the cost recorder once one is attached. Passing `log` here instead would
    // reinstate exactly the state cloud 0029 exists to end: a logger nobody handed in and a cost
    // table nothing writes to.
    onUsage: aiUsage.onUsage,
  });
  return {
    classifier: makeHaikuClassifier({ client }),
    drafter: makeSonnetDrafter(client),
    proposer: makeOpusProposer(client),
    aiUsage,
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
/**
 * The organizer display name for THIS deployment: the operator's own, or the origin's host. Empty and
 * whitespace-only are treated as unset (an operator who exported the variable with no value meant "use
 * the default", not "call me the empty string"), and CR/LF are stripped here as well as at the write
 * site, because a configuration value that can inject an RFC822 header is worth refusing twice. Returns
 * `undefined` when neither source has anything, which leaves `CLOUD_DISPLAY_NAME` — the right answer
 * for the hosted deployment and the only one it is true of.
 */
export function organizerDisplayNameFrom(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = (env.TF_ORGANIZER_DISPLAY_NAME ?? "").replace(/[\r\n]+/g, " ").trim();
  if (explicit !== "") return explicit.slice(0, 120);
  const origin = (env.OHMAIL_ORIGIN ?? env.TF_PUBLIC_ORIGIN ?? "").trim();
  if (origin === "") return undefined;
  try {
    const host = new URL(origin).host;
    return host === "" ? undefined : host.slice(0, 120);
  } catch {
    // Not a URL. An operator may have written a bare host, which is exactly what we want anyway.
    const bare = origin.replace(/[\r\n]+/g, " ").trim();
    return bare === "" ? undefined : bare.slice(0, 120);
  }
}

export function instanceIdFrom(env: NodeJS.ProcessEnv = process.env): string {
  const railway = env.RAILWAY_REPLICA_ID ?? env.RAILWAY_DEPLOYMENT_ID;
  if (railway && railway.trim() !== "") return railway.trim().slice(0, 64);
  try {
    const host = hostname();
    if (host && host.trim() !== "") return host.trim().slice(0, 64);
  } catch { /* no hostname in this sandbox — fall through */ }
  return `worker-${Math.random().toString(36).slice(2, 10)}`;
}
