import type { AccessRefusedFacts, AccountAccess } from "./api-client";
import type { StoredVerdict } from "./shell/wall-lift";

/**
 * What an answer says, or `null` when it says nothing: an older API names no `access`, and
 * silence is never read as open. `metered: false` is a host that refuses nobody.
 */
export function verdictOf(a: AccountAccess): StoredVerdict | null {
  if (a.metered === false) return "open";
  if (a.metered !== true) return null;
  if (a.access === "open") return "open";
  if (a.access === "refused") return "closed";
  return null;
}

/** The wall's facts from a refused answer — the same fields the `402` carries. */
export function refusedFactsOf(a: AccountAccess): AccessRefusedFacts | null {
  if (a.metered !== true || a.access !== "refused") return null;
  const lifecycle = a.lifecycle;
  return {
    reason: lifecycle?.closedReason === "suspended" ? "suspended" : "payment_required",
    ...(a.manageUrl ? { manageUrl: a.manageUrl } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(a.exportPath ? { exportPath: a.exportPath } : {}),
  };
}

/** The one predicate a wall lifts on: the service's own `access: "open"`, and nothing else. */
export function opensTheWall(a: AccountAccess): boolean {
  return a.metered === true && a.access === "open";
}
