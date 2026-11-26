import {
  pruneChangeLogForAccount, retentionAccountsAfter, pruneAuditLog, pruneAuthEvents, pruneConnectAttempts, pruneSignInRecords,
  SIGN_IN_RETENTION_DEADLINE_MS, RETENTION_ACCOUNTS_PER_TICK, RETENTION_DELETE_BATCH, RETENTION_BATCHES_PER_ACCOUNT, SIGN_IN_RECORD_RETENTION_MS,
  emptySignInRetention, type SignInRetentionOptions, type SignInRetentionResult,
} from "@trafficflow/db/cloud";
import {
  expiredFingerprintAccounts, pruneSendFingerprints, readDrainCursor, writeDrainCursor, type Tx,
} from "@trafficflow/db";
import type { SQL } from "drizzle-orm";
import type { Logger } from "@trafficflow/core/mail";

/**
 * RETENTION (mail 0122) — the pass that ends four tables' unbounded growth. The
 * horizons and the deletes live in `@trafficflow/db/cloud`'s `retention.ts` (ONE place); this is
 * the cadence and the rotation. It rides the hourly maintenance block under the leader lock, so
 * exactly one process prunes, visits {@link RETENTION_ACCOUNTS_PER_TICK} accounts per tick
 * round-robin, with a durable position for each shard. A failed attempt is logged and
 * revisited on the next lap. Fixed-age fleet sweeps use the worker's horizon policies.
 */
interface RetentionShard {
  forAccount: (id: string) => Tx;
  shard?: SQL | undefined;
  shardKey: string;
}

export async function retentionPrunePass(
  db: Tx, now: Date, log: Logger, opts?: RetentionShard,
): Promise<void> {
  const cursorKey = "change_log_retention:" + opts?.shardKey;
  try {
    const after = opts ? (await readDrainCursor(db, cursorKey))?.messageId ?? "" : "";
    let ids = await retentionAccountsAfter(db, after, RETENTION_ACCOUNTS_PER_TICK, opts?.shard);
    if (ids.length === 0 && after !== "") {
      ids = await retentionAccountsAfter(db, "", RETENTION_ACCOUNTS_PER_TICK, opts?.shard);
    }
    let pruned = 0;
    let accounts = 0;
    for (const id of ids) {
      try {
        const r = await pruneChangeLogForAccount(opts?.forAccount(id) ?? db, id, now, { hosted: opts !== undefined });
        pruned += r.deleted;
        accounts += 1;
      } catch (err) {
        log.warn("retention_prune_account_failed", { err });
      }
      if (opts) await writeDrainCursor(db, cursorKey, { at: now, messageId: id }, now);
    }
    if (pruned > 0) log.info("retention_prune_change_log", { accounts, pruned });
  } catch (err) {
    log.warn("retention_prune_failed", { err });
  }

  for (const [event, prune] of [
    ["retention_prune_audit_log", pruneAuditLog],
    ["retention_prune_auth_events", pruneAuthEvents],
    ["retention_prune_connect_attempts", pruneConnectAttempts],
  ] as const) {
    try {
      let total = 0;
      for (let i = 0; i < RETENTION_BATCHES_PER_ACCOUNT; i++) {
        const n = await prune(db, now);
        total += n;
        if (n < RETENTION_DELETE_BATCH) break;
      }
      if (total > 0) log.info(event, { pruned: total });
    } catch (err) {
      log.warn("retention_prune_failed", { err });
    }
  }
}

/** Sweep expired claims under their account, rotating past accounts with protected sends. */
export async function pruneWorkerSendFingerprints(db: Tx, now: Date, opts: RetentionShard): Promise<number> {
  const cursorKey = "send_fingerprint_retention:" + opts.shardKey;
  const deadline = Date.now() + SIGN_IN_RETENTION_DEADLINE_MS;
  const after = (await readDrainCursor(db, cursorKey))?.messageId ?? null;
  let ids = await expiredFingerprintAccounts(db, now, after, RETENTION_BATCHES_PER_ACCOUNT, opts.shard);
  if (ids.length === 0 && after !== null) {
    ids = await expiredFingerprintAccounts(db, now, null, RETENTION_BATCHES_PER_ACCOUNT, opts.shard);
  }
  let deleted = 0;
  for (const id of ids) {
    if (Date.now() >= deadline) break;
    deleted += await pruneSendFingerprints(opts.forAccount(id), now, { accountId: id });
    await writeDrainCursor(db, cursorKey, { at: now, messageId: id }, now);
  }
  return deleted;
}

/**
 * SIGN-IN RETENTION — the cadence of `pruneSignInRecords`: once per maintenance tick, after the
 * fixed-age prunes, under the leader lock. NEVER THROWS, for `retentionPrunePass`'s reason. Counts
 * only in the log, one line per table that lost rows and one summary — a failed run's summary too,
 * with what its committed batches took; every shard leader runs the section, so with several shards
 * a tick's counts are split across their logs, never doubled (a row is deleted once). The horizon
 * is `SIGN_IN_RECORD_RETENTION_MS`, from `retention.ts`.
 */
export async function signInRetentionPass(
  db: Tx, now: Date, log: Logger, opts: Omit<SignInRetentionOptions, "retentionMs" | "progress"> = {},
): Promise<void> {
  const startedAt = Date.now();
  const progress = emptySignInRetention();
  const counted = (r: SignInRetentionResult): number => {
    const tables: Array<[string, number]> = [
      ["login_tokens", r.loginTokens], ["oauth_auth_codes", r.oauthCodes], ["pairing_tokens", r.pairingTokens],
      ["staff_sessions", r.staffSessions], ["invites", r.invites], ["sessions", r.sessions],
      ["refresh_tokens", r.refreshTokens], ["webauthn_challenges", r.challenges],
    ];
    let pruned = 0;
    for (const [table, n] of tables) {
      pruned += n;
      if (n > 0) log.info("sign_in_retention_table", { table, pruned: n });
    }
    return pruned;
  };
  try {
    const r = await pruneSignInRecords(db, now, { ...opts, retentionMs: SIGN_IN_RECORD_RETENTION_MS, progress });
    const pruned = counted(r);
    if (pruned > 0 || r.deviceAddresses > 0 || r.stoppedBy !== "dry") {
      log.info("sign_in_retention_pruned", {
        pruned, cleared: r.deviceAddresses, stoppedBy: r.stoppedBy, elapsedMs: Date.now() - startedAt,
      });
    }
  } catch (err) {
    const pruned = counted(progress);
    log.warn("sign_in_retention_failed", { err, pruned, cleared: progress.deviceAddresses, elapsedMs: Date.now() - startedAt });
  }
}
