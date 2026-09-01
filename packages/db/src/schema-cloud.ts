/**
 * THE CLOUD-ONLY SCHEMA — the 27 tables the hosted service adds, and the half that never ships.
 *
 * The identity ceremony (password hashes, WebAuthn, TOTP, recovery codes; the refresh-token
 * store itself moved to the mail half in 0060 — paired devices rotate against the store that
 * serves them), the money (Stripe customers, subscriptions, the credit ledger), the ops tables,
 * the funnel and the admin console's own staff identity. A local install has none of it: it
 * mints a session per launch, it is free, it has no operator and nobody to sign in.
 *
 * **Nothing in the desktop engine's import closure may reach this file.** That is not a style
 * rule — the desktop artifact's sources are published, and `password_hash`, `token_hash` and
 * `credit_ledger` are one-way. `test/schema-split.test.ts` checks the closure;
 * `test/desktop-mirror-excludes-the-engine.test.ts` checks what the publisher will carry.
 *
 * The reverse direction is fine and is used below: a Cloud table may reference a mail table,
 * because `accounts` and `users` exist in every database that has this half.
 *
 * The per-table justification for each placement is in `test/journal-split.test.ts`,
 * beside the journal partition it mirrors.
 */

import { pgTable, uuid, text, timestamp, bigint, bigserial, boolean, jsonb, integer, real, unique, uniqueIndex, index, primaryKey, check } from "drizzle-orm/pg-core";
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

//
// `push_subscriptions` — shaped for both Web Push and APNs from day one. `transport`
// selects which identity column is live (endpoint for webpush AND unifiedpush,
// device_token for apns); the coalesced UNIQUE(account_id, transport, COALESCE(endpoint,
// device_token)) is added by hand in the migration SQL (an expression index
// Drizzle's schema DSL cannot express). Payloads are wake-signals only.
//
// 'unifiedpush' reuses the ENDPOINT column: the device's own distributor mints a URL and the
// organizer POSTs a content-free constant to it. `p256dh`/`auth` are OPTIONAL on that transport
// and stored when a connector offers them — UnifiedPush 3.x endpoints are Web Push endpoints, so
// a connector hands back exactly the three values webpush already uses. Nothing reads the two
// key columns for this transport yet (the wake that ships is unencrypted); accepting them costs
// one column each and means an encrypting sender needs no migration and no re-registration on
// every device. `device_id` is stamped from the REGISTERING SESSION rather than trusted from the
// request body, which is what lets revoking a device take its wake registration down with it.


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

// ─────────────────────────────────────────────────────────────────────────────
// BILLING + the credit ledger (migration 0018). Five additive tables
// whose whole purpose is to make "revenue precedes token spend" true BY
// CONSTRUCTION rather than by policy. The constraints that carry
// that guarantee — the sign↔reason CHECK, `CHECK (balance >= 0)`, the partial
// one-live-subscription unique index and the append-only trigger — are hand-written
// in `drizzle/0018_billing.sql`, because the DSL cannot express them; the doc
// comments here name each one so a reader of the schema is never left guessing why
// an insert was refused.
//
// `credit_balances` is DELIBERATELY a separate table from `credit_ledger`. Deriving
// the balance from `SUM(delta)` or from the newest `balance_after` hands two
// CONCURRENT debits the same starting read and both "succeed" — overspend, the exact
// failure this design exists to prevent. One row per account means every balance
// change contends on ONE row lock, so debits serialize inside Postgres, and
// `CHECK (balance >= 0)` is the floor no app-side refactor can buy off.
// ─────────────────────────────────────────────────────────────────────────────

/** account ↔ Stripe customer, 1:1. Written only by the webhook/Checkout side. */
export const billingCustomers = pgTable("billing_customers", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqStripeCustomer: unique().on(t.stripeCustomerId) }));

/**
 * Subscription state mirrored from Stripe, with entitlements DENORMALIZED onto the row.
 * `mailbox_limit` / `monthly_credits` are what THIS subscription was sold with, so a later
 * price change or a grandfathered custom deal cannot retro-rewrite a live entitlement —
 * which is why `entitlementsFor` reads the ROW and never the `PLAN_LIMITS` map.
 *
 * Hand-written in the migration: `plan` and `status` CHECKs (the value sets are exhaustive,
 * so a reader can never mis-classify a row), `mailbox_limit >= 0`, `monthly_credits >= 0`,
 * and `billing_sub_one_live_idx` — a PARTIAL unique index on `account_id` over the LIVE
 * statuses only. That index is what makes "at most one live subscription per account" a
 * database fact: two racing checkouts cannot both land. `incomplete`/`incomplete_expired`
 * are excluded because an abandoned Checkout parks a row in `incomplete` for ~23 h and must
 * not lock the user out of retrying; `canceled` is excluded so resubscribe history
 * accumulates freely.
 */
