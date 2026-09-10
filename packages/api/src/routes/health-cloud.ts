import {
  MAIL_SCHEMA_MARKERS, SCHEMA_INDEX_MARKERS, SCHEMA_CHECK_MARKERS,
  MAIL_CHECK_DEFINITION_MARKERS,
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
 * artifact a stranger downloads carried `staff_users.password_hash` and
 * `staff_sessions.token_hash` as live data. That is the same
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
  // cloud 0007_staff_users — TWO markers, because the migration created two independent
  // tables and a database missing either one fails differently. Without `staff_users` there is
  // nobody to sign in as; without `staff_sessions` the sign-in succeeds and then every
  // subsequent request is anonymous again, which presents as a console that will not stay
  // signed in rather than as a missing migration.
  //
  // The columns are the ones a QUERY actually reads, which is the rule `invites.code_hash`
  // established. `password_hash` is read by every sign-in;
  // `token_hash` is the column `resolveStaffSession` looks a presented cookie up by. Neither
  // is `id`, for the reason the mail markers give: a primary key exists the moment the table
  // does, so it cannot distinguish a fully-migrated table from a half-applied one.
  ["staff_users", "password_hash"],
  ["staff_sessions", "token_hash"],
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
  // cloud 0030_heartbeat_signals_alert_runs — FIVE markers, on 0028's rule again: the migration
  // makes six independent changes and a database can hold some without the others, so each
  // marker below names one of them. `worker_heartbeats.ai_circuit_open_since` needs none of its
  // own: it is a heartbeat column added BEFORE one that IS marked, and statements inside a
  // migration apply in order.
  //
  // `alert_state.cls` is the loud one, and its loudness is a particular kind. Every observation
  // the alert pass records INSERTS this column, so an API deployed ahead of the migration 42703s
  // inside `runAlertPass` — and that is the one pass whose failure is structurally silent,
  // because being the thing that notices is its entire job. Without this marker the deploy that
  // breaks the pager is also the deploy the pager cannot report.
  //
  // `alert_pass_runs` is quiet in the mirror-image way: the pass's own bookkeeping write is
  // best-effort and swallows its errors by contract (a pass must outlive its bookkeeping), so a
  // missing table costs nothing visible until the OTHER driver reports this one dark — a false
  // page, hours later, naming the wrong fault.
  //
  // `platform_signals` is quiet in the third way, and it is the one the ruling names as a risk:
  // without the table the 5xx poller's write 42P01s, no row is ever written, and an empty
  // population is exactly what an UNCONFIGURED token also produces. The board would read "not
  // measured" — which is true, and true for a reason nobody would look for.
  ["alert_state", "cls"],
  ["alert_pass_runs", "ran_at"],
  ["platform_signals", "errors_5xx"],
  // `worker_heartbeats.degraded_since` — the FOURTH. It WAS the last statement of the migration
  // when it was added, and that is no longer true: 0030 has grown twice since, so this entry now
  // carries only its own rule and the "implies everything above it" property belongs to the last
  // entry in this list. The sentence claiming otherwise stood here while two statements sat
  // below it — a comment that had quietly become the opposite of the code, in the one file whose
  // whole job is to notice that kind of drift.
  //
  // It is kept because it still covers the two heartbeat columns that carry no marker of their
  // own (`ai_circuit_open_since` is the other).
  //
  // Its own rule is the ordinary one: `worker_degraded` READS this column on every pass, and the
  // API arm runs that pass. Without the marker an API deployed ahead of the migration 42703s
  // inside `runAlertPass` — silently, because that pass swallows nothing and reports nowhere,
  // and its whole job is to be the thing that notices. With it, the deploy answers
  // `503 schema_incomplete` and names the reason.
  ["worker_heartbeats", "degraded_since"],
  // `platform_signals.sample_cause` — the migration's LAST statement, which is the whole point:
  // the last column of the last statement is the only one whose presence implies every object
  // above it. It moved here from `alert_pass_runs.sinks_configured` when 0030 grew two more
  // statements; `alerts.ts`'s SCHEMA_BEHIND_MARKER moved with it, in the same commit, because a
  // marker naming anything earlier reports ready for a migration that stopped halfway.
  //
  // The fourth marker above was chosen because it was last, and then a statement was APPENDED
  // after it. That quietly voided the only property the choice rested on, so this list has to
  // move whenever 0030 grows — the same obligation `SCHEMA_BEHIND_MARKER` in `alerts.ts` carries,
  // and for the same reason. Both are kept in step deliberately rather than one deriving from
  // the other, because the alert preflight must not import an API route to answer a question
  // about the database.
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
/* WHAT EACH CLOUD MIGRATION IS PROBED BY, and the ones no class can see.
 *
 * `0015_attachment_staging` and every ordinary migration after it are the easy case: a real
 * table with real columns, so a column marker above is the whole probe.
 *
 * `0017_oauth_code_twofa_provenance` is the easy case too — one added column on an existing
 * table, `oauth_auth_codes.twofa_at`. Its own sentence is about how it FAILS: unlike the entries
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
 * none of the five marker classes can see it. That is accepted rather than worked around, and
 * the journal accounting (`drizzle_cloud.__drizzle_migrations`) remains its record of
 * application.
 *
 * `0024_auth_events_reuse_index` is one partial index and nothing else, so its INDEX marker in
 * {@link CLOUD_INDEX_MARKERS} is its whole probe — a shape worth naming, because an index's
 * absence is the silent kind.
 *
 * `0025_alert_renotify_signature` and `0026_alert_claim_lease` are the easy case — one added
 * nullable column on `alert_state` each — and take ordinary column markers above; their
 * entries carry the loudness argument (the alert pass's claim names both columns, so
 * too-early code is an `alert_pass_failed` loop — the pager breaking).
 *
 * `0030_heartbeat_signals_alert_runs` takes THREE column markers and nothing else, which is the
 * ordinary case, and the entry is worth a sentence for what it is NOT. It adds three CHECKs, and
 * none of them is a REPLACEMENT under an existing name — all three are new constraints on new
 * columns or new tables — so no CHECK-DEFINITION marker is owed. It adds one index, and that
 * index is not silent when absent: `platform_signals_window_idx` serves a read over a table the
 * same migration creates, so the table's own column marker already catches every database that
 * lacks it.
 *
 * `0032_retire_billing_tables` DROPS tables and takes NO marker of any class, which is the one
 * entry in this list whose absence of a probe is a positive statement rather than a gap: a
 * marker asserts a database HAS something, and there is no name whose presence means "sixteen
 * tables are gone". A database that has not taken it carries tables nothing reads, which costs
 * disk and nothing else — so the deploy gate has nothing to refuse, deliberately.
 *
 * `0033_api_faults` creates a table with real columns, so it is the easy case and takes one
 * ordinary column marker on `arm`, its last. It adds two indexes and three CHECKs and none of
 * them is owed a marker: the CHECKs are all new constraints on a new table, so the `0011`/`0029`
 * replacement problem cannot arise, and both indexes serve reads over the table the same
 * migration creates — the column marker already catches every database that lacks either.
 *
 * The tag moves for its own reason: what this constant asserts is "the markers were reconciled
 * against the newest entry", and a stale tag beside an unchanged list is the state the assertion
 * exists to refuse — it cannot tell "nothing needed adding" from "nobody looked". */
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
