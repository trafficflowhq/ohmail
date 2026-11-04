import { errorResponse } from "../responses.js";

/**
 * `/events` answering that server-sent events are off: the one spelling, shared by the real route
 * and the phone engine's twin of it (`apps/sidecar/src/phone/events.ts`), so the two cannot drift.
 */
export function sseDisabledResponse(): Response {
  return errorResponse("sse_disabled", 503, "server-sent events are disabled on this deployment; poll GET /sync");
}

/**
 * `/events` on a host that holds no stream (`sse.holds === false`): 204, no body. `EventSource` fails
 * the connection on it without a redial, and it is no 5xx, so the error alert stays quiet.
 */
export function streamNotHeldResponse(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