export const billingSubscriptions = pgTable("billing_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull(),
  plan: text("plan").notNull(),                                   // solo|plus|pro (CHECK)
  status: text("status").notNull(),                               // SubscriptionStatus (CHECK)
  mailboxLimit: integer("mailbox_limit").notNull(),               // sold-at entitlement, not PLAN_LIMITS
  monthlyCredits: integer("monthly_credits").notNull(),           // sold-at entitlement, not PLAN_LIMITS
  // Sold-at entitlement like its two siblings (cloud 0019): the managed stored-body cap in
  // BYTES. Denormalized at sale time and grandfathered by the same price-moves-only CASE, so a
  // later change to the plan card cannot shrink what a live customer already bought. bigint —
  // the smallest card value (5 GB) already outruns int4.
  storageBytesLimit: bigint("storage_bytes_limit", { mode: "number" }).notNull(),
  // ADD-ON QUANTITIES (cloud 0022) — how many +10 GB storage add-ons and +1 mailbox add-ons
  // ride this subscription as their own recurring Stripe line items. NOT sold-at columns:
  // unlike the three allowances above, these move on EVERY admitted subscription event (an
  // add-on change arrives with the plan price unchanged, so the price-moves-only CASE must not
  // gate them; the `stripe_event_ts` fence still orders the writes). `entitlementsFor` composes
  // the effective allowance from base + add-ons.
  addonStorageUnits: integer("addon_storage_units").notNull().default(0),
  addonMailboxes: integer("addon_mailboxes").notNull().default(0),
  // The plan price's billing cadence (cloud 0022) — 'month' | 'year' (CHECK). A property of the
  // PRICE, so the mirror moves it under the same price-moves-only CASE as the allowances. An
  // annual cycle invoice grants twelve months of credits at once (`monthlyCreditsFor` × 12).
  billingInterval: text("billing_interval").notNull().default("month"),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  graceUntil: timestamp("grace_until", { withTimezone: true }),   // set by the webhook when status → past_due
  // `event.created` of the webhook that last wrote this row — the mirror's last-write-wins fence
  // against out-of-order Stripe delivery. NOT NULL so the fence can never be skipped.
  stripeEventTs: timestamp("stripe_event_ts", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqStripeSubscription: unique().on(t.stripeSubscriptionId),
  ixAccount: index("billing_sub_account_idx").on(t.accountId),
}));

/**
 * THE authoritative balance — one row per account. A MISSING row is semantically identical
 * to balance 0 (debit reports `insufficient`, grant creates it), so no backfill is needed
 * for accounts that predate 0018.
 *
 * Hand-written in the migration: `CHECK (balance >= 0)` — the invariant of last resort. Even
 * a future bug that bypasses every app-side guard cannot COMMIT a negative balance — and
 * `credit_balances_coupled`, a DEFERRED constraint trigger, additionally refuses to commit a
 * balance that the ledger does not account for. The two tables are one fact.
 */
