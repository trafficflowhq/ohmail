import {
  MAIL_SCHEMA_MARKERS, SCHEMA_INDEX_MARKERS, SCHEMA_CHECK_MARKERS,
  MAIL_SCHEMA_MARKER_JOURNAL_TAG, type SchemaMarker, type CheckDefinitionMarker,
  type FunctionDefinitionMarker,
} from "./health.js";
import { registerSchemaCensus } from "./health-census.js";

/**
 * THE HOSTED HALF OF THE SCHEMA-MARKER CENSUS — separated from `health.ts` because of what it
 * IS, not because of what it weighs.
 *
 * The entries below are Cloud table and column names. `health.ts` is mounted by the LOCAL route
 * table, which is bundled into the desktop engine and shipped, so while these lived there the
 * artifact a stranger downloads carried `staff_users.password_hash`,
 * `staff_sessions.token_hash` and `credit_ledger.source` as live data. That is the same
 * disclosure the `@trafficflow/db` barrel split closed on the import side, arriving through a
 * route module instead.
 *
 * Nothing local imports this file. The hosted composition passes {@link CLOUD_TIER_MARKERS} and
 * {@link EXPECTED_MARKERS} through `HealthConfig`, the same channel that already carries
 * `schemaTier`, and a host that declares the full tier without them is a configuration fault
 * rather than a host that quietly probes less.
 */
/**
 * The cloud half — every marker whose column is created by `packages/db/drizzle-cloud`.
 *
 * This is the list that reports the mail-committed / cloud-failed state: every one of these is
 * absent while a cloud pass is incomplete, so the deployment answers `503 schema_incomplete`
 * instead of serving requests that would 500 on a missing table.
 */
