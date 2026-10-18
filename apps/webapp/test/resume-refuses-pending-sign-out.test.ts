/** @vitest-environment jsdom */
/**
 * A SIGN-OUT THE SERVER NEVER CONFIRMED IS NEVER RESUMED. `tf_owner=signed_out_pending` beside a refresh
 * cookie names a family the person asked to end: it is finished at the sign-out door, never rotated.
 * `resumeSession` is the one refresh every caller goes through (`api()`'s recovery on a 401, the renewal,
 * the splash, the late-answer repair, a page that never binds the client), so it reads the marker itself,
 * inside the cross-tab lock, before any caller's own question. Measured before: `/join` opened from another
 * site over such a jar refreshed the family and read the previous person's account with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const PENDING = "signed_out_pending";
let asked: string[] = [];
let originalFetch: typeof globalThis.fetch;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refreshes = (): number => asked.filter((u) => u.endsWith("/auth/refresh")).length;

/** A minimal Web Locks manager: exclusive, FIFO. */
function installLocks(): void {
  const queues = new Map<string, Array<() => void>>();
  const busy = new Set<string>();
  const request = async (name: string, _opts: object, fn: () => Promise<unknown>): Promise<unknown> => {
    if (busy.has(name)) {
      await new Promise<void>((resolve) => {
        const queue = queues.get(name) ?? [];
        queue.push(resolve);
        queues.set(name, queue);
      });
    }
    busy.add(name);
    try {
      return await fn();
    } finally {
      busy.delete(name);
      (queues.get(name) ?? []).shift()?.();
    }
  };
  Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
}

beforeEach(() => {
  vi.resetModules();
  asked = [];
  localStorage.clear();
  sessionStorage.clear();
  originalFetch = globalThis.fetch;
  // A refresh door that would mint, and an API that answers every other ask 401: a resume here is
  // a rotation of the jar's family, and nothing else stops it.
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith("/auth/refresh")) return new Response(null, { status: 204 });
    return json({ error: { code: "unauthorized", message: "no session" } }, 401);
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis.navigator, "locks");
  vi.restoreAllMocks();
});

describe("a pending sign-out is finished at the door, never rotated", () => {
  it("resumeSession presents nothing and answers refused", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const { resumeSession } = await import("../app/session-refresh.js");
    expect(await resumeSession(), "the family the person ended was rotated").toBe("refused");
    expect(refreshes()).toBe(0);
  });

  it("…whatever the caller's own question answers", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const { resumeSession } = await import("../app/session-refresh.js");
    expect(await resumeSession({ mayProceed: () => true })).toBe("refused");
    expect(refreshes()).toBe(0);
  });

  it("read inside the lock: a sign-out that went unconfirmed while this queued for it is not resumed", async () => {
    installLocks();
    document.cookie = "tf_owner=acct_A; Path=/";
    const { resumeSession } = await import("../app/session-refresh.js");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locks = (navigator as unknown as { locks: { request: (n: string, o: object, f: () => Promise<void>) => Promise<unknown> } }).locks;
    void locks.request("ohmail:session-refresh", {}, () => held);
    const answer = resumeSession();
    // Another tab's sign-out went unconfirmed while this one waited for the lock.
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    release();
    expect(await answer, "the marker was read before the lock, not when the request would leave").toBe("refused");
    expect(refreshes()).toBe(0);
  });

  it("api()'s recovery on a path any client may ask (`/health`) does not resume it", async () => {
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    const { api } = await import("../app/api-client.js");
    await expect(api("/health")).rejects.toMatchObject({ status: 401 });
    expect(asked.filter((u) => u.endsWith("/health"))).toHaveLength(1);
    expect(refreshes(), "a 401 on a public read resumed a pending sign-out").toBe(0);
  });
});

describe("THE CONTROL — any other jar is resumed as before", () => {
  it("a marker naming an account: the refresh is asked", async () => {
    document.cookie = "tf_owner=acct_A; Path=/";
    const { resumeSession } = await import("../app/session-refresh.js");
    expect(await resumeSession()).toBe("resumed");
    expect(refreshes()).toBe(1);
  });

  it("no marker at all: the refresh is asked", async () => {
    const { resumeSession } = await import("../app/session-refresh.js");
    expect(await resumeSession()).toBe("resumed");
    expect(refreshes()).toBe(1);
  });

  it("api()'s recovery under a marker naming an account renews, then asks again", async () => {
    document.cookie = "tf_owner=acct_A; Path=/";
    const { api } = await import("../app/api-client.js");
    await expect(api("/health")).rejects.toMatchObject({ status: 401 });
    expect(refreshes()).toBe(1);
    expect(asked.filter((u) => u.endsWith("/health"))).toHaveLength(2);
  });
});
