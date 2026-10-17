import { describe, it, expect } from "vitest";
import { managedAddress } from "../../../test/support/fixture-credentials.js";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { staffUsers, staffSessions, staffRoleGrants } from "@trafficflow/db/cloud";
import { accounts, auditLog, mailboxes } from "@trafficflow/db";
import { scryptHasher, generateToken, hashToken, newTotpSecret, totpNow } from "@trafficflow/services";
import { and, eq } from "drizzle-orm";
import { makeDeps, FIXED_NOW } from "./helpers.js";
import { withStaffStepUp } from "../src/staff-step-up.js";

/**
 * THE STAFF WRITE SURFACE ASKS FOR A RECENT SECOND FACTOR.
 *
 * The console's Actions page states it: *"a staff session without a recent step-up gets 403
 * before any of it runs."* The sentence was false — a twelve-hour staff session minted this
 * morning drove every reachable write all day with no second factor since sign-in. Everything
 * here is driven THROUGH THE ROUTE, because a refusal is only as real as the pipeline the route
 * runs, and the census below is what stops a write added next year from arriving without it.
 */

const app = createApp(apiRoutes);
const SECRET = "admin-step-up-console-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

function post(path: string, body: unknown, opts: { bearer?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  return new Request(`https://api.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const EMAIL = managedAddress("fixture.ops");
const PASSWORD = "admin-step-up-staff-fixture-password";
const NOTE = "provider outage cleared, release the backoff";
const SIX_HOURS = 6 * 60 * 60 * 1000;
/** The window the API enforces and puts on the wire, in ms. */
const WINDOW_MS = 5 * 60_000;

async function deps0(): Promise<ApiDeps> {
  const { deps } = await makeDeps();
  return { ...deps, admin: ADMIN } as ApiDeps;
}

interface World { mailboxId: string; token: string; totpSecret: string; staffId: string }

/** One account, one parked mailbox, one enrolled operator, one session six hours old. */
async function seedStale(deps: ApiDeps): Promise<World> {
  const [account] = await deps.db.insert(accounts).values({ name: "Acme Ltd" }).returning();
  const accountId = (account as { id: string }).id;
  const totpSecret = newTotpSecret();
  const sealed = await deps.keyProvider.encrypt(totpSecret);
  const [staff] = await deps.db.insert(staffUsers).values({
    email: EMAIL,
    passwordHash: await scryptHasher.hash(PASSWORD),
    totpSecretEnc: sealed.ciphertext, totpKeyVersion: sealed.keyVersion, totpActivated: true,
  }).returning();
  // Cloud 0047: roles are read live; this fixture is an owner, as every existing staff member was.
  await deps.db.insert(staffRoleGrants).values({ staffUserId: (staff as { id: string }).id, role: "owner" });
  const token = generateToken(32);
  await deps.db.insert(staffSessions).values({
    staffUserId: (staff as { id: string }).id,
    tokenHash: hashToken(token),
    createdAt: new Date(FIXED_NOW.getTime() - SIX_HOURS),
    lastTwofaAt: new Date(FIXED_NOW.getTime() - SIX_HOURS),
    expiresAt: new Date(FIXED_NOW.getTime() + SIX_HOURS),
  });
  const [mb] = await deps.db.insert(mailboxes).values({
    accountId, provider: "imap", address: "parked@example.test",
    status: "error", errorCode: "auth", retryCount: 4,
    retryAfter: new Date(FIXED_NOW.getTime() + 900_000),
  }).returning();
  return {
    mailboxId: (mb as { id: string }).id, token, totpSecret, staffId: (staff as { id: string }).id,
  };
}

const resync = (w: World): Request =>
  post("/admin/mailboxes/resync", { mailboxId: w.mailboxId, note: NOTE, sessionToken: w.token }, { bearer: SECRET });

const code = (body: unknown): string | undefined => (body as { error?: { code?: string } }).error?.code;

describe("a staff session with no recent second factor cannot write", () => {
  it("refuses POST /admin/mailboxes/resync with 403 step_up_required", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const res = await H(resync(w), deps);
    expect(res.status).toBe(403);
    const body = await res.json() as { stepUpWindowSeconds?: number };
    expect(code(body)).toBe("step_up_required");
    // The window travels with the refusal so the console's prompt says what the code buys.
    expect(body.stepUpWindowSeconds).toBe(WINDOW_MS / 1000);
  });

  it("leaves the mailbox parked and writes no audit row when it refuses", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    await H(resync(w), deps);
    const [row] = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(row!.retryAfter).not.toBeNull();
    expect(await deps.db.select().from(auditLog)).toHaveLength(0);
  });

  it("refuses POST /admin/oauth/microsoft/save the same way", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const res = await H(
      post("/admin/oauth/microsoft/save", {
        sessionToken: w.token, note: "rotating the registration",
        clientId: "11111111-1111-1111-1111-111111111111",
      }, { bearer: SECRET }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(code(await res.json())).toBe("step_up_required");
  });

  it("still ANSWERS the registration read — a read is not a write", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const res = await H(post("/admin/oauth/microsoft", { sessionToken: w.token }, { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
  });
});

describe("the step-up route is how a stale session gets back inside the window", () => {
  it("takes a code, and the write then goes through (the positive control)", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const stepped = await H(post("/admin/staff/step-up", {
      token: w.token, code: totpNow(w.totpSecret, deps.now()),
    }, { bearer: SECRET }), deps);
    expect(stepped.status).toBe(200);
    expect((await stepped.json() as { status?: string }).status).toBe("stepped_up");

    const res = await H(resync(w), deps);
    expect(res.status).toBe(200);
    const [row] = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(row!.retryAfter).toBeNull();
    expect(await deps.db.select().from(auditLog)).toHaveLength(1);
  });

  it("mints nothing and leaves the session's expiry where it was", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const before = (await deps.db.select().from(staffSessions))[0]!;
    const stepped = await H(post("/admin/staff/step-up", {
      token: w.token, code: totpNow(w.totpSecret, deps.now()),
    }, { bearer: SECRET }), deps);
    const body = await stepped.json() as Record<string, unknown>;
    // No `token` in the answer: stepping up must not be a way to keep a stolen cookie alive.
    expect(body.token).toBeUndefined();
    const after = (await deps.db.select().from(staffSessions))[0]!;
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.lastTwofaAt.getTime()).toBe(FIXED_NOW.getTime());
  });

  it("refuses a wrong code, and the write stays refused", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const stepped = await H(post("/admin/staff/step-up", { token: w.token, code: "000000" }, { bearer: SECRET }), deps);
    expect(stepped.status).toBe(401);
    expect((await H(resync(w), deps)).status).toBe(403);
  });

  it("refuses a session token it has never seen, without a code being needed", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const stepped = await H(post("/admin/staff/step-up", {
      token: generateToken(32), code: totpNow(w.totpSecret, deps.now()),
    }, { bearer: SECRET }), deps);
    expect(stepped.status).toBe(401);
  });

  it("is single-use inside its own timestep — the second presentation is refused", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const six = totpNow(w.totpSecret, deps.now());
    expect((await H(post("/admin/staff/step-up", { token: w.token, code: six }, { bearer: SECRET }), deps)).status).toBe(200);
    // Put the session back outside the window so the second attempt has something to buy.
    await deps.db.update(staffSessions)
      .set({ lastTwofaAt: new Date(FIXED_NOW.getTime() - SIX_HOURS) })
      .where(eq(staffSessions.tokenHash, hashToken(w.token)));
    expect((await H(post("/admin/staff/step-up", { token: w.token, code: six }, { bearer: SECRET }), deps)).status).toBe(401);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The census — a write added without the flag fails HERE
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * EVERY `/admin/*` ROUTE, CLASSIFIED. Three classes and no default:
 *
 *  · `identity` — the sign-in surface itself (`/admin/staff/*`). It cannot ask for a step-up: it
 *    IS the second factor, and a route that demanded one before letting you prove one would be a
 *    permanent refusal, which is the failure this product has already shipped once (a standalone
 *    install behind `withStepUp`).
 *  · `read` — shared-secret + staff-session reads. They change nothing, and training an operator
 *    to type a code to LOOK at something is how codes get typed at prompts that are not writes.
 *  · `write` — changes state, leaves an audit row, and asks for a second factor proved inside
 *    `STAFF_STEP_UP_WINDOW_SECONDS`.
 *
 * A route added to the table and not to this map fails the first assertion; a `write` that does not
 * CARRY `withStaffStepUp` fails the second. That is the enumeration control — a guard that cannot
 * say what it did not cover has covered nothing. The census reads the middleware the route carries
 * rather than a flag, because a flag needs some chain to honour it and the middleware IS the
 * control: carrying it is what makes it run wherever the route is mounted.
 */
const ADMIN_ROUTE_CLASS: Readonly<Record<string, "identity" | "read" | "write">> = {
  "GET /admin/overview": "read",
  "GET /admin/accounts": "read",
  "GET /admin/accounts/:id": "read",
  "GET /admin/funnel": "read",
  "GET /admin/worker": "read",
  "GET /admin/actions": "read",
  "GET /admin/accounts/:id/staff-activity": "read",
  "GET /admin/search": "read",
  "GET /admin/sync-roster": "read",
  // The console's cross-account reads: counts, bytes, the staff audit and resolved alerts. The
  // staff list is a POST read under `/admin/staff/` that changes nothing, so it is a read too.
  "GET /admin/engagement": "read",
  "GET /admin/storage": "read",
  "GET /admin/staff-activity": "read",
  "GET /admin/alerts/history": "read",
  "POST /admin/staff/list": "read",
  // Cloud 0047. The mint judges the session's step-up stamp itself for a write scope (or a TOTP
  // in its body); the roles change consumes a TOTP in its own body. Neither can carry the
  // middleware, which would refuse the very call that proves the factor.
  "POST /admin/staff/assertion": "identity",
  "POST /admin/staff/roles": "identity",
  "POST /admin/staff/session": "identity",
  "POST /admin/staff/totp/begin": "identity",
  "POST /admin/staff/totp/confirm": "identity",
  "POST /admin/staff/step-up": "identity",
  "POST /admin/staff/totp/reset": "identity",
  "POST /admin/staff/whoami": "identity",
  "POST /admin/staff/sign-out": "identity",
  "POST /admin/mailboxes/resync": "write",
  "POST /admin/oauth/microsoft": "read",
  "POST /admin/oauth/microsoft/save": "write",
};

const adminRoutesInTable = apiRoutes.filter((r) => r.pattern.startsWith("/admin/"));
const keyOf = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
/** Does this route CARRY the control? Identity, not a name: a look-alike would not enforce. */
const carriesStepUp = (r: { options?: { middleware?: readonly unknown[] } }): boolean =>
  (r.options?.middleware ?? []).includes(withStaffStepUp);

describe("every staff WRITE is behind the step-up, and the set is enumerated", () => {
  it("classifies every `/admin/*` route in the table, in both directions", () => {
    const inTable = adminRoutesInTable.map(keyOf).sort();
    const classified = Object.keys(ADMIN_ROUTE_CLASS).sort();
    expect(inTable, "an /admin route with no class — classify it before it ships").toEqual(classified);
    expect(inTable.length).toBeGreaterThan(0);
  });

  it("carries the step-up on exactly the writes", () => {
    const wrong: string[] = [];
    for (const route of adminRoutesInTable) {
      const want = ADMIN_ROUTE_CLASS[keyOf(route)] === "write";
      if (want !== carriesStepUp(route)) {
        wrong.push(`${keyOf(route)} — class says ${want ? "write" : "not a write"}, carries ${carriesStepUp(route)}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(adminRoutesInTable.filter(carriesStepUp).length).toBeGreaterThan(0);
  });

  it("refuses a stale staff session on EVERY route that carries the control", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const flagged = adminRoutesInTable.filter(carriesStepUp);
    expect(flagged.length).toBeGreaterThan(0);

    const admitted: string[] = [];
    for (const route of flagged) {
      const res = await H(post(route.pattern, { sessionToken: w.token }, { bearer: SECRET }), deps);
      const body = await res.json().catch(() => ({}));
      if (res.status !== 403 || code(body) !== "step_up_required") {
        admitted.push(`${keyOf(route)} → ${res.status} ${code(body) ?? "(no code)"}`);
      }
    }
    expect(admitted, "routes carrying the step-up that a STALE staff session still reaches").toEqual([]);
  });

  it("admits a FRESH one on the same routes — the gate is not stuck closed", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    await H(post("/admin/staff/step-up", { token: w.token, code: totpNow(w.totpSecret, deps.now()) }, { bearer: SECRET }), deps);

    const refused: string[] = [];
    for (const route of adminRoutesInTable.filter(carriesStepUp)) {
      const res = await H(post(route.pattern, { sessionToken: w.token }, { bearer: SECRET }), deps);
      if (res.status !== 403) continue;
      if (code(await res.json().catch(() => ({}))) === "step_up_required") refused.push(keyOf(route));
    }
    expect(refused, "routes carrying the step-up that refuse a FRESH factor — the gate is stuck closed").toEqual([]);
  });
});

describe("the step-up adds ONE refusal and moves none of the others", () => {
  it("an unarmed host still answers 404 — the surface does not advertise itself", async () => {
    const { deps } = await makeDeps();
    const armed = { ...deps, admin: ADMIN } as ApiDeps;
    const w = await seedStale(armed);
    const res = await H(resync(w), deps);
    expect(res.status).toBe(404);
  });

  it("no shared secret is still 401, before any session is looked at", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const res = await H(post("/admin/mailboxes/resync", {
      mailboxId: w.mailboxId, note: NOTE, sessionToken: w.token,
    }), deps);
    expect(res.status).toBe(401);
    expect(code(await res.json())).toBe("unauthorized");
  });

  it("the secret with no staff session is still 401 staff_session_required", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    const res = await H(post("/admin/mailboxes/resync", {
      mailboxId: w.mailboxId, note: NOTE,
    }, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
    expect(code(await res.json())).toBe("staff_session_required");
  });

  it("a REVOKED session is 401, not 403 — the middleware never answers for a dead credential", async () => {
    const deps = await deps0();
    const w = await seedStale(deps);
    await deps.db.update(staffSessions)
      .set({ revokedAt: FIXED_NOW })
      .where(and(eq(staffSessions.tokenHash, hashToken(w.token))));
    const res = await H(resync(w), deps);
    expect(res.status).toBe(401);
    expect(code(await res.json())).toBe("staff_session_required");
  });
});
