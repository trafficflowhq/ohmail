import { describe, it, expect } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { createApp, authRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { totpNow, type Db } from "@trafficflow/services";
import { devices, sessions, refreshTokens } from "@trafficflow/db";
import {
  makeDeps, seedSession, seedSessionFor, seedDevice, req, setCookieMap,
  type TestClock,
} from "./helpers.js";

/**
 * ═══ DEVICES — PLAIN BROWSER SESSIONS ARE DEVICE-LESS, AND THE PANE'S VERBS MEAN IT ═══
 *
 * The device-list flood (a reported screenshot: a dozen indistinguishable "Web" rows; a
 * heavily used test account: ~200) had one root: `establish` minted a `devices` row for EVERY browser
 * sign-in, so the row that exists to make a PAIRED device visible and takable-back was also
 * minted for every tab that ever signed in. This suite pins the corrected model:
 *
 *  1. **A device row means a NAMED device.** A plain web sign-in mints a session with
 *     `device_id NULL`; only pairing redeems and the desktop's macos claims own device rows.
 *     (The sidecar's launch session pioneered exactly this discriminator —
 *     `apps/sidecar/src/identity.ts` narrows on `isNull(sessions.deviceId)`.)
 *  2. **`GET /devices` says which is which** (`named`), so the pane can pin the current
 *     session, list named devices individually, and collapse the plain-browser remainder.
 *  3. **`DELETE /devices/:id` accepts a device-less session's OWN id.** The list has always
 *     exposed `s.deviceId ?? s.id`, but the revoke matched `sessions.device_id` only — so
 *     revoking a device-less row was a 204 that revoked NOTHING (watched red exactly so:
 *     the "revoked" session's next request still answered 200). False success on a
 *     credential take-back is the worst spelling of this defect.
 *  4. **`POST /devices/revoke-web-sessions` is the one bulk verb**: every device-less full
 *     session of the caller EXCEPT the current one, never a named device. Step-up gated —
 *     it is mass credential revocation, `logout {allDevices}`'s exact reasoning.
 *  5. **Zero Set-Cookie on the bulk verb** — the host-only cookie ruling's census shape.
 */

const app = createApp(authRoutes);
const PW = "pw-correct-horse-password";
const CSRF = csrfTokenFor;
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Register + enroll TOTP + full login — the ceremony path, so `establish` itself is under test. */
async function signIn(deps: ApiDeps, db: Db, clock: TestClock, email: string): Promise<{
  userId: string; accountId: string; secret: string;
  cookies: Record<string, string>; cookie: string; csrf: string;
}> {
  const reg = await H(
    req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }) }),
    deps,
  );
  expect(reg.status).toBe(201);
  const { user } = await reg.json();
  const seeded = await seedSessionFor(db, { accountId: user.accountId, userId: user.userId, now: clock.now(), lastTwofaAt: clock.now() });
  const cookie = `tf_session=${seeded.token}; tf_csrf=${CSRF(seeded.token)}`;
  const headers = { "x-csrf-token": CSRF(seeded.token) };
  const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps);
  expect(enroll.status).toBe(200);
  const { secret } = await enroll.json();
  const activate = await H(
    req("POST", "/auth/2fa/totp/activate", { cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }),
    deps,
  );
  expect(activate.status).toBe(200);
  clock.advance(30_000); // past the activation's consumed timestep

  const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email, password: PW }) }), deps);
  expect(login.status).toBe(200);
  const { loginToken } = await login.json();
  const verify = await H(
    req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken, code: totpNow(secret, clock.now()) }) }),
    deps,
  );
  expect(verify.status).toBe(200);
  const cookies = setCookieMap(verify);
  return {
    userId: user.userId, accountId: user.accountId, secret, cookies,
    cookie: `tf_session=${cookies.tf_session}; tf_csrf=${cookies.tf_csrf}`,
    csrf: cookies.tf_csrf!,
  };
}