export const CLOUD_SCHEMA_MARKERS: ReadonlyArray<SchemaMarker> = [
  ["credit_ledger", "source"],      // cloud 0002_billing (legacy 0018)
  ["worker_heartbeats", "beat_at"], // cloud 0003_observability (legacy 0019)
  // cloud 0004_waitlist_invites (legacy 0020) — TWO markers, not one, because the migration
  // created two independent tables and the funnel breaks differently depending on which is
  // missing: without `waitlist` the landing's signup 500s, without `invites` nobody can register
  // at all. `invites.code_hash` is the column the single-use consumption keys on
  // (`UPDATE … WHERE code_hash = $1 AND consumed_at IS NULL`), so it is the one a query actually
  // reads — the same rule that picked `credit_ledger.source`.
  ["waitlist", "email"],
  ["invites", "code_hash"],
  // cloud 0005_invite_revocation (legacy 0021) — `revoked_at` is the column, not the index,
  // because this probe reads `information_schema.columns`. It is enough: that is one migration,
  // so a database with this column has also taken `users_email_unique_idx`, and a database that
  // has not taken it at all fails here rather than at the first invite an operator revokes.
  ["invites", "revoked_at"],
  // cloud 0007_staff_users — TWO markers, because the migration created two independent
  // tables and a database missing either one fails differently. Without `staff_users` there is
  // nobody to sign in as; without `staff_sessions` the sign-in succeeds and then every
  // subsequent request is anonymous again, which presents as a console that will not stay
  // signed in rather than as a missing migration.
  //
  // The columns are the ones a QUERY actually reads, which is the rule `credit_ledger.source`
  // and `invites.code_hash` established. `password_hash` is read by every sign-in;
  // `token_hash` is the column `resolveStaffSession` looks a presented cookie up by. Neither
  // is `id`, for the reason the mail markers give: a primary key exists the moment the table
  // does, so it cannot distinguish a fully-migrated table from a half-applied one.
  ["staff_users", "password_hash"],
  ["staff_sessions", "token_hash"],
  // cloud 0008_account_suspension — the ONE table this migration creates. `suspended_at` is
  // the column a query reads (the entitlement gates ask "is there a suspension row and when"), not
  // the PK `account_id`: the rule the mail markers set is to pick the column a query touches, and
  // a database missing this migration fails here rather than at the first suspend, which would
  // 42P01 on a table that does not exist.
  ["account_suspensions", "suspended_at"],
  // cloud 0009_mailbox_oauth — TWO markers, because the migration creates two INDEPENDENT tables and
  // a database missing either one fails differently, which is the rule 0004 and 0007 set.
  //
  //  · without `mailbox_oauth_ceremonies`, `POST …/oauth/microsoft/start` 42P01s on the insert — the
  //    consent screen never opens and nothing is stored;
  //  · without `oauth_provider_config`, the RESOLVER's first read 42P01s, so the flow reports "not
  //    configured" on a deployment whose environment carries a perfectly good registration. That is
  //    the more dangerous of the two, because it presents as a configuration mistake rather than as
  //    a missing migration.
  //
  // The columns are the ones a QUERY touches, not the primary keys. `consumed_at` is the column the
  // single-use consume predicates on (`WHERE state = $1 AND consumed_at IS NULL`) — the PK `state`
  // exists the moment the table does and so cannot distinguish a complete table from a half-applied
  // one. `client_secret_enc` is what the resolver reads and decrypts; `provider` is the PK and is
  // excluded for the same reason.
  ["mailbox_oauth_ceremonies", "consumed_at"],
  ["oauth_provider_config", "client_secret_enc"],
  // cloud 0027_oauth_device_ceremonies — ONE marker, for the device-code door's own table.
  //
  // Without it, `POST …/oauth/microsoft/device/start` 42P01s on the insert AFTER it has already
  // asked Microsoft for a grant — so the person is never shown the code for a ceremony that now
  // exists at Microsoft's end and will sit there until it expires. The failure is a 500 on a route
  // whose availability read said the door was armed, which is precisely the "too-early code"
  // shape these markers exist to turn into a `/health` answer instead.
  //
  // `poll_interval_ms` and not the PK: `state` exists the moment the table does, so it cannot tell
  // a complete table from a half-applied one. The interval is what the poll lease's predicate
  // reads, which is the rule every marker above follows — pick the column a QUERY touches.
  ["mailbox_oauth_device_ceremonies", "poll_interval_ms"],
  // cloud 0010_desktop_link_pkce — ONE marker, because the migration adds ONE column. It is the
  // column the desktop handoff CLAIM predicates on, which is the rule every marker above follows:
  // pick what a query touches. A database missing it does not merely lose the deep-link path — the
  // claim's `WHERE … challenge_hash IS NULL` 42703s, so the RETYPE path fails too, and it fails
  // with an undefined-column error on a public route rather than with a refusal anybody can read.
  ["login_tokens", "challenge_hash"],
  // cloud 0015_attachment_staging — the hosted send's upload tickets. ONE marker, because the
  // migration creates ONE table, and the column is the one a QUERY touches rather than the PK:
  // every read is `WHERE account_id = $1 AND id = ANY($2)`, and `id` exists the moment the table
  // does, so it cannot distinguish a complete table from a half-applied one.
  //
  // The absence is NOT silent the way an index's would be, which is why the column class is the
  // right one here (0013 and 0014 needed new classes precisely because they had no column to
  // probe): without this table `POST /attachments/staging` 42P01s on its insert and every send
  // over the inline ceiling fails at the upload step. A 503 at the deploy gate is the better
  // version of that.
  ["attachment_staging", "expires_at"],
  // cloud 0016_ai_attempt_claims — the exclusive claim the AI spend gate holds across a paid model
  // call. ONE marker, one created table, and the column follows the same rule every
  // marker above does: probe what a QUERY touches, never the primary key. `(account_id, source)`
  // IS the PK and exists the moment the table does; `expires_at` is what the claim's `ON CONFLICT
  // DO UPDATE … WHERE expires_at <= now()` predicates on, so it distinguishes a complete table
  // from a half-applied one.
  //
  // The absence is loud rather than silent, which is what makes the column class right here: with
  // no table, `claimAiAttempt` 42P01s inside the gate's transaction — and the gate SWALLOWS every
  // error by contract, so a deployment missing this migration would not fail visibly. It
  // would degrade every Screener suggestion to `refusal: "fault"` and answer 503 while the ledger
  // stayed untouched. A 503 at the deploy gate is the same answer, given somewhere a human reads.
  ["ai_attempt_claims", "expires_at"],
  // cloud 0017_oauth_code_twofa_provenance — the authorizing session's real `last_twofa_at`,
  // carried across the native PKCE hop. One added column, so the ordinary class
  // sees it, and there is no choice of probe to argue: the migration IS this column.
  //
  // The absence is SILENT, and that is the reason it needs a marker rather than a note. A missing
  // column here does not 42703 the way `login_tokens.challenge_hash` does, because the failure is
  // on the WRITE and it is `INSERT`-shaped: drizzle emits the column, Postgres rejects the
  // statement, and `GET /oauth/authorize` answers a 500 through the raw pipeline's plain error —
  // on a route the shipped clients do not call, so nobody would see it. Meanwhile the property
  // the column exists to hold would simply be absent. A 503 at the deploy gate is how that
  // becomes visible before it is deployed rather than never.
  ["oauth_auth_codes", "twofa_at"],
  // cloud 0018_invites_confers_verified — does redeeming this invite prove address control?
  // One added column, `NOT NULL DEFAULT true`, and the default is what makes the marker
  // load-bearing rather than decorative: on a database missing this migration the register
  // path's SELECT-through-drizzle 42703s loudly, but the PAIRING redeem's insert — the one
  // writer that must set FALSE — would also 42703, and the tempting "fix" on such a host is to
  // stop writing the column, which resurrects the exact verification forgery the column exists
  // to close. A 503 at the deploy gate forecloses the whole path.
  ["invites", "confers_verified"],
  // cloud 0019_storage_bytes_limit — the third sold-at allowance on the subscription row, the
  // managed stored-body cap. The easy case (one added `NOT NULL` bigint), and its sentence is
  // about how WIDELY it fails: every subscription read names the column in its select list —
  // `liveSubscriptionOf`, `newestSubscriptionOf`, the roster's `DISTINCT ON` — so an API ahead
  // of the migration 42703s the billing status route, the mailbox gate AND the webhook mirror's
  // upsert (which writes the column with its grandfathering CASE), while the WORKER's cap read
  // (`storageCapOf`, per account per cycle) fails into its own logged fail-open and quietly
  // unmeters storage — the one consumer whose failure is silent, which is exactly what the
  // deploy-gate 503 exists to forestall. Deploy order: migration → API → worker.
  ["billing_subscriptions", "storage_bytes_limit"],
  // cloud 0021_setup_grants — TWO markers for two independent tables, the rule 0007 set: without
  // `setup_grants` no mailbox connect can write its screening pool (the create transaction
  // 42703s — loud); without `setup_grant_spends` the pool EXISTS but every draw fails inside
  // the gate wrapper, whose contract swallows faults — the Screener silently bills the main
  // balance instead, which is exactly the quiet mispricing a deploy gate exists to refuse.
  // The columns are the ones the queries read: `expires_at` is the draw predicate's whole
  // point, `refunded_at` the exactly-once refund marker.
  ["setup_grants", "expires_at"],
  ["setup_grant_spends", "refunded_at"],
  // cloud 0022_subscription_addons — the add-on quantities and the billing cadence on the
  // mirror row. One marker per concern: `addon_storage_units` stands for the pair of addon
  // columns (one migration, one failure mode — the mirror upsert 42703s on either), and
  // `billing_interval` is the column whose absence is SILENT in the way this class exists
  // for: every query still runs, and an annual customer's cycle invoice simply grants one
  // month in twelve.
  ["billing_subscriptions", "addon_storage_units"],
  ["billing_subscriptions", "billing_interval"],
  // cloud 0023_billing_reconciliation — the reconciliation run ledger. `ran_at` is the column
  // BOTH alert rules key their newest-run reads on, so a database missing the table fails here
  // at the deploy gate rather than as an `alert_pass_failed` loop — the pager breaking is the
  // one failure mode this table must never have, since it exists to page.
  ["billing_reconciliation_runs", "ran_at"],
  // cloud 0025_alert_renotify_signature — the renotify policy's condition signature on
  // `alert_state`. The migration IS this column, and its absence is LOUD in the worst place:
  // `runAlertPass`'s claim UPDATE names it, so a database missing the migration 42703s the
  // claim on every pass, every minute, from both drivers — an `alert_pass_failed` loop, which
  // is the pager breaking, the one failure this table must never have (0023's sentence, one
  // row up, and the same reason the deploy gate must refuse it first). Deploy order:
  // migration → API + worker.
  ["alert_state", "notified_signature"],
  // cloud 0026_alert_claim_lease — the notify claim's lease as its own column, so
  // `notified_at` means exactly "the last confirmed notification". Same failure shape as
  // 0025, one row up: the claim's SELECT and UPDATE both name it, so a database missing the
  // migration is an `alert_pass_failed` loop from both drivers. Deploy order: migration →
  // API + worker.
  ["alert_state", "claimed_until"],
] as const;

