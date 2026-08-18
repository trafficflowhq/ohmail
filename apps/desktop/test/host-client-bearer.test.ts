import { describe, expect, it } from "vitest";
import { BearerManager, REFRESH_STORAGE_KEY, type BearerTokens } from "../src/host-client/bearer.js";

/**
 * ═══ THE BEARER MANAGER — the served client's whole credential, held to its contract ══════════
 *
 * Everything here drives the real class over a scripted fetch and an in-memory Storage, because
 * every property is behavioural: what leaves on the wire, what survives a 401, what a refusal
 * clears. The four that carry the file:
 *
 *  · Authorization is stamped by the MANAGER on every attempt — the extra-headers seam and every
 *    injected transport ride the same stamp, and a rotation that lands mid-request wins over the
 *    stale copy a caller composed earlier.
 *  · a 401 rotates ONCE and replays ONCE — and rotation is single-flighted, because this door's
 *    refresh is the native branch with strict reuse detection: presenting one refresh token
 *    twice IS the theft signal.
 *  · a refresh REFUSAL is definitive — cleared storage, the dead signal, no retry loop. A
 *    NETWORK failure during refresh clears nothing: the token was never presented.
 *  · adoption persists the refresh token and only it; the access token never touches storage.
 */

/** A Storage over a Map — jsdom-free, and the writes are inspectable. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  } as Storage;
}

interface Seen { url: string; method: string; headers: Record<string, string>; body: string | null }

/** A scripted fetch: each call records what it saw and pops the next answer. */
function scripted(answers: Array<(seen: Seen) => Response | Error>): { fetch: (url: string, init?: unknown) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
      const record: Seen = {
        url,
        method: i.method ?? "GET",
        headers: Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        body: i.body ?? null,
      };
      seen.push(record);
      const next = answers.shift();
      if (!next) throw new Error(`unscripted request: ${record.method} ${url}`);
      const out = next(record);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PAIR: BearerTokens = { accessToken: "access-1", refreshToken: "refresh-1" };
const ROTATED: BearerTokens = { accessToken: "access-2", refreshToken: "refresh-2" };

describe("adoption and the stamp", () => {
  it("persists the refresh token, keeps the access token OUT of storage, and stamps every request", async () => {
    const storage = memoryStorage();
    const wire = scripted([() => json(200, { ok: true })]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    expect(bearer.paired()).toBe(false);

    bearer.adopt(PAIR);
    expect(bearer.paired()).toBe(true);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-1");
    // The access token is in MEMORY only — nowhere in storage, under any key.
    for (let i = 0; i < storage.length; i++) {
      expect(storage.getItem(storage.key(i)!)).not.toContain("access-1");
    }

    await bearer.fetch("/sync");
    expect(wire.seen[0]!.headers.authorization).toBe("Bearer access-1");
  });

  it("a cold page load finds the refresh token in storage and is paired without an access token", () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const bearer = new BearerManager({ storage, fetchImpl: scripted([]).fetch });
    expect(bearer.paired()).toBe(true);
    expect(bearer.headers()).toEqual({}); // no access yet — the first 401 buys one
  });
});

describe("the 401 recovery", () => {
  it("rotates once, replays once with the fresh token, and persists the new refresh token", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([
      (s) => { expect(s.headers.authorization).toBeUndefined(); return json(401, { error: { code: "unauthorized" } }); },
      (s) => {
        expect(s.url).toBe("/auth/refresh");
        expect(JSON.parse(s.body!)).toEqual({ refreshToken: "refresh-1" });
        // The rotation itself carries no Authorization — there is nothing valid to carry.
        return json(200, { tokens: ROTATED });
      },
      (s) => { expect(s.headers.authorization).toBe("Bearer access-2"); return json(200, { items: [] }); },
    ]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    const res = await bearer.fetch("/mailboxes");
    expect(res.status).toBe(200);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-2");
    expect(wire.seen.map((s) => s.url)).toEqual(["/mailboxes", "/auth/refresh", "/mailboxes"]);
  });

  it("rotation is SINGLE-FLIGHTED: two concurrent 401s present the refresh token exactly once", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    let refreshCalls = 0;
    const wire = {
      fetch: async (url: string, init?: unknown) => {
        const i = (init ?? {}) as { headers?: Record<string, string> };
        if (url === "/auth/refresh") {
          refreshCalls++;
          await new Promise((r) => setTimeout(r, 20)); // both 401s are in flight before it lands
          return json(200, { tokens: ROTATED });
        }
        const auth = Object.entries(i.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
        return auth === "Bearer access-2" ? json(200, { ok: true }) : json(401, {});
      },
    };
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    const [a, b] = await Promise.all([bearer.fetch("/sync"), bearer.fetch("/threads")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // ONE presentation. Two would be the reuse signal that revokes the family server-side.
    expect(refreshCalls).toBe(1);
  });

  it("a second 401 after a fresh rotation is returned, never looped", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([
      () => json(401, {}),
      () => json(200, { tokens: ROTATED }),
      () => json(401, {}), // still refused with a token minted milliseconds ago — a revocation
    ]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    const res = await bearer.fetch("/sync");
    expect(res.status).toBe(401);
    expect(wire.seen).toHaveLength(3);
  });
});

describe("what a refresh refusal means", () => {
  it("a 401 from /auth/refresh clears the pair, fires the dead signal, and answers the original 401", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([
      () => json(401, {}),
      () => json(401, { error: { code: "unauthorized", message: "this session cannot be resumed" } }),
    ]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    let died = 0;
    bearer.onSessionDead(() => died++);
    const res = await bearer.fetch("/sync");
    expect(res.status).toBe(401);
    expect(died).toBe(1);
    expect(bearer.paired()).toBe(false);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
  });

  it("a NETWORK failure during the rotation clears nothing — the token was never presented", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([
      () => json(401, {}),
      () => new TypeError("Failed to fetch"),
    ]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    let died = 0;
    bearer.onSessionDead(() => died++);
    const res = await bearer.fetch("/sync");
    expect(res.status).toBe(401);
    expect(died).toBe(0);
    expect(bearer.paired()).toBe(true);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-1");
  });
});

describe("logout", () => {
  it("tells the door, then clears — and clears even when the door is unreachable", async () => {
    const storage = memoryStorage();
    const wire = scripted([(s) => {
      expect(s.url).toBe("/auth/logout");
      expect(s.headers.authorization).toBe("Bearer access-1");
      return new Response(null, { status: 204 });
    }]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    bearer.adopt(PAIR);
    await bearer.logout();
    expect(bearer.paired()).toBe(false);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBeNull();

    const offline = new BearerManager({ storage, fetchImpl: scripted([() => new TypeError("offline")]).fetch });
    offline.adopt(PAIR);
    await offline.logout();
    expect(offline.paired()).toBe(false);
  });
});
