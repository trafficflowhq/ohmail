/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ONE LINE IN postgres.js THAT CRASHES THIS PROCESS DURING THE OUTAGE IT WAS TAUGHT TO RIDE OUT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The shared-database-fault work stopped a database outage from quarantining the mailboxes it interrupts, and closed with a
 * residual it could not fix: `postgres@3.4.9` throws a `TypeError` **from a timer** when a
 * connection dies with a write still buffered. A timer throw has no promise to attach it to, so it
 * lands in `uncaughtException` — and `entry.ts` answers that with `exit(1)`. The worker therefore
 * crash-loops during exactly the outage it was taught to survive, which is the crash-loop
 * failure shape (`connection-error.e2e.test.ts`) reached through the driver instead of through
 * imapflow.
 *
 * ── THE PATH, READ OUT OF THE DRIVER AND THEN MEASURED ────────────────────────────────────────
 *
 *   `postgres/src/index.js:299-305`   `sql.begin()`'s `onexecute` captures the connection object
 *                                     BY REFERENCE, and `index.js:291-295` then sends every
 *                                     statement in the transaction straight to `c.execute(q)` —
 *                                     the pool's open/closed queues are bypassed entirely.
 *   `postgres/src/connection.js:156`  `execute()` guards only on `terminated`, which is set by
 *                                     `terminate()` and NOT by a socket that merely died.
 *   `postgres/src/connection.js:246`  `write()` defers anything under 1024 bytes through
 *                                     `setImmediate(nextWrite)`.
 *   `postgres/src/connection.js:255`  `nextWrite()` reads `socket.write` unguarded — and
 *                                     `connection.js:448` set `socket = null` when the connection
 *                                     closed.
 *
 * The transaction path is what makes this reachable rather than theoretical, and the worker is
 * made of transactions (`SyncWriteFence.transaction`, the per-message ingest). Sharper still:
 * `index.js`'s `scope` answers a failed statement by issuing `rollback` ON THE SAME CAPTURED
 * CONNECTION, so an interrupted transaction's own error handling is what writes into the dead
 * socket.
 *
 * MEASURED against real Postgres behind a TCP proxy, cutting the transport mid-transaction:
 * 5 166 transactions over 15 cut/restore rounds produced 4 escapes across 3 rounds — the same
 * order as the ~1-in-3 the earlier fault work recorded. Every one was byte-identical:
 *
 *     TypeError: Cannot read properties of null (reading 'write')
 *         at Immediate.nextWrite (…/postgres/src/connection.js:255:22)
 *         at process.processImmediate (node:internal/timers:511:21)
 *
 * Two frames. No query, no `code`, no user frame — there is nothing in the value itself that says
 * "database", which is why the crash contract could not have classified it and why the STACK is
 * the evidence rather than the message.
 *
 * ── WHY NOT UPGRADE THE DRIVER, WHICH WOULD BE THE RIGHT ANSWER IF IT EXISTED ─────────────────
 *
 * There is nothing to upgrade to. Checked against the registry rather than assumed: `postgres` has
 * 48 published versions, `dist-tags.latest` is **3.4.9** (2026-04-05), there is no 4.x and no
 * newer `3.4.x`. Upstream's most recent commit touching `src/connection.js` is
 * https://github.com/porsager/postgres/commit/de64f7ab3
 * (2026-01-06), which 3.4.9 already contains — so there is not even an unreleased fix to pull.
 *
 * A VENDOR PATCH was the other candidate and is deliberately not taken. `pnpm patch` would guard
 * `nextWrite` at source, which is the better shape in the abstract, but it introduces an
 * install-time mechanism into two independent deploy paths — the worker's `Dockerfile`, which runs
 * `pnpm install --frozen-lockfile --filter …` twice including a `--prod` pass, and the API's
 * Vercel build — and patch application under a filtered production install is a behaviour that
 * would have to be proven on the images rather than locally. The guard below costs nothing at
 * install time and covers every deploy path identically. The harm is also worker-shaped: the API
 * is request-scoped, where this throw costs one invocation rather than a restart loop.
 *
 * ── WHY THE MATCH IS THE STACK AND NOT THE WORKER'S STATE ─────────────────────────────────────
 *
 * The tempting extra condition is "…and a database fault is already announced" — bound the
 * suppression to a known outage window. It is wrong, and the measurement is why: the immediate
 * fires within a millisecond of the transport dying, BEFORE any awaited statement has rejected, so
 * this throw is routinely the FIRST symptom of the outage. Gating on the worker having already
 * noticed would let the first one through, and the first one is the crash.
 *
 * It also buys nothing. The three conditions below can only be produced by that one line in that
 * one vendored file: a null `socket` inside `nextWrite`. "The connection died" is therefore
 * DEFINITIONALLY true whenever this matches — it is not an inference from worker state, it is the
 * frame itself. Application code cannot forge it and no other defect can wear it.
 *
 * And nothing here weakens the announcement: the connection that died takes every subsequent call
 * through the seams `db-fault.ts` wraps, so the shard-wide condition is named by
 * `noteIfSharedDatabaseFault` on the normal path. This module's only job is to stop the process
 * dying before that can happen.
 */

/**
 * The reason to SURVIVE `err`, or `null` to let the crash contract do its normal work.
 *
 * Three conditions, all required, and each one is doing work:
 *
 *  1. **A `TypeError`** — a property read on `null`, which is what `socket.write` is when
 *     `socket` is `null`. Checked by `name` as well as by `instanceof` so a value crossing a
 *     realm boundary cannot be silently declined.
 *  2. **The message names the `write` property.** `nextWrite` touches exactly one property of
 *     `socket`, so a `TypeError` from that frame reading anything ELSE would be a different
 *     defect and must keep its exit.
 *  3. **The stack carries `nextWrite` inside a postgres driver file.** This is the unforgeable
 *     condition and the reason the other two are allowed to be as loose as they are. The worker
 *     deploys unbundled (`node dist/index.js` over a pnpm `node_modules`, `apps/worker/Dockerfile`)
 *     and postgres.js ships plain ESM source, so the production frame is the measured frame.
 *
 * The path test is deliberately `postgres` + `connection.js` rather than the exact pnpm store
 * layout (`.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js`), which is an artefact of
 * how one machine installed the package; it is NOT loosened to bare `postgres`, which any file in
 * a repo of this name would satisfy.
 */
export function driverWriteRaceReason(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== "TypeError") return null;
  if (!err.message.includes("reading 'write'")) return null;
  const stack = String(err.stack ?? "");
  if (!stack.includes("nextWrite")) return null;
  if (!/postgres[^\n]*connection\.js/.test(stack)) return null;
  return "postgres@3.4.9 threw from setImmediate(nextWrite) because the connection closed with a " +
    "write still buffered (connection.js:255 reads socket.write after connection.js:448 set " +
    "socket = null). The transport is gone, the statements it carried are already rejected " +
    "through the normal path, and there is no published driver version that fixes this — so the " +
    "process reports it and keeps running instead of crash-looping through the outage";
}

/** The predicate form, for tests and for reading a boolean at a call site. */
export function isDriverWriteRace(err: unknown): boolean {
  return driverWriteRaceReason(err) !== null;
}
