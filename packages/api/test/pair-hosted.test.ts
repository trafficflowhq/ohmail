import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions } from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makePushService } from "@trafficflow/services";
import { makePushEndpointGuard } from "@trafficflow/core/net";
import { mintPairingToken, type ServiceContext } from "@trafficflow/services/auth";
import { pairRoutes } from "../src/routes/pair.js";
import { makeDeps, req, seedSession, FIXED_NOW } from "./helpers.js";

/**
 * ═══ DEVICE PAIRING ON THE HOSTED TABLE — the managed door, driven as `apps/api-vercel`
 *     composes it ═════════════════════════════════════════════════════════════════════════════
 *
 * The managed mount put the whole pairing ceremony on `apiRoutes` so the webapp's Devices pane
 * can mint a QR and a phone can redeem `${origin}/pair#<token>` for a bearer pair. This file
 * proves the two properties that make that mount safe on a LIVE, cookie-serving, billing-funneled
 * deployment — the properties `pair.test.ts` (self-host table) and `desktop-host.test.ts` (the
 * desktop door) each prove for THEIR compositions:
 *
 *  1. **Device-pair only, in both directions, decided by the bag.** `apps/api-vercel` wires no
 *     `services.inviteRedeem`, so the invite REDEEM refuses (`pair.ts`'s port probe — the
 *     billing-funnel bypass the old not-mounting guarded against) and the invite MINT refuses
 *     symmetrically (a grant this composition cannot redeem must not be mintable on it). The
 *     `hostedDeps` shape below mirrors that bag: the full `AuthService`, NO invite bridge,
 *     cookies ALLOWED — the managed posture exactly, and the opposite of the desktop door's.
 *
 *  2. **Zero Set-Cookie across the pairing surface, WITH the cookie surface ON.** The desktop
 *     door pins zero-Set-Cookie by composing `allowCookieAuth: false`; this table cannot — the
 *     browser client's whole session lives in cookies — so the pin has to hold per-surface: no
 *     `/pair*` response, on any status, ever carries a `Set-Cookie`, even when the REQUEST
 *     carries one. A cookie minted by the redeem would turn a token shown on a screen into a
 *     browser session on ohmail.app; a cookie minted by the mint/list/revoke would be a session
 *     write on a surface that only hands out bearer material. Mutation watched red: a
 *     `Set-Cookie` planted on the redeem's 200 turns the census below red by name.
 *
 * Plus the paired session's standing (no step-up inheritance — the desktop door's cases, re-run
 * against THIS table because this is the composition a phone actually reaches in production),
 * and the row-level fact the launch-revoke narrowing keys on: a paired session always carries a
 * `deviceId` (`apps/sidecar/src/identity.ts` narrows its per-launch revoke with
 * `isNull(sessions.deviceId)`; that narrowing protects sessions like the ones minted here, so
 * the NOT-NULL half is asserted where the sessions are minted).
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const STALE = new Date(FIXED_NOW.getTime() - 60 * 60_000);

/**
 * The api-vercel bag shape: everything `makeDeps` wires EXCEPT the invite bridge — the hosted
 * deployment never constructs one — and the cookie surface explicitly ON (`buildDeps` computes
 * it per host; the managed browser origin composes it open, which is exactly the posture the
 * zero-Set-Cookie census must hold under).
 */
function hostedDeps(deps: ApiDeps): ApiDeps {
  const { inviteRedeem: _inviteRedeem, ...services } = deps.services!;
  return { ...deps, services: services as ApiDeps["services"], allowCookieAuth: true };
}

/** A ServiceContext for the one direct service call (minting the invite-grant fixture). */
function ctxFor(deps: ApiDeps, s: { accountId: string; userId: string }): ServiceContext {
  return {
    db: deps.db as unknown as ServiceContext["db"],
    accountId: s.accountId,
    userId: s.userId,
    sessionId: null,
    now: deps.now,
    requestId: "pair-hosted-test",
  };
}

const mintReq = (bearer: string, body: Record<string, unknown>): Request =>
  req("POST", "/pair", { bearer, body: JSON.stringify(body) });

