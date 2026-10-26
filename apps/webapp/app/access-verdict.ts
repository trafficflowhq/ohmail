import type { AccessRefusedFacts, AccountAccess, AccountLifecycle } from "./api-client";
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

/**
 * AN ACCOUNT THAT NEVER STARTED its trial: closed with no reason, no closing date, no erasure clock
 * and nothing ever paid — the service's answer for an account that signed up and has not chosen a
 * plan yet. A closure the service could not attribute still carries its erasure date (nothing to
 * erase is the never-started half). The one predicate for trial words: the lock screen offers the
 * trial on it, and /join's plan step names the trial on it and on nothing else.
 */
export function neverStarted(lifecycle: AccountLifecycle | undefined): boolean {
  return lifecycle !== undefined && lifecycle.state === "closed" && lifecycle.closedReason === null
    && !lifecycle.closedAt && !lifecycle.erasureAt && lifecycle.formerlyPaid !== true;
}
