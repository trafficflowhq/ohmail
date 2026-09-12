import { sql } from "drizzle-orm";
/* THE SEAM THAT DECIDES WHETHER THE SCHEMA CENSUS BELOW CAN BE ASKED AT ALL. Branched on the
   handle's own brand rather than on a `typeof` probe or an environment variable — the same rule
   every other reader of the two stores follows, and the only one a caller cannot get wrong by
   forgetting to set something. */
import { dialect, dialectOf, pgOnly } from "@trafficflow/db/dialect";
import { kekEnvIdentity } from "@trafficflow/core/mail";
import { fullSchemaCensus } from "./health-census.js";
import { API_VERSION } from "../version.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";

/**
 * `GET /health` — liveness + identity. `public` (a probe has no credential), `anonymous` (an
 * ambient cookie once cost a query outside this try/catch, turning a database outage into a
 * generic 500), `raw` (no envelope above — this handler never throws). It must not lie in either
 * direction: database unreachable ⇒ 503 `database_unreachable`; schema incomplete ⇒ 503
 * `schema_incomplete`; missing `pg_trgm` ⇒ 200 with `pgTrgm: false`; a KEK fault or no build
 * identity in production ⇒ 503 with the reason. One round trip: the probes are one statement.
 * `cookieAuth` reports this request's cookie/bearer split; `alertSinks`/`alertPasses` mirror the
 * worker's keys. A database error forwards the code, never the driver's message.
 */

/**
 * The columns whose presence means "this database carries this application's schema". `(table,
 * column)` pairs, not table names: a column is what a query reads, and an ALTER-only migration is
 * invisible to a table probe. The set covers the tables every request path touches plus the
 * newest migration's marker, so a virgin database, a half-applied run, and a pre-release database
 * all fail. The journal tags pin which migration each half's list was last reconciled against,
 * asserted by a test to be the newest entry in its own journal. Deployment order follows: a build
 * carrying a new marker answers 503 until the migration runner has reached the database.
 */
export type SchemaMarker = readonly [table: string, column: string];

/**
 * Split by journal, because the two halves fail independently: the mail-domain journal and the
 * hosted-service journal (which a local install never runs) are two transactions, so
 * mail-committed / cloud-failed is a reachable state this probe must report honestly. A single
 * flat list would still catch it; what it could not do is stay anchored — "the newest migration"
 * is now two facts, and one list pinned to one tag ages silently against the other half. So two
 * lists, each pinned to the newest entry of its own journal, each asserted by a test. {@link
 * SCHEMA_MARKERS} is their concatenation, so the split changed bookkeeping and nothing a caller
 * sees. No count in prose: {@link EXPECTED_MARKERS} derives it.
 */

/**
 * The mail half — every marker whose column is created by the mail-domain migration journal.
 *
 * These are also the markers a LOCAL desktop engine's PGlite database must satisfy, since the
 * mail journal is the whole of its schema. A cloud marker in this list would make a local
 * install permanently `schema_incomplete`.
 */
