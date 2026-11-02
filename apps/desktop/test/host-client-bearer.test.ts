import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_STORE_BUDGET_MS, BearerManager, OWED_ATTEMPT_STORAGE_KEY, OWED_DIAL_MS, OWED_SIGN_OUTS_STORAGE_KEY,
  PAIR_SCOPE_STORAGE_KEY, REFRESH_ATTEMPT_DB, REFRESH_ATTEMPT_STORAGE_KEY, REFRESH_STORAGE_KEY, type BearerTokens,
} from "../src/host-client/bearer.js";

/* The engine's own devDependency, reached through its package: the desktop does not carry one. */
const { IDBFactory: FakeIDBFactory, IDBDatabase: FakeIDBDatabase } = createRequire(
  new URL("../../../packages/client-engine/package.json", import.meta.url),
)("fake-indexeddb") as { IDBFactory: new () => IDBFactory; IDBDatabase: { prototype: IDBDatabase } };

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

/** A captive portal or a firewall answering in the host's place: its own HTML, no envelope. */
const portalPage = (status: number): Response =>
  new Response("<!doctype html><title>Sign in to Wi-Fi</title><form action=/login></form>", {
    status, headers: { "content-type": "text/html" },
  });

/** The refresh door's refusal, in the envelope `packages/services` throws it with. */
const refusal = (code: string, status = 401): Response => json(status, { error: { code, message: "refused" } });

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
        // The presented token AND the name of this attempt — the server tells a retry of a
        // lost answer from a replay by that name, so its presence is the wire contract.
        const sent = JSON.parse(s.body!) as { refreshToken: string; attemptId: string };
        expect(sent.refreshToken).toBe("refresh-1");
        expect(sent.attemptId, "every rotation names its attempt").toMatch(/^r\S+$/);
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
        // The presented token AND the name of this attempt — the server tells a retry of a
        // lost answer from a replay by that name, so its presence is the wire contract.
        const sent = JSON.parse(s.body!) as { refreshToken: string; attemptId: string };
        expect(sent.refreshToken).toBe("refresh-2");
        expect(sent.attemptId, "every rotation names its attempt").toMatch(/^r\S+$/);
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

  /* ONLY THE REFRESH DOOR'S OWN VERDICT ENDS THE PAIRING: a 401 naming one of its codes. Any
     other answer is the network's. MUTATION: judge by status alone in
     `readRefreshAnswer` — the first table reddens. */
  it.each<[string, () => Response]>([
    ["a 403 Wi-Fi sign-in page", () => portalPage(403)],
    ["a 401 page from a proxy", () => portalPage(401)],
    ["a 401 with a foreign JSON body", () => json(401, { message: "Unauthorized" })],
    ["a 403 naming a refusal code", () => refusal("refresh_revoked", 403)],
    ["a 200 sign-in page", () => portalPage(200)],
    ["a 200 with no token pair", () => json(200, { ok: true })],
  ])("%s at the refresh keeps the pairing", async (_what, answer) => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([() => json(401, {}), answer]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    let died = 0;
    bearer.onSessionDead(() => died++);
    const res = await bearer.fetch("/sync");
    expect(res.status).toBe(401);
    expect(died).toBe(0);
    expect(bearer.paired()).toBe(true);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-1");
    expect(storage.getItem(REFRESH_ATTEMPT_STORAGE_KEY)).not.toBeNull();
  });

  it.each<[string, number]>([
    ["refresh_missing", 401], ["refresh_expired", 401], ["refresh_revoked", 401], ["unauthorized", 401],
  ])("the host's %s ends the pairing", async (code, status) => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([() => json(401, {}), () => refusal(code, status)]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    let died = 0;
    bearer.onSessionDead(() => died++);
    await bearer.fetch("/sync");
    expect(died).toBe(1);
    expect(bearer.paired()).toBe(false);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
  });

  it("after a sign-in page, the next 401 retries the SAME attempt and adopts its answer", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const refreshes: Array<{ refreshToken?: string; attemptId?: string }> = [];
    const wire = scripted([
      () => json(401, {}),
      (s) => { refreshes.push(JSON.parse(s.body ?? "{}")); return portalPage(403); },
      () => json(401, {}),
      (s) => { refreshes.push(JSON.parse(s.body ?? "{}")); return json(200, { tokens: ROTATED }); },
      (s) => json(s.headers.authorization === "Bearer access-2" ? 200 : 401, { ok: true }),
    ]);
    const bearer = new BearerManager({ storage, fetchImpl: wire.fetch });
    expect((await bearer.fetch("/sync")).status).toBe(401);
    expect((await bearer.fetch("/sync")).status).toBe(200);
    expect(refreshes.map((r) => r.refreshToken)).toEqual(["refresh-1", "refresh-1"]);
    expect(refreshes[1]!.attemptId).toBe(refreshes[0]!.attemptId);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-2");
  });
});

