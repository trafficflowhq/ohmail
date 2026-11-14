/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/* The client refuses every call on a build with no server behind it, so the base is set before
   the module is imported — the same line every api-client test in this directory carries. */
process.env.NEXT_PUBLIC_API_BASE = "/api";
const { account, forgetAccess } = await import("../app/api-client");
import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie";

/**
 * ═══ ONE ACCESS READ PER SESSION, NOT ONE PER MOUNT ═══════════════════════════════════════
 *
 * `GET /account/access` was asked by five surfaces on mount, and the credit check's logs read it
 * about every twenty seconds for a single signed-in account. The verdict is now held for the
 * session and keyed by the account marker, with `fresh` for the two readers that gate a refusal.
 *
 * MUTATION-PROVEN AT AUTHORING TIME (applied, watched red, restored, `cmp`-verified):
 *   · the hold dropped (`access: () => api(…)` as it was) — 3 of 5 red.
 *   · the account dropped from the key — 1 of 5 red, and it is the one that would have handed one
 *     account's entitlement to another.
 *   · the rejection held (`accessHeld` left in place on a throw) — 1 of 5 red.
 */

let calls: string[] = [];
let answer: () => Promise<unknown> = () =>
  Promise.resolve(new Response(JSON.stringify({ metered: false }), {
    status: 200, headers: { "content-type": "application/json" },
  }));
const originalFetch = globalThis.fetch;

const asOwner = (id: string): void => { document.cookie = `${OWNER_COOKIE}=${id}`; };

beforeEach(() => {
  calls = [];
  forgetAccess();
  asOwner("acct-one");
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return answer();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgetAccess();
  answer = () =>
    Promise.resolve(new Response(JSON.stringify({ metered: false }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
});

describe("the access verdict is read once for the session", () => {
  it("two mounts make one request", async () => {
    await account.access();
    await account.access();
    await account.access();
    expect(calls.filter((u) => u.includes("/account/access"))).toHaveLength(1);
  });

  it("readers that arrive together join one request rather than issuing two", async () => {
    const both = await Promise.all([account.access(), account.access()]);
    expect(calls.filter((u) => u.includes("/account/access"))).toHaveLength(1);
    expect(both[0]).toEqual(both[1]);
  });

  it("`fresh` re-asks — the gate reads that the entitlement is mutable from outside this tab", async () => {
    await account.access();
    // Past the door's join window: a fresh ask inside it is the answer in hand (api-client.ts).
    const { RETURN_DEBOUNCE_MS } = await import("@ohmail/app-logic/doors/wall-lift");
    const t = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t + RETURN_DEBOUNCE_MS);
    await account.access({ fresh: true });
    clock.mockRestore();
    expect(calls.filter((u) => u.includes("/account/access"))).toHaveLength(2);
    // …and the fresh answer becomes the held one, so the mount readers see the new verdict.
    await account.access();
    expect(calls.filter((u) => u.includes("/account/access"))).toHaveLength(2);
  });

  it("a different account is a different question", async () => {
    await account.access();
    asOwner("acct-two");
    await account.access();
    expect(calls.filter((u) => u.includes("/account/access"))).toHaveLength(2);
  });

  it("a refusal is not the session's answer", async () => {
    answer = () => Promise.resolve(new Response(JSON.stringify({ error: "nope" }), {
      status: 503, headers: { "content-type": "application/json" },
    }));
    await expect(account.access()).rejects.toBeTruthy();
    answer = () => Promise.resolve(new Response(JSON.stringify({ metered: false }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    await expect(account.access()).resolves.toEqual({ metered: false });
    expect(calls.filter((u) => u.includes("/account/access"))).toHaveLength(2);
  });
});
