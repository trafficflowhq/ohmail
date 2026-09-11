import {
  MAIL_SCHEMA_MARKERS, SCHEMA_INDEX_MARKERS, SCHEMA_CHECK_MARKERS,
  MAIL_CHECK_DEFINITION_MARKERS,
  MAIL_SCHEMA_MARKER_JOURNAL_TAG, type SchemaMarker, type CheckDefinitionMarker,
  type FunctionDefinitionMarker,
} from "./health.js";
import { registerSchemaCensus } from "./health-census.js";

/**
 * The hosted half of the schema-marker census — separated from `health.ts` because of what it is,
 * not what it weighs. The entries are Cloud table and column names, and `health.ts` is mounted by
 * the local route table bundled into the shipped desktop engine, so while these lived there the
 * artifact a stranger downloads carried `staff_users.password_hash` as live data — the same
 * disclosure the `@trafficflow/db` barrel split closed on the import side. Nothing local imports
 * this file: the hosted composition passes {@link CLOUD_TIER_MARKERS} and {@link
 * EXPECTED_MARKERS} through `HealthConfig`, and a host that declares the full tier without them
 * is a configuration fault, never a quieter probe.
 */
/**
 * The cloud half — every marker whose column is created by `packages/db/drizzle-cloud`.
 *
 * This is the list that reports the mail-committed / cloud-failed state: every one of these is
 * absent while a cloud pass is incomplete, so the deployment answers `503 schema_incomplete`
 * instead of serving requests that would 500 on a missing table.
 */
