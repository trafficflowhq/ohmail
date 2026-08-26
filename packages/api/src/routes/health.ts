import { sql } from "drizzle-orm";
import { kekEnvIdentity } from "@trafficflow/core/mail";
import { fullSchemaCensus } from "./health-census.js";
import { API_VERSION } from "../version.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";

/**
 * `GET /health` — the API host's liveness + identity endpoint.
 *
 * `public` (no credential: a probe has none), `anonymous` (see below) and `raw` (the reduced
 * pipeline: no JSON envelope, no CSRF, no idempotency). Because `raw` means there is NO
 * `withErrorEnvelope` above it, this handler must never throw — an unhandled rejection here
 * would surface as the platform's own 500 page, i.e. a health endpoint whose failure mode is
 * unreadable. Everything is therefore inside one try/catch.
 *
 * `anonymous` is what makes the two claims below actually TRUE. While `/health` ran the
 * normal pipeline, `withSession` resolved any credential that happened to be presented, so a
 * probe carrying an ambient browser cookie cost a second query ("one round trip" held only
 * for anonymous callers) and — far worse — that query ran OUTSIDE this try/catch: with the
 * database down, a cookie-bearing request got the host's generic 500 instead of the
 * controlled `database_unreachable` 503. The endpoint failed hardest in the only situation it
 * exists for.
 *
 * **It must not lie in either direction** (the rule the worker's health server already
 * obeys). Four verdicts, each chosen so a probe can be trusted:
 *
 *  • database unreachable ⇒ **503** `database_unreachable`. Answering 200 would keep a dead
 *    deployment in rotation.
 *  • database reachable but the SCHEMA is not the application's ⇒ **503** `schema_incomplete`.
 *    A reachable VIRGIN database used to answer `200 {ok:true, pgTrgm:false}` while every
 *    single application query would fail on a missing table — the deployment was "healthy"
 *    and totally non-functional. The lexical-degradation argument below only holds once the
 *    base schema is known to be there, so the schema check comes first.
 *  • `pg_trgm` missing on a migrated database ⇒ **200 with `pgTrgm: false`**. That IS
 *    degradation, not death: `SearchService` falls back to its lexical arm. The flag is the
 *    tripwire for that state — `ensureSearchExtensions` lives outside the migrator, so
 *    "migrated but no `pg_trgm`" is a state no test can catch and only a real deployment can
 *    report.
 *  • a KEK fault, or a production deployment with no build identity ⇒ **503** with the
 *    reason. Neither darkens the host (`/health` is the only thing that can TELL an operator
 *    the KEK is wrong), but neither may be reported as healthy.
 *
 * **One round trip.** The `SELECT 1`, the `pg_trgm` probe and the schema probe are the SAME
 * statement, so `dbLatencyMs` is a genuine measurement of one query and a probe never costs
 * more than one. `to_regprocedure('word_similarity(text,text)')` is deliberately the SAME
 * check `SearchService.hasTrgm` uses — it asserts the FUNCTION the fuzzy arm calls is
 * resolvable, which is a stronger claim than a row in `pg_extension`.
 *
 * **`cookieAuth` reports the cookie/bearer host split for THIS request** — `true` when the hostname the
 * request arrived on is a cookie surface (`api.ohmail.app` behind the webapp's rewrite),
 * `false` on the bearer-only surfaces (`api.ohmail.app`, the deployment URL, anything
 * unrecognised). One deployment serves both, so the flag is a property of the REQUEST, and
 * without it the only way to find out which side a host landed on is to attempt a login and
 * watch it silently not stick. It echoes no allow-list and no configuration — just the verdict
 * a caller could determine anyway by presenting a cookie — and it is what makes the DNS flip
 * verifiable in one `curl`.
 *
 * **`alertSinks` / `alertPasses` are the worker's boot announcement in this host's idiom.** The
 * worker names its pager arms in its startup line and warns when there is exactly one; a
 * serverless host has no startup line, so until now the per-arm delivery health lived only on
 * the authenticated `/internal/alerts` response — and this host is the ONLY observer of a dead
 * worker, so its arms going quiet is the version of the fault that coincides with the outage
 * they exist to report. Same key, same shape and the same closed codes the worker publishes, so
 * the two are a literal JSON diff. Names, codes and counts only: a sink's own error sentence is
 * unbounded vendor text and stays in the log line. See `HealthConfig.alertSinks`, and
 * `AlertSinkSummary.passes` for why the counts are published with an instance-scoped pass count
 * beside them.
 *
 * **Nothing else environmental is echoed.** `kek` is the ring IDENTITY from
 * `kekEnvIdentity()` — a fingerprint plus two integers, never key material — and it is the
 * same object the worker publishes, nested under the same `kek` key on both hosts, so
 * comparing them is a literal JSON diff. A database error is reported as a fixed
 * `database_unreachable` plus the driver's error CODE; the driver's message can carry the
 * host and role from the connection string and is therefore never forwarded.
 */

/**
 * The columns whose presence means "this database carries THIS application's schema".
 *
 * Deliberately `(table, column)` pairs and not a table-name list: a column is what a query
 * actually reads, and a migration that only ALTERs (`0017_enrollment` added `sessions.scope`)
 * is invisible to a table-only probe. The set covers the tables every request path touches
 * plus the newest migration's own marker, so a virgin database, a half-applied migration run,
 * and a database from BEFORE the current release all fail it.
 *
 * {@link MAIL_SCHEMA_MARKER_JOURNAL_TAG} and {@link CLOUD_SCHEMA_MARKER_JOURNAL_TAG} pin which
 * migration each half's list was last reconciled against, and a test asserts each is still the
 * newest entry in ITS OWN journal. That is what stops these lists from silently
 * ageing — it is why `0018_billing` could not land without someone deciding what its marker is
 * (the billing ledger's dedup identity, chosen because it is the column the
 * metering paths actually write through). After the split it also means a migration added to one
 * journal cannot be excused by the other journal's tag being current.
 *
 * **Deployment ORDER is a consequence, not a detail.** An API build carrying a new marker
 * answers `503 schema_incomplete` against a database that has not run the matching migration.
 * The migration runner must therefore reach the target database BEFORE that build deploys — it
 * picks up new journal entries automatically and verifies them entry-by-entry, per journal.
 */
export type SchemaMarker = readonly [table: string, column: string];

