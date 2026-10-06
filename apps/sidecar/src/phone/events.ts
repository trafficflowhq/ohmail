/**
 * `GET /events`, OFF — substituted for `./events.js` where `packages/api` `routes/local` imports
 * it. Every local composition sets `sse.enabled: false`, so the real route answers 503
 * `sse_disabled` there first, and the phone app has no event-stream client. One route with the
 * real one's method, pattern, cost and options (the raw pipeline still answers 401 without a
 * session), answering the refusal from the module both share. Importing `@trafficflow/api/local`
 * is a cycle through the table that imports this file, and safe: only that table reaches this
 * module, and the refusal is read when a request arrives, never at load.
 */
import { sseDisabledResponse, type Route } from "@trafficflow/api/local";

export const eventsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/events",
    relay: true,
    cost: "connection",
    options: { raw: true },
    handler: async () => sseDisabledResponse(),
  },
];
