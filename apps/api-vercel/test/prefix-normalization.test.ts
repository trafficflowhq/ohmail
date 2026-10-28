import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { sha256 } from "@trafficflow/services";
// The PGlite `ApiDeps` factory + session seeder live with the API's own tests. The SUBJECT
// here is this host's normalizer, so the test belongs to this app — but the harness it needs
// is `packages/api`'s, and duplicating it would be a second, drifting copy of the wiring.
import { makeDeps, seedSession, req, FIXED_NOW } from "../../../packages/api/test/helpers.js";
import { canonicalQuery } from "../../../packages/api/src/middleware.js";
import { resetSseCounters, sseLiveCounts } from "../../../packages/api/src/routes/events.js";
/* The canonicalizer comes from the package that DEFINES it; `API_PREFIX` from this host, so a
   drift between the two spellings is a red here and not a silent 404. */
import { MalformedPathError, normalizeEscapes, normalizePathname } from "@trafficflow/api";
import { API_PREFIX } from "../src/prefix.js";
import { normalizeRequest } from "../src/normalize.js";

/**
 * the headline gate: the SAME mutation reaching this host at `/api/x` and at `/x` must
 * produce the IDENTICAL `withIdempotency` request hash, and therefore REPLAY rather than
 * answer 409 `idempotency_replay`.
 *
 * Why it is the gate and not a nicety: `withIdempotency` hashes
 * `method \n new URL(req.url).pathname \n rawBody`. A client that retries a send or a move
 * from a different surface — the webapp's `/api/*` rewrite on one side, `api.ohmail.app`
 * direct on the other — reuses its stored `Idempotency-Key` by design. If the two surfaces
 * hash differently, that retry lands on a stored row whose hash does not match and the API
 * answers 409: the request that exists to be safe under retry becomes the one that fails,
 * and the user is told their key was reused for a different request when it was not.
 *
 * `POST /push/subscriptions` is the vehicle: `idempotent: true`, and it needs nothing seeded
 * beyond a session, so nothing but the path is varying between the two calls.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const SUB = { transport: "webpush", endpoint: "https://push.example/abc", p256dh: "key-p256", auth: "key-auth" };

/**
 * What `withIdempotency` (`packages/api/src/middleware.ts`) computes, byte for byte — including
 * the canonical query string, which is part of the hash so that a future query-dependent
 * mutation cannot replay one request's response for a different request.
 */
const hashOf = (method: string, pathname: string, rawBody: string, query = ""): string =>
  sha256(`${method}\n${pathname}\n${query}\n${rawBody}`).toString("hex");

