import { describe, it, expect, afterEach } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { resetSseCounters, sseLiveCounts } from "../src/routes/events.js";
import { SSE_DISABLED_REFUSAL } from "@trafficflow/db/cloud";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /events` as a COST surface (risk 9), not just a protocol.
 *
 * Every open stream is a serverless function running for its whole lifetime and reconnecting
 * forever. Authentication does not bound that at all: each request is perfectly legitimate, so a
 * client in a loop is denial-of-WALLET. Three properties, none of which existed:
 *   1. the server decides whether SSE runs at all (a client-bundle flag is not a control),
 *   2. concurrency is capped per account and per instance,
 *   3. the poll is ONE serialized, caught loop — not overlapping `setInterval` callbacks.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps, sse?: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, ...(sse ? { sse } : {}) });

const TINY: SseConfig = { heartbeatMs: 15, pollMs: 10, lifetimeMs: 150 };

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

afterEach(() => { resetSseCounters(); });

describe("SSE is off unless the SERVER enables it", () => {
  it("enabled:false → 503 sse_disabled, and no stream is opened", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/events", { bearer: s.token }), deps, { ...TINY, enabled: false });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("sse_disabled");
    // 503 (not 404) matters: `EventSource` treats a non-200 as terminal and stops reconnecting,
    // so a client shipped with its own flag on backs off instead of hammering the endpoint.
    expect(sseLiveCounts().total).toBe(0);
  });

  it("the refusal the 5xx signal leaves out is the one this route answers while it is off", async () => {
    // `SSE_DISABLED_REFUSAL` is matched against the request log by method, path and status; this
    // drives the route itself, so a moved route or a changed status cannot leave the signal blind.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req(SSE_DISABLED_REFUSAL.method, SSE_DISABLED_REFUSAL.path, { bearer: s.token }), deps, { ...TINY, enabled: false });
    expect(res.status).toBe(SSE_DISABLED_REFUSAL.status);
    expect((await res.json()).error.code).toBe(SSE_DISABLED_REFUSAL.code);
  });

  it("the gate is checked BEFORE the session's account is used, so it cannot be worked around per account", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (let i = 0; i < 3; i++) {
      const res = await H(req("GET", "/events", { bearer: s.token }), deps, { ...TINY, enabled: false });
      expect(res.status).toBe(503);
    }
    expect(sseLiveCounts().total).toBe(0);
  });
});

describe("SSE concurrency caps", () => {
  it("the (N+1)th stream for one ACCOUNT is 429, and the count is released when streams close", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const cfg: SseConfig = { heartbeatMs: 50, pollMs: 50, lifetimeMs: 400, maxPerAccount: 2 };

    const a = await H(req("GET", "/events", { bearer: s.token }), deps, cfg);
    const b = await H(req("GET", "/events", { bearer: s.token }), deps, cfg);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sseLiveCounts().total).toBe(2);

    const third = await H(req("GET", "/events", { bearer: s.token }), deps, cfg);
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe("sse_too_many_streams");

    // Draining both lets their lifetime close them; the counter must return to zero or the cap
    // would slowly strangle a legitimate user on a long-lived warm instance.
    await Promise.all([drain(a), drain(b)]);
    expect(sseLiveCounts().total).toBe(0);
    expect(sseLiveCounts().byAccount).toEqual({});
  }, 20_000);

  it("the per-INSTANCE cap answers 503 (capacity), which is a different signal from the per-account 429", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const cfg: SseConfig = { heartbeatMs: 50, pollMs: 50, lifetimeMs: 300, maxPerAccount: 5, maxPerInstance: 1 };

    const a = await H(req("GET", "/events", { bearer: s.token }), deps, cfg);
    expect(a.status).toBe(200);
    const b = await H(req("GET", "/events", { bearer: s.token }), deps, cfg);
    expect(b.status).toBe(503);
    expect((await b.json()).error.code).toBe("sse_capacity");
    await drain(a);
  }, 20_000);
});

/**
 * A MINIMAL `Db` for the poll loop: `/events` only ever runs
 * `select({max, live}).from(change_log).where(...)`, so a stub with that one shape is enough — and
 * it keeps the instrumentation off the session path, which is a different query entirely. A row
 * answers `live: true` as production does for a live session; without it the stream ends.
 *
 * The session is preset on `deps` instead of being resolved from a token, so nothing but the poll
 * touches this fake.
 */
function pollDb(onPoll: () => Promise<Array<{ max: string | null; live?: boolean }>>): ApiDeps["db"] {
  return {
    select: () => ({ from: () => ({ where: () => onPoll() }) }),
  } as unknown as ApiDeps["db"];
}

const PRESET_SESSION: ApiDeps["session"] = {
  accountId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  sessionId: "33333333-3333-3333-3333-333333333333",
  lastTwofaAt: null,
  scope: "full",
  via: "bearer",
  // `GET /events` is `cost: "connection"`, so `withSpendGate` refuses an unproven address
  // on it. This session is FABRICATED, so it asserts nothing about how it was obtained and it
  // must not accidentally assert something about verification either: the subject here is the
  // poll loop. Omitting the field made every case in this file 403 — and the compiler did not
  // say so, because `ResolvedSession.emailVerifiedAt` is required and NO test file in this
  // repository is typechecked. The gate itself is proven in `spend-gate.test.ts`,
  // which drives this very route with an unverified session and asserts the 403.
  emailVerifiedAt: FIXED_NOW,
};

/** `app.handle` with a session already resolved (no token ⇒ `withSession` leaves it alone). */
const HS = (d: ApiDeps, sse: SseConfig): Promise<Response> =>
  app.handle(req("GET", "/events"), { ...d, session: PRESET_SESSION, idempotency: null, sse });

describe("the poll is one serialized, caught loop", () => {
  it("polls NEVER overlap, even when a poll takes longer than pollMs", async () => {
    // `setInterval` fires on schedule regardless of whether the previous poll finished, so a
    // pooler slower than `pollMs` multiplied one account's query rate exactly when the database
    // was already struggling. This measures the invariant directly: never two in flight.
    const { deps } = await makeDeps();
    let inFlight = 0;
    let maxInFlight = 0;
    let polls = 0;
    const db = pollDb(async () => {
      polls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 45));      // 3× pollMs: `setInterval` would overlap
        return [{ max: null, live: true }];
      } finally {
        inFlight--;
      }
    });

    const res = await HS({ ...deps, db }, { heartbeatMs: 1000, pollMs: 15, lifetimeMs: 400 });
    await drain(res);
    expect(polls).toBeGreaterThan(1);            // it really did poll repeatedly
    expect(maxInFlight).toBe(1);                 // and never twice at once
  }, 20_000);

  it("a FAILING poll closes the stream with sync_failed instead of becoming an unhandled rejection", async () => {
    const { deps } = await makeDeps();
    let calls = 0;
    const db = pollDb(async () => {
      calls++;
      if (calls > 1) throw new Error("connection terminated unexpectedly");
      return [{ max: null, live: true }];
    });

    const res = await HS({ ...deps, db }, { heartbeatMs: 1000, pollMs: 10, lifetimeMs: 5_000 });
    const text = await drain(res);               // returns EARLY: the failure closed the stream
    expect(text).toContain("event: sync_failed");
    expect(sseLiveCounts().total).toBe(0);       // and released its slot
  }, 20_000);

  it("a stream whose FIRST read fails still closes cleanly and releases its slot", async () => {
    const { deps } = await makeDeps();
    const db = pollDb(async () => { throw new Error("no connection"); });
    const res = await HS({ ...deps, db }, TINY);
    expect(res.status).toBe(200);                // the stream opened before the DB was touched
    expect(await drain(res)).toContain("event: sync_failed");
    expect(sseLiveCounts().total).toBe(0);
  }, 20_000);
});