export const MAIL_SCHEMA_MARKERS: ReadonlyArray<SchemaMarker> = [
  ["accounts", "id"],
  ["users", "id"],
  ["sessions", "scope"],          // mail 0017_enrollment
  ["mailboxes", "id"],
  ["mailbox_credentials", "secret_enc"],
  ["messages", "id"],
  ["change_log", "seq"],
  ["account_sync_state", "next_seq"],
  ["idempotency_keys", "request_hash"],
  ["folder_state", "desired_folder"],
  // mail 0019_ai_switch (legacy 0022) — the AI off switch. It is one column on `accounts`, and
  // it is worth a marker for the same reason the billing ledger's dedup column was: it is what
  // the SPEND GATE reads on every AI decision. A database without it makes `spendState` throw,
  // which the gate (correctly) degrades to "no AI" — so managed AI would be silently off across
  // the whole deployment with nothing in the ledger and nothing in the health probe to say why.
  // This marker turns that into a 503 naming the missing migration.
  ["accounts", "ai_enabled"],
  // mail 0020_email_verified_column (legacy 0023) — email verification. It earns a marker for
  // the strongest reason on this list: the column is what `withVerifiedEmail` reads to refuse an
  // unverified account at Checkout and at `POST /mailboxes`, and a database missing it makes
  // `resolveSession`'s JOIN fail. Without the marker the failure mode of deploying this build
  // against an un-migrated database would be every authenticated request 500-ing on a missing
  // column; with it, the deployment says `503 schema_incomplete` and names the migration to run.
  // A missing column must be a LOUD 503, never a gate that silently reads "verified" for
  // everyone.
  ["users", "email_verified_at"],
  // mail 0023_mailbox_failure_reason — why a mailbox failed. One marker for four columns;
  // `error_code` is the one both `MailboxService.toDTO` and the console project. It earns a
  // marker because `MailboxService.list` selects whole rows, so an API ahead of this migration
  // answers 42703 on the mailbox panel and the connect flow — the marker makes the deployment
  // name the missing migration instead of a 500 nobody can attribute.
  ["mailboxes", "error_code"],
  // mail 0024_flag_state — the read-state desired-state table. One marker for the
  // whole table, and `desired_seen` is the column a QUERY reads: it is what `PATCH /messages`
  // upserts and what `reconcileMailbox` selects on to decide whether to push `\Seen` to IMAP.
  //
  // It earns a marker for the reason `folder_state.desired_folder` has one. Without the table
  // the batch read-state route 42703s inside its transaction, so marking mail read fails for
  // the whole account — and, worse, `reconcileMailbox` throws on every cycle, which takes the
  // FOLDER reconciler down with it and stops organization reaching the mailbox at all. That is
  // a deployment that must name the missing migration rather than degrade quietly. It is the
  // NEWEST entry in the mail journal.
  ["flag_state", "desired_seen"],
  // mail 0025_mailbox_kickstart — the once-per-mailbox HEY-shaping marker. One
  // nullable column on `mailboxes`, and it earns a marker for exactly the reason
  // `mailboxes.error_code` does rather than for a reason of its own: nothing READS it to make a
  // product decision (the worker reads it only to decide skip-or-run), but `MailboxService.list`
  // selects WHOLE ROWS through the drizzle schema, so an API deployed ahead of this migration
  // answers Postgres 42703 on the mailbox panel and on the connect flow. The marker does not
  // gate that traffic; it makes the deployment name the missing migration instead of leaving a
  // 500 nobody can attribute. It is the NEWEST entry in the mail journal.
  ["mailboxes", "kickstart_at"],
  // mail 0026_thread_resolution — the conversation's root Message-ID, the threading conflict
  // anchor. One nullable column on `threads`; `materializeThread` reads `select().from(threads)`,
  // so an API ahead of the migration 42703s `GET /threads/:id` and every `/sync` page that
  // materializes a thread. Its unique index `threads_account_root_header_uq` is deliberately not
  // in `SCHEMA_INDEX_MARKERS`: its absence makes `ON CONFLICT` raise 42P10 on the first ingested
  // message — loud, so there is no false positive for a marker to catch.
  ["threads", "root_message_id_header"],
  // mail 0027_organizer_lease — the two columns the organizer lease needs (one organizer per
  // mailbox). One marker on `disabled_reason`. Generic half: `MailboxService.list` selects whole
  // rows, so a too-early API 42703s the mailbox panel. Sharper half: the worker writes this
  // column at every stand-down, and a worker ahead of the migration cannot record why it stopped
  // organizing — the opaque state 0023 exists to end. Deploy order: migration → API → worker, and
  // this marker is what makes getting it wrong say so.
  ["mailboxes", "disabled_reason"],
  // mail 0028_message_instances — physical identity: the IMAP locators one logical message
  // occupies. One marker on `is_primary`, the column every query filters on (the primary lookup,
  // the vanished-primary probe, the `listKnownLocators` join). Both reasons apply:
  // `MessageService` selects whole rows (42703 wherever the schema expands), and without the
  // table `listKnownLocators` 42P01s on every sync cycle — stopping ingest for every mailbox, and
  // leaving the consent boundary unevaluable. That is a loud 503 naming the migration, never a
  // cycle that quietly decides it has no evidence.
  ["message_instances", "is_primary"],
  // mail 0029_mailbox_sync_block — why a `connected` mailbox is not being synced. One marker for
  // both columns, on `sync_blocked_reason`. Generic half: whole-row selects 42703 the mailbox
  // panel. Sharp half: the worker is the only writer, and its writes are best-effort by design —
  // a worker ahead of the migration logs and keeps syncing, so a mailbox nothing serves reads as
  // healthy `connected`: the exact defect the migration removes, reintroduced by deploy order and
  // invisible in the product. Order: migration → API → worker; the marker makes getting it wrong
  // say `503 schema_incomplete`.
  ["mailboxes", "sync_blocked_reason"],
  // mail 0030_sensitive_rescreen — the one-time re-evaluation of mail the sensitivity override
  // misrouted into the Ohbox. It earns a marker for the generic `mailboxes` whole-row reason and
  // only that one — worth saying because every entry above it since 0027 also carried a
  // worker-side argument: there is no worker half here. The pass lives in `packages/services`,
  // which the sync worker is forbidden by its own dependency test from importing, so no worker
  // binary touches this column. Deploy order: migration → API. It is the newest entry in the mail
  // journal.
  ["mailboxes", "sensitive_rescreen_at"],
  // mail 0031_tags — two markers, one per new table, deliberately. `tags.id` alone would not
  // catch the failure that matters: the tables are created by separate statements, and
  // `message_tags` is what the sync path reads on every page — `materializeMessages` queries it
  // to fill `MessageDTO.labels`, so a database holding only the parent would 42P01 every message
  // list and every `/sync` drain while a single `tags.id` marker reported healthy.
  // `message_tags.tag_id` is probed because it carries the FK to the sibling table: a catalog
  // where it exists ran both CREATEs. Deploy order: migration → API, no worker half — a tag is
  // ours, never an IMAP folder.
  ["tags", "id"],
  ["message_tags", "tag_id"],
  // mail 0033_workflow_run_claim — when the `running` claim was last asserted, which is what lets
  // a crashed run be reaped and resumed. The sharp reason is who swallows the failure: the
  // reaper's claim UPDATE names this column, and the cycle's per-account try/catch catches the
  // 42703, logs one line and carries on — workflow automation simply stops, silently, attributed
  // to nothing. The marker turns that into a deployment that refuses and names the file to run.
  // Deploy order: migration → API → worker (0027's reasoning).
  ["workflow_runs", "claimed_at"],
  // mail 0034_rule_retro — the columns that make a new rule reach mail already on disk. One
  // marker on `retro_requested_at`: written by `RulesService.create` on the default path
  // (retroactive apply is the default) and the whole of the worker pass's owed-work predicate.
  // `materializeRule` and `RulesService.list` select whole rows, so a too-early API 42703s every
  // rule creation and the whole rules surface. The retro pass reads and writes all four columns,
  // so the deploy order is migration → API → worker; a worker ahead of the migration fails its
  // owed probe, moves no mail and marks nothing.
  ["rules", "retro_requested_at"],
  // mail 0035_account_settings — per-account settings, the first durable home for a preference.
  // One marker on `seed_confirmed_at`, the column the onboarding surface asks about on every load
  // and the seed's confirm writes. A whole new table, so a too-early API answers 42P01 on the
  // consent surface, and the drizzle schema selects whole rows so reads fail too. No worker half;
  // deploy order migration → API. A marker on a nullable column is deliberate: the probe asks
  // whether the column exists, never whether anything has been written — every account starts
  // with no row, and that is the correct state.
  ["account_settings", "seed_confirmed_at"],
  // mail 0036_sensitive_fp_backfill — repairing bodies a classifier false positive stored
  // redacted. Generic half: whole-row `mailboxes` selects 42703 the mailbox panel and the connect
  // flow. Worker half — which 0030 explicitly did not have: repairing a body means re-reading the
  // message from the mail server, and only the worker holds that connection, so a worker ahead of
  // the migration 42703s the marker read, logs per mailbox and repairs nothing — no damage, no
  // repair, and nothing attributing the silence to deploy order. Order: migration → API → worker.
  ["mailboxes", "sensitive_fp_backfill_at"],
  // mail 0037_draft_html — the rich half of a draft. One nullable column on `drafts`, with a
  // second consumer that makes it sharper than the `mailboxes` entries: `materializeDraft`
  // selects the row (42703 on every draft read), and `SendService.reserve` reads the same row to
  // build the envelope — so compose and reply both stop being able to send at all, from a column
  // a plain-text send never looks at. No worker half: nothing in the sync worker reads `drafts`.
  // Order: migration → API.
  ["drafts", "html"],
  // mail 0045_draft_bcc — the Bcc recipients of a draft. One jsonb column on `drafts`, the twin of
  // `cc`, and it earns a marker for the same sharper reason `html` does. `materializeDraft` selects
  // the whole row through the drizzle schema (42703 on every draft read ahead of the migration),
  // and `SendService.reserve` reads the SAME row to build the envelope — so a stale database takes
  // out compose and reply both, from a column a bcc-less send never looks at. The order is
  // migration → API, no worker half.
  ["drafts", "bcc"],
  // mail 0038_initial_import_completed — when a mailbox's first import actually finished; the
  // client reads `IS NULL` as still importing. Generic half: whole-row `mailboxes` selects 42703
  // the panel and connect flow. Worker half: the worker stamps this column on the first
  // no-backlog cycle, best-effort inside the success path, so a worker ahead of the migration
  // loses only the stamp — the first no-backlog cycle after the migration does the whole job.
  // Order: migration → API → worker.
  ["mailboxes", "initial_import_completed_at"],
  // mail 0039_mailbox_retry_after — when the leader may next attach a quarantined mailbox,
  // durable so somebody other than the worker can change the answer. Generic half as usual
  // (whole-row selects). The worker half reverses the order — migration → WORKER → API: the
  // worker is the column's only writer and only decision reader, and the API deploy is what flips
  // `resync_mailbox` to `available: true` in the actions catalog — the console must not offer a
  // release the worker cannot honour. A worker ahead of the migration falls back to the in-memory
  // backoff (the pre-0039 behaviour; the runtime `persisted` flag reports it). No CHECK marker (a
  // timestamp closes no set), no INDEX marker.
  ["mailboxes", "retry_after"],
  // mail 0040_auto_suggest — the auto-suggest opt-in, one nullable column on `account_settings`.
  // It earns a marker for the whole-row-select reason alone: `consentSettings` does
  // `select().from(accountSettings)`, so a too-early API 42703s `GET /consent`, which the shell
  // fetches once per tab — the failure is the consent surface, not the feature. No worker half
  // (the flag's only consumer is a browser, which reads absent as OFF). No CHECK marker (a
  // timestamp closes no set), no INDEX marker (read off a row fetched by primary key).
  ["account_settings", "auto_suggest_at"],
  // mail 0041_message_failures — the durable per-message failure ledger; a whole new table, so
  // absence answers 42P01. `next_attempt_at` is probed: the retry probe's predicate reads it. The
  // worker half is sharp and unlike the entries above: the worker is the table's only reader and
  // writer, and its terminal-skip path treats a failed durable write as a refusal to skip — the
  // cursor is held and the mailbox quarantined loudly, a visible outage rather than lost mail.
  // The API half is deliberately weak: nothing in `packages/api` reads this table, and nothing
  // may — a staff read of these rows is a delivery oracle. No INDEX marker (the partial index is
  // a cost object: slow, not wrong) and no CHECK marker (`message_failures_code_closed` is
  // created inside the CREATE TABLE, so it can only fail with the column). Order: migration → API
  // → worker.
  ["message_failures", "next_attempt_at"],
  // mail 0042_screening_preference — the editable Ohbox preference, two nullable columns on
  // `account_settings`. `ohbox_policy` is probed (the column the worker resolves per account into
  // the routing engine); `consentSettings`/`getScreeningPreference` select whole rows, so the
  // consent surface is what fails on a too-early API. The worker's read degrades to the lenient
  // default on 42703 (absent-config-selects-safe), so a worker ahead of the migration organizes
  // under `people_and_replied` rather than crashing — the safe direction. Order: migration → API.
  // No CHECK marker, no INDEX marker (row fetched by primary key).
  ["account_settings", "ohbox_policy"],
  // mail 0043_ohbox_tidy — the resumable, re-armable marker for the Ohbox backlog re-route pass;
  // three nullable columns on `account_settings`. `ohbox_tidy_requested_at` is probed:
  // `requested_at IS NOT NULL` is half the owed predicate the worker evaluates every cycle, and
  // the whole-row `consentSettings` select means a too-early API 42703s the screening surface.
  // The worker half is the safe kind: a worker ahead of the migration fails its owed probe, so no
  // mail moves and nothing is marked — visible, not silent. The INDEX this migration also creates
  // is on `change_log` and joins `SCHEMA_INDEX_MARKERS` because its absence is silent.
  ["account_settings", "ohbox_tidy_requested_at"],
  // mail 0046_screener_auto_apply — the opt-in Screener auto-apply flag, one nullable column on
  // `account_settings`, on the whole-row-select reason: `consentSettings` and
  // `getScreeningPreference` reach this row, so a missing column 42703s the consent and screening
  // surfaces, not just the feature. The worker reads the column every cycle, but a read that
  // 42703s degrades to OFF (absent-config-selects-safe), so a worker ahead of the migration moves
  // nothing — the safe direction. Order: migration → API (and worker). No CHECK marker, no INDEX
  // marker.
  ["account_settings", "screener_auto_apply_at"],
  // mail 0047_read_order — when a message stopped being unread, the sort key of the client's
  // "Earlier" group. The strongest whole-row-select case on this list, which is why a column
  // whose only consumer is a client-side sort is here at all: `messages` is projected through
  // `select().from(messages)` on the message list, the single read, the delta feed and the
  // bootstrap snapshot — a too-early API 42703s the entire read surface, every view empty, from a
  // column no view reads. No worker half. No CHECK marker, and no INDEX marker deliberately:
  // nothing filters or pages on the column — the sort runs on the client, and a permanent index
  // serving no query is a write cost with no reader.
  ["messages", "last_read_at"],
  // mail 0048_remote_images_default — the remote-images opt-out, one nullable column on
  // `account_settings`, on the whole-row-select reason: `consentSettings` selects the row, so a
  // too-early API 42703s `GET /consent` and `PATCH /consent/settings` — the whole consent
  // surface, which onboarding runs through. No worker half; order migration → API. No CHECK
  // marker (a timestamp closes no set), no INDEX marker (read off a row fetched by primary key).
  ["account_settings", "block_remote_images_at"],
  // mail 0072_tracking_pixels_optout — the opt-out of pixel BLOCKING (NULL = blocked, the default).
  // One additive nullable column on `account_settings`, and it earns a marker for exactly the
  // whole-row-select reason its neighbour above does: `consentSettings` selects the whole row, so
  // an API deployed ahead of the migration 42703s the entire consent surface. No worker half, no
  // CHECK, no INDEX — read off a row fetched by primary key. Deploy order: migration → API.
  ["account_settings", "load_tracking_pixels_at"],
  // mail 0073_mailbox_folders_optout — per-mailbox "Use folders", stored as the exception
  // (NULL = this mailbox's folders show under the master flag, the default). One additive
  // nullable column on `mailboxes`, and it earns a marker for the whole-row-select reason
  // `mailboxes.error_code` established: `MailboxService.list` selects whole rows, so an API
  // deployed ahead of the migration 42703s the mailbox panel and the connect flow. No worker
  // half, no CHECK, no INDEX — read through the `listUserFolders` mailbox join. Deploy order:
  // migration → API.
  ["mailboxes", "folders_disabled_at"],
  // mail 0076_junk_sweep_request — the one-time Quarantine→\Junk sweep recorded as a command
  // (`junk_sweep_requested_at`: the API stamps it on the user's press, the worker consumes it
  // inside the mailbox's serial cycle; NULL = no sweep owed, the default). One additive nullable
  // column on `mailboxes`, and it earns a marker for the whole-row-select reason
  // `mailboxes.error_code` established: `MailboxService.list` selects whole rows, so an API
  // deployed ahead of the migration 42703s the mailbox panel and the connect flow. The worker
  // half is the safe kind — a worker ahead of the migration never reaches the column (its read
  // lives in the sweep-command pass this same change introduces). Deploy order: migration → API
  // → worker.
  ["mailboxes", "junk_sweep_requested_at"],
  // mail 0078_inbound_quiet — the forwarding-detection notice's two columns
  // (`inbound_quiet_since`: the worker's inbound-quiet pass stamps a quiet episode's evidence;
  // `inbound_quiet_dismissed_at`: the user's per-mailbox dismissal, stamped by
  // `POST /mailboxes/:id/inbound-quiet/dismiss`; NULL/NULL = no episode, no dismissal — every
  // existing row). Two additive nullable columns on `mailboxes`, and they earn markers for the
  // whole-row-select reason `mailboxes.error_code` established: `MailboxService.list` selects
  // whole rows, so an API deployed ahead of the migration 42703s the mailbox panel and the
  // connect flow. The worker half is the safe kind — a worker ahead of the migration fails its
  // pass loudly and syncs on. Deploy order: migration → API → worker.
  ["mailboxes", "inbound_quiet_since"],
  ["mailboxes", "inbound_quiet_dismissed_at"],
  // mail 0079_erasure_fence — the durable marker a late settings write is fenced on
  // (`accounts.erased_at`, NULL = never erased, every existing row). One additive nullable
  // column, and it earns a marker because EVERY settings writer now opens its transaction by
  // reading it FOR SHARE (`erasure-fence.ts`): an API deployed ahead of the migration answers
  // Postgres 42703 on `PATCH /consent/settings`, on the Screener decide, and on the screening
  // preference — the whole consent-write surface at once. The 503 in front of that names the
  // missing migration instead. No worker half: the worker writes no settings rows. Deploy
  // order: migration → API. No CHECK (a timestamp closes no set), no index (read by primary
  // key).
  ["accounts", "erased_at"],
  // mail 0081 — the re-screen's RESUME POINT (`mailboxes.sensitive_rescreen_cursor`, NULL =
  // start at the beginning, every existing row). `MailboxService.list` selects whole rows, so
  // an API ahead of this migration 42703s the mailbox list itself, not merely the operator
  // pass that writes the column.
  ["mailboxes", "sensitive_rescreen_cursor"],
  ["mailboxes", "sensitive_rescreen_started_at"],
  // mail 0077_send_later — the draft's appointment (`send_at` + `send_key` + `send_error`,
  // `status = 'scheduled'`; NULL = no appointment). Whole-row reason one table over:
  // `materializeDraft` selects whole `drafts` rows — the CRUD, the schedule verbs and every
  // `draft` sync change re-materialize through it — so a too-early API 42703s the entire drafts
  // surface. `send_at` is probed as the column the worker's due scan filters on; a worker ahead
  // of the migration never reaches the columns. No CHECK marker, no INDEX marker (a slow scan
  // over near-zero rows, not a wrong answer). Order: migration → API → worker.
  ["drafts", "send_at"],
  // mail 0074_folder_ops — the user-commanded folder verbs' command table (create / rename /
  // delete; FOLDERS-SPEC.md stage 2). A whole NEW table, probed by its primary key: the API's
  // /folders verbs INSERT into it and the /sync folder materializers LEFT JOIN it for the
  // pending-op marker, so an API deployed ahead of the migration 42704s the folder reads the
  // moment "Use folders" is on — the flag-off account never touches it. The worker half is the
  // safe kind: a worker ahead of the migration finds no table on its op scan and the verbs
  // simply queue nothing (the API refuses first anyway). Deploy order: migration → API → worker.
  // The op/status CHECKs are closed OURS-only sets inside the CREATE TABLE (0041's rule).
  ["folder_ops", "id"],
  // mail 0075_mailbox_signature — the per-mailbox signature text (NULL = none, the default).
  // One additive nullable column on `mailboxes`, and it earns a marker for exactly the
  // whole-row-select reason its two neighbours above do: `MailboxService.list` selects whole
  // rows, so an API deployed ahead of the migration 42703s the mailbox panel and the connect
  // flow — and `mailboxSignatures` (the `GET /consent` map) selects the column by name, so the
  // consent read 42703s too. No worker half, no CHECK, no INDEX — read through account-scoped
  // mailbox selects only. Deploy order: migration → API.
  ["mailboxes", "signature"],
  // mail 0049_mailbox_sync_requested_at — the enforced-sync doorbell, on the whole-row-select
  // rule its own migration states. It was added two migrations late — the marker list, the tag
  // and four censuses were stale at once, recorded in `journal-split.test.ts`'s 0049 entry rather
  // than quietly fixed. The failure a too-early API produces is not the stamp (that write is
  // best-effort and caught) but `select().from(mailboxes)` answering 42703, taking out the
  // mailbox list. The worker half is safe: a failed kick scan degrades to poll-only latency —
  // visible, not silent. Order: migration → API → worker. No CHECK, no INDEX marker.
  ["mailboxes", "sync_requested_at"],
  // mail 0050_rule_subject_contains — the second term on a sender rule; the second-strongest
  // whole-row case after `messages.last_read_at`: `rules` is enumerated by `materializeRule` (the
  // rules surface, the `/sync` delta, every created rule's 201) and by
  // `drizzle-repo.ts#listRules`, which the router consults on arrival — a too-early API 42703s
  // the surface and stops filing mail. The worker reads the column through the same `listRules`,
  // and there the failure is not the safe kind: a retro pass or ingest that 42703s stops
  // organizing rather than degrading. Order: migration → API → worker, the first arrow
  // load-bearing.
  ["rules", "subject_contains"],
  // mail 0052_away_responder — the responder's `audience` column, the sharpest kind of marker
  // here: its absence 42703s the surface that configures an outbound-mail feature.
  // `AwayResponderService` selects whole rows and `put` returns the inserted row, so both
  // `/away-responder` endpoints go dark — somebody already away could not turn their responder
  // off, the one urgent direction. `audience` is probed as the column that decides whether a
  // stranger gets answered. The worker half is safe: a 42703 inside the pass is caught and sends
  // nothing. No CHECK marker: the column arrives NOT NULL with a DEFAULT in the prior statement,
  // so a database that took the column without the CHECK still resolves every row to
  // `screened_in`, the narrow member, and the service's closed-set validator refuses the rest.
  ["away_responders", "audience"],
  // mail 0052_rule_body_contains — the third term on a sender rule. One additive nullable text
  // column on `rules`, and the whole-row case is 0050's verbatim, because it is the SAME
  // `select().from(rules)` in both halves: `materializeRule` (the rules surface, the `/sync`
  // delta, the 201) and `drizzle-repo.ts#listRules` (what the router consults on arrival) both
  // enumerate the table, so a too-early API 42703s the surface AND stops the organizing. The
  // worker half is likewise NOT the safe kind — a routing read that 42703s stops filing mail —
  // so the order stays migration → API → worker with the first arrow load-bearing.
  ["rules", "body_contains"],
  // mail 0053_account_locale — the interface language, on the `account_settings` whole-row-select
  // reason: a too-early API 42703s the whole consent surface, so the dormancy window, the
  // auto-suggest flag and the remote-images opt-out all stop arriving and the client falls back
  // to its resting values on every load. No worker half; order migration → API. A CHECK marker as
  // well, unlike the timestamps beside it — this column closes a set over free text: see
  // `account_settings_locale_supported` below.
  ["account_settings", "locale"],
  // mail 0082_theme_face — the account-wide appearance face. One additive nullable text column
  // on `account_settings`, and it earns a marker on 0053's whole-row-select argument verbatim:
  // `consentSettings` does `select().from(accountSettings)`, so an API deployed ahead of the
  // migration 42703s `GET /consent` AND `PATCH /consent/settings` — the whole consent surface,
  // not merely the face. No worker half: nothing in the sync worker reads or writes it.
  // Deploy order: migration → API. A CHECK marker as well, 0053's reason: the column closes a
  // set over free text. See `account_settings_theme_face_supported` below.
  ["account_settings", "theme_face"],
  // mail 0083_organizer_role — the organizing role split off the connection, plus onboarding
  // state and the first-pull denominator. Five markers for a nine-column migration (one migration
  // is one transaction, so five probes detect what nine would; the five name the five decisions):
  // `mailboxes.organizer_role` — read by the gate, the roster, every write door's refusal and
  // `MailboxDTO`; worst absence, since a worker ahead of it cannot tell an organizer from a
  // reader, the one state with two organizers in it. `mailboxes.organize_consented_at` — the
  // ceremony's own record, its own marker because the two answer different questions. Both
  // `account_settings` columns on 0053's whole-row argument. `mailbox_folders.server_exists` —
  // written by every cycle, read by the import strip; `buildCursor` selects whole rows. Order:
  // migration → API → worker. Four CHECK markers below.
  ["mailboxes", "organizer_role"],
  ["mailboxes", "organize_consented_at"],
  ["account_settings", "onboarding_completed_at"],
  ["account_settings", "screening_scope"],
  // mail 0084_ai_answered — "has anybody been asked about AI?", the question `accounts.ai_enabled`
  // cannot answer because its resting value is `true`. Probed for 0083's reason and 0027's before
  // it: `getAiAnswer` SELECTs the column, so an API deployed ahead of the migration answers
  // Postgres 42703 on `GET /account/ai` — which is on the first-run flow's own path, i.e. the
  // first five minutes of an account's life. One marker and no CHECK entry: the column is a
  // nullable instant closing no set, so there is no second catalog object to probe (0030's rule).
  ["accounts", "ai_answered_at"],
  ["mailbox_folders", "server_exists"],
  // mail 0054_auto_unsubscribe_optout — the auto-unsubscribe opt-out, fifth `account_settings`
  // marker on the whole-row argument (the whole consent surface fails, not this switch). Sharper
  // in one respect: `UnsubscribeService.onScreenOut` reads the column in the request that decides
  // whether to send a one-click unsubscribe, inside a path contracted never to throw at its
  // caller — so a too-early 42703 is swallowed as a skip and the feature silently turns itself
  // off. The 503 in front is what makes that loud. No worker half; no CHECK, no INDEX marker.
  ["account_settings", "block_auto_unsubscribe_at"],
  // mail 0055_mailbox_smtp_max_size — the sending server's RFC 1870 `SIZE`, recorded by the
  // connect-time SMTP probe. Two whole-row readers: `MailboxService.list` (the panel and every
  // mailbox resolution) and `SendService.reserve`, which enumerates the row inside the
  // reservation transaction — so the same missing column takes out sending, before the
  // reservation commits (nothing stranded out of `draft`, but a user who cannot send). No worker
  // half; order migration → API. No CHECK marker (a size closes no set), no INDEX marker.
  ["mailboxes", "smtp_max_size_bytes"],
  // mail 0056 — `account_settings.screening_baseline_at`, the instant the dormancy window is
  // measured back from, on the whole-row rule: a too-early API 42703s `GET /consent`, the boot
  // fetch the shell partitions its mirror from — a client drawing the Screener over the raw
  // mirror with no way to say why. The worker reads the same column and degrades safely:
  // `screeningFor` catches the read and returns the lenient value without caching it, the
  // pre-0056 routing. No CHECK marker (any instant is a legal baseline), no INDEX marker.
  ["account_settings", "screening_baseline_at"],
  // mail 0057_message_from_name — the From header's display name, the sender's half of the
  // recipients repair. The whole-row argument at its widest: `materializeMessages` and the single
  // read select whole `messages` rows, so a too-early API 42703s the entire mail surface. The
  // worker half fails loud, deliberately: `insertMessage` names the column unconditionally, so a
  // worker ahead of the migration fails ingest into the ordinary quarantine rather than silently
  // dropping names — the defect the column ends. Order: migration → API → worker. No CHECK, no
  // INDEX marker.
  ["messages", "from_name"],
  // mail 0058_reconcile_backoff — the reconciler's bounded retry. Four columns land (`attempts` +
  // `next_attempt_at` on `folder_state` and `flag_state`) in one transaction, one marker:
  // `folder_state.next_attempt_at`, the column the pending-move query filters on. Whole-row
  // argument: `materializeMessages` selects whole `folder_state` rows across the mail surface.
  // The worker half is loud too — the reconcile pass filters and writes the pair, 42703 into the
  // cycle's quarantine. Order: migration → API → worker. No CHECK marker (an instant closes no
  // set; `attempts` is a count), no INDEX marker (the migration adds none, by design).
  ["folder_state", "next_attempt_at"],
  // mail 0059_pairing_tokens — the pairing-token table; a whole new table, so absence is 42P01
  // (the `/pair*` surface, self-host composition only). `token_hash` is probed: the redeem's
  // single atomic UPDATE names it in its WHERE — the ceremony's single-use guarantee. No worker
  // half; order migration → API. No CHECK marker for the grant CHECK (every writer is a literal
  // behind a closed TS union, and the redeem names the grant in its own WHERE), no INDEX marker
  // (the UNIQUE on `token_hash` is the redeem's lookup; its absence is loud).
  ["pairing_tokens", "token_hash"],
  // mail 0060_refresh_tokens — the rotating-refresh store, moved to the shared half for the
  // desktop-host tier's paired devices. One marker on `family_id`: the family-revocation sweep
  // predicates on it — reuse detection's whole guarantee — and not `token_hash`, which duplicates
  // the name the `pairing_tokens` probe already reads. A subtlety this entry owns: on hosted
  // databases the table predates the migration (cloud 0000 created it), so the probe passes there
  // regardless — the honest answer, since a marker asks "does the schema this deployment queries
  // exist", not "which journal built it". The store that can lack it is a mail-only desktop
  // database, which migrates at boot. No CHECK, no INDEX marker.
  ["refresh_tokens", "family_id"],
  // mail 0062_storage_accounting, marker one of two — the per-account stored-body byte counter, a
  // whole new table (42P01 ahead of the migration). `bytes` is the column every statement names:
  // the ingest reserve's conditional UPDATE (the managed cap's decline decision), the repair
  // passes' clamped deltas, the billing status read. The worker half fails loud —
  // `insertMessageBody` reserves unconditionally, so ingest fails into quarantine rather than
  // storing uncounted bodies; the API half is the settings read, which would 42703 the billing
  // card. Order: migration → API → worker. No CHECK marker (the CHECK arrives in the same
  // statement block as the table; every app-side decrement is clamped besides), no INDEX marker
  // (one row per account, fetched by primary key).
  ["account_storage", "bytes"],
  // mail 0062, marker TWO — the withheld-body marker column. It earns its own probe on the
  // whole-row-select rule at its widest for this table: `getBody` does
  // `select().from(messageBodies)`, so an API ahead of the migration 42703s the BODY of every
  // message — the reading surface itself — and both batch modes name the column explicitly.
  // The worker half is the same loud INSERT as `bytes` above (one values-builder writes both
  // features). No CHECK marker for `message_bodies_withheld_reason` (0030's rule: a closed-set
  // CHECK the column marker already implies — same migration, same transaction).
  ["message_bodies", "withheld_reason"],
  // mail 0063_smtp_size_probe_stamp — when the SIZE back-fill last dialled a mailbox's submission
  // server. Two columns land in one transaction; the marker names the column the selection
  // filters on. The whole-row argument at its sharpest for this table (0055's, two entries up):
  // `MailboxService.list` and `SendService.reserve` both enumerate the row, so the missing column
  // takes out the panel and sending. No worker half: the sync host neither reads nor writes
  // either column (its own back-fill arm deliberately does not stamp — a host that cannot reach
  // submission ports must not suppress the one that can). Order: migration → API. The CHECK gets
  // its own entry in `SCHEMA_CHECK_MARKERS`: what it keeps out is a third party's SMTP response
  // line, and a missing constraint is silent.
  ["mailboxes", "smtp_size_probed_at"],
  // mail 0064_device_sync_stamp — WHEN a device's `/sync` read last reached the horizon. It
  // earns a marker on the whole-row-select rule: `SessionLifecycle.listDevices` does
  // `select().from(devices)`, so an API ahead of the migration 42703s the Settings device
  // list (and the revocation surface that hangs off it). The sync route's stamp itself is a
  // guarded UPDATE that would merely fail loudly, but the read path is the one a person hits.
  // No worker half: the sync host neither reads nor writes the column. Deploy order:
  // migration → API, no third step.
  ["devices", "last_synced_at"],
  // mail 0065_junk_trash_delete — the provider's own \Junk/\Trash paths, discovered at connect.
  // TWO columns land in one migration inside one transaction; the marker names `trash_folder`
  // because it is the one whose absence changes an API decision (`MessageService.delete` refuses
  // on NULL — reading it at all 42703s the delete), and the whole-row-select rule bites here the
  // same way 0063's does: `MailboxService.list` does `select().from(mailboxes)`, so a too-early
  // API takes out the mailbox panel. Worker half is loud on its own (the discovery UPDATE names
  // both columns). Deploy order: migration → worker → API.
  ["mailboxes", "trash_folder"],
  // mail 0065, marker TWO — when a message left the mirror's living views. The predicates that
  // read it are the snapshot bootstrap (`isNull(messages.deletedAt)`) and search's raw
  // `m.deleted_at is null`, so an API ahead of the migration 42703s the fresh-mirror bootstrap
  // and every search — and the delete route's own stamp UPDATE besides. No CHECK marker for the
  // widened `message_bodies_withheld_reason` (0030's rule: replaced in the same migration
  // transaction as these columns, so the column probe implies it).
  ["messages", "deleted_at"],
  // mail 0066_folders_enabled — "Use folders", the folders foundation's master toggle
  // (FOLDERS-SPEC.md §6). One nullable column on `account_settings`, and it earns a marker for
  // the whole-row-select reason: `consentSettings` does `select().from(accountSettings)`, so an
  // API deployed ahead of the migration answers Postgres 42703 on `GET /consent` AND on
  // `PATCH /consent/settings` — the entire consent surface, which onboarding runs through, not
  // just this knob (0054's entry records the same blast radius for its column) — and the /sync
  // snapshot's flag probe reads the same column. No worker half. Deploy order: migration → API.
  // (Journal note: 0069_folders_enabled_reissue re-runs this migration's one statement from
  // above the journal maximum — see REISSUED_ORIGINALS in db/src/baseline.ts; one marker,
  // both entries.)
  ["account_settings", "folders_enabled_at"],
  // mail 0070_session_sync_stamp — the per-SESSION sync-horizon twin of 0064, for the installs
  // that hold no device row (mail 0061's deliberate deviceless shape). It earns a marker on the
  // whole-row-select rule with a wider blast radius than 0064's: `rotateRefresh`, `listDevices`
  // and `requireStepUp` all `select().from(sessions)`, so an API ahead of the migration 42703s
  // token refresh — the whole signed-in surface, not one panel. The sync route's stamp itself is
  // a guarded UPDATE that would merely fail loudly. No worker half: the sync host neither reads
  // nor writes the column. Deploy order: migration → API, no third step.
  ["sessions", "last_synced_at"],
  // mail 0087_away_reply_throttle — the per-person throttle, the reply ledger and the enablement
  // instant. `away_responders.throttle` is the probe, the column rather than either new table
  // because the column is the half missable silently: a database without the tables 42P01s loudly
  // the first pass, but one that took the tables and not this column would read an absent
  // `throttle` and fall through to some member — which decides how often a stranger is answered.
  // `AwayResponderService` selects whole rows, so a too-early API 42703s both `/away-responder`
  // endpoints. Order: migration → API → worker. No CHECK marker: the column arrives NOT NULL with
  // a DEFAULT, so every row resolves to `per_day` and the service's closed-set validator refuses
  // the rest.
  ["away_responders", "throttle"],
  // mail 0088_symmetric_takeover — the notice's two instants, the release request and the
  // reader's request queue. Two markers for a four-object migration (one transaction, so two
  // probes detect what four would): `mailboxes.organizer_event_at` — whole-row selects 42703 the
  // mailbox panel, and on the worker side the failure is quiet: every writer of the (role, state,
  // holder) triple stamps it, so a worker ahead of the migration fails its stand-down write and
  // leaves the row saying `organizer` about a mailbox it stopped organizing
  // (`release_requested_at` rides this marker). `organizer_requests.state` — the queue's own
  // facet; the table's absence 42P01s loudly, and the took-the-table-not-the-CHECK case is the
  // CHECK marker's below. Order: migration → API → worker.
  ["mailboxes", "organizer_event_at"],
  ["organizer_requests", "state"],
  // mail 0089_organizer_capability — the fifth holder column, `organized_by_capabilities`: what
  // the holder offers a reader. `MailboxService` and every write site named in the column's own
  // comment select/write whole rows, so an API ahead of the migration 42703s the mailbox panel;
  // a worker ahead of it fails every reader-cycle holder refresh silently — the column simply is
  // not there to write, and every request offer answers `409 organized_elsewhere` with
  // `reason: "organizer_outdated"` regardless of the true holder, because a column that cannot
  // be read reads as "we have not looked". Deploy order: migration → API → worker, unchanged.
  ["mailboxes", "organized_by_capabilities"],
  // mail 0090_request_key — one column, because the migration adds one.
  // `organizer_requests.refused_reason` is what an organizer says when it declines a decision
  // made on another install; the reader's own cycle selects the row whole, so a worker ahead of
  // the migration 42703s every settle pass while `/health` would otherwise certify the schema
  // fine. The migration's name promises a key column that is not here and must not be probed for:
  // the signing key is derived from the mailbox password at use and never stored — probing for it
  // would fail on a correctly migrated database. The widened `state` CHECK gets no marker: the
  // column is already probed, and a CHECK that gained a member cannot be detected by reading a
  // column name.
  ["organizer_requests", "refused_reason"],
  // mail 0092_organizer_install_id — which install holds the claim, beside the columns that say
  // what sort of thing holds it. Probed because the row is selected whole by the mailbox panel
  // and the reader's cycle. The consequence is worse than a 42703: the release arm compares this
  // column against the install asking, and a NULL reads as "we cannot say it is ours", which
  // refuses the hand-back — a database certified healthy while missing it serves a mailbox whose
  // owner is told they cannot stop Cloud organizing it.
  ["mailboxes", "organized_by_install_id"],
  // mail 0093_outbound_send_fingerprints — the account's claim on the content of a send; probing
  // a column of a table proves the table. Its absence is the loud kind: the send path INSERTs
  // here inside the reserve transaction on every send, so a too-early API 42P01s the first press
  // and nobody can send — the point is that `/health` must not certify a database the send path
  // cannot use. The UNIQUE gets no marker (the INSERT names it in its `ON CONFLICT` target, so
  // absence fails loudly at the first duplicate-free mint); the CHECK does — see
  // `outbound_send_fingerprints_hex`.
  ["outbound_send_fingerprints", "fingerprint"],
  // mail 0094_request_kinds_moves_profile — one column, on the new table.
  // `mailbox_profile_mirror.doc` is the configuration document a read-only install caches from
  // `ohmail/_meta`; probing a column on a new table probes the table. Worth a marker even though
  // its absence degrades quietly: the reader's settings pane renders "no profile from <holder>
  // yet", a real state it must also render when nothing has been read — indistinguishable to a
  // person, so an operator would see a healthy schema and a permanently empty screen. The widened
  // `kind` CHECK gets no marker (`organizer_requests.kind` is already probed, and a CHECK that
  // gained a member cannot be detected by name; its absence surfaces as a refused INSERT, which
  // reports itself).
  ["mailbox_profile_mirror", "doc"],
  // mail 0095_outbound_send_resolution — the resolution columns on the send ledger. Two columns
  // land; `resolved_by` is the probe: `SendService`'s replay branch selects the reservation whole
  // under `FOR UPDATE` on every same-key retry, so a too-early API 42703s the replay gate that
  // stops a second copy being delivered, and `DraftsService.resolve` writes both columns in one
  // UPDATE. The FK change cannot get a marker: dropped and re-added under the same name,
  // `pg_constraint` reads identically — so this marker answers "this database is from before
  // 0095", which is the question `/health` is asked. Named rather than waved off, since the FK is
  // the half that turns a discard into a 23503.
  ["outbound_sends", "resolved_by"],
  // mail 0096_away_piles — two columns, both read by name. `away_responders.piles` is which piles
  // the responder answers: the pass's probe selects it per live responder (42703 on every away
  // cycle ahead of the migration), and the settings `PUT` writes it — the save that turns a
  // responder off fails too, the one save nobody may be prevented from making. Certifying a
  // database without it is worse than the 42703: the column IS the scope, and the branch a pass
  // falls through to when it cannot tell which piles were chosen is the branch that sends mail —
  // to exactly the correspondents this migration stops answering.
  ["away_responders", "piles"],
  // `away_sender_state.undeliverable_at` is the record that a bounce came back for an earlier
  // reply. Probed for the same reason: the candidate query reads it in a correlated EXISTS by
  // name, so a database without it 42703s the whole away pass rather than degrading — and if it
  // ever degraded instead, the degraded reading is "this address is fine", which resumes writing
  // to a dead address once per throttle interval, each attempt returning a bounce into this
  // account's own Ohbox. That is the state this migration was written to end.
  ["away_sender_state", "undeliverable_at"],
  // mail 0097_folder_state_last_error_class — one column: why the mail server refused a filing,
  // one of four words. Probed because the API reads it: the mailbox projection selects it in the
  // filtered aggregate reporting what a mailbox owes, so a too-early API 42703s `GET /mailboxes`
  // — polled every thirty seconds by the shell's status line on every open tab. The CHECK closing
  // the column to the four words gets no marker: a constraint that gained a set cannot be
  // detected by reading a column name.
  ["folder_state", "last_error_class"],
  // mail 0098_signature_html — one column: the markup half of a mailbox's signature. Probed for a
  // sharper reason than the holder columns: `mailboxSignatureHtmls` selects this column by name
  // on every `GET /consent` — the settings read every client makes at boot, not a panel somebody
  // may never open. A database certified healthy while missing it serves an account that cannot
  // load its own settings. The derived text half needs no marker: `mailboxes.signature` predates
  // the split.
  ["mailboxes", "signature_html"],
  // mail 0099_folder_state_trashed_from — one column: the folder a delete moved a message out of,
  // the only durable record of where it came from and the only thing a restore can aim at. Probed
  // because the API selects it by name on two doors: the Trash list resolves each row's
  // destination from it, the restore decides where the message goes. A too-early API 42703s both
  // — an account whose Trash screen cannot load and whose Restore cannot work. It was the newest
  // entry until 0102, which adds no column (it widens a CHECK, so its prober is
  // `MAIL_CHECK_DEFINITION_MARKERS` and the tag's "newest" sentence sits there — the tag is
  // single-valued, so the sentence moves with it).
  ["folder_state", "trashed_from"],
] as const;

