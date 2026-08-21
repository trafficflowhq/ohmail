/**
 * `@trafficflow/core/net` — the SSRF gate and its pin, together, and NOT on the package barrel.
 *
 * A subpath rather than a member of `src/index.ts` on purpose: `pinned-fetch.ts` imports
 * `node:http`/`node:https`, and `@trafficflow/core` is imported by graphs that have neither
 * (the browser mirror reaches core for the pure halves). Putting these two behind their own
 * subpath means a consumer opts into node-only code by naming it.
 *
 * The two are exported from ONE entry because they are one mechanism: `assertPublicHttpUrl`
 * returns the addresses it cleared, and `pinnedHttpRequest` is the only correct thing to do with
 * them. Splitting them into separate subpaths would make it possible to import the gate, ignore
 * the return value, and hand the hostname to `fetch` — which is precisely the hole the return
 * value exists to close.
 */
export {
  SsrfRefusal, isBlockedAddress, nodeHostResolver,
  assertPublicHttpUrl, assertPublicHost, resolvePinUnchecked,
  type HostResolver, type PublicUrlOptions,
} from "./ssrf-guard.js";
export {
  pinnedLookup, pinnedHttpRequest,
  type PinnedRequestOptions, type PinnedResponse,
} from "./pinned-fetch.js";
export {
  makePushEndpointGuard, PUSH_ENDPOINT_MAX_LEN, type PushEndpointGuard,
} from "./push-endpoint.js";
