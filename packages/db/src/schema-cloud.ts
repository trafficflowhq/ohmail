/**
 * The CLOUD-ONLY schema — the tables the hosted service adds, and the half that never ships: the
 * identity ceremony, the money (Stripe customers, subscriptions, the credit ledger), the ops
 * tables and the staff identity. A local install has none of it. Nothing in the desktop engine's
 * import closure may reach this file — the desktop artifact's sources are published, and
 * `password_hash`, `token_hash` and `credit_ledger` are one-way. `test/schema-split.test.ts`
 * checks the closure; `test/desktop-mirror-excludes-the-engine.test.ts` checks what the publisher
 * carries. The reverse direction is fine: a Cloud table may reference a mail table. Per-table
 * placement arguments: `test/journal-split.test.ts`.
 */

import { pgTable, uuid, text, timestamp, date, bigint, bigserial, boolean, jsonb, integer, numeric, real, unique, uniqueIndex, index, primaryKey, check } from "drizzle-orm/pg-core";
import { sql, desc } from "drizzle-orm";
import { accounts, sessions, users } from "./schema-mail.js";

export const credentials = pgTable("credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  passwordHash: text("password_hash").notNull(),  // scrypt
  algo: text("algo").notNull().default("scrypt"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqUser: unique().on(t.userId) }));

export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  credentialId: text("credential_id").notNull(),  // base64url
  publicKey: text("public_key").notNull(),        // base64url COSE key
  counter: bigint("counter", { mode: "bigint" }).notNull().default(sql`0`),   // signature counter (clone detection)
  transports: jsonb("transports").notNull().default(sql`'[]'::jsonb`),
  label: text("label").notNull().default(""),
  deviceType: text("device_type"),
  backedUp: boolean("backed_up").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => ({
  uqCred: unique().on(t.credentialId),
  ixUser: index("webauthn_credentials_user_idx").on(t.userId),
}));

// Short-lived, SINGLE-USE reg/assert challenges, bound to a user (registration)
// or a loginToken (assertion) AND to the origin/RP-ID they were issued for.
export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id"),                         // set for registration ceremonies
  loginTokenId: uuid("login_token_id"),            // set for assertion ceremonies
  challenge: text("challenge").notNull(),          // base64url
  type: text("type").notNull(),                    // 'registration' | 'authentication'
  rpId: text("rp_id").notNull(),
  origin: text("origin").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),   // single-use marker
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const totpSecrets = pgTable("totp_secrets", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  secretEnc: text("secret_enc").notNull(),         // envelope-encrypted via the KeyProvider
  keyVersion: integer("key_version").notNull(),    // KeyProvider KEK version
  activated: boolean("activated").notNull().default(false),
  lastConsumedStep: bigint("last_consumed_step", { mode: "bigint" }),   // TOTP single-use per timestep
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqUser: unique().on(t.userId) }));

export const recoveryCodes = pgTable("recovery_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  codeHash: text("code_hash").notNull(),           // hash-at-rest, single-use
  usedAt: timestamp("used_at", { withTimezone: true }),   // null = unused
  batchId: uuid("batch_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ixUser: index("recovery_codes_user_idx").on(t.userId) }));



// `refresh_tokens` MOVED to `schema-mail.ts` (mail 0060, Phase 3): QR device pairing gives
// the desktop-as-host tier bearer pairs whose refresh families rotate against the local store,
// so the table now lives beside `sessions`/`devices`/`pairing_tokens`. The cloud journal's
// historical CREATE stays byte-frozen in `drizzle-cloud/0000`; `journal-split.test.ts` pins the
// arbitration.

export const loginTokens = pgTable("login_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),         // the 5-min first-factor token
  methods: jsonb("methods").notNull().default(sql`'[]'::jsonb`),
  // 'login' | 'oauth' | 'email_verify'. The verification flow stores the mailed
  // email-verification token here too — hashed, purpose-scoped, single-use. `peekLoginToken`
  // filters on purpose='login' precisely so a value that was EMAILED can never be presented as
  // a first factor; see mail-service.ts and the test that pins the purpose split.
  purpose: text("purpose").notNull().default("login"),
  // The PKCE commitment a desktop handoff code was minted against, or NULL for a code that was
  // minted without one (cloud 0010). `sha256(verifier)`, base64url — the PUBLIC half, so it is
  // stored as sent rather than hashed again or sealed. NULL means "claimable by whoever holds
  // the code", which is the retype flow; a value means the claim must present the verifier.
  // Decided at mint and never updated, so a bound code cannot become unbound.
  challengeHash: text("challenge_hash"),
  oauthMeta: jsonb("oauth_meta"),                  // client_id/redirect_uri/challenge/state for the OAuth flow
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),   // single-use
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ixToken: index("login_tokens_token_idx").on(t.tokenHash) }));

