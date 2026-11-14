import { COUNTER_KEY_FAMILIES, COUNTER_PREFIXES_THAT_LEFT, type CounterKeyParent } from "../counter-keys.js";

/**
 * THE MAP: every table a 2.0 store holds, which journal makes it, whether it carries the account,
 * and how many rows it must hold after the transition, said as a formula over the 1.0.11 store.
 *
 * The formulas are evaluated BEFORE the first entry, so "after" is compared with a number the
 * entries had no hand in. Most tables are untouched in their row count (`same`): the transition
 * adds columns and keys to them, never rows. The others are named one by one below.
 *
 * It is also the list of names the transition knows: a table of `public` that is not here (and is
 * not one the window drops) is not the product's. Data, with no driver and no schema import, so a
 * desktop's engine carries it; `transition-map.test.ts` holds it to the two schema files.
 */
export type MapJournal = "mail" | "cloud" | "desktop";

export interface MappedTable {
  /** `mail`: every store. `cloud`: servers only. `desktop`: the desktop engine's own, there only. */
  readonly journal: MapJournal;
  /** Carries `account_id`: what an erasure, an export and the isolation's policies must each cover. */
  readonly account: boolean;
  /** `same`: as many rows as before. `empty`: a table the window makes and fills with nothing. Else SQL: one bigint. */
  readonly rows: "same" | "empty" | { readonly sql: string };
}

const t = (journal: MapJournal, account: boolean, rows: MappedTable["rows"] = "same"): MappedTable => ({ journal, account, rows });

const PARENT_TABLE: Record<CounterKeyParent, string> = { user: "users", mailbox: "mailboxes", account: "accounts" };

/** The counters cloud 0101 moves: of a moving family's shape, with the row it names still there. */
export function movedCountersSql(columns: string): string {
  return COUNTER_KEY_FAMILIES.filter((f) => f.class === "moves").map((f) =>
    `select ${columns.replaceAll("$account", f.parent === "account" ? "p.id" : "p.account_id")} `
    + `from auth_throttle c join ${PARENT_TABLE[f.parent!]} p on p.id::text = right(c.key, 36) where c.key ~ '${f.shape.source}'`,
  ).join(" union all ");
}

/** What cloud 0101 takes out of `auth_throttle`: every key of a prefix that left, and every key with an address. */
export function leftThrottleSql(alias: string): string {
  return `(${[...COUNTER_PREFIXES_THAT_LEFT.map((p) => `${alias}.key like '${p}%'`), `${alias}.key like '%@%'`].join(" or ")})`;
}

/** One row per mark 1.0 kept in a column, as mail 0203 writes it. `columns` picks what to read of each. */
export function passMarksSql(): string {
  const mb = (job: string, started: string, done: string, cursor: string, where: string): string =>
    `select account_id, '${job}'::text as job, id as subject_id, null::timestamptz as requested_at, ${started} as started_at, ${done} as done_at, ${cursor} as cursor from mailboxes where ${where}`;
  const acct = (job: string, requested: string, done: string, cursor: string, where: string): string =>
    `select account_id, '${job}'::text, account_id, ${requested}, null::timestamptz, ${done}, ${cursor} from account_settings where ${where}`;
  return [
    mb("kickstart", "null::timestamptz", "kickstart_at", "null::text", "kickstart_at is not null"),
    mb("sensitive_rescreen", "sensitive_rescreen_started_at", "sensitive_rescreen_at", "sensitive_rescreen_cursor::text",
      "sensitive_rescreen_at is not null or sensitive_rescreen_started_at is not null or sensitive_rescreen_cursor is not null"),
    mb("sensitive_fp_backfill", "null::timestamptz", "sensitive_fp_backfill_at", "null::text", "sensitive_fp_backfill_at is not null"),
    mb("news_repair", "null::timestamptz", "legacy_news_clean_at", "null::text", "legacy_news_clean_at is not null"),
    acct("ohbox_tidy", "ohbox_tidy_requested_at", "ohbox_tidy_done_at", "ohbox_tidy_cursor::text",
      "ohbox_tidy_requested_at is not null or ohbox_tidy_done_at is not null or ohbox_tidy_cursor is not null"),
    acct("gate_release", "null::timestamptz", "gate_release_done_at", "null::text", "gate_release_done_at is not null"),
    acct("search_index_backfill", "null::timestamptz", "search_index_built_at", "null::text", "search_index_built_at is not null"),
    acct("list_address_backfill", "null::timestamptz", "list_addresses_scanned_at", "null::text", "list_addresses_scanned_at is not null"),
    acct("html_words_backfill", "null::timestamptz", "html_words_backfill_at", "html_words_backfill_cursor::text",
      "html_words_backfill_at is not null or html_words_backfill_cursor is not null"),
  ].join(" union all ");
}