export const creditBalances = pgTable("credit_balances", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The append-only money audit trail. NEVER updated, NEVER deleted — enforced by a
 * STATEMENT-level `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger in the migration.
 *
 * `source` is the ledger's idempotency IDENTITY (see `ledgerSources` in `credits.ts`):
 * `credit_ledger_source_uq` — UNIQUE (account_id, source) — means one economic event per
 * account at most once, and the primitives INSERT through it with `ON CONFLICT DO NOTHING`,
 * so replaying an invoice or reprocessing a message is a reported `duplicate`, never a
 * second row.
 *
 * Hand-written in the migration: `credit_ledger_sign_reason_check` pairs the SIGN of `delta`
 * to the `reason` (a row claiming to be a grant can never carry a negative delta and vice
 * versa — an audit trail whose rows can lie about their own direction is not an audit trail),
 * `credit_ledger_source_reason_check` pins each `reason` to its `source` NAMESPACE so a debit
 * can never collide with an invoice's dedup identity, `credit_ledger_source_len_check` bounds
 * the (partly client-controlled) index key, `CHECK (balance_after >= 0)`, the
 * `credit_ledger_refund_origin` trigger (a refund must reverse a real debit), the
 * `credit_ledger_coupled` DEFERRED constraint trigger (the chain of `balance_after` values,
 * and agreement with `credit_balances` at COMMIT), and the `(account_id, id DESC)`
 * statement-view index.
 *
 * Per-account ledger order = id order: `bigserial` is not globally commit-ordered, but every
 * ledger write in this design happens while holding that account's `credit_balances` row
 * lock, so WITHIN one account ids are commit order — which is what makes `ORDER BY id DESC`
 * a truthful statement view.
 */
export const creditLedger = pgTable("credit_ledger", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  delta: integer("delta").notNull(),                              // + grant, − debit (CHECK-tied to reason)
  balanceAfter: integer("balance_after").notNull(),               // >= 0 (CHECK)
  reason: text("reason").notNull(),                               // GrantReason | DebitReason
  source: text("source").notNull(),                               // namespaced dedup identity
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqSource: uniqueIndex("credit_ledger_source_uq").on(t.accountId, t.source),
  ixAccountIdDesc: index("credit_ledger_account_id_desc_idx").on(t.accountId, desc(t.id)),
}));

/**
 * WHO IS DOING THIS PIECE OF PAID WORK RIGHT NOW (migration 0016).
 *
 * ── WHY THE LEDGER CANNOT ANSWER THIS, WHICH IS THE WHOLE REASON THE TABLE EXISTS ─────────
 *
 * `credit_ledger` is append-only and its `UNIQUE (account_id, source)` says *"this economic
 * event happened at most once"*. That is a statement about the PAST, and the spend gate needed a
 * statement about the PRESENT. A second caller arriving at the same `source` reads the same row
 * and gets `duplicate`, which the gate correctly turns into "already paid for, proceed" — free
 * retries of an open attempt are the ledger's standing contract. What that row cannot say is
 * whether the caller which wrote it has FINISHED. So a retry after a crash and a caller still
 * inside its model call are indistinguishable, and the second one was waved through to a paid
 * model call it had not bought.
 *
 * With no bound on concurrency in front of it — `POST /screener/suggest` is `idempotent: true`,
 * so distinct `Idempotency-Key`s never collapse against each other, and the deployment has no
 * edge rate limit — N simultaneous requests bought N model calls for ONE debit. It needs no
 * attacker either: the worker's auto-suggest cron and a person pressing Suggest select the same
 * held sender by construction, and both reach this gate through the same ledger source.
 *
 * A row here is one caller's exclusive claim on one unit of work. It is taken in the SAME
 * transaction as the debit, before the model call, and deleted when the work ends.
 *
 * ── `expires_at` IS THE PRICE OF EXCLUSIVITY, AND IT IS NOT OPTIONAL ──────────────────────
 *
 * Anything that can be held can be held by something that died. Without a bound, one crashed
 * serverless invocation would wedge a sender for ever and no retry could ever clear it, which is
 * a worse failure than the one being fixed. So the claim expires, and the next arrival TAKES
 * OVER an expired row rather than colliding with it — the same expired-row takeover
 * `idempotency_keys` uses (see {@link claimIdempotencyKey}), for the same reason.
 *
 * Both the write and the takeover predicate use `now()` **in Postgres**, never a caller's clock:
 * the holders are different processes on different machines, so a claim bounded by each caller's
 * own wall clock is bounded by nothing in particular.
 *
 * ── THE KEY IS THE WORK, NOT THE ATTEMPT ──────────────────────────────────────────────────
 *
 * `source` is the BASE ledger source (`classify:screener:<message_id>`), not the resolved
 * `<base>~<n>` attempt. Attempts 1 and 2 are two tries at ONE unit of work and exactly one
 * caller may be trying at a time; keying by attempt would let a caller charging `~2` run
 * alongside a caller retrying `~1` for free, which is the same defect with an extra step.
 *
 * ── WHY CLOUD AND NOT MAIL ────────────────────────────────────────────────────────────────
 *
 * It is a property of METERED work. A local install has no ledger, no subscription and no gate —
 * `screenerAutoSuggestPass` there declares `unmetered` and no claim is ever taken — so the mail
 * journal creating this table would put a table nothing on that install can write into every
 * desktop database. (It references `accounts`, a MAIL table: the legal direction, mail first.)
 */
export const aiAttemptClaims = pgTable("ai_attempt_claims", {
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  /** The BASE ledger source. See the header: the work, never the attempt ordinal. */
  source: text("source").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  /**
   * When this claim stops being anyone's. Written as `now() + ttl` by Postgres, and compared
   * against `now()` by the next claimant — one clock for every instance.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.source], name: "ai_attempt_claims_pk" }),
  /** The sweep's whole predicate. Without it the maintenance pass seq-scans the table. */
  ixExpires: index("ai_attempt_claims_expires_idx").on(t.expiresAt),
}));

/**
 * Stripe webhook dedup + audit — the webhook dedup gate, as a CLAIM rather than a bare presence check.
 *
 * DELIBERATELY not append-only: `error`/`status` are written in a SEPARATE transaction after
 * a failed apply (the apply tx rolled back, so the error can only be recorded outside it).
 * That is safe because `billing_events` is evidence about webhook DELIVERY; `credit_ledger`
 * is the money record.
 *
 * …and that exception is exactly why `status` exists. A bare `INSERT … ON CONFLICT DO NOTHING
 * RETURNING id ⇒ zero rows ⇒ 200 already applied` is only sound if a row's PRESENCE means the
 * effect happened. The moment the failure path writes a row from outside the rolled-back
 * transaction, presence stops meaning that: the next Stripe retry conflicts, is acknowledged
 * 200, and a failed `invoice.paid` never grants the credits nor is ever retried. Only
 * `status = 'applied'` suppresses a retry; a `'failed'` row is CLAIMABLE. See
 * {@link claimBillingEvent}.
 */
export const billingEvents = pgTable("billing_events", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  type: text("type").notNull(),
  accountId: uuid("account_id").references(() => accounts.id),    // nullable: resolved from the customer
  payload: jsonb("payload").notNull(),
  eventTs: timestamp("event_ts", { withTimezone: true }).notNull(),   // event.created
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  error: text("error"),
  /** `applied` | `failed` (CHECK). Only `applied` suppresses a Stripe retry. */
  status: text("status").notNull().default("applied"),
}, (t) => ({ ixAccount: index("billing_events_account_idx").on(t.accountId, desc(t.eventTs)) }));

/**
 * The LEADER'S PULSE, as a durable row (migration 0019).
 *
 * The alert "no leader lock held for > 2 minutes" is not answerable from the lock: an
 * advisory lock is session-scoped, so a dead worker's lock does not exist, and `pg_locks`
 * can only ever say "not held right now". This row says how long, from a single read.
 *
 * Written ONLY by the process that holds shard N's lock (`apps/worker/src/index.ts`), which
 * is why the primary key is the shard and not the instance: at most one writer per key by
 * construction, a takeover overwrites, and no dead-instance rows accumulate for the alert
 * evaluator to reason about.
 *
 * `last_cycle_at` mirrors `WorkerStats.lastCycleAt` exactly — it advances only on a cycle in
 * which work actually succeeded — so a leader that is alive but syncing nothing is visible
 * here as a fresh `beat_at` with a stale `last_cycle_at`, which is a different fault from a
 * dead worker and must not be reported as the same one.
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
  lastCycleAt: timestamp("last_cycle_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  beatAt: timestamp("beat_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ixBeat: index("worker_heartbeats_beat_idx").on(t.beatAt) }));

/**
 * One row per FIRING alert rule (migration 0019), so a fault pages a human
 * once rather than once per poll.
 *
 * `alertKey` is the rule's stable identity (`worker_down:0`, `billing_events_failed`,
 * `sends_stuck`, `sync_lag`), never per-occurrence: an alert is a condition, and "3 events
 * failed" is `detail`, not three rows. `notified_at` + `notify_count` are what make the
 * repeat interval enforceable; the row is DELETED when the condition clears, so the table
 * is a live list of what is currently wrong and can be rendered as such.
 *
 * Nothing here can carry mail content — every field is a count, an age, or a rule name
 * produced by `alerts.ts` itself.
 */
export const alertState = pgTable("alert_state", {
  alertKey: text("alert_key").primaryKey(),
  kind: text("kind").notNull(),
  severity: text("severity").notNull().default("critical"),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  notifyCount: integer("notify_count").notNull().default(0),
  detail: text("detail"),
  /**
   * The CONDITION SIGNATURE of the last CONFIRMED notification — what "unchanged" means for
   * the renotify policy (cloud 0025). An UNCHANGED standing condition re-pages on a long
   * interval; a signature that differs from the firing alert's re-pages once the change-arm
   * floor passes. Written ONLY by the guarded confirm, beside `notified_at` — a claim writes
   * nothing but its lease, so a failed delivery and a crashed pass leave the confirmed
   * condition standing and the retry re-fires by construction (a signature written at claim
   * time read as "already told them" after a mid-delivery death — the crash-swallow the
   * confirm-only rule exists to refuse). Concurrent duplicate claims are `claimed_until`'s
   * job, not this column's. NULL = never notified with a signature (pre-migration rows),
   * which reads as "unchanged" — a deploy must not page every standing alert once just
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
}, (t) => ({ ixLastSeen: index("alert_state_last_seen_idx").on(t.lastSeenAt) }));

/**
 * ONE ROW PER BILLING-RECONCILIATION PASS (cloud 0023) — the run ledger of the scheduled
 * mirror-vs-Stripe comparison (`packages/services/src/entitlements/reconcile.ts`).
 *
 * Why a table and not a log line: the two alerts built on it are DB-evaluated
 * (`evaluateAlerts`), and both are about ABSENCE — a pass that found divergence, and a pass
 * that stopped happening. A log line can say a pass ran; only a row can page when none did.
 * The founding failure is a lost Stripe webhook leaving a no-card trial mirrored as
 * full-featured forever, with every test green — the reconciler heals it, and this table is
 * how a human hears that a heal was ever needed (a heal needed = a webhook was lost = the
 * pipeline needs looking at).
 *
 * CONTENT RULES, because `ohmail_admin` is granted SELECT on most columns: `flagged` is a
 * closed code→count map (`ReconcileCode` — the write site's exported vocabulary) and `error`
 * is class:code scrubbed, NEVER message text — the same scrubbing rule as
 * `billing_events.error`. `divergences` (codes + Stripe/account ids, bounded) is deliberately
 * NOT granted to the staff role; the alert needs counts, not rows.
 */
export const billingReconciliationRuns = pgTable("billing_reconciliation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).defaultNow().notNull(),
  /** 'dry-run' never applied anything; 'apply' is the armed pass. CHECK-constrained. */
  mode: text("mode").notNull(),
  /** How many subscriptions Stripe listed / mirror rows were read — the pass's population. */
  stripeSubscriptions: integer("stripe_subscriptions").notNull(),
  mirrorRows: integer("mirror_rows").notNull(),
  /** Events re-emitted through claim+apply (or that WOULD be, on a dry run). */
  emitted: integer("emitted").notNull(),
  /** Emitted events whose apply answered non-200 — each also left a failed billing_events row. */
  applyFailed: integer("apply_failed").notNull(),
  /** Closed code→count map of divergences NOT healed by an emit (test_row, missing_in_stripe, …). */
  flagged: jsonb("flagged").notNull().default(sql`'{}'::jsonb`),
  /** Bounded list of {code, stripeSubscriptionId, accountId} — the operator's detail. */
  divergences: jsonb("divergences").notNull().default(sql`'[]'::jsonb`),
  pages: integer("pages").notNull(),
  /** True when the page bound stopped the listing early — absence checks were skipped. */
  truncated: boolean("truncated").notNull().default(false),
  /** class:code, scrubbed — null on a completed pass. A non-null row does not reset staleness. */
  error: text("error"),
}, (t) => ({ ixRanAt: index("billing_recon_runs_ran_at_idx").on(t.ranAt) }));

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION & ONBOARDING (migration 0020): the funnel's two tables.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everyone who asked to be let in, from `POST /waitlist` (the landing form).
 *
 * UPSERTed on `email`, never appended: a person who submits the form three times is one
 * entry, one confirmation mail (the mailer's per-recipient limiter takes care of the rest), and
 * one `updated_at` that moves when they change their mind about the tier.
 *
 * `invited_at` / `registered_at` make the whole funnel readable from this one table —
 * waiting → invited → registered — which is the only reporting the beta needs and is what
 * the operator mint script lists.
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
 * STAFF IDENTITY FOR THE ADMIN CONSOLE (cloud migration 0007). One operator, no RBAC.
 *
 * ── WHY THIS IS NOT A ROW IN `users`, AND MUST NOT BECOME ONE ─────────────────────────────
 *
 * `users` is the CUSTOMER identity: it is joined to `accounts`, it carries the product's own
 * 2FA, its sessions authorise mail reads, and a row in it is reachable from the product's
 * whole auth surface. A `role='staff'` column on that table would mean one SQL mistake, one
 * over-broad `OR`, or one forgotten predicate anywhere in the product's auth path is a
 * privilege escalation into cross-account access. Keeping staff in a table the product's auth
 * never queries means the product has no code path that can promote anybody into it.
 *
 * It is also why the console's sign-in cannot reuse `AuthService`: that service exists to
 * establish CUSTOMER sessions against `users`, and pointing it at a different table would be
 * the same coupling by another route.
 *
 * ── WHAT THE BLIND ROLE CAN SEE OF IT: NOTHING ────────────────────────────────────────────
 *
 * `ohmail_admin` (the content-blind handle every admin READ runs on — `staff-grants.ts`) is
 * granted column by column against an allowlist, and this table is not on it. So the role
 * that serves the console cannot read a password hash or a sealed TOTP secret even though the
 * console it serves is the thing those credentials protect. The staff routes run on the
 * RUNTIME connection instead (`deps.db`), which is why this table needs no grant change and
 * the blindness attestation is untouched by this slice.
 *
 * ── THE TOTP SECRET IS SEALED, NEVER PLAINTEXT ────────────────────────────────────────────
 *
 * Same envelope as `totp_secrets`: `secret_enc` + `key_version` through the KeyProvider,
 * so a database dump is not a set of working authenticators. `last_consumed_step` is the
 * single-use-per-timestep guard — without it the same six digits replay for the whole
 * 30-second window, which is a real login for anyone who can read one over a shoulder.
 *
 * `totp_activated` is separate from "a secret exists" on purpose: enrolment writes the secret
 * FIRST and flips this only once a code from it has verified. An enrolment that is abandoned
 * half way leaves a row nobody can sign in with, rather than a locked-out operator.
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
 * THE STAFF SESSION (cloud migration 0007). Opaque, hashed at rest, revocable.
 *
 * ── WHY THIS IS A TABLE AND NOT A SIGNED COOKIE ───────────────────────────────────────────
 *
 * The operator console's outer gate (its middleware) uses a STATELESS signed token, and
 * that is right for what it guards: it hides the surface, it has no identity to revoke, and
 * rotating one environment variable invalidates every issued token at once with no state.
 *
 * This credential is different in kind. It authorises WRITES — suspending an account, moving
 * credits through the ledger — and it names the person the audit row will blame. A
 * self-verifying token cannot be withdrawn: a laptop lost at 09:00 stays signed in until the
 * expiry it was minted with, and the only remedy is rotating the signing secret, which signs
 * out everybody and is indistinguishable from an outage. So the row IS the session, and
 * `revoked_at` is a sign-out that actually signs out.
 *
 * Verifiable-without-a-round-trip was considered and rejected: every consumer of this cookie
 * is a write endpoint that is about to talk to the database anyway, so the round trip is free,
 * and buying "stateless" with "unrevocable" is a bad trade for the credential that moves money.
 *
 * ── `expires_at` IS THE AUTHORITY, NOT THE COOKIE'S `Max-Age` ─────────────────────────────
 *
 * `Max-Age` is a client-side attribute a client controls; a cookie whose attribute was stripped
 * or edited is still presented. The middleware's own note makes the same point about the gate
 * token. So the column decides, and the cookie attribute is a courtesy that makes browsers
 * tidy up on time.
 *
 * ── HASH AT REST ──────────────────────────────────────────────────────────────────────────
 *
 * `token_hash` via `hashToken`, exactly as `sessions`/`refresh_tokens` do it: a database dump
 * — or a read-only SQL injection anywhere — is then a list of useless digests rather than a
 * set of live staff sessions. The plaintext exists only in the operator's cookie jar.
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
 * ACCOUNT SUSPENSION — the operator's off switch (cloud migration 0008), and a HOSTED-ONLY fact.
 *
 * ── WHY A CLOUD TABLE AND NOT `accounts.suspended_at` ─────────────────────────────────────
 *
 * Suspension is an act of the hosted operations surface: a staff member stops serving an
 * account. It has no meaning on a LOCAL desktop install — there is no operator and nobody to
 * suspend — so it belongs on the private half, exactly like `staff_users`. Two hard reasons
 * settle it beyond taste: `accounts` is a MAIL table (`schema-mail.ts:735`, partitioned MAIL in
 * `journal-split.test.ts`), so a cloud migration that ran `ALTER TABLE accounts` would break the
 * closure rule (`journal-split.test.ts:648` — no cloud statement may DDL a shared object); and a
 * `suspended_by` reference to `staff_users` is a private object a mail statement may never name
 * (`journal-split.test.ts:638`). A column on `accounts` could not carry the actor at all — the
 * one thing this table exists to record.
 *
 * ── PRESENCE IS THE STATE ─────────────────────────────────────────────────────────────────
 *
 * A row means "suspended"; its absence means "not". Resume is a DELETE, not a `resumed_at` flag,
 * for one reason: with a nullable timestamp every reader (`accountsWithSyncDisabled`,
 * `spendState`, `readMailboxAllowance`, `billing-service`) would have to remember
 * `AND resumed_at IS NULL`, and a forgotten predicate is precisely the "someone kept it narrow"
 * failure the staff-blindness rule exists to make structural. Presence-is-state has no
 * predicate to forget. The AUDIT of a
 * suspend/resume lives in `audit_log` (the append-only history); this table is only the current
 * fact the entitlement readers gate on.
 *
 * ── WHAT THE BLIND CONSOLE MAY READ ───────────────────────────────────────────────────────
 *
 * `ohmail_admin` is granted `SELECT (account_id, suspended_at)` and nothing more — enough for
 * the console to show WHO is suspended and SINCE WHEN; `suspended_by` and `note` stay off the
 * allowlist until a screen renders them. The WRITE runs on the runtime connection (`deps.db`),
 * never on the blind role — a write grant on `ohmail_admin` would fail its boot attestation
 * (`staff-grants.ts`). See `scripts/harden-staff-role.sql`.
 */
export const accountSuspensions = pgTable("account_suspensions", {
  /** One suspension per account — the PK IS the mutual-exclusion the write's ON CONFLICT keys on. */
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  /** When the current suspension began. `defaultNow()` so the write need not compute it. */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }).defaultNow().notNull(),
  /**
   * The staff member who suspended, or NULL for a suspension the billing webhook wrote (a
   * revenue reversal — cloud 0012). The system writer has no staff identity, and a sentinel
   * staff row would surface a fake operator in every roster read; NULL plus the `note`'s
   * `stripe:<event type>:<object id>` provenance keeps the audit honest instead.
   */
  suspendedBy: uuid("suspended_by").references(() => staffUsers.id),
  /** The operator's stated reason. Required at the write site, nullable here for hand-inserts. */
  note: text("note"),
});

/**
 * THE MAILBOX OAuth2 CEREMONY (cloud 0009) — a redirect-based consent flow in flight, and a
 * HOSTED-ONLY fact.
 *
 * A row exists for the ninety seconds between "this account pressed Connect Outlook" and
 * "Microsoft redirected their browser back". It holds the PKCE verifier the code exchange needs
 * and the account the ceremony belongs to, and it is consumed exactly once.
 *
 * ── `state` IS THE PRIMARY KEY BECAUSE IT IS THE CONSUMPTION KEY ──────────────────────────
 *
 * 256 bits of `randomBytes`, base64url. It is the redirect's CSRF token (RFC 6749 §10.12) and the
 * key the single-use write turns on:
 * `UPDATE … SET consumed_at = now() WHERE state = $1 AND consumed_at IS NULL RETURNING …`.
 * Postgres serializes two concurrent replays of one authorization code on the row, so the loser
 * reads zero rows and is refused — there is no read-then-write window, which is why the callback
 * does not `SELECT` first. See `packages/api/src/routes/mailbox-oauth.ts`.
 *
 * ── THE VERIFIER IS ENVELOPE-ENCRYPTED, KEY VERSION BESIDE IT ─────────────────────────────
 *
 * Same shape as `totpSecrets.secretEnc` / `mailboxCredentials.secretEnc`. Both columns are NOT
 * NULL together, so unlike `staffUsers` there is no "sealed together" CHECK to write — the state
 * where one exists without the other is unrepresentable. A verifier alone buys nothing (redeeming
 * the code also needs the confidential client's secret); it is encrypted because this row is the
 * one place a read-only injection could stand between a leaked code and somebody's mailbox.
 *
 * ── DELIBERATELY NO `mailbox_id` ──────────────────────────────────────────────────────────
 *
 * A reconnect does not name a mailbox row. The address comes from the `id_token`'s
 * `preferred_username` claim and mail 0021's `mailboxes_active_address_uq` makes at most one live
 * mailbox per (account, lower(address)) — so the callback resolves its target BY ADDRESS. A
 * `mailbox_id` would be a second answer to the same question, and a person who starts a reconnect
 * for A and then signs in to Microsoft as B would have row A repointed at an address it does not
 * hold.
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
 * THE DEVICE-CODE CEREMONY (cloud 0027) — the self-host door's in-flight state.
 *
 * A SEPARATE TABLE from `mailbox_oauth_ceremonies`, and the reason is not that the fields differ a
 * little. It is that the two ceremonies have opposite consumption disciplines and one column that
 * cannot be shared:
 *
 *  · The redirect ceremony is spent by ONE request. Its `code_verifier_enc` is NOT NULL, and a
 *    device ceremony has no PKCE verifier to put there — the device grant has no redirect and no
 *    authorization code, so there is nothing for a verifier to bind (RFC 8628 has no PKCE arm).
 *    Sharing the table would mean either dropping that NOT NULL — weakening the redirect flow's
 *    own invariant for a feature that does not use the column — or storing a dummy verifier, which
 *    is a lie in the one place a reader most needs the truth.
 *  · The device ceremony is READ REPEATEDLY and consumed once. A person is walking to a browser;
 *    this row is polled every few seconds for up to fifteen minutes and must survive every one of
 *    those reads. Its single-use write happens only on a TERMINAL verdict. Two disciplines in one
 *    table is one `WHERE` clause away from the poll consuming the ceremony it is polling for.
 *
 * ── WHAT IS SECRET HERE, AND WHAT IS MERELY ON SCREEN ─────────────────────────────────────
 *
 * `device_code_enc` is the bearer credential that redeems the grant. It is a KEK envelope for the
 * same reason `mailbox_credentials.secret_enc` is: this row is the one place a read-only injection
 * could stand between the ceremony and somebody's mailbox. It is never rendered and never logged.
 *
 * `user_code` and `verification_uri` are the two values the person is SHOWN. They are stored in
 * clear, deliberately, and storing them adds no exposure the start response did not already have —
 * what it buys is that a poll can re-supply them, so reloading the settings page does not strand a
 * live grant the operator can no longer complete.
 *
 * ── `poll_interval_ms` AND `last_polled_at` ARE THE SHARED CLIENT'S PROTECTION ────────────
 *
 * RFC 8628 §3.5 requires the interval to increase by five seconds on every `slow_down`,
 * CUMULATIVELY. Across a stateless poll route that arithmetic has nowhere to live but this row: a
 * client that carried it could simply not, and the client id being throttled is SHARED by every
 * self-hosted install using the public registration, so one buggy or hostile caller degrades the
 * flow for all of them. The server therefore holds the interval and refuses a poll that arrives
 * early, without spending a request on Microsoft to be told so.
 *
 * ── DELIBERATELY NO `mailbox_id`, FOR THE REDIRECT CEREMONY'S REASON VERBATIM ─────────────
 *
 * The address comes from the `id_token` this ceremony's own tokens carry, and the live-address
 * unique index resolves the target row. A `mailbox_id` here would be a second answer to a question
 * the token already answers, and it would let a ceremony started for one address attach to another.
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
 * THE OPERATOR'S OAuth APPLICATION REGISTRATION (cloud 0009) — the Entra app the whole hosted
 * deployment signs with, managed from the admin console.
 *
 * ── ONE ROW PER PROVIDER, `provider` AS THE PRIMARY KEY ───────────────────────────────────
 *
 * Two live registrations for one provider is a state no reader could resolve: the API's authorize
 * URL and the worker's token POST would name different clients and only one of them would work.
 * The PK makes it unrepresentable and makes the write an `ON CONFLICT (provider) DO UPDATE`.
 *
 * ── A TABLE, WITH ENV AS THE BOOTSTRAP ────────────────────────────────────────────────────
 *
 * A client secret rotated in Azure must be replaceable without redeploying two apps, so the
 * registration is a row. `MS_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_SECRET` / `MS_OAUTH_TENANT` stay
 * as the FALLBACK — `resolveOAuthProviderConfig` (`oauth-config.ts`) prefers the row and drops to
 * env, so a first deploy works with no row and an operator locked out of the console still has a
 * way in. Both readers, the API and the worker, call that one resolver: there is exactly one
 * precedence rule and neither host re-derives it.
 *
 * ── THE SECRET NEVER COMES BACK OUT ───────────────────────────────────────────────────────
 *
 * `clientSecretEnc` is the KEK envelope; the admin read projects `secretSet: boolean` and nothing
 * else, ever. Both secret columns are nullable TOGETHER — a half-written registration is a real
 * state (an id and a tenant saved before Azure has minted the secret) — and the CHECK is what makes
 * "sealed together" true rather than hoped for, exactly as `staffUsers` does over its TOTP secret.
 *
 * `enabled` defaults FALSE: a registration that exists is not one that is live. The dangerous
 * direction would be a default of true, which offers a consent screen the deployment cannot
 * complete.
 *
 * `redirectUris` / `scopes` are jsonb arrays because Azure holds several — the hosted web callback
 * now, a loopback URI for the desktop flow later. The web ceremony selects the first `https://`
 * entry, so a loopback URI sits in the list without changing which one the browser uses.
 *
 * `updatedBy` is the `staff_users` actor, and it is why this table cannot live in the mail journal.
 * There is no `audit_log` row for a change here — `auditLog.accountId` is NOT NULL and this change
 * belongs to no account — so the actor, the time and the operator's note live on the row.
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
 * STAGED ATTACHMENT BYTES — the ticket half of the hosted send's direct-upload transport, and a
 * HOSTED-ONLY fact.
 *
 * ── WHY THE TABLE EXISTS AT ALL ───────────────────────────────────────────────────────────
 *
 * Attachment bytes used to ride the send request base64-encoded, which put the whole feature
 * under the hosted platform's ~4.5 MB request-body limit and forced the compose surface to
 * promise 3 MB whatever the user's own mail server announced. The bytes now go to object storage
 * on a signed URL the browser uses directly, and the send request carries a REFERENCE. This row
 * is that reference: it is what makes the ticket account-scoped, size-bounded and expiring, none
 * of which an opaque object path in a request body would be.
 *
 * ── WHY CLOUD AND NOT MAIL ────────────────────────────────────────────────────────────────
 *
 * Staging is a property of the HOSTED transport, exactly as `account_suspensions` is a property
 * of the hosted operations surface. A local install runs the send handler in the same process as
 * its own SMTP dial — there is no request body between the compose form and the wire, so there is
 * nothing to stage AROUND and no object storage to stage INTO. The mail journal creating this
 * table would put a table nothing on that install can ever write into every desktop database.
 * (It references `accounts`, a MAIL table — legal in this direction: mail runs first.)
 *
 * ── WHAT THE COLUMNS ARE FOR ──────────────────────────────────────────────────────────────
 *
 * `object_path` is where the bytes are, and it is UNIQUE because it is also the delete key: the
 * sweep removes the row and the object as a pair, and two rows naming one object would leave a
 * live row pointing at bytes another row's expiry already deleted.
 *
 * `size_bytes` is the size the MINT was asked for and refused against — the client's declaration,
 * not a measurement. It is stored because the send re-checks the declared total before it
 * downloads anything: refusing 40 MB of tickets costs one query, while discovering the same fact
 * after the download costs the transfer. The bytes themselves are measured again after download,
 * which is the check that catches a client that declared one size and uploaded another.
 *
 * `expires_at` is the retention promise as a row fact rather than as a convention, so the sweep
 * has a predicate and the privacy copy has something to be true about.
 *
 * There is no `consumed_at`. A send does not consume a ticket — it reads the bytes and leaves the
 * row to expire, because a send that fails mid-flight and is retried under the same idempotency
 * key must find the same bytes still there. Retention, not consumption, is what ends a staging
 * row's life.
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
 * A consumable, expiring, EMAIL-BOUND beta invite — an open item the session-hardening work
 * named and deferred for want of a migration number.
 *
 * Three properties, each of which the `AuthConfig.inviteCodes` `Set` structurally cannot
 * have, and each of which a user-visible refusal depends on:
 *
 *  · **hashed** (`code_hash = sha256(raw)`, same as every other bearer credential here) —
 *    a database dump is not a list of working invites;
 *  · **single-use** — consumption is one `UPDATE … WHERE code_hash = $1 AND consumed_at IS
 *    NULL AND expires_at > now RETURNING id` inside the registering transaction, so two
 *    concurrent redemptions of one code produce exactly one account and one honest
 *    `invite_used`;
 *  · **email-bound** (`email` NOT NULL) — the register endpoint's 201-vs-409 answer is an
 *    account-existence oracle for whatever address the caller types, and binding the code
 *    to one address reduces that to "the inbox you already control". See 0020's header for
 *    the argument in full.
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
   * Does redeeming this invite PROVE its holder controls `email`? (migration 0018)
   *
   * Register's invite path stamps `users.email_verified_at` only when this is true. TRUE for
   * mailed invites (receipt is the proof — the same argument a mailed verification link stands
   * on) and for the invite minted by a server's first-boot setup token (control of the box is
   * the proof). FALSE for invites minted by a pairing-token redeem, where the redeemer typed
   * the address and nothing was ever mailed: those accounts register fine and verify later
   * through the ordinary mailed flow. The writer decides from its own record — the pairing
   * redeem reads the consumed token row, never a caller-supplied flag.
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
 * SETUP GRANTS (cloud 0021) — the screening-only, expiring credit pool granted once per
 * connected mailbox (see `SETUP_GRANT_CREDITS_PER_MAILBOX`), SEPARATE from the main ledger.
 *
 * Separate because two of its three properties are not expressible on the one main balance:
 * "screening-only" needs the spender to know which pool it draws, and "expires in 90 days"
 * needs an attributable remainder — which a commingled balance has not, and which the monthly
 * renewal's `period_expiry` would eat at the first cycle boundary regardless (the
 * renewal-boundary hazard the architecture review flagged). The Screener suggestion gates draw
 * this pool FIRST (`setup-grant.ts#withSetupPool`), before the main balance, and a setup-funded
 * suggestion writes NOTHING to `credit_ledger` — the money audit's invariants keep their exact
 * meaning.
 *
 * `UNIQUE (mailbox_id)` is "one grant per mailbox, ever" as a table fact — the trial bounty's
 * pattern. No FK on the mailbox, deliberately: the grant must survive a disconnect precisely so
 * a reconnect cannot re-arm it.
 */
