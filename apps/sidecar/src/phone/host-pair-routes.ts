/**
 * THE WINDOW'S PAIRING MINT, EMPTY — substituted for `../host-pair-routes.js`.
 *
 * The desktop mounts these only when host mode is armed: they are how a window hands a phone a
 * credential for its own host door. This build arms no host mode and hands out no credentials, so
 * the table is empty.
 *
 * The module still LOADS on every launch (`engine.ts` imports the binding at the top level and
 * spreads it conditionally), so this is a value and not a throw.
 */
import type { Route } from "@trafficflow/api/local";

export const hostPairRoutes: Route[] = [];
