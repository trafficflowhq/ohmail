/**
 * THE PIN — moved to `@trafficflow/core/net` and re-exported here so no existing import moves.
 *
 * The reason for the move is in `ssrf-guard.ts` beside this file and, at length, at the top of
 * `packages/core/src/net/ssrf-guard.ts`: `apps/worker` needs the same gate and the same pin for the
 * UnifiedPush wake sender, and may not import this package. Nothing about the behaviour changed —
 * the socket still connects only to a pre-validated address, the SNI and `Host` header still carry
 * the original hostname, and redirects are still not followed.
 */
export {
  pinnedLookup, pinnedHttpRequest,
  type PinnedRequestOptions, type PinnedResponse,
} from "@trafficflow/core/net";
