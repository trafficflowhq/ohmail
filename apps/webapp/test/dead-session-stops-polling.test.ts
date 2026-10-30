/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══ THE BROWSER'S HALF ═════════════════════════════════════
 *
 * Production, one afternoon: a browser whose session had been confirmed dead asked `/mailboxes`,
 * `/screener` and `/consent` about twice a second for more than eight minutes — hundreds of refusals on
 * each route — and every one of those refusals started a `POST /auth/refresh` that was refused the
 * same way. No poller was broken. None of them had a bound, and none of them knew the one fact
 * that made all of them pointless.
 *
 * Three rules, driven here through the REAL `api()` and the REAL session-truth store with only
 * `fetch` stubbed, on a virtual clock:
 *
 *  1. with the death confirmed, `api()` answers itself and no byte leaves;
 *  2. the sign-in ceremony and the refresh are NOT gated — they are how the answer changes;
 *  3. the only thing still asking is the heal schedule, one attempt per widening step.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";

interface Seen {
  paths: string[];
}

let seen: Seen;
let originalFetch: typeof globalThis.fetch;
/**
 * Is the server serving this browser again? `false` is the outage: a coded 401 everywhere,
 * including the refresh, which is what confirms the death. `true` is the world after a sign-in.
 */
let served = false;
/** The refresh door answers 503 — a fault, never a verdict on the session. */
let refreshFault = false;

