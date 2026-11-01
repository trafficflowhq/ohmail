/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A WRONG STEP-UP CODE IS SENT ONCE (STEP-UP-WRONG-CODE-IS-SENT-TWICE). The server names a wrong code
 * `credential_refused`, which the web reads before it refreshes. The step-up cases here are the
 * OLD-SERVER BELT CONTROL: a server older than that code refuses with 401 `unauthorized`, the answer
 * a lapsed session gets, and only `NEVER_REFRESH` stops the client refreshing and sending the code
 * again. Driven through the real `api()` and the engine's door with only `fetch` stubbed; requests
 * are counted, never timed.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";

interface Seen { method: string; url: string }
let seen: Seen[];
let originalFetch: typeof globalThis.fetch;
let mailboxAsks: number;

const coded401 = (message: string, code = "unauthorized"): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status: 401, headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  seen = [];
  mailboxAsks = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ method: init?.method ?? "GET", url });
    if (url.endsWith("/auth/refresh")) return new Response(null, { status: 204 });
    if (url.includes("/auth/step-up/")) return coded401("two-factor verification failed");
    if (url.includes("/auth/confirm-by-code")) return coded401("two-factor verification failed", "credential_refused");
    if (url.endsWith("/mailboxes")) {
      mailboxAsks += 1;
      if (mailboxAsks === 1) return coded401("authentication required");
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const truth = await import("../app/shell/session-truth.js");
  truth.resetSessionTruthForTests();
});

const posts = (path: string): number => seen.filter((s) => s.method === "POST" && s.url.endsWith(path)).length;
const refreshes = (): number => seen.filter((s) => s.url.endsWith("/auth/refresh")).length;

describe("a refused second factor is an answer, not a lapsed session", () => {
  it("a wrong TOTP step-up code is posted once and starts no refresh", async () => {
    const { auth, ApiError } = await import("../app/api-client.js");
    const err = await auth.stepUpTotp({ code: "000000" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
    expect(posts("/api/auth/step-up/totp"), "the code was sent again after a refresh").toBe(1);
    expect(refreshes(), "a wrong code rotated the session").toBe(0);
  });

  it("a refused passkey assertion is posted once and starts no refresh", async () => {
    const { auth, ApiError } = await import("../app/api-client.js");
    const err = await auth.stepUpWebauthnVerify({ credential: { id: "cred" } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(posts("/api/auth/step-up/webauthn/verify"), "the assertion was sent again after a refresh").toBe(1);
    expect(refreshes()).toBe(0);
  });

  it("a refused recovery code is posted once and starts no refresh", async () => {
    const { auth, ApiError } = await import("../app/api-client.js");
    const err = await auth.stepUpRecoveryCode({ code: "abcd-efgh-ijkl" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(posts("/api/auth/step-up/recovery-code"), "the code was sent again after a refresh").toBe(1);
    expect(refreshes()).toBe(0);
  });

  it("the engine's door, which reads the same rule, sends a factor once too", async () => {
    await import("../app/api-client.js");
    const { sessionFetch } = await import("../app/shell/session-truth.js");
    const res = await sessionFetch("/api/auth/step-up/totp", { method: "POST", body: JSON.stringify({ code: "000000" }) });
    expect(res.status).toBe(401);
    expect(posts("/api/auth/step-up/totp")).toBe(1);
    expect(refreshes()).toBe(0);
  });

  it("THE CODE IS READ FIRST: credential_refused on a route NEVER_REFRESH does not name is sent once, by api() and the engine's door", async () => {
    const { api, ApiError } = await import("../app/api-client.js");
    const err = await api("/auth/confirm-by-code", { method: "POST", body: { code: "000000" } }).then(() => null, (e: unknown) => e);
    expect((err as InstanceType<typeof ApiError>).code).toBe("credential_refused");
    const { sessionFetch } = await import("../app/shell/session-truth.js");
    const res = await sessionFetch("/api/auth/confirm-by-code", { method: "POST", body: JSON.stringify({ code: "000000" }) });
    expect(res.status).toBe(401);
    expect(posts("/api/auth/confirm-by-code"), "a credential verdict was sent again after a refresh").toBe(2);
    expect(refreshes(), "a credential verdict rotated the session").toBe(0);
  });

  it("POSITIVE CONTROL: a lapsed session on an ordinary route still refreshes once and retries once", async () => {
    const { api } = await import("../app/api-client.js");
    await expect(api("/mailboxes")).resolves.toEqual({ items: [] });
    expect(mailboxAsks, "the ordinary route was not retried after its refresh").toBe(2);
    expect(refreshes(), "the ordinary route's 401 did not refresh").toBe(1);
  });
});
