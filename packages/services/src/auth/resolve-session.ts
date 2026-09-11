import { and, eq, gt, isNull } from "drizzle-orm";
import { sessions, users } from "@trafficflow/db";
import { hashToken } from "./crypto.js";
import type { Db } from "../context.js";

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
  lastTwofaAt: Date | null;
  scope: SessionScope;
  /**
   * When this user's address was proven (`users.email_verified_at`, migration 0023), or
   * `null` for an unproven one. Read by `withVerifiedEmail` in `packages/api`.
   *
   * It rides on the SESSION resolution rather than being fetched by the middleware that needs
   * it, for the same reason `scope` does: a privilege decision that costs an extra round trip
   * is a privilege decision somebody will eventually be tempted to skip on the hot path. The
   * JOIN below is on `users.id` — the primary key, against a query already limited to one row —
   * so this costs nothing measurable and no additional query.
   */
  emailVerifiedAt: Date | null;
}

/**
 * Resolve an opaque session/bearer access token to its live session row, or `null`. Usable iff
 * `accessTokenHash` equals `hashToken(token)` (tokens are only stored hashed), not revoked, and
 * the access window has not elapsed; one lookup shared by cookie and bearer auth so
 * `packages/api` never duplicates the query. The `users` JOIN is INNER, and that is a decision: a
 * session row whose user has been erased resolves to `null` rather than to an identity with no
 * user behind it, so an erased account's live session stops authenticating on the next request.
 * `sessions.user_id` is a FK, so the join can only fail for a row that is genuinely gone.
 */
export async function resolveSession(db: Db, token: string, now: Date): Promise<ResolvedSessionCore | null> {
  const rows = await db
    .select({
      id: sessions.id,
      accountId: sessions.accountId,
      userId: sessions.userId,
      lastTwofaAt: sessions.lastTwofaAt,
      scope: sessions.scope,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      eq(sessions.accessTokenHash, hashToken(token)),
      isNull(sessions.revokedAt),
      gt(sessions.accessExpiresAt, now),
    ))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    accountId: row.accountId,
    userId: row.userId,
    sessionId: row.id,
    lastTwofaAt: row.lastTwofaAt,
    // The column is CHECK-constrained to ('full','enrollment') by migration 0017, so
    // this narrowing is exhaustive rather than a silent fallback.
    scope: row.scope === "enrollment" ? "enrollment" : "full",
    emailVerifiedAt: row.emailVerifiedAt,
  };
}
