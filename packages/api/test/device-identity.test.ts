/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  CLIENT DEVICE-IDENTITY DECLARATIONS — the two hosted seams a desktop names itself on
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The device vocabulary (`DeviceKind`) grew platform-qualified kinds so the console and the
 * staleness alarm can say WHICH install a row is. This file pins the CLIENT-FACING half of
 * that: the two sign-in doors a desktop uses now accept an optional `kind`, and the acceptance
 * must be pure vocabulary — a declaration selects a device row's spelling and NOTHING about
 * the credential.
 *
 * The two seams, and what each may and may not do:
 *
 *  · `POST /auth/desktop-claim` — `kind` ∈ {macos, desktop-linux, desktop-macos,
 *    desktop-windows}, ABSENT = the legacy "macos" (every shipped desktop claims without the
 *    field). Every admissible kind mints the SAME credential: the native window this door has
 *    always issued. A kind outside the set refuses 400 and must NOT burn the single-use code.
 *
 *  · `POST /auth/2fa/totp/verify` — `kind` ∈ {desktop-linux, desktop-macos, desktop-windows},
 *    ABSENT = the deviceless "web" session every browser sign-in has always minted. The
 *    declaration mints a device row (so the alarm can attribute the install) and must NOT be
 *    able to buy the native window — which is why "macos", the one kind whose derived surface
 *    is native, is refused HERE while admitted on the claim (where the surface is pinned).
 *    A refused declaration must consume neither the login token nor the TOTP timestep.
 *
 * ── THE NO-PRIVILEGE CLAIM, AS ASSERTIONS ───────────────────────────────────────────────────
 *
 * "A device row grants nothing" is stated in the service; here it is measured: the refresh
 * window of a declared sign-in equals the undeclared one's to the millisecond, on both seams
 * (cookie window on the verify, native window on the claim), and the declared verify still
 * answers through cookies with tokens stripped — the transport did not move either.
 *
 * ── MUTATIONS RUN, WATCHED RED, RESTORED (2026-08-25) ───────────────────────────────────────
 *
 *   · `claimDesktopLink` surface pin removed (derive from kind)  ⇒ "on the SAME native window
 *     as ever" fails at 90 ≠ 400 days
 *   · `DESKTOP_DECLARED_KINDS` widened with "macos"              ⇒ "'macos' is refused on this
 *     seam" AND "a refused declaration costs nothing" both fail with a 200
 *   · `establish`'s auto-mint map losing "desktop-linux"         ⇒ the mint tests on BOTH seams
 *     fail with `deviceId` null
 *   · `claimDesktopLink`'s kind check moved AFTER the burn       ⇒ "the code is NOT burned"
 *     fails — the second refusal answers `invalid_code`, proof the first one spent the code
 *   · `stampDeviceSynced`'s devices UPDATE disabled              ⇒ "STAMPED by the real /sync"
 *     fails with `lastSyncedAt` null — the device-row propagation is load-bearing, not a
 *     side effect
 *
 * NOT a run mutation, stated honestly: `totpVerify`'s check sitting ahead of the throttle
 * reserve and the token peek is belt-and-braces (the peek is a read and the timestep advance
 * happens after code verification either way); the assertion that bites on this seam is the
 * retry's 200 in "a refused declaration costs nothing".
 */
import { describe, it, expect } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { devices, mailboxes, sessions } from "@trafficflow/db";
import { evaluateAlerts } from "@trafficflow/db/cloud";
import { totpNow, type Db } from "@trafficflow/services";
import { makeDeps, seedMailbox, seedSession, seedSessionFor, req, setCookieMap, FIXED_NOW, type TestClock } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const DAY = 24 * 60 * 60 * 1000;
const PW = "pw-correct-horse";
const IP = "198.51.100.77";

/** The newest session row of a user — the one the ceremony under test just minted. */
async function newestSession(db: Db, userId: string) {
  const row = (await db.select().from(sessions)
    .where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt)).limit(1))[0];
  expect(row, "the ceremony minted a session row").toBeTruthy();
  return row!;
}

async function deviceRow(db: Db, deviceId: string) {
  const row = (await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1))[0];
  expect(row, "the session's device_id names a devices row").toBeTruthy();
  return row!;
}

/* ── the desktop-link claim ─────────────────────────────────────────────────────────────────── */

/** Mint a handoff code from a stepped-up session, then claim it with the given body extras. */
async function mintCode(deps: ApiDeps, db: Db): Promise<{ code: string; userId: string }> {
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const res = await H(req("POST", "/auth/desktop-link", { bearer: s.token, body: "{}" }), deps);
  expect(res.status, `mint refused: ${await res.clone().text()}`).toBe(200);
  const { code } = await res.json() as { code: string };
  return { code, userId: s.userId };
}

const claim = (deps: ApiDeps, body: unknown, ip = IP): Promise<Response> =>
  H(req("POST", "/auth/desktop-claim", {
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }), deps);