describe("normalizePathname — the ONE canonicalization", () => {
  it("strips the /api prefix the webapp rewrite may leave", () => {
    expect(normalizePathname("/api/sync")).toBe("/sync");
    expect(normalizePathname("/api/messages/abc/move")).toBe("/messages/abc/move");
    expect(normalizePathname("/api")).toBe("/");
    expect(normalizePathname("/api/")).toBe("/");
  });

  it("leaves an unprefixed path alone", () => {
    expect(normalizePathname("/sync")).toBe("/sync");
    expect(normalizePathname("/")).toBe("/");
    expect(normalizePathname("/health")).toBe("/health");
  });

  it("does NOT strip a path that merely STARTS with the letters 'api'", () => {
    // The dot-boundary equivalent for paths: `/apiary` is a different route, not `/ary`.
    expect(normalizePathname("/apiary")).toBe("/apiary");
    expect(normalizePathname("/apis/keys")).toBe("/apis/keys");
    expect(normalizePathname("/api-docs")).toBe("/api-docs");
  });

  it("strips EXACTLY ONE prefix — a doubled prefix must not invent a route", () => {
    // Stripping repeatedly would turn `/api/api/sync` into `/sync`, i.e. serve a mutation
    // the client never addressed. One strip leaves `/api/sync`, which then 404s. Honest.
    expect(normalizePathname("/api/api/sync")).toBe("/api/sync");
  });

  it("collapses slash runs and drops a trailing slash (both hash differently otherwise)", () => {
    // `matchRoute` filters empty segments, so every one of these ALREADY reaches /sync —
    // which is exactly why they must not produce three different request hashes.
    expect(normalizePathname("//sync")).toBe("/sync");
    expect(normalizePathname("/api//sync")).toBe("/sync");
    expect(normalizePathname("/sync/")).toBe("/sync");
    expect(normalizePathname("/api/sync///")).toBe("/sync");
    expect(normalizePathname("//")).toBe("/");
  });

  it("is idempotent on every path except a deliberately DOUBLED prefix", () => {
    for (const p of ["/api/sync", "/api", "//api//sync//", "/apiary", "/sync", "/", "/health"]) {
      expect(normalizePathname(normalizePathname(p))).toBe(normalizePathname(p));
    }
    // The one exception, and it is a CONSEQUENCE of stripping exactly one prefix rather
    // than a defect: `/api/api/x` canonicalizes to `/api/x`, which is not itself canonical.
    // Harmless because the function runs exactly once per request and `/api/x` matches no
    // route — so a doubled prefix 404s instead of quietly reaching `/x`. Pinned here so a
    // future "just loop until it stops changing" refactor has to argue with a test.
    expect(normalizePathname("/api/api/x")).toBe("/api/x");
    expect(normalizePathname(normalizePathname("/api/api/x"))).toBe("/x");
  });

  it("no route in the table lives under /api, so the strip can never shadow one", () => {
    // If a future route were named `/api/...`, stripping would silently make it
    // unreachable. That is the one way this canonicalization could become wrong.
    const under = apiRoutes.filter((r) => r.pattern === API_PREFIX || r.pattern.startsWith(`${API_PREFIX}/`));
    expect(under.map((r) => `${r.method} ${r.pattern}`)).toEqual([]);
  });
});

describe("normalizeRequest — the rebuilt Request", () => {
  it("rewrites the path, preserves method, query, headers and body", async () => {
    const body = JSON.stringify(SUB);
    const original = new Request("https://api.ohmail.app/api/messages/abc/move?dry=1", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k1", "x-csrf-token": "c" },
      body,
    });
    const n = await normalizeRequest(original);
    const url = new URL(n.url);
    expect(url.pathname).toBe("/messages/abc/move");
    expect(url.search).toBe("?dry=1");
    expect(n.method).toBe("POST");
    expect(n.headers.get("idempotency-key")).toBe("k1");
    expect(n.headers.get("x-csrf-token")).toBe("c");
    expect(await n.text()).toBe(body);
  });

  it("keeps a body-less POST body-less (or withRequestGuard would 415 it)", async () => {
    // `withRequestGuard` demands `application/json` whenever a body is PRESENT. Forwarding
    // an empty body as a zero-length buffer makes `req.body` non-null in undici, so a
    // legitimately body-less `POST /auth/logout` would answer 415 on this host alone.
    const n = await normalizeRequest(new Request("https://h/api/auth/logout", { method: "POST" }));
    expect(new URL(n.url).pathname).toBe("/auth/logout");
    expect(n.body).toBeNull();
    expect(n.headers.get("content-type")).toBeNull();
  });

  it("carries the client's leave: an aborted /api/events request frees its stream slot", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const left = new AbortController();
    const original = new Request(req("GET", "/api/events", { bearer: s.token }), { signal: left.signal });
    const sse = { heartbeatMs: 60_000, pollMs: 60_000, lifetimeMs: 60_000, maxPerAccount: 1 };
    try {
      const res = await app.handle(await normalizeRequest(original), { ...deps, session: null, idempotency: null, sse });
      expect(res.status).toBe(200);
      await res.body!.getReader().read();
      expect(sseLiveCounts().byAccount[s.accountId]).toBe(1);
      left.abort();
      await new Promise((r) => setTimeout(r, 0));
      expect(sseLiveCounts().byAccount[s.accountId], "the left stream still holds its slot").toBeUndefined();
    } finally {
      resetSseCounters();
    }
  });

  it("does not attach a body to GET/HEAD", async () => {
    const n = await normalizeRequest(new Request("https://h/api/sync?since=5", { method: "GET" }));
    expect(new URL(n.url).pathname).toBe("/sync");
    expect(new URL(n.url).search).toBe("?since=5");
    expect(n.body).toBeNull();
  });
});