/**
 * ── SPLIT BY JOURNAL (stage 3), because the two halves now fail INDEPENDENTLY ──
 *
 * The database package's single migration journal became two: the mail-domain journal
 * (bookkeeping in `drizzle_mail`) and the hosted-service journal (bookkeeping in
 * `drizzle_cloud`), which a local install never runs. Two journals
 * are two transactions, so **mail-committed / cloud-failed is a reachable state** — and it is
 * exactly the state this probe must report honestly. A single flat marker list would still catch
 * it (a missing cloud column is a missing marker either way); what it could not do is stay
 * anchored, because "the newest migration" is now two facts, and one list pinned to one tag ages
 * silently against the other half.
 *
 * So the list is two lists, each pinned to the newest entry of ITS OWN journal, and each asserted
 * against that journal by a test. The exported {@link SCHEMA_MARKERS} is their
 * concatenation — the probe SQL, the totals and the published body are computed from it, so the
 * split changed the bookkeeping and nothing a caller can see. No count is written down here on
 * purpose: {@link EXPECTED_MARKERS} derives it, and a number in prose ages the moment a
 * migration lands.
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
  // mail 0023_mailbox_failure_reason — WHY a mailbox failed. One marker for four columns, on
  // the usual rule: probe the column a QUERY actually reads, and `error_code` is the one both
  // `MailboxService.toDTO` and the admin console project.
  //
  // It earns a marker for a reason the other entries do not share. Nothing on this table is
  // read to make a DECISION, so an absent column cannot mis-route mail — but
  // `MailboxService.list` selects WHOLE ROWS, so an API deployed ahead of this migration
  // answers Postgres 42703 on the mailbox panel and on the connect flow, and Vercel serves
  // that traffic whatever `/health` says. The marker does not gate the traffic; it makes the
  // deployment name the missing migration instead of leaving a 500 nobody can attribute. It is
  // the NEWEST entry in the mail journal.
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
  // mail 0026_thread_resolution — the conversation's root Message-ID, and the find-or-create
  // conflict anchor threading at ingest is built on. One nullable column on
  // `threads`, and it earns a marker for the `mailboxes.error_code` reason: nothing reads it to
  // make a product decision, but `materializeThread` reads `select().from(threads)`, which
  // drizzle expands into an explicit column list from the TS schema — so an API deployed ahead
  // of this migration answers Postgres 42703 on `GET /threads/:id` and on every `/sync` page
  // that materializes a thread, which is the read path the whole slice exists to populate.
  //
  // Its companion unique index `threads_account_root_header_uq` is deliberately NOT in
  // `SCHEMA_INDEX_MARKERS`. `mailboxes_active_address_uq` is there because its absence is
  // SILENT; this one's absence makes `ON CONFLICT (account_id, root_message_id_header)` raise
  // 42P10 on the first message ingested, so there is no false positive for a marker to catch.
  ["threads", "root_message_id_header"],
  // mail 0027_organizer_lease — the two columns the organizer lease needs, so that exactly one
  // installation organizes a mailbox at a time. One marker for both, on `disabled_reason`, and it
  // earns one for the `mailboxes.error_code` reason plus a sharper one of its own.
  //
  // The generic half: `MailboxService.list` selects WHOLE ROWS through the drizzle schema, so an
  // API deployed ahead of this migration answers Postgres 42703 on the mailbox panel and on the
  // connect flow. The sharper half: the WORKER writes this column at every stand-down, and a
  // worker deployed ahead of the migration cannot record WHY it stopped organizing a mailbox —
  // it would disable the mailbox and leave the reason nowhere, which is precisely the opaque
  // state 0023 exists to end. The deploy order is migration → API → worker for that reason, and
  // this marker is what makes getting it wrong say so. It is the NEWEST entry in the mail
  // journal.
  ["mailboxes", "disabled_reason"],
  // mail 0028_message_instances — PHYSICAL identity, the set of IMAP locators one logical message
  // occupies. One marker for the whole table, on `is_primary`, which is the column
  // every query here filters on: the primary lookup, the vanished-primary probe that decides whether
  // a placement may be adopted, and the join `listKnownLocators` builds the known-set from.
  //
  // It earns a marker for BOTH reasons on this list. The generic one: `MessageService` selects whole
  // rows through the drizzle schema, so an API deployed ahead of this migration answers Postgres
  // 42703 wherever the schema is expanded. The sharper one is the WORKER's: without the table
  // `listKnownLocators` 42P01s on every sync cycle, which stops ingest for every mailbox — and
  // `primaryInstanceVanished` is what supplies the adoption evidence, so a partially-migrated
  // database is one where the consent boundary cannot be evaluated at all. That has to be a loud
  // 503 naming the migration, never a cycle that quietly decides it has no evidence. It was the
  // newest entry in the mail journal until 0029 landed below — the marker stays, because a marker
  // earns its place by naming a column a query reads, not by being last.
  ["message_instances", "is_primary"],
  // mail 0029_mailbox_sync_block — WHY a `connected` mailbox is not being synced. One marker for
  // both columns, on `sync_blocked_reason`, and it earns one for the generic reason plus the
  // sharpest version yet of the worker's.
  //
  // The generic half, as for every `mailboxes` column on this list: `MailboxService.list` selects
  // WHOLE ROWS through the drizzle schema, so an API deployed ahead of this migration answers
  // Postgres 42703 on the mailbox panel and on the connect flow.
  //
  // The sharp half: THE WORKER IS THE ONLY WRITER OF THIS COLUMN, and the column exists to end a
  // 32-minute silence. A worker deployed ahead of the migration fails every one of those writes —
  // best-effort by design, so it logs and keeps syncing — and the observable result is that a
  // mailbox nothing is serving reads as a healthy `connected` mailbox: the exact defect this
  // migration was written to remove, reintroduced by a deploy-ordering mistake and invisible in the
  // product. The deploy order is migration → API → worker; this marker is what makes getting it
  // wrong say `503 schema_incomplete` and name the migration.
  ["mailboxes", "sync_blocked_reason"],
  // mail 0030_sensitive_rescreen — the marker for the one-time re-evaluation of mail that the
  // pipeline's sensitivity override had already misrouted into the Ohbox. The override applied
  // before the sender was checked against `contacts`, so most of what it caught was ordinary mail
  // from senders the account had never corresponded with.
  //
  // It earns a marker for the generic `mailboxes` reason and ONLY that one, which is worth saying
  // plainly because every entry above it since 0027 has also carried a worker-side argument and
  // this one deliberately does not: `MailboxService.list` selects WHOLE ROWS through the drizzle
  // schema, so an API deployed ahead of this migration answers Postgres 42703 on the mailbox
  // panel and on the connect flow. There is no worker half — the pass lives in
  // `packages/services`, which the sync worker is forbidden by its own dependency test from
  // importing, so no worker binary reads or writes this column and no worker-first deploy can get
  // it wrong. The deploy order is migration → API. It is the NEWEST entry in the mail journal.
  ["mailboxes", "sensitive_rescreen_at"],
  // mail 0031_tags — TAGS, the account's own labels keyed by message. TWO markers, one per
  // new table, and the pair is deliberate rather than the usual one-marker-per-migration.
  //
  // `tags.id` alone would not catch the failure that actually matters. The two tables are created
  // by separate statements, and it is `message_tags` that the SYNC path reads on every page:
  // `materializeMessages` now issues a fourth query against it to fill `MessageDTO.labels`. An API
  // deployed against a database that has `tags` but not `message_tags` would therefore answer
  // Postgres 42P01 on every message list and every `/sync` drain — not a tag-shaped degradation, a
  // total one, because the batch materializer is the single path every view's messages come
  // through. Probing only the parent table would let exactly that database report healthy.
  //
  // `message_tags.tag_id` is the column probed rather than `message_id`, because it is the one
  // carrying the FK to the table created in the same migration: a catalog where that column exists
  // is one where both `CREATE TABLE`s ran.
  //
  // The deploy order is migration → API, with no worker half at all — nothing in the sync worker
  // reads or writes either table, and nothing here opens an IMAP connection, because a tag is
  // ours and is never an IMAP folder. It is the NEWEST entry in the mail journal.
  ["tags", "id"],
  ["message_tags", "tag_id"],
  // mail 0033_workflow_run_claim — WHEN the `running` claim was last asserted, which is what lets
  // a crashed run be reaped and resumed.
  //
  // The generic reason for a marker is that a query would 42703; the sharp reason here is WHO
  // swallows it. The reaper's claim `UPDATE` names this column, so a WORKER deployed ahead of the
  // migration raises 42703 on every drain — and the cycle's per-account `try/catch` catches it,
  // logs one line under a workflow-shaped name, and carries on. Workflow automation would simply
  // stop, silently, with nothing attributing it to a migration. This marker turns that into a
  // deployment that refuses and names the file to run.
  //
  // Deploy order is migration → API → worker, the same order `0027_organizer_lease` states above
  // and for the same reason.
  ["workflow_runs", "claimed_at"],
  // mail 0034_rule_retro — the four columns that make a new rule reach mail already on disk.
  // ONE marker, and `retro_requested_at` is the column because it is the one a QUERY
  // reads: it is written by `RulesService.create` on the DEFAULT path — retroactive apply is the
  // product's default, not an option the user has to find — and it is the whole of the worker
  // pass's owed-work predicate.
  //
  // `materializeRule` and `RulesService.list` select WHOLE ROWS through the drizzle schema, so an
  // API deployed ahead of this migration answers Postgres 42703 on every rule creation and on the
  // entire rules surface, which is now a default-on path rather than a corner of Settings. Unlike
  // 0030 there IS a worker half — the retro pass in the sync worker reads and writes all four
  // columns — so the deploy order is migration → API → worker, and a worker running ahead of the
  // migration fails its owed probe per account, moves no mail and marks nothing.
  //
  ["rules", "retro_requested_at"],
  // mail 0035_account_settings — per-account settings, the first durable home for a preference.
  // ONE marker, and `seed_confirmed_at` is the column because it is the one a QUERY reads: the
  // onboarding surface asks "has this account been through the sent-mail seed review?" on every
  // load, and the seed's own confirm writes it.
  //
  // The whole table is new, so an API deployed ahead of this migration answers Postgres 42P01 —
  // relation does not exist — on the consent surface rather than a missing-column error, and the
  // drizzle schema selects whole rows, so it fails for reads as well as writes. There is no
  // worker half: nothing in the sync loop reads this table, so the deploy order is the ordinary
  // migration → API, with no third step to get wrong.
  //
  // A marker on a NULLABLE column is deliberate and is the same choice `0025_mailbox_kickstart`
  // made: the probe asks whether the COLUMN EXISTS, never whether anything has been written to
  // it. Every account starts with no row at all, and that is the correct state.
  //
  ["account_settings", "seed_confirmed_at"],
  // mail 0036_sensitive_fp_backfill — the one-shot marker for repairing the bodies a classifier
  // FALSE POSITIVE stored redacted, with their sender HTML thrown away. One nullable column on
  // `mailboxes`, and it earns a marker for the generic reason plus a worker one.
  //
  // The generic half, as for every `mailboxes` column on this list: `MailboxService.list` selects
  // WHOLE ROWS through the drizzle schema, so an API deployed ahead of this migration answers
  // Postgres 42703 on the mailbox panel and on the connect flow — a total failure of that surface
  // caused by a column nothing on it reads.
  //
  // The worker half, which `0030_sensitive_rescreen` explicitly did NOT have: that pass is
  // CLI-only and reads stored rows, so no worker binary ever touched its column. This one lives
  // in the worker's cycle, because repairing a body means re-reading the message from the mail
  // server and only the worker holds a connection to it. So a worker deployed ahead of the
  // migration raises 42703 on the marker read, logs it per mailbox and repairs nothing — no
  // damage, but also no repair, and nothing that would attribute the silence to a deploy order.
  // The order is migration → API → worker.
  //
  ["mailboxes", "sensitive_fp_backfill_at"],
  // mail 0037_draft_html — the rich half of a draft. One nullable column on `drafts`, and it
  // earns a marker on the generic rule with a second consumer that makes it sharper than the
  // `mailboxes` entries above.
  //
  // The generic half: `materializeDraft` selects the row through the drizzle schema, so an API
  // deployed ahead of this migration answers Postgres 42703 on every draft read. The sharper
  // half is that `SendService.reserve` reads the SAME row to build the envelope, so the failure
  // is not confined to a panel nobody has open — compose and reply both stop being able to send
  // at all, from a column that a plain-text send never looks at. That is a deployment which must
  // name the missing migration rather than 500 on the one action the product exists to perform.
  //
  // No worker half: nothing in the sync worker reads or writes `drafts`. The order is migration →
  // API, with no third step to get wrong.
  ["drafts", "html"],
  // mail 0045_draft_bcc — the Bcc recipients of a draft. One jsonb column on `drafts`, the twin of
  // `cc`, and it earns a marker for the same sharper reason `html` does. `materializeDraft` selects
  // the whole row through the drizzle schema (42703 on every draft read ahead of the migration),
  // and `SendService.reserve` reads the SAME row to build the envelope — so a stale database takes
  // out compose and reply both, from a column a bcc-less send never looks at. The order is
  // migration → API, no worker half.
  ["drafts", "bcc"],
  // mail 0038_initial_import_completed — WHEN a mailbox's first import actually finished: the
  // per-mailbox floor the client reads as `IS NULL ⇒ still importing`. One nullable column on
  // `mailboxes`, and it earns a marker for the generic reason plus a worker one.
  //
  // The generic half, as for every `mailboxes` column on this list: `MailboxService.list` selects
  // WHOLE ROWS through the drizzle schema, so an API deployed ahead of this migration answers
  // Postgres 42703 on the mailbox panel and on the connect flow.
  //
  // The worker half: the sync worker stamps this column on the first no-backlog cycle, so a
  // worker deployed ahead of the migration raises 42703
  // on the write. It is best-effort inside the cycle's success path and never fails the cycle, so
  // nothing is lost — no stamp is written and the first no-backlog cycle after the migration does
  // the whole job. The order is migration → API → worker.
  //
  // The order is migration → API → worker.
  ["mailboxes", "initial_import_completed_at"],
  // mail 0039_mailbox_retry_after — WHEN the leader may next attach a quarantined mailbox, made
  // durable so somebody other than the worker can change the answer. One nullable column on
  // `mailboxes`, and it earns a marker for the generic reason plus a worker one, with the
  // deploy order REVERSED from its neighbour above.
  //
  // The generic half, as for every `mailboxes` column on this list: `MailboxService.list` selects
  // WHOLE ROWS through the drizzle schema, so an API deployed ahead of this migration answers
  // Postgres 42703 on the mailbox panel and on the connect flow.
  //
  // The worker half, and why the order is migration → WORKER → API rather than the 0038 shape:
  // the worker is the column's only writer AND its only reader-for-a-decision, and the API deploy
  // is the one that flips `resync_mailbox` to `available: true` in the actions catalog. That flag
  // is a public claim — an operator clicking release against a worker that does not yet honour
  // the column would get a button reporting success it cannot achieve. So the worker must be able
  // to obey before the console offers the button. A worker deployed ahead of the migration fails
  // the write, logs it and falls back to the in-memory backoff, which is the pre-0039 behaviour
  // exactly; that is what the runtime `persisted` flag is for and why this is not a crash.
  //
  // No CHECK marker, on 0030's rule (a timestamp closes no set), and no INDEX marker: the column
  // is read per mailbox on a roster pass that has the row in hand, never filtered on.
  //
  ["mailboxes", "retry_after"],
  // mail 0040_auto_suggest — the auto-suggest opt-in, one nullable column on `account_settings`.
  //
  // It earns a marker for the whole-row-select reason and for nothing else. `consentSettings`
  // (`services/src/consent-seed.ts`) does a bare `select().from(accountSettings)`, so drizzle
  // enumerates every column this schema knows about: an API deployed AHEAD of the migration
  // answers Postgres 42703 on `GET /consent`, which the app shell fetches once per tab. The
  // failure is therefore the consent surface, not the one feature the column is for — the same
  // shape as `rules.retro_requested_at` above, and the reason a nullable column nobody has
  // written to still owes a probe.
  //
  // There is NO worker half. Nothing in the sync loop reads `account_settings`, and the flag's
  // only consumer is the Screener surface in a browser, so the deploy order is the ordinary
  // migration → API with no third step. A webapp deployed ahead of the API simply never sees the
  // field and reads absent as OFF, which is the default it would have taken anyway.
  //
  // No CHECK marker (0030's rule: a timestamp closes no set) and no INDEX marker: the column is
  // read off a row already fetched by primary key, and nothing filters on it.
  //
  ["account_settings", "auto_suggest_at"],
  // mail 0041_message_failures — the DURABLE per-message failure ledger, which is what makes a
  // message the sync loop could not ingest recoverable instead of lost. A whole new table, so a
  // database missing it answers Postgres 42P01 (relation does not exist) rather than 42703.
  //
  // `next_attempt_at` is the column probed rather than `uid` or `code`, on this list's usual rule:
  // probe the column a QUERY actually reads to make a decision. The retry probe's whole predicate
  // is `resolved_at IS NULL AND (next_attempt_at <= now() OR attempted_version IS DISTINCT FROM
  // <build>)`, and a catalog where that column exists is one where the CREATE TABLE ran.
  //
  // The WORKER half is the sharp one and it is unlike every other entry above. The worker is this
  // table's only reader and only writer, and its terminal-skip path treats a failed durable write
  // as a REFUSAL TO SKIP — the folder's cursor is held and the cycle fails. So a worker deployed
  // ahead of the migration does not lose mail; it stops organizing the mailbox and quarantines it
  // loudly, which is a visible outage rather than a silent one. That is the correct direction and
  // it is the entire reason the write is not best-effort, but it is still an outage, so the deploy
  // order is migration → API → worker and this marker is what makes getting it wrong say
  // `503 schema_incomplete` and name the file to run.
  //
  // The API half is the generic one, and it is weak on purpose: nothing in `packages/api` reads or
  // writes this table, and nothing may — a staff read of these rows is a delivery oracle (see the
  // schema's own note). The marker is here because `/health` is the deployment's own statement about
  // whether the schema it was built against is present, and a table only the worker touches is
  // exactly the kind that goes missing unnoticed.
  //
  // No INDEX marker: the partial `message_failures_due_idx` is a cost object, and its absence makes
  // the retry probe slow rather than wrong, which `SCHEMA_INDEX_MARKERS` explicitly reserves itself
  // for the opposite of (`mailboxes_active_address_uq` is there because its absence is SILENT). No
  // CHECK marker either, and this one is a closer call than 0030's rule: `message_failures_code_closed`
  // IS a privacy boundary, so it would qualify on `mailboxes_disabled_reason_closed`'s reasoning —
  // but it is created INSIDE the `CREATE TABLE`, so a database that has the table has the CHECK, and
  // the column marker above already covers both. A separate marker could only ever fail together
  // with it.
  //
  // It is the NEWEST entry in the mail journal.
  ["message_failures", "next_attempt_at"],
  // mail 0042_screening_preference — the editable Ohbox preference. Two additive nullable columns on
  // `account_settings`, and it earns a marker for the whole-row-select reason — the same shape as
  // `account_settings.auto_suggest_at` (0040) one feature over.
  //
  // `ohbox_policy` is the column probed rather than `ohbox_bar`, on this list's usual rule: probe the
  // column a QUERY reads to make a DECISION. The worker resolves this column per account and threads
  // it into the routing engine, so a database missing it makes the screening-preference read
  // 42703 — and `consentSettings`/`getScreeningPreference` do a bare `select().from(accountSettings)`,
  // so drizzle enumerates every column this schema knows about and the CONSENT surface, not just this
  // feature, is what fails. There is no worker half in the same sense as 0041: the worker READS the
  // column but a read that 42703s degrades to the lenient default (absent-config-selects-safe), so a
  // worker ahead of the migration organises mail under `people_and_replied` rather than crashing —
  // the safe direction. The API is where the whole-row select bites, so the deploy order is the
  // ordinary migration → API.
  //
  // No CHECK marker (0030's rule: an enum/length CHECK closes a set the column marker already implies)
  // and no INDEX marker: the row is fetched by primary key and nothing filters on either column.
  ["account_settings", "ohbox_policy"],
  // mail 0043_ohbox_tidy — the resumable, re-armable marker for the Ohbox backlog re-route pass.
  // Three additive nullable columns on `account_settings`, and it earns a marker for the same
  // whole-row-select reason as 0040/0042 one and two features over.
  //
  // `ohbox_tidy_requested_at` is the column probed rather than the other two, on this list's usual
  // rule: probe the column a QUERY reads to make a DECISION. `requested_at IS NOT NULL` is half the
  // owed predicate the worker evaluates every cycle. The API reaches all three through the bare
  // `select().from(account_settings)` that `getScreeningPreference` issues, so a database missing
  // them 42703s the SCREENING surface, not just this feature. The worker half is the safe kind: a
  // worker ahead of the migration fails its owed probe on the missing column, so no mail moves and
  // nothing is marked — visible, not silent. Deploy order: migration → worker (and API).
  //
  // No CHECK marker (0030's rule); the INDEX this migration also creates is on `change_log`, not
  // here, and joins `SCHEMA_INDEX_MARKERS` below because its absence is SILENT. It was the newest
  // mail entry until 0044 added the dormancy-dial ceiling — whose marker is a CHECK, so it lives in
  // `SCHEMA_CHECK_MARKERS` rather than here, and `MAIL_SCHEMA_MARKER_JOURNAL_TAG` moved to it.
  ["account_settings", "ohbox_tidy_requested_at"],
  // mail 0046_screener_auto_apply — the opt-in Screener auto-apply flag. One additive nullable
  // column on `account_settings`, and it earns a marker for the same whole-row-select reason as
  // `auto_suggest_at` (0040) three features over: `consentSettings` and `getScreeningPreference`
  // reach this row, so a database missing the column 42703s the CONSENT and SCREENING surfaces, not
  // just this feature. The worker READS the column every cycle (the opt-in probe of the auto-apply
  // pass), but a read that 42703s degrades to OFF (absent-config-selects-safe), so a worker ahead
  // of the migration moves nothing — the safe direction. Deploy order: migration → API (and worker).
  //
  // No CHECK marker (0030's rule: a timestamp closes no set) and no INDEX marker: read off a row
  // fetched by primary key, never filtered on. It was the NEWEST entry in the mail journal until
  // 0047 added the read-order column below.
  ["account_settings", "screener_auto_apply_at"],
  // mail 0047_read_order — WHEN a message stopped being unread, which is what the client's
  // "Earlier" group is sorted by. One additive nullable column on `messages`.
  //
  // It is the STRONGEST whole-row-select case on this list, and that is why a column whose only
  // consumer is a client-side sort is here at all. `messages` is projected through
  // `select().from(messages)`, so drizzle enumerates every column this schema knows about on the
  // message list, the single read, the delta feed and the bootstrap snapshot alike. An API
  // deployed ahead of this migration therefore answers Postgres 42703 on the ENTIRE read surface —
  // every view empty, every sync drain failing — from a column no view actually reads. Every other
  // whole-row entry above takes out one panel; this one takes out the mail.
  //
  // No worker half: nothing in the sync worker reads or writes it. The flag adoption that stamps
  // it on an externally-set `\Seen` runs in the same process as the API's own writers, through the
  // same schema. Deploy order: migration → API.
  //
  // No CHECK marker (0030's rule: a timestamp closes no set) and no INDEX marker — deliberately,
  // and stated here rather than left to be inferred. Nothing filters or pages on the column: the
  // sort runs on the client over the window it already holds, and the server's keyset stays
  // `(date, id)`. A permanent index maintained by every read of every message, serving no query,
  // is a write cost with no reader.
  ["messages", "last_read_at"],
  // mail 0048_remote_images_default — the remote-images OPT-OUT. One additive nullable column on
  // `account_settings`, and it earns a marker for the same whole-row-select reason as
  // `auto_suggest_at` (0040) and `screener_auto_apply_at` (0046): `consentSettings` does
  // `select().from(accountSettings)`, so an API deployed ahead of the migration answers Postgres
  // 42703 on `GET /consent` AND on `PATCH /consent/settings` — the whole consent surface, which
  // onboarding runs through, not just this feature.
  //
  // No worker half: nothing in the sync worker reads or writes it. Deploy order: migration → API.
  //
  // No CHECK marker (0030's rule: a timestamp closes no set) and no INDEX marker — the column is
  // read off a row fetched by primary key and nothing filters on it.
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
  // mail 0049_mailbox_sync_requested_at — the enforced-sync doorbell. One additive nullable
  // timestamptz on `mailboxes`, and it earns a marker on the whole-row-select rule its OWN
  // migration already states: *"`MailboxService.list` selects whole rows, so
  // `["mailboxes","sync_requested_at"]` joins the mail schema markers for a clean 503 on a too-early
  // API."* It was not added when the migration landed, so the marker list, the tag below and four
  // censuses in `packages/db/test` were all stale on the default branch at once — recorded in
  // `journal-split.test.ts`'s `0049` census entry rather than quietly fixed.
  //
  // The API also WRITES this column beside the send/move finalize, but that write is deliberately
  // best-effort and caught, so the failure a too-early API produces is not the stamp — it is
  // `select().from(mailboxes)` answering 42703, which takes out the mailbox list and every read that
  // resolves a mailbox. That is the whole-row case, and it is why the marker is the column a query
  // ENUMERATES rather than the one a feature reads.
  //
  // The worker half is the safe kind: a worker ahead of the migration fails its kick scan on the
  // missing column, so no out-of-band cycle runs and the product falls back to poll-only latency —
  // visible, not silent. Deploy order: migration → API → worker.
  //
  // No CHECK marker (0030's rule: a timestamp closes no set) and no INDEX marker — the scan is a
  // short `IS NOT NULL` probe over a table with one row per connected mailbox.
  ["mailboxes", "sync_requested_at"],
  // mail 0050_rule_subject_contains — the second term on a sender rule. One additive nullable text
  // column on `rules`, and it is the SECOND-strongest whole-row case on this list after
  // `messages.last_read_at`, for a reason worth stating: `rules` is read by
  // `select().from(rules)` in BOTH halves of the product. `materializeRule` serves `GET /rules`, the
  // rule DTO on every `/sync` delta and the 201 of every rule the sender sheet writes; and
  // `drizzle-repo.ts#listRules` is what the ROUTER consults on arrival. So an API deployed ahead of
  // this migration answers 42703 on the rules surface AND makes every routing decision fail — not a
  // panel, the organizing.
  //
  // The worker reads the column through the same `listRules`, and there the failure is NOT the safe
  // kind: a retro pass or an ingest that 42703s stops filing mail rather than degrading to a
  // lenient default. Deploy order is therefore migration → API → worker, and the migration arrow is
  // load-bearing for once.
  ["rules", "subject_contains"],
  // mail 0052_away_responder — the responder's `audience` column, and it is the SHARPEST kind of
  // marker on this list: a column whose absence would not merely 42703 a surface, it would 42703
  // the surface that CONFIGURES an outbound-mail feature.
  //
  // `AwayResponderService` does `select().from(awayResponders)` and its `put` returns the inserted
  // row, so both `/away-responder` endpoints go dark on an API deployed ahead of the migration —
  // meaning somebody who is already away cannot turn their responder OFF, which is the one direction
  // of that control that is urgent. `audience` is probed rather than the new table, on this list's
  // usual rule: probe the column a QUERY reads to make a DECISION, and this is the column that
  // decides whether a stranger gets answered.
  //
  // The WORKER half is the third deploy step and the safe kind: the pass reads this row and writes
  // `away_responder_sent`, so a worker ahead of the migration throws 42703/42P01 inside the pass,
  // which its own try/catch logs — no reply is sent, which is the direction to fail. Deploy order:
  // migration → API → worker.
  //
  // No INDEX marker (the two indexes this migration creates are on the new table, whose absence is
  // a loud 42P01 inside the pass and not a silent slowdown) and no CHECK marker, even though
  // `away_responders_audience_closed` is exactly the kind of constraint 0029 and 0037 earned one
  // for. The reason is that this CHECK cannot be half-applied in a way anybody would survive: the
  // column arrives NOT NULL with a DEFAULT in the statement before it, so a database that took the
  // column and not the CHECK still resolves every existing and every new row to `screened_in` — the
  // NARROW member — and the service's own closed-set validator refuses the other one at the
  // boundary. A missing CHECK here costs a defence in depth, not an audience.
  ["away_responders", "audience"],
  // mail 0052_rule_body_contains — the third term on a sender rule. One additive nullable text
  // column on `rules`, and the whole-row case is 0050's verbatim, because it is the SAME
  // `select().from(rules)` in both halves: `materializeRule` (the rules surface, the `/sync`
  // delta, the 201) and `drizzle-repo.ts#listRules` (what the router consults on arrival) both
  // enumerate the table, so a too-early API 42703s the surface AND stops the organizing. The
  // worker half is likewise NOT the safe kind — a routing read that 42703s stops filing mail —
  // so the order stays migration → API → worker with the first arrow load-bearing.
  ["rules", "body_contains"],
  // mail 0053_account_locale — the interface language. One additive nullable text column on
  // `account_settings`, and it earns a marker for the same whole-row-select reason as
  // `auto_suggest_at` (0040), `screener_auto_apply_at` (0046) and `block_remote_images_at` (0048):
  // `consentSettings` does `select().from(accountSettings)`, so an API deployed ahead of the
  // migration answers Postgres 42703 on `GET /consent` AND on `PATCH /consent/settings` — the whole
  // consent surface, which onboarding runs through, and which the mail client calls once per tab.
  // The cost of the 42703 is therefore not "the language setting is unavailable"; it is that the
  // dormancy window, the auto-suggest flag and the remote-images opt-out all stop arriving, and the
  // client falls back to its safe resting values on every load.
  //
  // No worker half: nothing in the sync worker reads or writes it. Deploy order: migration → API.
  //
  // A CHECK marker as well, unlike the three timestamps beside it, and the difference is 0030's
  // rule read the right way round: a timestamp closes no set, but this column DOES close one, and
  // it closes it over free text. See `account_settings_locale_supported` below.
  ["account_settings", "locale"],
  // mail 0054_auto_unsubscribe_optout — the switch for auto-unsubscribe on screen-out, stored as
  // the opt-out. The fifth `account_settings` marker, on the whole-row-select argument every one
  // above it makes: `consentSettings` does `select().from(accountSettings)`, so an API deployed
  // ahead of the migration answers Postgres 42703 on `GET /consent` AND on `PATCH
  // /consent/settings` — the entire consent surface, not merely this switch.
  //
  // It is sharper than the three timestamps beside it in one respect worth naming, because it is
  // the reason this marker is not optional: `UnsubscribeService.onScreenOut` reads this column in
  // the same request that decides whether to send a one-click unsubscribe. A too-early API would
  // throw 42703 there — inside a path whose whole contract is that it never throws at its caller,
  // so the screen-out would still commit and the read would be swallowed as a skip. That failure
  // is silent by construction; the 503 in front of it is what makes it loud.
  //
  // No worker half: nothing in the sync worker reads or writes it. Deploy order: migration → API.
  //
  // No CHECK marker (0030's rule: a timestamp closes no set) and no INDEX marker — the column is
  // read off a row fetched by primary key and nothing filters on it.
  ["account_settings", "block_auto_unsubscribe_at"],
  // mail 0055_mailbox_smtp_max_size — what the sending server said it will accept (RFC 1870 `SIZE`),
  // recorded per mailbox by the connect-time SMTP probe. One additive nullable `bigint` on
  // `mailboxes`, and it earns a marker on the same whole-row-select rule `sync_requested_at` (0049)
  // does one column over — but with a second reader that makes it sharper than the mailbox list.
  //
  // `MailboxService.list` does `select().from(mailboxes)`, so a too-early API 42703s the mailbox
  // panel and every read that resolves a mailbox. `SendService.reserve` enumerates the row too, in
  // the transaction that reserves an idempotent send — so the same missing column takes out SENDING,
  // and it does so BEFORE the reservation commits, which is the safe half of an unsafe failure: the
  // user cannot send, and no draft is stranded out of `draft` while they cannot.
  //
  // No worker half: nothing in the sync worker reads or writes it. Deploy order: migration → API.
  //
  // No CHECK marker (a size closes no set — 0030's rule, and the positivity that matters is applied
  // where the value is read) and no INDEX marker: the column is read off a row already fetched by
  // primary key and is never a predicate.
  ["mailboxes", "smtp_max_size_bytes"],
  // mail 0056 — `account_settings.screening_baseline_at`, the instant the dormancy window is
  // measured back from. It earns a marker on the whole-row-select rule the four flags above it
  // follow: `consentSettings` does `select().from(account_settings)`, so an API ahead of the
  // migration answers Postgres 42703 on `GET /consent` — the route the shell fetches at boot to
  // learn the window it partitions the mirror with. Without a marker that is a client that renders
  // its Screener over the raw mirror and cannot say why.
  //
  // The WORKER reads the same column to resolve the router's cutoff, and a worker ahead of the
  // migration degrades to "no cutoff" (`screeningFor` catches the read and returns the lenient
  // value without caching it), which is the pre-0056 routing — the safe direction, and the same
  // absent-config-selects-safe rule `ohbox_policy` states.
  //
  // No CHECK marker: any instant is a legal baseline (0040's rule). No INDEX marker: read off a
  // row already fetched by primary key, never a predicate.
  ["account_settings", "screening_baseline_at"],
  // mail 0057_message_from_name — the From header's display name, the sender's half of the
  // recipients repair (`to_addresses`/`cc_addresses` carry theirs inside the jsonb pairs). One
  // additive nullable text column on `messages`, and it earns a marker on the whole-row-select
  // rule at its widest reach: `materializeMessages` and the single message read select whole
  // `messages` rows, so an API deployed ahead of the migration answers Postgres 42703 on the
  // message list, the single read, the delta feed AND the bootstrap snapshot — the entire mail
  // surface, not one panel.
  //
  // The WORKER half is not the safe kind, deliberately: `insertMessage` names the column
  // unconditionally, so a worker ahead of the migration fails ingest with the same 42703 into
  // the cycle's ordinary quarantine — loud — rather than silently dropping the name, which is
  // the defect the column exists to end. Deploy order: migration → API → worker.
  //
  // No CHECK marker (a sender-chosen display name closes no set) and no INDEX marker: the column
  // is projected off rows already fetched by primary key or by the existing `from_address`
  // indexes, and it is never a predicate.
  ["messages", "from_name"],
  // mail 0058_reconcile_backoff — the reconciler's bounded retry. FOUR columns land (`attempts`
  // and `next_attempt_at` on both `folder_state` and `flag_state`) and one marker probes them, on
  // this list's usual rule: probe the column a QUERY reads. `next_attempt_at` on `folder_state` is
  // the one the pending-move query filters on, and the four are created by a single migration
  // inside a single transaction, so no state exists in which one is present and another is not.
  //
  // It earns a marker for the widest form of the whole-row-select argument: `materializeMessages`
  // does `select().from(folder_state)` for the message list, the single read and the bootstrap
  // snapshot, so an API deployed ahead of this migration answers Postgres 42703 across the mail
  // surface. The marker makes that a 503 naming this file rather than an unattributable 500.
  //
  // The WORKER half is loud too: the reconcile pass filters and writes both columns, so a worker
  // ahead of the migration 42703s into the cycle's ordinary quarantine instead of silently filing
  // nothing. Deploy order: migration → API → worker.
  //
  // No CHECK marker (any instant is a legal next attempt, and `attempts` closes no set — it is a
  // count). No INDEX marker: the migration deliberately adds none, because the predicate joins a
  // scan that is already bounded by one mailbox's pending set.
  ["folder_state", "next_attempt_at"],
  // mail 0059_pairing_tokens — the pairing-token lifecycle's table, one marker for a whole new
  // table on 0035's rule (42P01, not 42703: the relation itself is missing ahead of the
  // migration). `token_hash` is the column because it is the one the redeem's single atomic
  // UPDATE names in its WHERE — the statement the ceremony's single-use guarantee lives in —
  // and the mint writes it in the same breath. A database carrying the table without it is one
  // where redemption cannot be judged at all, which is the exact state this probe exists to
  // name. The surface a stale deployment loses is `/pair*` on the self-host composition only;
  // the marker turns that into a 503 naming this file. No worker half: nothing in the sync
  // loop touches this table. Deploy order: migration → API, no third step.
  //
  // No CHECK marker for `pairing_tokens_grant_check`, on 0032's rule inverted-and-repeated: the
  // migration DOES close a set, but every writer of `grant` is a literal in `pairing.ts` behind
  // a closed TS union, the redeem names the grant as a conjunct of its own WHERE (so an absent
  // CHECK cannot let a token be spent as the other kind), and an unconstrained hand-planted
  // value can only produce a row no reader matches. No INDEX marker: the UNIQUE on `token_hash`
  // is the redeem's own lookup, and its absence is loud at the first duplicate-free mint —
  // `mailboxes_active_address_uq`'s counter-rule does not apply because nothing here does
  // `ON CONFLICT`.
  ["pairing_tokens", "token_hash"],
  // mail 0060_refresh_tokens — the rotating-refresh store, moved to the shared half for the
  // desktop-as-host tier's paired devices (Phase 3). One marker for the whole table, on
  // 0035's rule. `family_id` is the column because the family-revocation sweep predicates on it
  // — the statement reuse detection's whole guarantee lives in — and NOT `token_hash`, which is
  // true but is the same column NAME the `pairing_tokens` probe above already reads; a second
  // marker on one name tells an operator less than two names. A subtlety this entry owns: on a
  // HOSTED or self-host database the table predates the migration (cloud 0000 created it), so
  // this probe passes there whether or not mail 0060 has run — which is the honest answer,
  // because the question a marker asks is "does the schema this deployment queries exist", not
  // "which journal built it". The store that can genuinely lack the table is a mail-only
  // desktop database, and there the engine migrates at boot and this names the migration if it
  // has not. No CHECK marker (nothing here closes a set), no INDEX marker (the UNIQUE on
  // `token_hash` is the rotation's claim lookup and its absence is loud). It was the newest
  // entry in the mail journal until 0062 landed the storage accounting below.
  ["refresh_tokens", "family_id"],
  // mail 0062_storage_accounting, marker ONE of two — the per-account stored-body byte counter,
  // a whole new table on 0035's rule (42P01 ahead of the migration). `bytes` is the column
  // because it is the one every statement names: the ingest reserve's conditional UPDATE (where
  // the managed cap's decline decision lives), the repair passes' clamped deltas, and the
  // billing status route's usage read. The WORKER half fails loud — `insertMessageBody` now
  // reserves unconditionally, so a worker ahead of the migration fails ingest into the ordinary
  // quarantine rather than storing uncounted bodies. The API half is the settings read
  // (`subscriptionStatus`), which would 42703 the whole billing card. Deploy order: migration →
  // API → worker, and the backfill re-run after the worker deploy is the runbook's, not a
  // marker's, concern.
  //
  // No CHECK marker for `account_storage_bytes_nonneg`, on 0030's rule extended one step: the
  // CHECK arrives in the SAME migration statement block as the table, so a database carrying
  // the table without it is not a state the journal can produce — the column probe already
  // implies it, and every app-side decrement is `GREATEST(0, …)`-clamped besides. No INDEX
  // marker: one row per account, fetched by primary key.
  ["account_storage", "bytes"],
  // mail 0062, marker TWO — the withheld-body marker column. It earns its own probe on the
  // whole-row-select rule at its widest for this table: `getBody` does
  // `select().from(messageBodies)`, so an API ahead of the migration 42703s the BODY of every
  // message — the reading surface itself — and both batch modes name the column explicitly.
  // The worker half is the same loud INSERT as `bytes` above (one values-builder writes both
  // features). No CHECK marker for `message_bodies_withheld_reason` (0030's rule: a closed-set
  // CHECK the column marker already implies — same migration, same transaction).
  ["message_bodies", "withheld_reason"],
  // mail 0063_smtp_size_probe_stamp — WHEN the `SIZE` back-fill last dialled a mailbox's submission
  // server. Two columns land (`smtp_size_probed_at` and `smtp_size_probe_code`) in one migration
  // inside one transaction, so one marker probes them on this list's usual rule — and the one named
  // here is the column the SELECTION filters on, which is the statement whose absence changes
  // behaviour rather than merely reading it.
  //
  // It earns a marker on the whole-row-select argument at its sharpest for this table, the same one
  // `smtp_max_size_bytes` (0055) makes two entries up: `MailboxService.list` does
  // `select().from(mailboxes)`, so a too-early API 42703s the mailbox panel and every read that
  // resolves a mailbox, AND `SendService.reserve` enumerates the row inside the transaction that
  // reserves an idempotent send — so the same missing column takes out SENDING, before the
  // reservation commits.
  //
  // No worker half: the sync host neither reads nor writes either column (its own arm of the
  // back-fill deliberately does not stamp — a host that cannot reach submission ports would
  // suppress the host that can), and it selects a narrow projection rather than whole rows. Deploy
  // order: migration → API, no third step.
  //
  // The CHECK gets its own entry in `SCHEMA_CHECK_MARKERS` rather than riding on this one, on
  // 0027's rule: a missing column is loud on the first read, while a column present WITHOUT its
  // constraint accepts whatever a write site lets through and says nothing — and what this
  // constraint keeps out is a third party's SMTP response line. No INDEX marker: the migration
  // deliberately adds none.
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
] as const;

/* THE CLOUD HALF OF THE MARKER CENSUS MOVED TO `./health-cloud.js`.
 *
 * It is a list of Cloud table and column NAMES — the staff directory's stored password, the staff
 * session store's token digest, the billing ledger's dedup column — and this module is mounted by
 * the LOCAL route table (`routes/local.ts`), which is bundled into the shipped desktop engine. So the
 * engine artifact carried the hosted half's schema vocabulary as live data, not as prose — the
 * engine build's own leak count found it, and it was the last real occurrence once the barrel
 * split had closed the import edges.
 *
 * A local install never needs them — it declares `schemaTier: "mail"` and probes
 * {@link MAIL_SCHEMA_MARKERS} — so the hosted set now arrives the same way the tier does, through
 * {@link HealthConfig}. A host that claims the full tier and supplies no set gets a fault rather
 * than a narrower probe: see the `schema_tier_unconfigured` branch below. */

