/**
 * WHICH TABLES HAVE NO ACCOUNT OF THEIR OWN, AND WHOSE THEY BORROW.
 *
 * Most tables carry an `account_id` and a composite key holds it to its parent's. These do not,
 * and that is the point: a column that is not there cannot disagree with the parent, and no
 * account-scoped read reaches such a row except through the parent it hangs from. What each one
 * owes instead is a single-column key, so the parent is not merely assumed to be there.
 *
 * `account-scope-is-declared.test.ts` derives both lists from the two schemas and refuses a table
 * that appears in neither — the declaration is the census's subject, never its source.
 */

/** A table whose account scope is its parent's, named with the reference that carries it. */
export interface ParentScopedTable {
  readonly table: string;
  /** The column that reaches the parent. */
  readonly via: string;
  /** The parent, which carries the account. */
  readonly parent: string;
}

/** The thirteen. Each carries a single-column key to a parent that has an `account_id`. */
export const SCOPED_THROUGH_A_PARENT: readonly ParentScopedTable[] = [
  { table: "mailbox_credentials", via: "mailbox_id", parent: "mailboxes" },
  { table: "mailbox_folders", via: "mailbox_id", parent: "mailboxes" },
  { table: "folder_state", via: "message_id", parent: "messages" },
  { table: "flag_state", via: "message_id", parent: "messages" },
  { table: "message_bodies", via: "message_id", parent: "messages" },
  { table: "pairing_tokens", via: "created_by_user_id", parent: "users" },
  { table: "credentials", via: "user_id", parent: "users" },
  { table: "webauthn_credentials", via: "user_id", parent: "users" },
  { table: "webauthn_challenges", via: "user_id", parent: "users" },
  { table: "totp_secrets", via: "user_id", parent: "users" },
  { table: "recovery_codes", via: "user_id", parent: "users" },
  { table: "login_tokens", via: "user_id", parent: "users" },
  { table: "oauth_auth_codes", via: "user_id", parent: "users" },
] as const;

/** A table with no account scope at all, and the reason it has none. */
export interface UnscopedTable {
  readonly table: string;
  readonly why: string;
}

/** Tables that belong to no account, so there is nothing for a key to hold them to. */
export const NO_ACCOUNT_SCOPE: readonly UnscopedTable[] = [
  { table: "staff_sessions", why: "an operator's session; `staff_users` belongs to no account" },
  { table: "staff_audit_log", why: "an operator's own trail; `staff_users` belongs to no account" },
  { table: "oauth_provider_config", why: "one row per provider, set by an operator, account-wide" },
  {
    table: "invites",
    why: "an invite PRECEDES the account it creates; its user reference deliberately carries no " +
      "key so erasure need not choose between the invite and the person",
  },
] as const;
