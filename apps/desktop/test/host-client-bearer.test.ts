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

describe("the review's three rotation races", () => {
  it("a 503 from /auth/refresh clears NOTHING — host_busy is admission, not an authentication judgment", async () => {
    // The listener answers 503 host_busy BEFORE the handler reads the token, so the token was
    // never consumed and the pairing is still valid. Clearing it here signed a working phone out
    // over a burst of load on the laptop.
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([
      () => json(401, {}),
      () => json(503, { error: { code: "host_busy", message: "retry shortly" } }),
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

  it("another tab already rotated: the manager presents the STORED token, never its consumed copy", async () => {
    // Tabs share the refresh token through storage. A manager whose in-memory copy is stale —
    // another tab rotated while this one sat idle — must re-read storage before presenting, or
    // its consumed copy trips strict reuse detection and revokes the whole family.
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const bearer = new BearerManager({ storage, fetchImpl: scripted([]).fetch });
    // …the other tab rotates: storage moves on while this manager's memory holds refresh-1.
    storage.setItem(REFRESH_STORAGE_KEY, "refresh-2");
    const wire = scripted([
      () => json(401, {}),
      (s) => {
        expect(JSON.parse(s.body!)).toEqual({ refreshToken: "refresh-2" });
        return json(200, { tokens: { accessToken: "access-3", refreshToken: "refresh-3" } });
      },
      (s) => { expect(s.headers.authorization).toBe("Bearer access-3"); return json(200, {}); },
    ]);
    (bearer as unknown as { fetchImpl: unknown }).fetchImpl = wire.fetch;
    const res = await bearer.fetch("/sync");
    expect(res.status).toBe(200);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-3");
  });

  it("a STALE 401 — judged against a token a rotation already replaced — retries without rotating again", async () => {
    // Two requests leave stamped with access-1. The first 401 rotates to access-2/refresh-2 and
    // its replay succeeds. The second request's 401 arrives AFTER that rotation settled; rotating
    // again on it would burn refresh-2 for nothing and invalidate access-2 under the first
    // request's feet — the cascade the review named. Bound to the generation, the stale 401 just
    // restamps and replays.
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    let refreshCalls = 0;
    let releaseB!: () => void;
    const bHeld = new Promise<void>((r) => { releaseB = r; });
    const wire = {
      fetch: async (url: string, init?: unknown) => {
        const i = (init ?? {}) as { headers?: Record<string, string> };
        const auth = Object.entries(i.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
        if (url === "/auth/refresh") {
          refreshCalls++;
          return json(200, { tokens: { accessToken: "access-2", refreshToken: "refresh-2" } });
        }
        if (url === "/b" && auth === undefined) {
          // B's FIRST answer is held until A's whole recovery is done, then says 401 — the
          // stale refusal, judged against the pre-rotation stamp.
          await bHeld;
          return json(401, {});
        }
        return auth === "Bearer access-2" ? json(200, {}) : json(401, {});
      },
    };
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    const b = bearer.fetch("/b");
    const a = await bearer.fetch("/a");
    expect(a.status).toBe(200);
    expect(refreshCalls).toBe(1);
    releaseB();
    expect((await b).status).toBe(200);
    // ONE rotation for the whole episode — the stale 401 restamped instead of presenting
    // refresh-2 a second time.
    expect(refreshCalls).toBe(1);
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

/**
 * ═══ WHICH PAIRING THE SHARED SHELL'S SCRATCH SPACE BELONGS TO ════════════════════════════════
 *
 * This door mints no cookie by construction, so until the pairing scope existed, `readOwner()`
 * answered `null` here and all four of the shared shell's owner-keyed `localStorage` keys — the
 * compose scratch buffer, the durable send lanes, the Screener intent journal and the Search
 * order — resolved to the literal `…local`. Every pairing this ORIGIN had ever held therefore
 * shared one partition, and a host door's origin is a tailnet or LAN address, which is reusable:
 * the same phone, paired to a second computer at an address the first one used, restored the
 * first computer's unfinished message into the second one's composer.
 *
 * The scope is a random id and not a credential — see `PAIR_SCOPE_STORAGE_KEY`. What these cases
 * hold it to is the lifetime, which is the only part that can be wrong in a way that costs
 * something: minted on a REDEEM, kept across every ROTATION, gone when the session dies.
 *
 * ── THE MUTATIONS EACH WAS WATCHED AGAINST ────────────────────────────────────────────────────
 *
 *  · mint unconditionally in `adopt` (drop the `fresh`/absent test) → "a rotation keeps the
 *    pairing's scope" goes red, and every rotation would discard a half-written message;
 *  · never mint unless `fresh` (drop the `== null` arm) → "an install upgraded from a bundle with
 *    no scope adopts one" goes red, and an existing pairing stays on the shared partition for
 *    ever;
 *  · leave the scope in storage in `die()` → "a new pairing cannot read the previous one's
 *    scratch" goes red, because the next redeem finds the old scope and reuses it.
 */
describe("the pairing scope", () => {
  const PAIR_SCOPE_KEY = "ohmail.host.pairScope";
  const pair: BearerTokens = { accessToken: "access-1", refreshToken: "refresh-1" };

  it("a redeem mints one, and it is id-shaped so it can be part of a storage key", () => {
    const storage = memoryStorage();
    const bearer = new BearerManager({ storage, fetchImpl: async () => new Response("") });
    expect(bearer.pairScope(), "no pairing, no scope").toBeNull();

    bearer.adopt(pair, { fresh: true });
    const scope = bearer.pairScope();
    expect(scope).not.toBeNull();
    expect(scope).toMatch(/^[A-Za-z0-9._~-]{1,128}$/);
    expect(storage.getItem(PAIR_SCOPE_KEY)).toBe(scope);
  });

  it("a rotation keeps the pairing's scope — a rotated token is the same pairing", () => {
    const storage = memoryStorage();
    const bearer = new BearerManager({ storage, fetchImpl: async () => new Response("") });
    bearer.adopt(pair, { fresh: true });
    const first = bearer.pairScope();

    // The rotation path inside the manager adopts WITHOUT `fresh`.
    bearer.adopt({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(
      bearer.pairScope(),
      "re-minting per rotation would throw away a half-written message every time a token aged out",
    ).toBe(first);
  });

  it("an upgraded install has a scope BEFORE anything renders, not at its first adopt", () => {
    /**
     * The upgrade arm used to live in `adopt`, and `adopt` runs on a redeem or a rotation —
     * neither of which has happened when a browser that already holds a refresh token loads this
     * build for the first time. `paired()` was true while `pairScope()` was still null, so the
     * gate set the storage owner to `null` and mounted the shared shell on the old un-owned
     * `…local` partition: the PREVIOUS pairing's compose buffer, send lanes and Screener journal,
     * read by the shell's own effects before any request could 401 and rotate.
     *
     * The manager is constructed above `createRoot`, so minting in the constructor closes the
     * window entirely. This case asserts the state at construction and nothing later.
     */
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-old" });
    const bearer = new BearerManager({ storage, fetchImpl: async () => new Response("") });

    expect(bearer.paired(), "the pairing is held").toBe(true);
    expect(
      bearer.pairScope(),
      "the shell would mount on the previous pairing's shared partition",
    ).not.toBeNull();
    expect(storage.getItem(PAIR_SCOPE_KEY)).toBe(bearer.pairScope());
  });

  it("a browser with no pairing is given no scope", () => {
    const storage = memoryStorage();
    const bearer = new BearerManager({ storage, fetchImpl: async () => new Response("") });
    expect(bearer.pairScope()).toBeNull();
    expect(storage.getItem(PAIR_SCOPE_KEY), "nothing to scope, nothing written").toBeNull();
  });

  it("construction does not re-mint over a scope the pairing already has", () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "r", [PAIR_SCOPE_KEY]: "scope-kept" });
    const bearer = new BearerManager({ storage, fetchImpl: async () => new Response("") });
    expect(bearer.pairScope(), "a reload is not a new pairing").toBe("scope-kept");
  });

  it("a new pairing cannot read the previous one's scratch space", async () => {
    const storage = memoryStorage();
    const bearer = new BearerManager({ storage, fetchImpl: async () => new Response("") });
    bearer.adopt(pair, { fresh: true });
    const first = bearer.pairScope();

    await bearer.logout();
    expect(bearer.pairScope(), "no pairing, no scope").toBeNull();
    expect(storage.getItem(PAIR_SCOPE_KEY), "the scope goes with the refresh token").toBeNull();

    bearer.adopt({ accessToken: "access-9", refreshToken: "refresh-9" }, { fresh: true });
    expect(
      bearer.pairScope(),
      "the next computer at this address gets its own partition, not the previous one's",
    ).not.toBe(first);
  });
});
