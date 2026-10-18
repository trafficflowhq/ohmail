import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSurface } from "../app/session-gate.js";

/**
 * A BROWSER THAT ASKED TO SIGN OUT IS FINISHED, NEVER SERVED THE APP AND NEVER RESUMED. A sign-out
 * whose server half went unconfirmed leaves `tf_owner=signed_out_pending` beside the session. The
 * gate read only the session cookies, so a live access cookie got the app (every request refused,
 * "this browser now holds another account's session") and a lapsed one got the resume splash,
 * which reloaded itself without end. Measured on ohmail.app. With the marker the gate answers
 * `sign-out`, which the edge turns into a redirect to the sign-in page: the sign-in screen paints at
 * once and finishes the sign-out at the door behind its form. The splash finished it behind a blank
 * page for as long as the door took (measured: 10 s for a door that held its first ask). It costs
 * no probe.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API = "https://api.ohmail.app";
const TOKEN = "tf_access_token_value";

/** A `fetch` that must never be called. */
const noNetwork: typeof fetch = (() => {
  throw new Error("network request made where the design promises none");
}) as unknown as typeof fetch;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the gate and the pending sign-out", () => {
  it("a LIVE access cookie with the marker: the sign-in page, and no probe", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("sign-out");
  });

  it("the stuck jar — the access cookie lapsed: the sign-in page", async () => {
    await expect(resolveSurface({
      sessionToken: null, resumeMarker: true, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("sign-out");
  });

  it("a throttled token-holder with the marker: still the sign-in page, never the app", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, throttled: true, search: "", apiOrigin: API,
      fetchImpl: noNetwork,
    })).resolves.toBe("sign-out");
  });

  it("an access cookie without the resume marker, with the pending marker: the sign-in page", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: false, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("sign-out");
  });

  it("the marker and nothing else in the jar: the landing — there is nothing left to finish", async () => {
    await expect(resolveSurface({
      sessionToken: null, resumeMarker: false, signOutPending: true, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("marketing");
  });

  it("no API armed: the landing, as for every cookie on such a deployment", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, search: "", apiOrigin: null, fetchImpl: noNetwork,
    })).resolves.toBe("marketing");
  });

  it("the demo still wins over the marker", async () => {
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: true, search: "demo=1", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("demo");
  });

  it("THE CONTROL — without the marker a live token is probed and served the app", async () => {
    let calls = 0;
    const live = (async () => {
      calls += 1;
      return json({ user: { userId: "u-1", accountId: "a-1" }, scope: "full" });
    }) as unknown as typeof fetch;
    await expect(resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, signOutPending: false, search: "", apiOrigin: API, fetchImpl: live,
    })).resolves.toBe("app");
    expect(calls).toBe(1);
  });

  it("the middleware reads the marker the client writes and hands it to the gate", () => {
    const mw = readFileSync(`${HERE}../middleware.ts`, "utf8");
    expect(mw, "the gate is never told about the pending sign-out")
      .toMatch(/const signOutPending = cookieFromStore\(request\.cookies, OWNER_COOKIE\) === OWNER_SIGNED_OUT;/);
    expect(mw).toMatch(/resolveSurface\(\{[\s\S]*?signOutPending,[\s\S]*?\}\)/);
  });

  it("…and answers `sign-out` with a 307 to the sign-in page, private and no-store, on both builds", () => {
    const mw = readFileSync(`${HERE}../middleware.ts`, "utf8");
    const at = mw.indexOf('if (surface === "sign-out") {');
    expect(at, "no arm answers the pending sign-out").toBeGreaterThan(-1);
    const arm = mw.slice(at, mw.indexOf("\n  }\n", at));
    expect(arm).toMatch(/door\.pathname = DOOR_ROUTE;/);
    expect(arm).toMatch(/door\.search = "";/);
    expect(arm).toMatch(/NextResponse\.redirect\(door, 307\)/);
    expect(arm).toMatch(/response\.headers\.set\("Cache-Control", "private, no-store"\)/);
    expect(arm, "the arm is a self-host one").not.toMatch(/SELF_HOST_BUILD/);
  });
});

/* ── the real middleware, with the jar the stuck sign-out leaves ──────────────────────────── */

const KEYS = ["NEXT_PUBLIC_OHMAIL_FLAVOR", "OHMAIL_INTERNAL_API_ORIGIN", "TF_API_ORIGIN", "LANDING_ZONE_ORIGIN", "LANDING_ZONE_BYPASS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
/** Shaped like a token the API issues (43 base64url characters), so the gate takes it seriously. */
const ISSUED = "pending-gate-fixture-token-".padEnd(43, "x");

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  vi.unstubAllGlobals();
});

/** Evaluate the middleware under `env`, every key not named unset; `fetch` counted, never answered. */
async function front(env: Partial<Record<(typeof KEYS)[number], string>>, cookie: string, path = "/?from=mail") {
  for (const k of KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const asked: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    asked.push(String(input));
    return json({ error: { code: "unauthorized", message: "no" } }, 401);
  }) as unknown as typeof fetch);
  const { middleware } = await import("../middleware.js");
  const { NextRequest } = await import("next/server");
  const res = (await middleware(new NextRequest(new Request(`https://ohmail.app${path}`, { headers: { cookie } })))) as unknown as Response;
  return { res, asked };
}

const MANAGED = { TF_API_ORIGIN: API };
const SELF_HOST = { NEXT_PUBLIC_OHMAIL_FLAVOR: "selfhost", OHMAIL_INTERNAL_API_ORIGIN: "http://api:8080" };

describe("the front door sends a pending sign-out to the sign-in page", () => {
  for (const [build, env] of [["managed", MANAGED], ["self-host", SELF_HOST]] as const) {
    for (const [jar, cookie] of [
      ["an access cookie", `tf_session=${ISSUED}; tf_resume=1; tf_owner=signed_out_pending`],
      ["a lapsed access cookie", "tf_resume=1; tf_owner=signed_out_pending"],
    ] as const) {
      it(`${build}, ${jar}: 307 to /login, the query dropped, private and no-store, nothing fetched`, async () => {
        const { res, asked } = await front(env, cookie);
        expect(res.status, "the pending sign-out was not redirected").toBe(307);
        expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/login");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("x-middleware-rewrite"), "the splash was served").toBeNull();
        expect(asked, "the front door asked the API about a browser that asked to sign out").toEqual([]);
      });
    }
  }

  it("THE CONTROL — the same jar naming an account is the splash: a rewrite, never a redirect", async () => {
    const { res, asked } = await front(MANAGED, "tf_resume=1; tf_owner=acct_A", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/resume");
    expect(asked).toEqual([]);
  });

  it("THE CONTROL — the marker alone, nothing left to finish: the landing, never the sign-in page", async () => {
    const { res } = await front(MANAGED, "tf_owner=signed_out_pending", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