/**
 * The cloud half of the marker census moved to `./health-cloud.js`. It is a list of Cloud table
 * and column names, and this module is mounted by the local route table bundled into the shipped
 * desktop engine — so the artifact carried the hosted half's schema vocabulary as live data; the
 * engine build's own leak count found it, the last real occurrence once the barrel split closed
 * the import edges. A local install declares `schemaTier: "mail"` and probes {@link
 * MAIL_SCHEMA_MARKERS}; the hosted set arrives through {@link HealthConfig}, and a host claiming
 * the full tier with no set gets a fault rather than a narrower probe (the
 * `schema_tier_unconfigured` branch below).
 */

/**
 * Index markers — migrations whose whole content is an index, which a column probe cannot see:
 * `information_schema.columns` is blind to indexes, so such a migration used to be invisible to
 * `/health` and the deployment certified `schemaOk: true` on a database the fix was missing from.
 * Not cosmetic: `mailboxes_active_address_uq` is the only thing between `POST /mailboxes` and two
 * rows for one address — `create` performs no pre-check, so its 409 is entirely contingent on the
 * index raising 23505; absent it, the worker rosters two IMAP runtimes for one physical mailbox.
 * Counted into the same `found`/`expected` totals as the column markers: the `/health` body may
 * not gain a key.
 */
