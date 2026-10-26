import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  createApp, jsonResponse, dbBusyResponse, isDbBusy, isOrganizerRefusal, type Route,
} from "@trafficflow/api";
import { DbAcquireTimeoutError, DbConnectionCapError } from "@trafficflow/db/cloud";
/* IMPORTED HERE AND NOWHERE IN `src` — that asymmetry IS the pin. The middleware may not name
   this entry point (it ships inside the desktop engine's closure); a test may, and that is what
   lets the name it matches on be checked against the real classes. */
import { MailboxNotFoundError, OrganizedElsewhereError } from "@trafficflow/db";
import { probeDatabase } from "../src/routes/health.js";
import { makeDeps, req, seedSession, FIXED_NOW } from "./helpers.js";

/**
 * WHAT THE API ANSWERS WHEN THE INSTANCE'S ONE CONNECTION IS BUSY.
 *
 * The failure this closes: 47 × `504 FUNCTION_INVOCATION_TIMEOUT` in twenty minutes, every one at
 * the platform's 60 s ceiling, across twelve unrelated routes at once — including a `HEAD /health`
 * at 60 012 ms, a route whose whole database cost is one trivial select. A 504 is produced ABOVE
 * the API: it carries no code, no request id and no cause, it cannot be alerted on, and it is
 * indistinguishable from the service being down.
 *
 * `POOLED_ACQUIRE_TIMEOUT_MS` (`packages/db/src/client.ts`) turns the wait into a thrown
 * `DbAcquireTimeoutError`. These are the assertions that it becomes an ANSWER rather than a 500.
 */
