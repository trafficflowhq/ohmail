import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { sessions } from "@trafficflow/db";
import { hashToken, resolveSession, type ResolvedSessionCore } from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";
import { mintLaunchSession, type LocalWorld } from "./identity.js";
import type { Diagnostic } from "./log.js";

/**
 * THIS PROCESS'S LAUNCH BEARER, DECIDED IN MEMORY BY THE ONE WRITER THAT OWNS IT — both doors.
 *
 * The store's answer is read once at the mint and held, so a request carrying it never queues
 * behind a mirror page. It lives as long as the process: the token is never written down and the
 * next launch revokes the row, so a clock expiry only stopped a window left open for a day. From
 * its half-life on, a use renews the row a full lifetime ahead, so the store agrees with the
 * memory; it ends at `end()`, or when the store says the row was revoked. Any other token is not
 * this holder's to answer, and the store decides it as before.
 */
type BearerDecision = { held: ResolvedSessionCore } | "refused" | "unknown";

interface LaunchBearer {
  /** The bearer itself. In memory only — the database holds its hash. */
  readonly token: string;
  readonly sessionId: string;
  /** How many stale launch sessions the mint revoked. */
  readonly revoked: number;
  /** Renews the row first when it is due, so a caller that reads the store next agrees with this. */
  decide(token: string, now: Date): Promise<BearerDecision>;
  /** The store this decision was read from is closing: every later request is refused. */
  end(): void;
}

/** The row's lifetime from the mint and from each renewal. */
export const LAUNCH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed renewal, how long a still-live bearer waits before asking the store again. */
const RENEW_RETRY_MS = 60_000;

export const LAUNCH_SESSION_EXPIRED = "launch_session_expired";

/** The one refusal both doors give their own ended bearer; the window names a state from it. */
export function launchSessionExpiredResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: LAUNCH_SESSION_EXPIRED, message: "this install's sign-in expired; sign in again to keep reading mail" },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

export async function mintLaunchBearer(
  db: LocalDb, world: LocalWorld, now: Date, log?: Diagnostic,
): Promise<LaunchBearer> {
  const session = await mintLaunchSession(db, world, now, LAUNCH_SESSION_TTL_MS);
  // The held answer IS the store's answer, read once. A fresh mint that does not resolve is a store
  // that cannot admit its own window, and the launch says so rather than refusing every request.
  const core = await resolveSession(db, session.token, now);
  if (core === null) throw new Error("the launch bearer this process minted does not resolve in its own store");
  const hash = Buffer.from(hashToken(session.token));
  let expiresAt = session.expiresAt.getTime();
  let renewAt = now.getTime() + LAUNCH_SESSION_TTL_MS / 2;
  let ended = false;
  let renewing: Promise<void> | null = null;

  /* ONE WRITE, AND ONLY OF AN UNREVOKED ROW: zero rows back means somebody ended this session, and
     the holder ends with it. A failed write keeps the old expiry and asks again a minute later. */
  const renew = async (at: number): Promise<void> => {
    const next = new Date(at + LAUNCH_SESSION_TTL_MS);
    try {
      const rows = await db.update(sessions)
        .set({ accessExpiresAt: next, refreshExpiresAt: next })
        .where(and(eq(sessions.id, session.sessionId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      if (rows.length === 0) {
        ended = true;
        log?.("launch_bearer_revoked", { reason: "this launch's session row was revoked, so its bearer is refused from now on" });
        return;
      }
      expiresAt = next.getTime();
      renewAt = at + LAUNCH_SESSION_TTL_MS / 2;
    } catch (err) {
      renewAt = Math.min(at + RENEW_RETRY_MS, expiresAt);
      log?.("launch_bearer_renew_failed", { err, reason: "the launch session's expiry was not moved; the next request asks again" });
    }
  };

  return {
    token: session.token,
    sessionId: session.sessionId,
    revoked: session.revoked,
    async decide(token: string, at: Date): Promise<BearerDecision> {
      const presented = Buffer.from(hashToken(token));
      if (presented.length !== hash.length || !timingSafeEqual(presented, hash)) return "unknown";
      const t = at.getTime();
      if (!ended && t >= renewAt) {
        renewing ??= renew(t).finally(() => { renewing = null; });
        await renewing;
      }
      if (ended || t >= expiresAt) return "refused";
      return { held: core };
    },
    end(): void {
      ended = true;
    },
  };
}
