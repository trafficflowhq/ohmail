/**
 * THE LAN CEREMONY'S ROUTE TABLE, EMPTY — substituted for `../lan-routes.js`.
 *
 * The desktop mounts these UNARMED, so that a person can be offered same-network access before
 * host mode exists; they report which addresses this machine could serve on. A phone offers no such
 * choice.
 *
 * AN EMPTY TABLE RATHER THAN A THROW, and this one is the reason the directory's rule is phrased as
 * "called at boot" rather than as the planner's list of two: `engine.ts` spreads
 * `localLanRoutes(...)` into the app's route table on EVERY launch, armed or not. A thrower here
 * would be a phone that cannot start, and reading the call site is the only way to know it.
 */
import type { Route } from "@trafficflow/api/local";

export function localLanRoutes(_fingerprint: () => string | null): Route[] {
  return [];
}
