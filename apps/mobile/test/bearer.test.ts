/**
 * ═══ THE BEARER MANAGER ON RN — the desktop rotation machine, held to the same contract ══════
 *
 * A port of `apps/desktop/test/host-client-bearer.test.ts`, case for case, with the two RN
 * substitutions under test instead of the browser's:
 *
 *  · storage is the async VAULT (the profile store's keystore slot), not localStorage — so the
 *    suite asserts vault writes/clears, and that the access token never reaches the vault;
 *  · there is NO multi-tab case and NO navigator.locks — one runtime, one presenter. The
 *    desktop's "another tab already rotated" test has no analogue here BY DESIGN; what replaces
 *    it is the census in pairing.test.ts proving the seam never references the Locks API at all.
 *
 * The four properties that carry the file are the desktop's own:
 *  · Authorization is stamped by the MANAGER on every attempt, absolute against the origin;
 *  · a 401 rotates ONCE and replays ONCE, single-flighted (double presentation reads as theft);
 *  · a refresh REFUSAL (a 401 naming the door's code) is definitive — vault cleared, dead signal,
 *    no retry loop — while any other answer, a NETWORK failure or a 503 clears NOTHING;
 *  · recovery is generation-bound: a STALE 401 restamps and replays without rotating again.
 */
import { describe, expect, it } from "vitest";
import { BearerManagerRN, type BearerTokens, type RefreshVault } from "../src/net/bearer";