describe("db_busy — a starved connection answers, it does not hang", () => {
  const routes: Route[] = [
    {
      method: "GET", pattern: "/starved", options: { public: true },
      handler: async () => { throw new DbAcquireTimeoutError(15_000); },
    },
    {
      method: "GET", pattern: "/other-fault", options: { public: true },
      handler: async () => { throw new Error("kaboom"); },
    },
    { method: "GET", pattern: "/fine", options: { public: true }, handler: async () => jsonResponse({ ok: true }) },
  ];

  /**
   * Two writes: one with no idempotency contract — the shape `POST /snippets` and
   * `POST /drafts` actually have — and one that opted in.
   */
  const mutations: Route[] = [
    {
      method: "POST", pattern: "/write", options: { public: true },
      handler: async () => { throw new DbAcquireTimeoutError(15_000); },
    },
    {
      method: "POST", pattern: "/keyed", options: { public: true, idempotent: true },
      handler: async () => { throw new DbAcquireTimeoutError(15_000); },
    },
  ];

  /** PROTECTED (no `public`) and idempotent — the shape every real `idempotent: true` route has. */
  const protectedMutations: Route[] = [
    {
      method: "POST", pattern: "/protected-keyed", options: { idempotent: true },
      handler: async () => { throw new DbAcquireTimeoutError(15_000); },
    },
    /**
     * PROTECTED and NOT idempotent, and NOT keyed — the shape `POST /tags` has, which the engine
     * queues as `tag_create`. Most protected mutations look like this; only 24 routes are marked
     * idempotent.
     */
    {
      method: "POST", pattern: "/protected-plain", options: {},
      handler: async () => { throw new DbAcquireTimeoutError(15_000); },
    },
  ];

  it("answers 503 db_busy with Retry-After, not the 500 an unknown throw would get", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(req("GET", "/starved"), deps);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = await res.json() as { error: { code: string; retryable?: boolean; message: string } };
    expect(body.error.code).toBe("db_busy");
    // A GET has no effect to duplicate, so returning is unconditionally safe.
    expect(body.error.retryable).toBe(true);
    // Never the driver's message: it can carry the connection string and the failing statement.
    expect(body.error.message).not.toMatch(/postgres|password|@/i);
  });

  /**
   * THE ANSWER MUST NOT INVITE A DUPLICATE WRITE.
   *
   * The refused statement was already written to the socket and is deliberately NOT cancelled
   * (`packages/db/src/client.ts`), so Postgres will normally still run it. For a read that costs
   * nothing; for a write it means the row may exist while the caller was told 503. Only 24 routes
   * carry `idempotent: true` — `POST /snippets` and `POST /contacts/:id/notes` insert directly —
   * so a blanket `retryable: true` here is an instruction to create duplicates.
   *
   * `false` rather than absent is the load-bearing part: the client's fallback is
   * `retryable ?? (status >= 500)`, so saying nothing would mean "retry" for exactly these.
   */
  it("an unkeyed mutation is told NOT to retry", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(mutations).handle(req("POST", "/write"), deps);

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string; retryable?: boolean } };
    expect(body.error.code).toBe("db_busy");
    expect(body.error.retryable).toBe(false);
    // Still tells a monitor or proxy when to come back, even when this client must not.
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  it("a keyed mutation on an idempotent ROUTE, with a session, is told it may retry", async () => {
    // The engine replays a queued verb under its ORIGINAL key (`client-engine/src/engine.ts`), and
    // `withIdempotency` replays the winner's stored answer — so the effect lands once however many
    // times this returns. A BEARER, because a cookie POST would be refused by `withCsrf` before
    // the handler is reached and the test would pass for the wrong reason.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(mutations).handle(
      req("POST", "/keyed", {
        bearer: s.token,
        headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" },
      }), deps,
    );

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(true);
  });

  /**
   * THE STARVED SESSION LOOKUP — and the reason `hasAccount` alone is not merely conservative but
   * DESTRUCTIVE.
   *
   * `withSession` resolving the token is the FIRST database query on every authenticated request,
   * which makes it the likeliest one to be starved. If the ceiling fires there, `deps.session` was
   * never assigned. Answering `retryable: false` in that state makes `OhmailEngine` treat it as an
   * explicit refusal: `overlays.delete`, `awaitingEcho.delete`, `dropOutbox(p.id)` — **the user's
   * mutation is thrown away** because the server was briefly busy.
   *
   * On a PROTECTED route both possible states are safe, which is why it is the route and not the
   * account that decides: either the session resolved (so `withIdempotency` ran and a replay is
   * deduplicated) or it did not (so nothing ran at all).
   *
   * Driven for real: the session lookup itself raises the ceiling's error.
   */
  it("a starved SESSION LOOKUP on a protected keyed mutation stays retryable", async () => {
    const { deps } = await makeDeps();
    // Every access throws, so `resolveSession` fails exactly where the first query would.
    deps.db = new Proxy({}, {
      get() { throw new DbAcquireTimeoutError(15_000); },
    }) as unknown as typeof deps.db;

    const res = await createApp(protectedMutations).handle(
      req("POST", "/protected-keyed", {
        bearer: "any-token-the-lookup-never-completes",
        headers: { "idempotency-key": "22222222-2222-4222-8222-222222222222" },
      }), deps,
    );

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string; retryable?: boolean } };
    expect(body.error.code).toBe("db_busy");
    expect(body.error.retryable, "a discarded outbox entry is worse than a deduplicated replay")
      .toBe(true);
  });

  /**
   * THE SAME RESCUE, ON A ROUTE WITH NO IDEMPOTENCY MARKING AT ALL — which is most of them.
   *
   * "Nothing ran" is a different question from "would a replay be deduplicated", and it has to be
   * asked first. `POST /tags` is protected and not `idempotent`-marked, and the engine queues it
   * as `tag_create`; when the session lookup is the starved query the handler cannot have run, so
   * a retry duplicates nothing. Asking the idempotency question first answered `false` here and
   * the engine deletes the durable outbox entry on `false` — the user's tag, gone, because the
   * server was briefly busy. No key is sent, deliberately: this must not depend on one.
   */
  it("a starved session lookup rescues a protected NON-idempotent, UNKEYED mutation", async () => {
    const { deps } = await makeDeps();
    deps.db = new Proxy({}, {
      get() { throw new DbAcquireTimeoutError(15_000); },
    }) as unknown as typeof deps.db;

    const res = await createApp(protectedMutations).handle(
      req("POST", "/protected-plain", { bearer: "the-lookup-never-completes" }), deps,
    );

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable, "nothing ran, so nothing can be duplicated").toBe(true);
  });

  /**
   * The other side of that rule, so it cannot be read as "protected ⇒ always retryable": once a
   * session HAS resolved, the handler may have run, and a route with no idempotency contract is
   * back to the duplicate-write risk.
   */
  it("a protected NON-idempotent mutation WITH a session is still not retryable", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(protectedMutations).handle(
      req("POST", "/protected-plain", { bearer: s.token }), deps,
    );

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
  });

  /**
   * `withIdempotency` needs an `accountId` and returns early without one — `middleware.ts:572`,
   * the line after the empty-key check. A PUBLIC idempotent route can genuinely run its handler
   * with no session at all, so there the absence really does mean unprotected.
   */
  it("a keyed mutation on a PUBLIC idempotent route with no session is not retryable", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(mutations).handle(
      req("POST", "/keyed", { headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" } }), deps,
    );

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
  });

  /**
   * An EMPTY key satisfies `Headers.has()` and is skipped by `withIdempotency`, whose own guard is
   * `const key = …get("idempotency-key"); if (!key) return next(…)`. Gating on `has()` therefore
   * promised deduplication on a request that gets none.
   */
  it("an EMPTY Idempotency-Key buys nothing, and is not treated as protection", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(mutations).handle(
      req("POST", "/keyed", { bearer: s.token, headers: { "idempotency-key": "" } }), deps,
    );

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
  });

  /**
   * THE HEADER IS NOT THE CONTRACT — the trap this gate nearly walked into.
   *
   * The client engine puts an `Idempotency-Key` on EVERY queued mutation, but `withIdempotency`
   * only acts where the ROUTE opted in. `http-adapter.ts` says so about a real route in its own
   * words: a send is two requests and *"only the second is idempotent server-side (`POST /drafts`
   * is not `idempotent`-marked)"*. Gating on the header alone would promise a deduplication the
   * server never performs, on exactly the routes that create rows.
   */
  it("a keyed mutation on a NON-idempotent route is still told not to retry", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(mutations).handle(
      req("POST", "/write", { headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" } }), deps,
    );

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
  });

  it("does NOT widen: any other throw is still an opaque 500", async () => {
    // The branch is a named exception to the 500, not a general softening of it. A route that
    // genuinely failed must keep reporting a fault rather than inviting a retry loop.
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(req("GET", "/other-fault"), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  /**
   * THE BACKSTOP'S DEFAULT, WHICH NOTHING ELSE REACHES.
   *
   * `handleApiRequest` catches throws that escaped the router, so it has no route in hand and
   * calls `dbBusyResponse(req)` with no second argument. Not knowing whether the route dedupes
   * must mean "do not invite a retry".
   *
   * **The request must CARRY the key for this to test anything**, which the first version of it
   * did not: with no header the answer is `false` whatever the default is, so flipping the default
   * to `true` passed. The default is only ever consulted for a keyed unsafe request — which is
   * exactly what the client engine sends — so that is the case it has to be asserted on.
   */
  it("with no route in hand, a KEYED unsafe request still defaults to NOT retryable", async () => {
    const post = dbBusyResponse(new Request("https://api.ohmail.app/anything", {
      method: "POST", headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" },
    }));
    const body = await post.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
  });

  it("with no route in hand, an unkeyed unsafe request is not retryable either", async () => {
    const post = dbBusyResponse(new Request("https://api.ohmail.app/anything", { method: "POST" }));
    const body = await post.json() as { error: { retryable?: boolean } };
    expect(body.error.retryable).toBe(false);
  });

  it("with no route in hand, a safe method is still retryable", () => {
    const get = dbBusyResponse(new Request("https://api.ohmail.app/anything"));
    return get.json().then((body: unknown) => {
      expect((body as { error: { retryable?: boolean } }).error.retryable).toBe(true);
    });
  });

  /**
   * A POOLER AT ITS CLIENT CAP IS BUSY TOO. On 2026-10-26 the pooler refused new client connections
   * (EMAXCONN) for six minutes and every route answered 500: the statement never began, exactly as
   * under the acquire ceiling, so it is the same answer, and the message names the cap.
   */
  it("a connection refused at the cap answers 503 db_busy naming it, with Retry-After", async () => {
    const capped: Route[] = [{
      method: "GET", pattern: "/capped", cost: "read", relay: false, options: { public: true },
      handler: async () => { throw new DbConnectionCapError("pooler"); },
    }];
    const { deps } = await makeDeps();
    const res = await createApp(capped).handle(req("GET", "/capped"), deps);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = await res.json() as { error: { code: string; retryable?: boolean; message: string } };
    expect(body.error).toMatchObject({ code: "db_busy", retryable: true });
    expect(body.error.message).toMatch(/connection limit/);
    expect(isDbBusy(new DbConnectionCapError("server"))).toBe(true);
    // The host's backstop has no route in hand; given the error, it names the cap as well.
    const backstop = await dbBusyResponse(new Request("https://api.ohmail.app/x"), {}, new DbConnectionCapError("pooler")).json();
    expect((backstop as { error: { message: string } }).error.message).toMatch(/connection limit/);
  });

  /**
   * AT THE CAP THE REFUSED STATEMENT NEVER REACHED THE SERVER, so a write whose replay reaches the
   * same state (`state`, `guarded`) or is deduplicated by its handler stays retryable once its
   * session resolved: `false` makes the engine drop the queued verb. The acquire ceiling keeps its
   * rule, because its statement may still run.
   */
  it("at the cap, a protected write whose replay converges stays retryable after its session", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const retryable = async (replay: Route["replay"], err: Error): Promise<unknown> => {
      const write: Route = {
        method: "PATCH", pattern: "/capped-write", cost: "work", relay: false, replay,
        handler: async () => { throw err; },
      };
      const res = await createApp([write]).handle(req("PATCH", "/capped-write", { bearer: s.token }), deps);
      expect(res.status).toBe(503);
      return ((await res.json()) as { error: { retryable?: boolean } }).error.retryable;
    };
    const cap = new DbConnectionCapError("pooler");
    for (const replay of ["state", "guarded", "handler"] as const) expect(await retryable(replay, cap), replay).toBe(true);
    for (const replay of [undefined, "ephemeral", "mints"] as const) expect(await retryable(replay, cap), `${replay}`).toBe(false);
    expect(await retryable("state", new DbAcquireTimeoutError(15_000)), "acquire ceiling").toBe(false);
  });

  it("leaves a healthy response untouched", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(req("GET", "/fine"), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  /**
   * THE CROSS-FILE PIN.
   *
   * `middleware.ts` matches the error by NAME rather than importing the class, and it has to:
   * `DbAcquireTimeoutError` lives in `packages/db/src/client.ts`, reachable only through
   * `@trafficflow/db/cloud`, and `client.ts` names the COMBINED schema — while `packages/api` sits
   * inside the desktop engine's import closure (the rule at the top of `packages/db/src/index.ts`).
   * An import there would put every Cloud table into a shipped .app, compile cleanly, and pass
   * every other test.
   *
   * The cost of that spelling is that a rename would silently un-map the 503 and hand the 60 s
   * gateway timeout back. This is the guard for it: the string in `middleware.ts` must still be
   * the real class's `name`.
   */
  it("the middleware's spelling of the error name still matches the real class", () => {
    const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
    const declared = /const DB_ACQUIRE_TIMEOUT_ERROR = "([^"]+)"/.exec(source)?.[1];
    expect(declared, "middleware.ts must declare DB_ACQUIRE_TIMEOUT_ERROR").toBeDefined();
    expect(declared).toBe(new DbAcquireTimeoutError(1).name);
    expect(declared).toBe("DbAcquireTimeoutError");
  });

  it("the middleware does not import the class it matches (the closure rule)", () => {
    const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import[^\n]*@trafficflow\/db/m);
  });

  /**
   * THE SAME PIN, FOR THE SECOND FAMILY THAT REACHED THIS FILE FROM `@trafficflow/db`.
   *
   * The organizer refusals arrived as `err instanceof OrganizedElsewhereError`, with the classes
   * imported — which is precisely what the closure rule above forbids, and which turned that
   * guard red in HEAD from the moment it landed. `packages/api` ships inside the desktop engine's
   * import closure, so naming that entry point puts every Cloud table into a shipped .app; it
   * compiles and passes every behavioural test on the way in.
   *
   * The middleware matches by NAME now, like `DbAcquireTimeoutError` beside it, and pays the same
   * cost: a rename would silently un-map the 409 into a 500. This is the guard for that. The TEST
   * may import the classes — it is not the shipped closure — which is what makes the pin possible
   * at all.
   */
  it("the middleware's spelling of the organizer refusals still matches the real classes", () => {
    const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
    const declared = /const ORGANIZER_REFUSAL_ERRORS = \[([^\]]+)\]/.exec(source)?.[1];
    expect(declared, "middleware.ts must declare ORGANIZER_REFUSAL_ERRORS").toBeDefined();
    const names = [...declared!.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(
      [new OrganizedElsewhereError("m", { kind: null, name: null, since: null }).name,
        new MailboxNotFoundError("m").name].sort(),
    );
    expect(names).toEqual(["MailboxNotFoundError", "OrganizedElsewhereError"]);
  });

  /**
   * AND THE SHAPE, because a name match alone is not enough here.
   *
   * `errorResponse` is handed `code` and `httpStatus` off the thrown object. A matcher that
   * trusted the name would pass an `undefined` status through from anything that happened to
   * carry one of these names — and this middleware's entire job is that an unrecognised throw
   * becomes a clean 500 rather than a malformed success.
   */
  it("the organizer matcher refuses an impostor that carries only the name", () => {
    expect(isOrganizerRefusal(
      new OrganizedElsewhereError("m", { kind: "cloud", name: "ohmail Cloud", since: null }),
    )).toBe(true);
    expect(isOrganizerRefusal(new MailboxNotFoundError("m"))).toBe(true);

    const impostor = Object.assign(new Error("nope"), { name: "MailboxNotFoundError" });
    expect(isOrganizerRefusal(impostor), "a bare Error wearing the name was accepted").toBe(false);
    expect(isOrganizerRefusal(new Error("unrelated"))).toBe(false);
    expect(isOrganizerRefusal(null)).toBe(false);
  });

  /**
   * THE BEHAVIOUR THE TWO PINS ABOVE PROTECT — the 409 really is composed, with its `by` block.
   *
   * Every reader door's copy is built from `details.by`, so a refusal that arrives without it is
   * eleven surfaces with nothing to say. Asserted through the real envelope rather than from
   * source, because this one CAN be.
   */
  it("an organizer refusal becomes a 409 carrying who holds the mailbox", async () => {
    const thrower: Route[] = [{
      method: "GET", pattern: "/held", cost: "read", relay: false, options: { public: true },
      handler: async () => {
        throw new OrganizedElsewhereError(
          "mb-1", { kind: "local", name: "mila-thinkpad", since: "2026-08-30T09:00:00.000Z" },
        );
      },
    }];
    const { deps } = await makeDeps();
    const res = await createApp(thrower).handle(req("GET", "/held"), deps);
    expect(res.status).toBe(409);
    const body = await res.json() as {
      error: { code: string; details?: { by?: { kind?: string; name?: string } } };
    };
    expect(body.error.code).toBe("organized_elsewhere");
    expect(body.error.details?.by?.kind).toBe("local");
    expect(body.error.details?.by?.name).toBe("mila-thinkpad");
  });

  it("and a not-found refusal becomes a 404 with no holder block", async () => {
    const thrower: Route[] = [{
      method: "GET", pattern: "/gone", cost: "read", relay: false, options: { public: true },
      handler: async () => { throw new MailboxNotFoundError("mb-2"); },
    }];
    const { deps } = await makeDeps();
    const res = await createApp(thrower).handle(req("GET", "/gone"), deps);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.details).toBeUndefined();
  });
});

