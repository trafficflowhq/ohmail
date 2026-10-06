import { errorResponse } from "../responses.js";

/**
 * `/events` answering that server-sent events are off: the one spelling, shared by the real route
 * and the phone engine's twin of it (`apps/sidecar/src/phone/events.ts`), so the two cannot drift.
 */
export function sseDisabledResponse(): Response {
  return errorResponse("sse_disabled", 503, "server-sent events are disabled on this deployment; poll GET /sync");
}