describe("the desktop-link claim's kind declaration", () => {
  it("declaring desktop-linux mints a device row of that kind, on the SAME native window as ever", async () => {
    const { db, deps } = await makeDeps();
    const { code, userId } = await mintCode(deps, db);

    const res = await claim(deps, { code, kind: "desktop-linux" });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(body.tokens?.accessToken).toBeTruthy();
    expect(res.headers.getSetCookie()).toEqual([]); // still no cookies on this door

    const session = await newestSession(db, userId);
    expect(session.deviceId).toBeTruthy();
    const dev = await deviceRow(db, session.deviceId!);
    expect(dev.kind).toBe("desktop-linux");
    expect(dev.label).toBe("ohmail for Linux");

    // THE PIN: the declared kind derives the cookie surface in `establish`, so only the
    // explicit `surface: "native"` at the claim keeps the window this door has always issued.
    expect((session.refreshExpiresAt.getTime() - FIXED_NOW.getTime()) / DAY).toBe(400);
  });

  it("an undeclared claim is byte-for-byte the legacy one: a macos row, the same window", async () => {
    const { db, deps } = await makeDeps();
    const { code, userId } = await mintCode(deps, db);

    const res = await claim(deps, { code });
    expect(res.status).toBe(200);

    const session = await newestSession(db, userId);
    const dev = await deviceRow(db, session.deviceId!);
    expect(dev.kind).toBe("macos");
    expect(dev.label).toBe("ohmail for Mac");
    expect((session.refreshExpiresAt.getTime() - FIXED_NOW.getTime()) / DAY).toBe(400);
  });

  it("each desktop kind gets its platform label", async () => {
    const { db, deps } = await makeDeps();
    for (const [kind, label] of [
      ["desktop-macos", "ohmail for Mac"],
      ["desktop-windows", "ohmail for Windows"],
    ] as const) {
      const { code, userId } = await mintCode(deps, db);
      const res = await claim(deps, { code, kind });
      expect(res.status, `${kind}: ${await res.clone().text()}`).toBe(200);
      const dev = await deviceRow(db, (await newestSession(db, userId)).deviceId!);
      expect(dev.kind).toBe(kind);
      expect(dev.label).toBe(label);
    }
  });

  it("a kind outside the claim's set refuses 400 — and the code is NOT burned", async () => {
    const { db, deps } = await makeDeps();
    const { code } = await mintCode(deps, db);

    // "web" would dodge the device staleness alarm; the mobile kinds cannot arrive through
    // this door; junk is junk. All three refuse with the closed set named…
    for (const kind of ["web", "mobile-ios", "laptop"]) {
      const res = await claim(deps, { code, kind });
      expect(res.status, `kind ${kind} must refuse`).toBe(400);
      const { error } = await res.json();
      expect(error.code).toBe("validation_failed");
      expect(error.message).toContain("device kind");
    }

    // …and none of the refusals consumed the single-use code: the honest retry still lands.
    const retry = await claim(deps, { code, kind: "desktop-windows" });
    expect(retry.status, "the code must survive a refused declaration").toBe(200);
  });
});

/* ── the TOTP verify (the cloud-door desktop's password sign-in) ────────────────────────────── */

/** Register a user over HTTP; returns its identity. */
async function register(deps: ApiDeps, email: string): Promise<{ userId: string; accountId: string }> {
  const res = await H(
    req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }) }),
    deps,
  );
  expect(res.status).toBe(201);
  const { user } = await res.json();
  return { userId: user.userId, accountId: user.accountId };
}

/** Enroll & activate TOTP for the user; returns the shared secret. */
async function enrollTotp(deps: ApiDeps, db: Db, clock: TestClock, id: { userId: string; accountId: string }): Promise<string> {
  const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: clock.now() });
  const cookie = `tf_session=${token}; tf_csrf=${csrfTokenFor(token)}`;
  const headers = { "x-csrf-token": csrfTokenFor(token) };
  const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps);
  expect(enroll.status).toBe(200);
  const { secret } = await enroll.json();
  const activate = await H(
    req("POST", "/auth/2fa/totp/activate", { cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }),
    deps,
  );
  expect(activate.status).toBe(200);
  return secret;
}

/** First factor → the verify, with the caller building the verify body's extras. */
async function verifyWith(
  deps: ApiDeps, clock: TestClock, email: string, secret: string, extra: Record<string, unknown>,
): Promise<Response> {
  const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email, password: PW }) }), deps);
  expect(login.status).toBe(200);
  const { loginToken } = await login.json();
  return H(
    req("POST", "/auth/2fa/totp/verify", {
      body: JSON.stringify({ loginToken, code: totpNow(secret, clock.now()), ...extra }),
    }),
    deps,
  );
}