describe("percent-encoding is canonicalized (RFC 3986 §6.2.2)", () => {
  it("DECODES escaped unreserved characters — two spellings of one route id hash alike", () => {
    // `matchRoute` runs `decodeURIComponent` on every `:param`, so `/messages/%61bc/move` and
    // `/messages/abc/move` reach the SAME handler with `id="abc"` — while the idempotency hash saw
    // the raw path and differed. Any client, SDK or proxy that escapes a little more eagerly than
    // the one that sent the first attempt found its safe retry answered with 409.
    expect(normalizePathname("/messages/%61bc/move")).toBe("/messages/abc/move");
    expect(normalizePathname("/messages/a%2Dbc/move")).toBe("/messages/a-bc/move");
    expect(normalizePathname("/%61pi/sync")).toBe("/sync");          // even the prefix itself
    expect(normalizeEscapes("/a%7Eb%2Ec%5Fd")).toBe("/a~b.c_d");     // ~ . _ are all unreserved
  });

  it("UPPERCASES the escapes it must keep — a reserved character stays escaped", () => {
    // Decoding `%2F` would split the segment and change which route matches, so it stays — but
    // hex case is not meaning, and `%2f` vs `%2F` must not be two different hashes.
    expect(normalizePathname("/messages/a%2fb/move")).toBe("/messages/a%2Fb/move");
    expect(normalizePathname("/messages/a%2Fb/move")).toBe("/messages/a%2Fb/move");
    expect(normalizeEscapes("/x/%c3%a9")).toBe("/x/%C3%A9");         // multi-byte UTF-8 kept escaped
  });

  it("REJECTS malformed encoding instead of letting decodeURIComponent throw a 500", () => {
    // `matchRoute` decodes params from ABOVE the error envelope, so `%ZZ` used to surface as the
    // host's generic 500 with a logged stack — for what is plainly a client error.
    for (const bad of ["/messages/%ZZ/move", "/messages/%A/move", "/messages/abc%", "/%"]) {
      expect(() => normalizePathname(bad)).toThrow(MalformedPathError);
    }
  });

  it("normalizeRequest propagates the rejection (the handler turns it into a 400)", async () => {
    await expect(normalizeRequest(new Request("https://h/messages/%ZZ/move", { method: "POST" })))
      .rejects.toBeInstanceOf(MalformedPathError);
  });

  it("an encoded-equivalent RETRY replays instead of 409ing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const body = JSON.stringify(SUB);
    const headers = { "idempotency-key": "encoded-1" };

    // `subscriptions` written with an escaped `i` — same route, same parameters, same intent.
    const first = await H(
      await normalizeRequest(req("POST", "/push/subscriptions", { bearer: s.token, headers, body })),
      deps,
    );
    expect(first.status).toBe(201);
    const second = await H(
      await normalizeRequest(req("POST", "/api/push/subscr%69ptions", { bearer: s.token, headers, body })),
      deps,
    );
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    const rows = (await db.select().from(pushSubscriptions)).filter((r) => r.accountId === s.accountId);
    expect(rows).toHaveLength(1);
  });
});

