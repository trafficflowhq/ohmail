/**
 * The LAN ceremony's route table, empty — substituted for `../lan-routes.js`. The desktop mounts
 * these UNARMED so a person can be offered same-network access before host mode exists; a phone
 * offers no such choice. An EMPTY TABLE rather than a throw, and this is the reason the directory's
 * rule is "called at boot" rather than a fixed list: `engine.ts` spreads `localLanRoutes(...)` into
 * the route table on EVERY launch, armed or not, so a thrower here is a phone that cannot start, and
 * reading the call site is the only way to know it.
 */
import type { Route } from "@trafficflow/api/local";

export function localLanRoutes(_fingerprint: () => string | null): Route[] {
  return [];
}
