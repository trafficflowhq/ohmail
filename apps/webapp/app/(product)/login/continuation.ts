/**
 * WHERE A SIGN-IN CONTINUES when `/login` was opened with `?next=`. The value is a NAME from a closed
 * set and never an address: `manage` is the one name, and anything else continues to the app, so no
 * link can send a sign-in anywhere this table does not list. Read once from the URL the page was
 * served for; the approval page's own return is a separate door (`approve/approval-return.ts`).
 */

/** The route that mints a fresh account-page link and leaves for it. */
export const MANAGE_ROUTE = "/account/manage";

export type Continuation = typeof MANAGE_ROUTE;

export function continuationOf(next: string | string[] | null | undefined): Continuation | null {
  return next === "manage" ? MANAGE_ROUTE : null;
}

/**
 * Go there as a DOCUMENT navigation. `/account/manage` is a route handler whose answer is a redirect
 * to another host, which the client router's fetch cannot follow; a full navigation can.
 */
export function leaveFor(target: Continuation): void {
  window.location.assign(target);
}
