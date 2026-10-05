import { and, desc, eq, gt, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { accounts, refreshTokens, sessions } from "./schema-mail.js";
import { erasedBearers } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * THE TOKENS OF AN ERASED ACCOUNT, KEPT BY HASH (cloud 0043) — written by the erasure, read by
 * the session door. The erasure deletes every session and refresh token of the account in the
 * transaction that stamps `accounts.erased_at`; without this record an installed app still
 * holding one is a stranger to the door and renews for ever. Hosted-only: it names a Cloud table,
 * so the engine's session door asks through `SessionLifecycle.bearerOfErasedAccount`.
 */

/**
 * How long past a REFRESH token's own expiry its erased account is still named: one native refresh
 * window again. A device silent past its window presents an expired token, and without this it
 * heard a plain refusal and kept its copy of the mail; past this horizon it still does.
 */
export const ERASED_REFRESH_KEEP_DAYS = 400;

/** An expiry plus {@link ERASED_REFRESH_KEEP_DAYS}, as SQL: how long the erasure names a token. */
export const erasureKeepsUntil = (expiry: AnyPgColumn): SQL<Date> =>
  sql<Date>`${expiry} + interval '1 day' * ${ERASED_REFRESH_KEEP_DAYS}::int`;

/**
 * WHAT THE ERASURE STILL NAMES, as the predicates {@link recordErasedBearers} selects by: a session's
 * live access token, and a refresh token not revoked whose keep is still open at `at`. Every other
 * site that deletes those rows (the hourly sign-in retention pass) deletes no session matching
 * {@link erasureStillNamesSession}, so a device silent past its window is still told its account
 * is gone. A revoked token is in neither: the erasure skips it, so a signed-out session's rows may
 * go on the pass's own horizon.
 */
export const erasureNamesAccess = (at: SQL): SQL =>
  sql`(${sessions.revokedAt} is null and ${sessions.accessTokenHash} is not null and ${sessions.accessExpiresAt} > ${at})`;
export const erasureNamesRefresh = (at: SQL): SQL =>
  sql`(${refreshTokens.revokedAt} is null and ${erasureKeepsUntil(refreshTokens.expiresAt)} > ${at})`;
/** A session the erasure would still copy a token of: the row in scope must be `sessions` itself. */
export const erasureStillNamesSession = (at: SQL): SQL =>
  sql`(${erasureNamesAccess(at)} or exists (select 1 from ${refreshTokens} where ${refreshTokens.sessionId} = ${sessions.id} and ${erasureNamesRefresh(at)}))`;

/**
 * Copy the account's access and refresh token hashes BEFORE the erasure deletes them — call it
 * inside that transaction. `ON CONFLICT DO NOTHING` keeps a retried erasure idempotent. An access
 * hash keeps its token's expiry (the client refreshes past it). A refresh hash is kept
 * {@link ERASED_REFRESH_KEEP_DAYS} past its token's expiry, for each family's unspent tail, live or
 * already expired, and for its NEWEST consumed token (a lost rotation answer's retry spends it).
 * Revoked, older consumed and claim-killed tokens are left out: one or two rows per family.
 */
export async function recordErasedBearers(tx: Tx, accountId: string, now: Date): Promise<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const keptUntil = erasureKeepsUntil(refreshTokens.expiresAt);
  // INSERT … SELECT, never a materialised list: the rows are the account's own and the erasure
  // deletes the same set next, so the statement's size is the database's problem, not a bind list.
  const access = await tx.insert(erasedBearers)
    .select(tx.select({
      tokenHash: sql<string>`${sessions.accessTokenHash}`.as("token_hash"),
      accountId: sessions.accountId,
      expiresAt: sessions.accessExpiresAt,
    }).from(sessions).where(and(eq(sessions.accountId, accountId), erasureNamesAccess(at))))
    .onConflictDoNothing()
    .returning({ tokenHash: erasedBearers.tokenHash });
  const refresh = await tx.insert(erasedBearers)
    .select(tx.select({
      tokenHash: refreshTokens.tokenHash,
      accountId: refreshTokens.accountId,
      expiresAt: keptUntil.as("expires_at"),
    }).from(refreshTokens).where(and(
      eq(refreshTokens.accountId, accountId), erasureNamesRefresh(at), isNull(refreshTokens.consumedAt),
    )))
    .onConflictDoNothing()
    .returning({ tokenHash: erasedBearers.tokenHash });
  const spent = await tx.insert(erasedBearers)
    .select(tx.selectDistinctOn([refreshTokens.familyId], {
      tokenHash: refreshTokens.tokenHash,
      accountId: refreshTokens.accountId,
      expiresAt: keptUntil.as("expires_at"),
    }).from(refreshTokens).where(and(
      eq(refreshTokens.accountId, accountId), erasureNamesRefresh(at), isNotNull(refreshTokens.consumedAt),
      // A claim-killed row (`expires_at = consumed_at`) was never spendable after the kill.
      gt(refreshTokens.expiresAt, refreshTokens.consumedAt),
    )).orderBy(refreshTokens.familyId, desc(refreshTokens.consumedAt)))
    .onConflictDoNothing()
    .returning({ tokenHash: erasedBearers.tokenHash });
  return access.length + refresh.length + spent.length;
}

/**
 * The account this token HASH belonged to, when that account's erasure committed; else `null`.
 * Reads the stamp itself (`accounts.erased_at`), the fact the wall's pass and `DELETE /account`
 * both write, so a row outliving a restored account could not answer for it. The id is the one
 * every answer to that token already carried, so it tells the holder nothing new. One lookup.
 */
export async function erasedBearerAccount(tx: Tx, tokenHash: string, now: Date): Promise<string | null> {
  const rows = await tx.select({ accountId: erasedBearers.accountId })
    .from(erasedBearers)
    .innerJoin(accounts, eq(accounts.id, erasedBearers.accountId))
    .where(and(
      eq(erasedBearers.tokenHash, tokenHash),
      gt(erasedBearers.expiresAt, sql`${now.toISOString()}::timestamptz`),
      isNotNull(accounts.erasedAt),
    ))
    .limit(1);
  return rows[0]?.accountId ?? null;
}

/** Delete every row past its expiry — the worker's hourly maintenance. */
export async function pruneErasedBearers(tx: Tx, now: Date): Promise<number> {
  const gone = await tx.delete(erasedBearers)
    .where(lte(erasedBearers.expiresAt, sql`${now.toISOString()}::timestamptz`))
    .returning({ tokenHash: erasedBearers.tokenHash });
  return gone.length;
}
