/** @vitest-environment jsdom */
/**
 * A PAGE THAT NEVER BINDS THE CLIENT SENDS NO ACCOUNT REQUEST UNDER A PENDING SIGN-OUT. The sign-in page, the
 * sign-up wizard, the address confirmation and the other credential pages leave the Cloud client `public`,
 * which used to let every request go: over a jar whose sign-out the server never confirmed
 * (`tf_owner=signed_out_pending` beside the previous person's cookies) `/join` read that person's session,
 * their mailboxes and their access, and generated their recovery codes. Now a public client refuses every
 * path but the ones a browser with no account may ask (the sign-out door, sign-in, registration, the address
 * confirmation, the sign-in's second factor, `/hello`) and the front door's own ceremony, with the sign-out's
 * refusal, before anything leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const PENDING = "signed_out_pending";
let asked: string[] = [];
let originalFetch: typeof globalThis.fetch;

/** The account the jar's session belongs to, read or acted on: what the wizard asked for, and more. */
const ACCOUNT_REQUESTS: Array<[string, "GET" | "POST"]> = [
  ["/auth/session", "GET"],
  ["/mailboxes", "GET"],
  ["/account/access", "GET"],
  ["/account/manage-link", "POST"],
  ["/account/checkout/confirm", "POST"],
  ["/auth/2fa/recovery-codes", "POST"],
  ["/auth/2fa/webauthn/register/options", "POST"],
  ["/auth/verify-email/resend", "POST"],
];

/** What a browser with no account of its own may ask: these finish the sign-out or begin a new identity. */
const OWNER_FREE = [
  "/auth/refresh/logout", "/auth/login", "/auth/register", "/auth/verify-email", "/auth/2fa/totp/verify",
  "/auth/2fa/recovery-codes/verify", "/auth/2fa/webauthn/assert/options", "/auth/2fa/webauthn/assert/verify",
  "/hello",
];

beforeEach(() => {
  vi.resetModules();
  asked = [];
  originalFetch = globalThis.fetch;
  // A server that answers everything: a request reaching it is one the client LET THROUGH.
  globalThis.fetch = vi.fn(async (input: unknown) => {
    asked.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("a public client under a pending sign-out", () => {
  it("refuses every account request before the wire, with the sign-out's own refusal", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const { api, apiOwnerBinding } = await import("../app/api-client.js");
    expect(apiOwnerBinding().kind, "the precondition: a page that never bound the client").toBe("public");
    for (const [path, method] of ACCOUNT_REQUESTS) {
      const err = await api(path, { method, ...(method === "POST" ? { body: {} } : {}) })
        .then(() => null, (e: unknown) => e as { code?: string });
      expect(err?.code, `${method} ${path} went out under a pending sign-out`).toBe("owner_signed_out");
    }
    expect(asked, "a request reached the server").toEqual([]);
  });

  it("still lets out what finishes the sign-out or begins a new identity, and the front door's ceremony", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const { api, apiOwnerVerdict } = await import("../app/api-client.js");
    for (const path of OWNER_FREE) expect(apiOwnerVerdict(path), path).toBe("holds");
    expect(apiOwnerVerdict("/auth/session", { ceremony: true })).toBe("holds");
    await api("/auth/register", { method: "POST", body: {} });
    await api("/auth/session", { ceremony: true });
    expect(asked.map((u) => new URL(u, "http://localhost").pathname)).toEqual(["/api/auth/register", "/api/auth/session"]);
  });
});

describe("THE CONTROL — a public client with no pending sign-out lets every request go, as before", () => {
  for (const [jar, cookie] of [["no marker", null], ["a marker naming an account", "tf_owner=acct_A"]] as const) {
    it(jar, async () => {
      if (cookie !== null) document.cookie = `${cookie}; Path=/`;
      const { api, apiOwnerVerdict } = await import("../app/api-client.js");
      for (const [path, method] of ACCOUNT_REQUESTS) {
        expect(apiOwnerVerdict(path), path).toBe("holds");
        await api(path, { method, ...(method === "POST" ? { body: {} } : {}) });
      }
      expect(asked).toHaveLength(ACCOUNT_REQUESTS.length);
    });
  }

  it("a client that IS bound keeps its own reading of the marker (signed-out), unchanged", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const { apiOwnerVerdict, bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner("acct_A");
    expect(apiOwnerVerdict("/mailboxes")).toBe("signed-out");
    expect(apiOwnerVerdict("/auth/refresh/logout")).toBe("holds");
    bindApiOwner(null);
  });
});
