/**
 * THE DESKTOP-HOST API SURFACE, EMPTY — substituted for `@trafficflow/api/desktop-host`.
 *
 * This is the route table a paired phone reaches on a desktop that is hosting. It is the single
 * biggest reason the phone's engine bundle must not simply inherit `engine.ts`'s import list: the
 * real table drags the API package's host surface, and with it a listener's worth of code, into an
 * artifact whose whole claim is that it serves nobody.
 *
 * `engine.ts` builds a second app from this table only when host mode is armed, so an empty table
 * is never routed into. It is a VALUE rather than a throw because the binding is imported at the
 * top level and read during composition.
 *
 * The census over the phone metafile is what proves the real table is absent, and it is watched by
 * planting an import of `desktopHostRoutes` and seeing the census go red.
 */
import type { Route } from "@trafficflow/api/local";

export const desktopHostRoutes: Route[] = [];
