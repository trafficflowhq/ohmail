/**
 * One LISTEN connection per warm instance, fanned out to that instance's `/events` streams.
 * The implementation lives in `packages/db/src/change-wake.ts` since a second long-running
 * host needed the same hub; this module stays as the host's own name for it so `deps.ts` and
 * this host's tests keep proving the exact import path the managed composition uses.
 * Unchanged here: `subscribe` never throws, dial is lazy, idle connections are released, a
 * failed LISTEN degrades to the poll loop. `end()` is never called here — a serverless
 * instance is reaped by the platform, not shut down by a signal handler.
 */
export { makeChangeWakeHub, WAKE_IDLE_CLOSE_MS as IDLE_CLOSE_MS, WAKE_RETRY_AFTER_MS as RETRY_AFTER_MS } from "@trafficflow/db/cloud";