export const CLOUD_SCHEMA_MARKERS: ReadonlyArray<SchemaMarker> = [
  ["worker_heartbeats", "beat_at"], // cloud 0003_observability (legacy 0019)
  // cloud 0004_waitlist_invites (legacy 0020) — TWO markers, not one, because the migration
  // created two independent tables and the funnel breaks differently depending on which is
  // missing: without `waitlist` the landing's signup 500s, without `invites` nobody can register
  // at all. `invites.code_hash` is the column the single-use consumption keys on
  // (`UPDATE … WHERE code_hash = $1 AND consumed_at IS NULL`), so it is the one a query actually
  // reads, which is the rule this whole list follows.
  ["waitlist", "email"],
  ["invites", "code_hash"],
  // cloud 0005_invite_revocation (legacy 0021) — `revoked_at` is the column, not the index,
  // because this probe reads `information_schema.columns`. It is enough: that is one migration,
  // so a database with this column has also taken `users_email_unique_idx`, and a database that
  // has not taken it at all fails here rather than at the first invite an operator revokes.
  ["invites", "revoked_at"],
  // cloud 0007_staff_users — two markers: the migration created two independent tables that fail
  // differently. Without `staff_users` there is nobody to sign in as; without `staff_sessions`
  // the sign-in succeeds and every later request is anonymous again — a console that will not
  // stay signed in rather than a missing migration. The columns are the ones a query reads
  // (`password_hash` by every sign-in, `token_hash` by `resolveStaffSession`), never `id`: a
  // primary key exists the moment the table does.
  ["staff_users", "password_hash"],
  ["staff_sessions", "token_hash"],
  // cloud 0009_mailbox_oauth — two markers, two independent tables that fail differently: without
  // `mailbox_oauth_ceremonies` the start route 42P01s on the insert; without
  // `oauth_provider_config` the resolver's first read 42P01s and the flow reports "not
  // configured" on a deployment whose environment carries a good registration — the more
  // dangerous one, since it presents as a configuration mistake. The columns are the ones a query
  // touches: `consumed_at` is what the single-use consume predicates on, `client_secret_enc` is
  // what the resolver decrypts.
  ["mailbox_oauth_ceremonies", "consumed_at"],
  ["oauth_provider_config", "client_secret_enc"],
  // cloud 0027_oauth_device_ceremonies — one marker for the device-code door's table. Without it
  // the start route 42P01s on the insert after it has already asked Microsoft for a grant, so the
  // person is never shown the code for a ceremony that now exists at Microsoft's end.
  // `poll_interval_ms` and not the PK: `state` exists the moment the table does; the interval is
  // what the poll lease's predicate reads — pick the column a query touches.
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
  // cloud 0017_oauth_code_twofa_provenance — the authorizing session's real `last_twofa_at`,
  // carried across the native PKCE hop; the migration IS this column. The absence is silent: the
  // failure is INSERT-shaped on a route the shipped clients do not call, so `GET
  // /oauth/authorize` would 500 unseen while the property the column holds was simply absent. A
  // 503 at the deploy gate is how that becomes visible before deployment rather than never.
  ["oauth_auth_codes", "twofa_at"],
  // cloud 0018_invites_confers_verified — does redeeming this invite prove address control?
  // One added column, `NOT NULL DEFAULT true`, and the default is what makes the marker
  // load-bearing rather than decorative: on a database missing this migration the register
  // path's SELECT-through-drizzle 42703s loudly, but the PAIRING redeem's insert — the one
  // writer that must set FALSE — would also 42703, and the tempting "fix" on such a host is to
  // stop writing the column, which resurrects the exact verification forgery the column exists
  // to close. A 503 at the deploy gate forecloses the whole path.
  ["invites", "confers_verified"],
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
  // cloud 0030_heartbeat_signals_alert_runs — five markers for six independent changes.
  // `alert_state.cls` is the loud one: every observation the alert pass records inserts it, so an
  // API ahead of the migration 42703s inside `runAlertPass` — the one pass whose failure is
  // structurally silent, because noticing is its job. `alert_pass_runs` is quiet the mirror-image
  // way: the bookkeeping write is best-effort by contract, so a missing table costs nothing
  // visible until the other driver reports this one dark. `platform_signals` is quiet the third
  // way: no row ever written reads exactly like an unconfigured token — "not measured", true for
  // a reason nobody would look for.
  ["alert_state", "cls"],
  ["alert_pass_runs", "ran_at"],
  ["platform_signals", "errors_5xx"],
  // `worker_heartbeats.degraded_since` — the fourth marker. It was the migration's last statement
  // when added; 0030 has since grown twice, so the "implies everything above it" property belongs
  // to the last entry in this list. Kept because it still covers the two heartbeat columns with
  // no marker of their own (`ai_circuit_open_since` is the other). Its own rule is the ordinary
  // one: `worker_degraded` reads this column on every pass, so an API ahead of the migration
  // 42703s inside `runAlertPass`; with the marker, the deploy answers `503 schema_incomplete` and
  // names the reason.
  ["worker_heartbeats", "degraded_since"],
  // `platform_signals.sample_cause` — the migration's last statement, which is the point: the
  // last column of the last statement is the only one whose presence implies every object above
  // it. It moved here when 0030 grew two more statements; `alerts.ts`'s SCHEMA_BEHIND_MARKER
  // moved with it, in the same commit — a marker naming anything earlier reports ready for a
  // migration that stopped halfway. This list has to move whenever 0030 grows; the two are kept
  // in step deliberately rather than one deriving from the other, because the alert preflight
  // must not import an API route.
  ["platform_signals", "sample_cause"],
  // cloud 0033_api_faults — `arm` is the table's LAST column, on the rule the `sample_cause`
  // entry above states: only the last column's presence implies every object above it. A
  // statement appended after it means moving this AND `alerts.ts`'s SCHEMA_BEHIND_MARKER, which
  // names the same pair for the alert pass's own preflight.
  //
  // The loudness is the SWALLOWED kind again, and from both sides. The recorder's write is
  // best-effort by contract — a request that failed must still be answered — so an API deployed
  // ahead of the migration 42P01s into a swallowed catch on every 5xx, and the symptom is a
  // reliability board that stays empty while the deployment reports healthy. Meanwhile the alert
  // pass READS the table, so a worker ahead of it dies inside the evaluation rather than
  // delivering the finding that would explain why.
  ["api_faults", "arm"],
] as const;

/**
 * The CLOUD constraints probed by DEFINITION — see {@link CheckDefinitionMarker} for the shape
 * and for why a name-only probe cannot see them.
 *
 * EMPTY today, and kept rather than deleted: every entry it held probed a constraint on a
 * metering table, and those tables are not this server's. The CLASS is what is worth keeping —
 * a migration that REPLACES a CHECK under its existing name is invisible to every name-only
 * probe, so the next one that does needs this list rather than a new mechanism.
 */
export const CLOUD_CHECK_DEFINITION_MARKERS: ReadonlyArray<CheckDefinitionMarker> = [

] as const;

/**
 * The CLOUD indexes probed by name through `pg_indexes` — the fourth marker class, and the
 * reason it is a HOST-SUPPLIED list rather than three more lines in `SCHEMA_INDEX_MARKERS`:
 * that list lives in `health.ts`, which ships in the desktop engine, and every entry here names
 * a table only a hosted deployment has.
 *
 * An index's absence is SILENT in the way this class exists for: no query is wrong, every suite
 * is green, and the only symptom is a scan where there should be a seek — or a uniqueness
 * nothing enforces.
 */
