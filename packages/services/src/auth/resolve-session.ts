import { and, eq, gt, isNull } from "drizzle-orm";
import { assertBinding, bindDb, sessions, users } from "@trafficflow/db";
import { hashToken } from "./crypto.js";
import type { ContextDb, UnboundDb } from "../context.js";

/**
 * A session's privilege scope. `'full'` is a completed
 * two-factor login. `'enrollment'` is the password-only session minted by
 * register (or by a re-entry login of a user with zero enrolled methods): it may
 * reach ONLY the routes flagged `enrollmentOk`, and `withSession` rejects it
 * everywhere else.
 */
export type SessionScope = "full" | "enrollment";

/**
 * The session identity `packages/api`'s `withSession` attaches to a request. The
 * transport-dependent `via` ('cookie' | 'bearer') is added by the middleware — a
 * session is the same row however its token arrived — so it is NOT part of the
 * core resolved fields returned here. `scope` IS part of the row: the privilege
 * decision must never depend on how the token travelled.
 */
export interface ResolvedSessionCore {
  accountId: string;
  userId: string;
  sessionId: string;
  familyId?: string;
  lastTwofaAt: Date | null;
  scope: SessionScope;
  /**
   * When this session's `/sync` last reached the horizon (`sessions.last_synced_at`, mail 0070),
   * read from the same row. Bookkeeping only: `GET /sync` skips a stamp that is not due yet. Never
   * a privilege input, never in a DTO. Absent means unknown, and the stamp then runs as before.
   */
  lastSyncedAt?: Date | null;
}

/**
 * Resolve an opaque session/bearer access token to its live session row, or `null`. Usable iff
 * `accessTokenHash` equals `hashToken(token)` (tokens are only stored hashed), not revoked, and
 * the access window has not elapsed. Cookie and bearer auth share this lookup.
 * The digest keys the binder's single statement before the account is known. The foreign key
 * from `sessions.user_id` guarantees the session's user exists.
 */
export async function resolveSession(db: UnboundDb, token: string, now: Date): Promise<ResolvedSessionCore | null> {
  const digest = hashToken(token);
  const [row] = await bindDb(db, { account: null, key: digest })
    .select({
      id: sessions.id,
      familyId: sessions.familyId,
      accountId: sessions.accountId,
      userId: sessions.userId,
      lastTwofaAt: sessions.lastTwofaAt,
      scope: sessions.scope,
      lastSyncedAt: sessions.lastSyncedAt,
    })
    .from(sessions)
    .where(and(
      eq(sessions.accessTokenHash, digest),
      isNull(sessions.revokedAt),
      gt(sessions.accessExpiresAt, now),
    ))
    .limit(1);
  if (!row) return null;
  return {
    accountId: row.accountId,
    userId: row.userId,
    sessionId: row.id,
    familyId: row.familyId,
    lastTwofaAt: row.lastTwofaAt,
    scope: row.scope === "enrollment" ? "enrollment" : "full",
    lastSyncedAt: row.lastSyncedAt,
  };
}

/**
 * When the session's user proved the address (`users.email_verified_at`), or null. Read on the
 * request's handle, which must name the session's account: the account lock shows a user's row
 * only to its own account, and the look-up above learns the account only from its answer. Asked
 * by the spend gate, only on the routes an unverified account may not reach.
 */
export async function sessionEmailVerifiedAt(
  db: ContextDb, session: Pick<ResolvedSessionCore, "accountId" | "userId">,
): Promise<Date | null> {
  assertBinding(db, session.accountId);
  const [user] = await db.select({ emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(and(eq(users.id, session.userId), eq(users.accountId, session.accountId)))
    .limit(1);
  return user?.emailVerifiedAt ?? null;
}
