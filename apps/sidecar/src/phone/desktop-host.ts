/**
 * The desktop-host API surface, empty — substituted for `@trafficflow/api/desktop-host`. This is the
 * route table a paired phone reaches on a hosting desktop, and it is the single biggest reason the
 * phone's engine bundle must not inherit `engine.ts`'s import list: the real table drags the API
 * package's host surface, and a listener's worth of code, into an artifact whose whole claim is that
 * it serves nobody. `engine.ts` builds a second app from it only when host mode is armed, so an
 * empty table is never routed into; a VALUE rather than a throw because the binding is read during
 * composition. The census over the phone metafile proves the real table is absent, watched by
 * planting an import of `desktopHostRoutes` and seeing it go red.
 */
import type { Route } from "@trafficflow/api/local";

export const desktopHostRoutes: Route[] = [];
