import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { refreshTokens } from "@trafficflow/db";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession, req, setCookieMap, FIXED_NOW } from "./helpers.js";

/**
 * ═══ ONLY A SIGN-IN NAMES THE ACCOUNT IN `tf_owner` ═══════════════════════════════════════
 *
 * The session read wrote the marker into a jar that had none, and the renewal wrote back the one the
 * request carried. Both decided from the jar as the request LEFT: a Sign out pressed while either was
 * out wrote `signed_out_pending`, the answer landed after it and named the account again, and a tab
 * opened then drew the mailbox. Neither answer writes the marker now. The session read still names
 * the account in its body, and the web client puts a lost marker back itself, only where its jar says
 * nothing (`apps/webapp/app/shell/owner-cookie.ts`).
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/** A live, rotatable refresh token attached to a seeded session. */
async function seedRefresh(db: Db, s: { accountId: string; userId: string; sessionId: string }): Promise<string> {
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: randomUUID(),
    tokenHash: hashToken(refresh),
    expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
  });
  return refresh;
}

type Seeded = { token: string; accountId: string };

describe("GET /auth/session sets no cookie, whatever the jar holds", () => {
  it.each([
    ["a jar with no marker", { jar: (s: Seeded) => ({ cookie: `tf_session=${s.token}` }) }],
    ["a jar naming the account", { jar: (s: Seeded) => ({ cookie: `tf_session=${s.token}; tf_owner=${s.accountId}` }) }],
    ["a jar naming another account", { jar: (s: Seeded) => ({ cookie: `tf_session=${s.token}; tf_owner=${randomUUID()}` }) }],
    ["a pending sign-out", { jar: (s: Seeded) => ({ cookie: `tf_session=${s.token}; tf_owner=signed_out_pending` }) }],
    ["an enrollment session", { scope: "enrollment" as const, jar: (s: Seeded) => ({ cookie: `tf_session=${s.token}` }) }],
    ["a bearer on a bearer-only host", { bearerHost: true, jar: (s: Seeded) => ({ bearer: s.token }) }],
  ] as const)("%s", async (_jar, c) => {
    const { db, deps } = await makeDeps();
    const scope = "scope" in c ? c.scope : "full";
    const s = await seedSession(db, { now: FIXED_NOW, scope });
    const res = await H(req("GET", "/auth/session", c.jar(s)), "bearerHost" in c ? { ...deps, allowCookieAuth: false } : deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe(scope);
    // The body names the account, never the caller's value: the web client heals a silent jar from it.
    if (scope === "full") expect(body.user.accountId).toBe(s.accountId);
    expect(res.headers.getSetCookie(), "the session read wrote a cookie").toEqual([]);
  });
});

describe("the renewal's 204 rotates the session and leaves the marker alone", () => {
  it.each([
    ["a jar with no marker", () => ""],
    ["a jar naming the account", (s: Seeded) => `; tf_owner=${s.accountId}`],
    ["a pending sign-out", () => "; tf_owner=signed_out_pending"],
  ] as const)("%s: four cookies, no tf_owner", async (_jar, extra) => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const res = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}${extra(s)}`, body: "{}" }), deps);
    expect(res.status).toBe(204);
    // It rotated, so this is no green over a refused refresh; `refresh` resolves a token family, never a user.
    expect(res.headers.getSetCookie()).toHaveLength(4);
    expect(Object.keys(setCookieMap(res)).sort(), "the renewal wrote the marker")
      .toEqual(["tf_csrf", "tf_refresh", "tf_resume", "tf_session"]);
  });
});
