import type { messageSearch, messages } from "../schema-mail.js";
import { ACCOUNT_READER, READER_SCHEMA, RUNTIME_LOGINS } from "./logins.js";

/**
 * THE ACCOUNT'S VIEWS OF THE ROW LOCK (the search ruling, as the views' text ruling amends it).
 * Under the lock a statement's own condition reaches an index only through leakproof operators, and
 * the search's words, trigrams and lower-cased senders are not; so the search reads three views in
 * the readers' schema, owned by the migrator (which bypasses), that answer the bound account's rows
 * to the two runtime logins alone. A view without a barrier is flattened into the statement, so the
 * planner sees the statement and the table's indexes as they are.
 *
 * Each view's text is generated here and nowhere else: the listed columns of its table, one by one;
 * the account's condition, spelled as the reads that go through it key the account; the reader's
 * condition, `current_user` compared with the two names of `RUNTIME_LOGINS` written as literals;
 * and the check option, so that a row an insert or an update writes through a view must answer the
 * same two conditions (the row an insert … on conflict do update finds is not asked: the two logins
 * hold SELECT alone, and any other right on a view is broken in the lock's check). No
 * `security_barrier` (it loses the index), no `security_invoker`, no other option, no code on a
 * view. The setup's lock step makes them, after the readers, in its one transaction; grants are the
 * runtime roles' rule's alone (SELECT for the two logins, and USAGE on the schema while a view stands).
 *
 * A LIST GROWS AT ITS END ONLY. The step makes a view again over itself only where the view holds the
 * list's first columns, in order and type, and the list adds columns after them (`create or replace
 * view` takes no other change of a view's columns, and keeps its grants). Any other change of a
 * view's columns is refused: a release that drops, renames or retypes a column a view names, or drops
 * or renames its table, starts its journal entry with `DROP VIEW IF EXISTS` of each view over that
 * table, in a closed window, and the step makes them again (the list test reads both journals for it).
 * A prepared read through a view names its columns: a named prepared `select *` through one fails
 * once a connection when the step makes the view again over a grown list (0A000).
 *
 * THEY ARE NOT A BARRIER. A statement run as a login may have its own function, operator or cast
 * given a row of another account in any shape of statement (a plain WHERE is enough); any other role
 * that holds SELECT on a view, only below an outer join; and while it plans, a value the statistics
 * kept: before the account and the reader are compared. For a login that is the lock's old border
 * (SQL run as a login names any account). For any other role, who may name a view at all is the
 * runtime roles' census's to hold, at each release and as the step's postcondition.
 */

/** The SQL names of `T`'s columns, as the schema declares them: a listed column the schema lost does not compile. */
type SqlNamesOf<T extends { readonly _: { readonly columns: Record<string, { readonly _: { readonly name: string } }> } }> =
  T["_"]["columns"][keyof T["_"]["columns"]]["_"]["name"];

/** One of the account's views. */
export interface AccountView<T extends string = string> {
  /** Its name in {@link READER_SCHEMA}: the table's own name, or the words' read of it. */
  readonly name: "messages" | "message_search" | "message_search_words";
  /** The table of `public` it reads. */
  readonly table: "messages" | "message_search";
  /** The table's columns it answers, one by one, in this order; a list grows at its end only. Never `*`. */
  readonly columns: readonly T[];
  /** The account's condition over the row. */
  readonly key: string;
}

/**
 * Every column of `messages` the 2.0 schema declares, in the order a store's view already holds them:
 * a new one goes at the end, never between (the step makes a view again only over the columns it
 * holds followed by new ones; the list test pins the ones a store may hold).
 */
const MESSAGES_COLUMNS: readonly SqlNamesOf<typeof messages>[] = [
  "id", "account_id", "mailbox_id", "message_id_header", "body_hash", "dedup_key", "subject", "from_address", "from_name",
  "date", "native_locator", "no_ai", "no_forward", "no_kb", "priority", "created_at", "thread_id", "unread", "last_read_at",
  "deleted_at", "snippet", "to_addresses", "cc_addresses", "has_attachments", "attachment_count", "sensitivity_category",
  "auth_verdict", "updated_at", "arrived_at", "open_read_at", "sender_check", "sender_check_brand", "sender_check_by",
  "server_missing_at", "unconfirmed_hold", "recipient_keys",
];

/** Every column of `message_search` the 2.0 schema declares, in the order a store's views hold them: a new one goes at the end. */
const MESSAGE_SEARCH_COLUMNS: readonly SqlNamesOf<typeof messageSearch>[] = [
  "message_id", "account_id", "head_tsv", "text_tsv", "terms", "source", "built_at",
];

/** The account's condition as the lock's policies spell it. */
const OWN_ACCOUNT = `account_id = ${ACCOUNT_READER}`;
/**
 * The account's condition as the word reads key it: the account as text, the first key of the word
 * index (`message_search_words_idx`) and the left side of the dialect's word key. A view spelled
 * otherwise leaves a second condition in the plan.
 */