export const SCHEMA_INDEX_MARKERS: ReadonlyArray<string> = [
  "mailboxes_active_address_uq",   // mail 0021_mailbox_address_unique
  // mail 0034_rule_retro. Listed for the same property as the one above and not for symmetry:
  // its absence is SILENT. Nothing raises, no query is wrong, and every test stays green — the
  // retro pass simply computes each page by a sequential scan of the account's messages, once
  // per page, once per worker cycle, per owed rule, until the cycle stops finishing. There was
  // no index on `messages.from_address` of any kind before this migration.
  "messages_account_from_addr_idx",
  // mail 0043_ohbox_tidy. Listed for the same property as the two above: its absence is SILENT. The
  // Ohbox backlog re-route pass excludes any message the user has dragged back into the Ohbox with a
  // `NOT EXISTS (move-to-INBOX change row)`, and `change_log`'s only index is its PK `(account_id,
  // seq)`. Without this partial index that `NOT EXISTS` is a full scan of the account's whole change
  // log per candidate, per page, per cycle — no query is wrong, every test stays green, and the only
  // symptom is a worker cycle that stops finishing, which is exactly what this list exists for.
  "change_log_move_to_inbox_idx",
  // mail 0071_withheld_provenance_index. Listed for the same property as the three above: its
  // absence is SILENT. The worker's `junk_filed` convergence pass (`junk-restore.ts`) walks
  // `message_bodies` by `withheld_reason` once per cycle per mailbox to find the few husks whose
  // message is alive in a watched folder again; without this partial index that read tests the
  // marker on every body of the mailbox, per cycle — no query is wrong, every test stays green,
  // and the only symptom is a worker cycle that stops finishing on a large mailbox.
  "message_bodies_withheld_idx",
  // mail 0080_sessions_access_token_hash_idx. Listed for the same property as the four above,
  // and it is the sharpest instance of it yet: `resolveSession` is the FIRST thing every
  // authenticated request does, its predicate is `access_token_hash = $1`, and without this
  // index that is a sequential scan of a table that grows monotonically (sessions are marked
  // revoked, never reaped) and whose row count any caller with one account's credentials can
  // raise at request rate. Absent, nothing raises and every test stays green; the only symptom
  // is every user's every request paying for every session the deployment has ever minted.
  "sessions_access_token_hash_idx",
];