export const oauthAuthCodes = pgTable("oauth_auth_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  clientId: text("client_id").notNull(),           // the code is bound to this client_id
  codeHash: text("code_hash").notNull(),
  codeChallenge: text("code_challenge").notNull(), // PKCE S256
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  redirectUri: text("redirect_uri").notNull(),     // …and to this redirect_uri
  scope: text("scope").notNull().default("full"),
  // The authorizing session's REAL `last_twofa_at`, carried to the session this code establishes
  // (cloud migration 0017; a security-review fix). The exchange asserts no factor of its own, so without this the
  // minted native session was stamped `now` — an authorization laundered into a fresh factor
  // timestamp. NULL means "no factor time to inherit" and the established session gets a NULL
  // `last_twofa_at`, which fails step-up closed. See `authorize` / `establish`.
  twofaAt: timestamp("twofa_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),   // short TTL
  consumedAt: timestamp("consumed_at", { withTimezone: true }),   // single-use
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ixCode: index("oauth_auth_codes_code_idx").on(t.codeHash) }));

export const authEvents = pgTable("auth_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id"),                   // null for pre-account events
  userId: uuid("user_id"),                         // null for unknown-email attempts
  event: text("event").notNull(),                  // AuthAuditEvent["event"] — login|login_failed|2fa_verified|2fa_failed|logout|device_revoked|recovery_used|lockout|enrollment_started|email_verified|desktop_link_issued|refresh_reuse_revoked|refresh_recovered
  method: text("method"),                          // webauthn|totp|recovery_code|password
  ip: text("ip"),
  device: text("device"),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  ixUserAt: index("auth_events_user_at_idx").on(t.userId, t.at),
  // cloud 0024 — PARTIAL on the reuse-sweep event, so it holds the rare revocation rows and
  // never the login ledger. The `session_reuse_revoked` alert rule (`event + at`, every alert
  // pass) and the admin account view's security row (`account_id + event`) both scan by it;
  // `(user_id, at)` above serves neither predicate.
  ixReuseAccountAt: index("auth_events_reuse_account_at_idx").on(t.accountId, t.at)
    .where(sql`"event" = 'refresh_reuse_revoked'`),
}));

export const authThrottle = pgTable("auth_throttle", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull(),                      // "ip:1.2.3.4" | "user:<id>" | "email:<addr>"
  failures: integer("failures").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqKey: unique().on(t.key) }));

// `push_subscriptions` — shaped for Web Push and APNs from day one. `transport` selects which
// identity column is live (endpoint for webpush AND unifiedpush, device_token for apns); the
// coalesced UNIQUE is hand-written in the migration SQL (an expression index the DSL cannot
// express). Payloads are wake-signals only. `unifiedpush` reuses the ENDPOINT column: the
// device's own distributor mints a URL and the organizer POSTs a content-free constant to it.
// `p256dh`/`auth` are OPTIONAL there and stored when a connector offers them — UnifiedPush 3.x
// endpoints are Web Push endpoints — so an encrypting sender needs no migration and no
// re-registration. `device_id` is stamped from the REGISTERING SESSION, never trusted from the
// request body: revoking a device takes its wake registration down with it.