/**
 * INDEX markers — the migrations whose whole content is an index, which a column probe cannot
 * see and which therefore need their own.
 *
 * `information_schema.columns` is blind to indexes, so before this list a migration that
 * creates only one was invisible to `/health`: the deployment certified `schemaOk: true` on a
 * database the fix was missing from.
 *
 * That is not cosmetic. `mailboxes_active_address_uq` is the ONLY thing standing between
 * `POST /mailboxes` and two rows for one address — `MailboxService.create` performs no
 * pre-check, so its 409 is entirely contingent on this index raising 23505. Absent it, two
 * calls both commit, the worker rosters two IMAP runtimes for one physical mailbox, and two
 * reconcile passes issue competing moves against the same real folders. A health gate that
 * says "fine" to that database is a false positive on the invariant the product rests on.
 *
 * Counted into the SAME `found`/`expected` totals as the column markers, deliberately: the
 * `/health` body may not gain a key — its consumers type `schemaMarkers` as
 * `{found, expected, through}` — so a second pair of numbers would be a contract change for
 * no gain. The totals simply get bigger.
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
];

/**
 * CHECK-CONSTRAINT markers — invisible to BOTH probes above, and for the same reason the index
 * list had to exist.
 *
 * `information_schema.columns` cannot see a constraint and `pg_indexes` cannot see one either,
 * so mail `0022`, whose entire content is one CHECK, would have been a migration `/health`
 * certified as applied on a database that never took it. That is the precise false positive
 * `SCHEMA_INDEX_MARKERS` was written to end, arriving a second time through a third catalog.
 *
 * `message_bodies_html_cap` earns its place on the same test as the others — what breaks
 * without it. It is the last of three defences against a storage outage caused by unbounded
 * stored HTML, and the only one that lives in the database rather than in the worker's code.
 * A deployment whose
 * `message_bodies` has no cap will re-bloat silently under any regression in
 * `packages/core/src/html-storage.ts` or `mime.ts`, and the first symptom is Postgres refusing
 * writes for the whole project. A 503 naming the missing migration is enormously cheaper.
 *
 * Counted into the SAME `found`/`expected` totals as the other two lists — see
 * {@link SCHEMA_INDEX_MARKERS} for why the published body may not grow a key.
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
  // mail 0050_rule_subject_contains — the constraint that makes NULL the ONLY representation of "this
  // rule has no subject term". It is listed on 0027's rule (the column and the CHECK fail
  // DIFFERENTLY, and only one of them is loud) and it is the sharpest instance of it in this list,
  // because what the CHECK forbids is not an oversized value but an AMBIGUOUS one.
  //
  // Without the constraint, `''` and `'   '` are storable, and every reader has to decide
  // independently whether they mean "absent" — `core/src/rules.ts#matches`, the specificity rank in
  // `compareRules`, the `ORDER BY` in `drizzle-repo.ts#listRules`, and the client's rule list. They
  // agree today. The first one that stops agreeing produces a rule that MATCHES EVERY SUBJECT while
  // its row reads as specific: mail the user split by subject silently re-collapses into one pile,
  // and nothing raises. `RulesService` refuses the same shapes with a 400, but that refusal is code
  // and can regress; the CHECK is the layer that holds for every writer, including the retro pass
  // and any future importer.
  "rules_subject_contains_nonempty",
  // mail 0052_rule_body_contains — the same constraint for the third term, on 0050's argument
  // verbatim: what it forbids is the AMBIGUOUS value, `''` and `'   '`, whose first
  // reader-disagreement is a rule that matches EVERY MESSAGE while its row reads as specific —
  // and for a body term "every message" is literal, since every message has a body to substring.
  // Same predicate, same six-character class, and the pg test pins the two constraints'
  // definitions equal up to the column name. It was the newest entry here until mail 0053's locale
  // set landed below it.
  "rules_body_contains_nonempty",
  // mail 0053_account_locale — the closed set behind `account_settings.locale`. Listed on 0027's
  // rule (the column and the CHECK fail DIFFERENTLY, and only one of them is loud) and it is the
  // clearest case of it in this list, because the loud/silent asymmetry is total: a missing COLUMN
  // 42703s the whole consent surface on the next request, while a column present WITHOUT its
  // constraint accepts any string a writer lets through — and every consumer of a wrong value
  // DEGRADES SILENTLY. `loadCatalog` falls back to English for a locale it cannot load, the server
  // render falls back to English, `normalizeLocale` answers null, and the row in Settings shows the
  // default. So a stored `'fr'`, `'de_DE'` or `''` produces an account whose language setting simply
  // does not work, with no error in any log and nothing to grep for. The service validates the same
  // set with a 400, but that is code and can regress; the CHECK is the layer that holds for a
  // hand-run UPDATE, a future admin tool and any importer.
  //
  // It was the newest entry here until mail 0063's probe-code set landed below it.
  "account_settings_locale_supported",
  // mail 0063_smtp_size_probe_stamp — the closed set behind `mailboxes.smtp_size_probe_code`.
  // Listed on 0027's rule (the column and the CHECK fail DIFFERENTLY, and only one of them is
  // loud), and its origin is the sharpest on this list: the value stored there is derived from an
  // SMTP AUTH failure, and nodemailer's message for one embeds the submission server's own response
  // line — third-party text that routinely contains the username and can contain an echoed
  // credential. The whole `code`-not-message rule in `SmtpSizeFailure` exists to keep that off a
  // log drain; this constraint is the half of it that also keeps it out of a `mailboxes` row.
  //
  // The write site takes a `SmtpSizeProbeCode`, so the compiler refuses free text today. That is
  // code and code regresses — `error_detail` had exactly one write-site guard and a server's
  // bracket atom walked through it into a column an operator reads. It is the NEWEST entry in the
  // mail journal.
  "mailboxes_smtp_size_probe_code_closed",
];

/**
 * A CHECK marker probed by its DEFINITION, not merely by its name.
 *
 * `[conname, definitionSubstring]` — the constraint must exist AND `pg_get_constraintdef` must
 * contain the substring, case-sensitively.
 *
 * ── WHY A THIRD KIND OF CHECK MARKER EXISTS AT ALL ──────────────────────────────────────────
 *
 * {@link SCHEMA_CHECK_MARKERS} probes for a NAME, which is exactly right when the migration
 * CREATES the constraint: absent name, absent migration. It is blind to the other shape a
 * constraint migration takes — **replacing** a constraint under its existing name, which is the
 * only way PostgreSQL lets a CHECK be amended (`DROP … IF EXISTS` then `ADD` under the same
 * name). Both names are then present on a database that never took the migration, the count
 * matches, `/health` answers `schemaOk: true`, and the host stays in rotation while the
 * constraint it is relying on still holds the OLD rule.
 *
 * Cloud `0011_trial_credits` is that shape and is the reason this list exists: it teaches the
 * ledger's sign and source rules the word `trial_grant` and adds no column, no index and no new
 * name. Deployed against a database still on `0010`, every trial grant is rejected by a CHECK
 * from inside the webhook's transaction — the subscription mirror rolls back with it, every
 * retry 500s for three days, and the account gets neither its mirrored trial nor the allowance
 * the product advertises. Health, meanwhile, reports the schema as complete.
 *
 * ── AND WHY A SUBSTRING RATHER THAN THE WHOLE DEFINITION ────────────────────────────────────
 *
 * `pg_get_constraintdef` renders a normalized form, not the SQL that was typed: literals acquire
 * `::character varying` casts, `IN (…)` becomes `= ANY (ARRAY[…])`, and the exact spelling is a
 * PostgreSQL version's business rather than this repository's. Pinning the whole string would be
 * a probe that fails on a server upgrade. A substring naming the VOCABULARY the migration added
 * survives that and still cannot be satisfied by the old definition, which is the whole question.
 */
