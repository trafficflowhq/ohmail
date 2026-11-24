/**
 * Is nobody looking? — the one guard every standing poll asks.
 *
 * Three polls ask it: the mailbox facts (`MailStateProvider`), the desktop's freshness read and
 * the build watch. They spelled it three ways and two of them did not spell it at all, so a
 * hidden window went on asking. `false` where there is no document — a server render, a test
 * environment without one — because a poll that cannot see a window must keep working.
 */
export function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