/**
 * The CLOUD constraints probed by DEFINITION — see {@link CheckDefinitionMarker} for the shape
 * and for why a name-only probe cannot see them.
 *
 * Cloud `0011_trial_credits` is the first migration in either journal whose entire content is a
 * REPLACEMENT: both CHECKs are dropped and re-added under their existing names, deliberately, so
 * that the migration file is re-runnable and so the pg test that reads `pg_constraint` keeps
 * asserting stable names. The consequence is that nothing about a `0010` database looks different
 * from a `0011` one to any catalog query that reads names — not `information_schema.columns`, not
 * `pg_indexes`, and not `SCHEMA_CHECK_MARKERS`.
 *
 * TWO entries and not one, because the two constraints fail differently and a database can
 * genuinely have one without the other: a hand-run repair, or a migration interrupted between the
 * two `ALTER TABLE`s on a server whose DDL was not wrapped. Without the sign rule a `trial_grant`
 * row is rejected whatever its source; without the source rule it is rejected for its namespace.
 * Both present as the same 500 from the webhook, and naming them separately is what tells an
 * operator which half to look at.
 *
 * The substrings are the vocabulary the migration ADDED, which is what makes them unsatisfiable
 * by the old definition: `trial_grant` cannot appear in a sign rule that does not know the
 * reason, and `trial:%` cannot appear in a source rule that does not pin its namespace. The
 * source rule's needle is the namespace rather than the reason on purpose — its definition names
 * both, so `trial_grant` alone would be satisfied by a partially-updated constraint.
 */