export type CheckDefinitionMarker = readonly [conname: string, definitionSubstring: string];

/**
 * A FUNCTION marker probed by its BODY — the fifth marker class, and the last catalog the other
 * four cannot reach.
 *
 * `[proname, bodySubstring]` — a `public` function of that name must exist AND its `pg_proc.prosrc`
 * must contain the substring, case-sensitively.
 *
 * ── THE SHAPE THIS EXISTS FOR ───────────────────────────────────────────────────────────────
 *
 * {@link CheckDefinitionMarker} closed the constraint-REPLACEMENT blind spot. A trigger FUNCTION
 * replacement is the same defect one catalog over, and strictly worse: `CREATE OR REPLACE
 * FUNCTION` changes no name anywhere, creates no column and no index, and lives in `pg_proc` —
 * which `information_schema.columns`, `pg_indexes` and `pg_constraint` all cannot see. Cloud
 * `0013_ledger_integrity` named this gap in its own header and worked around it by riding the
 * index it happened to create beside the two replaced functions. Cloud `0014_ledger_trial_source`
 * has NOTHING beside it — a replaced function body is its entire content — so the workaround runs
 * out and the class has to exist.
 *
 * What a missing entry costs is the usual one, in the usual silent direction: deployed against a
 * database on the older function body, every layer reports healthy and the invariant the newer
 * body enforces is simply not enforced. Nothing 500s, no query is wrong, and the first evidence is
 * a row that should have been impossible.
 *
 * ── WHY `prosrc` AND NOT `pg_get_functiondef` ───────────────────────────────────────────────
 *
 * `pg_get_functiondef` re-renders the whole `CREATE FUNCTION` statement, so its preamble is a
 * PostgreSQL version's business — the same objection {@link CheckDefinitionMarker} answers by
 * taking a substring. `prosrc` is the body EXACTLY as it was written, stored verbatim for a
 * `plpgsql` function, so a substring of the migration's own text is a stable needle. Pick the
 * predicate the migration ADDED, for the same reason the constraint markers pick added
 * vocabulary: it must be unsatisfiable by the body it replaced.
 */