describe("THE GATE — /api/x and /x hash identically and REPLAY", () => {
  it("computes the identical request hash for both surfaces", async () => {
    const body = JSON.stringify(SUB);
    const viaPrefix = await normalizeRequest(
      new Request("https://api.ohmail.app/api/push/subscriptions", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }),
    );
    const viaDirect = await normalizeRequest(
      new Request("https://api.ohmail.app/push/subscriptions", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }),
    );
    const a = hashOf(viaPrefix.method, new URL(viaPrefix.url).pathname, await viaPrefix.text(),
      canonicalQuery(new URL(viaPrefix.url)));
    const b = hashOf(viaDirect.method, new URL(viaDirect.url).pathname, await viaDirect.text(),
      canonicalQuery(new URL(viaDirect.url)));
    expect(a).toBe(b);
    // …and it is the hash of the UNPREFIXED path, i.e. what a client that only ever used
    // `api.ohmail.app` already has stored in `idempotency_keys`.
    expect(a).toBe(hashOf("POST", "/push/subscriptions", body));
  });

  it("the second surface REPLAYS the first verbatim — 201, same id, one row, no 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const body = JSON.stringify(SUB);
    const headers = { "idempotency-key": "cross-surface-1" };

    // 1. The mutation arrives DIRECT (api.ohmail.app): `/push/subscriptions`.
    const first = await H(
      await normalizeRequest(req("POST", "/push/subscriptions", { bearer: s.token, headers, body })),
      deps,
    );
    expect(first.status).toBe(201);
    const firstJson = await first.json();
    expect(firstJson.id).toBeTruthy();

    // 2. The user retries from the WEBAPP, whose rewrite presents `/api/push/subscriptions`,
    //    reusing the same stored Idempotency-Key. This is the 409 the normalizer prevents.
    const second = await H(
      await normalizeRequest(req("POST", "/api/push/subscriptions", { bearer: s.token, headers, body })),
      deps,
    );
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(firstJson);

    // 3. …and it replayed rather than re-executed: exactly one subscription row.
    const rows = (await db.select().from(pushSubscriptions)).filter((r) => r.accountId === s.accountId);
    expect(rows).toHaveLength(1);
  });

  it("and in the other direction: prefixed first, direct retry replays", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const body = JSON.stringify(SUB);
    const headers = { "idempotency-key": "cross-surface-2" };

    const first = await H(
      await normalizeRequest(req("POST", "/api/push/subscriptions", { bearer: s.token, headers, body })),
      deps,
    );
    expect(first.status).toBe(201);
    const firstJson = await first.json();

    const second = await H(
      await normalizeRequest(req("POST", "/push/subscriptions", { bearer: s.token, headers, body })),
      deps,
    );
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(firstJson);
    const rows = (await db.select().from(pushSubscriptions)).filter((r) => r.accountId === s.accountId);
    expect(rows).toHaveLength(1);
  });

  it("still 409s a genuinely different body under the same key (the guard is not disarmed)", async () => {
    // The normalizer must remove the SPURIOUS 409 without removing the real one — otherwise
    // "it replays now" would be indistinguishable from "idempotency stopped checking".
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const headers = { "idempotency-key": "cross-surface-3" };

    const first = await H(
      await normalizeRequest(req("POST", "/push/subscriptions", { bearer: s.token, headers, body: JSON.stringify(SUB) })),
      deps,
    );
    expect(first.status).toBe(201);

    const conflict = await H(
      await normalizeRequest(req("POST", "/api/push/subscriptions", {
        bearer: s.token, headers,
        body: JSON.stringify({ ...SUB, endpoint: "https://push.example/other" }),
      })),
      deps,
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_replay");
  });

  it("a trailing slash is the same request too", async () => {
    const { deps } = await makeDeps();
    const s = await seedSession(deps.db, { now: FIXED_NOW });
    const body = JSON.stringify(SUB);
    const headers = { "idempotency-key": "cross-surface-4" };

    const first = await H(
      await normalizeRequest(req("POST", "/push/subscriptions", { bearer: s.token, headers, body })),
      deps,
    );
    const firstJson = await first.json();
    const second = await H(
      await normalizeRequest(req("POST", "/api/push/subscriptions/", { bearer: s.token, headers, body })),
      deps,
    );
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(firstJson);
  });
});