/** An inspectable vault — what the keystore slot sees, and when. */
function memoryVault() {
  const saves: string[] = [];
  const armed: string[] = [];
  let cleared = 0;
  const vault: RefreshVault = {
    save: async (t) => {
      saves.push(t);
      return "landed";
    },
    clear: async () => {
      cleared += 1;
      return "landed";
    },
    armAttempt: async (a) => {
      armed.push(a);
      return "landed";
    },
  };
  return { vault, saves, armed, clearedCount: () => cleared };
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A scripted fetch: each call records what it saw and pops the next answer. */
function scripted(answers: Array<(seen: Seen) => Response | Error>) {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url: string, init?: unknown): Promise<Response> => {
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

/** A captive portal or a firewall answering in the server's place: its own HTML, no envelope. */
const portalPage = (status: number): Response =>
  new Response("<!doctype html><title>Sign in to Wi-Fi</title><form action=/login></form>", {
    status, headers: { "content-type": "text/html" },
  });

/** The refresh door's refusal, in the envelope `packages/services` throws it with. */
const refusal = (code: string, status = 401): Response => json(status, { error: { code, message: "refused" } });

const ORIGIN = "http://host.example:8028";
const ROTATED: BearerTokens = { accessToken: "access-2", refreshToken: "refresh-2" };

function manager(opts: {
  access?: string | null;
  refresh?: string | null;
  fetch: (url: string, init?: unknown) => Promise<Response>;
  vault?: RefreshVault;
}) {
  return new BearerManagerRN({
    origin: ORIGIN,
    accessToken: opts.access ?? null,
    refreshToken: opts.refresh === undefined ? "refresh-1" : opts.refresh,
    vault: opts.vault ?? memoryVault().vault,
    fetchImpl: opts.fetch,
  });
}

describe("adoption and the stamp", () => {
  it("persists the refresh token to the vault, keeps the access token OUT of it, and stamps every request", async () => {
    const { vault, saves } = memoryVault();
    const wire = scripted([() => json(200, { ok: true })]);
    const bearer = manager({ refresh: null, fetch: wire.fetch, vault });
    expect(bearer.paired()).toBe(false);

    await bearer.adopt({ accessToken: "access-1", refreshToken: "refresh-1" });
    expect(bearer.paired()).toBe(true);
    expect(saves).toEqual(["refresh-1"]);
    // The access token reaches MEMORY only — no vault write ever carries it.
    for (const s of saves) expect(s).not.toContain("access-1");

    await bearer.fetch(`${ORIGIN}/sync`);
    expect(wire.seen[0]!.headers.authorization).toBe("Bearer access-1");
  });

  it("a cold app launch holds the refresh token alone and is paired without an access token", () => {
    const bearer = manager({ fetch: scripted([]).fetch });
    expect(bearer.paired()).toBe(true);
    // No access yet, so no Authorization — the first 401 buys one. The erased-answer declaration
    // rides every ask (`erased-account-forgets-the-pairing.test.ts`).
    expect(bearer.headers()).toEqual({ "x-ohmail-accepts": "account_erased" });
  });
});

describe("the 401 recovery", () => {
  it("rotates once against the ORIGIN's refresh route, replays once, and persists the new refresh token", async () => {
    const { vault, saves } = memoryVault();
    const wire = scripted([
      (s) => {
        expect(s.headers.authorization).toBeUndefined();
        return json(401, { error: { code: "unauthorized" } });
      },
      (s) => {
        // Absolute, not root-relative: there is no served origin on this platform.
        expect(s.url).toBe(`${ORIGIN}/auth/refresh`);
        // The wire carries the token AND the name of this attempt — the two fields the door
        // admits. Read apart rather than as one literal: the id is minted, and a pin that spells
        // it would be pinning the mint rather than the shape.
        const sent = JSON.parse(s.body!) as { refreshToken?: string; attemptId?: string };
        expect(sent.refreshToken).toBe("refresh-1");
        expect(typeof sent.attemptId, "every attempt is named on the wire").toBe("string");
        expect(Object.keys(sent).sort()).toEqual(["attemptId", "refreshToken"]);
        // The rotation itself carries no Authorization — there is nothing valid to carry.
        expect(s.headers.authorization).toBeUndefined();
        return json(200, { tokens: ROTATED });
      },
      (s) => {
        expect(s.headers.authorization).toBe("Bearer access-2");
        return json(200, { items: [] });
      },
    ]);
    const bearer = manager({ fetch: wire.fetch, vault });
    const res = await bearer.fetch(`${ORIGIN}/mailboxes`);
    expect(res.status).toBe(200);
    expect(saves).toEqual(["refresh-2"]);
    expect(wire.seen.map((s) => s.url)).toEqual([
      `${ORIGIN}/mailboxes`,
      `${ORIGIN}/auth/refresh`,
      `${ORIGIN}/mailboxes`,
    ]);
  });

  it("rotation is SINGLE-FLIGHTED: two concurrent 401s present the refresh token exactly once", async () => {
    let refreshCalls = 0;
    const wire = {
      fetch: async (url: string, init?: unknown): Promise<Response> => {
        const i = (init ?? {}) as { headers?: Record<string, string> };
        if (url.endsWith("/auth/refresh")) {
          refreshCalls++;
          await new Promise((r) => setTimeout(r, 20)); // both 401s are in flight before it lands
          return json(200, { tokens: ROTATED });
        }
        const auth = Object.entries(i.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
        return auth === "Bearer access-2" ? json(200, { ok: true }) : json(401, {});
      },
    };
    const bearer = manager({ fetch: wire.fetch });
    const [a, b] = await Promise.all([bearer.fetch(`${ORIGIN}/sync`), bearer.fetch(`${ORIGIN}/threads`)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // ONE presentation. Two would be the reuse signal that revokes the family server-side.
    expect(refreshCalls).toBe(1);
  });

  it("a second 401 after a fresh rotation is returned, never looped", async () => {
    const wire = scripted([
      () => json(401, {}),
      () => json(200, { tokens: ROTATED }),
      () => json(401, {}), // still refused with a token minted milliseconds ago — a revocation
    ]);
    const bearer = manager({ fetch: wire.fetch });
    const res = await bearer.fetch(`${ORIGIN}/sync`);
    expect(res.status).toBe(401);
    expect(wire.seen).toHaveLength(3);
  });

  it("a STALE 401 — judged against a token a rotation already replaced — retries without rotating again", async () => {
    let refreshCalls = 0;
    let releaseB!: () => void;
    const bHeld = new Promise<void>((r) => {
      releaseB = r;
    });
    const wire = {
      fetch: async (url: string, init?: unknown): Promise<Response> => {
        const i = (init ?? {}) as { headers?: Record<string, string> };
        const auth = Object.entries(i.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
        if (url.endsWith("/auth/refresh")) {
          refreshCalls++;
          return json(200, { tokens: { accessToken: "access-2", refreshToken: "refresh-2" } });
        }
        if (url.endsWith("/b") && auth === undefined) {
          // B's FIRST answer is held until A's whole recovery is done, then says 401 — the
          // stale refusal, judged against the pre-rotation stamp.
          await bHeld;
          return json(401, {});
        }
        return auth === "Bearer access-2" ? json(200, {}) : json(401, {});
      },
    };
    const bearer = manager({ fetch: wire.fetch });
    const b = bearer.fetch(`${ORIGIN}/b`);
    const a = await bearer.fetch(`${ORIGIN}/a`);
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
  it("a 401 from the refresh clears the vault, fires the dead signal, and answers the original 401", async () => {
    const { vault, clearedCount } = memoryVault();
    const wire = scripted([
      () => json(401, {}),
      () => json(401, { error: { code: "unauthorized", message: "this session cannot be resumed" } }),
    ]);
    const bearer = manager({ fetch: wire.fetch, vault });
    let died = 0;
    bearer.onSessionDead(() => died++);
    const res = await bearer.fetch(`${ORIGIN}/sync`);
    expect(res.status).toBe(401);
    expect(died).toBe(1);
    expect(bearer.paired()).toBe(false);
    expect(clearedCount()).toBe(1);
  });

  /* ONLY THE REFRESH DOOR'S OWN VERDICT ENDS THE SESSION: a 401 naming one of its codes. A Wi-Fi
     sign-in page, a firewall's 403 or a proxy's 401 used to sign the phone out. MUTATION: judge
     by status alone in `readRefreshAnswer` — the first table reddens. */
  it.each<[string, () => Response]>([
    ["a 403 Wi-Fi sign-in page", () => portalPage(403)],
    ["a 401 page from a proxy", () => portalPage(401)],
    ["a 401 with a foreign JSON body", () => json(401, { message: "Unauthorized" })],
    ["a 403 naming a refusal code", () => refusal("refresh_revoked", 403)],
    ["a 200 sign-in page", () => portalPage(200)],
    ["a 200 with no token pair", () => json(200, { ok: true })],
  ])("%s at the refresh keeps the session", async (_what, answer) => {
    const { vault, clearedCount } = memoryVault();
    const wire = scripted([() => json(401, {}), answer]);
    const bearer = manager({ fetch: wire.fetch, vault });
    let died = 0;
    bearer.onSessionDead(() => died++);
    const res = await bearer.fetch(`${ORIGIN}/sync`);
    expect(res.status).toBe(401);
    expect(died).toBe(0);
    expect(bearer.paired()).toBe(true);
    expect(clearedCount()).toBe(0);
  });

  it.each<[string, number]>([
    ["refresh_missing", 401], ["refresh_expired", 401], ["refresh_revoked", 401], ["unauthorized", 401],
  ])("the server's %s signs out", async (code, status) => {
    const { vault, clearedCount } = memoryVault();
    const wire = scripted([() => json(401, {}), () => refusal(code, status)]);
    const bearer = manager({ fetch: wire.fetch, vault });
    let died = 0;
    bearer.onSessionDead(() => died++);
    await bearer.fetch(`${ORIGIN}/sync`);
    expect(died).toBe(1);
    expect(bearer.paired()).toBe(false);
    expect(clearedCount()).toBe(1);
  });

  it("after a sign-in page, the next 401 retries the SAME attempt and adopts its answer", async () => {
    const { vault, saves } = memoryVault();
    const refreshes: Array<{ refreshToken?: string; attemptId?: string }> = [];
    const wire = scripted([
      () => json(401, {}),
      (s) => { refreshes.push(JSON.parse(s.body ?? "{}")); return portalPage(403); },
      () => json(401, {}),
      (s) => { refreshes.push(JSON.parse(s.body ?? "{}")); return json(200, { tokens: ROTATED }); },
      (s) => json(s.headers.authorization === "Bearer access-2" ? 200 : 401, { ok: true }),
    ]);
    const bearer = manager({ fetch: wire.fetch, vault });
    expect((await bearer.fetch(`${ORIGIN}/sync`)).status).toBe(401);
    expect((await bearer.fetch(`${ORIGIN}/sync`)).status).toBe(200);
    expect(refreshes.map((r) => r.refreshToken)).toEqual(["refresh-1", "refresh-1"]);
    expect(refreshes[1]!.attemptId).toBe(refreshes[0]!.attemptId);
    expect(saves).toEqual(["refresh-2"]);
  });

  it("a 503 from the refresh clears NOTHING — admission is not an authentication judgment", async () => {
    // The listener answers 503 host_busy BEFORE the handler reads the token, so the token was
    // never consumed and the pairing is still valid. Clearing it here signs a working phone
    // out because the laptop was busy.
    const { vault, clearedCount } = memoryVault();
    const wire = scripted([
      () => json(401, {}),
      () => json(503, { error: { code: "host_busy", message: "retry shortly" } }),
    ]);
    const bearer = manager({ fetch: wire.fetch, vault });
    let died = 0;
    bearer.onSessionDead(() => died++);
    const res = await bearer.fetch(`${ORIGIN}/sync`);
    expect(res.status).toBe(401);
    expect(died).toBe(0);
    expect(bearer.paired()).toBe(true);
    expect(clearedCount()).toBe(0);
  });

  it("a NETWORK failure during the rotation clears nothing — the token was never presented", async () => {
    const { vault, clearedCount } = memoryVault();
    const wire = scripted([() => json(401, {}), () => new TypeError("Network request failed")]);
    const bearer = manager({ fetch: wire.fetch, vault });
    let died = 0;
    bearer.onSessionDead(() => died++);
    const res = await bearer.fetch(`${ORIGIN}/sync`);
    expect(res.status).toBe(401);
    expect(died).toBe(0);
    expect(bearer.paired()).toBe(true);
    expect(clearedCount()).toBe(0);
  });
});

describe("logout", () => {
  /**
   * NEVER A RENEWAL TO SIGN OUT. The logout renewed to buy an access token for `/auth/logout`, and a
   * renewal whose answer was lost, or that failed, left the family live with a fresh tail nobody
   * held. The refresh door ends the family any of its tokens names, so the held token goes there.
   */
  it("a cold logout presents the refresh token at the refresh door, and it LANDS", async () => {
    const { vault, clearedCount } = memoryVault();
    const wire = scripted([
      (s) => {
        expect(s.url).toBe(`${ORIGIN}/auth/refresh/logout`);
        expect(s.headers.authorization).toBeUndefined(); // cold launch: no access token yet
        expect(JSON.parse(s.body!)).toEqual({ refreshToken: "refresh-1" });
        return new Response(null, { status: 204 });
      },
    ]);
    const bearer = manager({ fetch: wire.fetch, vault });
    let died = 0;
    bearer.onSessionDead(() => died++);
    // …and it ANSWERS that it landed. The return value is what a forget reports on: the
    // credential this call destroys is the only thing that could ever retry the logout, and the
    // logout is what revokes the session and takes this device's wake registration down.
    expect(await bearer.logout()).toBe(true);
    expect(wire.seen).toHaveLength(1);
    expect(bearer.paired()).toBe(false);
    expect(clearedCount()).toBeGreaterThan(0);
    expect(died).toBe(1);
  });

  it("after a rotation whose answer was lost: the bearer's 401, then the refresh door — never a renewal", async () => {
    const wire = scripted([
      () => json(401, {}),
      () => new TypeError("network error"),
      () => refusal("unauthorized"),
      () => new Response(null, { status: 204 }),
    ]);
    const bearer = manager({ access: "access-1", fetch: wire.fetch });
    expect((await bearer.fetch(`${ORIGIN}/sync`)).status, "the rotation's answer never arrived").toBe(401);
    expect(await bearer.logout()).toBe(true);
    expect(wire.seen.map((s) => [s.url.slice(ORIGIN.length), s.headers.authorization ?? null])).toEqual([
      ["/sync", "Bearer access-1"], ["/auth/refresh", null],
      ["/auth/logout", "Bearer access-1"], ["/auth/refresh/logout", null],
    ]);
    expect(JSON.parse(wire.seen[3]!.body!)).toEqual({ refreshToken: "refresh-1" });
  });

  it("a server older than the refresh door (404, 405) gets the routed sign-out it always had", async () => {
    for (const old of [404, 405]) {
      const wire = scripted([
        () => new Response(null, { status: old }),
        () => json(401, {}),
        () => json(200, { tokens: ROTATED }),
        (s) => {
          expect(s.headers.authorization).toBe("Bearer access-2"); // the replay is authenticated
          return new Response(null, { status: 204 });
        },
      ]);
      expect(await manager({ fetch: wire.fetch }).logout(), `door ${old}`).toBe(true);
      expect(wire.seen.map((s) => s.url.slice(ORIGIN.length)))
        .toEqual(["/auth/refresh/logout", "/auth/logout", "/auth/refresh", "/auth/logout"]);
    }
  });

  it("says the server was NOT told when it answered a 5xx, or did not answer at all", async () => {
    // The status was not read at all: a 500, a 503 and a dead network all cleared the local half
    // and reported nothing, so `forgetProfile` could report a completed forget over a session
    // that was never revoked — with the credential already gone, so nothing could retry it.
    for (const answer of [500, 503] as const) {
      const wire = scripted([() => new Response(null, { status: answer })]);
      const bearer = manager({ fetch: wire.fetch, vault: memoryVault().vault });
      expect(await bearer.logout(), `status ${answer}`).toBe(false);
      // The LOCAL half still happened — a device taking its own credential back must not be
      // blocked by an unreachable server. Only the CLAIM changes.
      expect(bearer.paired()).toBe(false);
    }
    const dead = manager({
      fetch: (() => Promise.reject(new Error("network down"))) as never,
      vault: memoryVault().vault,
    });
    expect(await dead.logout()).toBe(false);
    expect(dead.paired()).toBe(false);
  });

  it("a refresh door that answers no verdict is not told: the credential may still be live", async () => {
    // A 401 at the bearer door says only that the access token was replaced. What the refresh door
    // answers decides, and a 401 with no envelope of ours is something in front of the server.
    const wire = scripted([
      () => refusal("unauthorized"),
      () => new Response(null, { status: 401 }),
    ]);
    const bearer = manager({ access: "access-1", fetch: wire.fetch, vault: memoryVault().vault });
    expect(await bearer.logout()).toBe(false);
  });

  it("the refresh door's own 401 counts as TOLD — the family it would end is already gone", async () => {
    // The outcome being asked for is "this session no longer exists", and the door's 401 is the
    // server saying exactly that. Treating it as a failure would make a forget report a partial
    // take-back over a completed one, which is the same class of lie pointed the other way.
    const wire = scripted([() => refusal("unauthorized")]);
    const bearer = manager({ fetch: wire.fetch, vault: memoryVault().vault });
    expect(await bearer.logout()).toBe(true);
    expect(bearer.paired()).toBe(false);
  });

  it("an older server: the dead signal fires ONCE when the routed sign-out's refusal and the logout both end it", async () => {
    // The routed logout can die INSIDE its own recovery (refresh refused); the logout's final
    // clear must then be a no-op, not a second funeral.
    const wire = scripted([
      () => new Response(null, { status: 404 }), // no refresh door on this server
      () => json(401, {}), // the unauthenticated logout attempt
      () => refusal("refresh_revoked"), // the refresh is refused — the session dies here
    ]);
    const bearer = manager({ fetch: wire.fetch });
    let died = 0;
    bearer.onSessionDead(() => died++);
    expect(await bearer.logout(), "a 401 with no credential left is already gone").toBe(true);
    expect(died).toBe(1);
    expect(bearer.paired()).toBe(false);
  });

  it("tells the door at the ORIGIN, then clears — and clears even when the door is unreachable", async () => {
    const { vault, clearedCount } = memoryVault();
    const wire = scripted([
      (s) => {
        expect(s.url).toBe(`${ORIGIN}/auth/logout`);
        expect(s.headers.authorization).toBe("Bearer access-1");
        return new Response(null, { status: 204 });
      },
    ]);
    const bearer = manager({ access: "access-1", fetch: wire.fetch, vault });
    await bearer.logout();
    expect(bearer.paired()).toBe(false);
    expect(clearedCount()).toBe(1);

    const offline = manager({
      access: "access-1",
      fetch: scripted([() => new TypeError("offline")]).fetch,
    });
    await offline.logout();
    expect(offline.paired()).toBe(false);
  });
});