export type FunctionDefinitionMarker = readonly [proname: string, bodySubstring: string];

/* `EXPECTED_MARKERS` — the BOTH-HALVES count — moved to `./health-cloud.js` with the list it
 * derives from. {@link MAIL_EXPECTED_MARKERS} below is what this module can compute on its own. */

/**
 * THE SAME PROBE FOR A HOST THAT ONLY EVER RAN THE MAIL JOURNAL.
 *
 * A desktop install migrates `MAIL_JOURNAL` alone — it has no billing ledger, no passkey
 * challenge store and no staff directory, and it should not: those tables belong to a service it
 * has no account with. Probed against the full set it reports `schema_incomplete` on every
 * request, for ever, which is the OPPOSITE of what that answer means. It is not an unmigrated
 * database; it is a complete one of a different shape.
 *
 * Two lists rather than a flag inside the probe, because the honest statement is "this host
 * expects THESE markers" and the count has to be derived from the same list that was asked for.
 * The index and check markers are unsplit deliberately: every one of them names a mail table, so
 * a local install is expected to have all of them, and if a Cloud-only index is ever added to
 * that list this constant is where the split has to happen — loudly, rather than by a filter that
 * silently drops it.
 */
export const MAIL_EXPECTED_MARKERS =
  MAIL_SCHEMA_MARKERS.length + SCHEMA_INDEX_MARKERS.length + SCHEMA_CHECK_MARKERS.length;