/**
 * CHECK-constraint markers — invisible to both probes above, for the reason the index list
 * exists: `information_schema.columns` cannot see a constraint and `pg_indexes` cannot either, so
 * mail 0022, whose entire content is one CHECK, would have been certified applied on a database
 * that never took it. `message_bodies_html_cap` earns its place on what breaks without it: the
 * last of three defences against unbounded stored HTML and the only one living in the database —
 * without it `message_bodies` re-bloats silently under any regression in
 * `html-storage.ts`/`mime.ts`, and the first symptom is Postgres refusing writes for the whole
 * project. Counted into the same totals as the other lists.
 */
export const SCHEMA_CHECK_MARKERS: ReadonlyArray<string> = [
  "message_bodies_html_cap",       // mail 0022_message_body_html_cap
  // mail 0027_organizer_lease — the closed set behind `mailboxes.disabled_reason`. It gets its
  // own marker rather than riding on the column's, because the column and the constraint fail
  // DIFFERENTLY and only one of them is loud: a missing column raises 42703 on the first read,
  // while a column present WITHOUT its CHECK accepts anything the write site lets through and
  // says nothing. That is the same shape as an unconstrained `error_detail`, and it is precisely
  // what a probe over `information_schema.columns` cannot see.
  "mailboxes_disabled_reason_closed",
  // mail 0029_mailbox_sync_block — the closed set behind `mailboxes.sync_blocked_reason`, for the
  // same reason as the line above, and with one more consumer that makes it sharper. This set is
  // what the operator-console isolation test relies on when it classifies the column as
  // REFUSED_BY_CONSTRAINT rather than tainting it: the argument "no value a mail server chose can
  // reach an operator's screen through this field" is an argument ABOUT THE CHECK. A column
  // present without it silently converts a closed set into free text that the worker's own writes
  // would keep filling correctly — so nothing in the product misbehaves, no test notices, and the
  // isolation claim quietly rests on nothing.
  "mailboxes_sync_blocked_reason_closed",
  // mail 0037_draft_html — the 256 KiB ceiling on `drafts.html`. It is listed for
  // `message_bodies_html_cap`'s reason with one difference that argues FOR it rather than
  // against: this is the only column on `drafts` whose size a hostile client chooses directly.
  // Every other composable field is a subject line or an address list the service parses and
  // bounds; `html` is bytes posted verbatim. `DraftsService` refuses above the cap with a 400,
  // and that refusal is code, which can regress — at which point the column silently accepts
  // whatever the write site lets through and nothing raises, which is the exact shape of the
  // 0027 argument on a column that carries more of it.
  "drafts_html_cap",
  // mail 0044_dormancy_days_max — the one-year ceiling on `account_settings.dormancy_days`, and the
  // FIRST CHECK marker that is not about storage size. It is listed on `message_bodies_html_cap`'s
  // rule and it is the sharpest case of it: the migration's ENTIRE content is this constraint (there
  // is no column to add — 0035 created `dormancy_days`), so a database that ran through 0043 but not
  // 0044 has every column marker present and is invisible to the column probe. What that database
  // loses is not a slow path but a LOUD crash the bound exists to prevent — a stored value above the
  // cap makes `cutlineCounts`' `toISOString()` throw `RangeError`, and `GET /consent` 500s for that
  // account on every tab load. `setDormancyDays` refuses >365 with a 400, but that refusal is code and
  // can regress; the CHECK is the one layer that holds for every writer, and this marker is what makes
  // a deploy against a database missing 0044 say `503 schema_incomplete` and name the file to run.
  "account_settings_dormancy_days_max",
  // mail 0050_rule_subject_contains — the constraint making NULL the only representation of "no
  // subject term". Listed on 0027's rule (the column and the CHECK fail differently, only one
  // loud) and its sharpest instance: what the CHECK forbids is an ambiguous value, not an
  // oversized one. Without it `''` and `' '` are storable, and every reader decides independently
  // whether they mean absent — the first one that stops agreeing produces a rule matching every
  // subject while its row reads as specific, and nothing raises. `RulesService` refuses the same
  // shapes with a 400, but that is code and can regress; the CHECK holds for every writer, the
  // retro pass and any future importer included.
  "rules_subject_contains_nonempty",
  // mail 0052_rule_body_contains — the same constraint for the third term, on 0050's argument
  // verbatim: what it forbids is the AMBIGUOUS value, `''` and `'   '`, whose first
  // reader-disagreement is a rule that matches EVERY MESSAGE while its row reads as specific —
  // and for a body term "every message" is literal, since every message has a body to substring.
  // Same predicate, same six-character class, and the pg test pins the two constraints'
  // definitions equal up to the column name. It was the newest entry here until mail 0053's locale
  // set landed below it.
  "rules_body_contains_nonempty",
  // mail 0053_account_locale — the closed set behind `account_settings.locale`. The clearest
  // loud/silent asymmetry in this list: a missing column 42703s the whole consent surface on the
  // next request, while a column present without its constraint accepts any string — and every
  // consumer of a wrong value degrades silently (`loadCatalog` falls back to English, the server
  // render falls back, `normalizeLocale` answers null), so a stored `'fr'` or `''` is a language
  // setting that simply does not work, with nothing to grep for. The service validates the same
  // set with a 400; the CHECK is the layer that holds for a hand-run UPDATE, a future admin tool
  // and any importer.
  "account_settings_locale_supported",
  // mail 0082_theme_face — the closed set behind `account_settings.theme_face`. Listed on
  // 0027's rule (the column and the CHECK fail DIFFERENTLY, and only one is loud), with
  // 0053's silent-degradation shape exactly: a stored face outside the set renders as paper
  // everywhere — `consentSettings` filters it to null on the read side, the client normalises
  // it to null, the Settings row shows the device's own answer — so a setting that "does not
  // work" leaves no error in any log. The service validates the same set with a 400, but that
  // is code and can regress; the CHECK holds for a hand-run UPDATE and any importer.
  "account_settings_theme_face_supported",
  // mail 0083_organizer_role — the four closed sets this migration adds, listed on 0027's rule
  // (the column and the CHECK fail differently, only one loud). `mailboxes_organizer_role_closed`
  // is the strongest here: the state it makes unrepresentable is two organizers on one mailbox —
  // a value outside the set is read as `reader` (fail-safe), but nothing stops a hand-run UPDATE,
  // and the CHECK holds when the code does not. `mailboxes_organized_by_kind_closed` closes a
  // value derived from another install's claim — a header a foreign writer chose, read by the
  // account's own user (`organized_by_name` deliberately has no CHECK: free text closes no set;
  // its bound is at the write site). The other two are 0053's silent-degradation shape: a value
  // outside either set renders as "we have not looked" / the default window — a setting that does
  // not work, with nothing to grep for.
  "mailboxes_organizer_role_closed",
  "mailboxes_organized_by_kind_closed",
  "mailboxes_organizer_state_closed",
  "account_settings_screening_scope_closed",
  // mail 0063_smtp_size_probe_stamp — the closed set behind `mailboxes.smtp_size_probe_code`, and
  // the sharpest origin in this list: the stored value derives from an SMTP AUTH failure, and
  // nodemailer's message embeds the submission server's own response line — third-party text that
  // routinely contains the username and can echo a credential. The code-not-message rule in
  // `SmtpSizeFailure` keeps that off a log drain; this constraint keeps it out of a `mailboxes`
  // row. The write site takes a `SmtpSizeProbeCode`, so the compiler refuses free text today —
  // and that is code, and code regresses: `error_detail` had exactly one write-site guard and a
  // server's bracket atom walked through it.
  "mailboxes_smtp_size_probe_code_closed",
  // mail 0088_symmetric_takeover — the two closed sets on `organizer_requests`, 0053's
  // silent-degradation shape with a sharper edge. `organizer_requests_kind_closed` decides which
  // applier runs on the organizer's side of a handover; the value arrives out of an RFC822 header
  // another install wrote — untrusted by construction — and a member outside the set would be
  // resolved by whichever branch the drain falls through to, and those branches move somebody's
  // mail. `organizer_requests_state_closed` is the queue's own progress: a value outside the set
  // matches none of the four reads, so the request is neither handed over, applied, nor expired —
  // it stops moving, with nothing to grep for.
  "organizer_requests_state_closed",
  "organizer_requests_kind_closed",
  // mail 0091_request_refusal_closed — the closed set behind `organizer_requests.refused_reason`.
  // 0090 added the column as free text and the write path was already closed in code: an
  // acknowledgement is verified under the account's key before it is read, and its parser maps any
  // reason outside the eight-word vocabulary to NULL. That argument is exactly the one 0029's entry
  // above says is not enough on its own — the operator console's isolation sweep can see a
  // constraint and cannot see a parser, so a closed set that lives only in code is classified as
  // free text, correctly. With the CHECK present the column is REFUSED_BY_CONSTRAINT there, and
  // that classification is an argument ABOUT THIS CONSTRAINT: take it away and the line becomes an
  // assertion about free text while nothing in the product misbehaves and no test notices. Which is
  // why the classification and this marker landed in the same commit.
  "organizer_requests_refused_reason_closed",
  // mail 0093_outbound_send_fingerprints — `fingerprint ~ '^[0-9a-f]{64}$'`, and it is here for the
  // silent-degradation property this list exists for rather than for the send path's sake.
  //
  // The column holds a digest this codebase computes and nothing a mail server, a sender or a
  // message body can choose, so the write path is closed in code — which is exactly the argument
  // 0029's and 0091's entries above say is NOT enough on its own. The operator console's isolation
  // sweep can see a constraint and cannot see a write path, and it classifies this column as
  // refused-by-constraint on the strength of this CHECK. Take the CHECK away and that
  // classification becomes an assertion about free text while nothing in the product misbehaves
  // and no test notices. The classification, the migration and this marker are one edit.
  "outbound_send_fingerprints_hex",
];