describe("device-pair only — the bag decides, in both directions", () => {
  it("the invite MINT refuses 400 on the hosted bag; the device-pair mint answers 200", async () => {
    // Watched red: with the mint's composition guard removed from `pair.ts`, the first request
    // here answered 200 — a credential this composition can never redeem, handed out anyway.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const hosted = hostedDeps(deps);

    const invite = await H(mintReq(s.token, { grant: "invite", label: "family" }), hosted);
    expect(invite.status).toBe(400);
    const refusal = await invite.json();
    expect(refusal.error.code).toBe("validation_failed");
    expect(refusal.error.message).toContain("not mintable");

    const device = await H(mintReq(s.token, { grant: "device-pair", label: "Phone" }), hosted);
    expect(device.status, await device.clone().text()).toBe(200);
    const minted = await device.json();
    expect(minted.grant).toBe("device-pair");
    expect(typeof minted.token).toBe("string");
  });

  it("the invite REDEEM refuses 400 (validation_failed) — the funnel-bypass arm stays closed", async () => {
    // The token is minted through the SERVICE with the full-bag context (the standalone server's
    // position), then presented to the HOSTED door: the refusal must be the port probe's 400, so
    // the redeemer can act on it, and the billing funnel cannot be entered from here.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await mintPairingToken(ctxFor(deps, s), { grant: "invite", label: "family" });

    const res = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "invite", token: minted.token, email: "kid@example.com" }),
    }), hostedDeps(deps));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_failed");
  });
});

