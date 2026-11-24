import { STAFF_ROLE } from "../staff-grants.js";
import { ACCOUNT_SETTING, KEY_SETTING, READER_SCHEMA, RUNTIME_LOGINS, type RuntimeLogin } from "./logins.js";

/**
 * THE LOCK'S NAMES: the two settings a transaction names its account and its key with, the two
 * readers every policy calls, and the roles the policies name. One home for each spelling: the
 * binder (`bound.ts`) writes the settings, the setup's lock step makes the readers, and the census
 * and the check read them back. No driver import, so every package may load it. The light names
 * (the logins, the readers' schema, the account's reader, the two settings) are defined in
 * `logins.ts`, which imports nothing, and re-exported here.
 */
export {
  API_ROLE, WORKER_ROLE, RUNTIME_LOGINS, READER_SCHEMA, ACCOUNT_READER, ACCOUNT_SETTING, KEY_SETTING, type RuntimeLogin,
} from "./logins.js";

/** The billing plane's runtime role: it reads five objects of `public`. */
export const PLANE_ROLE = "plane_runtime";
/** Roles the policies name only where the server has them: the staff role and the plane's. */
export const OPTIONAL_POLICY_ROLES = [STAFF_ROLE, PLANE_ROLE] as const;
export type OptionalPolicyRole = (typeof OPTIONAL_POLICY_ROLES)[number];
/** Every role a policy of the lock may name. No policy names PUBLIC. */
export type PolicyRole = RuntimeLogin | OptionalPolicyRole;
export const POLICY_ROLES: readonly PolicyRole[] = [...RUNTIME_LOGINS, ...OPTIONAL_POLICY_ROLES];

/** How a policy calls the key's reader. */
export const KEY_READER = `${READER_SCHEMA}.current_key()`;

export { STAFF_DOOR_KEY } from "../bound.js";

/** The first word of every comment the lock step writes on a policy it made. */
export const POLICY_COMMENT_TAG = "ohmail-lock";
/** The first word of the lock's off marker, the comment on {@link READER_SCHEMA}. */
export const LOCK_MARKER = "ohmail.lock";

/** One reader: its name in {@link READER_SCHEMA}, what it returns, and its body exactly as stored. */
export interface LockReader {
  readonly name: "current_account" | "current_key";
  readonly returns: "uuid" | "text";
  readonly body: string;
}

/**
 * THE TWO READERS. Absent, empty and malformed all read NULL, so a policy that compares with one
 * admits no row: an unbound transaction is an empty answer, never an error and never another
 * account's row. STABLE (the planner reads them once per statement and the account's index is
 * kept; IMMUTABLE would bake one account into a cached plan), never SECURITY DEFINER, no SET
 * clause (it would stop the planner inlining them), every name in the bodies schema-qualified.
 */
export const LOCK_READERS: readonly LockReader[] = [
  {
    name: "current_account",
    returns: "uuid",
    body: `select case when pg_catalog.pg_input_is_valid(pg_catalog.current_setting('${ACCOUNT_SETTING}', true), 'pg_catalog.uuid') `
      + `then pg_catalog.current_setting('${ACCOUNT_SETTING}', true)::pg_catalog.uuid end`,
  },
  {
    name: "current_key",
    returns: "text",
    body: `select case when pg_catalog.current_setting('${KEY_SETTING}', true) operator(pg_catalog.<>) '' `
      + `then pg_catalog.current_setting('${KEY_SETTING}', true) end`,
  },
];

/** The statement that makes (or remakes) one reader. */
export function readerStatement(r: LockReader): string {
  return `create or replace function ${READER_SCHEMA}.${r.name}() returns pg_catalog.${r.returns} `
    + `language sql stable parallel safe as $lock$${r.body}$lock$`;
}