export const setupGrants = pgTable("setup_grants", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").notNull(),
  granted: integer("granted").notNull(),
  remaining: integer("remaining").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqMailbox: unique("setup_grants_mailbox_uq").on(t.mailboxId),
  ixAccountExpiry: index("setup_grants_account_expiry_idx").on(t.accountId, t.expiresAt),
  ckBounds: check("setup_grants_remaining_bounds", sql`${t.remaining} >= 0 AND ${t.remaining} <= ${t.granted}`),
  ckPositive: check("setup_grants_granted_positive", sql`${t.granted} > 0`),
}));

/**
 * The pool's own idempotency ledger — `PRIMARY KEY (account_id, source)` mirrors
 * `credit_ledger`'s UNIQUE so a crash-retried suggestion is a free retry here exactly as it is
 * on the main ledger; `refunded_at` is the exactly-once refund marker.
 */
export const setupGrantSpends = pgTable("setup_grant_spends", {
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  grantId: uuid("grant_id").notNull().references(() => setupGrants.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ name: "setup_grant_spends_pk", columns: [t.accountId, t.source] }),
  ixGrant: index("setup_grant_spends_grant_idx").on(t.grantId),
  ckAmount: check("setup_grant_spends_amount_positive", sql`${t.amount} > 0`),
  ckSourceLen: check("setup_grant_spends_source_len", sql`char_length(${t.source}) <= 200`),
}));

/**
 * The Cloud-only half as one object, for `drizzle(client, { schema })`.
 *
 * Spread into `schema` by `./schema.js` for every consumer that wants both halves. A local
 * install passes THIS one and nothing else — see `apps/sidecar/src/db.ts`.
 */
export const cloudSchema = {
  credentials, webauthnCredentials, webauthnChallenges, totpSecrets, recoveryCodes, loginTokens, oauthAuthCodes, authEvents, authThrottle, pushSubscriptions, billingCustomers, billingSubscriptions, billingReconciliationRuns, creditBalances, creditLedger, billingEvents, workerHeartbeats, alertState, waitlist, staffUsers, staffSessions, accountSuspensions,
  mailboxOauthCeremonies, mailboxOauthDeviceCeremonies,
  oauthProviderConfig, attachmentStaging, invites, aiAttemptClaims,
  setupGrants, setupGrantSpends,
};
