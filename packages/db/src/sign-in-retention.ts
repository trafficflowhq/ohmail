import { and, asc, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { devices, pairingTokens, refreshTokens, sessions } from "./schema-mail.js";
import { invites, loginTokens, oauthAuthCodes, staffSessions } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";
import { affected, RETENTION_BATCHES_PER_ACCOUNT, RETENTION_DELETE_BATCH } from "./change-log-retention.js";
import { pruneWebauthnChallenges } from "./webauthn-challenges.js";
import { pruneDeviceCeremonies, pruneOAuthCeremonies } from "./oauth-ceremony.js";

/**
 * SIGN-IN RECORDS PAST THEIR HORIZON — the hourly pass's deletes. Every sign-in link, code and
 * approval, every OAuth code, pairing token, staff session and unused invitation goes once it is
 * `retentionMs` past its expiry; a session goes `retentionMs` after it was revoked or its refresh
 * window closed, with its refresh tokens, unless its family still has a live session (the consumed
 * tokens there are the reuse detector's evidence). Bounded per table and by one wall clock;
 * whatever a run leaves, the next hour finds. Postgres only: the hosted worker runs it.
 */

/** Sessions one transaction locks and deletes, with their refresh tokens. */
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
  /** Passkey challenges the opportunistic prune would otherwise leave for the next ceremony. */
  challenges: number;
  /** `dry` every table drained, `batches` a table still had rows after its batches, `deadline` the clock. */
  stoppedBy: "dry" | "batches" | "deadline";
}

export interface SignInRetentionOptions {
  /** How long past expiry, revocation or the refresh window's end a record is kept. Required. */
  retentionMs: number;
  batch?: number;
  maxBatches?: number;
  sessionBatch?: number;
  deadlineMs?: number;
  /** Injected so a test drives the deadline without waiting for it. */
  clock?: () => number;
}

/** The oldest `n` ids past `cut`, as the array an `= any(...)` delete takes in one statement. */
const oldest = (id: AnyPgColumn, expires: AnyPgColumn, table: SQL, cut: string, n: number, extra?: SQL): SQL =>
  sql`${id} = any(array(select ${id} from ${table} where ${expires} < ${cut}::timestamptz${
    extra ? sql` and ${extra}` : sql``} order by ${expires} limit ${n}))`;

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
  const nowIso = now.toISOString();
  let stoppedBy: SignInRetentionResult["stoppedBy"] = "dry";

  /** Batches of one statement until a short batch, the batch count or the clock. */
  const drain = async (step: (n: number) => Promise<number>, n: number): Promise<number> => {
    let total = 0;
    for (let i = 0; ; i++) {
      if (late()) { stoppedBy = "deadline"; return total; }
      if (i >= maxBatches) { if (stoppedBy === "dry") stoppedBy = "batches"; return total; }
      const got = await step(n);
      total += got;
      if (got < n) return total;
    }
  };

  const result: SignInRetentionResult = {
    loginTokens: 0, oauthCodes: 0, pairingTokens: 0, staffSessions: 0, invites: 0,
    sessions: 0, refreshTokens: 0, deviceAddresses: 0, challenges: 0, stoppedBy,
  };

  // Every purpose under one horizon, an unconfirmed desktop approval (no user) included.
  result.loginTokens = await drain(async (n) => affected(await db.delete(loginTokens)
    .where(oldest(loginTokens.id, loginTokens.expiresAt, sql`${loginTokens}`, cut, n))), batch);
  // A consumed code stays its 30 days: a replay inside them still revokes what it issued.
  result.oauthCodes = await drain(async (n) => affected(await db.delete(oauthAuthCodes)
    .where(oldest(oauthAuthCodes.id, oauthAuthCodes.expiresAt, sql`${oauthAuthCodes}`, cut, n))), batch);
  result.pairingTokens = await drain(async (n) => affected(await db.delete(pairingTokens)
    .where(oldest(pairingTokens.id, pairingTokens.expiresAt, sql`${pairingTokens}`, cut, n))), batch);
  result.staffSessions = await drain(async (n) => affected(await db.delete(staffSessions)
    .where(oldest(staffSessions.id, staffSessions.expiresAt, sql`${staffSessions}`, cut, n))), batch);
  // Unused only: a used invitation answers which invite opened an account.
  result.invites = await drain(async (n) => affected(await db.delete(invites)
    .where(oldest(invites.id, invites.expiresAt, sql`${invites}`, cut, n, sql`${invites.consumedAt} is null`))), batch);

  // SESSIONS, the family's lock order: the session rows first (FOR UPDATE, SKIP LOCKED, so an
  // erasure or a rotation holding one is passed over, never waited on), then their tokens.
  const dead = or(
    lt(sessions.revokedAt, sql`${cut}::timestamptz`),
    and(isNull(sessions.revokedAt), lt(sessions.refreshExpiresAt, sql`${cut}::timestamptz`)),
  )!;
  const familyLive = sql`exists (select 1 from ${sessions} live where live.family_id = ${sessions.familyId}
    and live.revoked_at is null and live.refresh_expires_at > ${nowIso}::timestamptz)`;
  result.sessions = await drain(async (n) => db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    const rows = await tx.select({ id: sessions.id }).from(sessions)
      .where(and(dead, sql`not ${familyLive}`))
      .orderBy(asc(sessions.id)).limit(n)
      .for("update", { skipLocked: true });
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return 0;
    result.refreshTokens += affected(await tx.delete(refreshTokens).where(inArray(refreshTokens.sessionId, ids)));
    return affected(await tx.delete(sessions).where(inArray(sessions.id, ids)));
  }), sessionBatch);

  // The address a device was added from, once no session of its is left. The row and its name stay.
  if (!late()) {
    result.deviceAddresses = affected(await db.update(devices).set({ ip: "" }).where(and(
      ne(devices.ip, ""), lt(devices.lastSeenAt, sql`${cut}::timestamptz`),
      sql`not exists (select 1 from ${sessions} where ${sessions.deviceId} = ${devices.id})`,
    )));
  } else stoppedBy = "deadline";

  // The ceremony tables keep their own hour; here they stop waiting for the next ceremony.
  if (!late()) {
    result.challenges = await pruneWebauthnChallenges(db, { now });
    await pruneOAuthCeremonies(db, { now });
    await pruneDeviceCeremonies(db, { now });
  } else stoppedBy = "deadline";

  result.stoppedBy = stoppedBy;
  return result;
}
