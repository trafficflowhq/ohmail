/** @vitest-environment jsdom */
/**
 * SIGN OUT ALWAYS ENDS. Two waits on the press had no end: the sign-out door queued behind a
 * renewal holding the refresh lock and then gave up without asking the server (measured on
 * ohmail.app: 15 s, then "another tab is finishing a sign-in or sign-out" over this tab's own
 * renewal, the session left live), and once granted it awaited a request with no deadline. Both
 * end now: the door is asked even behind a held lock, and an unanswered request is given up at
 * its deadline with the local half done and the server half named as unconfirmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

/** A minimal Web Locks manager: exclusive, FIFO, and honours an abort of the WAIT. */
function installLocks(): void {
  const queues = new Map<string, Array<() => void>>();
  const busy = new Set<string>();
  const request = async (
    name: string, opts: { mode?: string; signal?: AbortSignal }, fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    if (busy.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => resolve();
        const queue = queues.get(name) ?? [];
        queue.push(waiter);
        queues.set(name, queue);
        opts.signal?.addEventListener("abort", () => {
          const q = queues.get(name) ?? [];
          const at = q.indexOf(waiter);
          if (at >= 0) q.splice(at, 1);
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
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

/** A request the network never answers; only an abort of its own signal ends it. */
const never = (init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
});

let asked: string[] = [];
let priorFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  installLocks();
  asked = [];
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=csrf-a; Path=/";
  priorFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = priorFetch;
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.restoreAllMocks();
  vi.resetModules();
});

const settled = <T>(p: Promise<T>): { value: T | undefined; done: boolean } => {
  const box: { value: T | undefined; done: boolean } = { value: undefined, done: false };
  void p.then((v) => { box.value = v; box.done = true; });
  return box;
};

describe("the pending marker lives until the next visit finishes the sign-out", () => {
  it("it is written with the refresh family's lifetime, not as a session cookie", async () => {
    // A session cookie was forgotten at a browser restart while the refresh token lived on, and
    // the next person to open ohmail.app was resumed into the session somebody had signed out of.
    const { markSignedOutPending } = await import("../app/shell/owner-cookie.js");
    let written = "";
    markSignedOutPending((c) => { written = c; });
    expect(written).toMatch(/^tf_owner=signed_out_pending; /);
    expect(written, "the marker dies with the browser session").toMatch(/; Max-Age=7776000;/);
    expect(written).toMatch(/; Path=\//);
  });
});

describe("sign out ends, and asks the server even behind a renewal", () => {
  it("a renewal holding the refresh lock: the sign-out door is still asked and confirms", async () => {
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/auth/refresh")) return never(init);
      if (url.endsWith("/auth/refresh/logout")) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const { resumeSession } = await import("../app/session-refresh.js");
    void resumeSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.filter((u) => u.endsWith("/auth/refresh")), "the renewal never took the lock").toHaveLength(1);

    const { signOut } = await import("../app/sign-out.js");
    const out = settled(signOut("acct_A"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked, "the sign-out gave up behind the renewal without asking the server")
      .toContain("/auth/refresh/logout");
    expect(out.done, "the press never ended").toBe(true);
    expect(out.value?.serverRefused, "a confirmed sign-out was reported as refused").toBeNull();
  });

  it("a sign-out door that never answers: the press ends at its deadline, the local half done", async () => {
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/auth/refresh/logout")) return never(init);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const { signOut } = await import("../app/sign-out.js");
    const out = settled(signOut("acct_A"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toContain("/auth/refresh/logout");
    expect(out.done, "Signing out… for ever: the request had no deadline").toBe(true);
    expect(out.value?.serverRefused, "an unanswered sign-out was reported as confirmed").not.toBeNull();
    expect(document.cookie, "the local half did not run").toContain("tf_owner=signed_out_pending");
  });
});