export const CLOUD_CHECK_DEFINITION_MARKERS: ReadonlyArray<CheckDefinitionMarker> = [
  ["credit_ledger_sign_reason_check", "trial_grant"],
  ["credit_ledger_source_reason_check", "trial:%"],
  // cloud 0012_billing_suspension — the migration's load-bearing change (`suspended_by` DROP
  // NOT NULL, so the billing webhook's revenue-reversal suspend can write with no staff actor)
  // is invisible to every name-presence probe: `information_schema.columns` reports the column
  // either way, and nullability is not a name. The provenance CHECK the migration adds beside
  // it — every suspension names a staff actor or carries its source note — is NEW under a NEW
  // name, so probing its definition is what distinguishes an 0011 database from an 0012 one.
  // A database missing it would take the first refund webhook to a 23502 inside the apply
  // transaction instead of a 503 at the deploy gate.
  ["account_suspensions_provenance_check", "suspended_by"],
] as const;

/**
 * The CLOUD indexes probed by name through `pg_indexes` — the fourth marker class, and the
 * reason it is a HOST-SUPPLIED list rather than three more lines in `SCHEMA_INDEX_MARKERS`:
 * that list lives in `health.ts`, which ships in the desktop engine, and every entry here names
 * a Cloud table. Same disclosure rule that moved `credit_ledger.source` into this file.
 *
 * cloud 0013_ledger_integrity — `credit_ledger_one_trial_grant_idx` is the partial unique index
 * that makes "one trial bounty per account, EVER" a fact about the table rather than about the
 * granting helper's source string. Its absence is SILENT in exactly the way the index-marker
 * class exists for: no query is wrong, every suite is green, and a hand-written `trial_grant`
 * row keyed by something other than the account simply lands — a second bounty nothing reports.
 * The migration's other two artifacts (the refund CAP in the replaced `refund_origin` trigger
 * function, and the born-voided INSERT guard) are function BODIES, invisible to every catalog
 * probe `/health` has — pg_proc is not pg_constraint — so the index, which rides the same
 * journal entry, is what vouches for the file having run.
 */