/**
 * The newest entry of the MAIL journal, which {@link MAIL_SCHEMA_MARKERS} is reconciled to.
 *
 * `0026_thread_resolution` adds one column and two indexes, `0025_mailbox_kickstart` one column,
 * and `0024_flag_state` a whole TABLE — all of which a `(table, column)` probe sees the ordinary
 * way, one entry in {@link MAIL_SCHEMA_MARKERS} naming the column a query actually reads.
 * `0023_mailbox_failure_reason` adds four columns and is probed the same way; the two before that
 * could not be — `0021_mailbox_address_unique` creates only an index and
 * `0022_message_body_html_cap` only a CHECK, so they are probed by
 * {@link SCHEMA_INDEX_MARKERS} and {@link SCHEMA_CHECK_MARKERS} through two other catalogs. All
 * six ARE probed; only the mechanism differs. Unlike
 * {@link CLOUD_SCHEMA_MARKER_JOURNAL_TAG}'s data backfill, which genuinely has nothing to probe.
 *
 * `0027_organizer_lease` is probed TWICE and neither is redundant: `mailboxes.disabled_reason`
 * in {@link MAIL_SCHEMA_MARKERS}, because `MailboxService` selects whole rows and an API ahead of
 * the migration answers 42703 on the mailbox panel; and `mailboxes_disabled_reason_closed` in
 * {@link SCHEMA_CHECK_MARKERS}, because a column whose CHECK never landed is a privacy boundary
 * that is silently absent rather than loudly broken.
 *
 * `0029_mailbox_sync_block` is probed twice for exactly those two reasons — and this pin is the
 * reason anyone noticed. The change that shipped the migration and the column marker left this
 * constant at `0028_message_instances`, so the anti-drift gate went on approving a database from
 * before the migration that exists to end a 32-minute silence. The gate is not decoration: it
 * failed, named this line, and was the only thing that did — a deployed API reporting
 * `through 0028` reads as a stale alias, which is how it was misfiled for a day.
 *
 * `0030_sensitive_rescreen` is probed ONCE, by `mailboxes.sensitive_rescreen_at`, and the reason
 * it does not also earn a {@link SCHEMA_CHECK_MARKERS} entry is the reason 0027 and 0029 did: a
 * CHECK is probed separately when the migration HAS one, because a column whose constraint never
 * landed is silently absent rather than loudly broken. This migration adds a timestamp and closes
 * no set, so there is no second catalog object to probe and a second marker would be a number
 * that means nothing.
 *
 * `0031_tags` is probed TWICE — `tags.id` and `message_tags.tag_id` — and that is the first pair
 * on this list. It creates two tables in two statements, and the one the read path depends on is
 * the child: `materializeMessages` queries `message_tags` on every page, so a database holding
 * only the parent would 42P01 every message list while a single `tags.id` marker reported healthy.
 * One marker per CATALOG OBJECT a query touches, which is the same rule as always — this
 * migration is simply the first here to add more than one.
 *
 * Its unique index `tags_account_name_uq` is NOT in `SCHEMA_INDEX_MARKERS`, on 0026's rule: an
 * absent unique index here is not silent, because `create`'s `ON CONFLICT DO NOTHING` would stop
 * refusing duplicate names and the 409 path has a test that fails loudly. `mailboxes_active_address_uq`
 * is listed there because ITS absence is silent; this one's is not.
 *
 * `0032_unsubscribe_records` is probed ONCE, by `unsubscribe_records.list_key`, and the column is
 * chosen rather than `id` on the standing rule — probe the column a QUERY actually reads.
 * `list_key` is the one every statement in `UnsubscribeService` names: the claim inserts it, the
 * unique index that makes the claim at-most-once is built on it, and the repeat check reads it.
 * A database carrying an `unsubscribe_records` table without it is one where the idempotency key
 * does not exist, which is the single failure this whole table was added to prevent.
 *
 * Its unique index `unsubscribe_records_mailbox_list_uq` is NOT in `SCHEMA_INDEX_MARKERS`, and
 * this is the case where that decision was genuinely close. It follows `mailboxes_active_address_uq`
 * logic more than `tags_account_name_uq`'s: without the index the claim's `ON CONFLICT DO NOTHING`
 * raises Postgres 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
 * specification") rather than silently succeeding — so the absence is LOUD, at the first
 * unsubscribe, and there is no window in which duplicate requests go out believing themselves
 * unique. A marker would be a number that cannot catch anything the first claim does not.
 *
 * There is no CHECK marker for `unsubscribe_records_state_closed` on 0030's rule inverted: the
 * migration DOES close a set, but every writer of `state` is a literal in one file and an absent
 * CHECK cannot mis-route mail or send a request — it can only let a typo persist a state no
 * reader handles, which the closed TS union already refuses at compile time.
 *
 * `0034_rule_retro` is probed ONCE, by `rules.retro_requested_at`, and the column is chosen on
 * the standing rule — probe the column a QUERY actually reads. `RulesService.create` writes it on
 * the DEFAULT path, since retroactive apply is the default, and `materializeRule` selects whole
 * rows through the drizzle schema, so an API deployed ahead of this migration answers Postgres
 * 42703 on every rule creation and on the whole rules surface. That is a 503 naming the
 * migration, not a 500 nobody can attribute.
 *
 * Its index `messages_account_from_addr_idx` IS in `SCHEMA_INDEX_MARKERS`, and it is the clearest
 * case on that list since `mailboxes_active_address_uq`. Absent, nothing raises and no test fails:
 * the retro pass returns the RIGHT rows, computed by a sequential scan over every message in the
 * account, once per page, once per cycle, per owed rule. The symptom is a worker whose cycle
 * quietly stops finishing — which is the exact silence that list exists for, and the opposite of
 * `tags_account_name_uq`, whose absence is loud. Its domain sibling
 * `messages_account_from_domain_idx` is not listed on the one-marker-per-migration economy: the
 * two are created by the same statement group and no database can have one without the other.
 *
 * `0035_account_settings` is probed ONCE, by `account_settings.seed_confirmed_at` — see the
 * marker itself for why that column and not `account_id`.
 *
 * `0036_sensitive_fp_backfill` is probed ONCE, by `mailboxes.sensitive_fp_backfill_at`, and it
 * is the first `mailboxes` marker since 0029 to carry a WORKER argument as well as the generic
 * one — worth saying because the entry directly comparable to it, `0030_sensitive_rescreen`,
 * makes a point of having no worker half. The difference is where the evidence lives: 0030's
 * pass re-decides stored rows and needs no mail server, while this one cannot decide anything
 * without re-reading the original message, so it has to run where the IMAP connection is. That
 * puts the worker back in the deploy order.
 *
 * It adds no CHECK marker, on 0030's rule: it closes no set, so there is no second catalog
 * object to probe and a second marker would be a number that means nothing. It adds no index
 * marker either, and that is a decision rather than an omission — the migration creates no
 * index, because the query it serves runs once per mailbox for the life of that mailbox and a
 * permanent partial index maintained by every sensitive ingest is a worse trade than the scans
 * it would save. The reasoning is in the migration; what belongs here is that its absence from
 * `SCHEMA_INDEX_MARKERS` is not an oversight.
 *
 * `0037_draft_html` is probed TWICE — `drafts.html` in the column list and `drafts_html_cap` in
 * `SCHEMA_CHECK_MARKERS` — and it is only the second migration to earn a CHECK marker beside its
 * column since 0029. The reason is stated at each marker; the part worth having here is why the
 * pair is not redundant. The column's absence is LOUD (42703 on the first draft read) and the
 * constraint's absence is SILENT, so one probe cannot stand for the other: a database that took
 * half of this migration would answer every request correctly while accepting a draft of any
 * size at all.
 *
 * It adds no INDEX marker, and that is a decision rather than an omission — the migration
 * creates no index. `drafts` is already covered by `drafts_account_updated_idx` from 0012, and
 * nothing queries on the new column: `html` is projected, never filtered.
 *
 * `0038_initial_import_completed` is probed ONCE, by `mailboxes.initial_import_completed_at`. It
 * carries the generic `mailboxes` argument (a whole-row select 42703s an API deployed ahead of
 * it) AND a worker one — `stampInitialImportComplete` writes the column, so the deploy order is
 * migration → API → worker, the same shape 0036 has. No CHECK marker, on 0030's rule (a timestamp
 * closes no set), and no INDEX marker: the column is projected, never filtered.
 *
 * `0039_mailbox_retry_after` is probed ONCE, by `mailboxes.retry_after`, and it is the first
 * `mailboxes` column on this list whose deploy order runs migration → WORKER → API. Every other
 * one goes API-then-worker because the API's whole-row select is the loud failure; this one is
 * the other way round because the API deploy is what makes `resync_mailbox` `available: true` in
 * the actions catalog, and the worker has to be able to honour a release before the console
 * offers the button. No CHECK marker (0030's rule) and no INDEX marker: the roster pass reads it
 * off a row it already has, and nothing filters on it.
 *
 * `0040_auto_suggest` is probed ONCE, by `account_settings.auto_suggest_at`, and it is the second
 * marker this table has earned. The argument is not the feature — the flag's only reader is a
 * browser, which reads absent as OFF and degrades to the pre-migration behaviour — it is that
 * `consentSettings` selects WHOLE ROWS, so an API deployed ahead of the migration 42703s `GET
 * /consent` for every account. The blast radius of the missing column is therefore a surface that
 * does not use it, which is the whole reason a nullable, unwritten column is on this list at all.
 * No CHECK marker (0030's rule) and no INDEX marker: read off a row already fetched by primary
 * key, never filtered on. No worker half, so no third deploy step.
 *
 * `0041_message_failures` is probed ONCE, by `message_failures.next_attempt_at`, and it is the
 * first entry on this list whose API half is the WEAK one. Nothing in `packages/api` reads or
 * writes that table and nothing may — a staff read of those rows is a delivery oracle — so there is
 * no whole-row select to 42703 and no surface to break. The marker is here for the worker: the
 * worker is the table's only reader and only writer, and a worker deployed ahead of the migration
 * refuses to skip a message it cannot record, which holds the folder's cursor and quarantines the
 * mailbox. Safe, and still an outage, so the order is migration → API → worker. No INDEX marker
 * (the partial index is a cost object; its absence is slow, not wrong) and no CHECK marker, because
 * `message_failures_code_closed` is created INSIDE the `CREATE TABLE` and could only ever fail
 * together with the column above.
 *
 * `0045_draft_bcc` is probed ONCE, by `drafts.bcc`, the twin of the `drafts.html` marker and for
 * the same sharper reason: `materializeDraft` and `SendService.reserve` both select WHOLE `drafts`
 * rows, so an API deployed ahead of the migration 42703s every draft read AND the send path —
 * compose and reply both dark, from a column a bcc-less send never reads. No CHECK marker (the
 * column is a plain jsonb default, no constraint) and no INDEX marker. No worker half: nothing in
 * `apps/worker` reads `drafts`, so the order is migration → API with no third step.
 *
 * `0046_screener_auto_apply` is probed ONCE, by `account_settings.screener_auto_apply_at`, the twin
 * of the `auto_suggest_at` marker and for the same whole-row-select reason: `consentSettings`
 * selects WHOLE `account_settings` rows, so an API deployed ahead of the migration 42703s `GET
 * /consent` for every account, from a column the consent surface never itself reads. Unlike the two
 * `drafts` markers there IS a worker half — the auto-apply pass probes the column each cycle — but
 * that read degrades to OFF on 42703, so the worker never blocks on it; the order is still
 * migration → API (and worker).
 *
 * `0047_read_order` is probed ONCE, by `messages.last_read_at`, and it is the first `messages`
 * column on this list since 0028. The whole-row-select argument every `account_settings` entry
 * above makes is the same argument, one order of magnitude larger: `messages` is the table every
 * read surface projects, so an API ahead of this migration 42703s the message list, the single
 * read, the delta feed and the snapshot — not a panel, the mail. No CHECK marker (a timestamp
 * closes no set) and no INDEX marker, because nothing filters or pages on the column; the sort it
 * feeds runs on the client. No worker half, so the order is migration → API.
 *
 * `0048_remote_images_default` is probed ONCE, by `account_settings.block_remote_images_at` — the
 * third `account_settings` marker, on the same whole-row-select argument as `auto_suggest_at` and
 * `screener_auto_apply_at`. It is slightly sharper than either: this column is written through
 * `PATCH /consent/settings` as well as read through `GET /consent`, so an API ahead of the
 * migration 42703s both directions of the consent surface. No worker half, no CHECK marker, no
 * INDEX marker. The order is migration → API — and note that this is the one column here whose
 * ROLLBACK is not safe in the usual direction: dropping it returns every opted-out account to
 * auto-loading, so the API goes back before the column does. See the migration.
 *
 * `0049_mailbox_sync_requested_at` is probed ONCE, by `mailboxes.sync_requested_at`, on the
 * whole-row-select rule its own migration file already states. **It was added two migrations late**
 * — the migration landed with no marker, no tag bump and no census bump, so this probe would have
 * approved a database predating it for as long as nobody looked. The failure it now catches is not
 * the doorbell (that write is caught and best-effort, deliberately) but `select().from(mailboxes)`
 * answering 42703, which takes out the mailbox list and every read that resolves a mailbox. Worker
 * half is safe (a failed kick scan degrades to poll-only). No CHECK, no INDEX marker.
 *
 * `0050_rule_subject_contains` is probed TWICE — by `rules.subject_contains` AND by the
 * `rules_subject_contains_nonempty` CHECK — and it is the only mail entry with both halves since
 * 0027. The column half is the second-strongest whole-row case on the list after
 * `messages.last_read_at`: `rules` is enumerated by `materializeRule` (the rules surface, the
 * `/sync` delta, the 201 of every rule the sender sheet writes) AND by
 * `drizzle-repo.ts#listRules`, which is what the ROUTER consults on arrival — so a too-early API
 * both 42703s the surface and stops filing mail. The CHECK half is listed separately because the
 * two fail differently and only one is loud: a column present without its constraint accepts `''`,
 * which is a rule matching EVERY subject while its row reads as specific. Worker half is NOT the
 * safe kind (a routing read that 42703s stops organizing rather than degrading), so the order is
 * migration → API → worker with the first arrow load-bearing.
 *
 * `0051_away_responder` is probed ONCE, by `away_responders.audience` — the first marker on this
 * list belonging to a feature that SENDS MAIL. `AwayResponderService` selects whole rows and `put`
 * returns the inserted one, so an API ahead of the migration 42703s both `/away-responder`
 * endpoints: somebody already away could not turn their responder off. The worker half is real and
 * is the third step (the pass reads this row and writes `away_responder_sent`), and it fails in the
 * safe direction — a 42703 inside the pass is caught, logged and sends nothing. No INDEX marker and
 * no CHECK marker; the marker beside the column says why the CHECK does not need one.
 *
 * `0052_rule_body_contains` is probed TWICE — by `rules.body_contains` AND by the
 * `rules_body_contains_nonempty` CHECK — on `0050`'s two-halves argument verbatim: it is the same
 * `rules` table both product halves enumerate, and the same ambiguous-value CHECK whose absence
 * fails silently. One sharpening: without its constraint a stored `''` is a rule matching EVERY
 * MESSAGE, not every subject, because every message has a body to substring. Same deploy order,
 * same load-bearing first arrow.
 *
 * `0053_account_locale` is probed TWICE — by `account_settings.locale` AND by the
 * `account_settings_locale_supported` CHECK — and it is the fourth mail entry with both halves. The
 * column half is the `account_settings` whole-row case for the fourth time (`consentSettings` selects
 * the row, so a too-early API 42703s the entire consent surface and not merely this preference). The
 * CHECK half is the sharpest silent-failure case on that list: every reader of an unsupported locale
 * degrades to English on purpose, so a column without its constraint yields an account whose language
 * setting does not work and logs nothing anywhere. No worker half at all — nothing in the sync loop
 * reads it — and no INDEX marker, since the column is read off a row fetched by primary key and is
 * never a predicate.
 *
 * `0054_auto_unsubscribe_optout` is probed ONCE, by `account_settings.block_auto_unsubscribe_at` —
 * the fifth `account_settings` marker, on the same whole-row-select argument as the four before
 * it, and the one whose too-early failure is the QUIETEST on this list. The column is read by
 * `UnsubscribeService.onScreenOut`, whose contract is that it never throws at its caller, so a
 * 42703 there is caught and counted as a skip: the screen-out commits, the unsubscribe silently
 * stops happening, and nothing anywhere says so. A `503 schema_incomplete` in front of the whole
 * API is a better outcome than a feature that turns itself off without a log line. No CHECK marker
 * (a timestamp closes no set), no INDEX marker (read off a row fetched by primary key, never a
 * predicate) and no worker half — nothing in the sync loop reads it.
 *
 * `0055_mailbox_smtp_max_size` is probed ONCE, by `mailboxes.smtp_max_size_bytes` — the sending
 * server's own `SIZE` announcement, recorded by the connect-time SMTP probe. Two whole-row readers
 * rather than one, which is what makes it the sharpest `mailboxes` marker: `MailboxService.list`
 * enumerates the row (so a too-early API 42703s the mailbox panel and every mailbox resolution) and
 * `SendService.reserve` enumerates it inside the transaction that reserves a send, so the same
 * missing column takes out SENDING. That second failure is the safe half of an unsafe one — it
 * happens before the reservation commits, so nothing is stranded out of `draft` — but it is still a
 * user who cannot send, which is why the 503 in front of it is worth more than the diagnosis
 * afterwards. No CHECK marker (a size closes no set) and no INDEX marker (read off a row fetched by
 * primary key, never a predicate); no worker half — nothing in the sync loop reads it.
 *
 * `0056_screening_baseline` is probed ONCE, by `account_settings.screening_baseline_at` — the
 * sixth `account_settings` marker, on the whole-row-select argument all five before it make
 * (`consentSettings` does `select().from(account_settings)`). What distinguishes it is that it has
 * a WORKER half as well as an API one, and the two fail in opposite directions. The API's failure
 * is loud: `GET /consent` is the boot fetch the shell partitions its mirror from, so a 42703 there
 * is a client drawing the Screener over the raw mirror. The worker's is silent by construction —
 * `screeningFor` catches the read, logs, and returns the lenient value WITHOUT caching it, so a
 * worker ahead of the migration routes exactly as it did before this column existed. That is the
 * intended degradation and not a reason to skip the marker: the 503 in front of the API is what
 * makes the window visible instead of merely survivable. No CHECK marker (any instant is a legal
 * baseline), no INDEX marker (read off a row fetched by primary key, never a predicate).
 *
 * `0057_message_from_name` is probed ONCE, by `messages.from_name` — the From header's display
 * name, the sender's half of the recipients repair. The whole-row-select argument at its widest:
 * `materializeMessages` and the single message read select whole `messages` rows, so an API ahead
 * of the migration 42703s the message list, the single read, the delta feed and the bootstrap
 * snapshot — the entire mail surface. The WORKER half fails loud, not silent: `insertMessage`
 * names the column unconditionally, so a worker ahead of the migration fails ingest with the same
 * 42703 into the cycle's ordinary quarantine rather than dropping names on the floor, which is
 * the defect this column ends. Deploy order: migration → API → worker. No CHECK marker (a
 * sender-chosen display name closes no set), no INDEX marker (projected off rows already fetched;
 * never a predicate).
 *
 * `0058_reconcile_backoff` is probed ONCE, by `folder_state.next_attempt_at`, for four columns —
 * `attempts` and `next_attempt_at` on `folder_state` and on `flag_state`, all created by one
 * migration in one transaction, so a state where one exists without the others is unreachable. The
 * probed column is the one the pending-move query FILTERS on. Widest whole-row-select argument
 * again: `materializeMessages` selects whole `folder_state` rows for the message list, the single
 * read and the bootstrap snapshot, so an API ahead of the migration 42703s the mail surface; the
 * worker half is equally loud, because the reconcile pass both filters and writes the pair. Deploy
 * order: migration → API → worker. No CHECK marker (an instant closes no set and `attempts` is a
 * count), no INDEX marker (the migration adds none, by design).
 *
 * `0059_pairing_tokens` is probed ONCE, by `pairing_tokens.token_hash` — a whole new table, so
 * the failure ahead of the migration is 42P01 on the pairing surface (self-host composition
 * only; no other table mounts `/pair*`). The probed column is the one the redeem's single
 * atomic UPDATE names in its WHERE, which is where the ceremony's single-use guarantee lives.
 * No worker half: nothing in the sync loop reads or writes it. Deploy order: migration → API,
 * no third step. No CHECK marker for the grant CHECK (every writer is a literal behind a closed
 * TS union, and the redeem names the grant in its own WHERE, so an absent CHECK cannot mis-spend
 * a token), no INDEX marker (the UNIQUE on `token_hash` is the redeem's lookup and its absence
 * is loud, not silent).
 *
 * `0060_refresh_tokens` is probed ONCE, by `refresh_tokens.family_id` — the column the
 * family-revocation sweep predicates on. The table is old on hosted databases (cloud 0000) and
 * new only on mail-only desktop stores, so the probe's real subject is the desktop tier; the
 * marker entry above carries the nuance.
 *
 * `0061_web_sessions_deviceless` is probed by NOTHING, and that absence is a decision, not a
 * gap: it is a DATA backfill (auto-minted "Web" device rows detached from their sessions —
 * DEVICES) that creates no table, no column, no index and no constraint, so a database before
 * and after it is SCHEMA-IDENTICAL and there is no object a probe could select. The anti-drift
 * gate (`health.test.ts`: "each marker tag is still the NEWEST entry in its own journal")
 * exists to force exactly this sentence to be written when a migration lands; what it cannot
 * force — the census being unable to see data — the deploy runbook carries instead (applied to
 * prod before the API alias, re-run idempotently after). The one behavioral consequence of a
 * missed apply is cosmetic and self-healing: the Devices pane groups legacy "Web" rows as
 * named devices until the statements run.
 *
 * `0062_storage_accounting` is probed TWICE — `account_storage.bytes` (a whole new table) and
 * `message_bodies.withheld_reason` (the widest whole-row-select on the reading surface) — the
 * entries in {@link MAIL_SCHEMA_MARKERS} carry both arguments. Its backfill is data and, like
 * 0061's, belongs to the runbook: re-run once after the worker deploy, because the OLD worker
 * keeps ingesting uncounted bodies between the pre-alias migration and its own restart, and the
 * backfill's `ON CONFLICT … DO UPDATE` recomputes rather than preserves.
 *
 * `0063_smtp_size_probe_stamp` is probed TWICE, and the pair is 0027's exactly: `mailboxes
 * .smtp_size_probed_at` in {@link MAIL_SCHEMA_MARKERS}, because `MailboxService.list` and
 * `SendService.reserve` select whole rows and a too-early API 42703s the mailbox panel and the
 * send reservation; and `mailboxes_smtp_size_probe_code_closed` in {@link SCHEMA_CHECK_MARKERS},
 * because the code column's constraint is what keeps a submission server's own AUTH response line
 * out of a row an operator reads, and a constraint that never landed is silently absent rather
 * than loudly broken. Two columns, one column marker: they land in one statement block inside one
 * transaction, so no database can hold one without the other, and the one named is the column the
 * pass's SELECTION filters on. It has no data statement and no index, so there is nothing left for
 * the runbook to carry.
 *
 * `0064_device_sync_stamp` is probed as `devices.last_synced_at` (its entry carries the
 * whole-row-select argument). Its landing did not bump this tag — the anti-drift gate was red
 * from that commit until 0065's markers landed, which is exactly the drift the gate exists to
 * catch; recorded here rather than silently healed.
 *
 * `0065_junk_trash_delete` is probed TWICE — `mailboxes.trash_folder` (the delete refusal's
 * read, plus `MailboxService.list`'s whole-row select) and `messages.deleted_at` (the snapshot
 * bootstrap and search predicates). The widened `message_bodies_withheld_reason` CHECK rides
 * the same migration transaction as the columns, so the column probes imply it (0030's rule).
 * No data statement, no index; deploy order migration → worker → API is the file's own header.
 *
 * `0066_folders_enabled` is probed as `account_settings.folders_enabled_at` — the whole-row
 * `consentSettings` select means a too-early API takes out the entire consent surface, and the
 * marker names the migration instead. One column, no CHECK, no index, no worker half.
 *
 * `0069_folders_enabled_reissue` re-runs 0066's one idempotent statement from above the
 * journal maximum (0066's original position was skippable on databases that migrated between
 * two lanes' landings — `REISSUED_ORIGINALS` in packages/db/src/baseline.ts carries the whole
 * account, including why the file is a byte copy). Same column, so the 0066 marker covers it.
 *
 * `0070_session_sync_stamp` is probed as `sessions.last_synced_at` — the per-SESSION sync
 * horizon (0064's twin for deviceless installs). The whole-row-select blast radius is the
 * AUTH surface: `rotateRefresh`, `listDevices` and `requireStepUp` all
 * `select().from(sessions)`, so a too-early API 42703s token refresh itself. One column, no
 * CHECK, no index, no worker half.
 *
 * `0071_withheld_provenance_index` adds no column and is probed as the INDEX
 * `message_bodies_withheld_idx` (in `SCHEMA_INDEX_MARKERS`, not here): the partial index the
 * worker's `junk_filed` convergence pass reads husks by. Its absence is the silent kind — a slow
 * cycle, never a 42703 — which is exactly the class the index list exists for.
 *
 * `0072_tracking_pixels_optout` is probed as `account_settings.load_tracking_pixels_at` — the
 * opt-out of pixel blocking, one nullable column read by the whole-row `consentSettings` select.
 *
 * `0073_mailbox_folders_optout` is probed as `mailboxes.folders_disabled_at` — the per-mailbox
 * "Use folders" exception stamp, one nullable column read by the whole-row `MailboxService.list`
 * select and the `listUserFolders` join. It is the newest entry, so it is the tag below.
 */
