/**
 * THE LOCK'S LIGHT NAMES: the two runtime logins, the schema the readers and the account's views
 * live in, and how a policy or a view calls the account's reader. No import, so a module every
 * store loads (`account-rows.ts`) loads nothing of the hosted half. `names.ts` re-exports each:
 * that is still the one home of the lock's names.
 */

/** The two runtime logins: the API's and the worker's. Neither owns anything or may bypass. */
export const API_ROLE = "ohmail_api";
export const WORKER_ROLE = "ohmail_worker";
export const RUNTIME_LOGINS = [API_ROLE, WORKER_ROLE] as const;
export type RuntimeLogin = (typeof RUNTIME_LOGINS)[number];

/**
 * The schema the readers and the account's views live in, owned by the migrator. A login holds
 * USAGE on it only while one of its views stands there (the runtime roles' rule writes it): a
 * policy calls a reader by its id and needs none.
 */
export const READER_SCHEMA = "ohmail";
/** How a policy and a view call the account's reader. */
export const ACCOUNT_READER = `${READER_SCHEMA}.current_account()`;
