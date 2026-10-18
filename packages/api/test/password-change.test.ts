import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createApp, authRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import type { Db } from "@trafficflow/services";
import { sessions, users } from "@trafficflow/db";
import { makeDeps, seedSessionFor, req, type TestClock } from "./helpers.js";

/**
 * `POST /auth/password` over HTTP: the route's gates in front of `AuthService.changePassword`
 * (session, CSRF, step-up, body), the refusal a wrong current password gets on the wire, and the
 * caller's session left exactly as it was — no cookie rotated, none re-stamped. The service's own
 * rules (lockout, audit, the compare-and-set, the wake prune) are `auth-service.test.ts`'s.
 */

const app = createApp(authRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const PW = "pw-correct-horse-password";
const NEXT = "new-battery-staple-password";

/** Register over HTTP (a real credential row), then seed the full session the test speaks as. */
async function account(deps: ApiDeps, db: Db, clock: TestClock, lastTwofaAt: Date | null) {
  const reg = await H(req("POST", "/auth/register", {
    body: JSON.stringify({ email: "gil@x.example", password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }),
  }), deps);
  expect(reg.status).toBe(201);
  const { user } = await reg.json() as { user: { userId: string; accountId: string } };
  const me = await seedSessionFor(db, { accountId: user.accountId, userId: user.userId, now: clock.now(), lastTwofaAt });
  return {
    ...user,
    cookie: `tf_session=${me.token}; tf_csrf=${csrfTokenFor(me.token)}`,
    csrf: { "x-csrf-token": csrfTokenFor(me.token) },
    token: me.token,
  };
}

const change = (a: { cookie: string; csrf: Record<string, string> }, body: unknown): Request =>
  req("POST", "/auth/password", { cookie: a.cookie, headers: a.csrf, body: JSON.stringify(body) });

describe("POST /auth/password", () => {
  it("200 { revoked }: every other session is refused on its next request, the caller's is untouched", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await account(deps, db, clock, clock.now());
    const sibling = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now: clock.now() });
    // An unproven address: the route is `ceremony`, and rotating a known password must not wait on mail.
    const [u] = await db.select({ verified: users.emailVerifiedAt }).from(users).where(eq(users.id, me.userId));
    expect(u!.verified).toBeNull();
    const liveBefore = (await db.select().from(sessions)
      .where(and(eq(sessions.userId, me.userId), isNull(sessions.revokedAt)))).length;

    const res = await H(change(me, { currentPassword: PW, newPassword: NEXT }), deps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: liveBefore - 1 });
    expect(res.headers.getSetCookie(), "the caller's session is neither rotated nor re-stamped").toEqual([]);
    expect((await H(req("GET", "/auth/session", { cookie: `tf_session=${sibling.token}` }), deps)).status).toBe(401);
    expect((await H(req("GET", "/auth/session", { cookie: me.cookie }), deps)).status).toBe(200);

    const login = (password: string) => H(req("POST", "/auth/login", {
      body: JSON.stringify({ email: "gil@x.example", password }),
    }), deps);
    expect((await login(PW)).status).toBe(401);
    expect((await login(NEXT)).status).toBeLessThan(300);
  });

  it("a wrong current password is 401 credential_refused, and the session still answers", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await account(deps, db, clock, clock.now());

    const res = await H(change(me, { currentPassword: "wrong-guess-password", newPassword: NEXT }), deps);

    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("credential_refused");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await H(req("GET", "/auth/session", { cookie: me.cookie }), deps)).status).toBe(200);
  });

  it("403 step_up_required without a recent second factor", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await account(deps, db, clock, null);
    const res = await H(change(me, { currentPassword: PW, newPassword: NEXT }), deps);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("step_up_required");
  });

  it("401 without a session", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("POST", "/auth/password", {
      body: JSON.stringify({ currentPassword: PW, newPassword: NEXT }),
    }), deps);
    expect(res.status).toBe(401);
  });

  it("403 without the CSRF token", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await account(deps, db, clock, clock.now());
    const res = await H(req("POST", "/auth/password", {
      cookie: me.cookie, body: JSON.stringify({ currentPassword: PW, newPassword: NEXT }),
    }), deps);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("csrf_failed");
  });

  it("a self-hosted server mounts it too: its password is the same credential", () => {
    expect(selfHostRoutes.filter((r) => r.method === "POST" && r.pattern === "/auth/password")).toHaveLength(1);
  });

  it("400 on an empty body, a JSON null included", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await account(deps, db, clock, clock.now());
    for (const body of ["{}", "null"]) {
      const res = await H(req("POST", "/auth/password", { cookie: me.cookie, headers: me.csrf, body }), deps);
      expect(res.status, body).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    }
  });
});