// 0067/0068 (the device-sync alert's withdrawn SECURITY DEFINER carrier and its retirement)
// add no column and get no marker: a function's absence is the ALERT RULE's own isolated,
// tolerated state, not a schema fault a serving API should 503 over.
export const MAIL_SCHEMA_MARKER_JOURNAL_TAG = "0073_mailbox_folders_optout";

/* `CLOUD_SCHEMA_MARKER_JOURNAL_TAG` moved to `./health-cloud.js`: it is the NAME of a cloud
 * migration, and this module ships in the desktop engine. */

/* `SCHEMA_MARKER_JOURNAL_TAG` — the composite — moved to `./health-cloud.js` for the same
 * reason: it interpolates the cloud tag. */

/**
 * ONE ROUND TRIP, run once and read twice.
 *
 * `GET /admin/overview` has to publish the SAME `ApiHealth` a probe would see — the console's
 * whole claim is that it renders what `/health` says, not a second opinion — and the only way
 * for two endpoints to agree about that is for them to execute the same statement and the same
 * verdict. A copy of this SQL in `admin-service.ts` would drift on the first schema marker
 * anybody adds, and the drift would be invisible: both endpoints would keep answering 200.
 *
 * It returns the RAW probe rather than a rendered body because the two callers need different
 * shapes: `/health` has a published body this refactor may not alter by a single key, and the
 * console needs `ApiHealth`. The rendering therefore stays with each caller; only the query
 * and the fault ordering are shared.
 */