export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  transport: text("transport").notNull(),               // 'webpush' | 'apns' | 'unifiedpush'
  endpoint: text("endpoint"),                            // webpush, unifiedpush
  p256dh: text("p256dh"),                                // webpush
  auth: text("auth"),                                    // webpush
  deviceToken: text("device_token"),                    // apns
  bundleId: text("bundle_id"),                          // apns
  environment: text("environment"),                     // apns: 'sandbox' | 'production'
  deviceId: uuid("device_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Billing + the credit ledger (migration 0018): five additive tables whose purpose is to make
// "revenue precedes token spend" true BY CONSTRUCTION. The constraints that carry the guarantee —
// the sign-reason CHECK, `CHECK (balance >= 0)`, the partial one-live-subscription unique index
// and the append-only trigger — are hand-written in `drizzle/0018_billing.sql` (the DSL cannot
// express them); the doc comments here name each so a reader is never left guessing why an insert
// was refused. `credit_balances` is DELIBERATELY separate from `credit_ledger`: deriving the
// balance from `SUM(delta)` hands two concurrent debits the same starting read and both "succeed"
// — overspend. One row per account means every balance change contends on ONE row lock, so debits
// serialize inside Postgres, and `CHECK (balance >= 0)` is the floor no app-side refactor can buy
// off.

/**
 * The leader's pulse, as a durable row (migration 0019). "No leader lock held for > 2 minutes" is
 * not answerable from the lock: an advisory lock is session-scoped, so a dead worker's lock does
 * not exist, and `pg_locks` can only say "not held right now" — this row says how long, from a
 * single read. Written ONLY by the process holding shard N's lock, which is why the primary key
 * is the shard and not the instance: at most one writer per key by construction, a takeover
 * overwrites, no dead-instance rows accumulate. `last_cycle_at` advances only on a cycle in which
 * work actually succeeded, so a leader alive but syncing nothing is a fresh `beat_at` with a
 * stale `last_cycle_at` — a different fault from a dead worker.
 */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  shardIndex: integer("shard_index").primaryKey(),
  instanceId: text("instance_id").notNull(),
  leader: boolean("leader").notNull().default(true),
  shards: integer("shards").notNull().default(1),
  mailboxes: integer("mailboxes").notNull().default(0),
  expected: integer("expected").notNull().default(0),
  accounts: integer("accounts").notNull().default(0),
  quarantined: integer("quarantined").notNull().default(0),
  degraded: boolean("degraded").notNull().default(false),
  /**
   * When this worker's classifier circuit FIRST opened in its current unbroken run of trips
   * (cloud 0030), or NULL while closed. The breaker is in-process state and nothing about it
   * reached this database before, so "the provider has been unavailable for ten minutes" — every
   * customer's mail filing rules-only — was unreportable. It rides the heartbeat because it is
   * what the heartbeat already is: a fact about one worker process, keyed by its shard,
   * overwritten every beat. FIRST open, not last: the cooldown doubles per trip and the breaker
   * half-opens between, so the newest open is always minutes old however long the provider has
   * been down. Cleared to NULL by the first success.
   */
  aiCircuitOpenSince: timestamp("ai_circuit_open_since", { withTimezone: true }),
  /**
   * When this worker FIRST reported itself degraded in the current unbroken run, NULL while
   * healthy. The duration `worker_degraded` measures — a boolean can only answer "right now",
   * and the rule's question is how long. On the ROW rather than in the process so a leader
   * change does not reset the clock on a fault that outlived the worker that first saw it.
   */
  degradedSince: timestamp("degraded_since", { withTimezone: true }),
  lastCycleAt: timestamp("last_cycle_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  beatAt: timestamp("beat_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ixBeat: index("worker_heartbeats_beat_idx").on(t.beatAt) }));

/**
 * One row per FIRING alert rule (migration 0019), so a fault pages a human once rather than once
 * per poll. `alertKey` is the rule's stable identity, never per-occurrence: an alert is a
 * condition, and "3 events failed" is `detail`, not three rows. `notified_at` + `notify_count`
 * make the repeat interval enforceable; the row is MARKED `resolved_at` when the condition
 * clears, so `selectOpenAlerts` reads a live list of what is currently wrong; resolved rows are
 * kept because the observation write's INSERT branch has nothing to fence against without them.
 * Nothing here can carry mail content — every field is a count, an age, or a rule name produced
 * by `alerts.ts` itself.
 */