/**
 * A CHECK marker probed by its definition, not merely its name: `[conname, definitionSubstring]`
 * — the constraint must exist and `pg_get_constraintdef` must contain the substring. {@link
 * SCHEMA_CHECK_MARKERS} probes names, blind to a constraint replaced under its existing name —
 * the only way PostgreSQL amends a CHECK: both names then exist on a never-migrated database, and
 * the host serves under the old rule while `/health` says `schemaOk: true`. Cloud 0011 is that
 * shape and the reason this list exists. A substring, not the whole definition:
 * `pg_get_constraintdef` is normalized and version-dependent; the added vocabulary survives
 * upgrades and the old definition cannot satisfy it.
 */
export type CheckDefinitionMarker = readonly [conname: string, definitionSubstring: string];

/**
 * A FUNCTION marker probed by its body — the fifth marker class, the last catalog the other four
 * cannot reach: `[proname, bodySubstring]` against `pg_proc.prosrc`. A trigger-function
 * replacement is the constraint-replacement defect one catalog over, and worse: `CREATE OR
 * REPLACE FUNCTION` changes no name, no column, no index. Cloud 0013 rode the index it happened
 * to create; cloud 0014's entire content is a replaced function body, so the class has to exist.
 * A missing entry costs the silent direction: every layer reports healthy and the newer body's
 * invariant is not enforced. `prosrc`, not `pg_get_functiondef`: the body exactly as written —
 * pick the predicate the migration added.
 */
export type FunctionDefinitionMarker = readonly [proname: string, bodySubstring: string];

/* `EXPECTED_MARKERS` — the BOTH-HALVES count — moved to `./health-cloud.js` with the list it
 * derives from. {@link MAIL_EXPECTED_MARKERS} below is what this module can compute on its own. */

/**
 * The same probe for a host that only ever ran the mail journal. A desktop install migrates
 * `MAIL_JOURNAL` alone — no billing ledger, no passkey challenge store, no staff directory, and
 * it should not have them. Probed against the full set it reports `schema_incomplete` forever,
 * the opposite of what that answer means: not an unmigrated database, a complete one of a
 * different shape. Two lists rather than a flag inside the probe: the honest statement is "this
 * host expects these markers", and the count derives from the list that was asked. The index and
 * check markers are unsplit deliberately — every one names a mail table — and if a Cloud-only
 * entry is ever added, this constant is where the split happens, loudly.
 */
/**
 * The MAIL constraints probed by definition — see {@link CheckDefinitionMarker}.
 * `away_responders_piles_closed` was created by 0096 over two members and replaced by 0101 over
 * four; the name is identical on both databases, so a name probe certifies a 0096 host while the
 * constraint refuses every scope the settings pane offers — a save the person is told succeeded,
 * rejected inside the write's transaction. `mailboxes_sync_blocked_reason_closed` is the same
 * shape from 0102: a fourth member under the existing name, and against a three-member database
 * the worker's soft-block write is refused at the one moment it exists to record. The needle in
 * both is the vocabulary the migration adds.
 */
export const MAIL_CHECK_DEFINITION_MARKERS: ReadonlyArray<CheckDefinitionMarker> = [
  ["away_responders_piles_closed", "ohmail/Screener"],
  ["mailboxes_sync_blocked_reason_closed", "read_limited"],
  /* Mail 0103 — `mobile` joins the organizer kinds. TWO entries, because the kind reaches this
     table twice and the migration replaces BOTH constraints under their existing names, so a
     name-presence probe cannot tell an 0102 database from an 0103 one. What a missing entry costs
     here is the loud direction rather than the silent one, and it is worse for it: certified
     healthy against an 0102 database, an install reads a live phone's claim and the write that
     records it is REFUSED by the old CHECK — on a mailbox somebody is using. The needles are the
     vocabulary each definition gains and its predecessor cannot contain. */
  ["mailboxes_organized_by_kind_closed", "mobile"],
  ["mailboxes_disabled_reason_closed", "organized_elsewhere:mobile"],
];

export const MAIL_EXPECTED_MARKERS =
  MAIL_SCHEMA_MARKERS.length + SCHEMA_INDEX_MARKERS.length + SCHEMA_CHECK_MARKERS.length +
  MAIL_CHECK_DEFINITION_MARKERS.length;

/**
 * The newest entry of the MAIL journal, which {@link MAIL_SCHEMA_MARKERS} is reconciled to; a
 * test asserts the tag is the newest entry in its own journal. The rules (each marker's entry
 * argues its migration): probe the column a query reads, once per table facet; index-only and
 * CHECK-only migrations are probed through their own lists; a replaced definition through the
 * definition markers; a DATA-ONLY migration is unprobeable, gets no marker, and must not move the
 * tag — advancing `through` while probing nothing the migration added is a worse lie than a stale
 * tag, and shipped once (recorded in `SCHEMA_INDEX_MARKERS`' docblock). Add a marker: move this
 * sentence with the tag. Add a data-only migration: leave both.
 */
// 0067/0068 (the device-sync alert's withdrawn SECURITY DEFINER carrier and its retirement)
// add no column and get no marker: a function's absence is the ALERT RULE's own isolated,
// tolerated state, not a schema fault a serving API should 503 over.
export const MAIL_SCHEMA_MARKER_JOURNAL_TAG = "0103_organizer_kind_mobile";


/* `CLOUD_SCHEMA_MARKER_JOURNAL_TAG` moved to `./health-cloud.js`: it is the NAME of a cloud
 * migration, and this module ships in the desktop engine. */

