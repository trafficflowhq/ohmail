/**
 * WHERE A SIGN-IN CONTINUES when `/login` was opened with `?next=`. The value is a NAME from a closed
 * set and never an address: `manage` and `join` are the names, and anything else continues to the app,
 * so no link can send a sign-in anywhere this table does not list. Read once from the URL the page was
 * served for; the approval page's own return is a separate door (`approve/approval-return.ts`).
 */

/** The route that mints a fresh account-page link and leaves for it. */
export const MANAGE_ROUTE = "/account/manage";

/**
 * The signup wizard, which resumes on the step the server says the account is on. Its sign-in exits
 * name it, because the app's `/` has no mailbox step: a person sent there from the mailbox step
 * landed in an empty Ohbox with the setup gone.
 */
export const JOIN_ROUTE = "/join";

export type Continuation = typeof MANAGE_ROUTE | typeof JOIN_ROUTE;

export function continuationOf(next: string | string[] | null | undefined): Continuation | null {
  if (next === "manage") return MANAGE_ROUTE;
  if (next === "join") return JOIN_ROUTE;
  return null;
}

/**
 * Go there as a DOCUMENT navigation. `/account/manage` is a route handler whose answer is a redirect
 * to another host, which the client router's fetch cannot follow; a full navigation can.
 */
export function leaveFor(target: Continuation): void {
  window.location.assign(target);
}