export const CLOUD_INDEX_MARKERS: ReadonlyArray<string> = [
  "credit_ledger_one_trial_grant_idx",   // cloud 0013_ledger_integrity
  // cloud 0023_billing_reconciliation — the newest-run read both reconciliation alert rules
  // make (`ORDER BY ran_at DESC LIMIT 1`, twice a pass, every alert pass). The table itself is
  // probed by column below; the index rides the same journal entry, and a database that took
  // the table by hand without it would page correctly and scan for it.
  "billing_recon_runs_ran_at_idx",
  // cloud 0024_auth_events_reuse_index — the migration's WHOLE content, so this marker is what
  // vouches for the file having run (cloud 0013_ledger_integrity's rule exactly). Partial on
  // `event = 'refresh_reuse_revoked'`: the `session_reuse_revoked` alert rule scans it every
  // pass and the admin account view's security row reads it per account; without it both fall
  // back to walking the unbounded login ledger — correct, and increasingly slow, which for the
  // pass that pages a human is the failure this class exists to catch.
  "auth_events_reuse_account_at_idx",
] as const;

/**
 * The CLOUD trigger functions probed by BODY — the fifth marker class, and the one that finally
 * pays a debt `0013_ledger_integrity` recorded in its own header rather than closing.
 *
 * See {@link FunctionDefinitionMarker} for why `pg_proc.prosrc` and why a substring. Why the list
 * is HOST-SUPPLIED is the rule the two lists above already follow: `health.ts` ships in the
 * desktop engine and every function named here belongs to the billing ledger.
 *
 * `credit_ledger_check_trial_guard` — cloud `0014_ledger_trial_source`, whose ENTIRE content is
 * this function's replacement. The needle is the predicate 0014 adds, so it cannot be satisfied
 * by 0013's body. Deployed against an 0013 database, the ledger's own granting helper still
 * behaves correctly (it builds the source itself) and NOTHING else changes — the invariant is
 * simply absent, every probe reports healthy, and the first evidence is a `trial_grant` row filed
 * under an account that is not its own.
 *
 * `credit_ledger_check_refund_origin` — cloud `0013_ledger_integrity`'s refund CAP, entered here
 * RETROSPECTIVELY. 0013 is already vouched for by its index, but the index vouches for the FILE
 * having run, not for this body being the capped one: `CREATE OR REPLACE FUNCTION` is exactly the
 * statement a later hand-repair, a restored dump or a partially-replayed journal can leave at the
 * older definition with the index still standing beside it. The class now exists, so the cap
 * should be probed for itself.
 */
export const CLOUD_FUNCTION_MARKERS: ReadonlyArray<FunctionDefinitionMarker> = [
  // cloud 0014_ledger_trial_source — the bounty's source must name its own account.
  ["credit_ledger_check_trial_guard", "'trial:' || NEW.account_id::text"],
  // cloud 0013_ledger_integrity — a refund may not exceed the debit it reverses.
  ["credit_ledger_check_refund_origin", "NEW.delta > -orig_delta"],
] as const;

