/**
 * The desktop's streamed save, absent — substituted for `../attachment-file-route.js`. A phone has no
 * shell to name a staging folder and no `fs` to write one; its engine mounts no save route and
 * carries none of that code. An EMPTY TABLE, because `engine.ts` spreads it on every launch.
 */
import type { Route } from "@trafficflow/api/local";

export function attachmentFileRoutes(_stagingDir: string | undefined): Route[] {
  return [];
}