/* `SCHEMA_MARKER_JOURNAL_TAG` — the composite — moved to `./health-cloud.js` for the same
 * reason: it interpolates the cloud tag. */

/**
 * One round trip, run once and read twice. `GET /admin/overview` has to publish the same
 * `ApiHealth` a probe would see — the console's claim is that it renders what `/health` says, not
 * a second opinion — and the only way for two endpoints to agree is to execute the same statement
 * and the same verdict; a copy of this SQL in `admin-service.ts` would drift on the first schema
 * marker added, invisibly, both endpoints still 200. It returns the raw probe rather than a
 * rendered body because the two callers need different shapes: `/health` has a published body
 * this may not alter by a single key, and the console needs `ApiHealth` — the rendering stays
 * with each caller.
 */
export type HealthProbe =
  | { kind: "unreachable"; dbLatencyMs: number; errorCode: string | null }
  | { kind: "empty"; dbLatencyMs: number }
  /**
   * Reachable, and the schema census does not apply to this store. The census reads five Postgres
   * catalogs; a device store has none of them — its catalog is `sqlite_master`, a different
   * question, and its schema is guaranteed by a different journal run by a different migrator.
   * This arm exists because the store read as unreachable, measured on a working phone: `/health`
   * answered 503 `database_unreachable` while the same composition served mail — the census
   * statement throws on the device store, and "the query did not run" was indistinguishable from
   * "the database is gone". Liveness is asked first, in a way both stores answer; the census runs
   * only where its catalogs exist. `ok` on this arm means the store answered.
   */
  | { kind: "live"; dbLatencyMs: number }
  | { kind: "probed"; dbLatencyMs: number; pgTrgm: boolean; schemaOk: boolean; markersFound: number };

export async function probeDatabase(
  db: ApiDeps["db"],
  /**
   * Which column markers this host expects. Defaults to both journals, which is every hosted
   * deployment; a local engine passes {@link MAIL_SCHEMA_MARKERS}, because it ran one journal and
   * a database missing the other half is correct rather than incomplete.
   */
  columnMarkers: ReadonlyArray<SchemaMarker> = MAIL_SCHEMA_MARKERS,
  /**
   * Constraints whose DEFINITION is probed — see {@link CheckDefinitionMarker}. Defaults to
   * {@link MAIL_CHECK_DEFINITION_MARKERS}, which is the mail tier's own set: it used to default to
   * none, on the ground that every entry named a Cloud table, and mail 0101 ended that. A caller
   * passing its own list REPLACES this one, so a hosted caller passes the union of both tiers.
   */
  checkDefinitionMarkers: ReadonlyArray<CheckDefinitionMarker> = MAIL_CHECK_DEFINITION_MARKERS,
  /**
   * INDEX markers beyond {@link SCHEMA_INDEX_MARKERS} — the same `pg_indexes` probe, extended
   * the way `checkDefinitionMarkers` extends the constraint probes and for the same reason:
   * every entry so far names a Cloud table (`CLOUD_INDEX_MARKERS` in `health-cloud.ts`), and
   * this module ships in the desktop engine, so the names must arrive as a parameter rather
   * than live here. Defaults to none — a mail-tier database is complete without them.
   */
  extraIndexMarkers: ReadonlyArray<string> = [],
  /**
   * Trigger/helper FUNCTIONS whose BODY is probed — see {@link FunctionDefinitionMarker}.
   * Defaults to none, on the same rule as the two parameters above: every entry so far names a
   * Cloud function (`CLOUD_FUNCTION_MARKERS` in `health-cloud.ts`) and this module ships in the
   * desktop engine, so the names arrive as a parameter rather than living here.
   */
  functionDefinitionMarkers: ReadonlyArray<FunctionDefinitionMarker> = [],
): Promise<HealthProbe> {
  const started = Date.now();
  /**
   * The device store's arm, deliberately before everything else. The Postgres path below stays
   * byte-for-byte as it was, including its single statement and what `dbLatencyMs` measures: the
   * hosted `/health` body is published and its test must stay identical, so the safest shape is
   * one that executes no new code on a Postgres host — this branch returns before any of it.
   * `select 1` and nothing else, through the dialect seam so it renders on either store: "does
   * the store answer" is the only question a health endpoint can ask a store whose schema it
   * cannot census.
   */
  /**
   * The test is "is it the device store", not "is it not Postgres", and the control said so:
   * written first as `dialectOf(db) !== "pg"`, which fails on an unbranded handle — `dialectOf`
   * refuses one by design — and the hosted `/health` suite hands this function hand-built fakes
   * carrying no brand; six of its cases went red, which is what that suite is for. So the
   * Postgres path is the default, and only a handle that positively identifies itself as the
   * device store takes the branch. Fail-open is right here: the decision is whether to ask five
   * Postgres catalogs a question, and an unbranded handle reaching a store at all is a violation
   * the seam refuses in its own right.
   */
  let deviceStore = false;
  try {
    deviceStore = dialectOf(db) === "sqlite";
  } catch {
    /* Unbranded: not this branch's business to diagnose. The seam refuses it at the first
       statement it composes, with a message naming the factory that owes the brand. */
    deviceStore = false;
  }
  if (deviceStore) {
    try {
      const alive = await dialect(db).exec(db, sql`select 1 as one`);
      const dbLatencyMs = Date.now() - started;
      /**
       * READ POSITIONALLY, because that is what the seam guarantees on this store.
       *
       * The device arm of `exec` answers an array of ARRAYS — the column names are gone by the time
       * a caller sees them, which is the same positional contract the device store's whole binding
       * rests on. Written first as `row.one`, it read `undefined`, `Number(undefined)` is `NaN`,
       * and a live store reported `database_probe_empty`: a false state, arrived at by asking a
       * named question of an unnamed answer. The object arm is kept as the fallback so this stays
       * correct if it is ever reached with a handle whose `exec` answers rows by name.
       */
      const first = rowsOf<unknown>(alive)[0];
      const one = Array.isArray(first) ? first[0] : (first as { one?: unknown } | undefined)?.one;
      if (Number(one) !== 1) return { kind: "empty", dbLatencyMs };
      return { kind: "live", dbLatencyMs };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        kind: "unreachable",
        dbLatencyMs: Date.now() - started,
        errorCode: typeof code === "string" ? code : null,
      };
    }
  }
  const indexMarkers = [...SCHEMA_INDEX_MARKERS, ...extraIndexMarkers];
  const expected =
    columnMarkers.length + indexMarkers.length + SCHEMA_CHECK_MARKERS.length +
    checkDefinitionMarkers.length + functionDefinitionMarkers.length;
  try {
    /* A DECLARED POSTGRES-ONLY ARM, and the declaration is the honest form of what this already
       was. The whole statement asks five Postgres CATALOGS — `information_schema.columns`,
       `pg_indexes`, `pg_constraint`, `pg_proc` — whether this deployment's schema and its
       extension are what the code expects. There is no second spelling of that question: the
       device store's catalog is `sqlite_master` and `pragma table_info`, which is a different
       question, and the branch above answers it and RETURNS on every path, so nothing reaches
       here except a server. Marking it says so at the site instead of leaving a reader to derive
       it, and the census pins how many such arms this file has. */
    const result = await db.execute(
      pgOnly(sql`select 1 as one,
                 to_regprocedure('word_similarity(text,text)') is not null as pg_trgm,
                 (select count(*) from information_schema.columns
                   where table_schema = 'public'
                     and (table_name, column_name) in (${sql.join(
                       columnMarkers.map(([t, c]) => sql`(${t}, ${c})`),
                       sql`, `,
                     )})) as schema_markers,
                 -- The index half: pg_indexes, because information_schema has no view of
                 -- indexes at all. Scoped to public, like the column probe above. The list is
                 -- the shared mail markers plus whatever the host registered (see the
                 -- extraIndexMarkers parameter).
                 (select count(*) from pg_indexes
                   where schemaname = 'public'
                     and indexname in (${sql.join(
                       indexMarkers.map((n) => sql`${n}`),
                       sql`, `,
                     )})) as index_markers,
                 -- The CHECK half: a third catalog again, because neither view above can see a
                 -- constraint. contype = 'c' excludes FK/unique/PK constraints, whose names
                 -- share the same namespace, and the join to pg_namespace scopes it to public
                 -- exactly like the other two.
                 (select count(*) from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                   where n.nspname = 'public' and c.contype = 'c'
                     and c.conname in (${sql.join(
                       SCHEMA_CHECK_MARKERS.map((n) => sql`${n}`),
                       sql`, `,
                     )})) as check_markers,
                 -- The CHECK-DEFINITION half: the same catalog again, asking a different
                 -- question. A migration that REPLACES a constraint under its existing name is
                 -- invisible to the name probe above — both names are present on a database that
                 -- never ran it — so this reads the rendered definition and looks for the
                 -- vocabulary the migration added. A literal FALSE when the list is empty keeps
                 -- the subselect valid and its count at 0 for a host that passes none.
                 (select count(*) from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                   where n.nspname = 'public' and c.contype = 'c'
                     and (${checkDefinitionMarkers.length > 0
                       ? sql.join(
                         checkDefinitionMarkers.map(([name, needle]) =>
                           pgOnly(sql`(c.conname = ${name} and position(${needle} in pg_get_constraintdef(c.oid)) > 0)`)),
                         sql` or `,
                       )
                       : sql`false`
                     })) as check_def_markers,
                 -- The FUNCTION-BODY half: a FIFTH catalog, because a migration whose entire
                 -- content is a CREATE OR REPLACE FUNCTION changes nothing the four probes
                 -- above can see — not a column, not an index, not a constraint name, and not
                 -- a constraint DEFINITION (a function is pg_proc). prosrc is the body as
                 -- written. Scoped to public like the rest; a literal FALSE when the list is
                 -- empty keeps the subselect valid at 0 for a host that passes none.
                 (select count(*) from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and (${functionDefinitionMarkers.length > 0
                       ? sql.join(
                         functionDefinitionMarkers.map(([name, needle]) =>
                           pgOnly(sql`(p.proname = ${name} and position(${needle} in p.prosrc) > 0)`)),
                         sql` or `,
                       )
                       : sql`false`
                     })) as function_def_markers`),
    );
    const dbLatencyMs = Date.now() - started;
    const row = rowsOf<{
      one: number; pg_trgm: boolean; schema_markers: number | string; index_markers: number | string;
      check_markers: number | string; check_def_markers: number | string;
      function_def_markers: number | string;
    }>(result)[0];
    if (!row || Number(row.one) !== 1) return { kind: "empty", dbLatencyMs };
    // One total across all five probes — see `SCHEMA_INDEX_MARKERS` for why they are not five.
    const markersFound =
      Number(row.schema_markers) + Number(row.index_markers) + Number(row.check_markers) +
      Number(row.check_def_markers) + Number(row.function_def_markers);
    return {
      kind: "probed",
      dbLatencyMs,
      pgTrgm: Boolean(row.pg_trgm),
      schemaOk: markersFound === expected,
      markersFound,
    };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return {
      kind: "unreachable",
      dbLatencyMs: Date.now() - started,
      errorCode: typeof code === "string" ? code : null,
    };
  }
}