describe("the paired-device lifecycle over the hosted table — mint, redeem, establish, refresh, revoke", () => {
  it("mint → redeem → the session carries a deviceId → /devices lists it → refresh rotates → the minter's revoke kills the next request", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const hosted = hostedDeps(deps);

    // MINT — session + fresh factor, exactly the webapp pane's position after sign-in.
    const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "Mila's phone" }), hosted)).json();
    expect(typeof minted.token).toBe("string");

    // REDEEM — anonymous, as the phone does it against `${origin}/pair/redeem`. The bearer pair
    // in the body and nothing else.
    const redeemed = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), hosted);
    expect(redeemed.status, await redeemed.clone().text()).toBe(200);
    expect(redeemed.headers.getSetCookie()).toEqual([]);
    const { tokens } = (await redeemed.json()) as {
      tokens: { accessToken: string; refreshToken: string };
    };

    // THE ROW-LEVEL FACT the launch-revoke narrowing keys on: the paired session has a device.
    // `apps/sidecar/src/identity.ts` revokes per-launch sessions WHERE `deviceId IS NULL`; a
    // paired session minted NULL here would be inside that revoke's blast radius on any store
    // that runs it. `establishPairedDevice` always inserts a device row first — asserted where
    // the session is actually minted, over the door production serves.
    const paired = await db.select().from(sessions)
      .where(eq(sessions.userId, s.userId))
      .then((rows) => rows.filter((r) => r.id !== s.sessionId));
    expect(paired).toHaveLength(1);
    expect(paired[0]!.deviceId).not.toBeNull();

    // VISIBLE — the device list is what makes the offer revocable and therefore safe.
    const listed = await (await H(req("GET", "/devices", { bearer: tokens.accessToken }), hosted)).json();
    const phone = (listed.items as Array<{ id: string; label: string; current: boolean }>)
      .find((d) => d.label === "Mila's phone");
    expect(phone).toBeDefined();
    expect(phone!.current).toBe(true);

    // REFRESH — the body branch, the only one a bearer client has. Tokens in the body, zero
    // Set-Cookie, even though this table's cookie surface is ON: the transport of the request
    // decides the transport of the answer.
    const rotated = await H(req("POST", "/auth/refresh", {
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    }), hosted);
    expect(rotated.status).toBe(200);
    expect(rotated.headers.getSetCookie()).toEqual([]);
    const rotatedTokens = ((await rotated.json()) as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    expect(rotatedTokens.refreshToken).not.toBe(tokens.refreshToken);

    // REVOKE — from the MINTER's own session (fresh factor; the webapp pane's position), by the
    // device id the list shows. The paired session's NEXT request is a 401: the take-back is
    // immediate, not eventual.
    const revoke = await H(req("DELETE", `/devices/${phone!.id}`, { bearer: s.token }), hosted);
    expect(revoke.status).toBe(204);
    const after = await H(req("GET", "/devices", { bearer: rotatedTokens.accessToken }), hosted);
    expect(after.status).toBe(401);
  });

  it("revoking a paired device takes its WAKE REGISTRATION down with its sessions", async () => {
    /**
     * ── THE HALF A CREDENTIAL TAKE-BACK USED TO MISS ──────────────────────────────────
     *
     * A revoked phone stops being able to read mail immediately — the case above proves that.
     * But a UnifiedPush registration is not a session: it is a row keyed by an endpoint, and the
     * worker POSTs to it because the row exists, not because anybody is signed in. So a revoke
     * that dropped only the sessions left a phone that could no longer READ mail and still got
     * told, every few seconds of somebody else's morning, that mail had arrived. That is a
     * take-back that did not take everything back, and it is visible to whoever holds the phone.
     *
     * `AuthService.revokeDevice` overrides the base lifecycle to prune `push_subscriptions` for
     * the device, AFTER the base revoke — so a step-up refusal deletes nothing. This drives the
     * REAL route (`DELETE /devices/:id`) over the hosted bag, because the override is only
     * reached if `deps.services.auth` is the `AuthService` and not the base class; a test that
     * called the method directly would prove the method and not the wiring.
     */
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    // The hosted bag, plus an endpoint policy — the plain `pushService` singleton refuses
    // `unifiedpush` by design (an unwired guard must not read as "accept any endpoint"), so the
    // registration below would 400 without one. Resolver injected: no DNS in the sandbox.
    const hosted: ApiDeps = {
      ...hostedDeps(deps),
      services: {
        ...hostedDeps(deps).services!,
        push: makePushService({
          endpointGuard: makePushEndpointGuard(
            { async resolve() { return ["93.184.216.34"]; } }, { allowPrivate: false },
          ),
        }),
      } as ApiDeps["services"],
    };

    const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "Mila's phone" }), hosted)).json();
    const redeemed = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), hosted);
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string } };

    // The phone registers its wake endpoint on its OWN paired session, which is what stamps the
    // row with that session's `device_id` — the join the prune depends on.
    const registered = await H(req("POST", "/push/subscriptions", {
      bearer: tokens.accessToken,
      body: JSON.stringify({ transport: "unifiedpush", endpoint: "https://ntfy.example.com/upABC" }),
    }), hosted);
    expect(registered.status, await registered.text().catch(() => "")).toBe(201);

    const stamped = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, s.accountId));
    expect(stamped, "the registration was not written").toHaveLength(1);
    // STAMPED FROM THE SESSION, not from the request body — the body named no device at all.
    expect(stamped[0]!.deviceId, "the row carries no device, so no revoke can ever find it")
      .not.toBeNull();

    const listed = await (await H(req("GET", "/devices", { bearer: tokens.accessToken }), hosted)).json();
    const phone = (listed.items as Array<{ id: string; label: string }>)
      .find((d) => d.label === "Mila's phone");
    expect(phone).toBeDefined();
    expect(stamped[0]!.deviceId).toBe(phone!.id);

    // REVOKE, from the minter's own fresh-factor session — the webapp Devices pane's position.
    const revoke = await H(req("DELETE", `/devices/${phone!.id}`, { bearer: s.token }), hosted);
    expect(revoke.status).toBe(204);

    const left = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, s.accountId));
    expect(left, "the revoked device's wake registration survived its sessions").toHaveLength(0);
  });

  it("RE-REGISTERING the same endpoint from a new device re-stamps the row, so the revoke still reaches it", async () => {
    /**
     * ── THE HOLE A DEDUPED REGISTRATION LEFT IN THE TAKE-BACK ────────────────────────────────
     *
     * A UnifiedPush endpoint is stable for the life of an app install, so the SECOND registration
     * of the same endpoint is the ordinary case: the phone was revoked and paired again, or simply
     * relaunched after a re-pair. `onConflictDoNothing` deduped the row correctly and threw away
     * the new `device_id` — leaving the registration pointing at a device row that had already
     * been revoked. From then on nothing could take it down: the CURRENT device's revoke did not
     * match it, and the old device's revoke had already happened. The endpoint kept receiving wakes
     * with no surface anywhere that could stop it.
     *
     * This drives the real sequence — pair, register, revoke, pair again, register the SAME
     * endpoint, revoke — and the final assertion is the one that used to fail.
     */
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const hosted: ApiDeps = {
      ...hostedDeps(deps),
      services: {
        ...hostedDeps(deps).services!,
        push: makePushService({
          endpointGuard: makePushEndpointGuard(
            { async resolve() { return ["93.184.216.34"]; } }, { allowPrivate: false },
          ),
        }),
      } as ApiDeps["services"],
    };
    const ENDPOINT = "https://ntfy.example.com/upSTABLE";

    /**
     * Pair a phone and register ENDPOINT on its own session; answer THAT session's own device id,
     * read from `/devices` (`current: true`) rather than from the push row.
     *
     * Reading it from the row would be the whole bug wearing a helper: the question this test asks
     * is "does the row point at the device that last registered", so the expected value has to come
     * from somewhere other than the row.
     */
    const pairAndRegister = async (label: string): Promise<string> => {
      const minted = await (await H(mintReq(s.token, { grant: "device-pair", label }), hosted)).json();
      const redeemed = await H(req("POST", "/pair/redeem", {
        body: JSON.stringify({ grant: "device-pair", token: minted.token }),
      }), hosted);
      const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string } };
      const reg = await H(req("POST", "/push/subscriptions", {
        bearer: tokens.accessToken,
        body: JSON.stringify({ transport: "unifiedpush", endpoint: ENDPOINT }),
      }), hosted);
      expect(reg.status, await reg.text().catch(() => "")).toBe(201);
      const listed = await (await H(req("GET", "/devices", { bearer: tokens.accessToken }), hosted)).json();
      const me = (listed.items as Array<{ id: string; current: boolean }>).find((d) => d.current);
      expect(me, `the ${label} session has no device of its own`).toBeDefined();
      return me!.id;
    };

    const firstDevice = await pairAndRegister("first pairing");
    const first = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, s.accountId));
    expect(first).toHaveLength(1);
    expect(first[0]!.deviceId).toBe(firstDevice);

    /**
     * NO REVOKE IN BETWEEN — and that is the point of the sequence.
     *
     * A revoke would delete the row, and the next registration would be a fresh INSERT that never
     * touches the conflict path. The bug lives in the DEDUPED write, so the second pairing has to
     * register while the first row is still there. That is also the real-world shape: a phone that
     * re-pairs (a new session, a new device row) without anybody having revoked the old one, which
     * is what happens when a person re-scans the QR because the app lost its credential.
     */
    const secondDevice = await pairAndRegister("re-paired");
    expect(secondDevice, "the two pairings produced one device row").not.toBe(firstDevice);

    const deduped = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, s.accountId));
    expect(deduped, "the same endpoint produced more than one row").toHaveLength(1);
    expect(
      deduped[0]!.deviceId,
      "the deduped registration kept the OLD device stamp, so the current device's revoke cannot reach it",
    ).toBe(secondDevice);

    // AND THE CURRENT DEVICE'S REVOKE REACHES IT. This is what was unreachable before the re-stamp.
    expect((await H(req("DELETE", `/devices/${secondDevice}`, { bearer: s.token }), hosted)).status).toBe(204);
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, s.accountId)),
      "a re-registered endpoint survived the revoke of the device that registered it",
    ).toHaveLength(0);
  });

  it("a step-up REFUSAL deletes nothing — the prune runs after the base revoke, never instead of it", async () => {
    // The ordering half. `revokeDevice` prunes AFTER `super.revokeDevice`, so a caller without
    // step-up standing gets 403 and the registration is untouched. Inverting the order would make
    // a 403 an unauthenticated delete of somebody's push rows — a refusal with a side effect.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const hosted: ApiDeps = {
      ...hostedDeps(deps),
      services: {
        ...hostedDeps(deps).services!,
        push: makePushService({
          endpointGuard: makePushEndpointGuard(
            { async resolve() { return ["93.184.216.34"]; } }, { allowPrivate: false },
          ),
        }),
      } as ApiDeps["services"],
    };

    const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "phone" }), hosted)).json();
    const redeemed = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), hosted);
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string } };
    await H(req("POST", "/push/subscriptions", {
      bearer: tokens.accessToken,
      body: JSON.stringify({ transport: "unifiedpush", endpoint: "https://ntfy.example.com/upZZZ" }),
    }), hosted);

    const before = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, s.accountId));
    expect(before).toHaveLength(1);

    // The paired session has no step-up standing (the case below proves that in general).
    const refused = await H(req("DELETE", `/devices/${before[0]!.deviceId!}`, {
      bearer: tokens.accessToken,
    }), hosted);
    expect(refused.status).toBe(403);

    const after = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, s.accountId));
    expect(after, "a refused revoke deleted a wake registration anyway").toHaveLength(1);
  });

  it("a JUST-PAIRED session has no step-up standing on THIS table: no chained mint, no device revoke, no allDevices logout", async () => {
    // The desktop door proves these against its own composition; a phone in production reaches
    // THIS one, so the same three privileges are asserted refused here. `establishPairedDevice`
    // mints `twofaAt: null` — a credential that may have crossed a room on paper inherits
    // nothing that could sign other devices out or mint more of itself.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const hosted = hostedDeps(deps);
    const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "phone" }), hosted)).json();
    const redeemed = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), hosted);
    const { tokens } = (await redeemed.json()) as { tokens: { accessToken: string } };

    const chained = await H(mintReq(tokens.accessToken, { grant: "device-pair" }), hosted);
    expect(chained.status).toBe(403);
    expect((await chained.json()).error.code).toBe("step_up_required");

    const revoke = await H(req("DELETE", `/devices/${randomUUID()}`, { bearer: tokens.accessToken }), hosted);
    expect(revoke.status).toBe(403);
    expect((await revoke.json()).error.code).toBe("step_up_required");

    const massLogout = await H(req("POST", "/auth/logout", {
      bearer: tokens.accessToken, body: JSON.stringify({ allDevices: true }),
    }), hosted);
    expect(massLogout.status).toBe(403);
    expect((await massLogout.json()).error.code).toBe("step_up_required");
  });

  it("a STALE factor cannot mint on the hosted table — the webapp's step-up sentence is the real gate", async () => {
    const { db, deps } = await makeDeps();
    const stale = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: STALE });
    const res = await H(mintReq(stale.token, { grant: "device-pair" }), hostedDeps(deps));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_required");
  });
});

