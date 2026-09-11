/**
 * ONE LINE IN postgres.js THAT CRASHES THIS PROCESS DURING THE OUTAGE IT WAS TAUGHT TO RIDE OUT. The
 * shared-database-fault work stopped an outage from quarantining mailboxes but left a residual:
 * `postgres@3.4.9` throws a `TypeError` from a TIMER when a connection dies with a write buffered — a timer
 * throw has no promise, so it lands in `uncaughtException`, and `entry.ts` answers that with `exit(1)`, so
 * the worker crash-loops during the very outage. The path (`connection.js:255` `nextWrite` reads
 * `socket.write` unguarded after `connection.js:448` set `socket = null`) is reachable via the transaction
 * path the worker is made of. Measured behind a TCP proxy: 5 166 transactions, 15 cut/restore rounds, 4
 * escapes, every one byte-identical (`Cannot read properties of null (reading 'write')` at
 * `Immediate.nextWrite`). No upgrade exists (`dist-tags.latest` is 3.4.9, commit https://github.com/porsager/postgres/commit/de64f7ab3 already in); a `pnpm patch` was rejected (install-time mechanism across two deploy paths). The guard matches the STACK; the announcement still runs via `noteIfSharedDatabaseFault`. */

/**
 * The reason to SURVIVE `err`, or `null` to let the crash contract do its normal work. Three conditions,
 * all required: (1) a `TypeError` (a property read on `null`, checked by `name` as well as `instanceof` so
 * a realm-boundary value cannot slip); (2) the message names the `write` property (`nextWrite` touches
 * exactly one property of `socket`, so a `TypeError` reading anything else is a different defect and keeps
 * its exit); (3) the stack carries `nextWrite` inside a postgres driver file — the unforgeable condition,
 * and the reason the other two may be loose (the worker deploys unbundled, `node dist/index.js` over a pnpm
 * `node_modules`, `apps/worker/Dockerfile`, and postgres.js ships plain ESM, so the production frame is the
 * measured frame). The path test is `postgres` + `connection.js`, not the exact pnpm store layout (an
 * artefact of one install), and NOT bare `postgres` (any file in a repo of this name would satisfy it). */
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
