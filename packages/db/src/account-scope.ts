/**
 * WHICH TABLES HAVE NO ACCOUNT OF THEIR OWN, AND WHOSE THEY BORROW.
 *
 * Since mail 0201 and cloud 0100 none borrows: the six mail tables and the seven sign-in tables
 * that named a parent and no account carry their own, under a key onto the parent's
 * `(id, account_id)`. The list stays, empty, because it is what the census asks: a table with no
 * account column that hangs off another table is either here, with the single-column key it owes
 * instead, or in {@link NO_ACCOUNT_SCOPE} with the reason it belongs to no account.
 * `account-scope-is-declared.test.ts` derives both from the schemas and refuses a table in neither.
 */

/** A table whose account scope is its parent's, named with the reference that carries it. */
export interface ParentScopedTable {
  readonly table: string;
  /** The column that reaches the parent. */
  readonly via: string;
  /** The parent, which carries the account. */
  readonly parent: string;
}

/** No table borrows its parent's account any more. A new one that does is a ruling, not a default. */
export const SCOPED_THROUGH_A_PARENT: readonly ParentScopedTable[] = [];

/**
 * The five tables whose account every insert names since mail 0201: NOT NULL on a server, nullable
 * on a device (`schema-mail-sqlite.ts`), where the test store refuses an insert without it.
 * `pairing_tokens` carries the column too and is not here: the first setup token has no creator,
 * and so no account.
 */
export const ACCOUNT_NAMED_BY_EVERY_INSERT = [
  "message_bodies", "folder_state", "flag_state", "mailbox_credentials", "mailbox_folders",
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
  { table: "staff_role_grants", why: "an operator's roles; `staff_users` belongs to no account" },
  {
    table: "staff_audit_events",
    why: "an operator's own trail; `target_account_id` names an account without a key on purpose, " +
      "so erasure leaves the rows under the id alone",
  },
  { table: "oauth_provider_config", why: "one row per provider, set by an operator, account-wide" },
  {
    table: "invites",
    why: "an invite PRECEDES the account it creates; its user reference deliberately carries no " +
      "key so erasure need not choose between the invite and the person",
  },
] as const;
