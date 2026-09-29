import type { SignOutResult } from "./sign-out";

/**
 * WHAT A SIGN-OUT THAT DID NOT FINISH SAYS, one reading for every surface with the button (the
 * account pane, the error page, the lock screen). The order is load-bearing: `cleared` is false
 * whenever the inventory is partial, so the unverifiable arm comes first. A blocked or unconfirmed
 * wipe leaves mail in this browser and a refusal on the server leaves a session, so none of the
 * three may navigate away. `null` is a finished sign-out. The keys are the `account` catalogue's.
 */
export type SignOutTrouble =
  | { key: "signOutUnverified" }
  | { key: "signOutBlocked" }
  | { key: "signOutServerRefused"; reason: string };

export function signOutTrouble(outcome: SignOutResult): SignOutTrouble | null {
  if (!outcome.inventoryComplete) return { key: "signOutUnverified" };
  if (!outcome.cleared) return { key: "signOutBlocked" };
  if (outcome.serverRefused !== null) return { key: "signOutServerRefused", reason: outcome.serverRefused };
  return null;
}