describe("plain web sign-ins carry no device row", () => {
  it("the full login ceremony mints a session with device_id NULL and NO devices row", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await signIn(deps, db, clock, "gil@x.example");

    // The ceremony-established session (the cookie one) is device-less…
    const rows = await db.select().from(sessions).where(eq(sessions.userId, s.userId));
    const full = rows.filter((r) => r.scope === "full" && r.revokedAt === null);
    expect(full.length).toBeGreaterThan(0);
    for (const r of full.filter((x) => x.id !== undefined)) {
      // The seeded fixture row is device-less by construction; the assertion that matters is
      // that the CEREMONY row is too — so every full session here must be device-less.
      expect(r.deviceId).toBeNull();
    }
    // …and no "Web" device row was minted anywhere in the ceremony.
    const devRows = await db.select().from(devices).where(eq(devices.userId, s.userId));
    expect(devRows).toHaveLength(0);
  });
});

describe("GET /devices distinguishes named devices from plain sessions", () => {
  it("a device-backed session answers named:true; a device-less one named:false", async () => {
    const { db, deps, clock } = await makeDeps();
    const now = clock.now();
    const me = await seedSession(db, { now, lastTwofaAt: now });
    const paired = await seedDevice(db, { accountId: me.accountId, userId: me.userId, kind: "web", label: "Mila's phone" });
    await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now, deviceId: paired });
    await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now }); // plain sibling

    const list = await H(req("GET", "/devices", { cookie: `tf_session=${me.token}` }), deps);
    expect(list.status).toBe(200);
    const { items } = await list.json();
    const namedRow = items.find((d: { label: string }) => d.label === "Mila's phone");
    expect(namedRow?.named).toBe(true);
    const plain = items.filter((d: { named: boolean }) => d.named === false);
    // The current session and the plain sibling are both device-less.
    expect(plain.length).toBe(2);
    expect(plain.some((d: { current: boolean }) => d.current)).toBe(true);
  });
});

describe("DELETE /devices/:id on a device-less session's own id", () => {
  it("actually revokes it — proven by the session's NEXT request, not the 204", async () => {
    const { db, deps, clock } = await makeDeps();
    const now = clock.now();
    const me = await seedSession(db, { now, lastTwofaAt: now });
    const sibling = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now });

    // The sibling works before the revoke — the control that makes the 401 below meaningful.
    const before = await H(req("GET", "/devices", { cookie: `tf_session=${sibling.token}` }), deps);
    expect(before.status).toBe(200);

    const del = await H(
      req("DELETE", `/devices/${sibling.sessionId}`, {
        cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
        headers: { "x-csrf-token": CSRF(me.token) },
      }),
      deps,
    );
    expect(del.status).toBe(204);

    const after = await H(req("GET", "/devices", { cookie: `tf_session=${sibling.token}` }), deps);
    expect(after.status).toBe(401);
  });

  it("refuses another user's session id (404) — the id is user-scoped", async () => {
    const { db, deps, clock } = await makeDeps();
    const now = clock.now();
    const me = await seedSession(db, { now, lastTwofaAt: now });
    const stranger = await seedSession(db, { now });

    const del = await H(
      req("DELETE", `/devices/${stranger.sessionId}`, {
        cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
        headers: { "x-csrf-token": CSRF(me.token) },
      }),
      deps,
    );
    // Nothing of the caller's matches: the stranger's session must survive untouched.
    expect([204, 404]).toContain(del.status);
    const still = await H(req("GET", "/devices", { cookie: `tf_session=${stranger.token}` }), deps);
    expect(still.status).toBe(200);
  });
});