export const alertState = pgTable("alert_state", {
  alertKey: text("alert_key").primaryKey(),
  /**
   * When this alert was resolved, or NULL while it is open (cloud 0030).
   *
   * Resolution MARKS rather than deletes, because an INSERT cannot be fenced against a row that
   * is not there: an older pass paused before its observation write arrives at an empty table,
   * takes the insert branch, and recreates — and pages — an incident a newer pass had just
   * resolved. Every reader meaning "open" goes through one accessor applying
   * `resolved_at IS NULL`, and a source census keeps it that way.
   */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  kind: text("kind").notNull(),
  severity: text("severity").notNull().default("critical"),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  notifyCount: integer("notify_count").notNull().default(0),
  detail: text("detail"),
  /**
   * The condition signature of the last CONFIRMED notification — what "unchanged" means for the
   * renotify policy (cloud 0025). An unchanged standing condition re-pages on a long interval; a
   * differing signature re-pages once the change-arm floor passes. Written ONLY by the guarded
   * confirm, beside `notified_at` — a claim writes nothing but its lease, so a failed delivery
   * and a crashed pass leave the confirmed condition standing and the retry re-fires by
   * construction. Concurrent duplicate claims are `claimed_until`'s job. NULL = never notified
   * with a signature, which reads as "unchanged" — a deploy must not page every standing alert
   * because the column arrived.
   */
  notifiedSignature: text("notified_signature"),
  /**
   * The notify claim's LEASE (cloud 0026): claim-time + claimTtlMs while a pass holds the
   * claim, cleared by its settle (confirm or release), expired by the clock if the pass dies.
   * Every due arm refuses a row whose lease is in the future. Its existence is what lets
   * `notified_at` mean exactly "the last confirmed notification" — the lease used to be
   * encoded there, and the changed-condition arm misread a live lease as an old confirm.
   */
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  /**
   * Incident or SIGNAL (cloud 0030) — the class that decides DELIVERY, not merely presentation.
   * An incident is a real application problem and goes to the sinks; a signal is informational —
   * recorded, rendered, never wakes anybody. Severity could not express this: `storage_at_cap`
   * and `sync_lag` are both warnings and only one is a customer being wronged. DEFAULTED to
   * `'incident'`, the safe direction: a row written by an older driver, or a rule whose author
   * forgot the field, pages. The other default turns a new incident into a row that fires,
   * renders, and reaches no human — the exact silence the alert subsystem exists to refuse.
   */
  cls: text("cls").notNull().default("incident"),
  /**
   * How many ACCOUNTS this condition affects, or NULL when the rule does not measure a
   * population. A COUNT and never a list: the console sizes the incident from it, and the
   * accounts themselves are reached through {@link fixHref}'s surface under that surface's own
   * projection rules. NULL is deliberately distinguishable from 0 — "this rule is one
   * deployment-wide fact" is a different statement from "this rule counted, and found none".
   */
  affectedAccounts: integer("affected_accounts"),
  /**
   * The INTERNAL CONSOLE PATH an operator should open to act on this — `/worker`, `/billing`,
   * `/accounts/<uuid>`. Written by the rule that fires, rendered as a link, never fetched
   * server-side. It carries no query string derived from mail and no external origin.
   */
  fixHref: text("fix_href"),
  /**
   * What the rule SAID, persisted so a reader never has to invent it.
   *
   * Nullable on purpose: a row from a driver that predates these columns has no title, and a
   * reader must say so rather than fabricate one out of the detail's first sentence — which is
   * what every surface reading this table used to do, alongside a hardcoded count of 1.
   */
  title: text("title"),
  count: integer("count"),
}, (t) => ({ ixLastSeen: index("alert_state_last_seen_idx").on(t.lastSeenAt) }));

/**
 * One row per ALERT DRIVER (cloud 0030) — the pulse of the thing that takes everyone else's
 * pulse. Two drivers: the worker's timer and the API host's cron. Until this table neither left a
 * record of having run, so both could stop and the only evidence would be an ABSENCE of pages —
 * indistinguishable from a healthy deployment. `driver` IS the primary key: at most one row per
 * arm, no history for a table nobody queries historically. The rule built on it
 * (`alert_driver_dark`) is evaluated by the OTHER driver: a dead driver cannot report its own
 * death. Content: counts and one timestamp — `failed_sinks` is a COUNT, never sink names; a
 * vendor endpoint's identity belongs in the log line.
 */
export const alertPassRuns = pgTable("alert_pass_runs", {
  /** `'worker'` or `'api'`. CHECK-constrained — see the migration for why the set is closed. */
  driver: text("driver").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).defaultNow().notNull(),
  /** Conditions firing on this pass, both classes. */
  firing: integer("firing").notNull().default(0),
  /** Sinks that ACCEPTED on this pass. 0 on a pass with nothing to deliver. */
  delivered: integer("delivered").notNull().default(0),
  /** Sinks that REFUSED on this pass. */
  failedSinks: integer("failed_sinks").notNull().default(0),
  /** Consecutive passes in which no sink accepted — `AlertPassResult.sinkFailureStreak`. */
  sinkFailureStreak: integer("sink_failure_streak").notNull().default(0),
  /**
   * How many sinks that arm had configured on its last pass. ZERO means it cannot page anybody,
   * which `sink_failure_streak` cannot express: an arm that never attempts a delivery never
   * fails one, so its streak stays at zero and reads exactly like a healthy arm.
   */
  sinksConfigured: integer("sinks_configured").notNull().default(0),
});

/**
 * What the hosting platform served (cloud 0030) — request and error counts per project per
 * window. The API host's 5xx rate is invisible from inside the host: an invocation that returns a
 * 502 and dies writes nothing here; only the platform's own request-log store knows. A
 * five-minute cron polls it; the rule reads three windows. TWO COUNTS, never a stored rate: three
 * five-minute rows must add up to the fifteen minutes the rule is written against, and a stored
 * percentage cannot be re-summed. `window_start` is the window's own start; `fetched_at` is when
 * the poll answered. No `account_id`, and there cannot be one: this is a count of HTTP requests
 * to a deployment.
 */
