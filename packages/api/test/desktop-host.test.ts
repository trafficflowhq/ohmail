import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes, authRoutes, desktopApprovalRoutes, type ApiDeps } from "@trafficflow/api";
import { localRoutes, DEFAULT_SSE, type HelloConfig } from "@trafficflow/api/local";
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
import {
  makeSessionLifecycle, mintPairingToken, type ServiceContext,
} from "@trafficflow/services/auth";
import { sessionLifecycleRoutes } from "../src/routes/session-lifecycle.js";
import { deviceRoutes } from "../src/routes/devices.js";
import { pairRedeemRoutes, pairRoutes, pairStateRoutes } from "../src/routes/pair.js";
import { coreRoutes } from "../src/routes/core.js";
import { makeDeps, req, seedSession, FIXED_NOW } from "./helpers.js";

/**
 * ═══ THE DESKTOP-HOST ROUTE TABLE — what the always-on desktop serves to the user's own
 *     other devices, and the two properties that make it safe to serve at all ═══════════════
 *
 * A phone that scanned a QR is a VIEWER of the one engine: it reads and writes through the same
 * `app.handle` the desktop window uses, holding a bearer pair minted by the device-pair redeem.
 * This file pins the composition (exactly the single-user product set plus the session-lifecycle
 * carve, the device list and the anonymous redeem — and structurally nothing else) and the door's
 * one non-negotiable: **it never mints, reads or clears a cookie.** A cookie minted here would be
 * a browser credential on whatever origin proxied the request; the bearer pair in the body is the
 * whole contract.
 *
 * Everything drives `app.handle` directly — the composition is what the loopback listener will
 * serve; no socket exists in this slice.
 */

const app = createApp(desktopHostRoutes);
const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;

/** The descriptor the sidecar's host door injects — mirrored here for the contract tests. */
const DESKTOP_HOST_HELLO: HelloConfig = {
  flavor: "desktop-host",
  needsSetup: false,
  auth: { password: false, totp: false, webauthn: false, publicSignup: false },
  features: { sse: false, staging: false, ai: false, pairing: true, remoteImages: true },
};

/**
 * The door's dependency shape: the LIFECYCLE, not the ceremony — `services.auth` is a bare
 * `SessionLifecycle` exactly as `apps/sidecar`'s `localServices` wires it — no `inviteRedeem`
 * (this store has no invites table to bridge to), COOKIES REFUSED (`allowCookieAuth: false`,
 * the pin the zero-Set-Cookie censuses below stand on — flip it to `true` and the
 * cookie-blindness test goes red, watched), SSE off.
 */
function hostDeps(deps: ApiDeps): ApiDeps {
  const { inviteRedeem: _inviteRedeem, ...services } = deps.services!;
  return {
    ...deps,
    services: { ...services, auth: makeSessionLifecycle({ config: deps.authConfig }) },
    allowCookieAuth: false,
    sse: { ...DEFAULT_SSE, enabled: false },
    hello: DESKTOP_HOST_HELLO,
    session: null,
  };
}

/** A ServiceContext for direct service calls (the mint lives on the STDIO door, not on this table). */
function ctxFor(deps: ApiDeps, s: { accountId: string; userId: string }): ServiceContext {
  return {
    db: deps.db as unknown as ServiceContext["db"],
    accountId: s.accountId,
    userId: s.userId,
    sessionId: null,
    now: deps.now,
    requestId: "desktop-host-test",
  };
}

