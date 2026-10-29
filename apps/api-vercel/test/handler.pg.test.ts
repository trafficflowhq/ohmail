import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql as raw } from "drizzle-orm";
import {
  API_MAX_DURATION_MS, closePooledDbs, makePooledDb, POOLED_ACQUIRE_TIMEOUT_MS, POOLED_IDLE_TIMEOUT_S,
  POOLED_MAX_CONNECTIONS, SESSION_ACQUIRE_TIMEOUT_MS,
} from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, refreshTokens, sessions, users } from "@trafficflow/db";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { generateToken, hashToken } from "@trafficflow/services";
import { EVENTS_MAX_DURATION_S, PROD_SSE_LIFETIME_MS, resetHostState } from "../src/config.js";
import { resetServices } from "../src/deps.js";
import { handleApiRequest, QUIET_HOLD_MS } from "../src/handler.js";
import { API_FAULT_RECORD_BUDGET_MS, csrfTokenFor } from "@trafficflow/api";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { FIXTURE_SHAPES, stripeTestKey } from "../../../test/support/fixture-credentials.js";

/** A Stripe secret this host must refuse to boot beside; its body must never reach a refusal. */
const STRIPE_KEY = stripeTestKey("handler-metered");

it("the fixture Stripe key has the vendor key's shape", () => {
  expect(STRIPE_KEY).toMatch(FIXTURE_SHAPES.stripeTest);
});

/**
 * THE HOST ITSELF, exercised end to end.
 *
 * Everything else in this app's test folder tests a pure function. Nothing called
 * `handleApiRequest`, so the host's own behaviour — HEAD, the config-failure path, the request
 * id, `no-store`, the malformed-path rejection, the "normalize exactly once" contract — was
 * asserted only by reading the code. Those are precisely the parts a unit test of the normalizer
 * cannot reach, and two of them were broken:
 *   • `HEAD /health` answered **405**, because Next maps HEAD onto the exported GET while the
 *     inner router still saw `method: "HEAD"` — a dead API to every monitor that probes with HEAD;
 *   • the config-failure path re-normalized an already-normalized pathname, so `/api/api/health`
 *     was treated as `/health` and handed the diagnostic detail, against the documented
 *     single-strip contract.
 *
 * It needs a real Postgres because `buildDeps` builds a POOLED postgres-js `Db` from
 * `DATABASE_URL_POOLED` — there is no seam to hand it PGlite, and inventing one would test a
 * different host than the one that gets deployed.
 */
const PG_UP = await realPgAvailable();

const KEK = "ab".repeat(32);

/** The environment a production-shaped instance loads (localhost is exempt from the pooler guard). */
function envFor(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL_POOLED: PG_TEST_URL,
    [KEY_RING_V1]: KEK,
    TF_AUTH_ORIGINS: "https://ohmail.app",
    TF_RP_ID: "ohmail.app",
    TF_BUILD_VERSION: "test-sha",
    ...over,
  } as NodeJS.ProcessEnv;
}

/**
 * Install `env` for this instance: `hostState()` resolves `process.env` once per cold start.
 *
 * Assigning an `undefined` VALUE into `process.env` writes the literal string `"undefined"` (Node
 * coerces every value to a string), which is not "unset" at all — it is a plausible-looking
 * connection string that fails much later. So an undefined entry is DELETED.
 */