const OWN_ACCOUNT_AS_TEXT = `(account_id)::text = (${ACCOUNT_READER})::text`;

/** THE THREE VIEWS. */
export const ACCOUNT_VIEWS: readonly AccountView[] = [
  { name: "messages", table: "messages", columns: MESSAGES_COLUMNS, key: OWN_ACCOUNT },
  { name: "message_search", table: "message_search", columns: MESSAGE_SEARCH_COLUMNS, key: OWN_ACCOUNT },
  { name: "message_search_words", table: "message_search", columns: MESSAGE_SEARCH_COLUMNS, key: OWN_ACCOUNT_AS_TEXT },
];

/** The one option a view carries, as the catalog stores it (`with check option` is cascaded). */
export const VIEW_CHECK_OPTION = "check_option=cascaded";

/** A login's name as a view's text writes it: a plain lower-case identifier, or nothing is generated. */
const LOGIN_NAME = /^[a-z_][a-z0-9_]*$/;

/** The reader's condition: the role a statement runs as is one of the two runtime logins, by name. */
export function readerCondition(): string {
  for (const l of RUNTIME_LOGINS) if (!LOGIN_NAME.test(l)) throw new Error(`a runtime login's name is not a plain identifier: ${l}`);
  return `current_user in (${RUNTIME_LOGINS.map((l) => `'${l}'`).join(", ")})`;
}

/** `ohmail.<name>`: how a statement names the view. */
export function viewName(v: Pick<AccountView, "name">): string {
  return `${READER_SCHEMA}.${v.name}`;
}

/** The statement that makes `v`, or (`replace`) makes it again over a view of the same columns. */
export function viewStatement(v: AccountView, replace = false): string {
  return `create ${replace ? "or replace " : ""}view ${viewName(v)} as select ${v.columns.map((c) => `"${c}"`).join(", ")}`
    + ` from public."${v.table}" where ${v.key} and ${readerCondition()} with check option`;
}

/**
 * HOW EACH INDEX THE LOCK COULD TAKE FROM A READ IS READ (the search ruling's first part: the lock's list of
 * views and of index reads, one list). Under the lock a
 * statement's own condition becomes an index condition only where every function and operator in it is
 * leakproof and the planner knows the node: `@@`, the trigram operators, LIKE, `lower`, `trim`, `->>`,
 * COALESCE and every function of the product's own are not. So an index on a locked table that is no
 * btree (a GIN), or whose key or predicate is an expression, is a read that may lose its index under the
 * policy. Each such index has one row here; the lock's ground reads every one from the catalog, and an
 * index with no row is red there, as is a row with no index: a new expression index is a decision.
 *
 * - `view`: its reads go through one of the account's views (above), where the planner sees the table's
 *   indexes as they are (the search's arms, a person's reads, a list's next page by arrival).
 * - `small`: a filter over one account's rows, which the product bounds (`bound` names the bound).
 * - `kept`: the read keeps its index under the policy, or stays as it is on the table (`why` says which).
 *
 * Seen on 16 and 17 as the API's login, bound, on the lock's ground: a key condition on an expression
 * becomes a filter over the account's rows, the account's prefix staying the index condition; a
 * predicate the read states (a NULL test, a constant, `->>` too) is proved and nothing is asked before
 * the policy; a walk in the order of an expression index keeps it, no condition on the expression.
 */
export type IndexRead =
  | { readonly table: string; readonly read: "view"; readonly through: AccountView["name"] }
  | { readonly table: string; readonly read: "small"; readonly bound: string }
  | { readonly table: string; readonly read: "kept"; readonly why: string };

/** Plain keys, a predicate the read states: proved, never asked before the policy. */
const PREDICATE = "its keys plain columns compared by leakproof operators; its predicate the read's own condition (a NULL test, a constant), proved and never asked before the policy";
/** The account's prefix kept, the expression a filter over one account's rows that nothing in the product bounds. */
const UNBOUNDED = (what: string): string => `under the policy the account's prefix is its condition and ${what} a filter over one account's rows; `
  + "the product sets no bound on them (the search ruling counts them small; no constant makes them so): a judge that finds one slow names it";

