import { ROLE_DEFAULT_TIMEOUTS } from "../handle-table.js";
import { STAFF_ROLE } from "../staff-grants.js";
import { API_ROLE, API_REPLACEMENT_ROLE, WORKER_ROLE } from "./logins.js";

/**
 * THE SERVER DEADLINES BY ROLE NAME: what each role that serves people carries through the pooler,
 * set on the role alone (no database scope) by the setup signed in as the migrator, and read back
 * from the catalog. One table, keyed by role; every cell is the handle table's
 * {@link ROLE_DEFAULT_TIMEOUTS}, so a number changes there and nowhere here. The migrator carries
 * none of its own: the transition, the setup and the dump set or lift theirs.
 */
export const ROLE_DEADLINES: Readonly<Record<string, typeof ROLE_DEFAULT_TIMEOUTS>> = {
  [API_ROLE]: ROLE_DEFAULT_TIMEOUTS,
  [WORKER_ROLE]: ROLE_DEFAULT_TIMEOUTS,
  [API_REPLACEMENT_ROLE]: ROLE_DEFAULT_TIMEOUTS,
  [STAFF_ROLE]: ROLE_DEFAULT_TIMEOUTS,
};

/** The text a deadline is written and compared as: `'<ms>ms'`, the spelling the setup's own loop writes. */
export function deadlineText(ms: number): string {
  return `${ms}ms`;
}