export const MAP_2_0: Readonly<Record<string, MappedTable>> = {
  // ── the mail journal: every server and every desktop ──────────────────────────────────────────
  accounts: t("mail", false),
  account_settings: t("mail", true),
  account_storage: t("mail", true),
  account_sync_state: t("mail", true),
  approvals: t("mail", true),
  attachments: t("mail", true),
  audit_log: t("mail", true),
  away_replies: t("mail", true),
  away_responders: t("mail", true),
  away_sender_state: t("mail", true),
  cal_alarms: t("mail", true, "empty"),
  cal_attendees: t("mail", true, "empty"),
  cal_calendars: t("mail", true, "empty"),
  cal_connections: t("mail", true, "empty"),
  cal_credentials: t("mail", true, "empty"),
  cal_events: t("mail", true, "empty"),
  cal_links: t("mail", true, "empty"),
  cal_settings: t("mail", true, "empty"),
  cal_suggestions: t("mail", true, "empty"),
  cal_writes: t("mail", true, "empty"),
  change_log: t("mail", true),
  contact_notes: t("mail", true),
  contacts: t("mail", true),
  devices: t("mail", true),
  drafts: t("mail", true),
  flag_state: t("mail", true),
  folder_ops: t("mail", true),
  folder_state: t("mail", true),
  graduations: t("mail", true),
  idempotency_keys: t("mail", true),
  junk_rescues: t("mail", true),
  kb_entries: t("mail", true),
  learning_signals: t("mail", true),
  list_addresses: t("mail", true),
  mailbox_credentials: t("mail", true),
  mailbox_folders: t("mail", true),
  mailbox_profile_mirror: t("mail", true),
  mailboxes: t("mail", true),
  message_bodies: t("mail", true),
  message_failures: t("mail", true),
  message_instances: t("mail", true),
  message_invitations: t("mail", true, "empty"),
  message_search: t("mail", true),
  message_states: t("mail", true),
  message_tags: t("mail", true),
  messages: t("mail", true),
  notify_rules: t("mail", true),
  organizer_requests: t("mail", true),
  outbound_send_fingerprints: t("mail", true),
  outbound_sends: t("mail", true),
  outbound_sent_copies: t("mail", true),
  pairing_tokens: t("mail", true),
  pass_progress: t("mail", true, { sql: `select count(*) from (${passMarksSql()}) marks` }),
  refresh_tokens: t("mail", true),
  routing_decisions: t("mail", true),
  rule_removals: t("mail", true),
  rules: t("mail", true),
  scheduled_send_files: t("mail", true),
  sessions: t("mail", true),
  snippets: t("mail", true),
  tags: t("mail", true),
  thread_notes: t("mail", true),
  threads: t("mail", true),
  tracker_events: t("mail", true),
  unsubscribe_drain_state: t("mail", false),
  unsubscribe_examined: t("mail", true),
  unsubscribe_records: t("mail", true),
  users: t("mail", true),
  workflow_proposals: t("mail", true),
  workflow_runs: t("mail", true),
  workflows: t("mail", true),
  // ── the Cloud journal: servers only ───────────────────────────────────────────────────────────
  account_closures: t("cloud", true, "empty"),
  account_counters: t("cloud", true, { sql: `select count(*) from (${movedCountersSql("1")}) moved` }),
  account_lifecycle_notices: t("cloud", true),
  account_storage_holds: t("cloud", true),
  account_storage_prefs: t("cloud", true),
  alert_drills: t("cloud", false),
  alert_driver_gaps: t("cloud", false),
  alert_pass_runs: t("cloud", false),
  alert_state: t("cloud", false),
  api_faults: t("cloud", false),
  attachment_staging: t("cloud", true),
  auth_events: t("cloud", true),
  auth_throttle: t("cloud", false, { sql: `select count(*) from auth_throttle c where not ${leftThrottleSql("c")}` }),
  cal_push_channels: t("cloud", true, "empty"),
  connect_attempts: t("cloud", true),
  credentials: t("cloud", true),
  credit_refund_obligations: t("cloud", true),
  erased_bearers: t("cloud", true),
  invites: t("cloud", false),
  login_tokens: t("cloud", true),
  mailbox_oauth_ceremonies: t("cloud", true),
  mailbox_oauth_device_ceremonies: t("cloud", true),
  mailbox_storage_stats: t("cloud", true),
  oauth_auth_codes: t("cloud", true),
  oauth_provider_config: t("cloud", false),
  platform_signals: t("cloud", false),
  push_subscriptions: t("cloud", true),
  recovery_codes: t("cloud", true),
  screener_suggest_owed: t("cloud", true),
  staff_audit_events: t("cloud", false),
  staff_audit_log: t("cloud", false),
  staff_role_grants: t("cloud", false),
  staff_sessions: t("cloud", false),
  staff_users: t("cloud", false),
  storage_mail_sent: t("cloud", true),
  totp_secrets: t("cloud", true),
  waitlist: t("cloud", false),
  webauthn_challenges: t("cloud", true),
  webauthn_credentials: t("cloud", true),
  worker_heartbeats: t("cloud", false),
  // ── a desktop engine's own ─────────────────────────────────────────────────────────────────────
  local_store_flush: t("desktop", false),
};

export type StoreKind = "cloud" | "server" | "desktop";

/** Does a store of `kind` hold the tables of `journal`? */
export function holds(kind: StoreKind, journal: MapJournal): boolean {
  return journal === "mail" || (journal === "cloud" ? kind !== "desktop" : kind === "desktop");
}

/** The tables of the map a store of `kind` holds after the transition, by name. */
export function tablesOf(kind: StoreKind): string[] {
  return Object.keys(MAP_2_0).filter((name) => holds(kind, MAP_2_0[name]!.journal)).sort();
}

/** The tables that carry the account on a store of `kind`. */
export function accountTablesOf(kind: StoreKind): string[] {
  return tablesOf(kind).filter((name) => MAP_2_0[name]!.account);
}