/**
 * The columns whose presence means "this database carries THIS application's schema" — both
 * halves, concatenated. The PUBLISHED shape (`schemaMarkers.found/expected/through`) and the
 * probe SQL read this and only this, so the split changed neither.
 */
export const SCHEMA_MARKERS: ReadonlyArray<SchemaMarker> = [
  ...MAIL_SCHEMA_MARKERS,
  ...CLOUD_SCHEMA_MARKERS,
] as const;

/**
 * Columns + indexes (both halves) + checks + check DEFINITIONS + function BODIES. What a hosted
 * `/health` measures against.
 */
export const EXPECTED_MARKERS =
  SCHEMA_MARKERS.length + SCHEMA_INDEX_MARKERS.length + CLOUD_INDEX_MARKERS.length +
  SCHEMA_CHECK_MARKERS.length + CLOUD_CHECK_DEFINITION_MARKERS.length +
  CLOUD_FUNCTION_MARKERS.length;

/** Alias that names the role rather than the shape, for the composition root. */
export const CLOUD_TIER_MARKERS = SCHEMA_MARKERS;

/**
 * The newest entry of the CLOUD journal, which {@link CLOUD_SCHEMA_MARKERS} is reconciled to.
 * Asserted by `health.test.ts` against the journal itself, so a cloud migration that adds a
 * probeable column and no marker fails there rather than in production.
 */