/**
 * WHY THERE IS NO RESERVED CONNECTION FOR `/health`.
 *
 * The obvious remedy for a starved monitor is a second, reserved pool so `/health` can always
 * answer. It is not taken, and this is the test that makes the cheaper answer checkable instead.
 *
 * A reserved handle would buy a `200 ok` during starvation — which is the WRONG answer, because
 * the API genuinely cannot serve requests at that moment — at the cost of a second connection per
 * warm instance against an upstream pooler whose budget is the thing under pressure. What
 * monitoring actually needs is a fast answer with a distinguishable cause, and the ceiling already
 * produces one: `probeDatabase` catches the throw, reports `unreachable`, and carries the error's
 * own `code` through to the response, so `/health` says `db_acquire_timeout` in seconds instead of
 * being killed at 60 s with nothing to read.
 */
describe("/health under a starved connection", () => {
  it("names the cause instead of hanging to the platform's ceiling", async () => {
    const starved = { execute: async () => { throw new DbAcquireTimeoutError(15_000); } };
    const probe = await probeDatabase(starved as never);

    expect(probe.kind).toBe("unreachable");
    // The distinguishable half. A monitor that sees this can tell connection contention apart
    // from a database that is actually gone — two very different pages.
    expect((probe as { errorCode: string | null }).errorCode).toBe("db_acquire_timeout");
  });

  it("that code is the one the error class actually carries", () => {
    // Pins the two ends together: `probeDatabase` reads `err.code`, and nothing else asserts that
    // `DbAcquireTimeoutError` has one.
    expect(new DbAcquireTimeoutError(1).code).toBe("db_acquire_timeout");
  });
});
