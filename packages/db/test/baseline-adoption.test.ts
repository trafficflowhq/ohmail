import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGACY_CUTOFF_WHEN, LEGACY_JOURNAL_WHENS, baselineEntries, baselineObjects, readJournalOf,
  type JournalSpec,
} from "../src/baseline.js";

/**
 * The parts of baseline adoption that are decidable WITHOUT a database — the frozen cutoff and
 * the object set the probe is derived from. The five cells of the truth table need a real
 * Postgres and live in `baseline-adoption.pg.test.ts`.
 *
 * These are here because they are the two properties whose failure has no undo:
 *
 *  · **the cutoff must be frozen.** If the adoptable set were "this journal's entries" rather
 *    than `when <= LEGACY_CUTOFF_WHEN`, then the moment somebody appends migration 22 to the
 *    mail journal the next production run marks it applied WITHOUT running it, forever.
 *  · **the insert set and the verification set must be the same set.** Both are derived from
 *    `baselineEntries`. A hand-maintained list of markers beside a journal-derived list of
 *    inserts is exactly how the two drift, and the drift is invisible until a column is missing
 *    in production.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

const MAIL: JournalSpec = {
  name: "mail",
  dir: join(HERE, "..", "..", "db-mail", "drizzle"),
  migrationsSchema: "drizzle_mail",
};
const CLOUD: JournalSpec = {
  name: "cloud",
  dir: join(HERE, "..", "drizzle-cloud"),
  migrationsSchema: "drizzle_cloud",
};

describe("the baseline cutoff is frozen", () => {
  it("is the pre-split journal's last entry, as a literal", () => {
    expect(LEGACY_CUTOFF_WHEN).toBe(1786006486206);
    expect(LEGACY_JOURNAL_WHENS).toHaveLength(24);
    expect(LEGACY_JOURNAL_WHENS.at(-1)).toBe(LEGACY_CUTOFF_WHEN);
    // Strictly increasing, like the journals themselves — this list IS the evidence a database
    // took the single-journal path, so a duplicate in it would weaken the proof.
    for (let i = 1; i < LEGACY_JOURNAL_WHENS.length; i++) {
      expect(LEGACY_JOURNAL_WHENS[i]!).toBeGreaterThan(LEGACY_JOURNAL_WHENS[i - 1]!);
    }
  });

  it("is a SUPERSET of the retained pre-split folder, by exactly the billing entry", () => {
    // The constant is what a pre-split DATABASE HAS — twenty-four rows in `drizzle.__drizzle_
    // migrations` — and no deletion in this tree can change that, so adoption still demands all
    // twenty-four. The FOLDER now holds twenty-three: `0018_billing` was the billing schema
    // expressed in SQL and that machinery is no longer part of this server.
    //
    // Stated as a superset with the ONE difference named, so the two cannot drift for any other
    // reason: an entry deleted from the folder without a line here still fails.
    const legacy = readJournalOf({ name: "legacy", dir: join(HERE, "..", "drizzle"), migrationsSchema: "drizzle" });
    const folder = legacy.map((e) => e.when);
    const BILLING_WHEN = 1785574486206;          // `0018_billing`, removed from the folder
    expect(folder).not.toContain(BILLING_WHEN);
    expect([...folder, BILLING_WHEN].sort((a, b) => a - b)).toEqual([...LEGACY_JOURNAL_WHENS]);
  });

  it("covers everything that predates the split, and NOT the migrations written since", () => {
    // This assertion used to read "covers the WHOLE of both journals today", and the word
    // TODAY was doing real work: it was true only while no migration had been authored after
    // the split. `0021_mailbox_address_unique` is the first that has been, so the whole-journal
    // form is now false BY DESIGN — an adopting production database must still APPLY it,
    // which is the entire point of the cutoff.
    //
    // So the property is stated the way it will stay true: adoptable means at-or-below the
    // cutoff, and the remainder is exactly the post-cutoff work. Both halves are checked, so
    // this cannot pass by adopting nothing or by adopting everything.
    const belowCutoff = (dir: typeof MAIL): number =>
      readJournalOf(dir).filter((e) => e.when <= LEGACY_CUTOFF_WHEN).length;

    expect(baselineEntries(MAIL)).toHaveLength(belowCutoff(MAIL));
    expect(baselineEntries(CLOUD)).toHaveLength(belowCutoff(CLOUD));

    // The pre-split bulk is still adoptable — production's adoptability depends on it, and a
    // cutoff that covered nothing would satisfy the line above just as well.
    expect(baselineEntries(MAIL).length).toBeGreaterThanOrEqual(21);
    // The cloud half used to assert its WHOLE journal was adoptable, which held only while no
    // cloud migration had been authored after the split. `0007_staff_users` was the first that
    // was, and `0008_account_suspension` the second — so the cloud side reads exactly like the
    // mail side above it: the bulk is adoptable, and the post-cutoff remainder (now TWO entries)
    // is named below rather than counted.
    // `- 2` → `- 3`: cloud 0009 is the THIRD cloud migration authored after the split, so the
    // post-cutoff remainder grows with it. Named below rather than counted.
    // `- 3` → `- 4`: cloud 0010 is the FOURTH, same rule.
    // `- 4` → `- 5`: cloud 0011 (the trial bounty's ledger vocabulary) is the fifth.
    // `- 5` → `- 6`: cloud 0012 (the billing suspension's nullable actor + provenance CHECK) is
    // the sixth.
    // `- 6` → `- 7`: cloud 0013 (the trial-once partial unique index and the refund cap) is the
    // seventh. NOTE for an adopting database: 0013's index cannot build over duplicate trial
    // grants, so the dedup runner's dry run (`apps/worker/run-trial-grant-dedup.ts`) belongs
    // BEFORE the apply pass on any database whose ledger predates it.
    // `- 7` → `- 8`: cloud 0014 (the trial bounty's source must name its own account) is the
    // eighth. It needs no such prelude — it replaces a BEFORE INSERT trigger function, so it
    // validates no existing row and can land over any history at all; rows already filed under
    // a foreign `trial:` source keep their place and only a NEW one is refused.
    // `- 8` → `- 9`: cloud 0015 (`attachment_staging`, the hosted send's upload tickets) is the
    // ninth. NOTE for an adopting database: it creates a NEW table and needs no prelude at all —
    // nothing existing is read, altered or validated, so it lands over any history. What it DOES
    // need is an operator step no migration can perform: the private staging BUCKET has to exist
    // before the API deploy that mints its first grant, because object storage is not a database
    // object and no SQL statement can create one.
    // `- 9` → `- 10`: cloud 0016 (`ai_attempt_claims`, the exclusive claim the AI spend gate holds
    // across a paid model call) is the tenth. Same shape as 0015 and it needs no prelude — a NEW
    // table, nothing existing read, altered or validated, so it lands over any history. Unlike
    // 0015 it needs no operator step either: there is no bucket, no key and no external object,
    // only the table. NOTE that an adopting database WITHOUT it does not fail loudly — the gate
    // swallows every error by contract, so a missing table degrades every Screener suggestion to
    // a 503 with the ledger untouched. `/health` carries a marker for the table's `expires_at` so
    // the deploy gate says it instead.
    // `- 10` → `- 11`: cloud 0017 (`oauth_auth_codes.twofa_at`, the real second-factor time
    // carried across the native PKCE hop) is the eleventh. It needs no prelude and no operator
    // step: ONE nullable column with no default and no index, so it validates no existing row and
    // lands over any history — and there is nothing to backfill FROM, nor anything worth
    // backfilling, since every row in that table expires sixty seconds after it is written.
    // NOTE for an adopting database, and it is the opposite failure mode from 0016's: a database
    // missing this column breaks a WRITE, not a read — the authorize insert names a column that is
    // not there — on a route no shipped client calls, so nothing would look wrong while the
    // provenance the column carries was simply absent. `/health` carries a marker for it.
    // `- 11` → `- 12`: cloud 0018 (`invites.confers_verified` — does redeeming this invite prove
    // address control?) is the twelfth. It needs no prelude and no operator step: one column,
    // `NOT NULL DEFAULT true`, so it validates no existing row, lands over any history, and the
    // default IS the backfill — every pre-existing invite was minted by a path that mails, so
    // TRUE preserves each one's earned semantics. `/health` carries a marker for it.
    // `- 12` → `- 13`: cloud 0019 (`billing_subscriptions.storage_bytes_limit` — the managed
    // stored-body cap, the third sold-at allowance) is the thirteenth. It needs no prelude and
    // no operator step: ADD COLUMN, a seed UPDATE from the plan card (rows sold before the
    // column existed — today's card is the only honest value, and every existing customer
    // GAINS an entitlement), then SET NOT NULL — three statements precisely so the NOT NULL
    // lands on a populated column over any history. `/health` carries a marker for it.
    // `- 13` → `- 16`: cloud 0020 (the 2026-08-21 re-pricing's row migration — three
    // value-idempotent UPDATEs, no DDL, lands over any history), cloud 0021 (the setup pool's
    // two NEW tables — the 0015/0016 shape, no prelude, no operator step; `/health` carries
    // column markers for both) and cloud 0022 (the add-on quantities + billing cadence on the
    // mirror row — ADD COLUMN with defaults plus re-runnable CHECK pairs, lands over any
    // history; `/health` carries markers) are the fourteenth through sixteenth.
    // `- 16` → `- 17`: cloud 0023 (the billing reconciliation run ledger — one NEW table, the
    // 0015/0016 shape: no prelude, no operator step, lands over any history; `/health` carries
    // a column marker and an index marker) is the seventeenth.
    // `- 17` → `- 18`: cloud 0024 (the reuse-revocation reads' partial index on auth_events —
    // one CREATE INDEX IF NOT EXISTS, no prelude, no operator step, lands over any history;
    // `/health` carries an index marker, which is the migration's whole probe) is the
    // eighteenth.
    // `- 18` → `- 19`: cloud 0025 (`alert_state.notified_signature` — the renotify policy's
    // condition signature: one nullable ADD COLUMN IF NOT EXISTS, no prelude, no data, no
    // operator step, lands over any history; `/health` carries a column marker) is the
    // nineteenth.
    // `- 19` → `- 20`: cloud 0026 (`alert_state.claimed_until` — the notify claim's lease as
    // its own column: same one-statement shape as 0025, no prelude, no data, no operator
    // step; `/health` carries a column marker) is the twentieth.
    // `- 20` → `- 21`: cloud 0027 (`mailbox_oauth_device_ceremonies` — the device-code door's
    // in-flight state) is the twenty-first. Same shape as 0015/0016: a NEW table plus one
    // index, `IF NOT EXISTS` on both, nothing existing read, altered or validated, so it lands
    // over any history with no prelude and no operator step.
    //
    // NOTE for an adopting database, and it is the opposite of what the migration's own header
    // suggests: that header says the table is "inert on a deployment that never arms a public
    // client", because only the self-host composition mounts the device-flow routes. True of
    // the ROUTES and false of the DEPLOY — `health-cloud.ts` carries a census marker for this
    // table's `poll_interval_ms`, so an API build at this journal answers
    // `503 schema_incomplete` against a database still at 0026 whether it ever mounts a device
    // route or not. The table is owed before the API deploy on EVERY deployment, managed
    // included. Measured on the hosted service 2026-09-01: `to_regclass` NULL, `/health` reporting
    // `through … cloud 0026_alert_claim_lease`, 27 of 28 cloud entries applied.
    //
    // 21 → 22 for cloud `0028_credit_rollup_and_account_setup_grant`. Same shape as 0027 and one
    // sentence more, because this one has an ALTER on a table that already holds rows: three new
    // tables and two indexes are `IF NOT EXISTS`, `setup_grants.kind` is
    // `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT 'mailbox'` (so every existing pool keeps
    // meaning what it meant, with no backfill), and the partial unique index binds only
    // `kind = 'account'` rows, of which an adopting database has none. No prelude, no operator
    // step. It IS owed before the API deploy on every deployment, managed included:
    // `health-cloud.ts` carries four column markers and two index markers for it, so an API
    // build at this journal answers `503 schema_incomplete` against a database still at 0027 —
    // and `grantSetupCredits` writes `kind` on every first connection, so a too-early API 42703s
    // inside the mailbox-create transaction. Deploy order: migration → API → worker.
    //
    // 22 → 23 for cloud `0029_billing_invoices_platform_costs_ai_usage`. Three new tables and
    // three indexes, all `IF NOT EXISTS`; two `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT 0` on
    // `billing_reconciliation_runs` (a populated table on any deployment that has reconciled,
    // and 0 is true of every existing row — those passes examined no invoices); and one CHECK
    // REPLACEMENT under an existing name, `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`,
    // which is 0011's shape and is re-runnable. Nothing is read, validated or backfilled, so it
    // lands over any history with no prelude and no operator step.
    //
    // It is owed before the API deploy on every deployment, managed included, and the loud reason
    // is `billing_invoices`: the webhook apply writes an invoice row inside the SAME transaction
    // that grants a paid month's credits, so an API at this journal against an 0028 database
    // 42P01s inside `applyInvoicePaid` — a genuinely paid invoice parked as `failed` and retried
    // for three days while the customer holds no credits. `health-cloud.ts` carries four column
    // markers, two index markers and one CHECK-DEFINITION marker for it, so that deploy answers
    // `503 schema_incomplete` instead. Deploy order: migration → API → worker.
    // `- 23` → `- 24`: cloud 0030 (the incident/signal split, the alerting's own pulse and the
    // platform's request counts). ADDITIVE in every statement — two new tables, three defaulted
    // or nullable columns on `alert_state` and one nullable column on `worker_heartbeats`, plus
    // three CHECKs added under the `DROP … IF EXISTS` / `ADD` shape 0011 established, which is
    // re-runnable. Nothing is read, validated or backfilled.
    //
    // Owed before the API deploy, and the reason is quieter than 0029's but the same shape: the
    // alert pass INSERTS `alert_state.cls` on every observation, so an API at this journal
    // against an 0029 database 42703s inside `runAlertPass` — and that pass is the one whose
    // failure is by construction silent, because its whole job is to be the thing that notices.
    // `health-cloud.ts` carries markers for both new tables and for `cls`, so that deploy answers
    // `503 schema_incomplete` instead. Deploy order: migration → harden-staff-role → API → worker.
    // `- 24` → `- 25`: cloud 0031 (the roll-up's run row learns its backlog and its duration).
    // ADDITIVE and the smallest shape in this list — two nullable `ADD COLUMN`s with no default,
    // so PostgreSQL rewrites no rows and every existing run row keeps NULL in both, which is the
    // truthful reading for passes that predate the fold. Nothing is read, validated or backfilled.
    //
    // Owed before the API deploy, and its loudness is the SWALLOWED kind. The roll-up's run-row
    // INSERT names both columns and that write's failure is caught by contract — a pass that did
    // its work must not report as one that did nothing — so a worker at this journal against an
    // 0030 database 42703s inside it and the only symptom is a run ledger that stops gaining
    // rows, after which the console reads its freshness stamp off the newest row and calls the
    // aggregates stale when they are not. `loadRollupState` also SELECTs `setup_sweep_backlog`,
    // so the Billing board's read fails outright. `health-cloud.ts` carries one column marker for
    // the pair (they land in one statement order, so the second implies the first), which turns
    // both into a refused deploy. Deploy order: migration → API → worker → admin.
    // `- 25` → `- 12`: the cloud journal lost fifteen entries and gained one, and thirteen of
    // the fifteen sat ABOVE the cutoff — so the remainder shrank by thirteen while the adoptable
    // set below the cutoff lost two (`0002_billing` and `0008_account_suspension`). Both halves
    // are checked by the line above, which is what stops this number from being a guess.
    // `- 12` → `- 13`: cloud 0033 (`api_faults`) is ONE entry ABOVE the cutoff, so the
    // journal grew by one and the adoptable set below the cutoff did not move.
    // `- 13` → `- 14`: cloud 0034 (`webauthn_challenges_expires_idx`) is the next such entry,
    // same rule — an index on an existing table, above the cutoff, adopting nothing.
    // `- 14` → `- 15`: cloud 0035 (the two open-ceremony indexes on that same table) is the next
    // again, same rule — indexes on an existing table, above the cutoff, adopting nothing. One
    // ENTRY however many statements it carries: this counts journal entries, not statements.
    // `- 15` → `- 16`: cloud 0036 (the staff step-up stamp and the pending TOTP pair) is the next
    // again — one entry above the cutoff, adopting nothing. It needs no prelude: `last_twofa_at`
    // lands NOT NULL with a default so no existing session row is read or invalidated, and the
    // pending pair is nullable. Owed before the API deploy, and loudly — an API at this journal
    // against an 0035 database fails every staff sign-in at the insert; `health-cloud.ts` carries
    // three column markers, one per table it touches. Deploy order: migration → API.
    // `- 16` → `- 17`: cloud 0037 (`credit_refund_obligations`) is the next again — ONE entry
    // above the cutoff, so the journal grew by one and the adoptable set below it did not move.
    // It creates a NEW table and adopts nothing, so an adopting database runs it over any history.
    // `- 17` → `- 18`: cloud 0038 (`account_isolation`) is the next again — ONE entry above the
    // cutoff, so the journal grew by one and the adoptable set below it did not move. It adds
    // keys and nulls the ids of audit rows whose parent an erasure removed; it creates no table
    // and adopts nothing, so an adopting database runs it over any history.
    // `- 18` → `- 19`: cloud 0039 (`screener_suggest_owed`) is the next again — ONE entry
    // above the cutoff, so the journal grew by one and the adoptable set below it did not move.
    // It creates a NEW table, empty, and adopts nothing, so an adopting database runs it over
    // any history.
    // `- 19` → `- 20`: cloud 0040 (`account_lifecycle_notices`) is the next again — ONE entry
    // above the cutoff, so the journal grew by one and the adoptable set below it did not move.
    // It creates a NEW table, empty, and adopts nothing, so an adopting database runs it over
    // any history.
    // `- 20` → `- 21`: cloud 0041 (`attachment_staging.content_sha256`) — ONE entry above the
    // cutoff, a nullable column and its CHECK on an existing table, adopting nothing.
    // `- 21` → `- 22`: cloud 0042 (`desktop_approval`, renumbered from 0041 at the landing) —
    // ONE entry above the cutoff, additive columns, a dropped NOT NULL and a CHECK on an existing
    // table, adopting nothing.
    // `- 22` → `- 23`: cloud 0043 (`erased_bearers`) — ONE entry above the cutoff, a NEW table,
    // empty, adopting nothing.
    // `- 23` → `- 24`: cloud 0044 (the `upstream_refused` sample cause) — ONE entry above the
    // cutoff, a CHECK redefined on an existing table, adopting nothing.
    // `- 24` → `- 25`: cloud 0045_attachment_staging_digest_validate (0041's CHECK
    // validated) — ONE entry above the cutoff, a VALIDATE on an existing table, adopting nothing.
    // `- 25` → `- 26`: cloud 0046_totp_pending_replacement (the authenticator
    // replacement's pending trio) — ONE entry above the cutoff, three nullable columns and their
    // CHECK on an existing table, adopting nothing.
    // `- 26` → `- 27`: cloud 0047_staff_roles_and_audit — ONE entry above the cutoff, two NEW
    // tables, a backfill from `staff_users` and a trigger on the new one, adopting nothing.
    // `- 27` → `- 28`: cloud 0048_alert_driver_gaps — ONE entry above the cutoff, a NEW table,
    // empty, adopting nothing.
    // `- 28` → `- 29`: cloud 0049_alert_driver_gaps_staff_grant — ONE entry above the cutoff, a
    // role-guarded grant on 0048's table, adopting nothing.
    // `- 29` → `- 30`: cloud 0050_billing_link_notices — ONE entry above the cutoff, a CHECK
    // redefined on an existing table, adopting nothing.
    // `- 30` → `- 31`: cloud 0051_alert_drills — ONE entry above the cutoff, a NEW table, its index
    // and a role-guarded grant on it, adopting nothing.
    // `- 31` → `- 32`: cloud 0052_lifecycle_notice_delivered — ONE entry above the cutoff, a column
    // on an existing table and a backfill of its earlier rows, adopting nothing.
    // `- 32` → `- 33`: cloud 0053_connect_reminder_notices — ONE entry above the cutoff, a CHECK
    // redefined on an existing table, adopting nothing.
    expect(baselineEntries(CLOUD).length).toBe(readJournalOf(CLOUD).length - 33);

    // And the entries above the cutoff are REAL migrations that must run, not an empty set.
    // Listed by TAG rather than counted, so a new one has to be named here on purpose — this
    // is the exact set an adopting production database still applies.
    const above = readJournalOf(MAIL).filter((e) => e.when > LEGACY_CUTOFF_WHEN);
    expect(above.map((e) => e.tag)).toEqual([
      "0021_mailbox_address_unique",
      "0022_message_body_html_cap",
      "0023_mailbox_failure_reason",
      "0024_flag_state",
      "0025_mailbox_kickstart",
      "0026_thread_resolution",
      "0027_organizer_lease",
      "0028_message_instances",
      "0029_mailbox_sync_block",
      "0030_sensitive_rescreen",
      "0031_tags",
      "0032_unsubscribe_records",
      "0033_workflow_run_claim",
      "0034_rule_retro",
      "0035_account_settings",
      "0036_sensitive_fp_backfill",
      "0037_draft_html",
      "0038_initial_import_completed",
      "0039_mailbox_retry_after",
      "0040_auto_suggest",
      "0041_message_failures",
      "0042_screening_preference",
      "0043_ohbox_tidy",
      "0044_dormancy_days_max",
      "0045_draft_bcc",
      "0046_screener_auto_apply",
      "0047_read_order",
      "0048_remote_images_default",
      "0049_mailbox_sync_requested_at",
      "0050_rule_subject_contains",
      "0051_away_responder",
      "0052_rule_body_contains",
      "0053_account_locale",
      "0054_auto_unsubscribe_optout",
      "0055_mailbox_smtp_max_size",
      "0056_screening_baseline",
      "0057_message_from_name",
      "0058_reconcile_backoff",
      // mail 0059 (`pairing_tokens`, the pairing-token lifecycle) — a NEW table, so it needs no
      // prelude and no operator step: nothing existing is read, altered or validated, and it
      // lands over any history. NOTE for an adopting database: a database missing it degrades
      // only the self-host pairing surface (42P01 on `/pair*`), and `/health` carries a marker
      // for `pairing_tokens.token_hash` so the deploy gate names the missing migration.
      "0059_pairing_tokens",
      // mail 0060 (`refresh_tokens` moves to the shared half, Phase 3) — every statement
      // guarded, so an adopting database (which already HAS the table from the cloud journal or
      // the legacy path) applies it as a no-op, and only a mail-only desktop store actually
      // builds anything. NOTE for an adopting database: nothing to do; `/health` carries a
      // marker for `refresh_tokens.family_id` that names the migration on a store missing it.
      "0060_refresh_tokens",
      // mail 0061 (plain browser sign-ins stop owning device rows — DEVICES) — a DATA backfill,
      // idempotent and narrowly scoped (see its `POST_SPLIT_STATEMENTS` entry): it detaches
      // sessions from auto-minted "Web" device rows and deletes the unreferenced rows; it
      // revokes nothing and creates no object. NOTE for an adopting database: nothing to do —
      // a store that skips it merely renders legacy "Web" rows as named devices until the two
      // statements run, and a re-run later converges (`/health` carries no marker because a
      // data-only migration is unprobeable; the tag bump beside MAIL_SCHEMA_MARKER_JOURNAL_TAG
      // carries the reasoning).
      "0061_web_sessions_deviceless",
      // mail 0062 (`account_storage` + `message_bodies.withheld_reason` — the managed storage
      // cap's accounting) — a NEW table, a nullable column with a closed-set CHECK, and a
      // RECOMPUTING backfill (`ON CONFLICT … DO UPDATE`), so it needs no prelude and lands over
      // any history. NOTE for an adopting database: re-run the backfill statement once after
      // the worker that maintains the counter is live — between migration and worker deploy the
      // old worker ingests uncounted bodies, and the re-run recomputes rather than preserves.
      // `/health` carries markers for `account_storage.bytes` and
      // `message_bodies.withheld_reason`.
      "0062_storage_accounting",
      // mail 0063 (`mailboxes.smtp_size_probed_at` + `smtp_size_probe_code` — the `SIZE`
      // back-fill's durable attempt stamp) — two nullable columns and a re-runnable closed-set
      // CHECK, no prelude, no backfill, so it lands over any history. NOTE for an adopting
      // database: nothing to do. A database missing it keeps the pre-0063 behaviour, which is a
      // scheduled pass that re-dials an un-learnable submission server once a day; `/health`
      // carries markers for the column and for `mailboxes_smtp_size_probe_code_closed`, so a too-
      // early API says `503 schema_incomplete` and names the file instead of 42703-ing the mailbox
      // list.
      "0063_smtp_size_probe_stamp",
      // mail 0064 (`devices.last_synced_at` — the per-device sync-horizon stamp the
      // `device_sync_stale` alert reads) — one nullable column, no default, no backfill (a
      // backfilled now() would assert a convergence nobody observed), so it lands over any
      // history. NOTE for an adopting database: nothing to do; devices stamp themselves on
      // their next horizon-reaching `GET /sync`. `/health` carries the column marker, so a
      // too-early API says `503 schema_incomplete` instead of 42703-ing the device list.
      "0064_device_sync_stamp",
      // mail 0065 (the provider's own Junk/Trash paths on `mailboxes`, `messages.deleted_at`,
      // and two new withheld-reason members) — additive columns plus a re-runnable CHECK, no
      // prelude. NOTE for an adopting database: the worker's connect-time discovery fills the
      // folder paths on each mailbox's next attach; until then deletes are refused up front
      // exactly as a mailbox with no Trash is.
      "0065_junk_trash_delete",
      // mail 0066 ("Use folders" — account_settings.folders_enabled_at, the folders
      // foundation's opt-in flag; NULL = off = the pre-feature wire) — one additive nullable
      // column, no prelude, no backfill. NOTE for an adopting database: nothing to do; every
      // account starts with folders off and turns them on itself. See 0069, its reissue.
      "0066_folders_enabled",
      // mail 0067 (a SECURITY DEFINER carrier for the device-sync alert) — WITHDRAWN by 0068
      // the same night: the staff-role attestation refuses any executable secdef routine by
      // construction, and the provisioner's pre-flight aborts while one exists. Kept in the
      // journal because a journal is append-only; the pair nets to nothing.
      "0067_device_sync_health",
      // mail 0068 retires 0067's function (DROP IF EXISTS — a database that never applied 0067
      // drops nothing). The alert reads plain allowlisted columns instead; NOTE for an adopting
      // database: run the staff-role provisioner after migrating, as the runbook already says.
      "0068_retire_device_sync_fn",
      // mail 0069 — 0066's one idempotent statement, re-run from above the journal maximum
      // (0066's first entry position was skippable on any database that migrated between two
      // lanes' landings; REISSUED_ORIGINALS in baseline.ts carries the full account). NOTE for
      // an adopting database: a no-op wherever 0066 already ran.
      "0069_folders_enabled_reissue",
      // mail 0070 (sessions.last_synced_at — the per-SESSION sync-horizon stamp, 0064's twin
      // for deviceless installs) — one additive nullable column, no prelude, no backfill.
      // NOTE for an adopting database: run the staff-role provisioner after migrating (the
      // session_sync_stale alert reads the widened sessions/auth_events grants), as 0068's
      // note already says.
      "0070_session_sync_stamp",
      // mail 0071 — the husk-provenance partial index (`message_bodies_withheld_idx`, on the
      // withheld marker being set) the worker's junk_filed convergence pass reads by. One
      // `CREATE INDEX IF NOT EXISTS`, no column, no DML. NOTE for an adopting database: a plain
      // in-transaction build; the husk population is small, so the lock is brief.
      "0071_withheld_provenance_index",
      // mail 0072 — the opt-out of tracking-pixel BLOCKING (`account_settings.
      // load_tracking_pixels_at`; NULL = blocked, the default). One additive nullable column,
      // no prelude, no backfill. NOTE for an adopting database: a catalog-only change on a
      // one-row-per-account table; nothing to run afterwards.
      "0072_tracking_pixels_optout",
      // mail 0073 — the per-mailbox "Use folders" exception stamp
      // (`mailboxes.folders_disabled_at`; NULL = the mailbox's folders show under the master
      // flag, the default). One additive nullable column, no prelude, no backfill. NOTE for an
      // adopting database: a catalog-only change; nothing to run afterwards.
      "0073_mailbox_folders_optout",
      // mail 0074 — the user-commanded folder verbs' command table (`folder_ops`: create /
      // rename / delete recorded by the API, executed by the worker inside the serial cycle,
      // deleted on completion). One CREATE TABLE with its CHECKs inside, two guarded FKs, no
      // DML. NOTE for an adopting database: a new empty table; nothing to run afterwards.
      "0074_folder_ops",
      // mail 0075 — the per-mailbox signature text (`mailboxes.signature`; NULL = no
      // signature, the default). One additive nullable column, no prelude, no backfill. NOTE
      // for an adopting database: a catalog-only change; nothing to run afterwards.
      "0075_mailbox_signature",
      // mail 0076 — the one-time Quarantine→\Junk sweep's command stamp
      // (`mailboxes.junk_sweep_requested_at`; NULL = no sweep owed, the default). One additive
      // nullable column, no prelude, no backfill. NOTE for an adopting database: a catalog-only
      // change; nothing to run afterwards.
      "0076_junk_sweep_request",
      // mail 0077 — Send later: the draft's appointment (`drafts.send_at` + `send_key` +
      // `send_error`; NULL = no appointment / no failure, every existing row) and the worker's
      // partial due-scan index. Three additive nullable columns, one partial index, no prelude,
      // no backfill. NOTE for an adopting database: a catalog-only change; nothing to run
      // afterwards.
      "0077_send_later",
      // mail 0078 — the forwarding-detection notice's evidence pair
      // (`mailboxes.inbound_quiet_since` + `inbound_quiet_dismissed_at`; NULL = no quiet
      // episode / never dismissed, every existing row). Two additive nullable columns, no
      // prelude, no backfill. NOTE for an adopting database: a catalog-only change; nothing to
      // run afterwards.
      "0078_inbound_quiet",
      // mail 0079 — the erasure fence's marker (`accounts.erased_at`; NULL = never erased,
      // every existing row). One additive nullable column, no prelude, no backfill. NOTE for an
      // adopting database: a catalog-only change; nothing to run afterwards — accounts erased
      // before the column existed stay unstamped on purpose (no writer they could fence).
      "0079_erasure_fence",
      // mail 0080 — the authentication lookup's index (`sessions (access_token_hash)`; no
      // column, no data). One CREATE INDEX, no prelude, no backfill. NOTE for an adopting
      // database: a catalog-only change; nothing to run afterwards. LISTED LATE — it landed
      // without this line, without its `journal-split.test.ts` entry and count, and without
      // `search-extensions.pg.test.ts`'s MAIL_ENTRIES bump, so both suites were red at HEAD
      // from that commit until mail 0081 paid all four.
      "0080_sessions_access_token_hash_idx",
      // mail 0081 — the one-time sensitivity re-screen's resume point and the instant of the
      // walk it belongs to (`mailboxes.sensitive_rescreen_cursor` +
      // `sensitive_rescreen_started_at`; NULL = no walk in progress, every existing row). Two
      // additive nullable columns, no prelude, no backfill. NOTE for an adopting
      // database: a catalog-only change; nothing to run afterwards — and NULL is the only
      // correct value to adopt with, because a back-filled resume point would declare a prefix
      // examined that nothing examined and the pass would skip it.
      "0081_sensitive_rescreen_cursor",
      // mail 0082 — the account-wide appearance face (`account_settings.theme_face`,
      // `'paper' | 'ohmarchy'` or NULL, plus its closed-set CHECK). One additive nullable
      // column, no prelude, no backfill. NOTE for an adopting database: a catalog-only
      // change; nothing to run afterwards — and NULL is the only correct value to adopt
      // with: it means "no account-wide choice", and back-filling a face would stamp a
      // choice nobody made onto every device of the account.
      "0082_theme_face",
      // mail 0083 — the organizing role, split off the connection (`mailboxes.organizer_role`
      // and the four holder columns, `organize_consented_at`, `account_settings.
      // onboarding_completed_at` and `screening_scope`, `mailbox_folders.server_exists`, four
      // closed-set CHECKs). NINE additive columns AND — unlike every entry above it since 0062 —
      // TWO DATA BACKFILLS. NOTE for an adopting database: the backfills are the whole reason
      // this one is not catalog-only, and they must run WITH the schema rather than afterwards.
      // (1) promotes stood-down rows (`disabled` + an `organized_elsewhere:*` reason) to
      // connected READERS, guarded on the partial unique index so a row whose address was
      // re-connected in the meantime stays disabled instead of failing the migration; (2) stamps
      // `organize_consented_at` on every connected row, because connecting a mailbox WAS the
      // consent under the old copy. Skip (2) and the deploy demotes every live mailbox to reader.
      "0083_organizer_role",
      // mail 0084 — `accounts.ai_answered_at`, the fact `ai_enabled` cannot carry because its
      // resting value is `true` and a resting value is not an answer.
      "0084_ai_answered",
      // mail 0085 — the rows the OLD worker wrote after 0083's backfill had already run: stranded
      // `disabled` readers, off the roster, unreachable by the new worker for ever. Data only.
      "0085_heal_disabled_readers",
      // mail 0086 — the same heal with the sibling test on the ADDRESS rather than the account,
      // which is the hole 0085 had. Data only, and a no-op on today's rows.
      "0086_heal_reader_address_wide",
      // mail 0087 — the away responder's per-person throttle, its reply ledger and the enablement
      // instant. Purely additive: two columns on `away_responders`, two new tables, no drop and no
      // rename, so an adopting database applies it like any other. Its one guarded UPDATE and its
      // `ON CONFLICT DO NOTHING` seed are both re-runnable, which is what a desktop replaying this
      // journal at every launch depends on.
      "0087_away_reply_throttle",
      // mail 0088 — symmetric takeover: the notice's two instants, the release request and the
      // reader's request queue. Purely additive (three nullable columns on `mailboxes`, one new
      // table) with NO data statement at all, so an adopting database applies it like any other
      // and a desktop replaying this journal at every launch re-runs it as a no-op — the two
      // CHECKs are written DROP-then-ADD and the table and columns are `IF NOT EXISTS`.
      "0088_symmetric_takeover",
      // mail 0089 — the fifth holder column, `mailboxes.organized_by_capabilities`: what the
      // holder offers a reader, comma-joined off its claim's `X-Ohmail-Capabilities`. One
      // additive nullable column, no prelude, no backfill. NOTE for an adopting database: a
      // catalog-only change; nothing to run afterwards — and NULL is the only correct value to
      // adopt with, on 0088's own reason: an existing row has no capability observation under a
      // build that records one, and the fail-safe reading of NULL is "do not offer a request".
      "0089_organizer_capability",
      // mail 0090 — the `refused` state an organizer's acknowledgement carries back, the reason it
      // carries, and the Screener list's own `(account_id, state)` index. One additive nullable
      // column, one WIDENED CHECK, no prelude, no backfill. NOTE for an adopting database: a
      // catalog-only change; nothing to run afterwards.
      //
      // The tag names a key column it does not create, and that is not drift: the signing key
      // behind this channel is derived from the mailbox password at use and never stored, so the
      // columns an earlier cut of this migration carried are gone. Journal tags are immutable once
      // an adopting database has recorded one, so the name stays and the migration's own header
      // explains it.
      "0090_request_key",
      // mail 0091 — the CHECK that closes `organizer_requests.refused_reason` to the eight-word
      // refusal vocabulary. NO COLUMN: 0090 shipped the column as free text and the write path was
      // already closed in code, which is precisely the argument the operator console's isolation
      // sweep cannot check — it sees constraints, not parsers. So the set moves into the schema.
      //
      // NOTE for an adopting database: it carries ONE data statement, and that is the only thing
      // here worth a second look. The `UPDATE` forgets a reason outside the set, and it cannot fire
      // against any database this fleet has produced — no write path could have put an unrecognised
      // word there. It exists because the alternative to a repair is a FAILED MIGRATION at
      // somebody's launch, and because NULL is already this column's own word for "a refusal I
      // cannot name". Nothing to run afterwards.
      "0091_request_refusal_closed",
      "0092_organizer_install_id",
      // mail 0093 — one new table, its UNIQUE constraint and its CHECK: the account's claim on the
      // CONTENT of a send, which is what refuses a second copy of a message when the client has lost
      // the key that used to be the only defence.
      //
      // NOTE for an adopting database: purely additive and NO data statement at all. Nothing here
      // touches an existing table, so it cannot fail on rows a database already holds, and there is
      // nothing to run afterwards. Deploy order is migration → API: the API is the only writer and
      // answers 42P01 against an un-migrated database.
      "0093_outbound_send_fingerprints",
      // mail 0094 — two more members on `organizer_requests.kind` (`message.move`,
      // `profile.update`) and the new `mailbox_profile_mirror` table, where an install that only
      // READS a mailbox keeps the configuration document the organizer publishes.
      //
      // NOTE for an adopting database: nothing to run afterwards, and no prelude. The CHECK is
      // WIDENED — dropped and re-added with the four existing members plus two — so it validates
      // every existing row successfully whatever they hold, and the table is new, so nothing
      // existing is read or altered. A database missing this migration does not fail loudly: the
      // widened kinds are refused by the CHECK on INSERT, which is a write nothing shipped
      // performs until the reader doors land, and the mirror's absence degrades a settings pane
      // to "no profile yet" rather than erroring. `/health` carries markers for the table and the
      // constraint, so a too-early API answers `503 schema_incomplete` and names the file.
      "0094_request_kinds_moves_profile",
      //
      // NOTE for an adopting database: no data statement at all. Two nullable columns with no
      // default, one `DROP NOT NULL`, and one foreign key dropped and re-added to change its
      // delete action from NO ACTION to SET NULL — so a discard of a draft whose send is over
      // clears the reference and KEEPS the record of the attempt. PostgreSQL rewrites no rows
      // for any of it, and every existing row reads NULL/NULL, which is the truthful value:
      // nobody has resolved anything before this exists. Nothing to run afterwards.
      "0095_outbound_send_resolution",
      // mail 0096 — the away responder's pile scope and the bounce record. TWO columns and one
      // CHECK, additive throughout.
      //
      // NOTE for an adopting database, and it is a BEHAVIOUR change rather than a schema one: the
      // `piles` default is `{INBOX}`, so a responder that is enabled when this runs stops
      // answering mail filed to Reads or Receipts. That is the migration's purpose (a responder
      // set to "people I've let in" answered senders let in once whose later mail files itself
      // away), and the narrow default is deliberate — a reply already sent to somebody its owner
      // did not mean cannot be recalled, and opting Reads back in is one press.
      //
      // It carries ONE data statement, a repair, and it is the only thing here worth a second
      // look. The `UPDATE` narrows a `piles` value outside the closed set and cannot fire against
      // any database this fleet has produced: the column is created two statements earlier, so no
      // writer has ever seen it. It exists because the alternative to a repair is a FAILED
      // MIGRATION at somebody's launch. Nothing to run afterwards.
      "0096_away_piles",
      // mail 0097 — `folder_state.last_error_class`, one nullable text column and one CHECK over a
      // four-word set (`refused | no_such_folder | read_only | over_quota`). The status line that
      // reports the filings a mail server has not applied had one sentence for every reason a
      // filing can be outstanding, and this is the operand that tells a refusal from a turn not
      // yet taken.
      //
      // NOTE for an adopting database: additive, nullable, no default and NO backfill, so
      // PostgreSQL rewrites no rows and every existing row reads NULL — which is the truthful
      // value, because a refusal that was never recorded cannot be reconstructed. Both statements
      // are idempotent, and nothing runs afterwards.
      //
      // ITS `idx` IS 97 AND ITS TAG SAYS 0097, and the two are numbered for different things: the
      // FILE is numbered for the position this migration takes on main, the ENTRY for the position
      // it occupies in the journal it is appended to. They meet here because all three mail
      // migrations this wave numbered ahead of it — 0094, 0095, 0096 — landed first, which is the
      // same coincidence-restored the 0095 and 0096 notes above insist on naming. Both numbers are
      // RE-READ from the landed journal at every rebase, the `when` in particular: two lanes taking
      // "the maximum plus one" in parallel collide, and drizzle then records the later one as
      // applied without running it.
      "0097_folder_state_last_error_class",
      // mail 0098 — the signature's markup half. ONE additive nullable column, no default, no
      // CHECK and no data statement, so an adopting database applies it without a rewrite and
      // with nothing to run afterwards.
      "0098_signature_html",
      // mail 0099 — the folder a delete moved a message out of. ONE additive nullable column, no
      // default, no CHECK and no data statement, so an adopting database applies it without a
      // rewrite and with nothing to run afterwards.
      "0099_folder_state_trashed_from",
      // mail 0100 — the one-time re-stamp of mail a second install of the account filed. NO schema
      // change at all: one DML statement over `folder_state.last_set_by`, and the only statement in
      // this journal that rewrites a column on rows it did not create, so it is the one entry here
      // that genuinely needs the second look 0096's note asks for.
      //
      // NOTE for an adopting database: it CAN fire, unlike 0096's repair, because the rows it
      // matches were written by shipped code. Its predicate is three exclusions wide — the pair
      // agreed inside the ohmail namespace, no `move` for that message in the change log, the row
      // predates the corrected writer — so it cannot take a placement made by hand in someone's own
      // mail client, which always carries a `change_log` move. Idempotent by construction: a row it
      // writes stops matching `last_set_by = 'external'`. One anti-join, one pass, nothing to run
      // afterwards; the row count it touched is raised as a notice.
      "0100_reader_window_peer_restamp",
      "0101_away_piles_wider",
      // mail 102 — the fourth `sync_blocked_reason`. NO column and no table: it widens the
      // closed set on `mailboxes.sync_blocked_reason` by dropping the CHECK and re-adding it
      // under its own name, which is the shape 0094 uses to stay re-runnable.
      //
      // NOTE for an adopting database: it rewrites no row and cannot fail — every existing
      // value is inside the widened set — and both statements are idempotent, so a desktop
      // replaying this journal at each launch applies it repeatedly without effect. Nothing to
      // run afterwards.
      "0102_sync_blocked_reason_read_limited",
      // mail 103 — `mobile` joins the organizer kinds. NO column and no table: it widens TWO
      // closed sets on `mailboxes` (`organized_by_kind`, and `disabled_reason`, whose members
      // carry the kind as a suffix) by 0102's drop-then-re-add under each existing name.
      //
      // NOTE for an adopting database: it rewrites no row and cannot fail — every existing value
      // is inside both widened sets — and all four statements are idempotent, so a desktop
      // replaying this journal at each launch applies it repeatedly without effect. Nothing to
      // run afterwards.
      "0103_organizer_kind_mobile",
      // mail 104 — the VERB behind the takeover stamp. ONE additive column on `mailboxes`
      // (`takeover_intent text NOT NULL DEFAULT 'join'`) and the CHECK closing it to the two
      // members, added by 0102's drop-then-re-add under its own name.
      //
      // NOTE for an adopting database: the column arrives with a DEFAULT, so no row is rewritten
      // and the CHECK cannot fail — every value is that default. Both statements are idempotent,
      // so a desktop replaying this journal at each launch applies them repeatedly without
      // effect. Nothing to run afterwards.
      "0104_mailbox_takeover_intent",
      // mail 105 — the fifth `sync_blocked_reason`, so an install whose clock disagrees with its
      // mail server says the clock rather than reporting a folder it could not read. No column:
      // 0102's drop-then-re-add of the closed set under its own name, one member wider.
      //
      // NOTE for an adopting database: it rewrites no row and cannot fail — every existing value
      // is inside the widened set — and both statements are idempotent, so a desktop replaying
      // this journal at each launch applies them repeatedly without effect. Nothing to run
      // afterwards.
      "0105_sync_blocked_reason_clock_off",
      // mail 106 — the NULL screening baselines of consented mailboxes. NO column, no table and
      // no constraint: one guarded INSERT … SELECT that gives an account which consented under
      // the old door the instant it first agreed.
      //
      // NOTE for an adopting database: this one DOES rewrite rows, and that is the point — it is
      // the only entry in this list that repairs data rather than shape. It writes only where the
      // baseline is absent or NULL (the conflict arm’s own `WHERE`), so a live cutline is never
      // moved and a desktop replaying this journal at each launch applies it repeatedly without
      // effect. Nothing to run afterwards.
      "0106_screening_baseline_backfill",
      // mail 107 — one nullable column on `rules`, the press that releases mail held at the
      // screening gate. NOTE for an adopting database: it rewrites no row, cannot fail, and is
      // `IF NOT EXISTS`, so a desktop replaying this journal at each launch applies it repeatedly
      // without effect. Nothing to run afterwards.
      "0107_release_held_at",
      // mail 0108 — the sign-out's durable stamp on `mailboxes`. One additive nullable column, no
      // prelude and no backfill. NOTE for an adopting database: a catalog-only change; nothing to
      // run afterwards, and NULL is the only correct value to adopt with — an existing row has no
      // sign-out to record, which is exactly what NULL means to every reader of the column.
      "0108_mailbox_signed_out_at",
      // mail 0109 — the one-time gate release's per-account marker on `account_settings`. One
      // additive nullable column, no prelude and no backfill. NOTE for an adopting database: a
      // catalog-only change; nothing to run afterwards, and NULL is the only correct value to
      // adopt with — it is what tells the pass this account has not been swept.
      "0109_gate_release_done_at",
      // mail 0110 — the resurface time on `account_settings`. One additive nullable text column,
      // no prelude and no backfill. NOTE for an adopting database: a catalog-only change; nothing
      // to run afterwards, and NULL is the only correct value to adopt with — it is what says
      // "this account has never chosen a time", which every reader renders as the built-in 09:00.
      "0110_resurface_time",
      // mail 0111 — the MAILBOX erasure fence's stamp on `mailboxes`. One additive nullable
      // timestamptz, no prelude and no backfill. NOTE for an adopting database: a catalog-only
      // change, and NULL is the only correct value to adopt with — it says "this mailbox's mirror
      // has not been erased", which is true of every mailbox a live database holds. Backfilling
      // it for already-removed mailboxes would refuse writes against mailboxes whose mail is
      // still there: only the erasure sweep may write this column.
      "0111_mailbox_erased_at",
      // mail 0112 — when an erasure replaced an idempotency row's stored response. One additive
      // nullable timestamptz on `idempotency_keys`, no prelude and no backfill. NOTE for an
      // adopting database: a catalog-only change; NULL is the only correct value to adopt with —
      // it says "no erasure has replaced this row's response", true of every row a live database
      // holds. Deleting the erased rows instead would let a retry re-apply its mutation.
      "0112_idempotency_erased_at",
      // mail 0113 — which attempt consumed a refresh token. One additive nullable text column on
      // `refresh_tokens`, no prelude and no backfill. NOTE for an adopting database: a catalog-only
      // change; nothing to run afterwards, and NULL is the only correct value to adopt with — it
      // says "this rotation named no attempt", which routes every existing row to the strict reuse
      // arm the server has always had.
      "0113_refresh_consumed_by_attempt",
      // mail 0114 — the away responder's rotation stamp on `away_responders`. One additive column,
      // no prelude and no backfill statement. NOTE for an adopting database: a catalog-only
      // change; nothing to run afterwards, and the column's own `to_timestamp(0)` default is the
      // only correct value to adopt with — it says "the pass has never walked this responder",
      // which puts every existing row at the FRONT of the first rotation rather than behind it.
      "0114_away_rotation_stamp",
      // mail 0115 — where a budgeted first sync stopped, two additive nullable columns on
      // `mailbox_folders`, no prelude and no backfill. NOTE for an adopting database: a
      // catalog-only change; nothing to run afterwards, and NULL is the only correct value to
      // adopt with — it says "this folder is not where the last pass stopped", which leaves every
      // existing mailbox leading exactly where it led before. A backfilled stop would send the
      // next pass to a folder nothing chose.
      "0115_first_sync_budget_stop",
      // mail 0116 — the unsubscribe drain's per-message mark, where its window walk stopped, and
      // the index over the window it walks. Two CREATE TABLEs, two CREATE INDEXes, no prelude and
      // no backfill. NOTE for an adopting database: EMPTY is the only correct state to adopt with
      // — a mark says the pass has LOOKED at a message, and inventing one would stop a message
      // being a candidate without anybody having judged it; an absent cursor says "start at the
      // head", which is what every run did before this migration.
      "0116_unsub_drain_cursor",
      // mail 0117 — `junk_rescues`, the junk rescue's desired state. ONE new table, its UNIQUE
      // constraint and one partial index: "not junk" becomes a command the organizer executes, so
      // the API stops opening IMAP to apply it.
      //
      // NOTE for an adopting database: purely additive and NO data statement at all. Nothing here
      // touches an existing table, so it cannot fail on rows a database already holds, and there
      // is nothing to run afterwards. Deploy order is migration → API → worker: the API is the
      // only writer and answers 42P01 against an un-migrated database, and the worker's pass reads
      // an absent table the same way with its failure caught per cycle.
      "0117_junk_rescues",
      "0118_account_isolation",
      // mail 0119 — one nullable column on `messages`, no default and no backfill, so an
      // adopting database runs it over any history and every pre-existing row keeps NULL,
      // which is what "arrival not recorded" means.
      "0119_messages_arrived_at",
      // mail 0120 — `account_settings.held_release_dismissed`, one nullable column with no
      // default and no backfill, plus its length CHECK under the `DROP … IF EXISTS` / `ADD`
      // re-runnable shape. NULL is the state to adopt with: nobody has dismissed an offer
      // yet, so the held-release offer shows on first read, which is the truthful reading.
      "0120_held_release_dismissed",
      // mail 0121 — `mailboxes.release_refusal`, one nullable text column with no default, no
      // index and no CHECK. NULL is the state to adopt with: no stop has been refused yet, so
      // every pane reads the ordinary pending sentence until a release pass writes one.
      "0121_release_refusal",
      // mail 0122 — the retention floor (NOT NULL DEFAULT 0 = nothing pruned, true for any
      // adopted history); one additive column, safe over any history.
      "0122_change_log_retention",
      // mail 0123 — `ohmail/News` joins the away scope's closed CHECK, drop-then-add under the
      // constraint's existing name. It WIDENS the set and narrows nothing, so it is safe over any
      // history: the legacy `ohmail/Reads` stays a member for scopes stored before the rename and
      // no row is rewritten. Nothing to adopt with — every scope an adopting database holds
      // already fits the wider set.
      "0123_news_pile_check",
      // mail 0124 — the wall's sixth `sync_blocked_reason` (`account_closed`): drop-then-add of
      // the CHECK under its existing name, idempotent, admits one more value and refuses nothing
      // a live table can hold — safe over any history. Its `when` is max+1 off the landed mail
      // journal, re-read at every rebase; it sits above 0123, which RENAME-022 took.
      "0124_sync_blocked_reason_account_closed",
      "0125_message_search",
      // mail 0126 — when a per-mailbox erasure finished: one additive nullable column, a
      // backfill that marks every older stamp done (those were one-transaction sweeps) and a
      // partial index over the owed pairs. Safe over any history; nothing to adopt with.
      "0126_mailbox_erasure_done",
      // mail 0127 — where a signed-out mailbox lives: one additive nullable column, no backfill.
      // Safe over any history; nothing to adopt with.
      "0127_mailbox_signed_out_meta",
      // mail 0128 — who made a rule's decision: one additive nullable column, no backfill.
      // Safe over any history; nothing to adopt with.
      "0128_rule_person_decided",
      // mail 0129 — a press of Import settings the organizer finishes: four additive nullable
      // columns, no backfill. Safe over any history; nothing to adopt with.
      "0129_profile_import_ask",
      // mail 0130 — the seventh sync-block member (drop-then-add of the CHECK) and one additive
      // nullable column with a guarded grant. Safe over any history; nothing to adopt with.
      "0130_mailbox_sync_soft_states",
      // mail 0131 — the four uid columns `integer` → `bigint`, no USING and no DML. Every value an
      // `integer` held fits, so it is safe over any history; the cost is the rewrite's lock.
      "0131_uid_bigint",
      // mail 0132 — the mailbox's own Sent folder: one additive nullable column, no backfill.
      // Safe over any history; nothing to adopt with.
      "0132_mailbox_sent_folder",
      // mail 0133 — the act on suggestions' consent and refusal: three additive nullable columns and
      // a NOT VALID CHECK over them, no backfill. Safe over any history; nothing to adopt with.
      "0133_screener_auto_act",
      // mail 0134 — one more withheld reason (drop-then-add of the CHECK, NOT VALID). Safe over
      // any history; nothing to adopt with.
      "0134_withheld_too_large",
      // mail 0135 — when the wall released a mailbox: one additive nullable column, no backfill.
      // Safe over any history; nothing to adopt with.
      "0135_organizer_parked_at",
      // mail 0136 — three `IF NOT EXISTS` index builds on small tables. Safe over any history.
      "0136_screener_probe_indexes",
      // The message a draft forwards: a nullable column with its key and CHECK, each
      // dropped before it is added, no backfill. Safe over any history; nothing to adopt with.
      "0137_draft_forward_of",
      // The Screener's automatic filing, put back: one nullable column, `IF NOT EXISTS`, no
      // backfill. Safe over any history; nothing to adopt with.
      "0138_auto_filing_undone_at",
      // The arrival order index: one `IF NOT EXISTS` build, prebuilt concurrently where the table
      // is large. Safe over any history; nothing to adopt with.
      "0139_messages_arrival_order",
      // The body vector kept by trigger: DROP EXPRESSION (catalog-only), a function, a trigger and
      // the failure CHECK widened NOT VALID, no backfill. Safe over any history; nothing to adopt with.
      "0140_body_tsv_bounded",
      // The auto-apply pass's floor verdict: one nullable column, `IF NOT EXISTS`, no backfill.
      // Safe over any history; nothing to adopt with.
      "0141_screener_floor_version",
      // The full meta folder named: the sync-block CHECK widened by drop-then-add, no backfill.
      // Safe over any history; nothing to adopt with.
      "0142_sync_blocked_reason_meta_folder_full",
      // The undeletable meta folder named: the sync-block CHECK widened by drop-then-add, no
      // backfill. Safe over any history; nothing to adopt with.
      "0143_sync_blocked_reason_meta_undeletable",
      // The person's decisions before their stamp: an index IF NOT EXISTS and two backfills whose
      // WHEREs read the trail as it stands and empty after one run. Safe over any history.
      "0144_rule_person_decided_backfill",
      // The stale-press stamp: three nullable columns, `IF NOT EXISTS`, no backfill. Safe over any
      // history; nothing to adopt with.
      "0145_press_decided_at",
      // The stamps 0144 could not give: two backfills whose WHEREs read the trail as it stands and
      // empty after one run. Safe over any history; nothing to adopt with.
      "0146_rule_person_decided_followup",
      // The open read: one nullable column, IF NOT EXISTS, no backfill. Safe over any history.
      "0147_messages_open_read_at",
      // The identity fact: three nullable columns IF NOT EXISTS and the closed set's CHECK in the
      // duplicate_object DO block, NOT VALID, no backfill. Safe over any history; nothing to adopt with.
      "0148_messages_sender_check",
      // Which writer gave the fact: one nullable column IF NOT EXISTS and its closed set's CHECK in
      // the duplicate_object DO block, NOT VALID, no backfill. Safe over any history.
      "0149_messages_sender_check_by",
      // The list addresses: a new table and one nullable column, IF NOT EXISTS, no backfill in the
      // migration. Safe over any history; nothing to adopt with.
      "0150_list_addresses",
      // The gap window and its offer: three nullable columns, IF NOT EXISTS, no backfill. Safe over any history.
      "0151_mailboxes_gap_since",
      // The search GIN indexes' pending list bounded: three ALTER INDEX IF EXISTS … SET and one flush.
      // Storage parameters only, safe over any history.
      "0152_search_gin_pending_bounded",
      // The rule key of routing_decisions recreated with ON DELETE SET NULL, NOT VALID: drop-then-add
      // under one name, no data. Safe over any history.
      "0153_rule_revoke_keeps_its_decisions",
      // The recipient keys: CREATE OR REPLACE FUNCTION and CREATE INDEX IF NOT EXISTS, no column and
      // no data. Safe over any history.
      "0154_messages_recipient_keys",
      // The send re-arm: two ADD COLUMN IF NOT EXISTS on outbound_sends, a constant default and a
      // nullable deadline, no data. Safe over any history.
      "0155_outbound_sends_rearm",
      // The fact that capped a stored suggestion: one nullable ADD COLUMN IF NOT EXISTS on
      // routing_decisions, no default, no data. Safe over any history.
      "0156_routing_decisions_sender_reason",
      // The Screener cutline probe's index: CREATE INDEX IF NOT EXISTS, no data. Safe over any history.
      "0157_messages_sender_date",
      // The gap offer's stranger count: one nullable ADD COLUMN IF NOT EXISTS on mailboxes, no
      // default, no data. Safe over any history.
      "0158_mailboxes_gap_strangers",
      // The reader's press ordering: one nullable ADD COLUMN IF NOT EXISTS on rules, no default, no
      // data. Safe over any history.
      "0159_rules_settled_press_at",
      // The poll's outstanding filings: a guarded nullable column, a trigger function, a trigger
      // created only where missing, CREATE INDEX IF NOT EXISTS and a backfill of NULL outstanding
      // rows from their message. Safe over any history.
      "0160_folder_state_outstanding",
      // The list read's index: CREATE INDEX IF NOT EXISTS, no data. Safe over any history.
      "0161_mailboxes_account_idx",
      // The send's offer state: one ADD COLUMN IF NOT EXISTS with a constant default, no data. Safe
      // over any history.
      "0162_outbound_sends_offer_state",
      // A new filing's schedule reset: a trigger function and a trigger created only where
      // missing, no data. Safe over any history.
      "0163_folder_state_fresh_intent",
      // A letter the server lost, kept: one nullable ADD COLUMN IF NOT EXISTS on messages, and the
      // two filing-class CHECKs re-added under their names, NOT VALID. No data. Safe over any history.
      "0164_messages_server_missing",
      // An erased mailbox's bytes leave the storage counter: the counter rows of accounts with an
      // erased mailbox, locked and recounted from their bodies. No object. Safe over any history.
      "0165_account_storage_recount",
      // The storage counter's facts: seven ADD COLUMN IF NOT EXISTS on account_storage (two with a
      // constant default), its CHECK dropped and re-added, the count of letters already emptied
      // filled from their marker, and a grant guarded on the staff role. Safe over any history.
      "0166_account_storage_facts",
      // A Rules-page Change's re-filing: two nullable ADD COLUMN IF NOT EXISTS on rules, no data.
      // Safe over any history.
      "0167_rules_refile",
      // A forward's kept files: one nullable ADD COLUMN IF NOT EXISTS on drafts, no default, no data.
      // Safe over any history.
      "0168_drafts_forward_parts",
      // Where a hand-back's gap window starts, and how far back its clock allowance reaches: two
      // nullable ADD COLUMN IF NOT EXISTS on mailboxes. No data. Safe over any history.
      "0169_mailboxes_organized_through",
      // A delivered send's owed Sent copy: one CREATE TABLE IF NOT EXISTS, no data. Safe over any history.
      "0170_outbound_sent_copies",
    ]);

    // The cloud half of the same set. Listed by TAG for the same reason — an adopting
    // production database still applies these, so a new one must be named here on purpose.
    const aboveCloud = readJournalOf(CLOUD).filter((e) => e.when > LEGACY_CUTOFF_WHEN);
    expect(aboveCloud.map((e) => e.tag)).toEqual([
      "0007_staff_users",
      "0009_mailbox_oauth",
      "0010_desktop_link_pkce",
      "0015_attachment_staging",
      "0017_oauth_code_twofa_provenance",
      // cloud 0018 (`invites.confers_verified`) — one defaulted column; see the `- 12` note
      // above for why it lands over any history with no prelude and no operator step.
      "0018_invites_confers_verified",
      // cloud 0024 — the reuse-revocation reads' partial index on auth_events (event =
      // 'refresh_reuse_revoked' only). NOTE for an adopting database: nothing to do beyond
      // applying it; both readers are correct without it and merely slow.
      "0024_auth_events_reuse_index",
      "0025_alert_renotify_signature",
      "0026_alert_claim_lease",
      // cloud 0027 (`mailbox_oauth_device_ceremonies`) — a new table and one index, both
      // `IF NOT EXISTS`; see the `- 21` note above for why it needs no prelude, and for why it
      // is owed before the API deploy on a MANAGED deployment too and not only a self-host one.
      "0027_oauth_device_ceremonies",
      "0030_heartbeat_signals_alert_runs",
      // cloud 0032 — the metering tables leave this schema. It is a GUARDED drop: each of the
      // sixteen goes only where it is empty, and a non-empty one is left in place with a warning
      // naming its row count. NOTE for an adopting database: an install that metered must move or
      // archive those rows and re-run, and nothing is removed before it does.
      "0032_retire_billing_tables",
      // cloud 0033 — the API's own 5xx record. ONE new table, nine statements, no data
      // statement and nothing altered, so an adopting database creates it and has nothing to
      // run afterwards. Its `when` is RE-READ from the landed cloud journal at every rebase:
      // two lanes taking "the maximum plus one" in parallel collide, and drizzle then records
      // the later one as applied without running it.
      "0033_api_faults",
      // cloud 0034 — the passkey ceremony table's expiry index, so the prune that now runs on
      // every ceremony start has a key to walk. ONE statement, `IF NOT EXISTS`, on an existing
      // table: an adopting database builds the index and has nothing to run afterwards, and no
      // row is read or written. Its `when` is RE-READ from the landed cloud journal at every
      // rebase, for 0033's reason.
      "0034_webauthn_challenge_expiry",
      // cloud 0035 — two more indexes on that same table, for the CONSUME read 0034's key cannot
      // serve. TWO statements, both `IF NOT EXISTS` and both PARTIAL on `consumed_at IS NULL`, on
      // an existing table: an adopting database builds them and has nothing to run afterwards, and
      // no row is read or written. Its `when` is RE-READ from the landed cloud journal at every
      // rebase, for 0033's reason.
      "0035_webauthn_open_ceremony_idx",
      // cloud 0036 — the staff step-up's stamp on `staff_sessions` and the PENDING TOTP pair on
      // `staff_users`, plus the recovery's `staff_audit_log`. Additive throughout: `last_twofa_at`
      // lands NOT NULL with a default, so no existing session row is read or invalidated, and the
      // pending columns are nullable. An adopting database applies it and has nothing to run
      // afterwards. Owed before the API deploy and loudly — an API at this journal against an 0035
      // database fails every staff sign-in at the insert. Its `when` is RE-READ from the landed
      // cloud journal at every rebase, for 0033's reason.
      "0036_staff_step_up_and_pending_totp",
      // cloud 0037 — a spend that bought nothing leaves a durable obligation to refund it. TEN
      // statements creating ONE NEW TABLE with its unique key, three CHECKs and one index: an
      // adopting database creates it empty and has nothing to run afterwards, because a debt is
      // something a REQUEST observed and not something a migration can infer — there is no
      // backfill here and there can be none. What it DOES need is an ordering an operator has to
      // respect: migration, then API and worker. The reverse leaves the drafting path refusing a
      // metered press by name, which is the right failure and the wrong way to meet it — the
      // `CLOUD_SCHEMA_MARKERS` entry on `credit_refund_obligations.last_fault` is what makes the
      // deployment say `503 schema_incomplete` and name this file first. Its `when` is RE-READ
      // from the landed cloud journal at every rebase, for 0033's reason.
      "0037_refund_obligations",
      "0038_account_isolation",
      // cloud 0039 — the suggest-owed mark. ONE statement creating ONE NEW TABLE, empty; an
      // adopting database creates it and has nothing to run afterwards, because a mark is
      // something INGEST observed and not something a migration can infer. Deploy order:
      // migration, then worker — the reverse costs a logged mark failure per held ingest and
      // the suggest cadence falls back to the cycle. Its `when` is RE-READ from the landed
      // cloud journal at every rebase, for 0033's reason.
      "0039_screener_suggest_owed",
      // cloud 0040 — the wall's notice ledger (`account_lifecycle_notices`), created EMPTY with
      // its PK-as-idempotency and kind CHECK inline. An adopting database creates it and has
      // nothing to run afterwards: a notice is something the nightly pass SENT, never something
      // a migration can infer. Deploy order: migration, then API — the reverse costs a 42P01
      // inside the pass's own catch and no mail is sent twice.
      "0040_account_lifecycle_notices",
      // cloud 0041 — a nullable column and the NOT VALID CHECK fixing its shape on
      // `attachment_staging`. An adopting database takes both and has nothing to back-fill: a
      // ticket that predates the column stated no digest, which is exactly what NULL means.
      "0041_attachment_staging_digest",
      // cloud 0042 — the desktop approval row on `login_tokens`: additive columns with defaults,
      // `user_id` nullable for that one purpose, and the CHECK saying so. An adopting database
      // takes it over any history; no row predates the purpose, so nothing is back-filled.
      "0042_desktop_approval",
      // cloud 0043 — one new table the erasure writes (token hashes of an erased account). An
      // adopting database takes it empty: no erasure before it kept anything to copy.
      "0043_erased_bearers",
      // cloud 0044 — the sample-cause CHECK redefined to admit `upstream_refused`. An adopting
      // database takes it over any history: every stored cause is one of the seven it keeps.
      "0044_platform_signals_upstream_refused",
      // cloud 0045 — VALIDATE of 0041's digest CHECK. Every row it scans was written under the
      // CHECK or holds NULL, so it validates over any history; nothing to adopt with.
      "0045_attachment_staging_digest_validate",
      // cloud 0046 — three nullable columns on `totp_secrets` and the CHECK sealing them. An
      // adopting database takes them over any history: no replacement predates them, so all NULL.
      "0046_totp_pending_replacement",
      // cloud 0047 — two NEW tables and the staff-owner backfill from `staff_users`. An adopting database
      // takes them over any history: every staff row it holds becomes an owner, as before.
      "0047_staff_roles_and_audit",
      // The alert drivers' gap history: a new table, IF NOT EXISTS, empty. Safe over any history.
      "0048_alert_driver_gaps",
      // The staff role's grant on that table: REVOKE ALL then three column grants, only where
      // `ohmail_admin` exists. Re-runnable, so safe over any history.
      "0049_alert_driver_gaps_staff_grant",
      // The notice kind CHECK redefined to admit `billing_link`. Safe over any history: every
      // stored kind is one of the four it keeps.
      "0050_billing_link_notices",
      // Alert drills: a new table and its index, IF NOT EXISTS, empty, and the staff role's grant
      // on it only where `ohmail_admin` exists. Safe over any history.
      "0051_alert_drills",
      // A notice's delivery time: a nullable column, IF NOT EXISTS, and the pass's earlier rows
      // stamped delivered (nothing can tell otherwise). Safe over any history that has not run it.
      "0052_lifecycle_notice_delivered",
      // The connect reminder's notice kind: the kind CHECK dropped IF EXISTS and added again NOT VALID,
      // a superset of 0050's. Safe over any history.
      "0053_connect_reminder_notices",
    ]);

    // …and the moment an entry is added above the cutoff it is NOT adoptable. Simulated by
    // filtering the real journal, so the property is about the cutoff and not about a fixture.
    const future = { idx: 99, version: "7", when: LEGACY_CUTOFF_WHEN + 1, tag: "0099_future", breakpoints: true };
    const adoptable = [...readJournalOf(MAIL), future].filter((e) => e.when <= LEGACY_CUTOFF_WHEN);
    expect(adoptable.map((e) => e.tag)).not.toContain("0099_future");
  });
});

describe("the object probe is derived from the journal SQL, so it cannot drift", () => {
  it("mail: finds the tables, the added columns, the indexes", () => {
    const o = baselineObjects(MAIL);
    expect(o.tables).toHaveLength(35);
    expect(o.tables).toContain("messages");
    expect(o.tables).toContain("audit_log");
    expect(o.tables).toContain("devices");
    // The two columns the mail journal adds to shared tables in its last two entries — the
    // exact pair the seam rule had to arbitrate.
    expect(o.columns).toEqual(expect.arrayContaining([["accounts", "ai_enabled"], ["users", "email_verified_at"]]));
    expect(o.indexes).toContain("messages_subject_tsv_idx");
    expect(o.indexes).toContain("users_email_unique_idx");
    // No private table may appear — the same closure rule, reached from a different direction.
    for (const t of o.tables) {
      expect(["credit_ledger", "invites", "waitlist", "billing_events", "push_subscriptions",
        "credentials", "refresh_tokens", "login_tokens"]).not.toContain(t);
    }
  });

  it("cloud: finds the identity and funnel tables, and no money table", () => {
    const o = baselineObjects(CLOUD);
    // 20 → 19: `refresh_tokens` left the cloud PROBE when mail 0060 adopted the table — a
    // two-journal database holds it the moment the mail journal has run, so its presence
    // stopped discriminating provenance. See `CLOUD_OBJECTS_ADOPTED_BY_MAIL` in `baseline.ts`.
    // 19 → 14: `0002_billing` left the cloud journal, so its five tables are no longer created
    // by anything and cannot be probed for. What the probe still certifies is the identity and
    // funnel half of the pre-split era, which is the half this server still has.
    expect(o.tables).toHaveLength(14);
    expect(o.tables).not.toContain("refresh_tokens");
    expect(o.indexes).not.toContain("refresh_tokens_family_idx");
    expect(o.tables).toEqual(expect.arrayContaining([
      "invites", "waitlist", "push_subscriptions", "credentials",
    ]));
    // …and NOT the metering tables, which nothing in this journal creates any more.
    for (const t of ["credit_ledger", "credit_balances", "billing_events",
      "billing_subscriptions", "billing_customers"]) {
      expect(o.tables, `${t} is still probed for`).not.toContain(t);
    }
    expect(o.columns).toEqual(expect.arrayContaining([["invites", "revoked_at"]]));
    // The objects with no undo. If the probe cannot see these it cannot certify a faithful
    // split, which is the one thing adoption must never get wrong.
    expect(o.indexes).toContain("push_subscriptions_identity_uq");
    // The ledger's own undo-less objects went with the ledger; the probe must not demand them.
    expect(o.indexes).not.toContain("credit_ledger_source_uq");
    expect(o.indexes).not.toContain("billing_sub_one_live_idx");
    expect(o.triggers).toEqual([]);
  });

  it("the two halves' object sets are DISJOINT — 49 tables, counted once each", () => {
    const mail = new Set(baselineObjects(MAIL).tables);
    const cloud = new Set(baselineObjects(CLOUD).tables);
    expect([...mail].filter((t) => cloud.has(t))).toEqual([]);
    // 55 → 54: `refresh_tokens` left the cloud PROBE (mail 0060 adopted the table) and it is
    // not in the MAIL baseline either — the mail baseline is frozen at the legacy cutoff and
    // 0060 sits above it, so the ADOPTED table is deliberately probed by neither half. See
    // `CLOUD_OBJECTS_ADOPTED_BY_MAIL` in `baseline.ts` for why counting it broke fresh setups.
    // 54 → 49 with `0002_billing`'s five tables gone from the cloud probe.
    expect(mail.size + cloud.size).toBe(49);
  });

  it("does NOT demand an index the baseline later DROPPED", () => {
    // `0003` created `users_email_idx`; the mail half of `0021` dropped it because the new
    // unique index is the same single column. A probe that still required it would refuse every
    // correctly-migrated database — including production.
    expect(baselineObjects(MAIL).indexes).not.toContain("users_email_idx");
    expect(baselineObjects(MAIL).indexes).toContain("users_email_unique_idx");
  });

  it("probes something substantial, not an empty set that passes vacuously", () => {
    for (const spec of [MAIL, CLOUD]) {
      const o = baselineObjects(spec);
      const total = o.tables.length + o.columns.length + o.indexes.length + o.triggers.length;
      expect(total, `${spec.name} probe is too small to mean anything`).toBeGreaterThan(20);
    }
  });
});