/** EVERY SUCH INDEX OF THE 2.0 STORE, by name: 43 on the locked tables (8 no btree, 35 with an expression or a predicate). */
export const INDEX_READS: Readonly<Record<string, IndexRead>> = {
  // The search documents: every arm reads through the account's views.
  message_search_head_terms_trgm_idx: { table: "message_search", read: "view", through: "message_search" },
  message_search_head_tsv_idx: { table: "message_search", read: "view", through: "message_search" },
  message_search_names_trgm_idx: { table: "message_search", read: "view", through: "message_search" },
  message_search_terms_trgm_idx: { table: "message_search", read: "view", through: "message_search" },
  message_search_text_tsv_idx: { table: "message_search", read: "view", through: "message_search" },
  message_search_words_idx: { table: "message_search", read: "view", through: "message_search_words" },
  // The letters by a person, and a list's next page by arrival: through `ohmail.messages`.
  messages_account_arrival_key_idx: { table: "messages", read: "view", through: "messages" },
  messages_account_from_addr_idx: { table: "messages", read: "view", through: "messages" },
  messages_account_from_domain_idx: { table: "messages", read: "view", through: "messages" },
  messages_account_sender_date_idx: { table: "messages", read: "view", through: "messages" },
  messages_recipient_keys_column_idx: { table: "messages", read: "view", through: "messages" },
  // The letters otherwise: a plain order, a NULL test, an ordered walk.
  messages_account_date_order_idx: { table: "messages", read: "kept",
    why: "the storage eviction's walk, oldest first: the account is its condition and the index gives the order, with no condition on the expression" },
  messages_account_msg_order_idx: { table: "messages", read: "kept",
    why: "the header-date order: plain keys, its next page a row comparison of leakproof operators, its predicate a NULL test the reads state" },
  messages_sender_check_owed_idx: { table: "messages", read: "kept", why: PREDICATE },
  // The mailboxes: the active address, one per slot of the Cloud's allowance.
  mailboxes_active_address_uq: { table: "mailboxes", read: "small",
    bound: "the Cloud's mailbox allowance (`mailboxLimit` from the entitlements port, services' mailbox-allowance.ts): its predicate holds the slots the allowance counts" },
  mailboxes_erasure_owed_idx: { table: "mailboxes", read: "kept", why: PREDICATE },
  // A person's own rules, tags, devices and knowledge base: the account's prefix, the rest a filter.
  rules_account_key_idx: { table: "rules", read: "kept", why: UNBOUNDED("the trimmed lower match") },
  tags_account_name_uq: { table: "tags", read: "kept", why: UNBOUNDED("the lower name") },
  push_subscriptions_identity_uq: { table: "push_subscriptions", read: "kept", why: UNBOUNDED("the endpoint or device token") },
  kb_entries_kb_tsv_idx: { table: "kb_entries", read: "kept",
    why: "its words read the account's entries by kb_entries_account_idx and `@@` filters them (the GIN is not used under the policy); "
      + "the product sets no bound on an account's entries: a judge that finds one slow names it" },
  // Queues, owed work and open records: plain keys, a predicate the read states.
  approvals_account_message_idx: { table: "approvals", read: "kept", why: PREDICATE },
  auth_events_reuse_account_at_idx: { table: "auth_events", read: "kept", why: PREDICATE },
  cal_alarms_account_calendar_idx: { table: "cal_alarms", read: "kept", why: PREDICATE },
  cal_events_account_occurrence_idx: { table: "cal_events", read: "kept", why: PREDICATE },
  cal_suggestions_account_open_idx: { table: "cal_suggestions", read: "kept", why: PREDICATE },
  cal_writes_pending_idx: { table: "cal_writes", read: "kept", why: PREDICATE },
  change_log_move_to_inbox_idx: { table: "change_log", read: "kept", why: `${PREDICATE}: its \`->>\` too` },
  drafts_account_reply_idx: { table: "drafts", read: "kept", why: PREDICATE },
  drafts_scheduled_due_idx: { table: "drafts", read: "kept", why: PREDICATE },
  flag_state_pending_queue_idx: { table: "flag_state", read: "kept", why: PREDICATE },
  folder_state_outstanding_idx: { table: "folder_state", read: "kept", why: PREDICATE },
  folder_state_pending_queue_idx: { table: "folder_state", read: "kept", why: PREDICATE },
  folder_state_screener_held_idx: { table: "folder_state", read: "kept", why: PREDICATE },
  junk_rescues_due_idx: { table: "junk_rescues", read: "kept", why: PREDICATE },
  login_tokens_account_idx: { table: "login_tokens", read: "kept", why: PREDICATE },
  message_bodies_withheld_idx: { table: "message_bodies", read: "kept", why: PREDICATE },
  message_failures_due_idx: { table: "message_failures", read: "kept", why: PREDICATE },
  message_instances_primary_uq: { table: "message_instances", read: "kept", why: PREDICATE },
  pairing_tokens_account_idx: { table: "pairing_tokens", read: "kept", why: PREDICATE },
  rules_retro_owed_idx: { table: "rules", read: "kept", why: PREDICATE },
  staff_role_grants_live_uq: { table: "staff_role_grants", read: "kept", why: PREDICATE },
  webauthn_challenges_open_login_idx: { table: "webauthn_challenges", read: "kept", why: PREDICATE },
  webauthn_challenges_open_user_idx: { table: "webauthn_challenges", read: "kept", why: PREDICATE },
};