/**
 * The fault a probed database has, ordered by severity — or null when the host is healthy.
 *
 * Ordered by blast radius: a wrong/unmigrated database first (nothing works at all), then the
 * KEK (credentials undecryptable), then build identity (unidentifiable deploy).
 */
export function healthFault(input: {
  schemaOk: boolean;
  markersFound: number;
  kekError: string | null;
  buildError: string | null;
  /** What this host expects. A local engine ran one journal — see {@link MAIL_EXPECTED_MARKERS}. */
  expected?: number;
  /** Which journal entries that count was reconciled to. Absent ⇒ the mail journal alone. */
  through?: string;
}): { error: string; detail: string } | null {
  if (!input.schemaOk) {
    return {
      error: "schema_incomplete",
      detail:
        `expected ${input.expected ?? MAIL_EXPECTED_MARKERS} schema markers ` +
        `(through ${input.through ?? MAIL_SCHEMA_MARKER_JOURNAL_TAG}), found ${input.markersFound} — run ` +
        `'pnpm db:setup:prod' against this database`,
    };
  }
  if (input.kekError !== null) return { error: "kek_env_invalid", detail: input.kekError };
  if (input.buildError !== null) return { error: "build_identity_unknown", detail: input.buildError };
  return null;
}

export const healthRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/health",
    relay: true,
    cost: "unauthenticated",
    options: { public: true, raw: true, anonymous: true },
    handler: async (_req, deps) => {
      const injected = deps.health;
      const version = injected?.version ?? API_VERSION;
      // An injected `health` is AUTHORITATIVE: the host already parsed its own environment
      // (and may have captured a KEK failure there). Without one — the test harness, and
      // any host that forgets to inject — read the environment here so the endpoint still
      // reports truthfully rather than silently claiming "no KEK".
      let kek: ReturnType<typeof kekEnvIdentity> | null = injected?.kek ?? null;
      let kekError: string | null = injected?.kekError ?? null;
      if (!injected) {
        try {
          kek = kekEnvIdentity() ?? null;
        } catch (err) {
          kekError = err instanceof Error ? err.message : "invalid KEK environment";
        }
      }
      // A production deployment with no commit sha and no `TF_BUILD_VERSION` is a deployment
      // nobody can identify: the moment two of them behave differently, "which build is
      // this?" has no answer, and the KEK/schema comparisons lose their anchor. The host
      // still serves — this is a reporting fault, not a fatal one — but it is NOT healthy.
      const buildError = injected?.buildError ?? null;
      // Where `version` came from — see {@link BuildIdentitySource}. Published beside
      // `version`/`buildError` on every branch, like `dbProvider`, so a consumer never has to
      // infer provenance from the presence or absence of a fault.
      const buildSource = injected?.buildSource ?? null;
      // NOT a `healthFault` — see `HealthConfig.adminError` for why an unarmed staff
      // console must not darken the product host. It is published because with the surface
      // unarmed there is no `/admin/*` endpoint left that could report its own absence.
      const adminError = injected?.adminError ?? null;
      // A SECOND, SEPARATE key, and the separation is the finding. `adminFault` says
      // "the staff console is unarmed"; this says "the pager is configured and has no database,
      // so nothing is watching the worker". The old code could only say the first, and said it
      // about hosts whose real problem was the second. Also 200: an observability fault must
      // never darken the product — see `HealthConfig.alertsError`.
      const alertsError = injected?.alertsError ?? null;
      // RUN THE CONTENT-BLIND ATTESTATION, non-fatally. `adminFault` names the static
      // console refusals; this names the one they cannot see — a plausible over-privileged
      // `DATABASE_URL_ADMIN` — which otherwise surfaced only as a per-request 503. Awaited (the
      // memoised factory pays the round trips once per cold instance), never allowed to throw:
      // a dark console must not take the product host out of rotation. Absent on hosts with no
      // blind connection, so this is a no-op for desktop and unarmed deployments.
      let staffDbFault: string | null = null;
      if (injected?.staffDbAttestation) {
        try {
          staffDbFault = await injected.staffDbAttestation();
        } catch {
          // The capability itself is contracted not to throw; this is belt-and-braces so a
          // future edit to it can never darken `/health`.
          staffDbFault = null;
        }
      }
      const staffFaults = {
        ...(adminError ? { adminFault: adminError } : {}),
        ...(alertsError ? { alertsFault: alertsError } : {}),
        ...(staffDbFault ? { staffDbFault } : {}),
      };
      // Not a fault, and never 503: it is the tripwire for the NEXT provider migration.
      // `unrecognized` here means the connection guards have gone silent again. Emitted beside
      // `kek` on every branch, including the unhealthy ones, because a host that cannot reach its
      // database is exactly when knowing which family it dialled is worth most.
      const dbProvider = injected?.dbProvider ?? null;
      // THE ENTITLEMENTS COMPOSITION MARKER, on dbProvider's exact pattern: a fixed string,
      // injected by the host, never a fault. It is the tripwire for a configuration change whose
      // failure mode is camouflaged — a host that lost its entitlements URL reads as a
      // legitimately unmetered one. Emitted on every branch, like dbProvider and for its reason.
      const entitlements = injected?.entitlements ?? null;

      // The pager's arms — the worker's boot announcement, in the idiom a serverless host has. A
      // memory read (`HealthConfig.alertSinks` says why it is a capability), so it costs no round
      // trip and is published on every branch below, beside `dbProvider` and `entitlements`: a
      // host that cannot reach its database is exactly when "can this deployment still page
      // anybody?" is worth most. Two keys from one call: `alertSinks` is the same key, shape and
      // closed codes the worker publishes, so the two are a literal JSON diff; `alertPasses` is
      // what stops the counters lying on a cold instance.
      let pager: Record<string, unknown> = {};
      if (injected?.alertSinks) {
        try {
          const summary = injected.alertSinks();
          pager = { alertSinks: summary.arms, alertPasses: summary.passes };
        } catch {
          // Contracted not to throw — it reads memory. Belt-and-braces for the same reason
          // `staffDbAttestation`'s catch exists: an observability surface may never darken the
          // host it reports on, and `raw` means there is no error envelope above this handler.
          pager = {};
        }
      }

      // WHICH SCHEMA THIS HOST IS SUPPOSED TO HAVE. A desktop install ran the mail journal alone
      // and has no billing ledger to find; probed against both, it would answer
      // `schema_incomplete` on every request for ever — which reads as "somebody forgot to
      // migrate" about a database that is complete.
      const mailOnly = injected?.schemaTier === "mail";
      // THE FULL-TIER CENSUS IS THE HOST'S TO SUPPLY, because its entries are Cloud table and
      // column names and this module ships in the desktop engine (`health-cloud.ts`). A host that
      // claims the full tier and hands over no census is a CONFIGURATION FAULT, not a host that
      // silently probes the mail half: answering "healthy" off a narrower probe is exactly the
      // "somebody forgot to migrate, and nothing said so" failure this route exists to catch.
      const fullCensus = mailOnly ? null : fullSchemaCensus();
      const through = fullCensus?.through ?? MAIL_SCHEMA_MARKER_JOURNAL_TAG;
      const expectedMarkers = fullCensus
        ? fullCensus.expected
        : MAIL_EXPECTED_MARKERS;
      const probe = await probeDatabase(
        deps.db,
        fullCensus ? fullCensus.markers : MAIL_SCHEMA_MARKERS,
        // The check-DEFINITION list is the one class a mail-tier host DOES carry: mail 0102
        // widens a mail CHECK, so `MAIL_CHECK_DEFINITION_MARKERS` names a mail table and a local
        // engine's database is incomplete without it. The index and function lists stay empty —
        // every entry there names a Cloud table or a Cloud function.
        fullCensus ? fullCensus.checkDefinitions : MAIL_CHECK_DEFINITION_MARKERS,
        fullCensus ? fullCensus.indexMarkers : [],
        fullCensus ? fullCensus.functionDefinitions : [],
      );
      if (probe.kind === "unreachable") {
        return healthResponse(503, {
          ok: false,
          version,
          buildSource,
          dbLatencyMs: probe.dbLatencyMs,
          error: "database_unreachable",
          errorCode: probe.errorCode,
          kek,
          dbProvider,
          entitlements,
          ...pager,
          ...staffFaults,
        });
      }
      if (probe.kind === "empty") {
        return healthResponse(503, {
          ok: false, version, buildSource, dbLatencyMs: probe.dbLatencyMs, error: "database_probe_empty", kek,
          dbProvider,
          entitlements,
          ...pager,
          ...staffFaults,
        });
      }

      /**
       * The device store answered, and there is no schema census to report for it. `schemaOk` and
       * the marker counts are Postgres-catalog readings, so they are absent rather than zero — a
       * `found: 0, expected: 47` body would read as a broken schema on a store whose schema is
       * fine, the false state this arm exists to stop being shown; `pgTrgm` is absent for the
       * same reason. The key faults that are not store-shaped still apply, which is why this goes
       * through `healthFault` rather than returning 200 flat: a missing install key or a broken
       * build is as wrong on a phone as anywhere else.
       */
      if (probe.kind === "live") {
        const liveFault = healthFault({
          schemaOk: true, markersFound: 0, kekError, buildError, expected: 0, through,
        });
        return healthResponse(liveFault ? 503 : 200, {
          ok: liveFault === null,
          version,
          buildSource,
          dbLatencyMs: probe.dbLatencyMs,
          cookieAuth: deps.allowCookieAuth !== false,
          kek,
          dbProvider,
          ...pager,
          ...staffFaults,
          ...(liveFault ?? {}),
        });
      }

      const fault = healthFault({
        schemaOk: probe.schemaOk, markersFound: probe.markersFound, kekError, buildError,
        expected: expectedMarkers, through,
      });
      return healthResponse(fault ? 503 : 200, {
        ok: fault === null,
        version,
        buildSource,
        dbLatencyMs: probe.dbLatencyMs,
        pgTrgm: probe.pgTrgm,
        schemaOk: probe.schemaOk,
        schemaMarkers: {
          found: probe.markersFound, expected: expectedMarkers, through,
        },
        // Same default as `withSession`: absent means the historical "cookies allowed".
        cookieAuth: deps.allowCookieAuth !== false,
        kek,
        dbProvider,
        entitlements,
        ...pager,
        ...staffFaults,
        ...(fault ?? {}),
      });
    },
  },
];

/**
 * Normalize the driver-specific `execute` shape: postgres-js returns an ARRAY, PGlite
 * returns `{ rows }`. Same helper as `search-service.ts` / `kb-service.ts` — and it is
 * not optional here: reading `result[0]` directly makes `/health` report
 * `database_probe_empty` against PGlite, i.e. the endpoint would answer 503 in the very
 * harness that is supposed to prove it answers 200.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Always `no-store`: a cached health response is a lie about the present. */
function healthResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
