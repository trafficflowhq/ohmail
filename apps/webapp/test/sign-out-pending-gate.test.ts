/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSurface } from "../app/session-gate.js";

process.env.NEXT_PUBLIC_API_BASE = "/api";

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

const HERE = `${process.cwd()}/apps/webapp/test/`;
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

  it("a sign-in ended seconds ago (tf_signed_out): an empty jar goes to the sign-in page, a live one to the app", async () => {
    const live = (async () => json({ user: { userId: "u-1", accountId: "a-1" }, scope: "full" })) as unknown as typeof fetch;
    const gate = (sessionToken: string | null, apiOrigin: string | null, fetchImpl = noNetwork) =>
      resolveSurface({ sessionToken, signedOutJustNow: true, search: "", apiOrigin, fetchImpl });
    await expect(gate(null, API)).resolves.toBe("door");
    await expect(gate("not a token", API)).resolves.toBe("door");
    await expect(gate(TOKEN, API, live), "a new sign-in since").resolves.toBe("app");
    await expect(gate(null, null), "no API armed").resolves.toBe("marketing");
  });

  it("the middleware reads the marker the client writes and hands it to the gate", () => {
    const mw = readFileSync(`${HERE}../middleware.ts`, "utf8");
    expect(mw, "the gate is never told about the pending sign-out")
      .toMatch(/const signOutPending = cookieFromStore\(request\.cookies, OWNER_COOKIE\) === OWNER_SIGNED_OUT;/);
    expect(mw).toMatch(/resolveSurface\(\{[\s\S]*?signOutPending,[\s\S]*?\}\)/);
  });

  it("…and answers `sign-out` with a 307 to the sign-in page, private and no-store, on both builds", () => {
    const mw = readFileSync(`${HERE}../middleware.ts`, "utf8");
    const at = mw.indexOf('if (surface === "sign-out" || surface === "door") {');
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
  vi.useRealTimers();
  Reflect.deleteProperty(document, "cookie");
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

/** The word as the edge re-sets it: a server cookie, host-only, never HttpOnly, ninety days. */
const HELD = "tf_owner=signed_out_pending; Path=/; Max-Age=7776000; SameSite=Strict; Secure";
const ownerLines = (res: Response): string[] => res.headers.getSetCookie().filter((l) => l.startsWith("tf_owner="));

describe("the front door sends a pending sign-out to the sign-in page", () => {
  for (const [build, env] of [["managed", MANAGED], ["self-host", SELF_HOST]] as const) {
    for (const [jar, cookie] of [
      ["an access cookie", `tf_session=${ISSUED}; tf_resume=1; tf_owner=signed_out_pending`],
      ["a lapsed access cookie", "tf_resume=1; tf_owner=signed_out_pending"],
    ] as const) {
      it(`${build}, ${jar}: 307 to /login, the query dropped, private and no-store, nothing fetched, the word re-set`, async () => {
        const { res, asked } = await front(env, cookie);
        expect(res.status, "the pending sign-out was not redirected").toBe(307);
        expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/login");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("x-middleware-rewrite"), "the splash was served").toBeNull();
        expect(asked, "the front door asked the API about a browser that asked to sign out").toEqual([]);
        expect(res.headers.getSetCookie(), "the word stays a script cookie, which Safari forgets in seven days").toEqual([HELD]);
      });
    }
  }

  it("/login re-sets the word beside a session cookie, and not without one, nor over an account's marker", async () => {
    expect(ownerLines((await front(MANAGED, "tf_resume=1; tf_owner=signed_out_pending", "/login")).res)).toEqual([HELD]);
    expect(ownerLines((await front(MANAGED, "tf_owner=signed_out_pending", "/login")).res)).toEqual([]);
    expect(ownerLines((await front(MANAGED, "tf_resume=1; tf_owner=acct_A", "/login")).res)).toEqual([]);
  });

  const DAY = 86_400_000;
  /**
   * Safari keeps a cookie page script writes for seven days at most; one a server sets is not capped. Page script
   * (`document.cookie`, bound by {@link bindDocumentCookie}) neither sees nor writes an HttpOnly cookie.
   */
  function cappedJar() {
    const kept = new Map<string, { value: string; until: number; httpOnly: boolean }>();
    const write = (line: string, now: number, by: "script" | "server"): void => {
      const [pair = "", ...attrs] = line.split(";").map((a) => a.trim());
      const name = pair.slice(0, pair.indexOf("="));
      if (by === "script" && kept.get(name)?.httpOnly) return;
      const age = attrs.find((a) => /^max-age=/i.test(a));
      const ms = age === undefined ? Infinity : Number(age.slice("max-age=".length)) * 1000;
      const httpOnly = attrs.some((a) => /^httponly$/i.test(a));
      if (ms <= 0) kept.delete(name);
      else kept.set(name, { value: pair.slice(name.length + 1), until: now + (by === "script" ? Math.min(ms, 7 * DAY) : ms), httpOnly });
    };
    const header = (now: number, by: "script" | "server" = "server"): string =>
      [...kept].filter(([, c]) => c.until > now && (by === "server" || !c.httpOnly)).map(([n, c]) => `${n}=${c.value}`).join("; ");
    return { write, header };
  }
  /** The page's `document.cookie`, over `jar` at `at()`. */
  const bindDocumentCookie = (jar: ReturnType<typeof cappedJar>, at: () => number): void => {
    Object.defineProperty(document, "cookie", {
      configurable: true, get: () => jar.header(at(), "script"), set: (line: string) => jar.write(line, at(), "script"),
    });
  };
  /** Every request answered as a sign-out door that is down. */
  const doorDown = (): void => {
    vi.stubGlobal("fetch", (async () =>
      json({ error: { code: "db_busy", message: "busy", retryable: false } }, 503)) as unknown as typeof fetch);
  };

  it("a sign-out refused at the press and again at the sign-in page: eight days on, the next visit still goes to the sign-in page", async () => {
    const jar = cappedJar();
    let now = Date.parse("2026-11-03T10:00:00Z");
    jar.write(`tf_session=${ISSUED}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=900`, now, "server");
    jar.write("tf_resume=1; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=7776000", now, "server");
    jar.write("tf_owner=acct_A; SameSite=Strict; Secure; Path=/; Max-Age=7776000", now, "server");
    bindDocumentCookie(jar, () => now);
    // The press, its door refused: the word, written by script.
    doorDown();
    await (await import("../app/sign-out.js")).signOut("acct_A");
    // The press's own navigation to `/`, and the 307 to the sign-in page: each answer's Set-Cookie a server write.
    for (const path of ["/", "/login"]) {
      for (const line of (await front(MANAGED, jar.header(now), path)).res.headers.getSetCookie()) jar.write(line, now, "server");
    }
    // The sign-in page's finisher, the door still down: its whole ladder, each refusal's local half again.
    doorDown();
    await import("../app/sign-out.js"); // the finisher's own import: a module never loads on the pinned clock
    const { finishPendingSignOut } = await import("../app/(product)/login/finish-sign-out.js");
    vi.useFakeTimers();
    let ended = false;
    const ladder = finishPendingSignOut({ isCancelled: () => false }).finally(() => { ended = true; });
    for (let i = 0; i < 200 && !ended; i += 1) await vi.advanceTimersByTimeAsync(250);
    expect((await ladder).outcome).toBe("refused");
    vi.useRealTimers();
    now += 8 * DAY;
    const { res } = await front(MANAGED, jar.header(now), "/");
    const to = res.headers.get("location") ?? res.headers.get("x-middleware-rewrite") ?? "https://ohmail.app/";
    expect({ status: res.status, to: new URL(to).pathname }, "the next visit resumed the session the person signed out of")
      .toEqual({ status: 307, to: "/login" });
  });

  it("THE CONTROL — the same jar naming an account is the splash: a rewrite, never a redirect", async () => {
    const { res, asked } = await front(MANAGED, "tf_resume=1; tf_owner=acct_A", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/resume");
    expect(asked).toEqual([]);
    expect(ownerLines(res), "the edge wrote over an account's marker").toEqual([]);
  });

  it("THE CONTROL — the marker alone, nothing left to finish: the landing, never the sign-in page", async () => {
    const { res } = await front(MANAGED, "tf_owner=signed_out_pending", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.getSetCookie(), "a cacheable landing carried a cookie").toEqual([]);
    expect((await front(MANAGED, "", "/")).res.headers.getSetCookie(), "an anonymous visit was given a cookie").toEqual([]);
  });
});
