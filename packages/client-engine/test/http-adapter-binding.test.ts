import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, NAMED_FEED_KINDS, OhmailEngine } from "@ohmail/client-engine";

/**
 * THE DEFAULT `fetch` BRANCH, EXERCISED — because in production it was the ONLY branch, and
 * no test had ever taken it.
 *
 * `HttpAdapter` stores a fetch on the instance and calls it as `this.fetchImpl(url, init)`.
 * That call site makes the RECEIVER the adapter. A browser's native `fetch` is bound to its
 * global and rejects any other receiver with a synchronous
 *
 *     TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
 *
 * thrown before a single byte leaves. In production that killed `OhmailEngine.start()` on its
 * first `/sync` call for every signed-in Cloud account: the mailbox rendered "0 unread of 0"
 * forever, with no console error and no network request, because `app/shell/engine.tsx`
 * catches `start()`'s rejection and discards it.
 *
 * Every other test in this package injects `HttpAdapterOptions.fetch` — a plain function,
 * which has no receiver requirement and therefore cannot fail this way. So the suite was
 * green against a client that could not load mail in any browser.
 *
 * THE FIDELITY THAT MAKES THIS BITE: `receiverBoundFetch` reproduces the ONE property of
 * native `fetch` that matters here — it throws unless its receiver is the global. Node's
 * `fetch` is NOT receiver-bound, so asserting against the real global would pass with or
 * without the fix and prove nothing.
 */

const ORIGINAL_FETCH = globalThis.fetch;

/** A stand-in for a browser's native `fetch`: usable only with the global as receiver. */
function receiverBoundFetch(calls: string[]): typeof globalThis.fetch {
  const impl = function (this: unknown, url: string | URL | Request, _init?: RequestInit) {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    calls.push(String(url));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: "MA",
          hasMore: false,
          serverTime: new Date(0).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  return impl as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("HttpAdapter's default fetch", () => {
  it("calls a receiver-bound global fetch without an Illegal invocation", async () => {
    const calls: string[] = [];
    globalThis.fetch = receiverBoundFetch(calls);

    // No `opts.fetch` — this is the branch the browser takes and the suite never did.
    const adapter = new HttpAdapter({ baseUrl: "/api" });
    const res = await adapter.sync({ since: "0" });

    expect(calls).toEqual(["/api/sync?since=0"]);
    expect(res.hasMore).toBe(false);
  });

  it("lets a live engine complete its first drain against a receiver-bound fetch", async () => {
    const calls: string[] = [];
    globalThis.fetch = receiverBoundFetch(calls);

    // The production shape: engine → adapter → default fetch. `start()` used to reject here,
    // and the webapp discarded the rejection, so the mailbox stayed empty in silence.
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "/api" }) });
    await expect(engine.start()).resolves.toBeUndefined();

    // THREE calls now, and each is the point rather than noise. A cold mirror asks
    // `GET /sync/snapshot` first, because `HttpAdapter` carries that capability; this stub
    // answers every URL with a `/sync`-shaped body, which has no `asOfSeq`, so the adapter refuses
    // it and the engine falls back to `since=0`. That fallback is what keeps `start()` RESOLVING
    // — the invariant this test was written for — against a server that has not deployed the
    // route. The degraded fallback opens with the rules-first pass (`types=rule` — decisions
    // land before the mail they govern; see `bootstrap-rules-first.test.ts`), then the mixed
    // replay. Asserting the exact list rather than "contains" is deliberate: a snapshot retried
    // on every drain, or a `since=0` that never happened, both have to be visible here. The
    // snapshot and the mixed replay name every kind the engine keeps.
    const named = new URLSearchParams({ types: NAMED_FEED_KINDS.join(",") }).toString();
    expect(calls).toEqual([`/api/sync/snapshot?${named}`, "/api/sync?since=0&types=rule", `/api/sync?since=0&${named}`]);
  });

  it("still prefers an injected fetch over the global", async () => {
    const globalCalls: string[] = [];
    globalThis.fetch = receiverBoundFetch(globalCalls);
    const injected: string[] = [];

    const adapter = new HttpAdapter({
      baseUrl: "",
      fetch: (url) => {
        injected.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              changes: { creates: [], updates: [], moves: [], deletes: [] },
              cursor: "MA",
              hasMore: false,
              serverTime: new Date(0).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    await adapter.sync({ since: "0" });

    expect(injected).toEqual(["/sync?since=0"]);
    expect(globalCalls).toEqual([]);
  });

  it("still refuses to construct when there is no fetch at all", () => {
    // @ts-expect-error — deleting the global is the condition under test.
    delete globalThis.fetch;
    expect(() => new HttpAdapter({ baseUrl: "" })).toThrow(/no fetch implementation/);
  });
});