/** Every stubbed answer is the API's own coded 401 — a live server with a dead session. */
const coded401 = (): Response =>
  new Response(JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  seen = { paths: [] };
  served = false;
  refreshFault = false;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const purge = new Headers(init?.headers).has("x-ohmail-clear");
    const url = String(input) + (purge ? "#purge" : "");
    seen.paths.push(url);
    if (refreshFault && url.includes("/auth/refresh")) return new Response("busy", { status: 503 });
    // The refresh door's refusal clears the jar, as the server's clearSessionCookies() does.
    if (!served && url.endsWith("/auth/refresh")) {
      document.cookie = "tf_csrf=; max-age=0; path=/";
      document.cookie = "tf_owner=; max-age=0; path=/";
    }
    if (!served) return coded401();
    if (url.includes("/auth/refresh")) return new Response(null, { status: 204 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  document.cookie = "tf_csrf=; max-age=0; path=/";
  document.cookie = "tf_owner=; max-age=0; path=/";
  const truth = await import("../app/shell/session-truth.js");
  truth.resetSessionTruthForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The three routes the logs named, asked the way a poller asks them. */
const POLLED = ["/mailboxes", "/screener", "/consent"];

async function pollOnce(api: (p: string) => Promise<unknown>): Promise<void> {
  await Promise.all(POLLED.map((p) => api(p).catch(() => undefined)));
}

/** Only the three polled routes — the refresh is counted by its own assertions. */
const polledReads = (): string[] => seen.paths.filter((p) => POLLED.some((r) => p.endsWith(r)));
/** Refreshes that present the jar; a refusal's cache clear (`x-ohmail-clear`) is counted apart. */
const refreshes = (): string[] => seen.paths.filter((p) => p.endsWith("/auth/refresh"));

describe("a browser whose session is confirmed dead stops asking", () => {
  it("THE PRODUCTION SEQUENCE: one tick confirms the death, and no tick after it asks", async () => {
    const { api } = await import("../app/api-client.js");
    const truth = await import("../app/shell/session-truth.js");

    // Tick one is the honest one: nothing is confirmed yet — a single 401 is evidence, never
    // confirmation — so all three ask, each recovers through `POST /auth/refresh`, and the
    // refresh's own coded 401 is what settles it.
    await pollOnce(api);
    expect(polledReads().length).toBe(3);
    expect(seen.paths.some((p) => p.includes("/auth/refresh"))).toBe(true);
    expect(truth.sessionIsDead(), "the refresh's coded 401 did not confirm the death").toBe(true);

    // Everything after it is the eight minutes that were measured. None of it happens now.
    seen.paths = [];
    for (let i = 0; i < 100; i++) await pollOnce(api);
    expect(seen.paths, "the storm: 300 requests under a session already known to be over").toEqual([]);
  });

  it("THE GATE: with the death confirmed, not one of the three reaches the wire", async () => {
    const { api } = await import("../app/api-client.js");
    const { markSessionDead } = await import("../app/shell/session-truth.js");

    markSessionDead();
    seen.paths = [];

    for (let i = 0; i < 20; i++) await pollOnce(api);
    expect(seen.paths, "a confirmed dead session still reached the server").toEqual([]);
  });

  it("the refusal a caller sees is a 401 in ohmail's own words, so no surface re-classifies", async () => {
    const { api, ApiError, SESSION_ENDED_REFUSAL_CODE } = await import("../app/api-client.js");
    const { markSessionDead } = await import("../app/shell/session-truth.js");
    markSessionDead();

    const err = await api("/mailboxes").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
    expect((err as InstanceType<typeof ApiError>).code).toBe(SESSION_ENDED_REFUSAL_CODE);
  });

  it("THE WAY BACK stays open: the sign-in ceremony and the refresh are never gated", async () => {
    const { api } = await import("../app/api-client.js");
    const { markSessionDead } = await import("../app/shell/session-truth.js");
    markSessionDead();
    seen.paths = [];

    // Every path `apiOwnerVerdict` already exempts — the same census, so neither can drift alone.
    for (const path of ["/hello", "/auth/login", "/auth/refresh", "/auth/2fa/totp/verify"]) {
      await api(path, { method: "POST", body: {} }).catch(() => undefined);
    }
    await api("/auth/session", { ceremony: true }).catch(() => undefined);

    // Every one reached the wire. (The count is the paths asked for, never `seen.paths.length`:
    // `/auth/session` recovers through a refresh, which is a request this case did not make.)
    for (const path of ["/hello", "/auth/login", "/auth/refresh", "/auth/2fa/totp/verify", "/auth/session"]) {
      expect(seen.paths.some((p) => p.endsWith(path)), `${path} was gated shut`).toBe(true);
    }
  });

  it("THE HEAL: the only thing still asking is the schedule, and it asks once per step", async () => {
    vi.useFakeTimers();
    const truth = await import("../app/shell/session-truth.js");
    const { api } = await import("../app/api-client.js");

    const probe = vi.fn();
    truth.registerSessionProbe(probe);
    truth.markSessionDead();

    // Every surface holding auth-shaped evidence calls this. Under a confirmed death that is all
    // of them, and answering each with a refresh is the storm wearing another name.
    for (let i = 0; i < 50; i++) truth.probeSessionNow();
    await pollOnce(api).catch(() => undefined);
    expect(probe, "a surface's probe started a refresh under a confirmed death").toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);

    // A whole minute of a live outage: two attempts, against the storm of attempts measured.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(truth.sessionHealAttempts()).toBe(2);
  });

  it("THE REVIVAL: a real 204 stops the schedule and reopens every door", async () => {
    vi.useFakeTimers();
    const truth = await import("../app/shell/session-truth.js");
    const { api } = await import("../app/api-client.js");

    const probe = vi.fn();
    truth.registerSessionProbe(probe);
    truth.markSessionDead();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(1);

    // Exactly what `resumeSession` publishes on a 204 — and what a sign-in in another tab
    // eventually produces here too.
    const revived: number[] = [];
    truth.subscribeSessionRevival(() => revived.push(1));
    truth.markSessionAlive();

    expect(truth.sessionIsDead()).toBe(false);
    expect(revived.length, "the open surfaces were not told to ask again").toBe(1);

    // The server is serving this browser again, so the polled reads go out and come back.
    served = true;
    seen.paths = [];
    await pollOnce(api);
    expect(polledReads().length, "the doors stayed shut after a session was minted").toBe(3);

    // And nothing is left ticking: the schedule belongs to the death it was armed for.
    expect(truth.sessionHealAttempts()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(truth.sessionHealAttempts(), "the heal kept asking for a session this tab already holds").toBe(0);
  });

  it("A CODED REFUSAL ENDS THE KNOCKING until a sign-in moves the jar (one refresh every 5 min, measured)", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { api } = await import("../app/api-client.js");
    const truth = await import("../app/shell/session-truth.js");
    await pollOnce(api);
    expect(truth.sessionIsDead()).toBe(true);

    seen.paths = [];
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refreshes(), "a signed-out tab kept knocking on the refresh door").toEqual([]);

    // A sign-in in another tab of this browser mints a fresh jar: the next step asks, and heals.
    document.cookie = "tf_csrf=fresh-session; path=/";
    served = true;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refreshes().length).toBe(1);
    expect(truth.sessionIsDead()).toBe(false);
  });

  it("a sign-in elsewhere revives the tab even after its tf_csrf lapsed (tf_owner outlives it)", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { api } = await import("../app/api-client.js");
    const truth = await import("../app/shell/session-truth.js");
    document.cookie = "tf_csrf=old-session; path=/";
    document.cookie = "tf_owner=acct-1; path=/";
    await pollOnce(api);
    expect(truth.sessionIsDead()).toBe(true);

    // Signed in in another tab; this tab's heal sleeps past the 15-minute tf_csrf.
    document.cookie = "tf_csrf=fresh-session; path=/";
    document.cookie = "tf_owner=acct-1; path=/";
    document.cookie = "tf_csrf=; max-age=0; path=/";
    served = true;
    seen.paths = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshes().length, "the live sign-in's jar was read as the refused one").toBe(1);
    expect(truth.sessionIsDead()).toBe(false);
  });

  it("a fault after the jar moved keeps retrying; a second refusal stops it again", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { api } = await import("../app/api-client.js");
    const truth = await import("../app/shell/session-truth.js");
    await pollOnce(api);
    document.cookie = "tf_csrf=fresh-session; path=/";
    refreshFault = true;
    seen.paths = [];
    await vi.advanceTimersByTimeAsync(5_000 + 30_000 + 120_000);
    expect(refreshes().length, "a busy door is not a verdict: every step asks").toBe(3);

    // The door answers again, and refuses this jar too: nothing more leaves.
    refreshFault = false;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refreshes().length).toBe(4);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refreshes().length).toBe(4);
    expect(truth.sessionIsDead()).toBe(true);
  });
});
