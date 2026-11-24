import { manageUrlWithTimeZone } from "@ohmail/app-logic/doors/wall-lift";

/**
 * Leave for the address the mint answered.
 *
 * SAME TAB, where the old anchor opened a new one: a mint is a round trip, and `window.open`
 * after it is what a popup blocker eats — silently, which is the outcome this pane may not have.
 * A detached anchor and not `location.assign` so the referrer stays off: `rel="noreferrer"` is the
 * only way to say it for a scripted navigation, and the address is minted for one account.
 */
export function leaveForManagePage(url: string, timeZone?: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.href = manageUrlWithTimeZone(a.href, timeZone);
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