describe("the composition census — exactly the ruled table, and nothing else", () => {
  it("is localRoutes + sessionLifecycleRoutes + deviceRoutes + the pair redeem and state, by IDENTITY and in order", () => {
    // Identity, not shape (the same discipline `hello.test.ts` applies to the three older
    // tables): the mounted routes ARE the modules' members, so a fix to a handler cannot fork
    // between a re-listed copy on this door and the real one on the hosted table.
    const expected = [
      ...localRoutes, ...sessionLifecycleRoutes, ...deviceRoutes, ...pairRedeemRoutes, ...pairStateRoutes,
    ];
    expect(desktopHostRoutes).toHaveLength(expected.length);
    desktopHostRoutes.forEach((r, i) => expect(r).toBe(expected[i]));
  });

  it("carries the carved lifecycle pair + devices/audit from the auth surface, and NO OTHER auth route", () => {
    // Iterated over the REAL hosted auth surface rather than a name list, so a route added to
    // the ceremony can never silently join this door: membership here is exact. Mutation
    // watched red: spreading `authRoutes` (or appending the register route) into
    // `desktopHostRoutes` fails this census before anything else runs.
    // The sign-out door below the refresh path is one of the lifecycle routes both tables mount as
    // the same objects: here it is cookie-blind, and a paired device may present its token in the body.
    const allowed = new Set([
      "POST /auth/refresh", "POST /auth/logout", "POST /auth/refresh/logout",
      "GET /devices", "DELETE /devices/:id", "GET /auth/audit",
    ]);
    const keys = new Set(desktopHostRoutes.map(key));
    // The browser approval left `authRoutes` for the hosted table only; it is still hosted auth.
    for (const r of [...authRoutes, ...desktopApprovalRoutes]) {
      expect(keys.has(key(r)), `${key(r)} must ${allowed.has(key(r)) ? "" : "NOT "}be on the desktop-host door`)
        .toBe(allowed.has(key(r)));
    }
    // …and the allowed six are really there (the loop above only proves agreement).
    for (const k of allowed) expect(keys).toContain(k);
  });

  it("serves the redeem and its state read and NOTHING ELSE of the pairing ceremony — the mint stays on the stdio door", () => {
    // The state read joined the redeem so a pairing desktop asks, by the token's hash, before it
    // configures anything; it spends nothing and names nothing a caller could mint with.
    expect(desktopHostRoutes.filter((r) => r.pattern.startsWith("/pair")).map(key)).toEqual([
      "POST /pair/redeem",
      "POST /pair/state",
    ]);
    expect(desktopHostRoutes).toContain(pairStateRoutes[0]);
    // The SAME route object the self-host table mounts — one redeem implementation, two doors.
    expect(pairRedeemRoutes).toHaveLength(1);
    expect(pairRoutes).toContain(pairRedeemRoutes[0]);
    expect(desktopHostRoutes).toContain(pairRedeemRoutes[0]);
  });

  it("the carved lifecycle routes are the HOSTED table's own objects — one implementation, two mounts", () => {
    expect(sessionLifecycleRoutes.map(key).sort())
      .toEqual(["POST /auth/logout", "POST /auth/refresh", "POST /auth/refresh/logout"]);
    for (const r of sessionLifecycleRoutes) {
      expect(coreRoutes, `${key(r)} must still ride in coreRoutes`).toContain(r);
      expect(apiRoutes, `${key(r)} must still ride in the hosted table`).toContain(r);
    }
  });

  it("serves nothing Cloud: no billing/waitlist/admin/internal/oauth/staging/erasure path", () => {
    for (const r of desktopHostRoutes) {
      for (const prefix of [
        "/billing", "/waitlist", "/admin", "/internal", "/oauth",
        "/mailboxes/oauth", "/attachments/staging", "/account/ai",
      ]) {
        expect(r.pattern.startsWith(prefix), `${key(r)} is a hosted/Cloud surface`).toBe(false);
      }
    }
    /* `/consent` CAME OFF THIS LIST WITH mail 0083, and it is a real change of position rather
     * than an exemption granted to make a test pass.
     *
     * It was here because consent was a hosted surface: the standalone door had no `GET /consent`
     * and no `PATCH /consent/settings`, so it could neither read nor write `dormancy_days`,
     * `screening_scope` or `screening_baseline_at` — and therefore had no screening window at all.
     * Its cycle screened every backfilled message whatever its age, which on a decade-old mailbox
     * is a decade of physical IMAP moves into `ohmail/Screener` with nowhere in the product to say
     * otherwise.
     *
     * The consent group is account-scoped and this host serves exactly one account, so mounting it
     * adds no cross-tenant surface. What it adds is the dial the free desktop was missing. The
     * positive assertion below — every `localRoutes` entry rides here by reference — is what now
     * carries the claim, so the group cannot drift in unnoticed. */
    expect(desktopHostRoutes.some((r) => r.pattern.startsWith("/consent"))).toBe(true);
    // The erasure route is exact-path (`/account` is also the screening prefix, which IS mounted).
    expect(desktopHostRoutes.some((r) => key(r) === "DELETE /account")).toBe(false);
    // The whole single-user product set rides, by containment (same references).
    for (const r of localRoutes) expect(desktopHostRoutes).toContain(r);
  });

  it("serves NEITHER the step-up re-verification ceremony NOR the bulk web-session revoke", () => {
    // Two absences, each load-bearing on this door and argued at the route arrays themselves
    // (`step-up.ts`, `devices.ts#webSessionRevokeRoutes`):
    //  · `/auth/step-up/*` reaches `shared-cloud.ts#auth` — the CEREMONY accessor — and this
    //    composition's `services.auth` is the bare `SessionLifecycle`; a mounted route would be
    //    a 500 behind every request, and there are no factors here to verify anyway.
    //  · `/devices/revoke-web-sessions` sweeps device-less sessions, and on THIS door the
    //    device-less non-current session IS the host's LAUNCH session — a remote viewer holding
    //    the verb could kill the very engine serving it.
    // Watched red by temporarily spreading both arrays into `desktopHostRoutes`.
    // The password change is the third: it reaches the ceremony accessor, and this store keeps
    // no password to change.
    for (const r of desktopHostRoutes) {
      expect(r.pattern.startsWith("/auth/step-up"), `${key(r)} is the hosted step-up ceremony`).toBe(false);
      expect(r.pattern !== "/auth/password", `${key(r)} is the hosted password change`).toBe(true);
    }
    expect(desktopHostRoutes.some((r) => key(r) === "POST /devices/revoke-web-sessions")).toBe(false);
  });

  it("holds no duplicate (method, pattern)", () => {
    const keys = desktopHostRoutes.map(key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it("`routes/desktop-host.ts` never IMPORTS the excluded modules — absent from the graph, not filtered", () => {
    const src = readFileSync(new URL("../src/routes/desktop-host.ts", import.meta.url), "utf8");
    // Not the hosted barrel, not the auth surface, not the ceremony module the carve came from.
    expect(src).not.toContain("./index.js");
    expect(src).not.toContain("./auth.js");
    expect(src).not.toContain("./core.js");
    // Not the Cloud-half schema census, whose entries are Cloud table names.
    expect(src).not.toContain("./health-cloud.js");
    for (const mod of [
      "./billing.js", "./waitlist.js", `from "./admin`, "./internal.js",
      "./mailbox-oauth.js", "./attachment-staging.js", "./account.js",
      "./consent.js", "./ai-settings.js", "./proposals.js", "./oauth.js",
    ]) {
      expect(src, `desktop-host.ts imports ${mod}`).not.toContain(mod);
    }
  });

  it("the mint/list/revoke answer 404 — the routes are ABSENT, not gated", async () => {
    const { deps } = await makeDeps();
    for (const [method, path] of [
      ["POST", "/pair"], ["GET", "/pair"], ["DELETE", `/pair/${randomUUID()}`], ["POST", "/auth/password"],
    ] as const) {
      const res = await app.handle(req(method, path, method === "GET" ? {} : { body: "{}" }), hostDeps(deps));
      expect(res.status, `${method} ${path} must be structurally absent`).toBe(404);
    }
  });
});

describe("GET /hello — the door states what it is", () => {
  it("answers flavor desktop-host: no sign-in ceremonies, pairing on, sse honestly off", async () => {
    const { deps } = await makeDeps();
    const res = await app.handle(req("GET", "/hello"), hostDeps(deps));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["apiVersion", "auth", "features", "flavor", "needsSetup", "product"],
    );
    expect(body.flavor).toBe("desktop-host");
    expect(body.needsSetup).toBe(false);
    expect(body.auth).toEqual({ password: false, totp: false, webauthn: false, publicSignup: false });
    expect(body.features.pairing).toBe(true);
    expect(body.features.sse).toBe(false);
    expect(body.features.staging).toBe(false);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("the invite arm — refused with a caller-actionable 400, never a 500", () => {
  it("an invite-grant redeem answers validation_failed: this store has no invites table to bridge to", async () => {
    const { deps } = await makeDeps();
    const res = await app.handle(
      req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "invite", token: "t".repeat(43), email: "kid@example.com" }) }),
      hostDeps(deps),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_failed");
  });
});

describe("ZERO Set-Cookie across the ENTIRE door", () => {
  it("no route on this table answers ANY request with a Set-Cookie header", async () => {
    // Every route, driven unauthenticated (the protected ones answer 401 from `withSession`,
    // which is itself a response this census covers; the public ones run their handlers). The
    // session-minting successes — redeem, refresh, logout — are asserted on their 200/204 paths
    // in the lifecycle suite below, so between the two loops every response shape the door can
    // produce is swept. Mutation watched red: with `allowCookieAuth` flipped to `true`, a
    // `tf_refresh`-cookie refresh answers 401 WITH `clearSessionCookies()` — three Set-Cookie
    // headers — and this census catches it on the cookie-blindness case below.
    // The web's sign-out door rides this table too, and this sweep is what holds it cookie-free here.
    expect(desktopHostRoutes.map(key)).toContain("POST /auth/refresh/logout");
    const { deps } = await makeDeps();
    for (const r of desktopHostRoutes) {
      const path = r.pattern.replace(/:[^/]+/g, randomUUID());
      const needsBody = !["GET", "HEAD"].includes(r.method);
      // A FRESH ApiDeps per request — `ApiDeps` is mutable by design (`withSession` writes
      // `session`), so a shared object would leak one request's identity into the next.
      const res = await app.handle(req(r.method, path, needsBody ? { body: "{}" } : {}), hostDeps(deps));
      expect(res.headers.getSetCookie(), `${key(r)} answered with Set-Cookie (status ${res.status})`)
        .toEqual([]);
    }
  });

  it("a presented tf_refresh COOKIE is refused blind: not spent, not answered with cookies", async () => {
    // "Bearer-only means the host REFUSES cookies, not that browsers happen not to point at
    // it" — core.ts's own sentence, enforced here for the door. The cookie carries a VALID
    // refresh token; the door must neither rotate on it (the family stays intact for the body
    // presentation below) nor answer with the cookie-clearing Set-Cookie trio the hosted
    // surface would send on a refusal.
    const { deps } = await makeDeps();
    const seeded = await seedSession(deps.db, { now: FIXED_NOW });
    const minted = await mintPairingToken(ctxFor(hostDeps(deps), seeded), { grant: "device-pair", label: "Pixel" });
    const redeemed = await app.handle(
      req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token: minted.token }) }),
      hostDeps(deps),
    );
    expect(redeemed.status).toBe(200);
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string; refreshToken: string } };

    const viaCookie = await app.handle(
      req("POST", "/auth/refresh", { cookie: `tf_refresh=${tokens.refreshToken}` }), hostDeps(deps),
    );
    expect(viaCookie.status).toBe(401);
    expect(viaCookie.headers.getSetCookie()).toEqual([]);

    // The cookie presentation spent nothing: the SAME token still rotates through the body,
    // and the rotation answers tokens in the body with no cookie beside them.
    const viaBody = await app.handle(
      req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: tokens.refreshToken }) }),
      hostDeps(deps),
    );
    expect(viaBody.status).toBe(200);
    expect(viaBody.headers.getSetCookie()).toEqual([]);
    expect(((await viaBody.json()) as { tokens: { refreshToken: string } }).tokens.refreshToken)
      .not.toBe(tokens.refreshToken);
    // No wait of its own: 0.3 s as a rule, 2.8 s once on a loaded CI VM, 27 s under 10% of a CPU.
  }, 60_000);
});