describe("logout", () => {
  it("clears, then tells the door with the bearer it held — and clears even when the door is unreachable", async () => {
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

  it("after a rotation whose answer was lost: the bearer's 401, then the refresh door ends the family — never a renewal", async () => {
    const wire = scripted([
      () => json(401, {}),
      () => new TypeError("network error"),
      () => refusal("unauthorized"),
      () => new Response(null, { status: 204 }),
    ]);
    const bearer = new BearerManager({ storage: memoryStorage(), fetchImpl: wire.fetch, idb: null });
    bearer.adopt(PAIR);
    expect((await bearer.fetch("/sync")).status, "the rotation's answer never arrived").toBe(401);
    expect(await bearer.logout(), "the door ended the family").toBe(true);
    expect(wire.seen.map((s) => [s.url, s.headers.authorization ?? null])).toEqual([
      ["/sync", "Bearer access-1"], ["/auth/refresh", null],
      ["/auth/logout", "Bearer access-1"], ["/auth/refresh/logout", null],
    ]);
    expect(JSON.parse(wire.seen[3]!.body!)).toEqual({ refreshToken: "refresh-1" });
    expect(bearer.paired()).toBe(false);
  });

  it("with no access token held it goes to the refresh door at once; an answer that is no verdict is not told", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const cold = scripted([(s) => (s.url === "/auth/refresh/logout" ? refusal("unauthorized") : new Error(s.url))]);
    expect(await new BearerManager({ storage, fetchImpl: cold.fetch, idb: null }).logout(), "nothing left to end is told").toBe(true);
    for (const answer of [() => new Response(null, { status: 401 }), () => new Response(null, { status: 503 }), () => new TypeError("offline")]) {
      const bearer = new BearerManager({ storage: memoryStorage(), fetchImpl: scripted([() => refusal("unauthorized"), answer]).fetch, idb: null });
      bearer.adopt(PAIR);
      expect(await bearer.logout()).toBe(false);
      expect(bearer.paired(), "the local half runs whatever the server said").toBe(false);
    }
  });
});

/**
 * ═══ A SIGN-OUT THE COMPUTER WAS NOT TOLD IS OWED, AND SENT WHEN IT CAN BE ══════════════════════
 *
 * Signing out while the computer is out of reach used to clear this browser and leave the session
 * live there until it idled out. The refresh token is kept as owed (it is the only thing the refresh
 * door's sign-out accepts), never presented for a renewal, and sent to that door at the next chance:
 * a construction, `online`, a visible page, a capped retry, a redeem.
 */
describe("an owed sign-out", () => {
  const owedOf = (storage: Storage): Array<{ token: string; at: number }> =>
    JSON.parse(storage.getItem(OWED_SIGN_OUTS_STORAGE_KEY) ?? "[]") as Array<{ token: string; at: number }>;
  const offline = async (): Promise<Response> => { throw new TypeError("offline"); };
  const offlineSignOut = async (storage: Storage, refreshToken: string): Promise<string> => {
    const bearer = new BearerManager({ storage, fetchImpl: offline, idb: null });
    bearer.adopt({ accessToken: "a", refreshToken }, { fresh: true });
    return bearer.signOut();
  };

  it("an offline sign-out is kept as owed, and the page is signed out all the same", async () => {
    const storage = memoryStorage();
    expect(await offlineSignOut(storage, "refresh-1")).toBe("owed");
    expect(owedOf(storage).map((e) => e.token)).toEqual(["refresh-1"]);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
    expect(new BearerManager({ storage, fetchImpl: offline, idb: null }).paired(),
      "an owed sign-out reads as a pairing").toBe(false);
  });

  it("a computer that never answers: the press signs this browser out at once, owed, and settles within the dial's bound", async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      // Answers nothing; fails only when the caller gives up, as a browser's fetch does.
      const silent = (_url: string, init?: unknown): Promise<Response> => new Promise((_ok, fail) => {
        (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () => fail(new TypeError("aborted")));
      });
      const bearer = new BearerManager({ storage, fetchImpl: silent, idb: null });
      bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
      let outcome: string | null = null;
      void bearer.signOut().then((o) => { outcome = o; });
      // A page closed now, before the computer says anything, must leave nothing paired and the debt kept.
      expect(bearer.paired(), "still paired while the computer is silent").toBe(false);
      expect(storage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
      expect(owedOf(storage).map((e) => e.token)).toEqual(["r1"]);
      await vi.advanceTimersByTimeAsync(OWED_DIAL_MS);
      expect(outcome).toBe("owed");
      const wire = scripted([() => new Response(null, { status: 204 })]);
      const next = new BearerManager({ storage, fetchImpl: wire.fetch, idb: null });
      expect(next.paired()).toBe(false);
      await next.drainOwedSignOuts();
      expect(wire.seen.map((s) => [s.url, JSON.parse(s.body!)])).toEqual([["/auth/refresh/logout", { refreshToken: "r1" }]]);
      expect(owedOf(storage)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("told by a drain while the press still waits on the computer: the press says told", async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const bearer = new BearerManager({
        storage,
        idb: null,
        // The refresh door answers; the bearer door never does.
        fetchImpl: (url, init) => (url === "/auth/refresh/logout"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : new Promise<Response>((_ok, fail) => {
            (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () => fail(new TypeError("aborted")));
          })),
      });
      await bearer.drainOwedSignOuts(); // the construction's own, with nothing owed yet
      bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
      const outcome = bearer.signOut();
      await bearer.drainOwedSignOuts();
      expect(owedOf(storage)).toEqual([]);
      await vi.advanceTimersByTimeAsync(OWED_DIAL_MS);
      expect(await outcome).toBe("told");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the next page sends it to the refresh door, never for a renewal, and forgets it on the answer", async () => {
    const storage = memoryStorage();
    await offlineSignOut(storage, "refresh-1");
    const wire = scripted([() => new Response(null, { status: 204 })]);
    const next = new BearerManager({ storage, fetchImpl: wire.fetch, idb: null });
    await next.drainOwedSignOuts();
    expect(wire.seen.map((s) => [s.url, s.headers.authorization ?? null])).toEqual([["/auth/refresh/logout", null]]);
    expect(JSON.parse(wire.seen[0]!.body!)).toEqual({ refreshToken: "refresh-1" });
    expect(owedOf(storage)).toEqual([]);
    expect(next.paired()).toBe(false);
  });

  it.each([
    ["a 503", () => new Response(null, { status: 503 }), ["refresh-1"]],
    ["a page in front of the door", () => portalPage(401), ["refresh-1"]],
    ["the network", () => new TypeError("offline"), ["refresh-1"]],
    ["the door's own refusal", () => refusal("refresh_revoked"), []],
    ["a computer without the door (404)", () => new Response("not found", { status: 404 }), []],
  ] as const)("%s: kept or forgotten as the answer says", async (_name, answer, left) => {
    const storage = memoryStorage();
    await offlineSignOut(storage, "refresh-1");
    await new BearerManager({ storage, fetchImpl: scripted([answer]).fetch, idb: null }).drainOwedSignOuts();
    expect(owedOf(storage).map((e) => e.token)).toEqual(left);
  });

  it("four are kept at most: a fifth is not recorded, and says so", async () => {
    const storage = memoryStorage();
    for (const t of ["r1", "r2", "r3", "r4"]) expect(await offlineSignOut(storage, t)).toBe("owed");
    expect(await offlineSignOut(storage, "r5")).toBe("untold");
    expect(owedOf(storage).map((e) => e.token)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("one older than thirty days is dropped unsent", async () => {
    const storage = memoryStorage({
      [OWED_SIGN_OUTS_STORAGE_KEY]: JSON.stringify([{ token: "old", at: Date.now() - 31 * 24 * 60 * 60_000 }]),
    });
    const wire = scripted([]);
    await new BearerManager({ storage, fetchImpl: wire.fetch, idb: null }).drainOwedSignOuts();
    expect(wire.seen).toEqual([]);
    expect(owedOf(storage)).toEqual([]);
  });

  it("a told sign-out owes nothing", async () => {
    const storage = memoryStorage();
    const bearer = new BearerManager({ storage, fetchImpl: scripted([() => new Response(null, { status: 204 })]).fetch, idb: null });
    bearer.adopt(PAIR, { fresh: true });
    expect(await bearer.signOut()).toBe("told");
    expect(storage.getItem(OWED_SIGN_OUTS_STORAGE_KEY)).toBeNull();
  });

  it("a page built over an owed sign-out sends it of its own accord", async () => {
    const storage = memoryStorage();
    await offlineSignOut(storage, "refresh-1");
    const wire = scripted([() => new Response(null, { status: 204 })]);
    new BearerManager({ storage, fetchImpl: wire.fetch, idb: null });
    await vi.waitFor(() => expect(owedOf(storage)).toEqual([]));
    expect(wire.seen.map((s) => s.url)).toEqual(["/auth/refresh/logout"]);
  });
});

describe("the family a re-pair names", () => {
  const digest = (t: string): string => createHash("sha256").update(t, "utf8").digest("base64url");

  it("the held refresh token's digest, else the newest owed sign-out's, else none", async () => {
    const storage = memoryStorage();
    const bearer = new BearerManager({ storage, fetchImpl: async () => { throw new TypeError("offline"); }, idb: null });
    expect(await bearer.previousSession()).toBeNull();
    bearer.adopt(PAIR, { fresh: true });
    expect(await bearer.previousSession()).toBe(digest("refresh-1"));
    await bearer.signOut();
    expect(await new BearerManager({ storage, fetchImpl: async () => { throw new TypeError("offline"); }, idb: null }).previousSession())
      .toBe(digest("refresh-1"));
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

  it("a stale tab whose origin was re-paired elsewhere ends, rather than adopting the successor", async () => {
    /**
     * `rotate` re-reads the shared refresh slot on purpose: another TAB may have rotated the SAME
     * pairing while this one sat idle, and presenting a consumed token is the theft signal. But a
     * changed token has two causes and only one of them is that. The other is a fresh `/pair`
     * redeem pointing this origin at a DIFFERENT computer — after which this tab would present the
     * successor's token, adopt its access token, and go on rendering the previous account's mail
     * while acting as the new one.
     *
     * The pairing scope tells the two apart, and it only exists because of the partition work.
     * This is what it buys beyond storage keys.
     */
    const storage = memoryStorage();
    // One request, refused. The rotation must never reach `/auth/refresh`.
    const { fetch, seen } = scripted([() => json(401, { error: { code: "unauthorized" } })]);
    const stale = new BearerManager({ storage, fetchImpl: fetch });
    stale.adopt({ accessToken: "a-1", refreshToken: "r-a" }, { fresh: true });

    let dead = false;
    stale.onSessionDead(() => { dead = true; });

    // Another tab redeems a fresh QR for a different computer at this same origin.
    const other = new BearerManager({ storage, fetchImpl: async () => new Response("") });
    other.adopt({ accessToken: "b-1", refreshToken: "r-b" }, { fresh: true });

    const res = await stale.fetch("/messages", {});

    expect(
      seen.filter((r) => r.url === "/auth/refresh"),
      "it presented the successor pairing's refresh token",
    ).toEqual([]);
    expect(dead, "the stale tab did not end its own session").toBe(true);
    expect(res.status).toBe(401);
    expect(stale.paired(), "and it is no longer paired").toBe(false);

    /**
     * AND IT LEFT THE SUCCESSOR'S CREDENTIAL ALONE, which is the half that makes this guard safe.
     *
     * The first version called `die()`, which clears `localStorage` — correct when the SESSION is
     * over, and exactly wrong here: the jar no longer holds THIS tab's credential, it holds the
     * NEW pairing's. Ending that way would have destroyed the new account's session from a
     * background rotation in an old tab, with no user act at all. The guard would have caused the
     * outage it was written to prevent.
     */
    expect(storage.getItem(REFRESH_STORAGE_KEY), "the successor's refresh token was deleted").toBe("r-b");
    expect(storage.getItem(PAIR_SCOPE_KEY), "the successor's scope was deleted").toBe(other.pairScope());
    expect(other.paired(), "the new pairing is still live").toBe(true);
  });

  it("a same-pairing rotation from another tab is still adopted — the scope did not move", async () => {
    // The case the check must NOT break: one pairing, two tabs, the other rotated first.
    const storage = memoryStorage();
    const { fetch, seen } = scripted([
      () => json(401, {}),
      () => json(200, { tokens: { accessToken: "a-2", refreshToken: "r-a2" } }),
      () => json(200, { ok: true }),
    ]);
    const tab = new BearerManager({ storage, fetchImpl: fetch });
    tab.adopt({ accessToken: "a-1", refreshToken: "r-a" }, { fresh: true });
    // …the other tab rotates the SAME pairing: the refresh token moves, the scope does not.
    storage.setItem(REFRESH_STORAGE_KEY, "r-a-rotated");

    const res = await tab.fetch("/messages", {});
    expect(seen.some((r) => r.url === "/auth/refresh"), "the rotation was refused wrongly").toBe(true);
    expect(res.status).toBe(200);
  });

  /**
   * ═══ A RE-PAIR WHILE A REFRESH IS IN FLIGHT ══════════════════════════════════════════════
   *
   * The case above moves the scope BEFORE the rotation starts, and the check at the top of
   * `rotate` catches it. These three move it DURING the await, which that check cannot see: a
   * check placed before a suspension point answers about a state the resumption no longer has.
   * Both outcomes were reproduced against the unchanged module and both end with a person
   * unable to reach their mail — the late REFUSAL deleted the successor's credential, the late
   * SUCCESS overwrote it with the old pairing's, and in each case the pairing just made had
   * stopped working with no user act.
   *
   * The re-pair happens INSIDE the scripted answer, which is what makes these cases about the
   * suspension point rather than about a sequence a test arranged around it.
   *
   * MUTATION (2026-09-15): drop the post-await comparison — `standDownIfRepaired` returning
   * `false` unconditionally — and the first two go red on the successor's credential, exactly
   * as the reviewer reproduced them. The third stays green under it, which is what says the
   * guard is not simply refusing everything.
   */
  it("a LATE REFUSAL after a re-pair leaves the successor's credential alone", async () => {
    const storage = memoryStorage();
    const stale = new BearerManager({ storage, fetchImpl: async () => new Response("") });
    stale.adopt({ accessToken: "a-1", refreshToken: "r-a" }, { fresh: true });

    let successorScope: string | null = null;
    const { fetch, seen } = scripted([
      () => json(401, { error: { code: "unauthorized" } }),
      () => {
        /* THE RE-PAIR, while this refresh is pending: another tab redeems a fresh link for a
           different computer at the same origin, which re-mints the scope and writes its own
           refresh token. Then the old pairing's refresh comes back refused. */
        const other = new BearerManager({ storage, fetchImpl: async () => new Response("") });
        other.adopt({ accessToken: "b-1", refreshToken: "r-b" }, { fresh: true });
        successorScope = other.pairScope();
        return json(401, { error: { code: "unauthorized" } });
      },
    ]);
    const tab = new BearerManager({ storage, fetchImpl: fetch });
    tab.adopt({ accessToken: "a-1", refreshToken: "r-a" }, { fresh: true });
    let dead = false;
    tab.onSessionDead(() => { dead = true; });

    const res = await tab.fetch("/messages", {});

    expect(seen.some((r) => r.url === "/auth/refresh"), "no refresh was attempted").toBe(true);
    expect(res.status).toBe(401);
    expect(
      storage.getItem(REFRESH_STORAGE_KEY),
      "the successor's refresh token was deleted by the old pairing's late refusal",
    ).toBe("r-b");
    expect(
      storage.getItem(PAIR_SCOPE_KEY),
      "the successor's scope was deleted by the old pairing's late refusal",
    ).toBe(successorScope);
    /* AND THIS TAB ENDED, in memory, telling the gate — `standDown`, not `die`. */
    expect(dead, "the tab whose pairing is gone did not end its own session").toBe(true);
    expect(tab.paired()).toBe(false);
  });

  it("a LATE SUCCESS after a re-pair does not overwrite the successor's credential", async () => {
    const storage = memoryStorage();
    let successorScope: string | null = null;
    const { fetch } = scripted([
      () => json(401, { error: { code: "unauthorized" } }),
      () => {
        const other = new BearerManager({ storage, fetchImpl: async () => new Response("") });
        other.adopt({ accessToken: "b-1", refreshToken: "r-b" }, { fresh: true });
        successorScope = other.pairScope();
        /* The old pairing's refresh SUCCEEDS, a moment too late. Adopting here would seal the
           old computer's token into the new pairing's jar. */
        return json(200, { tokens: { accessToken: "a-2", refreshToken: "r-a2" } });
      },
    ]);
    const tab = new BearerManager({ storage, fetchImpl: fetch });
    tab.adopt({ accessToken: "a-1", refreshToken: "r-a" }, { fresh: true });

    const res = await tab.fetch("/messages", {});

    expect(res.status).toBe(401);
    expect(
      storage.getItem(REFRESH_STORAGE_KEY),
      "the old pairing's rotated token was written over the successor's",
    ).toBe("r-b");
    expect(storage.getItem(PAIR_SCOPE_KEY)).toBe(successorScope);
    expect(tab.paired(), "the tab whose pairing is gone is not still holding one").toBe(false);
  });

  it("an ordinary refresh, with nobody re-pairing, still stores its result", async () => {
    /* THE POSITIVE CONTROL. A guard that refuses every write would pass both cases above and
       break the product; this is the case that has to stay green under it. Its twin lives in
       "the 401 recovery" above, driven through the wire; this one is here so the trio reads
       together and so the mutation's effect on it is visible in one run. */
    const storage = memoryStorage();
    const { fetch, seen } = scripted([
      () => json(401, { error: { code: "unauthorized" } }),
      () => json(200, { tokens: { accessToken: "a-2", refreshToken: "r-a2" } }),
      () => json(200, { ok: true }),
    ]);
    const tab = new BearerManager({ storage, fetchImpl: fetch });
    tab.adopt({ accessToken: "a-1", refreshToken: "r-a" }, { fresh: true });
    const scope = tab.pairScope();

    const res = await tab.fetch("/messages", {});

    expect(res.status).toBe(200);
    expect(storage.getItem(REFRESH_STORAGE_KEY), "the rotation did not store").toBe("r-a2");
    expect(storage.getItem(PAIR_SCOPE_KEY), "a rotation is the same pairing").toBe(scope);
    expect(seen[2]!.headers.authorization, "the replay went out stale").toBe("Bearer a-2");
    expect(tab.paired()).toBe(true);
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

/**
 * ═══ A LOST ROTATION ANSWER — THE RETRY IS THE SAME ATTEMPT, NOT A STRANGER ══════════════════
 *
 * A rotation is two halves plus a response: the server consumes and mints, then the answer has to
 * land. When it does not, this client still holds the old token, and its retry used to be
 * byte-identical to a replay — so the server revoked the family. Every attempt now carries a
 * name, committed to IndexedDB and written to the JAR before it submits, and owed for the token it
 * went out with. This is the CLIENT half; the server half — N presentations under ONE name leave
 * one live tail and no revocation — is measured in the services rotation-retry pg twin.
 */
describe("a lost rotation answer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * The host door's native refresh arm (`surface: "native"`: no grace, a name honoured for its token's
   * whole life). A live token rotates; a spent one presented under the name that spent it is answered
   * again while the chain has not moved on under another name; anything else sweeps the family.
   * `drop` loses the next answer, `"before"` the door reads it or `"after"` it rotated.
   */
  function nativeDoor() {
    const chain: Array<{ token: string; by: string | null }> = [{ token: "refresh-1", by: null }];
    const drops: Array<"before" | "after"> = [];
    const names: string[] = [];
    const presented: string[] = [];
    let swept = false;
    let lapsed = false;
    const mint = (): Response => {
      chain.push({ token: `refresh-${chain.length + 1}`, by: null });
      lapsed = false;
      return json(200, { tokens: { accessToken: `access-${chain.length}`, refreshToken: `refresh-${chain.length}` } });
    };
    const answer = (token: string, name: string): Response => {
      const at = chain.findIndex((row) => row.token === token);
      const row = chain[at];
      if (swept || row === undefined) return refusal("refresh_revoked");
      if (row.by === null) {
        row.by = name;
        return mint();
      }
      if (row.by === name && chain.slice(at + 1).every((later) => later.by === null || later.by === name)) {
        chain.at(-1)!.by = name;
        return mint();
      }
      swept = true;
      return refusal("refresh_revoked");
    };
    const fetch = async (url: string, init?: unknown): Promise<Response> => {
      const i = (init ?? {}) as { body?: string; headers?: Record<string, string> };
      if (url === "/auth/refresh") {
        const sent = JSON.parse(i.body!) as { refreshToken: string; attemptId: string };
        names.push(sent.attemptId);
        presented.push(sent.refreshToken);
        const drop = drops.shift();
        if (drop === "before") throw new TypeError("network error");
        const out = answer(sent.refreshToken, sent.attemptId);
        if (drop === "after") throw new TypeError("network error");
        return out;
      }
      const auth = Object.entries(i.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
      return !lapsed && auth === `Bearer access-${chain.length}` ? json(200, { ok: true }) : json(401, {});
    };
    return {
      fetch, names, presented,
      swept: () => swept,
      /** The access window ends: the next request is refused until a rotation lands. */
      lapse: () => { lapsed = true; },
      drop: (when: "before" | "after") => { drops.push(when); },
    };
  }

  /** localStorage as a browser keeps it: reads see every write; `commit` lands the batch on `disk`, `kill` drops it. */
  function batchedJar(disk: Map<string, string>): { storage: Storage; commit: () => void; kill: () => void } {
    const pending = new Map<string, string | null>();
    const view = (): Map<string, string> => {
      const now = new Map(disk);
      for (const [k, v] of pending) {
        if (v === null) now.delete(k);
        else now.set(k, v);
      }
      return now;
    };
    const storage = {
      get length() { return view().size; },
      clear: () => { for (const k of view().keys()) pending.set(k, null); },
      getItem: (k: string) => view().get(k) ?? null,
      key: (i: number) => [...view().keys()][i] ?? null,
      removeItem: (k: string) => void pending.set(k, null),
      setItem: (k: string, v: string) => void pending.set(k, String(v)),
    } as Storage;
    const commit = (): void => {
      for (const [k, v] of pending) {
        if (v === null) disk.delete(k);
        else disk.set(k, v);
      }
      pending.clear();
    };
    return { storage, commit, kill: () => pending.clear() };
  }

  /** IndexedDB's copy, read as a restarted page reads it; `null` for none. */
  async function storedRecord(idb: IDBFactory): Promise<unknown> {
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const req = idb.open(REFRESH_ATTEMPT_DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("attempt"); };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
    });
    try {
      return await new Promise((ok, no) => {
        const get = db.transaction("attempt", "readonly").objectStore("attempt").get("owed");
        get.onsuccess = () => ok(get.result ?? null);
        get.onerror = () => no(get.error);
      });
    } finally {
      db.close();
    }
  }
  const idOf = (record: unknown): unknown => (record as { id?: unknown } | null)?.id ?? null;
  const jarId = (raw: string | null | undefined): unknown => idOf(raw == null ? null : JSON.parse(raw));
  /** The jar's two copies of the name: the bare one every build reads, and the record. */
  const jarNames = (jar: Storage): unknown[] => [jar.getItem(REFRESH_ATTEMPT_STORAGE_KEY), jar.getItem(OWED_ATTEMPT_STORAGE_KEY)];
  const databases = async (idb: IDBFactory): Promise<string[]> => (await idb.databases()).map((d) => d.name ?? "");

  /** IndexedDB refusing, failing every open a task later, or never answering one — a wedged profile. */
  const refusingIdb = { open: () => { throw new DOMException("refused", "SecurityError"); } } as unknown as IDBFactory;
  const failingIdb = {
    open: () => {
      const req = {} as IDBOpenDBRequest;
      setTimeout(() => req.onerror?.(new Event("error")));
      return req;
    },
  } as unknown as IDBFactory;
  const hungIdb = { open: () => ({}) } as unknown as IDBFactory;

  /** One real store whose opens can be made to hang or fail for a while. */
  function wedgeable(): { idb: IDBFactory; mode: "answers" | "hung" | "failing" } {
    const real = new FakeIDBFactory();
    const store = { mode: "answers" as "answers" | "hung" | "failing", idb: real };
    store.idb = {
      open: (name: string, version?: number) =>
        (store.mode === "answers" ? real : store.mode === "hung" ? hungIdb : failingIdb).open(name, version),
      deleteDatabase: (name: string) => real.deleteDatabase(name),
    } as unknown as IDBFactory;
    return store;
  }

  /** A door whose refresh answer is dropped until `answer` is flipped; every name is recorded. */
  function lossyDoor(names: string[], state: { answer: "lost" | "ok" }): (url: string, init?: unknown) => Promise<Response> {
    return async (url, init) => {
      const i = (init ?? {}) as { body?: string; headers?: Record<string, string> };
      if (url === "/auth/refresh") {
        names.push((JSON.parse(i.body!) as { attemptId: string }).attemptId);
        // A DROPPED ANSWER IS A THROW, which is what a broken connection is — never a judgment
        // on the token. The server has rotated; this side hears nothing.
        if (state.answer === "lost") throw new TypeError("network error");
        return json(200, { tokens: ROTATED });
      }
      const auth = Object.entries(i.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
      return auth === "Bearer access-2" ? json(200, { ok: true }) : json(401, {});
    };
  }

  it("is retried under the SAME name until one lands, and stays owed for the token it went out with", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const names: string[] = [];
    const state = { answer: "lost" as "lost" | "ok" };
    const bearer = new BearerManager({ storage, fetchImpl: lossyDoor(names, state) });

    for (let i = 0; i < 5; i += 1) {
      expect((await bearer.fetch("/sync")).status, `retry ${i}: nothing was judged`).toBe(401);
    }
    expect(names).toHaveLength(5);
    expect(new Set(names).size, "five retries of one lost answer, ONE name").toBe(1);
    // On disk, not only in this object — which is what makes the name survive a reload. The bare
    // copy is what a tab of an older build sends as ITS name: a name, and nothing else.
    expect(storage.getItem(REFRESH_ATTEMPT_STORAGE_KEY)).toBe(names[0]);
    expect(jarId(storage.getItem(OWED_ATTEMPT_STORAGE_KEY))).toBe(names[0]);
    // A dropped answer clears nothing: the pairing and its token are exactly as they were.
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-1");
    expect(bearer.paired()).toBe(true);

    state.answer = "ok";
    expect((await bearer.fetch("/sync")).status).toBe(200);
    expect(names[5], "the answered attempt is still the same one").toBe(names[0]);
    // ANSWERED for every build, as before: the bare copy goes with the adoption.
    expect(storage.getItem(REFRESH_ATTEMPT_STORAGE_KEY)).toBeNull();
    // STILL OWED for refresh-1: a crash before the jar keeps refresh-2 comes back holding refresh-1.
    expect(jarId(storage.getItem(OWED_ATTEMPT_STORAGE_KEY))).toBe(names[0]);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-2");
  });

  it("the name survives a RELOAD — a manager rebuilt from the same jar resumes the attempt", async () => {
    const storage = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const names: string[] = [];
    const state = { answer: "lost" as "lost" | "ok" };
    const first = new BearerManager({ storage, fetchImpl: lossyDoor(names, state) });
    expect((await first.fetch("/sync")).status).toBe(401);

    // The page is reloaded between submit and adopt — the case a name in memory cannot survive.
    const second = new BearerManager({ storage, fetchImpl: lossyDoor(names, state) });
    expect((await second.fetch("/sync")).status).toBe(401);

    expect(names).toHaveLength(2);
    expect(names[1], "the reloaded page retries as itself, not as a stranger").toBe(names[0]);
  });

  it("CONTROL: no crash, so the next rotation presents the token the answer brought, under a NEW name", async () => {
    // A name owed for a token the jar has moved past is never claimed again, on this page or a reload.
    const idb = new FakeIDBFactory();
    const door = nativeDoor();
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const bearer = new BearerManager({ storage: jar, fetchImpl: door.fetch, idb });
    expect((await bearer.fetch("/sync")).status).toBe(200);
    door.lapse();
    expect((await bearer.fetch("/sync")).status).toBe(200);
    door.lapse();
    expect((await new BearerManager({ storage: jar, fetchImpl: door.fetch, idb }).fetch("/sync")).status).toBe(200);

    expect(door.presented).toEqual(["refresh-1", "refresh-2", "refresh-3"]);
    expect(new Set(door.names).size, "a finished attempt is never claimed twice").toBe(3);
    expect(door.swept()).toBe(false);
  });

  /* KILLED BEFORE THE JAR'S BATCH LANDED. A rotation from refresh-1 to refresh-2 lands, then the browser
     dies before localStorage writes its batch, which held the name and refresh-2 both. The restart holds
     refresh-1, and only the name that spent it brings it back: this door honours the name for the
     token's whole life and sweeps the family under any other. */
  it.each([["at once", 0], ["a day later", 24 * 60 * 60 * 1000]])(
    "killed before the jar's batch landed, restarted %s: refresh-1 goes under the SAME name and stays paired",
    async (_when, later) => {
      const disk = new Map([[REFRESH_STORAGE_KEY, "refresh-1"], [PAIR_SCOPE_STORAGE_KEY, "scope-1"]]);
      const idb = new FakeIDBFactory();
      const door = nativeDoor();
      const before = batchedJar(disk);
      const first = new BearerManager({ storage: before.storage, fetchImpl: door.fetch, idb });
      expect((await first.fetch("/sync")).status).toBe(200);
      before.kill();
      expect(disk.get(REFRESH_STORAGE_KEY)).toBe("refresh-1");
      expect([REFRESH_ATTEMPT_STORAGE_KEY, OWED_ATTEMPT_STORAGE_KEY].filter((k) => disk.has(k)), "the lost batch held the name too")
        .toEqual([]);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + later);
      const after = batchedJar(disk);
      const restarted = new BearerManager({ storage: after.storage, fetchImpl: door.fetch, idb });
      let died = 0;
      restarted.onSessionDead(() => died++);
      expect((await restarted.fetch("/sync")).status).toBe(200);
      expect(door.presented).toEqual(["refresh-1", "refresh-1"]);
      expect(door.names[1], "the name the spent token went out under").toBe(door.names[0]);
      expect(door.swept()).toBe(false);
      expect(died).toBe(0);
      // Both records hold it again: the jar's, once its batch lands, beside IndexedDB's.
      after.commit();
      expect(jarId(disk.get(OWED_ATTEMPT_STORAGE_KEY))).toBe(door.names[0]);
      expect(idOf(await storedRecord(idb))).toBe(door.names[0]);
    },
  );

  it("the name's IndexedDB write has FINISHED when the request leaves", async () => {
    // Each open answers a task later, as a browser's does; the count is read at the send, never by a
    // second read that IndexedDB would queue behind a write still in flight.
    const real = new FakeIDBFactory();
    let finished = 0;
    const transaction = FakeIDBDatabase.prototype.transaction;
    vi.spyOn(FakeIDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args);
      if (args[1] === "readwrite") tx.addEventListener("complete", () => { finished += 1; });
      return tx;
    });
    const idb = {
      open: (name: string, version?: number) => {
        const later: { result?: IDBDatabase; error?: unknown; onupgradeneeded?: (e: Event) => void;
          onsuccess?: (e: Event) => void; onerror?: (e: Event) => void } = {};
        setTimeout(() => {
          const req = real.open(name, version);
          req.onupgradeneeded = (e) => { later.result = req.result; later.onupgradeneeded?.(e); };
          req.onsuccess = (e) => { later.result = req.result; later.onsuccess?.(e); };
          req.onerror = (e) => { later.error = req.error; later.onerror?.(e); };
        });
        return later;
      },
    } as unknown as IDBFactory;
    const door = nativeDoor();
    let atSend = -1;
    const wire = (url: string, init?: unknown): Promise<Response> => {
      if (url === "/auth/refresh") atSend = finished;
      return door.fetch(url, init);
    };
    const bearer = new BearerManager({ storage: memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" }), fetchImpl: wire, idb });
    expect((await bearer.fetch("/sync")).status).toBe(200);
    expect(atSend, "the request left before the name was on disk").toBe(1);
  });

  it.each<[string, IDBFactory | null]>([
    ["missing", null], ["refusing", refusingIdb], ["failing", failingIdb], ["hung", hungIdb],
  ])("an IndexedDB that is %s: the rotation still goes out, once, within the budget, saying nothing", async (_how, idb) => {
    vi.useFakeTimers();
    const said = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const door = nativeDoor();
    const bearer = new BearerManager({ storage: memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" }), fetchImpl: door.fetch, idb });
    const answer = bearer.fetch("/sync");
    await vi.advanceTimersByTimeAsync(ATTEMPT_STORE_BUDGET_MS);
    expect((await answer).status).toBe(200);
    expect(door.presented).toEqual(["refresh-1"]);
    for (const level of said) expect(level).not.toHaveBeenCalled();
  });

  it("an IndexedDB that opens past the budget is closed unwritten: the rotation went without it", async () => {
    vi.useFakeTimers();
    const late = { close: vi.fn(), transaction: vi.fn() };
    const idb = {
      open: () => {
        const req: { result?: unknown; onsuccess?: () => void } = {};
        setTimeout(() => { req.result = late; req.onsuccess?.(); }, 2 * ATTEMPT_STORE_BUDGET_MS);
        return req;
      },
    } as unknown as IDBFactory;
    const door = nativeDoor();
    const bearer = new BearerManager({ storage: memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" }), fetchImpl: door.fetch, idb });
    const answer = bearer.fetch("/sync");
    await vi.advanceTimersByTimeAsync(ATTEMPT_STORE_BUDGET_MS);
    expect((await answer).status).toBe(200);
    await vi.advanceTimersByTimeAsync(ATTEMPT_STORE_BUDGET_MS);
    expect(late.close).toHaveBeenCalled();
    expect(late.transaction, "a late write could only be older").not.toHaveBeenCalled();
    expect(door.presented).toEqual(["refresh-1"]);
  });

  /* A COPY THAT MISSED A WRITE HOLDS AN OLDER NAME: an IndexedDB that hung or failed on the rotation
     whose answer died must not shadow the name that rotation went out under, which the other copies hold. */
  it.each([
    ["hung", "this page"], ["hung", "a reload"], ["failing", "this page"], ["failing", "a reload"],
  ] as const)("IndexedDB %s on the rotation whose answer died: the retry from %s keeps that rotation's name", async (how, where) => {
    const store = wedgeable();
    const door = nativeDoor();
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const bearer = new BearerManager({ storage: jar, fetchImpl: door.fetch, idb: store.idb });
    expect((await bearer.fetch("/sync")).status).toBe(200);
    // refresh-2's window ends; the store misses its rotation's name, and the answer dies after the door rotated.
    door.lapse();
    door.drop("after");
    store.mode = how;
    if (how === "hung") vi.useFakeTimers();
    const lost = bearer.fetch("/sync");
    if (how === "hung") await vi.advanceTimersByTimeAsync(ATTEMPT_STORE_BUDGET_MS);
    expect((await lost).status).toBe(401);
    vi.useRealTimers();
    store.mode = "answers";
    const retry = where === "this page" ? bearer : new BearerManager({ storage: jar, fetchImpl: door.fetch, idb: store.idb });
    expect((await retry.fetch("/sync")).status).toBe(200);
    expect(door.presented).toEqual(["refresh-1", "refresh-2", "refresh-2"]);
    expect(door.names[1], "refresh-2 went out under a name of its own").not.toBe(door.names[0]);
    expect(door.names[2], "the name refresh-2 went out under").toBe(door.names[1]);
    expect(door.swept()).toBe(false);
  });

  it("two names for one token: the newer one goes", async () => {
    // The first was lost before the door read it. A restart whose jar had lost it named the token
    // again while IndexedDB failed, and the door rotated under that newer name; its answer died too.
    const store = wedgeable();
    const door = nativeDoor();
    door.drop("before");
    await new BearerManager({ storage: memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" }), fetchImpl: door.fetch, idb: store.idb }).fetch("/sync");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    store.mode = "failing";
    door.drop("after");
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    await new BearerManager({ storage: jar, fetchImpl: door.fetch, idb: store.idb }).fetch("/sync");
    store.mode = "answers";
    expect((await new BearerManager({ storage: jar, fetchImpl: door.fetch, idb: store.idb }).fetch("/sync")).status).toBe(200);
    expect(door.presented).toEqual(["refresh-1", "refresh-1", "refresh-1"]);
    expect(door.names[1]).not.toBe(door.names[0]);
    expect(door.names[2], "the newer of the two").toBe(door.names[1]);
    expect(door.swept()).toBe(false);
  });

  it("a newer name for a token the jar never kept does not hide the name owed for the token it holds", async () => {
    // refresh-1's name reached disk while its request was in flight and refresh-2 never did; refresh-2's
    // rotation named it in IndexedDB, then the browser died before the door read it.
    const disk = new Map([[REFRESH_STORAGE_KEY, "refresh-1"], [PAIR_SCOPE_STORAGE_KEY, "scope-1"]]);
    const idb = new FakeIDBFactory();
    const door = nativeDoor();
    const before = batchedJar(disk);
    const wire = (url: string, init?: unknown): Promise<Response> => {
      if (url === "/auth/refresh" && door.presented.length === 0) before.commit();
      return door.fetch(url, init);
    };
    const tab = new BearerManager({ storage: before.storage, fetchImpl: wire, idb });
    expect((await tab.fetch("/sync")).status).toBe(200);
    door.lapse();
    door.drop("before");
    expect((await tab.fetch("/sync")).status).toBe(401);
    before.kill();
    expect(door.presented).toEqual(["refresh-1", "refresh-2"]);
    expect(door.names[1], "refresh-2 went out under a name of its own").not.toBe(door.names[0]);

    const restarted = new BearerManager({ storage: batchedJar(disk).storage, fetchImpl: door.fetch, idb });
    expect((await restarted.fetch("/sync")).status).toBe(200);
    expect(door.presented[2]).toBe("refresh-1");
    expect(door.names[2], "the name refresh-1 went out under").toBe(door.names[0]);
    expect(door.swept()).toBe(false);
  });

  it.each(["a named refusal", "a sign-out"] as const)("%s settles every copy of the name, the database included", async (end) => {
    const idb = new FakeIDBFactory();
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const wire = scripted([
      () => json(401, {}), () => new TypeError("network error"),
      ...(end === "a named refusal" ? [() => json(401, {}), () => refusal("refresh_revoked")] : [() => new Response(null, { status: 204 })]),
    ]);
    const bearer = new BearerManager({ storage: jar, fetchImpl: wire.fetch, idb });
    await bearer.fetch("/sync");
    expect(await databases(idb), "the control: the name was written").toContain(REFRESH_ATTEMPT_DB);
    if (end === "a named refusal") await bearer.fetch("/sync");
    else await bearer.logout();
    expect(bearer.paired()).toBe(false);
    expect(jarNames(jar)).toEqual([null, null]);
    await vi.waitFor(async () => expect(await databases(idb)).not.toContain(REFRESH_ATTEMPT_DB));
  });

  it("a fresh pairing leaves no name behind, even for the same token string", async () => {
    const idb = new FakeIDBFactory();
    const names: string[] = [];
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const bearer = new BearerManager({ storage: jar, fetchImpl: lossyDoor(names, { answer: "lost" }), idb });
    await bearer.fetch("/sync");
    bearer.adopt({ accessToken: "access-0", refreshToken: "refresh-1" }, { fresh: true });
    expect(jarNames(jar)).toEqual([null, null]);
    await bearer.fetch("/sync");
    expect(names).toHaveLength(2);
    expect(names[1], "a new pairing never presents the previous one's name").not.toBe(names[0]);
  });

  it("re-paired in another tab while IndexedDB hung: nothing is presented, this tab stands down, the new pairing is untouched", async () => {
    vi.useFakeTimers();
    const door = nativeDoor();
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    const tab = new BearerManager({ storage: jar, fetchImpl: door.fetch, idb: hungIdb });
    let died = 0;
    tab.onSessionDead(() => died++);
    const answer = tab.fetch("/sync");
    await vi.advanceTimersByTimeAsync(10);
    const other = new BearerManager({ storage: jar, fetchImpl: door.fetch, idb: null });
    other.adopt({ accessToken: "b-1", refreshToken: "r-b" }, { fresh: true });
    await vi.advanceTimersByTimeAsync(ATTEMPT_STORE_BUDGET_MS);
    expect((await answer).status).toBe(401);
    expect(door.presented).toEqual([]);
    expect(died).toBe(1);
    expect(tab.paired()).toBe(false);
    expect(jar.getItem(REFRESH_STORAGE_KEY), "the successor's token").toBe("r-b");
    expect(jar.getItem(PAIR_SCOPE_STORAGE_KEY)).toBe(other.pairScope());
    expect(jarNames(jar), "the stale tab wrote the new pairing's jar").toEqual([null, null]);
  });

  it("re-paired in another tab while the name's write was in flight: nothing is presented or written over", async () => {
    const real = new FakeIDBFactory();
    const door = nativeDoor();
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1" });
    let opens = 0;
    const idb = {
      open: (name: string, version?: number) => {
        // The second open is the write's: another tab redeems a new pairing just then.
        opens += 1;
        if (opens === 2) {
          new BearerManager({ storage: jar, fetchImpl: door.fetch, idb: real })
            .adopt({ accessToken: "b-1", refreshToken: "r-b" }, { fresh: true });
        }
        return real.open(name, version);
      },
      deleteDatabase: (name: string) => real.deleteDatabase(name),
    } as unknown as IDBFactory;
    const tab = new BearerManager({ storage: jar, fetchImpl: door.fetch, idb });
    let died = 0;
    tab.onSessionDead(() => died++);
    expect((await tab.fetch("/sync")).status).toBe(401);
    expect(opens, "the control: the write was under way").toBe(2);
    expect(door.presented).toEqual([]);
    expect(died).toBe(1);
    expect(jar.getItem(REFRESH_STORAGE_KEY), "the successor's token").toBe("r-b");
    expect(await storedRecord(real), "the old pairing's name in the new pairing's store").toBeNull();
  });

  it("a bare name an older build left is resumed for the token the jar holds, and only for it", async () => {
    const idb = new FakeIDBFactory();
    const door = nativeDoor();
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-1", [REFRESH_ATTEMPT_STORAGE_KEY]: "rlegacy-1" });
    expect((await new BearerManager({ storage: jar, fetchImpl: door.fetch, idb }).fetch("/sync")).status).toBe(200);
    door.lapse();
    expect((await new BearerManager({ storage: jar, fetchImpl: door.fetch, idb }).fetch("/sync")).status).toBe(200);
    expect(door.names[0]).toBe("rlegacy-1");
    expect(door.names[1], "refresh-2 is a new attempt").not.toBe("rlegacy-1");
  });

  it("no copy holds a token: the record is a name, a mark and a time", async () => {
    const idb = new FakeIDBFactory();
    const jar = memoryStorage({ [REFRESH_STORAGE_KEY]: "refresh-never-stored" });
    const wire = scripted([() => json(401, {}), () => new TypeError("network error")]);
    await new BearerManager({ storage: jar, fetchImpl: wire.fetch, idb }).fetch("/sync");
    const [bare, kept] = jarNames(jar) as [string, string];
    const stored = JSON.stringify(await storedRecord(idb));
    expect(Object.keys(JSON.parse(kept) as object).sort()).toEqual(["at", "id", "mark"]);
    expect(JSON.parse(stored)).toEqual(JSON.parse(kept));
    expect(bare).toBe(jarId(kept));
    for (const copy of [bare, kept, stored]) expect(copy).not.toContain("refresh-never-stored");
  });
});