function install(env: NodeJS.ProcessEnv): void {
  for (const k of ["DATABASE_URL_POOLED", KEY_RING_V1, "TF_AUTH_ORIGINS", "TF_RP_ID", "TF_BUILD_VERSION",
    "TF_SSE_POLL_MS", "TF_SSE", "TF_COOKIE_HOSTS", "VERCEL_ENV",
    // The entitlements block is all-or-nothing and a leftover STRIPE_* is a cold-start THROW, so
    // a leaked variable from one test would darken the NEXT one's host at config load. This list
    // named `BILLING_PLANE_URL` alone after the pair became `ENTITLEMENTS_URL` + the same secret,
    // so a case that armed the block leaked its URL into the next host with the secret deleted —
    // the HALF-configured state, answering 503 `service_misconfigured` for a reason belonging to
    // the previous test. Both spellings are deleted: the retired one cannot come back either.
    "ENTITLEMENTS_URL", "BILLING_PLANE_URL", "BILLING_PLANE_SECRET",
    "STRIPE_SECRET_KEY", "STRIPE_ACCOUNT_ID", "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_SOLO", "STRIPE_PRICE_PLUS", "STRIPE_PRICE_PRO", "TF_APP_URL"]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetHostState();
  resetServices();
}

const at = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://api.ohmail.app${path}`, init);

/**
 * EVERY connection of the pool `buildDeps` hands out, busy for `seconds`. The pool is
 * module-cached per URL, so these are the request's own connections; each holder needs one of
 * its own, so all are dialled first — one holder on a four-connection pool starves nothing.
 */
async function occupyEveryConnection(seconds: number): Promise<Promise<unknown>[]> {
  const pooled = makePooledDb(PG_TEST_URL);
  await Promise.all(Array.from({ length: POOLED_MAX_CONNECTIONS },
    () => pooled.execute(raw`select pg_sleep(0.05)`)));
  const holders = Array.from({ length: POOLED_MAX_CONNECTIONS }, () => {
    const h = Promise.resolve(pooled.execute(raw`select pg_sleep(${raw.raw(String(seconds))})`));
    h.catch(() => { /* awaited by the caller; this only prevents an unhandled rejection */ });
    return h;
  });
  await new Promise((r) => setTimeout(r, 150));
  return holders;
}

/** Time one request through the shipped host. */
async function timed(req: Request): Promise<{ res: Response; ms: number }> {
  const started = Date.now();
  const res = await handleApiRequest(req);
  return { res, ms: Date.now() - started };
}

describe.skipIf(!PG_UP)("apps/api-vercel — handleApiRequest against real Postgres", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 60_000);
  afterAll(async () => { await closePooledDbs(); resetHostState(); resetServices(); });
  beforeEach(() => { install(envFor()); });

  it("GET /health → 200 on a real SELECT, no-store, with a request id", async () => {
    const res = await handleApiRequest(at("/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, version: "test-sha", schemaOk: true });
    expect(typeof body.dbLatencyMs).toBe("number");
    // The host also opened a fresh connection of its own, and it was admitted.
    expect(typeof body.dbFreshConnectMs).toBe("number");
    expect(body.kek).toEqual({ active: 1, count: 1, fingerprint: expect.any(String) });
  });

  it("GET /api/health is byte-identical to GET /health (prefix normalization, end to end)", async () => {
    const direct = await (await handleApiRequest(at("/health"))).json();
    const prefixed = await (await handleApiRequest(at("/api/health"))).json();
    // dbLatencyMs is a live measurement; everything else must match exactly.
    expect({ ...prefixed, dbLatencyMs: 0 }).toEqual({ ...direct, dbLatencyMs: 0 });
  });

  /**
   * THE PIPELINE WITH NO ENVELOPE, WHICH IS WHERE THE 503 WOULD OTHERWISE HAVE BEEN A 500.
   *
   * `withErrorEnvelope` maps a busy pooled connection to 503 `db_busy` — but it lives in
   * `FULL_PIPELINE` only. `RAW_PIPELINE` (`/events`, `/oauth/authorize`, the attachment byte
   * routes) deliberately carries no envelope while still carrying `withSession`, and a session
   * lookup is a database read. So on a starved connection those routes throw straight past the
   * router into `handleApiRequest`, where `internal()` used to call it a 500 — the wrong answer
   * twice: it blames the route for connection contention, and it tells a monitor the endpoint is
   * broken rather than busy.
   *
   * Driven for real rather than asserted from the source: long statements occupy every
   * connection of the pool `buildDeps` hands the request, and a bearer on a raw route forces the
   * session read behind them. It costs the production ceiling in wall time because `buildDeps`
   * takes no override, which is the point: this is the shipped number on the shipped path.
   */
  it("a RAW route starved of the connection answers 503 db_busy, not 500", async () => {
    const holders = await occupyEveryConnection(18);

    const res = await handleApiRequest(at("/events", {
      headers: { authorization: "Bearer 00000000000000000000000000000000000000000000" },
    }));

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string; retryable?: boolean } };
    expect(body.error.code).toBe("db_busy");
    expect(res.headers.get("Retry-After")).toBe("5");
    // GET is safe, so returning cannot duplicate anything.
    expect(body.error.retryable).toBe(true);
    // The host still stamps its own contract on the answer.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    await Promise.all(holders.map((h) => h.catch(() => { /* torn down */ })));
  }, 90_000);

  it("a busy pool refuses the session doors in 5 s and a write in 15 s, and sets no cookie", async () => {
    // The ceiling split on the shipped host: the two session doors carry the shorter wait, every
    // other route keeps the write ceiling. The garbage bearer and refresh token never reach a
    // statement — the pool refuses first, which is exactly the answer being timed. Each answer
    // also waits out the fault record's own budget, whose write meets the same saturated pool:
    // measured 6.0 s at the session doors, so the bound is the ceiling plus that budget.
    const holders = await occupyEveryConnection(19);
    const bearer = { authorization: "Bearer 00000000000000000000000000000000000000000000" };
    const [session, refresh, write] = await Promise.all([
      timed(at("/auth/session", { headers: bearer })),
      timed(at("/auth/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "0".repeat(43) }),
      })),
      timed(at("/tags", {
        method: "POST", headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ name: "busy" }),
      })),
    ]);

    for (const { res } of [session, refresh, write]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("db_busy");
    }
    const slack = API_FAULT_RECORD_BUDGET_MS + 500;
    for (const door of [session, refresh]) {
      expect(door.ms).toBeGreaterThanOrEqual(SESSION_ACQUIRE_TIMEOUT_MS - 300);
      expect(door.ms, "a session door answers at its own ceiling").toBeLessThanOrEqual(SESSION_ACQUIRE_TIMEOUT_MS + slack);
    }
    expect(write.ms, "a write keeps its own ceiling").toBeGreaterThanOrEqual(POOLED_ACQUIRE_TIMEOUT_MS - 500);
    expect(write.ms).toBeLessThanOrEqual(POOLED_ACQUIRE_TIMEOUT_MS + slack);

    await Promise.all(holders.map((h) => h.catch(() => { /* torn down */ })));
  }, 90_000);

  it("HEAD /health → 200 with NO body — the monitor case that used to 405", async () => {
    const res = await handleApiRequest(at("/health", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("HEAD /api/health also works, and HEAD on a POST-only route is still 405", async () => {
    expect((await handleApiRequest(at("/api/health", { method: "HEAD" }))).status).toBe(200);
    // `/auth/login` has no GET, so mapping HEAD→GET must not invent one.
    expect((await handleApiRequest(at("/auth/login", { method: "HEAD" }))).status).toBe(405);
  });

  it("POST /health → 405, GET /sync → 401, both no-store", async () => {
    const post = await handleApiRequest(at("/health", { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("cache-control")).toBe("no-store");
    const sync = await handleApiRequest(at("/sync"));
    expect(sync.status).toBe(401);
    expect(sync.headers.get("cache-control")).toBe("no-store");
  });

  it("a body-less POST is NOT 415 — the empty-body drop is real over the whole host", async () => {
    // Forwarding a zero-length buffer gives undici a non-null `body`, and `withRequestGuard`
    // then demands a JSON Content-Type. `POST /auth/logout` carries no body by design.
    const res = await handleApiRequest(at("/auth/logout", { method: "POST" }));
    expect(res.status).not.toBe(415);
    expect([401, 204]).toContain(res.status);          // unauthenticated here, but never 415
  });

  it("/api/api/health 404s — the strip happens exactly once, on the request path too", async () => {
    const res = await handleApiRequest(at("/api/api/health"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("/apiary is untouched (it is not a prefixed path)", async () => {
    expect((await handleApiRequest(at("/apiary"))).status).toBe(404);
  });

  it("malformed percent-encoding → 400 malformed_path, not a logged 500", async () => {
    const res = await handleApiRequest(at("/messages/%ZZ/move", { method: "POST" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("malformed_path");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("SSE is server-disabled by default: /events answers 503 sse_disabled, never a stream", async () => {
    // The route is behind a session, so the honest end-to-end assertion here is that the host
    // does not stream to an anonymous caller; the gate itself is asserted in packages/api.
    const res = await handleApiRequest(at("/events"));
    expect([401, 503]).toContain(res.status);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  describe("the config-failure path", () => {
    it("503 service_misconfigured everywhere, and 503 config_invalid WITH the reason on /health", async () => {
      install(envFor({ DATABASE_URL_POOLED: undefined }));
      const other = await handleApiRequest(at("/sync"));
      expect(other.status).toBe(503);
      expect((await other.json()).error.code).toBe("service_misconfigured");

      const health = await handleApiRequest(at("/health"));
      expect(health.status).toBe(503);
      const body = await health.json();
      expect(body.error).toBe("config_invalid");
      expect(body.detail).toContain("DATABASE_URL_POOLED");
    });

    it("/api/health also gets the reason (one strip), /api/api/health does NOT (not two)", async () => {
      install(envFor({ DATABASE_URL_POOLED: undefined }));
      expect((await (await handleApiRequest(at("/api/health"))).json()).error).toBe("config_invalid");
      // The double-normalization bug: `/api/api/health` must be a plain misconfigured 503,
      // because it is NOT `/health` — it is a path that matches no route at all.
      const doubled = await (await handleApiRequest(at("/api/api/health"))).json();
      expect(doubled.error).toEqual({ code: "service_misconfigured", message: "service is misconfigured" });
    });

    it("a config error names the VARIABLE and never a value", async () => {
      install(envFor({ TF_SSE_POLL_MS: "77" }));
      const body = await (await handleApiRequest(at("/health"))).json();
      expect(body.detail).toContain("TF_SSE_POLL_MS");
      expect(body.detail).not.toContain("77");         // the offending value is not echoed
    });
  });

  describe("build identity and KEK are reported, not assumed", () => {
    it("a PRODUCTION deploy with no build identity is 503 build_identity_unknown", async () => {
      install(envFor({ TF_BUILD_VERSION: undefined, VERCEL_ENV: "production" }));
      const res = await handleApiRequest(at("/health"));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("build_identity_unknown");
      expect(body.version).toBe("dev");
    });

    it("the same host outside production is 200 (a local run is not a broken deploy)", async () => {
      install(envFor({ TF_BUILD_VERSION: undefined }));
      const res = await handleApiRequest(at("/health"));
      expect(res.status).toBe(200);
      expect((await res.json()).version).toBe("dev");
    });

    it("a broken KEK degrades /health to 503 without darkening the host", async () => {
      install(envFor({ [KEY_RING_V1]: "nothex" }));
      const health = await handleApiRequest(at("/health"));
      expect(health.status).toBe(503);
      const body = await health.json();
      expect(body.error).toBe("kek_env_invalid");
      expect(body.detail).toContain(KEY_RING_V1);
      expect(body.detail).not.toContain("nothex");
      // …and the host still serves: an ordinary route answers its normal 401, not a 503.
      expect((await handleApiRequest(at("/sync"))).status).toBe(401);
    });
  });

  describe("cookie authentication is decided per HOST", () => {
    const cookieReq = (host: string): Request =>
      new Request(`https://${host}/sync`, { headers: { cookie: `tf_session=${randomUUID()}` } });

    it("api.ohmail.app ignores the cookie entirely (bearer-only surface)", async () => {
      expect((await handleApiRequest(cookieReq("api.ohmail.app"))).status).toBe(401);
    });

    it("an unknown host fails CLOSED to bearer-only", async () => {
      expect((await handleApiRequest(cookieReq("ohmail-api-abc123.vercel" + ".app"))).status).toBe(401);
    });

    it("a cookie host consults the cookie — same 401 here, but by a different path", async () => {
      // Both are 401 with a garbage token; what this pins is that the ALLOW-list is wired into
      // the host at all (the per-host decision is unit-tested exhaustively in host-config.test.ts).
      expect((await handleApiRequest(cookieReq("api.ohmail.app"))).status).toBe(401);
    });

    /**
     * THE REFUSED REFRESH IS ANSWERED WITHOUT `Clear-Site-Data`: Chrome holds such an answer, its
     * cookie clears with it, until it has walked its whole disk cache, and the resume splash waits
     * on it. The cache clear is the purge the browser sends next, answered alone.
     */
    it("on the web's rewrite, a refused refresh clears the jar with no cache clear; the purge answers alone", async () => {
      install(envFor({ TF_COOKIE_HOSTS: "api.ohmail.app,ohmail.app" }));
      const browser = { origin: "https://ohmail.app", "x-forwarded-host": "ohmail.app" };
      const refused = await handleApiRequest(at("/auth/refresh", {
        method: "POST", body: "{}",
        headers: { ...browser, "content-type": "application/json", cookie: `tf_refresh=${"r".repeat(43)}` },
      }));
      expect(refused.status).toBe(401);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("refresh_revoked");
      expect(refused.headers.getSetCookie().filter((c) => /Max-Age=0/.test(c)).map((c) => c.split("=")[0]).sort())
        .toEqual(["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"]);
      expect(refused.headers.get("clear-site-data"), "the refusal is held for a cache walk").toBeNull();

      const purge = await handleApiRequest(at("/auth/refresh", {
        method: "POST", headers: { ...browser, "x-ohmail-clear": "cache" },
      }));
      expect(purge.status).toBe(202);
      expect(purge.headers.get("clear-site-data")).toBe('"cache"');
      expect(purge.headers.getSetCookie()).toEqual([]);
    });

    /**
     * THE SIGN-OUT DOOR AND THE ERASE, the same: a held 204 outlived the press's deadline and a
     * confirmed sign-out was recorded as unconfirmed; a held erase receipt kept the cookie lock.
     */
    it("on the web's rewrite, the sign-out door's 401 and 204 and the erase's 200 clear the jar with no cache clear", async () => {
      install(envFor({ TF_COOKIE_HOSTS: "api.ohmail.app,ohmail.app" }));
      const browser = { origin: "https://ohmail.app", "x-forwarded-host": "ohmail.app" };
      const ended = async (res: Response, status: number, what: string): Promise<void> => {
        expect(res.status, `${what}: ${await res.clone().text()}`).toBe(status);
        expect(res.headers.getSetCookie().filter((c) => /Max-Age=0/.test(c)).map((c) => c.split("=")[0]).sort(), what)
          .toEqual(["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"]);
        expect(res.headers.get("clear-site-data"), `${what}: held for a cache walk`).toBeNull();
      };
      await ended(await handleApiRequest(at("/auth/refresh/logout", { method: "POST", headers: browser })), 401,
        "an empty jar at the door");

      // One account, two sessions: the first signs out at the door, the second (step-up fresh) erases.
      const db = makePooledDb(PG_TEST_URL);
      const now = new Date();
      const [acct] = await db.insert(accounts).values({ name: `so-${randomUUID().slice(0, 8)}` }).returning();
      const [user] = await db.insert(users).values({
        accountId: acct!.id, email: `so-${randomUUID()}@so.example`, displayName: "SO", emailVerifiedAt: now,
      }).returning();
      const jarFor = async (): Promise<{ cookie: string; csrf: string }> => {
        const access = generateToken();
        const refresh = generateToken();
        const familyId = randomUUID();
        const [s] = await db.insert(sessions).values({
          accountId: acct!.id, userId: user!.id, familyId, accessTokenHash: hashToken(access),
          accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
          lastTwofaAt: now,
        }).returning();
        await db.insert(refreshTokens).values({
          accountId: acct!.id, userId: user!.id, sessionId: s!.id, familyId, tokenHash: hashToken(refresh),
          expiresAt: new Date(now.getTime() + 7_200_000),
        });
        return { cookie: `tf_session=${access}; tf_refresh=${refresh}; tf_csrf=${csrfTokenFor(access)}`, csrf: csrfTokenFor(access) };
      };
      const first = await jarFor();
      const second = await jarFor();
      await ended(await handleApiRequest(at("/auth/refresh/logout", {
        method: "POST", headers: { ...browser, cookie: first.cookie, "x-csrf-token": first.csrf },
      })), 204, "a live family at the door");
      await ended(await handleApiRequest(at("/account", {
        method: "DELETE", headers: { ...browser, cookie: second.cookie, "x-csrf-token": second.csrf },
      })), 200, "the erase");
    });
  });
});

/**
 * THE SUBSCRIPTION WEBHOOK DOOR IS GONE FROM THIS HOST, and what is left is the refusal that
 * still applies.
 *
 * This block asserted BYTE FIDELITY of a relay: `POST /billing/webhook` handed the provider's
 * exact bytes to the program that verifies them, because that program HMACs what it receives and
 * a single re-encoding would read as "never retry". The route left with the subscription
 * machinery, so there is no relay here to be byte-transparent about and the fixture that proved a
 * JSON round trip was detectable proved it about nothing. Those cases are removed, not re-pointed.
 *
 * What replaces them is the assertion that the door is ABSENT: a route restored on this host would
 * be red here, on the bare and the `/api`-prefixed path alike, whatever this host's entitlements
 * env says, and with nothing dialled outward. The half-configured refusal below is live and keeps
 * its arm — the variable pair moved with the program, so it is asked of `ENTITLEMENTS_URL` now.
 */
describe.skipIf(!PG_UP)("apps/api-vercel — the retired webhook door, and the config refusals", () => {
  const ENTITLEMENTS_URL = "https://entitlements.example.com";
  const PLANE_SECRET = "handler-plane-fixture-token";
  /** What makes this host METERED: the program's origin plus its own bearer, as a WHOLE. */
  const meteredEnv = {
    ENTITLEMENTS_URL,
    BILLING_PLANE_SECRET: PLANE_SECRET,
  };

  /** Anything this host put on the wire, captured at the fetch boundary. */
  type OutboundCall = { url: string };
  let calls: OutboundCall[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 60_000);
  afterAll(async () => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    await closePooledDbs(); resetHostState(); resetServices();
  });
  beforeEach(() => {
    // Swapped BEFORE the first request, because a lazy client captures the implementation at
    // construction. Its job here is to catch an outbound call that should not happen at all.
    calls = [];
    (globalThis as { fetch: unknown }).fetch = async (url: string) => {
      calls.push({ url });
      return { status: 400, json: async () => ({ error: "unexpected_outbound_call" }) };
    };
    install(envFor(meteredEnv));
  });

  const SIGNATURE = "t=1723800000,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead";

  const post = (path: string): Request =>
    new Request(`https://api.ohmail.app${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": SIGNATURE },
      body: `{"id":"evt_retired","object":"event","type":"customer.subscription.updated"}`,
    });

  it.each(["/billing/webhook", "/api/billing/webhook"])(
    "%s is NOT a door on this host — 404, and nothing is dialled outward",
    async (path) => {
      // Both spellings, because `normalizeRequest` rebuilds the prefixed one: a route restored
      // under either path is a subscription surface back on the open server.
      const res = await handleApiRequest(post(path));
      expect(res.status).toBe(404);
      expect(calls, `${path} dialled outward`).toHaveLength(0);
      // The host is otherwise healthy — an absent door is not a broken deployment.
      expect((await handleApiRequest(at("/health"))).status).toBe(200);
    },
  );

  it("…and with NO entitlements env either: still 404, still healthy", async () => {
    // The old case here expected 503 `billing_unconfigured`. That refusal existed for the relay
    // and went with it, so "unconfigured" is no longer a state this door can be in.
    install(envFor());
    const res = await handleApiRequest(post("/billing/webhook"));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    expect((await handleApiRequest(at("/health"))).status).toBe(200);
  });

  it("a HALF-configured entitlements block darkens the host at 503 rather than booting", async () => {
    // A URL with no bearer is a client whose every call 401s, which fails OPEN — every account
    // allowed, silently. Refused at cold start instead, and the message names VARIABLES.
    install(envFor({ ENTITLEMENTS_URL }));
    const health = await handleApiRequest(at("/health"));
    expect(health.status).toBe(503);
    const body = await health.json();
    expect(body.error).toBe("config_invalid");
    expect(body.detail).toContain("ENTITLEMENTS_URL");
    expect(body.detail).toContain("BILLING_PLANE_SECRET");
  });

  it("a LEFTOVER STRIPE_* variable darkens the host — the stale-credential refusal, end to end", async () => {
    install(envFor({ ...meteredEnv, STRIPE_SECRET_KEY: STRIPE_KEY }));
    const health = await handleApiRequest(at("/health"));
    expect(health.status).toBe(503);
    const body = await health.json();
    expect(body.error).toBe("config_invalid");
    expect(body.detail).toContain("STRIPE_SECRET_KEY");
    expect(body.detail).not.toContain(STRIPE_KEY);   // variables, never values
    expect(body.detail).not.toContain(STRIPE_KEY.slice(STRIPE_KEY.lastIndexOf("_") + 1));
  });
});

/**
 * THE QUIET HOLD. A suspended instance keeps its idle pooled connections open at the pooler until
 * it wakes, and on 2026-10-26 ~160 cold instances' held connections filled the pooler's client cap.
 * Every answer hands the platform a hold that ends `QUIET_HOLD_MS` after its body is done, so the
 * pool's idle close runs first; a later answer releases the earlier one. The platform is its
 * request context and a fake clock (`entitlements-refresh-behind.test.ts`); no route asked here
 * touches the database.
 */
describe("every answer keeps its instance awake past the pool's idle close", () => {
  const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
  const IDLE_MS = POOLED_IDLE_TIMEOUT_S * 1000;
  let holds: Array<{ settled: boolean }> = [];
  beforeEach(() => {
    install(envFor());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    holds = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({
        waitUntil: (p: Promise<unknown>) => {
          const hold = { settled: false };
          holds.push(hold);
          void p.then(() => { hold.settled = true; });
        },
      }),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
  });

  it("an answer hands one hold: still pending at the idle close, settled once QUIET_HOLD_MS is up", async () => {
    const res = await handleApiRequest(at("/apiary"));
    expect(res.status).toBe(404);
    expect(holds).toHaveLength(1);
    await res.text();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(holds[0]!.settled, "released before the pool closed its idle connections").toBe(false);
    await vi.advanceTimersByTimeAsync(QUIET_HOLD_MS - IDLE_MS);
    expect(holds[0]!.settled).toBe(true);
  });

  it("every exit hands one, and an answer with no body (HEAD) starts its quiet at once", async () => {
    await (await handleApiRequest(at("/messages/%ZZ/move", { method: "POST" }))).text();   // the host's own 400
    install(envFor({ DATABASE_URL_POOLED: undefined }));
    await (await handleApiRequest(at("/health"))).text();                                // a misconfigured host
    install(envFor());
    const head = await handleApiRequest(at("/apiary", { method: "HEAD" }));
    expect(holds).toHaveLength(3);
    expect(head.body).toBeNull();
    await vi.advanceTimersByTimeAsync(QUIET_HOLD_MS);
    expect(holds.map((h) => h.settled)).toEqual([true, true, true]);
  });

  it("a later answer releases the earlier one, so one invocation lingers", async () => {
    const first = await handleApiRequest(at("/apiary"));
    const second = await handleApiRequest(at("/apiary"));
    await first.text();
    await second.text();
    await vi.advanceTimersByTimeAsync(1);
    expect(holds.map((h) => h.settled)).toEqual([true, false]);
  });

  it("a body holds until it is read to its end or cancelled", async () => {
    const res = await handleApiRequest(at("/apiary"));
    await vi.advanceTimersByTimeAsync(QUIET_HOLD_MS + 10_000);
    expect(holds[0]!.settled, "a body still being sent is not quiet").toBe(false);
    await res.body!.cancel();
    await vi.advanceTimersByTimeAsync(QUIET_HOLD_MS);
    expect(holds[0]!.settled).toBe(true);
  });

  it("a body done late is held no longer than the invocation's own ceiling", async () => {
    const res = await handleApiRequest(at("/apiary"));
    await vi.advanceTimersByTimeAsync(50_000);
    await res.text();
    await vi.advanceTimersByTimeAsync(1);
    expect(holds[0]!.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(API_MAX_DURATION_MS - 50_000 - 1);
    expect(holds[0]!.settled, "past the catch-all's maxDuration the platform kills the invocation").toBe(true);
  });

  it("the hold outlasts the idle close and fits after a whole /events stream", () => {
    expect(QUIET_HOLD_MS).toBeGreaterThanOrEqual((POOLED_IDLE_TIMEOUT_S + 1) * 1000);
    expect(QUIET_HOLD_MS).toBeLessThanOrEqual(EVENTS_MAX_DURATION_S * 1000 - PROD_SSE_LIFETIME_MS - 5_000);
  });
});
