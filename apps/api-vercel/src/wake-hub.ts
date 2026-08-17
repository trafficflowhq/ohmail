/**
 * ONE LISTEN CONNECTION PER WARM INSTANCE, fanned out to that instance's `/events` streams.
 *
 * The implementation moved to `packages/db/src/change-wake.ts` — verbatim, invariants and all —
 * the day a second long-running host (the standalone self-host server) needed the same hub over
 * its own connection string: the "streams : connections = N : 1 per instance" economics must not
 * exist as two hand-kept copies. This module stays as the host's own name for it so `deps.ts`
 * and this host's tests are untouched, and so the pg suite here keeps proving the exact import
 * path the managed composition uses.
 *
 * Everything this host relies on is unchanged: `subscribe` never throws, dial is lazy, idle
 * connections are released, a failed LISTEN degrades to the poll loop. The one addition over
 * there — `end()`, a prompt teardown for a SIGTERM-driven host — is never called here: a
 * serverless instance is reaped by the platform, not shut down by a signal handler.
 */
export { makeChangeWakeHub, WAKE_IDLE_CLOSE_MS as IDLE_CLOSE_MS, WAKE_RETRY_AFTER_MS as RETRY_AFTER_MS } from "@trafficflow/db/cloud";
