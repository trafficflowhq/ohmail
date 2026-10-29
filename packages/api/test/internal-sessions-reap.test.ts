import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { sessions } from "@trafficflow/db";
import { makeDeps, seedSession, seedSessionFor, seedDevice, req } from "./helpers.js";

/**
 * `GET /internal/sessions/reap` — the web-session reaper's cron surface, pinned exactly as
 * `/internal/alerts/run`'s is: 404 when unconfigured (no secret ⇒ no endpoint — a reaper a
 * deployment cannot authenticate must not be advertised, AND the hygiene does not run there,
 * which the live acceptance verifies armed rather than assuming), 401 on a wrong bearer, and
 * the pass on either accepted secret (the operator's own, or the platform cron's). The
 * REAPING itself — what may be touched, the budget, the family sweep — is
 * `session-reaper.test.ts`'s subject; here one stale row proves the route actually runs the
 * pass on `deps.db`, and one paired row proves the route adds no reach the pass lacks.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

const SECRET = "s".repeat(32);
const CRON = "c".repeat(32);
const DAY = 24 * 60 * 60 * 1000;

function get(secret?: string): Request {
  return new Request("http://api.test/internal/sessions/reap", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /internal/sessions/reap — the surface", () => {
  it("404s on a host with no alerts secret: no secret ⇒ no endpoint, and NO hygiene", async () => {
    const { deps } = await makeDeps();
    expect((await H(get(SECRET), deps)).status).toBe(404);
  });

  it("401s with no bearer or a wrong one; accepts BOTH the operator secret and the cron's", async () => {
    const { deps } = await makeDeps();
    const armed = { ...deps, alerts: { secret: SECRET, cronSecret: CRON, sinks: [] } };
    expect((await H(get(), armed)).status).toBe(401);
    expect((await H(get("wrong"), armed)).status).toBe(401);
    expect((await H(get(SECRET), armed)).status).toBe(200);
    expect((await H(get(CRON), armed)).status).toBe(200);
  });

  it("reaps a plain web session past its window, counts it, and leaves a paired device alone", async () => {
    const { db, deps, clock } = await makeDeps();
    const now = clock.now();
    const me = await seedSession(db, { now });
    // Stale: device-less, unseen 91 days, its 90-day window closed a day ago. `seedSessionFor`
    // stamps lastSeenAt from the column default (now), so age it explicitly.
    const stale = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now });
    await db.update(sessions).set({ lastSeenAt: new Date(now.getTime() - 91 * DAY), refreshExpiresAt: new Date(now.getTime() - DAY) })
      .where(eq(sessions.id, stale.sessionId));
    // Ancient, its window long closed, but PAIRED: never auto-reaped.
    const dev = await seedDevice(db, { accountId: me.accountId, userId: me.userId, kind: "web", label: "Mila's phone" });
    const paired = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now, deviceId: dev });
    await db.update(sessions).set({ lastSeenAt: new Date(now.getTime() - 400 * DAY), refreshExpiresAt: new Date(now.getTime() - 310 * DAY) })
      .where(eq(sessions.id, paired.sessionId));

    const armed = { ...deps, alerts: { secret: SECRET, sinks: [] } };
    const res = await H(get(SECRET), armed);
    expect(res.status).toBe(200);
    expect((await res.json()).reaped).toBe(1);

    const staleRow = (await db.select().from(sessions).where(eq(sessions.id, stale.sessionId)))[0]!;
    expect(staleRow.revokedAt).not.toBeNull();
    const pairedRow = (await db.select().from(sessions).where(eq(sessions.id, paired.sessionId)))[0]!;
    expect(pairedRow.revokedAt).toBeNull();
    // The reaped session's next request is a refusal — the hygiene is revocation, not cosmetics.
    expect((await H(req("GET", "/devices", { cookie: `tf_session=${stale.token}` }), armed)).status).toBe(401);

    // A second pass finds nothing: the claim is guarded, so the count cannot double.
    const again = await H(get(SECRET), armed);
    expect((await again.json()).reaped).toBe(0);
  });
});
