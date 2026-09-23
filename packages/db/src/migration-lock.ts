/**
 * The session-level advisory lock the whole two-pass migration runs under. It MUST NOT be the
 * worker's leader-election key: contending on `LEADER_LOCK_KEY` (+N per shard) would either block
 * behind a running worker forever or take the key a standby is waiting on and hand a second
 * process leadership on release. This key sits 9000 above the leader band, which no plausible
 * shard count reaches; `migration-lock-key.test.ts` asserts the gap is real. A blocking
 * `pg_advisory_lock`, not `try`: two concurrent `db:setup:prod` invocations should SERIALIZE (the
 * second applies nothing — the idempotency proof), not fail. {@link MIGRATION_LOCK_TIMEOUT_MS}
 * keeps "blocking" from meaning "forever".
 */
export const MIGRATION_LOCK_KEY = 4207279001n;

/**
 * How long to wait for the migration lock before giving up, in ms.
 *
 * `lock_timeout` is set for the ACQUISITION ONLY and then reset to 0. That reset is not
 * tidiness: every DDL statement in the journal takes heavy table locks, and leaving a
 * `lock_timeout` in place would let a momentarily busy table abort a migration mid-pass.
 */
export const MIGRATION_LOCK_TIMEOUT_MS = 120_000;