export type HealthProbe =
  | { kind: "unreachable"; dbLatencyMs: number; errorCode: string | null }
  | { kind: "empty"; dbLatencyMs: number }
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
   * Constraints whose DEFINITION is probed — see {@link CheckDefinitionMarker}. Defaults to none,
   * because every entry so far names a Cloud table and this module ships in the desktop engine.
   */
  checkDefinitionMarkers: ReadonlyArray<CheckDefinitionMarker> = [],
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
  const indexMarkers = [...SCHEMA_INDEX_MARKERS, ...extraIndexMarkers];
  const expected =
    columnMarkers.length + indexMarkers.length + SCHEMA_CHECK_MARKERS.length +
    checkDefinitionMarkers.length + functionDefinitionMarkers.length;
  try {
    const result = await db.execute(
      sql`select 1 as one,
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
                           sql`(c.conname = ${name} and position(${needle} in pg_get_constraintdef(c.oid)) > 0)`),
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
                           sql`(p.proname = ${name} and position(${needle} in p.prosrc) > 0)`),
                         sql` or `,
                       )
                       : sql`false`
                     })) as function_def_markers`,
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
      // The billing COMPOSITION marker, on dbProvider's exact pattern: a fixed string, injected
      // by the host, never a fault. It is the tripwire for a billing-environment change, whose
      // failure mode is camouflaged (a lost billing configuration reads as the legitimate
      // `billing_unconfigured`). Emitted on every branch, like dbProvider and for its reason.
      const billing = injected?.billing ?? null;

      // THE PAGER'S ARMS — the worker's boot announcement, in the idiom a serverless host has.
      //
      // A memory read (`HealthConfig.alertSinks` says why it is a capability and not a value), so
      // it costs no round trip and is published on EVERY branch below, beside `dbProvider` and
      // `billing`: a host that cannot reach its database is exactly when "does this deployment
      // still have a way to page anybody?" is worth the most.
      //
      // Two keys, from one call. `alertSinks` is the same key, the same shape and the same closed
      // codes the worker's `/health` publishes, so the two are a literal JSON diff — the property
      // the `kek` object was given for the same reason. `alertPasses` is what stops the counters
      // from lying on a cold instance; see `AlertSinkSummary.passes`.
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
        // A mail-tier host passes none of any of them: every entry so far names a Cloud table or
        // a Cloud function, and a local engine's database is complete without them.
        fullCensus ? fullCensus.checkDefinitions : [],
        fullCensus ? fullCensus.indexMarkers : [],
        fullCensus ? fullCensus.functionDefinitions : [],
      );
      if (probe.kind === "unreachable") {
        return healthResponse(503, {
          ok: false,
          version,
          dbLatencyMs: probe.dbLatencyMs,
          error: "database_unreachable",
          errorCode: probe.errorCode,
          kek,
          dbProvider,
          billing,
          ...pager,
          ...staffFaults,
        });
      }
      if (probe.kind === "empty") {
        return healthResponse(503, {
          ok: false, version, dbLatencyMs: probe.dbLatencyMs, error: "database_probe_empty", kek,
          dbProvider,
          billing,
          ...pager,
          ...staffFaults,
        });
      }

      const fault = healthFault({
        schemaOk: probe.schemaOk, markersFound: probe.markersFound, kekError, buildError,
        expected: expectedMarkers, through,
      });
      return healthResponse(fault ? 503 : 200, {
        ok: fault === null,
        version,
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
        billing,
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
