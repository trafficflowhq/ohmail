import { describe, it, expect } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { sessions, devices, refreshTokens } from "@trafficflow/db";
import { loginTokens, authEvents } from "@trafficflow/db/cloud";
import { DESKTOP_APPROVAL_PURPOSE, hashToken } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * SIGNING A DESKTOP IN BY CONFIRMING IN THE BROWSER — every door through the ROUTE.
 *
 * The desktop asks (`POST /auth/desktop-approval`), the signed-in page reads and confirms (the
 * confirm is step-up gated and CSRF-bound), and the desktop polls the claim with the verifier it
 * never let out of its engine. The refusals are asserted as the wire answers them, because the
 * gates that matter here — `public`, `stepUp`, CSRF, the 202 — live in the pipeline, not the
 * service. The concurrent one-use half is `desktop-approval.pg.test.ts` on real Postgres.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const IP = "203.0.113.77";

/** The PKCE pair, spelled with node's crypto so the wire encoding is the thing under test. */
const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "utf8").digest("base64url") };
};

const code = async (res: Response): Promise<string | undefined> =>
  ((await res.json()) as { error?: { code?: string } }).error?.code;

async function ask(
  deps: ApiDeps, body: Record<string, unknown>, ip = IP,
): Promise<Response> {
  return H(req("POST", "/auth/desktop-approval", {
    headers: { "x-vercel-forwarded-for": ip }, body: JSON.stringify(body),
  }), deps);
}

/** A desktop's request, answered: its id and the verifier the "engine" kept. */
async function request(deps: ApiDeps, label = "studio-mac"): Promise<{ id: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const res = await ask(deps, { challenge, kind: "desktop-linux", label });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { approvalId: string; expiresIn: number };
  expect(body.expiresIn).toBe(300);
  return { id: body.approvalId, verifier };
}

const claim = (deps: ApiDeps, body: Record<string, unknown>, ip = IP): Promise<Response> =>
  H(req("POST", "/auth/desktop-approval/claim", {
    headers: { "x-vercel-forwarded-for": ip }, body: JSON.stringify(body),
  }), deps);

const confirm = (deps: ApiDeps, id: string, token: string): Promise<Response> =>
  H(req("POST", `/auth/desktop-approval/${id}/confirm`, { bearer: token, body: "{}" }), deps);

async function signedIn(deps: { db: Parameters<typeof seedSession>[0] }, fresh = true) {
  return seedSession(deps.db, { now: FIXED_NOW, lastTwofaAt: fresh ? FIXED_NOW : null });
}