describe("the TOTP verify's kind declaration", () => {
  it("declaring desktop-linux mints a NAMED device row — same cookies, same cookie window", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);

    const verify = await verifyWith(deps, clock, "gil@x.example", secret, { kind: "desktop-linux" });
    expect(verify.status, await verify.clone().text()).toBe(200);

    // The transport did not move: still a cookie answer with tokens stripped.
    const cookies = setCookieMap(verify);
    expect(cookies.tf_session).toBeTruthy();
    expect((await verify.json()).tokens).toBeUndefined();

    const session = await newestSession(db, id.userId);
    expect(session.deviceId, "the declaration mints a device row").toBeTruthy();
    const dev = await deviceRow(db, session.deviceId!);
    expect(dev.kind).toBe("desktop-linux");
    expect(dev.label).toBe("ohmail for Linux");

    // NO PRIVILEGE: the declaration cannot buy the native window. The admissible kinds all
    // derive the cookie surface, so this is 90 days — identical to the undeclared sign-in.
    expect((session.refreshExpiresAt.getTime() - clock.now().getTime()) / DAY).toBe(90);
  });

  it("an undeclared verify stays deviceless — the shape every existing session has", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil2@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);

    const verify = await verifyWith(deps, clock, "gil2@x.example", secret, {});
    expect(verify.status).toBe(200);
    const session = await newestSession(db, id.userId);
    expect(session.deviceId).toBeNull();
    expect((session.refreshExpiresAt.getTime() - clock.now().getTime()) / DAY).toBe(90);
  });

  it("'macos' is refused on this seam — the one kind whose derived surface is native", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil3@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);

    for (const kind of ["macos", "web", "mobile-android", 7]) {
      const verify = await verifyWith(deps, clock, "gil3@x.example", secret, { kind });
      expect(verify.status, `kind ${String(kind)} must refuse`).toBe(400);
      const { error } = await verify.json();
      expect(error.code).toBe("validation_failed");
      expect(error.message).toContain("device kind");
    }
  });

  it("the declared device is STAMPED by the real /sync and WATCHED by the device alarm, by kind", async () => {
    // Owner item: device rows must not alarm forever on a healthy install. The whole chain,
    // through the production wire: declared sign-in → device row → the /sync empty tail stamps
    // the DEVICE row (not only the session) → the account moves on → `device_sync_stale` pages
    // and its sentence NAMES the declared kind — which is what the console renders.
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil5@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);

    const verify = await verifyWith(deps, clock, "gil5@x.example", secret, { kind: "desktop-linux" });
    expect(verify.status).toBe(200);
    const access = setCookieMap(verify).tf_session!;
    const session = await newestSession(db, id.userId);

    // Drive the REAL empty tail: first read hands back the horizon cursor, presenting it
    // proves the horizon was committed, and that is the stamp's admission rule.
    const first = await H(req("GET", "/sync?since=0", { bearer: access }), deps);
    expect(first.status).toBe(200);
    const { cursor } = await first.json();
    const tail = await H(req("GET", `/sync?since=${encodeURIComponent(cursor)}`, { bearer: access }), deps);
    expect(tail.status).toBe(200);

    const dev = await deviceRow(db, session.deviceId!);
    expect(dev.lastSyncedAt, "the stamp reaches the DEVICE row, not only the session").not.toBeNull();

    // Now the install goes quiet while the account moves on: the device rule owns it.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const later = new Date(clock.now().getTime() + 4 * DAY_MS);
    const mailboxId = await seedMailbox(db, { accountId: id.accountId });
    await db.update(mailboxes).set({ lastSyncAt: new Date(later.getTime() - 60 * 60 * 1000) })
      .where(eq(mailboxes.id, mailboxId));
    await db.update(sessions).set({ lastSeenAt: new Date(later.getTime() - 60_000) })
      .where(eq(sessions.id, session.id));

    const alerts = await evaluateAlerts(db, { now: later });
    const hit = alerts.find((a) => a.key === `device_sync_stale:${dev.id}`);
    expect(hit, "the declared install is inside the device alarm's population").toBeTruthy();
    expect(hit!.title, "the page says WHICH install").toContain("desktop-linux");
  });

  it("a refused declaration costs nothing: the same login token and timestep still verify", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil4@x.example");
    const secret = await enrollTotp(deps, db, clock, id);
    clock.advance(30_000);

    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "gil4@x.example", password: PW }) }), deps);
    const { loginToken } = await login.json();
    const code = totpNow(secret, clock.now());

    const refused = await H(
      req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken, code, kind: "macos" }) }),
      deps,
    );
    expect(refused.status).toBe(400);

    // The refusal ran BEFORE the token peek, the throttle reserve and the timestep advance —
    // so the very same request minus the bad declaration is still whole.
    const retry = await H(
      req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken, code, kind: "desktop-macos" }) }),
      deps,
    );
    expect(retry.status, await retry.clone().text()).toBe(200);
    const session = await newestSession(db, id.userId);
    const dev = await deviceRow(db, session.deviceId!);
    expect(dev.kind).toBe("desktop-macos");
    expect(dev.label).toBe("ohmail for Mac");
  });
});