export const platformSignals = pgTable("platform_signals", {
  /** CHECK-constrained to the platforms this deployment can poll. */
  provider: text("provider").notNull(),
  /** The platform's own project name (`ohmail-api`) — an identifier this repository chooses. */
  project: text("project").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  requests: integer("requests").notNull().default(0),
  errors5xx: integer("errors_5xx").notNull().default(0),
  /**
   * TRUE when the poll hit its page budget before reaching the start of the window, so both
   * counts are LOWER BOUNDS over the window's most-recent slice. The walk runs backwards from the
   * window's end, so that slice is contiguous and real — which makes under-reporting the only
   * direction this can be wrong in, and a rule that fires on "≥ 10 errors AND ≥ 2%" can never
   * invent a page from it. The column exists so the board says "sampled" instead of implying a
   * count it does not have.
   */
  truncated: boolean("truncated").notNull().default(false),
  /**
   * WHICH of the seven causes made this bucket a sample, or NULL when it is not one (cloud 0030).
   *
   * `truncated` began meaning "the walk hit its page budget" and grew five more causes, while
   * the console went on naming the first — so an operator was sent to a limit that was not
   * involved. The panel's sentence is keyed on this value, and a cause with no sentence fails a
   * test rather than rendering blank. CHECK-constrained by 0030 to the same closed set the
   * reader names in `SAMPLE_CAUSES`, which a test compares against the migration itself.
   */
  sampleCause: text("sample_cause"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.provider, t.project, t.windowStart], name: "platform_signals_pk" }),
  ixWindow: index("platform_signals_window_idx").on(t.windowStart),
}));

/**
 * ONE ROW PER 5xx THE API'S OWN ERROR ENVELOPE ANSWERED (cloud 0033) — the first-party half of
 * `platformSignals`, which counts what the PLATFORM served and cannot say which route failed.
 *
 * Every column is a literal this repository chose or an integer: the route PATTERN, never a URL;
 * the thrown value's CLASS, never its message (a driver's message quotes connection strings and
 * an application's quotes what a person typed). Seven-day retention, pruned by a worker pass.
 */
export const apiFaults = pgTable("api_faults", {
  id: uuid("id").defaultRandom().primaryKey(),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  /** The MATCHED ROUTE's pattern (`/messages/:id`) — one of a closed set the route table declares. */
  route: text("route").notNull(),
  method: text("method").notNull(),
  /** CHECK-constrained to 500–599: a 4xx is the API working, and would poison every rule's rate. */
  status: integer("status").notNull(),
  /** The thrown value's class name, or `String` for a thrown primitive. Never the message. */
  errorClass: text("error_class").notNull(),
  /** Our own `withRequestId` uuid, so a row and a log line join. NULL when the id was unbound. */
  requestId: text("request_id"),
  /**
   * WHICH ARM ANSWERED — the closed set `alert_pass_runs.driver` uses, and the table's LAST
   * column, which is why `health-cloud.ts`'s marker and `alerts.ts`'s SCHEMA_BEHIND_MARKER both
   * name it. Adding a column after this one means moving both in the same commit.
   */
  arm: text("arm").notNull(),
}, (t) => ({
  ixAt: index("api_faults_at_idx").on(t.at),
  ixAtRoute: index("api_faults_at_route_idx").on(t.at, t.route),
  ckStatus: check("api_faults_status_check", sql`${t.status} >= 500 and ${t.status} <= 599`),
  ckLen: check("api_faults_len_check",
    sql`char_length(${t.route}) <= 200 and char_length(${t.method}) <= 20
      and char_length(${t.errorClass}) <= 200 and char_length(${t.requestId}) <= 100`),
  ckArm: check("api_faults_arm_check", sql`${t.arm} in ('api', 'worker')`),
}));

/**
 * Everyone who asked to be let in, from `POST /waitlist` (the landing form). UPSERTed on `email`,
 * never appended: a person who submits the form three times is one entry, one confirmation mail
 * (the mailer's per-recipient limiter handles the rest), and one `updated_at` that moves when
 * they change their mind about the tier. `invited_at` / `registered_at` make the whole funnel
 * readable from this one table — waiting, invited, registered — which is the only reporting the
 * beta needs and is what the operator mint script lists.
 */
export const waitlist = pgTable("waitlist", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Normalised by `normalizeRecipient` before it gets here, so UNIQUE is real uniqueness. */
  email: text("email").notNull(),
  /** `desktop|solo|plus|pro|undecided` (CHECK in 0020) — mirrors the landing's `SignupTier`. */
  tier: text("tier").notNull().default("undecided"),
  source: text("source").notNull().default("landing"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  registeredAt: timestamp("registered_at", { withTimezone: true }),
}, (t) => ({
  uqEmail: unique("waitlist_email_unique").on(t.email),
  ixCreated: index("waitlist_created_idx").on(t.createdAt),
  ixInvited: index("waitlist_invited_idx").on(t.invitedAt),
}));