describe("the desktop asks — public, bounded, and nothing it stores identifies a host", () => {
  it("writes ONE unbound row with the challenge, the label, the platform and an IP CLASS", async () => {
    const { db, deps } = await makeDeps();
    const { verifier, challenge } = pkce();
    const res = await ask(deps, { challenge, kind: "desktop-linux", label: "  studio\u202e-mac\n" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const { approvalId } = (await res.json()) as { approvalId: string };
    const rows = await db.select().from(loginTokens);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(approvalId);
    expect(row.purpose).toBe(DESKTOP_APPROVAL_PURPOSE);
    expect(row.userId).toBeNull();
    expect(row.approvedAt).toBeNull();
    expect(row.challengeHash).toBe(challenge);
    expect(row.label).toBe("studio-mac");
    expect(row.platform).toBe("Linux");
    expect(row.ipClass).toBe("203.0.x.x");
    // The verifier and the full address are nowhere at rest.
    expect(JSON.stringify(rows)).not.toContain(verifier);
    expect(JSON.stringify(rows)).not.toContain(IP);
  });

  it("refuses a missing or malformed challenge, and an unknown kind, before any row", async () => {
    const { db, deps } = await makeDeps();
    expect(await code(await ask(deps, {}))).toBe("invalid_challenge");
    expect(await code(await ask(deps, { challenge: "short" }))).toBe("invalid_challenge");
    expect(await code(await ask(deps, { challenge: pkce().challenge, kind: "web" }))).toBe("validation_failed");
    expect(await db.select().from(loginTokens)).toHaveLength(0);
  });

  it("the eleventh request from one connection in the window is a 429", async () => {
    const { deps } = await makeDeps();
    for (let i = 0; i < 10; i++) expect((await ask(deps, { challenge: pkce().challenge })).status).toBe(200);
    const eleventh = await ask(deps, { challenge: pkce().challenge });
    expect(eleventh.status).toBe(429);
    expect((await ask(deps, { challenge: pkce().challenge }, "198.51.100.1")).status).toBe(200);
  });
});

describe("the page reads what it is about to confirm", () => {
  it("needs a session, and answers the facts without an address", async () => {
    const { db, deps } = await makeDeps();
    const { id } = await request(deps);
    expect((await H(req("GET", `/auth/desktop-approval/${id}`), deps)).status).toBe(401);
    const me = await signedIn({ db });
    const res = await H(req("GET", `/auth/desktop-approval/${id}`, { bearer: me.token }), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      label: "studio-mac", platform: "Linux", ipClass: "203.0.x.x", network: "unknown",
      requestedAt: FIXED_NOW.toISOString(), expiresIn: 300, approved: false,
    });
    expect(JSON.stringify(body)).not.toContain(IP);
  });

  it("says in one word whether the computer asked from this browser's network", async () => {
    const { db, deps } = await makeDeps();
    const { id } = await request(deps);
    const me = await signedIn({ db });
    const readFrom = async (ip: string): Promise<Record<string, unknown>> => {
      const res = await H(req("GET", `/auth/desktop-approval/${id}`, {
        bearer: me.token, headers: { "x-vercel-forwarded-for": ip },
      }), deps);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const elsewhere = await readFrom("198.51.100.9");
    expect(elsewhere.network).toBe("different");
    expect(JSON.stringify(elsewhere)).not.toContain("198.51");
    expect((await readFrom("203.0.5.6")).network).toBe("same");
  });

  it("TTL at read: past five minutes the page says it expired", async () => {
    const { db, deps, clock } = await makeDeps();
    const { id } = await request(deps);
    const me = await signedIn({ db });
    clock.advance(5 * 60_000);
    const res = await H(req("GET", `/auth/desktop-approval/${id}`, { bearer: me.token }), deps);
    expect(res.status).toBe(410);
    expect(await code(res)).toBe("approval_expired");
  });
});

describe("the confirm is ONE press, step-up gated, CSRF-bound, own account only", () => {
  it("a stale factor is 403 step_up_required and the row is untouched; a fresh one binds it", async () => {
    const { db, deps } = await makeDeps();
    const { id } = await request(deps);
    const stale = await signedIn({ db }, false);
    const refused = await confirm(deps, id, stale.token);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("step_up_required");
    let [row] = await db.select().from(loginTokens).where(eq(loginTokens.id, id));
    expect(row!.userId).toBeNull();
    expect(row!.approvedAt).toBeNull();

    const me = await signedIn({ db });
    const ok = await confirm(deps, id, me.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie()).toEqual([]);
    [row] = await db.select().from(loginTokens).where(eq(loginTokens.id, id));
    expect(row!.userId).toBe(me.userId);
    expect(row!.approvedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
    const events = await db.select().from(authEvents).where(eq(authEvents.userId, me.userId));
    expect(events.map((e) => e.event)).toContain("desktop_approval_confirmed");
    // A second press is the same answer, not a refusal.
    expect((await confirm(deps, id, me.token)).status).toBe(200);
  });

  it("a cookie session without the CSRF token is refused; with it the press lands", async () => {
    const { db, deps } = await makeDeps();
    const { id } = await request(deps);
    const me = await signedIn({ db });
    const bare = await H(req("POST", `/auth/desktop-approval/${id}/confirm`, {
      cookie: `tf_session=${me.token}`, body: "{}",
    }), deps);
    expect(bare.status).toBe(403);
    const csrf = csrfTokenFor(me.token);
    const good = await H(req("POST", `/auth/desktop-approval/${id}/confirm`, {
      cookie: `tf_session=${me.token}; tf_csrf=${csrf}`, headers: { "x-csrf-token": csrf }, body: "{}",
    }), deps);
    expect(good.status, await good.clone().text()).toBe(200);
  });

  it("another account reads, confirms and denies a 404 once the request is bound", async () => {
    const { db, deps } = await makeDeps();
    const { id } = await request(deps);
    const me = await signedIn({ db });
    const them = await signedIn({ db });
    expect((await confirm(deps, id, me.token)).status).toBe(200);
    expect((await H(req("GET", `/auth/desktop-approval/${id}`, { bearer: them.token }), deps)).status).toBe(404);
    expect((await confirm(deps, id, them.token)).status).toBe(404);
    const deny = await H(req("POST", `/auth/desktop-approval/${id}/deny`, { bearer: them.token, body: "{}" }), deps);
    expect(deny.status).toBe(404);
    const [row] = await db.select().from(loginTokens).where(eq(loginTokens.id, id));
    expect(row!.userId).toBe(me.userId);
    expect(row!.revokedAt).toBeNull();
  });

  it("an unknown request is a 404, never a 500", async () => {
    const { db, deps } = await makeDeps();
    const me = await signedIn({ db });
    expect((await confirm(deps, randomUUID(), me.token)).status).toBe(404);
  });
});

describe("the desktop's claim: pending, then the pair ONCE, and every refusal by name", () => {
  it("pending answers 202 with the cadence and costs no slot; the confirm makes it 200 once", async () => {
    const { db, deps } = await makeDeps();
    const { id, verifier } = await request(deps);
    for (let i = 0; i < 12; i++) {
      const res = await claim(deps, { approvalId: id, verifier, kind: "desktop-linux" });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "pending", retryAfterMs: 2000 });
    }
    const me = await signedIn({ db });
    expect((await confirm(deps, id, me.token)).status).toBe(200);

    const res = await claim(deps, { approvalId: id, verifier, kind: "desktop-linux" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = (await res.json()) as { tokens: { accessToken: string; refreshToken: string } };
    expect(Object.keys(body)).toEqual(["tokens"]);

    // A NAMED native device, a 400-day family, the factor stamp the confirm carried.
    const devs = await db.select().from(devices).where(eq(devices.userId, me.userId));
    expect(devs.map((d) => [d.kind, d.label])).toEqual([["desktop-linux", "studio-mac"]]);
    const minted = (await db.select().from(sessions).where(eq(sessions.userId, me.userId)))
      .filter((s) => s.deviceId === devs[0]!.id);
    expect(minted).toHaveLength(1);
    expect(minted[0]!.lastTwofaAt?.toISOString()).toBe(FIXED_NOW.toISOString());
    const [rt] = await db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, minted[0]!.id));
    expect(rt!.expiresAt.getTime() - FIXED_NOW.getTime()).toBe(400 * 24 * 60 * 60_000);

    const again = await claim(deps, { approvalId: id, verifier, kind: "desktop-linux" });
    expect(again.status).toBe(410);
    expect(await code(again)).toBe("approval_used");
  });

  it("a denied request answers approval_denied", async () => {
    const { db, deps } = await makeDeps();
    const { id, verifier } = await request(deps);
    const me = await signedIn({ db });
    const deny = await H(req("POST", `/auth/desktop-approval/${id}/deny`, { bearer: me.token, body: "{}" }), deps);
    expect(deny.status).toBe(200);
    const res = await claim(deps, { approvalId: id, verifier });
    expect(res.status).toBe(410);
    expect(await code(res)).toBe("approval_denied");
    const events = await db.select().from(authEvents).where(eq(authEvents.userId, me.userId));
    expect(events.map((e) => e.event)).toContain("desktop_approval_denied");
  });

  it("TTL at claim: an approved request claimed after five minutes is approval_expired", async () => {
    const { db, deps, clock } = await makeDeps();
    const { id, verifier } = await request(deps);
    const me = await signedIn({ db });
    expect((await confirm(deps, id, me.token)).status).toBe(200);
    clock.advance(5 * 60_000);
    const res = await claim(deps, { approvalId: id, verifier });
    expect(res.status).toBe(410);
    expect(await code(res)).toBe("approval_expired");
    expect(await db.select().from(devices).where(eq(devices.userId, me.userId))).toHaveLength(0);
  });

  it("five wrong verifiers kill the row, audited once; the sixth — even the right one — is 410", async () => {
    const { db, deps } = await makeDeps();
    const { id, verifier } = await request(deps);
    const me = await signedIn({ db });
    expect((await confirm(deps, id, me.token)).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      const res = await claim(deps, { approvalId: id, verifier: pkce().verifier }, `198.51.100.${i + 10}`);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("invalid_approval");
    }
    const [row] = await db.select().from(loginTokens).where(eq(loginTokens.id, id));
    expect(row!.attempts).toBe(5);
    expect(row!.revokedAt).not.toBeNull();
    const refused = (await db.select().from(authEvents).where(eq(authEvents.userId, me.userId)))
      .filter((e) => e.event === "desktop_approval_refused");
    expect(refused).toHaveLength(1);
    const sixth = await claim(deps, { approvalId: id, verifier });
    expect(sixth.status).toBe(410);
    expect(await code(sixth)).toBe("approval_expired");
  });

  it("a claim carrying the previous claim's digest ends that desktop's family", async () => {
    const { db, deps } = await makeDeps();
    const me = await signedIn({ db });
    const claimed = async (extra: Record<string, unknown> = {}): Promise<string> => {
      const { id, verifier } = await request(deps);
      expect((await confirm(deps, id, me.token)).status).toBe(200);
      const res = await claim(deps, { approvalId: id, verifier, kind: "desktop-linux", ...extra });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { tokens: { refreshToken: string } }).tokens.refreshToken;
    };
    const first = await claimed();
    await claimed({ previousSession: hashToken(first) });
    const late = await H(req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: first }) }), deps);
    expect(late.status, "the install's previous family still renews").toBe(401);
  });

  it("an unknown request and a wrong verifier cost slots: the eleventh from one connection is 429", async () => {
    const { deps } = await makeDeps();
    for (let i = 0; i < 10; i++) {
      const res = await claim(deps, { approvalId: randomUUID(), verifier: "x" });
      expect(res.status).toBe(410);
    }
    expect((await claim(deps, { approvalId: randomUUID(), verifier: "x" })).status).toBe(429);
  });
});

