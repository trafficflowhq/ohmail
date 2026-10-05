import { and, asc, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { devices, pairingTokens, refreshTokens, sessions } from "./schema-mail.js";
import { invites, loginTokens, oauthAuthCodes, staffSessions } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";
import { affected, RETENTION_BATCHES_PER_ACCOUNT, RETENTION_DELETE_BATCH } from "./change-log-retention.js";
import { pruneWebauthnChallenges } from "./webauthn-challenges.js";
import { pruneDeviceCeremonies, pruneOAuthCeremonies } from "./oauth-ceremony.js";
import { erasureKeepsUntil, erasureStillNamesSession } from "./erased-bearers.js";

/**
 * SIGN-IN RECORDS PAST THEIR HORIZON — the hourly pass's deletes. Every sign-in link, code and
 * approval, every OAuth code, pairing token, staff session and unused invitation goes once it is
 * `retentionMs` past its expiry. A session goes `retentionMs` after it was revoked, or, never
 * revoked, once the erasure's keep on its refresh window has run out, with its refresh tokens; never
 * while the erasure would still name a token of it, nor while its family has a live session.
 * Bounded per table and by one wall clock; whatever a run leaves, the next hour finds. Postgres
 * only: the hosted worker runs it.
 */

/** Sessions (and device addresses) one statement takes. */
export const SIGN_IN_SESSION_BATCH = 5_000;

/** The whole pass's wall-clock bound. A backlog drains across hours, never inside one. */
export const SIGN_IN_RETENTION_DEADLINE_MS = 10_000;

export interface SignInRetentionResult {
  loginTokens: number;
  oauthCodes: number;
  pairingTokens: number;
  staffSessions: number;
  invites: number;
  sessions: number;
  refreshTokens: number;
  /** Device rows whose IP address was blanked: no session of theirs is left. */
  deviceAddresses: number;
  /** Passkey challenges deleted, which the opportunistic prune would leave for the next ceremony. */
  challenges: number;
  /** `dry` every table drained, `batches` a table still had rows after its batches, `deadline` the clock. */
  stoppedBy: "dry" | "batches" | "deadline";
}

/** A result with nothing counted yet. */
export const emptySignInRetention = (): SignInRetentionResult => ({
  loginTokens: 0, oauthCodes: 0, pairingTokens: 0, staffSessions: 0, invites: 0,
  sessions: 0, refreshTokens: 0, deviceAddresses: 0, challenges: 0, stoppedBy: "dry",
});

export interface SignInRetentionOptions {
  /** How long past expiry or revocation a record is kept. Required. */
  retentionMs: number;
  batch?: number;
  maxBatches?: number;
  sessionBatch?: number;
  deadlineMs?: number;
  /** Injected so a test drives the deadline without waiting for it. */
  clock?: () => number;
  /** Counted into as each batch commits, so a caller that catches a failure can say what went. */
  progress?: SignInRetentionResult;
}

/** The oldest `n` ids past `cut` that no other transaction holds, as the array an `= any(...)`
 *  delete takes in one statement. SKIP LOCKED: a row an erasure has already taken is passed over,
 *  so the pass never waits for that transaction and never holds a row it waits on. */
const oldest = (id: AnyPgColumn, expires: AnyPgColumn, table: SQL, cut: string, n: number, extra?: SQL): SQL =>
  sql`${id} = any(array(select ${id} from ${table} where ${expires} < ${cut}::timestamptz${
    extra ? sql` and ${extra}` : sql``} order by ${expires} limit ${n} for update skip locked))`;

type Counted = Exclude<keyof SignInRetentionResult, "stoppedBy">;

export async function pruneSignInRecords(
  db: Tx, now: Date, opts: SignInRetentionOptions,
): Promise<SignInRetentionResult> {
  const batch = opts.batch ?? RETENTION_DELETE_BATCH;
  const maxBatches = opts.maxBatches ?? RETENTION_BATCHES_PER_ACCOUNT;
  const sessionBatch = opts.sessionBatch ?? SIGN_IN_SESSION_BATCH;
  const deadlineMs = opts.deadlineMs ?? SIGN_IN_RETENTION_DEADLINE_MS;
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const late = (): boolean => clock() - startedAt >= deadlineMs;
  const cut = new Date(now.getTime() - opts.retentionMs).toISOString();
  const at = sql`${now.toISOString()}::timestamptz`;
  const result = Object.assign(opts.progress ?? emptySignInRetention(), emptySignInRetention());

  /** Batches of one statement into `field`, until a short batch, the batch count or the clock. */
  const drain = async (field: Counted, step: (n: number) => Promise<number>, n: number): Promise<void> => {
    for (let i = 0; ; i++) {
      if (late()) { result.stoppedBy = "deadline"; return; }
      if (i >= maxBatches) { if (result.stoppedBy === "dry") result.stoppedBy = "batches"; return; }
      const got = await step(n);
      result[field] += got;
      if (got < n) return;
    }
  };

  // Every purpose under one horizon, an unconfirmed desktop approval (no user) included.
  await drain("loginTokens", async (n) => affected(await db.delete(loginTokens)
    .where(oldest(loginTokens.id, loginTokens.expiresAt, sql`${loginTokens}`, cut, n))), batch);
  // A consumed code stays its 30 days: a replay inside them still revokes what it issued.
  await drain("oauthCodes", async (n) => affected(await db.delete(oauthAuthCodes)
    .where(oldest(oauthAuthCodes.id, oauthAuthCodes.expiresAt, sql`${oauthAuthCodes}`, cut, n))), batch);
  await drain("pairingTokens", async (n) => affected(await db.delete(pairingTokens)
    .where(oldest(pairingTokens.id, pairingTokens.expiresAt, sql`${pairingTokens}`, cut, n))), batch);
  await drain("staffSessions", async (n) => affected(await db.delete(staffSessions)
    .where(oldest(staffSessions.id, staffSessions.expiresAt, sql`${staffSessions}`, cut, n))), batch);
  // Unused only: a used invitation answers which invite opened an account.
  await drain("invites", async (n) => affected(await db.delete(invites)
    .where(oldest(invites.id, invites.expiresAt, sql`${invites}`, cut, n, sql`${invites.consumedAt} is null`))), batch);

  // SESSIONS. Revoked: `retentionMs` after the revocation — the erasure skips a revoked token, so
  // nothing of it is still named. Never revoked: only once the erasure's keep past its refresh
  // window has run out, so a device silent past its window is still told its account is gone.
  // Neither while the erasure would still name a token of it, nor while its family has a live
  // session (the consumed tokens are the reuse detector's evidence). The family's lock order: the
  // session rows first, FOR UPDATE SKIP LOCKED, then their tokens, under a lock timeout for the one
  // wait left (a token row some path took without its session row).
  const dead = or(
    lt(sessions.revokedAt, sql`${cut}::timestamptz`),
    and(isNull(sessions.revokedAt), sql`${erasureKeepsUntil(sessions.refreshExpiresAt)} <= ${at}`),
  )!;
  const familyLive = sql`exists (select 1 from ${sessions} live where live.family_id = ${sessions.familyId}
    and live.revoked_at is null and live.refresh_expires_at > ${at})`;
  await drain("sessions", async (n) => {
    const [gone, tokens] = await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      const rows = await tx.select({ id: sessions.id }).from(sessions)
        .where(and(dead, sql`not ${familyLive}`, sql`not ${erasureStillNamesSession(at)}`))
        .orderBy(asc(sessions.id)).limit(n)
        .for("update", { skipLocked: true });
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return [0, 0] as const;
      const t = affected(await tx.delete(refreshTokens).where(inArray(refreshTokens.sessionId, ids)));
      return [affected(await tx.delete(sessions).where(inArray(sessions.id, ids))), t] as const;
    });
    result.refreshTokens += tokens;
    return gone;
  }, sessionBatch);

  // The address a device was added from, once no session of its is left; the row and its name
  // stay. Batched and passed over when held, as above.
  await drain("deviceAddresses", async (n) => affected(await db.update(devices).set({ ip: "" }).where(sql`${devices.id} = any(array(
    select ${devices.id} from ${devices} where ${and(ne(devices.ip, ""), lt(devices.lastSeenAt, sql`${cut}::timestamptz`))}
    and not exists (select 1 from ${sessions} where ${sessions.deviceId} = ${devices.id})
    order by ${devices.id} limit ${n} for update skip locked))`)), sessionBatch);

  // The ceremony tables keep their own hour; here they stop waiting for the next ceremony.
  if (!late()) {
    result.challenges = await pruneWebauthnChallenges(db, { now });
    await pruneOAuthCeremonies(db, { now });
    await pruneDeviceCeremonies(db, { now });
  } else result.stoppedBy = "deadline";

  return result;
}