/**
 * Staff identity for the admin console (cloud 0007). One operator, no RBAC. NOT a row in `users`:
 * `users` is the CUSTOMER identity, reachable from the product's whole auth surface, and a
 * `role='staff'` column there would make one over-broad `OR` a cross-account escalation; a table
 * the product's auth never queries has no code path that can promote anybody. The console's
 * sign-in cannot reuse `AuthService` for the same reason. The blind role sees NOTHING of it:
 * `ohmail_admin` is granted column by column and this table is not on the allowlist. The TOTP
 * secret is sealed; `totp_activated` is separate from "a secret exists", so an abandoned
 * enrolment leaves a row nobody can sign in with, not a locked-out operator.
 */
export const staffUsers = pgTable("staff_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Lower-cased before it gets here, so UNIQUE is real uniqueness. */
  email: text("email").notNull(),
  /** scrypt, via `scryptHasher` — the same hasher the product's own credentials use. */
  passwordHash: text("password_hash").notNull(),
  /** Envelope-encrypted TOTP secret. Null until the first enrolment begins. */
  totpSecretEnc: text("totp_secret_enc"),
  /** KeyProvider KEK version for `totp_secret_enc`. Null iff the secret is null. */
  totpKeyVersion: integer("totp_key_version"),
  /** False while an enrolment is pending; true once a code from the secret has verified. */
  totpActivated: boolean("totp_activated").notNull().default(false),
  /** TOTP single-use per timestep. */
  totpLastConsumedStep: bigint("totp_last_consumed_step", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
}, (t) => ({ uqEmail: unique("staff_users_email_unique").on(t.email) }));

/**
 * The staff session (cloud 0007). Opaque, hashed at rest, revocable. A table and not a signed
 * cookie: this credential authorises WRITES (suspending an account, moving credits) and names the
 * person the audit row blames, and a self-verifying token cannot be withdrawn — a laptop lost at
 * 09:00 stays signed in until expiry, and rotating the signing secret signs out everybody. So the
 * row IS the session, and `revoked_at` is a sign-out that actually signs out. `expires_at` is the
 * authority, not the cookie's `Max-Age` — a client controls its own attributes. `token_hash` via
 * `hashToken`: a dump is a list of useless digests; the plaintext exists only in the operator's
 * cookie jar.
 */
export const staffSessions = pgTable("staff_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  staffUserId: uuid("staff_user_id").notNull().references(() => staffUsers.id),
  /** SHA-256 of the opaque token. The plaintext is never stored. */
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set by an explicit sign-out. A revoked session is dead before its expiry. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  uqToken: unique("staff_sessions_token_hash_unique").on(t.tokenHash),
  ixUser: index("staff_sessions_user_idx").on(t.staffUserId),
}));

/**
 * The mailbox OAuth2 ceremony (cloud 0009) — a redirect consent flow in flight, hosted-only. A
 * row lives between "Connect Outlook" and the redirect back; it holds the PKCE verifier and the
 * owning account, consumed exactly once. `state` is the PRIMARY KEY because it is the consumption
 * key: 256 bits of `randomBytes`, the redirect's CSRF token and the key the single-use UPDATE
 * turns on. The verifier is envelope-encrypted; both columns NOT NULL together, so the
 * half-sealed state is unrepresentable. Deliberately NO `mailbox_id`: the address comes from the
 * `id_token` claim and the live-address unique index resolves the target — a stored id would let
 * a reconnect started for A be repointed at B.
 */