/* `0011_trial_credits` adds no COLUMN and no INDEX — it replaces two CHECK constraints under
 * their existing names, so {@link CLOUD_SCHEMA_MARKERS} is unchanged and still describes the
 * schema exactly. That is not the same as "nothing to probe", which is what this comment used to
 * say and what let `/health` certify a `0010` database as current: both constraint NAMES are
 * already there, so the name-only probe cannot tell the two databases apart. It is probed by
 * DEFINITION instead — see {@link CLOUD_CHECK_DEFINITION_MARKERS}.
 *
 * `0012_billing_suspension` adds no column either — its load-bearing change is a NOT NULL drop,
 * which no catalog-name probe can see — so it is probed through the provenance CHECK it adds,
 * again via {@link CLOUD_CHECK_DEFINITION_MARKERS}.
 *
 * `0013_ledger_integrity` adds no column and replaces two trigger FUNCTIONS — invisible to every
 * catalog probe — but it also creates a real INDEX, so it is probed by name through
 * {@link CLOUD_INDEX_MARKERS}, the class this migration introduced.
 *
 * `0014_ledger_trial_source` adds no column, no index and no constraint: a replaced trigger
 * function body is its WHOLE content, so it is the first migration in either journal that four of
 * the five classes cannot see at all. It is probed through {@link CLOUD_FUNCTION_MARKERS}, the
 * class it introduced — and the fact that 0013 could dodge this and 0014 could not is the reason
 * the class exists rather than a third workaround.
 *
 * `0015_attachment_staging` is the first cloud migration since 0010 that the ORIGINAL class can
 * see: it creates a real table with real columns, so it joins {@link CLOUD_SCHEMA_MARKERS} and
 * needs no new class. That is worth noting rather than passing over — three migrations in a row
 * needed a workaround or a new marker class, and the reason was that each one's whole content was
 * a constraint or a function body. A table is the easy case, and the easy case is still owed a
 * marker.
 *
 * `0016_ai_attempt_claims` is the easy case again and takes the ordinary column marker
 * (`ai_attempt_claims.expires_at`). It is worth one sentence for a reason the entries above do not
 * have: the consumer of this table is the AI spend gate, which **swallows every error by
 * contract** so that a billing fault costs a suggestion and never a message. So a database missing
 * this migration does not announce itself anywhere — every Screener suggestion degrades to a
 * `fault` refusal and a 503, with the ledger untouched and nothing logged beyond the gate's own
 * `onError`. A marker is how that becomes a deploy-gate answer instead.
 *
 * `0017_oauth_code_twofa_provenance` is the easy case too — one added column on an existing
 * table, `oauth_auth_codes.twofa_at`. Its own sentence is about how it FAILS: unlike every entry
 * above, a database missing it breaks a WRITE rather than a read, on a route no shipped client
 * calls, so the deployment would look entirely healthy while the property the column carries —
 * the real second-factor time inherited across the native handoff — was silently absent.
 *
 * `0018_invites_confers_verified` is the easy case — one added column on an existing table,
 * `invites.confers_verified`. Its sentence is about which FAILURE the marker forestalls: the
 * column's `NOT NULL DEFAULT true` means a database missing it does not corrupt data, it 42703s
 * the register and pairing-redeem paths — and the cheap repair someone reaches for on a
 * half-migrated host (drop the column from the writes) is precisely the verification forgery
 * the column closes. The deploy-gate 503 is what makes that repair never look attractive.
 *
 * `0020_replan_2026_08_21` is the FIRST data-only cloud migration: three UPDATEs, no DDL, so
 * none of the five marker classes can see it — the same shape as 0014 without even a function
 * body to probe. That is accepted rather than worked around: the values it writes are exactly
 * what `mirrorSubscription` writes for a new sale, so a database that somehow skipped it is
 * WRONG about three numbers but structurally current, and the wrongness is visible in every
 * admin listing rather than silent. The journal accounting (`drizzle_cloud.__drizzle_migrations`)
 * remains its record of application.
 *
 * `0021_setup_grants` and `0022_subscription_addons` are the easy case — new tables and new
 * columns — and take ordinary column markers above.
 *
 * `0019_storage_bytes_limit` is the easy case — one added column on an existing table,
 * `billing_subscriptions.storage_bytes_limit` — and its marker entry carries the argument worth
 * keeping: of its consumers, the one whose too-early failure is SILENT is the worker's cap read,
 * whose fail-open would quietly unmeter managed storage.
 *
 * `0024_auth_events_reuse_index` is one partial index and nothing else, so its INDEX marker in
 * {@link CLOUD_INDEX_MARKERS} is its whole probe — `0013_ledger_integrity`'s shape exactly,
 * argued at its entry.
 *
 * `0025_alert_renotify_signature` and `0026_alert_claim_lease` are the easy case — one added
 * nullable column on `alert_state` each — and take ordinary column markers above; their
 * entries carry the loudness argument (the alert pass's claim names both columns, so
 * too-early code is an `alert_pass_failed` loop — the pager breaking).
 *
 * The tag moves for its own reason: what this constant asserts is "the markers were reconciled
 * against the newest entry", and a stale tag beside an unchanged list is the state the assertion
 * exists to refuse — it cannot tell "nothing needed adding" from "nobody looked". */
export const CLOUD_SCHEMA_MARKER_JOURNAL_TAG = "0027_oauth_device_ceremonies";

/** The journal entries {@link SCHEMA_MARKERS} was last reconciled against (asserted by a test). */
export const SCHEMA_MARKER_JOURNAL_TAG =
  `mail ${MAIL_SCHEMA_MARKER_JOURNAL_TAG} + cloud ${CLOUD_SCHEMA_MARKER_JOURNAL_TAG}`;

/* LOADING THIS MODULE IS WHAT MAKES A HOST HOSTED. `routes/index.ts` imports it and
 * `routes/local.ts` does not, which is the whole mechanism: the Cloud table names never enter the
 * desktop engine's bundle, and no caller has to remember to pass them. See `health-census.ts`. */
registerSchemaCensus({
  markers: SCHEMA_MARKERS,
  checkDefinitions: CLOUD_CHECK_DEFINITION_MARKERS,
  indexMarkers: CLOUD_INDEX_MARKERS,
  functionDefinitions: CLOUD_FUNCTION_MARKERS,
  expected: EXPECTED_MARKERS,
  through: SCHEMA_MARKER_JOURNAL_TAG,
});