describe("a desktop signed in from the browser keeps the browser's factor time", () => {
  /**
   * The approval's claim stamped its session with the confirm's own time, so a desktop signed in
   * this way could confirm the next request inside a fresh window, and step-up never aged out on one
   * factor. It now inherits the confirming session's factor time, as a desktop link's claim does.
   * `POST /pair` is the step-up door the chain reaches.
   */
  it("a link, then a chain of approvals, keeps the first factor's time; past its window the last desktop cannot pair", async () => {
    const { db, deps, clock } = await makeDeps();
    const stampOf = async (accessToken: string): Promise<string | undefined> =>
      (await db.select({ at: sessions.lastTwofaAt }).from(sessions)
        .where(eq(sessions.accessTokenHash, hashToken(accessToken))))[0]?.at?.toISOString();
    const tokensOf = async (res: Response): Promise<string> => {
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
    };
    const linkHop = async (bearer: string): Promise<string> => {
      const minted = await H(req("POST", "/auth/desktop-link", { bearer, body: "{}" }), deps);
      expect(minted.status, await minted.clone().text()).toBe(200);
      const { code: linkCode } = (await minted.json()) as { code: string };
      return tokensOf(await H(req("POST", "/auth/desktop-claim", {
        headers: { "x-vercel-forwarded-for": IP }, body: JSON.stringify({ code: linkCode }),
      }), deps));
    };
    const approvalHop = async (bearer: string): Promise<string> => {
      const { id, verifier } = await request(deps);
      expect((await confirm(deps, id, bearer)).status).toBe(200);
      return tokensOf(await claim(deps, { approvalId: id, verifier, kind: "desktop-linux" }));
    };
    const pairFrom = (bearer: string): Promise<Response> => H(req("POST", "/pair", {
      bearer, body: JSON.stringify({ grant: "device-pair", label: "Phone" }),
    }), deps);
    const t0 = FIXED_NOW;
    const web = await signedIn({ db });

    clock.advance(60_000);
    const linked = await linkHop(web.token);
    clock.advance(60_000);
    const a = await approvalHop(linked);
    expect(await stampOf(a), "the claim stamped the confirm's time").toBe(t0.toISOString());
    clock.advance(2 * 60_000);
    const b = await approvalHop(a);
    expect(await stampOf(b)).toBe(t0.toISOString());

    clock.advance(60_000 + 1_000); // one second past the window opened by the factor at t0
    const refused = await pairFrom(b);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("step_up_required");

    // The control: a factor asserted now, approved and claimed inside its window, pairs.
    const fresh = await seedSession(db, { now: clock.now(), lastTwofaAt: clock.now() });
    expect((await pairFrom(await approvalHop(fresh.token))).status).toBe(200);
  });
});