export const mailboxOauthCeremonies = pgTable("mailbox_oauth_ceremonies", {
  /** 256-bit random, base64url. The CSRF token of the redirect AND the single-use consumption key. */
  state: text("state").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  /** Today only `"microsoft"`. Stored so a second provider needs no column. */
  provider: text("provider").notNull(),
  /** The KEK envelope of the PKCE `code_verifier`. */
  codeVerifierEnc: text("code_verifier_enc").notNull(),
  /** NOT NULL beside the ciphertext: `decrypt(ct, keyVersion)` cannot be called without it. */
  codeVerifierKeyVersion: integer("code_verifier_key_version").notNull(),
  /** Where to send the browser afterwards. Validated as a SAME-SITE relative path by the reader. */
  returnTo: text("return_to"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /**
   * When this ceremony was spent. A timestamp and not a boolean: a replay attempt is worth being
   * able to date. Presence is the state — the predicate is `IS NULL` and there is no second flag.
   */
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (t) => ({
  ixCreated: index("mailbox_oauth_ceremonies_created_idx").on(t.createdAt),
}));

/**
 * The device-code ceremony (cloud 0027). A SEPARATE table from `mailbox_oauth_ceremonies`:
 * opposite consumption disciplines — the redirect ceremony is spent by ONE request with
 * `code_verifier_enc` NOT NULL, and the device grant has no PKCE arm; this one is READ REPEATEDLY
 * and consumed once, on a TERMINAL verdict only. Two disciplines in one table is one `WHERE` away
 * from the poll consuming the ceremony it polls for. `device_code_enc` is the bearer credential,
 * KEK-enveloped, never rendered or logged; `user_code`/`verification_uri` are what the person is
 * SHOWN, in clear so a reload does not strand a live grant. `poll_interval_ms`/`last_polled_at`
 * protect the SHARED client id. No `mailbox_id`.
 */
export const mailboxOauthDeviceCeremonies = pgTable("mailbox_oauth_device_ceremonies", {
  /**
   * 256-bit random, base64url — MINTED BY US, and never the `device_code`.
   *
   * This is the handle the operator's browser polls with, so it travels in request bodies and sits
   * in a client's memory. The `device_code` is the credential and stays sealed in this row: a
   * design that used it as the poll handle would put a bearer credential in every poll body and in
   * whatever logs the operator's reverse proxy keeps.
   */
  state: text("state").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  /** Today only `"microsoft"`. Stored so a second provider needs no column. */
  provider: text("provider").notNull(),
  /** The KEK envelope of the `device_code`. SECRET — never rendered, never logged. */
  deviceCodeEnc: text("device_code_enc").notNull(),
  /** NOT NULL beside the ciphertext: `decrypt(ct, keyVersion)` cannot be called without it. */
  deviceCodeKeyVersion: integer("device_code_key_version").notNull(),
  /** The short code the person types. On screen by design; useless without a Microsoft session. */
  userCode: text("user_code").notNull(),
  /** Where the person goes — typically `https://microsoft.com/devicelogin`. On screen by design. */
  verificationUri: text("verification_uri").notNull(),
  /** The interval currently in force, already including every `slow_down` increment so far. */
  pollIntervalMs: integer("poll_interval_ms").notNull(),
  /** Microsoft's own `expires_in`, clamped and absolute. The hard deadline for polling this grant. */
  grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }).notNull(),
  /** When this ceremony was last polled, or NULL before the first poll. The early-poll fence. */
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /**
   * When this ceremony reached a TERMINAL verdict and was claimed. A pending poll never writes it.
   * Presence is the state, exactly as on the redirect ceremony — the predicate is `IS NULL`.
   */
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (t) => ({
  ixCreated: index("mailbox_oauth_device_ceremonies_created_idx").on(t.createdAt),
}));

/**
 * The operator's OAuth application registration (cloud 0009) — the Entra app the hosted
 * deployment signs with. One row per provider, `provider` as the PRIMARY KEY: two live
 * registrations is a state no reader could resolve. A table, with env as the BOOTSTRAP: a secret
 * rotated in Azure must be replaceable without redeploying two apps; `resolveOAuthProviderConfig`
 * prefers the row and drops to env, and both hosts call that one resolver. The secret never comes
 * back out: the admin read projects `secretSet: boolean`; both secret columns are nullable
 * TOGETHER, with a CHECK. `enabled` defaults FALSE. `updatedBy` is the `staff_users` actor — no
 * `audit_log` row exists for a change here, so the actor and note live on the row.
 */
export const oauthProviderConfig = pgTable("oauth_provider_config", {
  provider: text("provider").primaryKey(),
  clientId: text("client_id"),
  /** KEK envelope of the confidential client's secret. NEVER projected to any client. */
  clientSecretEnc: text("client_secret_enc"),
  clientSecretKeyVersion: integer("client_secret_key_version"),
  /** The Azure AD tenant SEGMENT. Validated against `MS_TENANT_RE` before it reaches a URL. */
  tenant: text("tenant"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().default([]).notNull(),
  scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by").references(() => staffUsers.id),
  note: text("note"),
});

/**
 * Staged attachment bytes — the ticket half of the hosted send's direct-upload transport,
 * hosted-only. Bytes used to ride the send request base64-encoded under the platform's ~4.5 MB
 * body limit; now they go to object storage on a signed URL and the send carries a REFERENCE —
 * this row: account-scoped, size-bounded, expiring. Cloud, not mail: a local install sends beside
 * its own SMTP dial — nothing to stage around. `object_path` is UNIQUE because it is also the
 * delete key. `size_bytes` is the client's DECLARATION, refused against before download; the
 * bytes are measured again after. No `consumed_at`: a send reads the bytes and leaves the row to
 * expire — a retry under the same idempotency key must find the same bytes.
 */
export const attachmentStaging = pgTable("attachment_staging", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** WHOSE. Every read is account-scoped; a ticket from another account is a 404, never bytes. */
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  /** Where the bytes live in the staging bucket. The delete key, hence UNIQUE. */
  objectPath: text("object_path").notNull(),
  /** What the file is called on the outgoing message. Never used to build the object path. */
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  /** The DECLARED size the mint refused against. Re-measured after download; see the header. */
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /** The retention promise. The sweep's whole predicate, and what the privacy copy states. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uqPath: unique("attachment_staging_object_path_unique").on(t.objectPath),
  ixAccount: index("attachment_staging_account_idx").on(t.accountId),
  ixExpires: index("attachment_staging_expires_idx").on(t.expiresAt),
}));

/**
 * A consumable, expiring, EMAIL-BOUND beta invite. Three properties the `AuthConfig.inviteCodes`
 * `Set` structurally cannot have: hashed (`code_hash = sha256(raw)`) — a database dump is not a
 * list of working invites; single-use — consumption is one `UPDATE … WHERE code_hash = $1 AND
 * consumed_at IS NULL AND expires_at > now RETURNING id` inside the registering transaction, so
 * two concurrent redemptions produce exactly one account; email-bound (`email` NOT NULL) — the
 * register endpoint's 201-vs-409 is an account-existence oracle for whatever address the caller
 * types, and binding the code to one address reduces that to "the inbox you already control"
 * (0020's header has the full argument).
 */
export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** `hashToken(raw)`. The raw code exists only in the operator's terminal and the inbox. */
  codeHash: text("code_hash").notNull(),
  /** THE BINDING. NOT NULL by schema: an unbound invite re-opens the oracle. */
  email: text("email").notNull(),
  issuedBy: text("issued_by").notNull().default("operator"),
  note: text("note"),
  /**
   * Does redeeming this invite PROVE its holder controls `email`? (migration 0018). Register's
   * invite path stamps `users.email_verified_at` only when this is true. TRUE for mailed invites
   * (receipt is the proof — the same argument a mailed verification link stands on) and for the
   * invite minted by a server's first-boot setup token (control of the box is the proof). FALSE
   * for invites minted by a pairing-token redeem, where the redeemer typed the address and
   * nothing was mailed: those accounts register fine and verify later through the ordinary flow.
   * The writer decides from its own record — the pairing redeem reads the consumed token row,
   * never a caller-supplied flag.
   */
  confersVerified: boolean("confers_verified").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /** No default: an invite that never expires must not be creatable by forgetting an argument. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  /** Deliberately no FK: Art. 17 erasure must not have to choose between the two. */
  consumedByUserId: uuid("consumed_by_user_id"),
  /**
   * TAKEN BACK (migration 0021). The third way an invite can end, and the only one an
   * operator controls on the day it is needed: a code mailed to the wrong address, forwarded,
   * or pasted into a support ticket. Before this column the documented remedy was
   * `invite mint --force`, which issued a second code and left the leaked one working for the
   * rest of its 14 days — two live keys to one account.
   *
   * It is part of `consumeInvite`'s single consumption statement, exactly like `consumed_at`,
   * so revocation is enforced in the same place as single-use rather than in a second check.
   */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** Who revoked it. Free text like `issued_by`; a staff identity once revocation has a console screen. */
  revokedBy: text("revoked_by"),
  /** Why — asked once, months later, by someone who was not there. */
  revokedReason: text("revoked_reason"),
}, (t) => ({
  uqCode: unique("invites_code_hash_unique").on(t.codeHash),
  ixEmail: index("invites_email_idx").on(t.email),
  ixExpires: index("invites_expires_idx").on(t.expiresAt),
}));

/**
 * The Cloud-only half as one object, for `drizzle(client, { schema })`.
 *
 * Spread into `schema` by `./schema.js` for every consumer that wants both halves. A local
 * install passes THIS one and nothing else — see `apps/sidecar/src/db.ts`.
 */
export const cloudSchema = {
  credentials, webauthnCredentials, webauthnChallenges, totpSecrets, recoveryCodes, loginTokens,
  oauthAuthCodes, authEvents, authThrottle, pushSubscriptions,
  workerHeartbeats, alertState, alertPassRuns, platformSignals, apiFaults,
  waitlist, staffUsers, staffSessions,
  mailboxOauthCeremonies, mailboxOauthDeviceCeremonies,
  oauthProviderConfig, attachmentStaging, invites,
};
