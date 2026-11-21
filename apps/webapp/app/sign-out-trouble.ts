import type { SignOutResult } from "./sign-out";

/** The server verdict and browser cleanup are separate. Report a refusal before describing storage. */
export type SignOutTrouble =
  | { key: "signOutUnverified" }
  | { key: "signOutCleanupPending" }
  | { key: "signOutReplaced" }
  | { key: "signOutBlocked" }
  | { key: "signOutServerRefused"; reason: string; cleanupIncomplete?: boolean };

export function signOutTrouble(outcome: SignOutResult): SignOutTrouble | null {
  if (outcome.replaced) return { key: "signOutReplaced" };
  if (outcome.serverRefused !== null) return { key: "signOutServerRefused", reason: outcome.serverRefused, cleanupIncomplete: outcome.cleared === false };
  if (outcome.cacheCleanup?.state === "pending") return { key: "signOutCleanupPending" };
  if (outcome.cacheCleanup?.state === "failed") return { key: "signOutUnverified" };
  if (!outcome.inventoryComplete) return { key: "signOutUnverified" };
  if (!outcome.cleared) return { key: "signOutBlocked" };
  return null;
}