describe("ZERO Set-Cookie across the pairing surface — with the cookie surface ON", () => {
  it("no /pair* response carries a Set-Cookie, on any status, even when the REQUEST carries cookies", async () => {
    // Every pairing route, driven three ways — bare, with a garbage session cookie, and with a
    // garbage refresh cookie riding along — because the managed table's OTHER surfaces answer
    // cookie-bearing requests WITH cookies (that is what a browser session is), and the pin
    // here is that the pairing surface never joins them. The success shapes (mint 200,
    // redeem 200, refresh 200 on the paired pair) are asserted on their own paths in the
    // lifecycle case above; between the two, every response shape the surface can produce is
    // swept. Mutation watched red: a header planted on the redeem's 200
    // (`json({...}, 200)` → a response carrying `Set-Cookie: tf_session=...`) failed this
    // census by route name before it was restored.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const hosted = hostedDeps(deps);

    const pairSurface = apiRoutes.filter((r) => r.pattern.startsWith("/pair"));
    // Five since the link's state read by its hash (`POST /pair/state`) joined the redeem; six with a phone app's
    // handoff to its sibling (`POST /pair/handoff`).
    expect(pairSurface).toHaveLength(6);
    const presentations: Array<{ name: string; init: { cookie?: string; bearer?: string } }> = [
      { name: "bare", init: {} },
      { name: "session cookie", init: { cookie: "tf_session=not-a-real-token; tf_csrf=x" } },
      { name: "refresh cookie", init: { cookie: "tf_refresh=not-a-real-token" } },
      { name: "bearer", init: { bearer: s.token } },
    ];
    for (const r of pairSurface) {
      for (const p of presentations) {
        const path = r.pattern.replace(/:[^/]+/g, randomUUID());
        const needsBody = !["GET", "HEAD"].includes(r.method);
        const res = await H(req(r.method, path, {
          ...p.init, ...(needsBody ? { body: "{}" } : {}),
        }), hosted);
        expect(
          res.headers.getSetCookie(),
          `${r.method} ${r.pattern} (${p.name}) answered with Set-Cookie (status ${res.status})`,
        ).toEqual([]);
      }
    }
  });

  it("a successful redeem stays cookie-free when the redeemer's browser sends the minter's own live cookies", async () => {
    // The sharpest version of the planted-cookie case: the REQUEST carries a real, live session
    // cookie (the minter's), the redeem succeeds, and the answer still contains bearer material
    // only. If the handler ever consulted or refreshed ambient cookies, this is where it would
    // show — and a Set-Cookie here is exactly the "token on a screen becomes a browser session"
    // failure the anonymous pipeline exists to make unrepresentable.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const hosted = hostedDeps(deps);
    const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "iPad" }), hosted)).json();

    const res = await H(req("POST", "/pair/redeem", {
      cookie: `tf_session=${s.token}; tf_csrf=whatever`,
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), hosted);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["grant", "tokens"]);
  });
});

describe("the composition tripwire nearest the door", () => {
  it("the hosted mounts ARE pairRoutes' members — one ceremony, no fork", () => {
    // `hello.test.ts` owns the full table census; this is the identity half restated beside the
    // behavioural suite so a re-listed copy cannot pass here while the census file is edited.
    for (const r of pairRoutes) expect(apiRoutes).toContain(r);
    expect(apiRoutes.filter((r) => r.pattern.startsWith("/pair"))).toHaveLength(pairRoutes.length);
  });
});