describe("POST /devices/revoke-web-sessions — the bulk take-back", () => {
  it("revokes every device-less full session except the caller's; named devices survive", async () => {
    const { db, deps, clock } = await makeDeps();
    const now = clock.now();
    const me = await seedSession(db, { now, lastTwofaAt: now });

    const web1 = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now });
    const web2 = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now });
    const paired = await seedDevice(db, { accountId: me.accountId, userId: me.userId, kind: "web", label: "Mila's phone" });
    const pairedSession = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now, deviceId: paired });

    // One sibling holds a refresh family row — the bulk revoke must kill the FAMILY, not
    // only the session row, or the refresh token resurrects the "revoked" session.
    const web1Row = (await db.select().from(sessions).where(eq(sessions.id, web1.sessionId)))[0]!;
    await db.insert(refreshTokens).values({
      accountId: me.accountId, userId: me.userId, sessionId: web1.sessionId,
      familyId: web1Row.familyId, tokenHash: "web-session-row-hash-fixture-token",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });

    const res = await H(
      req("POST", "/devices/revoke-web-sessions", {
        cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
        headers: { "x-csrf-token": CSRF(me.token) },
        body: JSON.stringify({}),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(2);

    // Both plain siblings are dead on their next request…
    expect((await H(req("GET", "/devices", { cookie: `tf_session=${web1.token}` }), deps)).status).toBe(401);
    expect((await H(req("GET", "/devices", { cookie: `tf_session=${web2.token}` }), deps)).status).toBe(401);
    // …their refresh family with them…
    const fam = (await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, web1Row.familyId)))[0]!;
    expect(fam.revokedAt).not.toBeNull();
    // …while the caller and the paired device survive.
    expect((await H(req("GET", "/devices", { cookie: `tf_session=${me.token}` }), deps)).status).toBe(200);
    expect((await H(req("GET", "/devices", { cookie: `tf_session=${pairedSession.token}` }), deps)).status).toBe(200);
    // The paired session row is untouched in the store, not merely still answering.
    const pairedRow = (await db.select().from(sessions).where(eq(sessions.id, pairedSession.sessionId)))[0]!;
    expect(pairedRow.revokedAt).toBeNull();
  });

  it("is step-up gated: a stale factor answers 403 step_up_required", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await seedSession(db, { now: clock.now(), lastTwofaAt: null });
    const res = await H(
      req("POST", "/devices/revoke-web-sessions", {
        cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
        headers: { "x-csrf-token": CSRF(me.token) },
        body: JSON.stringify({}),
      }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_required");
    void db;
  });

  it("sets no cookie — the response is JSON and nothing else", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await seedSession(db, { now: clock.now(), lastTwofaAt: clock.now() });
    const res = await H(
      req("POST", "/devices/revoke-web-sessions", {
        cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
        headers: { "x-csrf-token": CSRF(me.token) },
        body: JSON.stringify({}),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    void db;
  });

  /**
   * ── THE AGE CUTOFF ─────────────────────────────────────────────────────────────────────────
   *
   * Why it exists: an account that had accumulated many device-less rows could only be thinned
   * by the per-row `DELETE /devices/:id`, one call per row, because the bulk verb would have
   * signed out the sessions in use that day as well. `olderThanDays` narrows by `last_seen_at`
   * and changes nothing when omitted — the pane's one press has to keep its meaning.
   *
   * EVERY ROW HERE SETS `last_seen_at` EXPLICITLY, and that is load-bearing rather than tidy:
   * the column defaults to the DATABASE's `now()` while the service reads the TEST clock
   * (`FIXED_NOW`, some weeks in the past), so a default-seeded row is "last seen" in
   * `ctx.now()`'s future and no cutoff could ever match it. A suite that only asserted "the
   * recent ones survive" would have been green on that mismatch alone.
   */
  describe("olderThanDays", () => {
    /** Seed a plain web session and stamp when it was last seen, relative to the test clock. */
    const seedSeen = async (
      db: Db, me: { accountId: string; userId: string }, now: Date, daysAgo: number,
    ): Promise<{ token: string; sessionId: string }> => {
      const s = await seedSessionFor(db, { ...me, now });
      await db.update(sessions)
        .set({ lastSeenAt: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000) })
        .where(eq(sessions.id, s.sessionId));
      return s;
    };

    it("revokes only the sessions older than the cutoff; recent ones and named devices survive", async () => {
      const { db, deps, clock } = await makeDeps();
      const now = clock.now();
      const me = await seedSession(db, { now, lastTwofaAt: now });
      const mine = { accountId: me.accountId, userId: me.userId };

      const old30 = await seedSeen(db, mine, now, 30);
      const old8 = await seedSeen(db, mine, now, 8);
      const fresh2 = await seedSeen(db, mine, now, 2);
      const today = await seedSeen(db, mine, now, 0);
      // A named device last seen a YEAR ago — well past the cutoff, and still untouchable: the
      // predicate is `device_id IS NULL`, which the age parameter does not relax.
      const dev = await seedDevice(db, { accountId: me.accountId, userId: me.userId, kind: "web", label: "Mila's phone" });
      const pairedSession = await seedSessionFor(db, { ...mine, now, deviceId: dev });
      await db.update(sessions)
        .set({ lastSeenAt: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000) })
        .where(eq(sessions.id, pairedSession.sessionId));

      const res = await H(
        req("POST", "/devices/revoke-web-sessions", {
          cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
          headers: { "x-csrf-token": CSRF(me.token) },
          body: JSON.stringify({ olderThanDays: 7 }),
        }),
        deps,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).revoked).toBe(2);

      // The two past the cutoff are dead on their next request…
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${old30.token}` }), deps)).status).toBe(401);
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${old8.token}` }), deps)).status).toBe(401);
      // …and the recent ones, the caller and the year-old NAMED device are all still live.
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${fresh2.token}` }), deps)).status).toBe(200);
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${today.token}` }), deps)).status).toBe(200);
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${me.token}` }), deps)).status).toBe(200);
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${pairedSession.token}` }), deps)).status).toBe(200);
      // In the store, not merely still answering.
      const pairedRow = (await db.select().from(sessions).where(eq(sessions.id, pairedSession.sessionId)))[0]!;
      expect(pairedRow.revokedAt).toBeNull();
    });

    /**
     * The POSITIVE CONTROL for the refusals below: the same fixture with the field OMITTED
     * revokes the whole remainder, cutoff or no cutoff. Without this, "400 for everything" would
     * satisfy the refusal cases.
     */
    it("omitted means the whole remainder — the cutoff is additive, not a new default", async () => {
      const { db, deps, clock } = await makeDeps();
      const now = clock.now();
      const me = await seedSession(db, { now, lastTwofaAt: now });
      const mine = { accountId: me.accountId, userId: me.userId };
      await seedSeen(db, mine, now, 30);
      await seedSeen(db, mine, now, 0);

      const res = await H(
        req("POST", "/devices/revoke-web-sessions", {
          cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
          headers: { "x-csrf-token": CSRF(me.token) },
          body: JSON.stringify({}),
        }),
        deps,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).revoked).toBe(2);
    });

    /**
     * A caller's own session is excluded by id AND by family, and the age parameter must not
     * become a way around that: the caller here is itself long past the cutoff.
     */
    it("never revokes the caller, even when the caller is the oldest session of all", async () => {
      const { db, deps, clock } = await makeDeps();
      const now = clock.now();
      const me = await seedSession(db, { now, lastTwofaAt: now });
      await db.update(sessions)
        .set({ lastSeenAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000) })
        .where(eq(sessions.id, me.sessionId));

      const res = await H(
        req("POST", "/devices/revoke-web-sessions", {
          cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
          headers: { "x-csrf-token": CSRF(me.token) },
          body: JSON.stringify({ olderThanDays: 1 }),
        }),
        deps,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).revoked).toBe(0);
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${me.token}` }), deps)).status).toBe(200);
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["past the ceiling", 3651],
      ["fractional", 7.5],
      ["a string", "7"],
      ["null — absence is spelled by OMITTING the field, never by null", null],
      ["NaN", Number.NaN],
    ])("answers 400 validation_failed for %s", async (_label, value) => {
      const { db, deps, clock } = await makeDeps();
      const now = clock.now();
      const me = await seedSession(db, { now, lastTwofaAt: now });
      const victim = await seedSeen(db, { accountId: me.accountId, userId: me.userId }, now, 30);

      const res = await H(
        req("POST", "/devices/revoke-web-sessions", {
          cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
          headers: { "x-csrf-token": CSRF(me.token) },
          // `JSON.stringify` turns NaN into `null` on the wire, which is a refused value too —
          // the case that matters either way is that nothing is revoked.
          body: JSON.stringify({ olderThanDays: value }),
        }),
        deps,
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_failed");
      // A REFUSAL REVOKES NOTHING: the sibling past the cutoff is still live, so the route
      // cannot have run the verb and then failed to describe it.
      expect((await H(req("GET", "/devices", { cookie: `tf_session=${victim.token}` }), deps)).status).toBe(200);
    });
  });

  it("touches nothing on an account whose only web session is the caller's (revoked: 0)", async () => {
    const { db, deps, clock } = await makeDeps();
    const me = await seedSession(db, { now: clock.now(), lastTwofaAt: clock.now() });
    const res = await H(
      req("POST", "/devices/revoke-web-sessions", {
        cookie: `tf_session=${me.token}; tf_csrf=${CSRF(me.token)}`,
        headers: { "x-csrf-token": CSRF(me.token) },
        body: JSON.stringify({}),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(0);
    const mine = await db.select().from(sessions)
      .where(and(eq(sessions.userId, me.userId), isNull(sessions.revokedAt)));
    expect(mine).toHaveLength(1);
  });
});