export const CLOUD_INDEX_MARKERS: ReadonlyArray<string> = [
  "auth_events_reuse_account_at_idx",

] as const;

/**
 * The CLOUD trigger functions probed by BODY — the fifth marker class.
 *
 * See {@link FunctionDefinitionMarker} for why `pg_proc.prosrc` and why a substring. EMPTY
 * today, and kept for {@link CLOUD_CHECK_DEFINITION_MARKERS}' reason: every function it named
 * belonged to a metering table, and `CREATE OR REPLACE FUNCTION` is exactly the statement a
 * hand-repair or a restored dump can leave at an older definition with every name probe still
 * reporting healthy — so the class is what the next replaced trigger needs.
 */
export const CLOUD_FUNCTION_MARKERS: ReadonlyArray<FunctionDefinitionMarker> = [

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

/* Both tiers' definition probes, in one list, because `probeDatabase`'s parameter REPLACES its
 * default: a hosted caller passing the cloud list alone would silently stop probing the mail
 * definitions — 0101's away-pile CHECK and 0102's `sync_blocked_reason` one. */
export const CHECK_DEFINITION_MARKERS: ReadonlyArray<CheckDefinitionMarker> = [
  ...MAIL_CHECK_DEFINITION_MARKERS,
  ...CLOUD_CHECK_DEFINITION_MARKERS,
];

/**
 * Columns + indexes (both halves) + checks + check DEFINITIONS (both halves) + function BODIES.
 * What a hosted `/health` measures against.
 *
 * The check-DEFINITION term is BOTH halves since mail 0100 — a hosted database ran the mail
 * journal too, so a hosted probe that measured only the Cloud definitions would certify it
 * through a mail tag whose one distinguishing object it never looked at.
 */
export const EXPECTED_MARKERS =
  SCHEMA_MARKERS.length + SCHEMA_INDEX_MARKERS.length + CLOUD_INDEX_MARKERS.length +
  SCHEMA_CHECK_MARKERS.length + CHECK_DEFINITION_MARKERS.length +
  CLOUD_FUNCTION_MARKERS.length;

/** Alias that names the role rather than the shape, for the composition root. */
export const CLOUD_TIER_MARKERS = SCHEMA_MARKERS;

/**
 * The newest entry of the CLOUD journal, which {@link CLOUD_SCHEMA_MARKERS} is reconciled to.
 * Asserted by `health.test.ts` against the journal itself, so a cloud migration that adds a
 * probeable column and no marker fails there rather than in production.
 */
/**
 * What each cloud migration is probed by, and the ones no class can see. Ordinary migrations take
 * a column marker. 0017 and 0018 are one added column each, their failures write-shaped. 0020 is
 * the first data-only cloud migration — no DDL, nothing to probe; the journal accounting is its
 * record. 0024 is one partial index, probed by its INDEX marker alone. 0030 takes three column
 * markers, no CHECK-definition marker (all three CHECKs are new constraints on new objects) and
 * no index marker. 0032 drops tables and takes no marker of any class: no name's presence means
 * "sixteen tables are gone", and an untaken drop costs disk only. The tag asserts reconciliation
 * against the newest entry.
 */
export const CLOUD_SCHEMA_MARKER_JOURNAL_TAG = "0033_api_faults";

/** The journal entries {@link SCHEMA_MARKERS} was last reconciled against (asserted by a test). */
export const SCHEMA_MARKER_JOURNAL_TAG =
  `mail ${MAIL_SCHEMA_MARKER_JOURNAL_TAG} + cloud ${CLOUD_SCHEMA_MARKER_JOURNAL_TAG}`;

/* LOADING THIS MODULE IS WHAT MAKES A HOST HOSTED. `routes/index.ts` imports it and
 * `routes/local.ts` does not, which is the whole mechanism: the Cloud table names never enter the
 * desktop engine's bundle, and no caller has to remember to pass them. See `health-census.ts`. */
registerSchemaCensus({
  markers: SCHEMA_MARKERS,
  checkDefinitions: CHECK_DEFINITION_MARKERS,
  indexMarkers: CLOUD_INDEX_MARKERS,
  functionDefinitions: CLOUD_FUNCTION_MARKERS,
  expected: EXPECTED_MARKERS,
  through: SCHEMA_MARKER_JOURNAL_TAG,
});