describe("the paired-device lifecycle over the door — redeem, devices, refresh, logout", () => {
  it("redeem → 200 bearer pair (no cookie) → the device is listed → logout kills it (204, no cookie)", async () => {
    const { deps } = await makeDeps();
    const seeded = await seedSession(deps.db, { now: FIXED_NOW });
    const minted = await mintPairingToken(ctxFor(hostDeps(deps), seeded), { grant: "device-pair", label: "kitchen iPad" });

    const redeemed = await app.handle(
      req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token: minted.token }) }),
      hostDeps(deps),
    );
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.getSetCookie()).toEqual([]);
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string; refreshToken: string } };

    const listed = await app.handle(req("GET", "/devices", { bearer: tokens.accessToken }), hostDeps(deps));
    expect(listed.status).toBe(200);
    const devicesBody = (await listed.json()) as { items: { label: string; current: boolean }[] };
    expect(devicesBody.items.some((i) => i.label === "kitchen iPad" && i.current)).toBe(true);

    const out = await app.handle(
      req("POST", "/auth/logout", { bearer: tokens.accessToken, body: "{}" }), hostDeps(deps),
    );
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toEqual([]);
    const after = await app.handle(req("GET", "/devices", { bearer: tokens.accessToken }), hostDeps(deps));
    expect(after.status).toBe(401);
  });

  it("the sign-out door takes a paired device's refresh token in the BODY: 204, no cookie, the pair dead", async () => {
    const { deps } = await makeDeps();
    const seeded = await seedSession(deps.db, { now: FIXED_NOW });
    const minted = await mintPairingToken(ctxFor(hostDeps(deps), seeded), { grant: "device-pair", label: "tablet" });
    const redeemed = await app.handle(
      req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token: minted.token }) }),
      hostDeps(deps),
    );
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string; refreshToken: string } };

    const out = await app.handle(
      req("POST", "/auth/refresh/logout", { body: JSON.stringify({ refreshToken: tokens.refreshToken }) }),
      hostDeps(deps),
    );
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toEqual([]);
    expect((await app.handle(req("GET", "/devices", { bearer: tokens.accessToken }), hostDeps(deps))).status)
      .toBe(401);
    const renew = await app.handle(
      req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: tokens.refreshToken }) }), hostDeps(deps),
    );
    expect(renew.status, "the signed-out pair still renews").toBe(401);
  });

  it("a JUST-PAIRED session cannot revoke devices — step-up fails closed on its NULL factor stamp", async () => {
    // `establishPairedDevice` mints with `twofaAt: null`, deliberately: a credential that may
    // have crossed a room on paper must not inherit the right to sign other devices out. The
    // door mounts `DELETE /devices/:id` with its step-up gate intact, so the paired session is
    // refused — the window (whose machine login is the step-up) revokes over the stdio door.
    const { deps } = await makeDeps();
    const seeded = await seedSession(deps.db, { now: FIXED_NOW });
    const minted = await mintPairingToken(ctxFor(hostDeps(deps), seeded), { grant: "device-pair", label: "phone" });
    const redeemed = await app.handle(
      req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token: minted.token }) }),
      hostDeps(deps),
    );
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string } };
    const res = await app.handle(
      req("DELETE", `/devices/${randomUUID()}`, { bearer: tokens.accessToken }), hostDeps(deps),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("step_up_required");
  });

  it("allDevices logout from a paired session is refused — mass logout is device revocation", async () => {
    // A review finding, pinned at the door: the paired session's NULL factor stamp
    // must gate the family-wide revoke exactly as it gates DELETE /devices/:id — otherwise one
    // paired bearer signs out the window and every sibling device in a single request. Its own
    // plain sign-out (the case above) stays a 204.
    const { deps } = await makeDeps();
    const seeded = await seedSession(deps.db, { now: FIXED_NOW });
    const minted = await mintPairingToken(ctxFor(hostDeps(deps), seeded), { grant: "device-pair", label: "phone" });
    const redeemed = await app.handle(
      req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token: minted.token }) }),
      hostDeps(deps),
    );
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string } };
    const res = await app.handle(
      req("POST", "/auth/logout", { bearer: tokens.accessToken, body: JSON.stringify({ allDevices: true }) }),
      hostDeps(deps),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("step_up_required");
    // Nothing died: the paired bearer itself still works.
    const alive = await app.handle(req("GET", "/devices", { bearer: tokens.accessToken }), hostDeps(deps));
    expect(alive.status).toBe(200);
  });

  it("GET /auth/audit answers the bare lifecycle's truth: an empty trail, 200, never a 500", async () => {
    // The local tier records no auth events (`SessionLifecycle.audit` is a no-op); the read
    // half of that same truth is an empty list — not an error about a table this store never
    // had, and not the hosted `AuthService` probe's `500 auth service not configured`.
    const { deps } = await makeDeps();
    const seeded = await seedSession(deps.db, { now: FIXED_NOW });
    const minted = await mintPairingToken(ctxFor(hostDeps(deps), seeded), { grant: "device-pair", label: "phone" });
    const redeemed = await app.handle(
      req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token: minted.token }) }),
      hostDeps(deps),
    );
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string } };
    const res = await app.handle(req("GET", "/auth/audit", { bearer: tokens.accessToken }), hostDeps(deps));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });
});
