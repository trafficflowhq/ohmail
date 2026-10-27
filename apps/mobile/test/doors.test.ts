/**
 * ═══ THE PHONE'S THREE DOORS, AND THE SELF-HOSTED ONE PROVEN END TO END ════════════════════════
 *
 * The desktop learned to ask "which mailbox is this?" with three answers. The phone's entry screens
 * predated all of it: one scan button, with two of the product's three doors filed under "other
 * ways to connect", and — behind that — a self-hosted arm that could pair and then never mirror a
 * single message.
 *
 * This suite holds three things:
 *
 *  1. **THE DEFECT, REPRODUCED.** A real pairing seam against a loopback stack wearing the shipped
 *     self-host route split (`helpers/selfhost-split.ts`, whose route list is read off
 *     `deploy/selfhost/proxy/Caddyfile`). `/hello`, `/pair/redeem` and `/auth/session` answer at the bare
 *     path; `/sync` answers `404 text/html` from the web container. The pairing therefore SUCCEEDS
 *     and the drain must still work — which it only does because the base was measured.
 *  2. **THE DERIVATION.** `resolveApiBase` picks the bare origin where the API is there (the two
 *     doors that already worked, so nothing about them moves) and `<origin>/api` where it is not,
 *     and refuses with a sentence where it is neither.
 *  3. **THE CLAIMS ON THE DOOR SCREEN.** Each door's sentence is a statement about what happens,
 *     and the three that could go stale are pinned to the facts that make them true.
 */
import { createServer } from "node:http";
import { refuse, sayRefusal } from "../src/refusal";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mirrorDbName } from "@ohmail/client-engine";
import { Copy, DECKS } from "../src/copy";
import type { MobileEngineDeps } from "../src/engine/boot";
import { bootEngine } from "../src/engine/boot";
import { connectProfileById, type PairingEnv } from "../src/net/pairing";
import {
  addressProblem,
  apiBaseFor,
  parseServerAddress,
  PROBE_DEADLINE_MS,
  resolveApiBase,
} from "../src/net/server-base";
import type { FetchLike } from "../src/net/bearer";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { listen, pairServer, pairThroughConfirm, sqlWorld } from "./helpers/pair-server";
import {
  apiPathsFromCaddyfile,
  caddyRouteFiles,
  dropOneApiPrefix,
  matchesCaddyPath,
  selfHostSplit,
  SELFHOST_DIR,
} from "./helpers/selfhost-split";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * ── THE GENERATED ANDROID PROJECT IS NOT IN THE TREE, AND A CHECK MUST NOT ASSUME IT IS ─────
 *
 * `apps/mobile/android` is an Expo prebuild output and `apps/mobile/.gitignore` ignores it. It
 * exists in a checkout somebody has run a build in and in NO fresh clone or worktree, so a case
 * that read `AndroidManifest.xml` unconditionally failed with `ENOENT` in every clean tree — a
 * hard red that looks exactly like a broken door and is in fact a missing build artifact.
 *
 * The manifest is also the wrong thing to hold the claim against, for a reason that outlives the
 * ENOENT: it is DERIVED. What decides whether this app opts into user certificate authorities is
 * the tracked configuration the prebuild reads, so that is what the assertion is made from, and
 * the generated file is a second opinion consulted only when it happens to be there.
 */
const MANIFEST = fileURLToPath(
  new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url),
);
const HAS_PREBUILD = existsSync(MANIFEST);
/**
 * A skip that SAYS SO. Silence on a missing artifact is how a check that verifies nothing looks
 * from the outside, so the reason travels in the case's own name and shows up in the run.
 */
const ifPrebuilt = HAS_PREBUILD ? it : it.skip;
const PREBUILD_NOTE = HAS_PREBUILD
  ? ""
  : " [SKIPPED: no Expo prebuild in this tree — apps/mobile/android is generated and gitignored]";
if (!HAS_PREBUILD) {
  /* THE NAME IS NOT ENOUGH ON ITS OWN. The default reporter prints "1 skipped" and no title, so a
     reader of a green run cannot tell which check did not run or why. This line is the difference
     between a skip and a silence. */
  console.info(
    "doors.test.ts: the generated-manifest case did not run — no Expo prebuild at "
    + "apps/mobile/android. The claim it seconds is asserted from app.json and the local config "
    + "plugins, which are tracked; run `expo prebuild` to get the second opinion as well.",
  );
}

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

function testEnv(): {
  env: PairingEnv;
  world: ReturnType<typeof sqlWorld>;
  profiles: ServerProfileStore;
  /** The raw keystore — the only way to write a row in a SHAPE an older build produced. */
  kv: SecureKV;
} {
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  const kv = memoryKV();
  const profiles = new ServerProfileStore(kv);
  return { env: { profiles, engineDeps: deps }, world, profiles, kv };
}

/**
 * REWRITE A STORED PROFILE THE WAY A BUILD THAT PREDATES `apiBase` WROTE IT — the field simply
 * absent from the JSON.
 *
 * Through the raw keystore rather than the store's API, deliberately: there is no method that
 * un-measures a base, and there should not be. What is being simulated is a row written by other
 * code, so it is written as other code would have — and the pairing that produced its CREDENTIAL is
 * a real one, because a planted refresh token is not one any server will honour.
 */
async function dropApiBase(kv: SecureKV, id: string): Promise<void> {
  const key = `ohmail.servers.v1.${id}`;
  const raw = await kv.get(key);
  if (raw === null) throw new Error(`no stored profile ${id}`);
  const body = JSON.parse(raw) as Record<string, unknown>;
  delete body.apiBase;
  await kv.set(key, JSON.stringify(body));
}

/** Everything opened in a case, closed after it — a leaked listener hangs the whole file. */
const shutdown: (() => void)[] = [];
afterEach(() => {
  while (shutdown.length > 0) shutdown.pop()?.();
});

/**
 * A self-host stack: the API double behind the shipped route split, both listening.
 *
 * `sessionRoute` is on because the standalone server mounts `/auth/session` — which is precisely
 * why the old code's failure was invisible. That route is in the Caddyfile's bare-path set, so the
 * pairing could name the account and looked entirely healthy.
 */
async function selfHostStack(opts: { flavor?: string } = {}) {
  const api = pairServer({ flavor: opts.flavor ?? "selfhost", sessionRoute: true });
  const upstream = await listen(api.server);
  const split = selfHostSplit(upstream);
  const origin = await listen(split.server);
  shutdown.push(() => split.server.close(), () => api.server.close());
  return { api, split, origin, upstream };
}

/* ── 1. the split itself, derived from the shipped deployment ───────────────────────────────── */

describe("the self-host route split, read off the shipped front door", () => {
  it("routes the ceremony at the bare path and the sync family only under /api", () => {
    const paths = apiPathsFromCaddyfile();
    const toApi = (p: string) => paths.some((pattern) => matchesCaddyPath(pattern, p));

    // The ceremony — every request `pairWithServer` makes before the drain.
    for (const p of ["/hello", "/pair/redeem", "/auth/refresh", "/auth/session", "/auth/logout"]) {
      expect(toApi(p), `${p} must reach the API at the bare path`).toBe(true);
    }
    // The drain — and this is the whole asymmetry. A pairing can complete without these.
    for (const p of ["/sync", "/sync/snapshot", "/sync/pull"]) {
      expect(toApi(p), `${p} must NOT reach the API at the bare path`).toBe(false);
      expect(toApi(`/api${p}`), `/api${p} must reach the API`).toBe(true);
    }
  });

  it("drops exactly one /api, so /api/api/x still 404s", () => {
    expect(dropOneApiPrefix("/api/sync")).toBe("/sync");
    expect(dropOneApiPrefix("/sync")).toBe("/sync");
    expect(dropOneApiPrefix("/api/api/sync")).toBe("/api/sync");
    expect(dropOneApiPrefix("/api")).toBe("/");
  });

  /*
   * ═══ THE READ FOLLOWS THE DOOR'S OWN IMPORT ══════════════════════════════════════════════
   *
   * "a second front door, for a TLS terminator the stack does not own" moved the route table out
   * of the Caddyfile into `routes.caddy`, which both doors import. This helper still named the
   * Caddyfile, so eleven of this file's cases refused — the parse threw rather than returning a
   * short list, which is the one thing that behaved. The read is derived now, and these cases are
   * what keep it derived: which files are read, that a matcher in the IMPORTED file is found, and
   * that a stack carrying the matcher NOWHERE is refused rather than guessed at.
   */
  it("reads the shipped door and every route file it imports", () => {
    const files = caddyRouteFiles().map((f) => f.path);
    expect(files[0], "the door itself is not the first file read").toMatch(/\/Caddyfile$/);
    expect(files.some((f) => f.endsWith("/routes.caddy")),
      "the door's own import was not followed, so a moved route table reads as no routes").toBe(true);
    expect(files.every((f) => f.startsWith(SELFHOST_DIR))).toBe(true);
  });

  it("finds the matcher in the imported file, not only in the door", () => {
    /* The shipped arrangement asserted as a property rather than as a filename: the door carries
       no matcher of its own, and the paths still come back. */
    const door = readFileSync(join(SELFHOST_DIR, "Caddyfile"), "utf8");
    expect(door, "the door carries the matcher again — this case has stopped proving anything")
      .not.toMatch(/^\s*@api path /m);
    expect(apiPathsFromCaddyfile()).toContain("/hello");
  });

  it("REFUSES a stack whose door and imports carry no matcher at all", () => {
    /* Every case above is the positive control; this is the refusal. An empty list here would send
       every path to the web container, and the pairing itself would still pass. */
    const dir = mkdtempSync(join(tmpdir(), "ohmail-caddy-"));
    try {
      writeFileSync(join(dir, "Caddyfile"), "{$ORIGIN} {\n\timport /etc/caddy/routes.caddy\n}\n");
      writeFileSync(join(dir, "routes.caddy"), "handle {\n\treverse_proxy web:3000\n}\n");
      expect(() => apiPathsFromCaddyfile(dir))
        .toThrow(/no "@api path" matcher in .*Caddyfile or .*routes\.caddy/);
      /* …and the same refusal when the import names a file the tree does not carry. */
      rmSync(join(dir, "routes.caddy"));
      expect(() => apiPathsFromCaddyfile(dir)).toThrow(/no "@api path" matcher/);
      /* The positive control over the same fixture: the matcher in the IMPORTED file is found. */
      writeFileSync(join(dir, "routes.caddy"), "@api path /hello /pair/*\nhandle @api {\n}\n");
      expect(apiPathsFromCaddyfile(dir)).toEqual(["/hello", "/pair/*"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


/* ── 2. the derivation ──────────────────────────────────────────────────────────────────────── */

describe("resolveApiBase — the phone measures where a server's mail API is", () => {
  /* The seam's own transport type — `FetchLike` widens `init` to `unknown`, which the global
     `fetch` signature does not match structurally. The app composes the same cast in
     `connection.tsx`, so the test drives exactly what ships. */
  const fetchImpl = globalThis.fetch.bind(globalThis) as FetchLike;
  /* The probe's deadline on a fake clock, the sockets on real ones: `until` spends REAL turns
     while the virtual clock stands still, so a deadline fires only when the test moves it. */
  const until = async (ready: () => boolean): Promise<void> => {
    while (!ready()) await new Promise((r) => setImmediate(r));
  };

  it("a one-origin self-host stack resolves to <origin>/api", async () => {
    const { origin } = await selfHostStack();
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("base");
    if (verdict.kind !== "base") return;
    expect(verdict.base).toBe(apiBaseFor(origin));
    expect(verdict.prefixed).toBe(true);
  });

  /**
   * THE DOORS THAT ALREADY WORKED DO NOT MOVE, and this is the compatibility assertion.
   *
   * The hosted service and a desktop host both serve their route table at the root of the address
   * the pairing names. The bare probe is tried FIRST and wins, so their base is the origin — the
   * same string every stored profile already holds. A change that reordered the probes would move
   * every working pairing onto a path it had never used, and it would show up here.
   */
  it("a server whose API is at its root resolves to the origin, unprefixed", async () => {
    const api = pairServer({ flavor: "desktop-host" });
    const origin = await listen(api.server);
    shutdown.push(() => api.server.close());
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("base");
    if (verdict.kind !== "base") return;
    expect(verdict.base).toBe(origin);
    expect(verdict.prefixed).toBe(false);
  });

  it("something that answers but is not an ohmail API is refused with a sentence, not a base", async () => {
    // The web container alone: every path answers 404 HTML, including `/api/sync`. That is a box
    // running something else, and the honest end is a sentence naming what was looked for.
    const api = pairServer();
    const upstream = await listen(api.server);
    const split = selfHostSplit(upstream);
    // Point the proxy at nothing the matcher will route: an origin with an unreachable upstream
    // still answers 404 HTML for `/sync` and 502 for `/api/sync`, so neither probe finds an API.
    api.server.close();
    const origin = await listen(split.server);
    shutdown.push(() => split.server.close());
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason)).toContain("could not find its mail API");
    expect(sayRefusal(verdict.reason)).toContain("/api");
  });

  /* ── the three the review round hardened ─────────────────────────────────────────────────── */

  /**
   * A JSON-ERROR IDIOM IS NOT THE API. The check used to accept any `{"error":{"code":<string>}}`,
   * so a component that is not the ohmail API but answers in that shape could claim the path and
   * take the bearer that followed. `"unauthorized"` is what the request guard actually says.
   */
  it("a 401 whose code is not the guard's own is not the API", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "forbidden_by_something_else", message: "no" } }));
    });
    const origin = await listen(server);
    shutdown.push(() => server.close());
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("refused");
  });

  /**
   * AN ANSWER THAT CAME FROM SOMEWHERE ELSE IS NOT THIS SERVER'S API.
   *
   * `fetch` follows redirects, so an origin can answer the probe with a redirect to any other
   * address — turning a credential-free GET into a request the phone makes on somebody else's
   * behalf, and letting the redirect TARGET satisfy the discriminator. The response's final URL
   * must still be on the candidate's origin.
   *
   * The redirect target here IS a real ohmail-shaped 401, which is the point: without the check the
   * verdict would be "base found" and every drain would go to a server the person never named.
   */
  it("a probe redirected to another origin does not establish a base", async () => {
    const elsewhere = pairServer({ flavor: "managed" });
    const elsewhereOrigin = await listen(elsewhere.server);
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `${elsewhereOrigin}/sync` });
      res.end();
    });
    const origin = await listen(redirector);
    shutdown.push(() => redirector.close(), () => elsewhere.server.close());
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    // Whatever the sentence, it must not have adopted the other origin.
    expect(JSON.stringify(verdict)).not.toContain(elsewhereOrigin);
  });

  /**
   * …AND THE SAME REDIRECT ON A PLATFORM THAT IGNORES `redirect: "manual"`.
   *
   * THE CASE ABOVE PASSED FOR THE WRONG REASON, and the mutation pass is what found it: deleting the
   * final-URL origin check left it GREEN. Node's undici honours `redirect: "manual"`, so the 302 is
   * never followed, the status is not 401, and the probe is refused by the status check alone — the
   * origin guard is never consulted.
   *
   * React Native's fetch does not honour that flag on every version, and that is precisely the
   * platform this code ships to. So the transport is injected here to behave the way RN does: it
   * FOLLOWS the redirect and hands back the target's real response, with `Response.url` naming the
   * target as the platform would. On that transport the status IS 401 and the body IS the API's own
   * refusal — everything except the address it came from — so the origin check is the only thing
   * standing between a scanned QR and a base on a server the person never named.
   */
  it("a followed redirect is refused on its final origin, the way RN's transport behaves", async () => {
    const elsewhere = pairServer({ flavor: "managed" });
    const elsewhereOrigin = await listen(elsewhere.server);
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `${elsewhereOrigin}/sync` });
      res.end();
    });
    const origin = await listen(redirector);
    shutdown.push(() => redirector.close(), () => elsewhere.server.close());

    /**
     * A transport that IGNORES `redirect: "manual"` — one RN version's behaviour, made explicit.
     *
     * The FOLLOWED response is handed back whole rather than reconstructed, and that detail is
     * load-bearing: a `new Response(...)` has an EMPTY `url`, which `answeredFromCandidate` reads as
     * "no information" and lets through by design (the documented residual). Returning the real
     * response is what gives it the target address to refuse, which is what a platform that reports
     * a final URL actually does.
     */
    const followsAnyway: FetchLike = (async (url: string) => {
      const first = await fetch(url, { redirect: "manual" });
      const location = first.headers.get("location");
      if (location === null) return first;
      return fetch(location);
    }) as unknown as FetchLike;
    // The injected transport really does deliver the API's own 401 — otherwise this case would
    // again be passing on the status check rather than on the origin.
    const proof = await (followsAnyway as unknown as (u: string, i?: unknown) => Promise<Response>)(
      `${origin}/sync`,
    );
    expect(proof.status, "the injected transport must deliver a real 401").toBe(401);
    expect(((await proof.json()) as { error?: { code?: string } }).error?.code).toBe("unauthorized");

    const verdict = await resolveApiBase(followsAnyway, origin);
    expect(verdict.kind, "a 401 from another origin must not establish a base").toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(JSON.stringify(verdict)).not.toContain(elsewhereOrigin);
  });

  /**
   * A TRANSPORT FAILURE ON ONE CANDIDATE MUST NOT END THE SEARCH.
   *
   * The first version returned immediately on any thrown fetch, under a claim that a transport
   * failure is about the origin rather than the path. True of DNS and of a handshake; false of a
   * reset on one route — and this server is exactly that: the bare path destroys the socket, and
   * `/api/sync` is a perfectly healthy API. A self-hoster behind such a proxy would have been
   * refused before the candidate that works was ever tried.
   */
  it("the prefixed candidate is still tried after the bare one fails at the transport", async () => {
    const api = pairServer({ flavor: "selfhost", sessionRoute: true });
    const upstream = await listen(api.server);
    const split = selfHostSplit(upstream);
    const inner = await listen(split.server);
    const resetting = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/sync")) {
        // Kill the connection: the client sees a transport failure, not a status.
        res.socket?.destroy();
        return;
      }
      void (async () => {
        const up = await fetch(`${inner}${req.url ?? "/"}`);
        const body = Buffer.from(await up.arrayBuffer());
        const h: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (!["content-length", "transfer-encoding", "connection"].includes(k)) h[k] = v;
        });
        res.writeHead(up.status, h);
        res.end(body);
      })();
    });
    const origin = await listen(resetting);
    shutdown.push(() => resetting.close(), () => split.server.close(), () => api.server.close());

    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind === "base" ? "base" : sayRefusal(verdict.reason)).toBe("base");
    if (verdict.kind !== "base") return;
    expect(verdict.base).toBe(apiBaseFor(origin));
    expect(verdict.prefixed).toBe(true);
  });

  /**
   * THE THIRD REDIRECT GUARD: a platform that FOLLOWED one and says so, but reports no final URL.
   *
   * This case exists because the mutation pass found nothing held that guard, and it could not: node
   * honours `redirect: "manual"`, so `Response.redirected` is always false here, and the
   * follows-anyway transport above returns a direct fetch of the target, which is also not
   * "redirected". The guard is for a platform shape node cannot produce — so the shape is
   * CONSTRUCTED, which is the honest way to test a platform contract rather than a network.
   *
   * The response handed back is the API's exact 401, `redirected: true`, and `url: ""` — an empty
   * final URL being read as "no information" by design (the documented residual). Without this
   * guard the empty URL lets it through and a foreign answer establishes the base; with it, the
   * platform's own admission that it followed a redirect is enough to refuse.
   */
  it("a response that admits it was redirected is refused even with no final URL", async () => {
    const forged: FetchLike = (async () => {
      const res = new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
      // `redirected` and `url` are read-only accessors; the platform sets them and a test that
      // wants to BE that platform has to define them.
      Object.defineProperty(res, "redirected", { value: true });
      Object.defineProperty(res, "url", { value: "" });
      return res;
    }) as unknown as FetchLike;

    const verdict = await resolveApiBase(forged, "https://ohmail.example.com");
    expect(verdict.kind, "a followed redirect must not establish a base").toBe("refused");
  });

  /* ── the four that review round 2 raised ─────────────────────────────────────────────────── */

  /**
   * A SERVER THAT ACCEPTS AND NEVER ANSWERS MUST NOT HANG THE PAIRING.
   *
   * The same hazard `IDENTITY_PROBE_DEADLINE_MS` exists for: an unbounded `await` is not ended by
   * anything. This probe runs inside `pairWithServer`, which a screen awaits behind a "Pairing…"
   * label — and on a self-host stack the bare `/sync` is served by a component that is NOT the API,
   * exactly the sort of route that can be misconfigured into silence.
   *
   * Here the bare path accepts the socket and writes nothing, and `/api/sync` is a healthy API. The
   * derivation must time the first one out and still find the second — a timeout is a transport
   * failure, not a definitive answer.
   */
  it("a candidate that accepts and never answers is timed out, and the other is still tried", async () => {
    const api = pairServer({ flavor: "selfhost", sessionRoute: true });
    const upstream = await listen(api.server);
    const split = selfHostSplit(upstream);
    const inner = await listen(split.server);
    const held: import("node:net").Socket[] = [];
    const silent = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/sync")) {
        // Accept and answer NOTHING, holding the socket open.
        if (res.socket) held.push(res.socket);
        return;
      }
      void (async () => {
        const up = await fetch(`${inner}${req.url ?? "/"}`);
        const body = Buffer.from(await up.arrayBuffer());
        const h: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (!["content-length", "transfer-encoding", "connection"].includes(k)) h[k] = v;
        });
        res.writeHead(up.status, h);
        res.end(body);
      })();
    });
    const origin = await listen(silent);
    shutdown.push(
      () => { for (const s of held) s.destroy(); },
      () => silent.close(),
      () => split.server.close(),
      () => api.server.close(),
    );

    // A SHORT deadline, the `identityDeadlineMs` seam's idiom: what is under test is that a
    // deadline EXISTS and that a timed-out candidate does not end the search. The default's value
    // is pinned by its own case below, so the override cannot hide a shipped change.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const t0 = Date.now();
      const asked: number[] = [];
      const seeing: FetchLike = ((url: string, init?: unknown) => {
        asked.push(Date.now() - t0);
        return fetchImpl(url, init);
      }) as unknown as FetchLike;
      let settled = false;
      const pending = resolveApiBase(seeing, origin, { deadlineMs: 400 }).finally(() => { settled = true; });
      await until(() => held.length === 1);
      // BOUNDED, and at the deadline itself: one tick short the silent candidate still holds the
      // search, and the deadline alone moves it on — the healthy one then answers with no clock.
      await vi.advanceTimersByTimeAsync(399);
      expect(settled, "the silent candidate was given up before its deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const verdict = await pending;
      expect(verdict.kind === "base" ? "base" : sayRefusal(verdict.reason)).toBe("base");
      if (verdict.kind !== "base") return;
      expect(verdict.base).toBe(apiBaseFor(origin));
      expect(asked, "the healthy candidate was asked before the silent one's deadline").toEqual([0, 400]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("the shipped deadline is the identity probe's own number, not a test override", () => {
    expect(PROBE_DEADLINE_MS).toBe(8000);
  });

  /**
   * …AND THE DEADLINE COVERS THE BODY, NOT ONLY THE HEADERS.
   *
   * The first deadline bounded the fetch alone, and review round 3 named the hole: a server that
   * returns `401 application/json` HEADERS inside the deadline and then never finishes the BODY
   * defeats it completely — the timer is cleared and the controller discarded by the time the body
   * is read, so the pairing stalls exactly as it did before, one layer in.
   *
   * This server answers the headers immediately and then trickles nothing, for ever, on BOTH
   * candidates. The derivation must give up and say what happened, rather than hanging.
   */
  it("headers inside the deadline and a body that never ends is still bounded", async () => {
    const held: import("node:net").Socket[] = [];
    const trickling = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      // A body that is started and never finished: no `end()`, ever.
      res.write('{"error":{"code":');
      if (res.socket) held.push(res.socket);
    });
    const origin = await listen(trickling);
    shutdown.push(() => { for (const s of held) s.destroy(); }, () => trickling.close());

    // BOUNDED on both candidates, each at its own deadline: the headers are in hand before the
    // clock moves, so what the deadline ends is the BODY — the hole this case exists for.
    const headed: Response[] = [];
    const seeing: FetchLike = (async (url: string, init?: unknown) => {
      const res = await fetchImpl(url, init);
      headed.push(res);
      return res;
    }) as unknown as FetchLike;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let verdict: Awaited<ReturnType<typeof resolveApiBase>>;
    try {
      let settled = false;
      const pending = resolveApiBase(seeing, origin, { deadlineMs: 400 }).finally(() => { settled = true; });
      for (const n of [1, 2]) {
        await until(() => headed.length === n);
        await vi.advanceTimersByTimeAsync(399);
        expect(settled, `candidate ${n}'s stalled body was given up before its deadline`).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      verdict = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    // The stall gets its OWN sentence, and the AFTER-HEADERS one: this server did start answering,
    // so "could not reach that server" would be false and would send somebody to their wifi.
    expect(sayRefusal(verdict.reason)).toContain("started answering and then stopped");
    expect(sayRefusal(verdict.reason)).not.toContain("could not reach that server");
  }, 30_000);

  /**
   * A STALLED BODY IS ABORTED — and this case was written believing something else first.
   *
   * The first version asserted that the orphaned response's stream is CANCELLED, and it failed: by
   * the time the deadline fires, `res.json()` has locked the body, and `cancel()` on a locked
   * stream throws — which the release helper swallows, so it is a no-op in precisely the case it
   * was added for. The code's comment claimed a release that never happened, and only running the
   * assertion showed it.
   *
   * What actually frees a stalled body is the `abort()` the timer fires: an honoured signal
   * terminates the body stream and makes the pending read reject. So THAT is what is asserted —
   * the signal is raised, for every candidate, while a body hangs. A platform that ignores the
   * signal leaks until collection, which is the residual the code now states rather than papers
   * over.
   */
  it("a stalled body raises the abort signal on every candidate", async () => {
    const aborted: boolean[] = [];
    const stalling: FetchLike = ((_url: string, init?: unknown) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener("abort", () => aborted.push(true));
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('{"error":{"code":')); /* never closed */ },
      });
      return Promise.resolve(
        new Response(body, { status: 401, headers: { "content-type": "application/json" } }),
      );
    }) as unknown as FetchLike;

    const verdict = await resolveApiBase(stalling, "https://ohmail.example.com", { deadlineMs: 300 });
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    // Headers arrived on both candidates, so this is the after-headers sentence.
    expect(sayRefusal(verdict.reason)).toContain("started answering and then stopped");
    expect(aborted, "both candidates' stalled bodies must be aborted").toHaveLength(2);
  }, 30_000);

  /**
   * THE DEADLINE'S OWN ERROR WINS EVEN WHERE THE ABORT REJECTS FIRST — round 4's second finding.
   *
   * `abort()` can synchronously reject the in-flight fetch with an `AbortError`, and whichever
   * rejection reaches the race first decides the error the caller sees. An `AbortError` arriving
   * there is classified as a TRANSPORT failure, which produces "could not reach that server" about
   * a server that was perfectly reachable and simply never answered.
   *
   * The code defends twice — it rejects before aborting, AND reclassifies any error raised after
   * the deadline fired. Neither mutation alone reddened anything, because each was covered by the
   * other; this transport forces the abort-wins ordering so the reclassification is the only thing
   * standing, which is the state a platform with a synchronous abort actually puts it in.
   */
  it("an abort that beats the timer is still reported as a stall, not as unreachable", async () => {
    const abortsFirst: FetchLike = ((_url: string, init?: unknown) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as FetchLike;

    const verdict = await resolveApiBase(abortsFirst, "https://ohmail.example.com", { deadlineMs: 200 });
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason)).toContain("did not answer in time");
    expect(sayRefusal(verdict.reason), "an abort is the deadline, not a dead network")
      .not.toContain("could not reach that server");
    expect(sayRefusal(verdict.reason)).not.toContain("AbortError");
  }, 30_000);

  /**
   * A CANDIDATE THAT ANSWERED ITS HEADERS COUNTS AS HAVING REACHED THE SERVER — round 4's third.
   *
   * The mixed case, and the only one that separates the two flags: the bare candidate returns
   * headers and then stalls, and the prefixed one fails at the transport. Without an after-headers
   * stall setting `reached`, the transport branch fires and says "could not reach that server"
   * about a server whose headers this app had in hand — which `isPinFailure` can then dress up as a
   * changed certificate.
   */
  it("headers on one candidate and a reset on the other is not an unreachable server", async () => {
    const held: import("node:net").Socket[] = [];
    const mixed = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/api/sync")) {
        res.socket?.destroy();          // the prefixed candidate: a transport failure
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.write('{"error":{"code":');   // the bare candidate: headers, then silence
      if (res.socket) held.push(res.socket);
    });
    const origin = await listen(mixed);
    shutdown.push(() => { for (const s of held) s.destroy(); }, () => mixed.close());

    const verdict = await resolveApiBase(fetchImpl, origin, { deadlineMs: 400 });
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason), "its headers arrived, so it was plainly reached")
      .not.toContain("could not reach that server");
    expect(sayRefusal(verdict.reason)).toContain("started answering and then stopped");
  }, 30_000);

  /**
   * A DEADLINE THAT FIRES WITH NOTHING RECEIVED IS A DIFFERENT SENTENCE — round 4's fourth finding.
   *
   * "That server started answering and then stopped" is true of a stalled BODY and false of a
   * connection that never produced a header: that may be DNS, a TCP connect or a TLS negotiation
   * hanging silently, and pointing an operator at their proxy for a connectivity problem is the
   * same class of misdirection as calling a reached server unreachable.
   */
  it("a stall BEFORE any headers does not claim the server started answering", async () => {
    const held: import("node:net").Socket[] = [];
    const mute = createServer((_req, res) => {
      // Accept, and never write a byte — not even a status line.
      if (res.socket) held.push(res.socket);
    });
    const origin = await listen(mute);
    shutdown.push(() => { for (const s of held) s.destroy(); }, () => mute.close());

    const verdict = await resolveApiBase(fetchImpl, origin, { deadlineMs: 400 });
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason)).toContain("did not answer in time");
    expect(sayRefusal(verdict.reason), "nothing arrived, so this would be a claim about what did")
      .not.toContain("started answering");
    // And still not a reachability claim, which is the sentence `isPinFailure` can dress up.
    expect(sayRefusal(verdict.reason)).not.toContain("could not reach that server");
  }, 30_000);

  /**
   * A SAME-ORIGIN REDIRECT MUST NOT VALIDATE THE CANDIDATE IT CAME FROM.
   *
   * Review round 3's second finding. `<origin>/sync` answering `302 → <origin>/api/sync` passes an
   * ORIGIN check, so the BARE base would be stored on the strength of the prefixed candidate's
   * answer — a base whose own probe never succeeded. Later requests pay for it: a proxy that
   * redirects `/sync` need not redirect `/sync/snapshot`, and a 301/302 turns an authenticated POST
   * into a GET, so the mutation surface breaks in a way the pairing never showed.
   *
   * The transport here follows the redirect and reports the final URL, as a platform that ignores
   * `redirect: "manual"` does. The whole-URL comparison is the only thing that separates the two
   * candidates — and the RIGHT answer is still reachable, because `/api/sync` is probed directly
   * afterwards and answers without a redirect.
   */
  it("a same-origin redirect validates the path it landed on, not the one it came from", async () => {
    const api = pairServer({ flavor: "selfhost", sessionRoute: true });
    const upstream = await listen(api.server);
    const split = selfHostSplit(upstream);
    const inner = await listen(split.server);
    const redirecting = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/sync") {
        // Same origin, different path — the shape an origin-only check cannot see.
        res.writeHead(302, { location: "/api/sync" });
        res.end();
        return;
      }
      void (async () => {
        const up = await fetch(`${inner}${url}`);
        const body = Buffer.from(await up.arrayBuffer());
        const h: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (!["content-length", "transfer-encoding", "connection"].includes(k)) h[k] = v;
        });
        res.writeHead(up.status, h);
        res.end(body);
      })();
    });
    const origin = await listen(redirecting);
    shutdown.push(() => redirecting.close(), () => split.server.close(), () => api.server.close());

    /** Follows redirects and reports the final URL — the RN platform this guard is for. */
    const follows: FetchLike = (async (url: string) => {
      const first = await fetch(url, { redirect: "manual" });
      const location = first.headers.get("location");
      if (location === null) return first;
      return fetch(new URL(location, url).href);
    }) as unknown as FetchLike;

    const verdict = await resolveApiBase(follows, origin);
    expect(verdict.kind === "base" ? "base" : sayRefusal(verdict.reason)).toBe("base");
    if (verdict.kind !== "base") return;
    // The PREFIXED base — reached directly — not the bare one the redirect came from.
    expect(verdict.base).toBe(apiBaseFor(origin));
    expect(verdict.prefixed).toBe(true);
  });

  /**
   * A TRANSPORT FAILURE ON ONE PATH MUST NOT BE REPORTED AS AN UNREACHABLE SERVER.
   *
   * The bare path resets; `/api/sync` answers definitively and is NOT an ohmail API. The server was
   * plainly reached, so "could not reach that server" would be false — and a false sentence
   * `isPinFailure` may then dress up as "this computer's identity has changed", sending somebody to
   * look for a key that never changed.
   *
   * A genuine pin or handshake failure fails BOTH candidates (one socket, one certificate), which
   * is the case the transport sentence IS for and which the dead-address case below covers.
   */
  it("a server reached on one path is not described as unreachable", async () => {
    const answering = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/sync")) {
        res.socket?.destroy();
        return;
      }
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html>not the api</html>");
    });
    const origin = await listen(answering);
    shutdown.push(() => answering.close());
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    /* THE MIXED SENTENCE, and it is more precise than the one this case first asserted. It used to
       expect "could not find its mail API — neither at the address itself nor under /api", which
       review round 5 showed is FALSE here: the reset candidate was never classified at all and may
       be exactly where the API is. "Neither" is only a true word when both were disproved. */
    expect(sayRefusal(verdict.reason)).toContain("answered and was not its mail API");
    expect(sayRefusal(verdict.reason)).toContain("the other could not be reached");
    expect(sayRefusal(verdict.reason), "one address answered, so nothing was disproved at the other")
      .not.toContain("neither at the address itself");
    expect(sayRefusal(verdict.reason), "the server answered, so this sentence would be false")
      .not.toContain("could not reach that server to find its mail API");
  });

  /**
   * A BODY THAT FAILED TO TRANSFER IS NOT A DISPROOF — review round 6's second finding.
   *
   * The API answers its 401 JSON headers and the connection then resets mid-body. That disproves
   * nothing: the API may be exactly here. Reading it as "definitively not the API" let a transient
   * failure on the RIGHT candidate produce the sentence saying both addresses had been ruled out —
   * sending an operator to change proxy routing that was already correct.
   *
   * The other candidate answers HTML, so it IS disproved; the honest verdict is the mixed one.
   */
  it("a connection reset mid-body is a transport failure, not a disproof", async () => {
    const resetting = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/api/sync")) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html>not the api</html>");
        return;
      }
      // The API's own headers, a partial body, and then the socket dies.
      res.writeHead(401, { "content-type": "application/json" });
      res.write('{"error":{"code":"unau');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const origin = await listen(resetting);
    shutdown.push(() => resetting.close());

    const verdict = await resolveApiBase(fetchImpl, origin, { deadlineMs: 3_000 });
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason), "the reset candidate was never disproved")
      .not.toContain("neither at the address itself");
    expect(sayRefusal(verdict.reason)).toContain("could not be reached");
  }, 30_000);

  /**
   * …WHILE BODY BYTES THAT ARRIVED AND DID NOT PARSE *ARE* A DISPROOF.
   *
   * The other half of the same discrimination, and the reason it is a `SyntaxError` check rather
   * than a blanket re-throw: whatever answered with unparseable bytes is not the API's envelope,
   * and treating that as a transport failure would report a box that is plainly not ohmail as one
   * that could not be reached.
   */
  it("a 401 whose JSON does not parse is a disproof, not a transport failure", async () => {
    const garbage = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("this is not json at all");
    });
    const origin = await listen(garbage);
    shutdown.push(() => garbage.close());
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason), "both answered, so both were disproved")
      .toContain("neither at the address itself");
    expect(sayRefusal(verdict.reason)).not.toContain("could not be reached");
  });

  /**
   * A 401 WHOSE BODY IS A JSON PRIMITIVE IS A DISPROOF, NOT A TRANSPORT FAILURE — round 7.
   *
   * `null` is valid JSON. A body of exactly `null` parses fine and then throws on the property
   * access, and under the parse-versus-transfer discrimination a thrown `TypeError` is a transport
   * failure — so two fully received responses could produce "could not reach that server". The body
   * arrived; it is simply not the envelope.
   */
  it("a 401 whose body is JSON null is a disproof, not an unreachable server", async () => {
    for (const body of ["null", "42", '"a string"']) {
      const primitive = createServer((_req, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(body);
      });
      const origin = await listen(primitive);
      try {
        const verdict = await resolveApiBase(fetchImpl, origin);
        expect(verdict.kind, body).toBe("refused");
        if (verdict.kind !== "refused") return;
        expect(sayRefusal(verdict.reason), body).toContain("neither at the address itself");
        expect(verdict.reason, body).not.toContain("could not reach that server");
      } finally {
        primitive.close();
      }
    }
  });

  /**
   * "NEITHER" IS ONLY SAID WHERE BOTH CANDIDATES WERE ACTUALLY DISPROVED.
   *
   * The counterpart to the mixed case above: here both addresses answer definitively and neither is
   * an ohmail API, which is the one state in which the word is true.
   */
  it("both candidates classified and neither the API is the only 'neither' sentence", async () => {
    const notOhmail = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html>a router admin page</html>");
    });
    const origin = await listen(notOhmail);
    shutdown.push(() => notOhmail.close());
    const verdict = await resolveApiBase(fetchImpl, origin);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason)).toContain("neither at the address itself nor under /api");
  });

  /**
   * A TRANSPORT THAT THROWS SYNCHRONOUSLY MUST NOT LEAVE AN UNHANDLED REJECTION — round 5's first.
   *
   * `fetchImpl` is a seam, and a seam can throw rather than reject: a binding that has not been
   * installed, a transport that rejects a malformed URL by throwing, a test double. The throw
   * reaches the caller correctly either way — but the deadline timer is already armed, and if the
   * throw escapes before the `finally` is installed, that timer later rejects a promise nobody is
   * waiting on. In React Native that is an unhandled rejection: a red box in development, and worse
   * on some runtimes.
   *
   * The assertion is the absence of an unhandled rejection over a window longer than the deadline,
   * which is the only way to observe it — the verdict itself was always correct.
   */
  it("a transport that throws synchronously leaves no unhandled rejection behind", async () => {
    const throwsSync: FetchLike = (() => {
      throw new Error("no transport installed");
    }) as unknown as FetchLike;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const verdict = await resolveApiBase(throwsSync, "https://ohmail.example.com", { deadlineMs: 50 });
      expect(verdict.kind).toBe("refused");
      if (verdict.kind !== "refused") return;
      expect(sayRefusal(verdict.reason)).toContain("could not reach that server");
      expect(vi.getTimerCount(), "an armed timer must not outlive the call").toBe(0);
      // Past the deadline on the fake clock, which is when an orphaned timer would fire, plus real
      // turns for the rejection to be reported as unhandled.
      await vi.advanceTimersByTimeAsync(300);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      expect(unhandled, "an armed timer must not outlive the call").toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", onUnhandled);
    }
  }, 30_000);

  it("a dead address is one sentence about the origin, not two about paths", async () => {
    // Both probes ride the same socket and the same certificate, so a transport failure has
    // nothing the second could learn — it reports once and names the platform's words, which is
    // what lets the pairing seam recognise a pin failure in them.
    const verdict = await resolveApiBase(fetchImpl, "http://127.0.0.1:1");
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(sayRefusal(verdict.reason)).toContain("could not reach that server");
  });
});

/* ── 3. the address parse, and its sentences ────────────────────────────────────────────────── */

describe("the address step — one parse, shared with the desktop's third door", () => {
  it("completes a bare host to https and nothing else", () => {
    expect(parseServerAddress("ohmail.example.com")).toBe("https://ohmail.example.com");
    expect(parseServerAddress("  HTTPS://OhMail.Example.com/  ")).toBe("https://ohmail.example.com");
    expect(parseServerAddress("https://ohmail.example.com:8443")).toBe("https://ohmail.example.com:8443");
  });

  it("refuses cleartext to a network address, and says so as its own sentence", () => {
    expect(parseServerAddress("http://ohmail.example.com")).toBeNull();
    const said = sayRefusal(addressProblem("http://ohmail.example.com")!);
    expect(said).toContain("plain, unencrypted");
    // NOT the shape sentence: this address is perfectly well formed and is refused for safety.
    expect(said).not.toContain("does not look like a server address");
  });

  it("refuses a path, a query, a fragment and embedded credentials with the shape sentence", () => {
    for (const bad of [
      "https://ohmail.example.com/api",
      "https://ohmail.example.com?x=1",
      "https://ohmail.example.com#f",
      "https://me:pw@ohmail.example.com",
      "not an address",
    ]) {
      expect(parseServerAddress(bad), bad).toBeNull();
      expect(sayRefusal(addressProblem(bad)!), bad).toContain("does not look like a server address");
    }
  });

  it("an empty field is its own sentence", () => {
    expect(sayRefusal(addressProblem("   ")!)).toContain("address is missing");
  });

  /**
   * THE CLEARTEXT SENTENCE IS ONLY GIVEN WHERE THE SCHEME IS ACTUALLY THE REASON.
   *
   * Review round 3's fifth finding, and it is a claims-are-contracts one. `http://localhost/path`
   * is refused for its PATH — cleartext to loopback is explicitly allowed, so `http://localhost:8080`
   * is accepted. Naming the scheme there is a false explanation, and its remedy ("give the https
   * address") does not fix the address.
   */
  it("an http address refused for its SHAPE is not blamed on the scheme", () => {
    // Loopback + a path: the path is the fault, and http is not.
    const said = sayRefusal(addressProblem("http://localhost/path")!);
    expect(said).toContain("does not look like a server address");
    expect(said, "the scheme is not why this was refused").not.toContain("unencrypted");
    // …while cleartext to a NETWORK address still gets the safety sentence, because there the
    // scheme really is the only thing wrong.
    expect(sayRefusal(addressProblem("http://ohmail.example.com")!)).toContain("unencrypted");
    // …and plain loopback is still accepted outright.
    expect(addressProblem("http://localhost:8080")).toBeNull();
  });

  /**
   * A REMEDY HAS TO SURVIVE BEING TAKEN — review round 4's fifth finding.
   *
   * "Give the https address" is right for `http://mail.example.com` and useless for
   * `http://192.168.1.20`: the https spelling of a numeric address parses, so that branch offered
   * it, and typing exactly what was asked for hit the pin requirement and was refused again. A
   * remedy that leads to a second refusal is worse than none, because the person has now done what
   * they were told.
   */
  it("a cleartext NUMERIC address is not told to use https, which would be refused too", () => {
    const said = sayRefusal(addressProblem("http://192.168.1.20")!);
    expect(said).toContain("code your computer shows");
    expect(said, "https is not the remedy for an address that needs a pin")
      .not.toContain("Give the https address");
    // And the https spelling it would have recommended really is refused, which is why.
    expect(sayRefusal(addressProblem("https://192.168.1.20")!)).toBe(said);
  });

  it("loopback keeps http, because a request that never leaves the phone has no path to be on", () => {
    expect(parseServerAddress("http://localhost:8080")).toBe("http://localhost:8080");
    expect(addressProblem("http://localhost:8080")).toBeNull();
  });

  /**
   * A NUMERIC ADDRESS PARSES AND IS STILL REFUSED, WITH THE USEFUL SENTENCE.
   *
   * `https://192.168.1.20:8028` is a perfectly well-formed origin and a perfectly ordinary thing
   * to type — it is the address a router handed a computer on the same network. No certificate
   * authority issues for it, so the only trust available is a pin, and a pin comes from the code
   * that computer shows (43 characters nobody types correctly). `admitOrigin` refuses it at pairing
   * time and says exactly that.
   *
   * Without this arm the door probed it, the probe failed at the handshake, and the person was told
   * the server could not be reached — true, useless, and about the wrong thing. The remedy belongs
   * at the field that took the address.
   */
  it("a numeric address is refused at the field, pointing at the code rather than at the network", () => {
    for (const ip of ["https://192.168.1.20:8028", "10.0.2.2", "https://[2001:db8::1]"]) {
      // It PARSES — that is the point; this is not a shape refusal.
      expect(parseServerAddress(ip), ip).not.toBeNull();
      const said = sayRefusal(addressProblem(ip)!);
      expect(said, ip).toContain("Devices");
      expect(said, ip).toContain("code your computer shows");
      expect(said, ip).not.toContain("does not look like a server address");
    }
    // A DNS name is unaffected — the platform's own trust store judges it, as it does a website.
    expect(addressProblem("https://ohmail.example.com")).toBeNull();
  });

  /**
   * ONE DEFINITION, TWO PROGRAMS. The parse is `apps/sidecar/src/cloud-origin.ts`'s, imported by
   * relative path exactly as `apps/desktop/src/self-host.ts` imports it — that file is written
   * import-free so both can, and so a mutation in it reddens both suites rather than one.
   *
   * A census rather than a behavioural test, because the property being held is "there is no second
   * copy of this rule", which no amount of input/output agreement can establish.
   *
   * ── AND IT NAMES THE RULE, NOT `new URL` ──────────────────────────────────────────────────────
   *
   * This banned `new URL(` outright, which was a PROXY for the property and a bad one. The file now
   * uses `new URL` legitimately, to compare a response's final origin against the candidate's
   * (the redirect guard), and that is not a copy of anything — it is asking the platform what an
   * origin is, which is exactly what `cloud-origin.ts` does rather than guessing with a regexp.
   *
   * So the assertion names the ACCEPTANCE RULE itself: which schemes are allowed, which shapes are
   * refused, and what counts as loopback. Every one of those decisions lives in the imported file
   * and none may be restated here. That is a tighter statement of the same property, and it does not
   * go green just because somebody stopped using a constructor.
   */
  it("the parse is the desktop's file, not a second copy of its rule", () => {
    const source = read("../src/net/server-base.ts");
    expect(source).toContain("../../../sidecar/src/cloud-origin.js");
    // The scheme and shape refusals — `cloud-origin.ts`'s clauses, none of them restated here.
    for (const clause of [
      /protocol\s*!==/,
      /\.search\s*!==/,
      /\.hash\s*!==/,
      /\.username\s*!==/,
      /\.pathname\s*!==/,
    ]) {
      expect(source, `the acceptance rule must not be restated: ${clause}`).not.toMatch(clause);
    }
    // …and loopback, which is the one clause a reader is most tempted to re-derive.
    expect(source).not.toMatch(/isLoopback|127\\\.|\.localhost/);
    // The comparison that IS allowed here is a whole-URL equality, and it is named as such.
    expect(source).toContain("answeredFromRequest");
  });
});

/* ── 4. the defect, reproduced: pair AND drain against the split ────────────────────────────── */

describe("a self-hosted stack: the pairing completes AND the mirror fills", () => {
  /**
   * THE WHOLE SLICE, IN ONE CASE.
   *
   * Before the base was measured this test would have passed its first half and failed its second:
   * the redeem answers at the bare path, `/auth/session` names the account, the profile is stored
   * and the engine boots — and then every drain would have fetched an HTML 404 from the web
   * container. The `seen` census on the proxy is what makes that visible rather than inferred: the
   * ceremony's paths went to the API at the bare path, and every `/sync` went there under `/api`.
   */
  it("pairs at the bare path, drains under /api, and records the base it measured", async () => {
    const { api, split, origin } = await selfHostStack();
    const { env, profiles } = testEnv();
    api.addMessage("m-1", "from the operator's own server");
    api.mintPairToken("tok-selfhost");

    const outcome = await pairThroughConfirm(env, { origin, token: "tok-selfhost" });
    expect(outcome.kind === "paired" ? "paired" : outcome.reason).toBe("paired");
    if (outcome.kind !== "paired") return;

    // THE BASE IS ON THE PROFILE, so no later launch pays for the probe.
    const [row] = await profiles.list();
    expect(row?.apiBase).toBe(apiBaseFor(origin));
    expect(row?.origin).toBe(origin);
    expect(row?.flavor).toBe("selfhost");

    // AND THE MIRROR FILLS. This is the assertion the shipped build would have failed.
    await outcome.session.verifyIdentity();
    await outcome.session.engine.start();
    expect(outcome.session.engine.read().list("message")).toHaveLength(1);
    outcome.session.store.close();

    // The census: which container answered what.
    const ceremony = split.seen.filter((s) => /^\/(hello|pair|auth)/.test(s.path));
    expect(ceremony.length).toBeGreaterThan(0);
    for (const s of ceremony) expect(s.to, s.path).toBe("api");
    /* ── THE WHOLE SYNC-FAMILY CENSUS, SPLIT BY WHETHER IT CARRIED A CREDENTIAL ──────────────
       Two credential-free requests: the derivation's own probes, one at the bare path (which the
       WEB container answered, which is the fact the whole slice turns on) and one under `/api`
       (which the API answered). Then every credential-carrying request — the account read's
       snapshot and the engine's drains — went under `/api` and reached the API.

       The bare path being touched once is not a defect to assert away: it IS the measurement.
       What must never happen is a request carrying the bearer going there, because that is the
       request the shipped build made for every drain, for ever, against a container that answers
       HTML. `auth` is what tells the two apart. */
    const sync = split.seen.filter((s) => /^\/(api\/)?sync/.test(s.path));
    const probes = sync.filter((s) => !s.auth);
    expect(probes.map((s) => `${s.path} → ${s.to}`)).toEqual([
      "/sync → web",
      "/api/sync → api",
    ]);
    const drains = sync.filter((s) => s.auth);
    expect(drains.length).toBeGreaterThan(0);
    for (const s of drains) {
      expect(s.path.startsWith("/api/sync"), `${s.path} must be prefixed`).toBe(true);
      expect(s.to, s.path).toBe("api");
    }
  });

  /**
   * THE MIRROR IS NAMED BY THE ORIGIN, NOT BY THE BASE — and this is not a detail.
   *
   * `mirrorOwnerKey(origin, accountId)` names the database. If the base had been substituted for
   * the origin, the same account on the same server would key a DIFFERENT mirror the moment its
   * operator moved the API behind a proxy, and a re-pair would silently re-download the mailbox
   * into a second file while the first sat on the phone holding every header it had.
   */
  it("the mirror is keyed by the origin, so a prefixed API does not fork the copy", async () => {
    const { api, origin } = await selfHostStack();
    const { env, world } = testEnv();
    api.mintPairToken("tok-key");
    const outcome = await pairThroughConfirm(env, { origin, token: "tok-key" });
    if (outcome.kind !== "paired") throw new Error(sayRefusal(outcome.reason));
    expect(outcome.session.ownerKey).toBe(`${origin}::acct-1`);
    expect(outcome.session.ownerKey).not.toContain("/api");
    expect(world.names()).toContain(mirrorDbName(`${origin}::acct-1`));
    outcome.session.store.close();
  });

  /**
   * A COLD LAUNCH SPENDS THE STORED BASE AND PROBES NOTHING.
   *
   * The boot contract is that it touches no wire (`bootEngine`'s header — boot-from-local), and a
   * re-measurement at launch would have quietly broken it for the one door that needed the value.
   * Asserted by the paths the proxy sees on a reconnect: no probe, and the drain already prefixed.
   */
  it("a reconnect uses the stored base without re-probing", async () => {
    const { api, split, origin } = await selfHostStack();
    const { env } = testEnv();
    api.addMessage("m-1", "one");
    api.mintPairToken("tok-cold");
    const first = await pairThroughConfirm(env, { origin, token: "tok-cold" });
    if (first.kind !== "paired") throw new Error(sayRefusal(first.reason));
    const id = first.session.profile.id;
    first.session.store.close();

    split.seen.length = 0;
    const again = await connectProfileById(env, id);
    expect(again.kind === "connected" ? "connected" : again.reason).toBe("connected");
    if (again.kind !== "connected") return;
    // Nothing at all was asked before the engine existed — no /hello, no /sync probe.
    expect(split.seen).toEqual([]);
    await again.session.verifyIdentity();
    await again.session.engine.start();
    expect(again.session.engine.read().list("message")).toHaveLength(1);
    for (const s of split.seen.filter((x) => x.path.includes("sync"))) {
      expect(s.path.startsWith("/api/sync"), s.path).toBe(true);
    }
    again.session.store.close();
  });

  /**
   * THE POPULATION AN UPGRADE COULD NOT FIX BY ITSELF, REPAIRED ON THE NEXT CONNECT.
   *
   * A self-hosted pairing made by a build that predates the measured base is stored with no base,
   * which reads as the origin — and the origin is exactly what never worked. Nothing re-probes, so
   * without this those profiles stay broken for ever: the fix ships and the people it was written
   * for see no change.
   *
   * Gated on `flavor === "selfhost"` AND a null base, which is precisely the set that has never
   * mirrored a message — so the boot-from-local rule loses nothing (there is no cached mirror to
   * paint) and pays one probe, once, after which the base is stored.
   */
  it("a selfhost profile stored without a base measures one on its next connect, once", async () => {
    const { api, split, origin } = await selfHostStack();
    const { env, profiles, kv } = testEnv();
    api.addMessage("m-1", "mail that never arrived before");
    // A REAL pairing, so the credential is one the server minted and will honour…
    api.mintPairToken("tok-old");
    const paired = await pairThroughConfirm(env, { origin, token: "tok-old" });
    if (paired.kind !== "paired") throw new Error(sayRefusal(paired.reason));
    paired.session.store.close();
    const id = paired.session.profile.id;
    // …and then the row is rewritten in the SHAPE an earlier build wrote: no base at all.
    await dropApiBase(kv, id);
    expect((await profiles.list())[0]?.apiBase, "the row now looks like an old one").toBeNull();

    split.seen.length = 0;
    const first = await connectProfileById(env, id);
    expect(first.kind === "connected" ? "connected" : first.reason).toBe("connected");
    if (first.kind !== "connected") return;
    // The repair probed and stored, so the mirror can fill at all.
    expect((await profiles.list())[0]?.apiBase).toBe(apiBaseFor(origin));
    // …and it DID probe: the bare candidate reached the web half, exactly as at pairing time.
    expect(split.seen.some((x) => x.path === "/sync" && !x.auth)).toBe(true);
    await first.session.verifyIdentity();
    await first.session.engine.start();
    expect(first.session.engine.read().list("message")).toHaveLength(1);
    first.session.store.close();

    // ONCE. The next connect is wire-free again — no probe, and the drain already prefixed.
    split.seen.length = 0;
    const again = await connectProfileById(env, id);
    expect(again.kind).toBe("connected");
    if (again.kind !== "connected") return;
    expect(split.seen, "the repair must not run a second time").toEqual([]);
    again.session.store.close();
  });

  /**
   * …AND NO OTHER FLAVOR PAYS FOR IT. A desktop-host or managed row with no base is not broken —
   * its API is at its root — so the boot stays wire-free for it, which is the rule this repair is
   * carved out of rather than an exception to.
   */
  it("a desktop-host profile with no base is not probed at all", async () => {
    const api = pairServer({ flavor: "desktop-host" });
    const origin = await listen(api.server);
    shutdown.push(() => api.server.close());
    const { env, profiles } = testEnv();
    const row = await profiles.add({
      origin, flavor: "desktop-host", accountId: "acct-1", refreshToken: "ref-old",
    });
    api.seen.length = 0;
    const out = await connectProfileById(env, row.id);
    expect(out.kind === "connected" ? "connected" : out.reason).toBe("connected");
    if (out.kind !== "connected") return;
    expect(api.seen, "the boot owes the wire nothing for a door that works").toEqual([]);
    expect((await profiles.list())[0]?.apiBase).toBeNull();
    out.session.store.close();
  });

  /**
   * AN OLD PROFILE — no `apiBase` at all — STILL BOOTS, against the origin.
   *
   * Every row on every phone today is in this state, and they are all on a door whose API is at its
   * root. Reading the absence as anything other than the origin would break the two doors that
   * work in order to fix the one that does not.
   */
  it("a profile written before the base existed boots against the origin", async () => {
    const api = pairServer({ flavor: "desktop-host" });
    const origin = await listen(api.server);
    shutdown.push(() => api.server.close());
    api.addMessage("m-1", "one");
    const { env, profiles } = testEnv();
    // No `apiBase` in the input at all — the shape an earlier build stored.
    const row = await profiles.add({
      origin, flavor: "desktop-host", accountId: "acct-1", refreshToken: "ref-seed",
    });
    expect(row.apiBase).toBeNull();
    const boot = await bootEngine(env.engineDeps, {
      origin, accountId: "acct-1", token: "seed", apiBase: row.apiBase,
    });
    expect(boot.kind).toBe("ready");
  });

  /**
   * A BASE THAT IS NOT DERIVABLE FROM THE ORIGIN IS REFUSED — and this is the sharp one.
   *
   * The base is `HttpAdapter`'s `baseUrl`, so a value naming a foreign address sends the profile's
   * LIVE BEARER there on every drain — while `origin` and `accountId` are untouched, so the mirror's
   * owner stamp and the account guard both pass and nothing else notices. `resolveApiBase` only ever
   * answers one of two values, so anything else reaching the boot came from a corrupted keystore or
   * a hand-composed caller, and a shape check alone does not stop either.
   */
  it("a base on a foreign address is refused, not dialled", async () => {
    const { env } = testEnv();
    for (const hostile of [
      "https://evil.example.com",
      "https://evil.example.com/api",
      "https://ohmail.example.com.evil.test",
      "https://ohmail.example.com/api/api",
      "http://ohmail.example.com",
    ]) {
      const boot = await bootEngine(env.engineDeps, {
        origin: "https://ohmail.example.com",
        accountId: "acct-1",
        token: "seed",
        apiBase: hostile,
      });
      expect(boot.kind, hostile).toBe("refused");
      if (boot.kind !== "refused") return;
      expect(sayRefusal(boot.reason), hostile).toContain("is not on the paired address");
    }
    // …and the two derivable values are the two that are accepted.
    for (const ok of ["https://ohmail.example.com", "https://ohmail.example.com/api"]) {
      const boot = await bootEngine(env.engineDeps, {
        origin: "https://ohmail.example.com", accountId: "acct-1", token: "seed", apiBase: ok,
      });
      expect(boot.kind, ok).toBe("ready");
    }
  });

  it("a stored base that is not an address refuses the boot rather than guessing the origin", async () => {
    const { env } = testEnv();
    const boot = await bootEngine(env.engineDeps, {
      origin: "https://ohmail.example.com",
      accountId: "acct-1",
      token: "seed",
      apiBase: "not an address",
    });
    expect(boot.kind).toBe("refused");
    if (boot.kind !== "refused") return;
    expect(sayRefusal(boot.reason)).toContain("not a server API base");
  });

  /**
   * THE PROBE IS BEFORE THE BURN, and a spent code for a server whose API cannot be found is the
   * cost of getting that order wrong.
   */
  it("a server whose API cannot be found is refused with the pairing token unspent", async () => {
    const api = pairServer();
    const upstream = await listen(api.server);
    const split = selfHostSplit(upstream);
    const origin = await listen(split.server);
    shutdown.push(() => split.server.close(), () => api.server.close());
    const { env, profiles } = testEnv();
    api.mintPairToken("tok-live");

    // The proxy is real but its API's `/hello` answers; break only the sync family by asking for a
    // path the matcher does not route AND that the upstream 404s — i.e. point the probe at a stack
    // whose `/api/*` reaches an API that has no `/sync`. Simulated by closing the upstream after
    // the negotiation: the first probe 404s from the web half and the second cannot be forwarded.
    const before = await resolveApiBase(globalThis.fetch.bind(globalThis) as FetchLike, origin);
    expect(before.kind).toBe("base"); // the healthy stack, for contrast
    api.server.close();

    const outcome = await pairThroughConfirm(env, { origin, token: "tok-live" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    // The redeem was never reached and nothing was stored.
    expect(api.seen.some((r) => r.url === "/pair/redeem")).toBe(false);
    expect(await profiles.list()).toEqual([]);
  });
});

/* ── 5. the door screen's claims ────────────────────────────────────────────────────────────── */

describe("the three doors — the claims, held to the code", () => {
  const doors = read("../src/ui/Doors.tsx");
  const welcome = read("../app/welcome.tsx");
  const servers = read("../app/servers.tsx");

  it("first run asks the chooser's question and offers all three doors", () => {
    expect(Copy.welcomeTitle).toBe("Which mailbox is this?");
    // No door is filed under "other": the deck no longer has a key for it.
    expect(Object.keys(Copy)).not.toContain("welcomeOther");
    for (const name of [Copy.doorCloud, Copy.doorOwnServer, Copy.doorDesktop]) {
      expect(name.length).toBeGreaterThan(0);
    }
    expect(welcome).toContain("<Doors");
    expect(servers).toContain("<Doors");
  });

  it("ONE implementation behind both surfaces — no second vocabulary for one decision", () => {
    // The address field, the parse and the probe exist in the shared component and nowhere else.
    expect(doors).toContain("addressProblem");
    expect(doors).toContain("conn.probeBase");
    for (const screen of [welcome, servers]) {
      expect(screen).not.toContain("addressProblem");
      expect(screen).not.toContain("probeBase");
      expect(screen).not.toContain("TextInput");
    }
  });

  it("the Cloud door names the web step a new account takes, and offers no sign-up or purchase", () => {
    expect(DECKS.en.doorCloudSay).toContain("connect your mailbox there");
    expect(DECKS.de.doorCloudSay).toContain("verbinde dort dein Postfach");
    for (const deck of Object.values(DECKS)) {
      expect(deck.doorCloudSay).not.toMatch(/sign up|create an account|subscri|registrier|abonn|https?:|ohmail\.app/i);
    }
  });

  it("no phone door claims the phone itself organizes anything", () => {
    // The desktop's first door is "On this computer — nothing is sent anywhere". A phone has no
    // IMAP client and no engine dialling a mail server, so an equivalent door here would be a
    // claim the code cannot keep. Every door names somebody else's machine and says "keeps a copy".
    for (const say of [Copy.doorCloudSay, Copy.doorOwnServerSay, Copy.doorDesktopSay]) {
      expect(say).toContain("this phone keeps a copy");
      expect(say).not.toMatch(/on this phone|nothing is sent anywhere/i);
    }
    /* THE FOURTH DOOR IS THE EXCEPTION, AND IT IS STATED HERE RATHER THAN LEFT OUT. It names THIS
       phone on purpose, so it must NOT say "keeps a copy" — and the thing it must never do is
       promise the organizing without its condition, which is the third line's job. */
    expect(Copy.doorPhoneSay, "the standalone door claims to keep a copy").not.toContain("keeps a copy");
    expect(Copy.doorPhoneSay.toLowerCase()).toContain("this phone");
    for (const need of [Copy.doorPhoneNeedIos, Copy.doorPhoneNeedAndroid]) {
      expect(need.toLowerCase(), "the door's third line states no condition").toMatch(/only|while/);
    }
  });

  /**
   * THE TRAVEL SENTENCE NAMES WHAT THE PROFILE PAYLOAD CARRIES, AND NOTHING ELSE.
   *
   * The catalogue's own enumeration (`leave.note`) is the authority: screened senders, rules,
   * notification choices, the away reply and tag names travel; triage piles, Resurface timers and
   * learned patterns stay with the install that made them. The phone's short form must not widen
   * that into "your settings", because this app's own Look setting travels with the account,
   * not the mailbox, and its piles are local.
   */
  it("the travel sentence claims only what travels", () => {
    const said = Copy.doorsTravel;
    expect(said).toContain("mailbox is always the master");
    expect(said).toContain("screened senders");
    expect(said).toContain("rules");
    expect(said).toContain("notification choices");
    /* ── "KEEPS A COPY" IS GONE FROM THIS SENTENCE, AND THE REMOVAL IS THE POINT ──────────────
       It ended "This phone only ever keeps a copy of it." — true of three doors and FALSE behind
       the fourth, where the phone holds the mailbox's organizer. A panel carrying all four doors
       cannot close on a sentence that is true of three, so the clause was dropped rather than
       qualified: the per-door truth is on each door's own lines, which §5 of the no-host census
       holds, and this sentence keeps only the part that is true behind every door.

       The clause must not come BACK, so it is refused here rather than merely unasserted. */
    expect(said, "the trimmed clause is back, and it is false behind the fourth door")
      .not.toContain("only ever keeps a copy");
    // The three that do NOT travel must not appear as things that do.
    for (const notCarried of ["piles", "Resurface", "appearance", "Look"]) {
      expect(said, notCarried).not.toContain(notCarried);
    }
  });

  /**
   * THE CA SENTENCE IS THE PHONE'S, NOT THE DESKTOP'S — and the Android half is a fact about this
   * app's own build, so it is asserted against the manifest rather than against a memory of it.
   *
   * The desktop tells an operator to drop a root into `cloud-ca.pem` and composes
   * `NODE_EXTRA_CA_CERTS` from it. There is no equivalent on a phone: React Native's Android
   * networking is OkHttp behind the platform trust manager, whose default for API 24 and up trusts
   * SYSTEM authorities only — so an operator's own root, installed on the device, changes nothing
   * for this app. Opting in (`<certificates src="user"/>`) would widen what EVERY connection this
   * app makes accepts, so it is deliberately absent, and this case is what keeps it absent.
   */
  it("the self-host door's certificate sentence matches what this build actually trusts", () => {
    const said = Copy.doorSelfCert;
    expect(said).toContain("an authority this phone already trusts");
    expect(said).toContain("Android");
    expect(said).toContain("Tailscale");
    // It must NOT offer the desktop's remedy, which does not exist here.
    expect(said).not.toContain("cloud-ca.pem");
    expect(said).not.toContain("data folder");
    /* ── AND IT MUST NOT RULE OUT A CONFIGURATION THAT WORKS ─────────────────────────────────────
       It read "its own certificate will be refused" without qualification, and review named that as
       false on iOS: URLSession honours a root the person installed AND enabled. An unqualified
       refusal there tells a self-hoster to rebuild infrastructure they did not need to touch. Both
       platforms are now stated, so the sentence is true whichever phone is reading it. */
    expect(said, "an unqualified refusal is false on iOS").not.toContain("will be refused");
    expect(said).toContain("iPhone and iPad");
    expect(said).toContain("Certificate Trust Settings");

    /* ── AND THE ANDROID CLAIM IS A FACT ABOUT WHAT THIS BUILD IS CONFIGURED TO TRUST ────────
       Asserted from the TRACKED configuration the prebuild reads, not from its output. There are
       exactly two routes to a manifest attribute in this app: a key under `expo.android` in
       `app.json`, and a local config plugin that edits the manifest as it is generated. Both are
       checked, because checking one would leave the other free to add the opt-in silently. */
    const app = JSON.parse(read("../app.json")) as {
      expo: {
        android?: Record<string, unknown>;
        ios?: { infoPlist?: Record<string, unknown> };
        plugins?: unknown[];
      };
    };
    const android = app.expo.android ?? {};
    for (const key of ["networkSecurityConfig", "usesCleartextTraffic"]) {
      expect(
        Object.keys(android),
        `expo.android.${key} would widen what every connection this app makes accepts`,
      ).not.toContain(key);
    }

    /* ── AND THE iOS HALF, WHICH WAS NOT CHECKED AT ALL ──────────────────────────────────────
       The rule is "no cleartext exception in EITHER manifest", and only one of the two manifests
       had a guard. Android's is above; the iPhone's opt-in is `NSAppTransportSecurity` in
       `expo.ios.infoPlist` — `NSAllowsArbitraryLoads` for the blanket version, `NSExceptionDomains`
       for the per-host one, and `NSAllowsLocalNetworking` for the shape that looks narrow and is
       not (it permits cleartext to every `.local` name and every private address, which is exactly
       the population the same-network door serves).

       The tree has never carried one — `infoPlist` holds a single encryption declaration. A guard
       over a state that already holds is the point: the reason the LAN door serves TLS at all is
       that this opt-in was refused, and a later build reaching for it to "make pairing work" is
       the regression this is here to stop. Same two routes as Android: the key, and the plugins. */
    const infoPlist = app.expo.ios?.infoPlist ?? {};
    expect(Object.keys(infoPlist), "an ATS exception would undo the reason the LAN door has a key")
      .not.toContain("NSAppTransportSecurity");
    // Nested, too: the key could arrive spelled inside another dictionary.
    expect(JSON.stringify(infoPlist))
      .not.toMatch(/NSAppTransportSecurity|NSAllowsArbitraryLoads|NSAllowsLocalNetworking|NSExceptionDomains/);

    /* THE PLUGIN HALF. Every local plugin is read, and the list is derived from `app.json` rather
       than typed here — a plugin added tomorrow is covered without anybody remembering to add it,
       which is the whole difference between a census and a list. */
    const local = (app.expo.plugins ?? [])
      .map((p) => (Array.isArray(p) ? p[0] : p))
      .filter((p): p is string => typeof p === "string" && p.startsWith("./plugins/"));
    // Anti-vacuity: a renamed plugins directory would make the loop below check nothing at all.
    expect(local.length, "no local config plugins found — the census would pass over nothing")
      .toBeGreaterThan(3);
    for (const rel of local) {
      const src = read(`../${rel.slice(2)}.js`);
      expect(src, `${rel} opts this app into user certificate authorities`)
        .not.toMatch(/networkSecurityConfig|usesCleartextTraffic|certificates src/);
      /* The plugin route to the OTHER manifest. `withInfoPlist` is how a config plugin edits it,
         and a plugin is the only way an ATS exception could arrive without appearing in
         `app.json` above — which is the half this census was missing. */
      expect(src, `${rel} opts this app out of App Transport Security`)
        .not.toMatch(/NSAppTransportSecurity|NSAllowsArbitraryLoads|NSAllowsLocalNetworking|NSExceptionDomains/);
    }
  });

  /**
   * THE SECOND OPINION, when a prebuild happens to be in the tree. It cannot be the primary check
   * (see `HAS_PREBUILD`), and it is worth having anyway: it is the only thing that would catch a
   * DEPENDENCY's config plugin writing the opt-in, which no amount of reading this app's own
   * configuration can see.
   */
  it("the manifest really is a generated artifact — the premise the skip rests on", () => {
    /* THE SKIP'S OWN REASON, UNDER TEST. A conditional check is only honest while the thing it is
       conditional on is genuinely absent BY DESIGN; the day `android/` becomes tracked, the second
       opinion should stop being optional, and nothing else would say so. This case fails then. */
    expect(read("../.gitignore"), "apps/mobile/android is no longer ignored — the manifest check "
      + "can and should become unconditional").toMatch(/^\/android$/m);
  });

  ifPrebuilt(`the generated manifest agrees with the configuration${PREBUILD_NOTE}`, () => {
    const manifest = readFileSync(MANIFEST, "utf8");
    expect(manifest, "a user-CA opt-in would make the sentence false").not.toContain(
      "networkSecurityConfig",
    );
    expect(manifest).not.toContain("certificates src");
  });

  /*
   * ── THE ANDROID HALF OF THAT CLAIM IS A FACT ABOUT A GENERATED FILE ──────────────────────────
   *
   * `android/AndroidManifest.xml` is `expo prebuild` output and is gitignored, so it is absent on
   * an ordinary checkout — and this read used to sit inside the case above and ENOENT there, which
   * is a red that says nothing about the product and cannot be fixed by anyone reading it.
   *
   * The arming is the artifact, never `CI`: a flag cannot tell you whether a file exists, and
   * arming on one failed every clean run of the two censuses next door for the same reason. A skip
   * is an honest "not measured" — the skip reason names the artifact and the command that makes
   * it — and `scripts/mobile-native-gate.mjs` runs this file after a prebuild and refuses if
   * anything here skipped, so a release still cannot ship the claim unmeasured.
   */
  const MANIFEST = fileURLToPath(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url));
  const NO_MANIFEST = !existsSync(MANIFEST);

  it.skipIf(NO_MANIFEST)(
    NO_MANIFEST
      ? "the shipped manifest does not opt in to user certificate authorities — SKIPPED: no "
        + "apps/mobile/android/app/src/main/AndroidManifest.xml in this checkout "
        + "(run `npx expo prebuild --platform android`)"
      : "the shipped manifest does not opt in to user certificate authorities",
    () => {
      const manifest = readFileSync(MANIFEST, "utf8");
      expect(manifest, "a user-CA opt-in would make the certificate sentence false").not.toContain(
        "networkSecurityConfig",
      );
      expect(manifest).not.toContain("certificates src");
    },
  );

  /**
   * THE LAN DOOR IS NOT PROMISED EARLY. The capability needs both halves — the code that carries a
   * key fingerprint, and the platform half that installs it — and `canPin()` is false where the
   * second is absent. So no door tile describes "on your own network" at all; the seam that knows
   * refuses and says which half is missing.
   */
  it("no door tile promises same-network pairing, which is conditional on a platform half", () => {
    for (const say of [Copy.doorCloudSay, Copy.doorOwnServerSay, Copy.doorDesktopSay]) {
      expect(say).not.toMatch(/same network|your own network|local network|LAN/i);
    }
    /* The refusal that owns the subject still exists and still names the remedy. The SENTENCE
       moved into the copy deck when the phone gained a second language — a refusal a reader sees
       is copy — so it is asserted where it lives now, and the SEAM is still asserted in the module
       that enforces it. Both halves, because either one alone can rot: a sentence with no gate is
       a promise nothing keeps, and a gate with no sentence is a dead end. */
    expect(Copy.admitCannotPin).toContain("Pairing with a computer on your own network is not available");
    expect(Copy.admitCannotPin).toMatch(/Tailscale/);
    const pairing = read("../src/net/pairing.ts");
    expect(pairing).toContain("canPin()");
    expect(pairing).toContain('refuse("admitCannotPin")');
  });

  /**
   * A SUPERSEDED CHECK WRITES NOTHING — the request-identity guard.
   *
   * Review's sequence: tap ohmail Cloud, then open "Your own server" before `/hello` answers. The
   * Cloud check resolves and sets `probed` with the HOSTED origin, and that result renders inside
   * the self-hosted arm — locking the address field and offering to pair with a server the person
   * never typed. Two taps on the self-hosted door resolving out of order does the same.
   *
   * A census rather than a render, in this file's idiom, and it names the mechanism rather than the
   * symptom: a ticket taken before the first await, and a `mine()` check after EVERY await, so a
   * superseded check cannot write — not even its failure, which would be noise on the question that
   * replaced it.
   */
  it("every await in the check is followed by a supersede guard", () => {
    expect(doors).toContain("const ticket = (latest.current += 1)");
    expect(doors).toContain("latest.current === ticket");
    // The unmount marker, so a check in flight when the screen leaves writes nothing either.
    expect(doors).toContain("latest.current = -1");
    /* EVERY await, counted: two in `check` (`conn.ask`, `conn.probeBase`), each followed by the
       guard. A third await added without one is the whole regression, so the count is the
       assertion rather than the presence. */
    const awaits = [...doors.matchAll(/await conn\./g)];
    const guards = [...doors.matchAll(/if \(!mine\(\)\) return;/g)];
    expect(awaits).toHaveLength(2);
    expect(guards.length, "one supersede guard per await").toBe(awaits.length);
  });

  /**
   * THE ADDRESS FIELD IS LOCKED FROM THE START OF THE CHECK, NOT FROM ITS ANSWER.
   *
   * It was `probe.k === "probed"`, so the field was editable WHILE asking: type A, press Continue,
   * replace it with B, and A's answer locks the field showing B while the pair buttons carry A. The
   * token for B would then be sent to A — a failure, and a credential in the wrong place.
   */
  it("the address field is not editable while a check is in flight", () => {
    // The address step's own probe (`probeUnder("self", …)`), so another door's late check cannot lock it.
    expect(doors).toContain('locked={selfProbe.k === "asking" || selfProbe.k === "probed"}');
    expect(doors).toContain('const selfProbe = probeUnder("self", open, probe);');
    expect(doors).toContain("editable={!locked}");
  });

  /**
   * THE DESKTOP DOOR NAMES ITS ONE CONDITION WHERE THAT CONDITION HOLDS.
   *
   * The tile is true on both platforms and still walked an iPhone user into a refusal, because a
   * computer's SAME-NETWORK code is the one that needs the pin and `canPin()` is false where the
   * native half is absent. Saying nothing did not remove the dead end — it moved the discovery to
   * after the camera. The tile stays unconditional; one line renders only where the condition holds.
   */
  it("where this build cannot pin, the desktop door says so before the scan", () => {
    expect(doors).toContain("canPin() ? null : (");
    expect(doors).toContain("Copy.doorDesktopNoPin");
    // It names the remedy that works, not the mechanism that does not.
    expect(Copy.doorDesktopNoPin).toContain("Tailscale");
    expect(Copy.doorDesktopNoPin).toContain("cannot yet verify");
    // And the TILE itself stays free of the conditional — the reason it is a separate line.
    expect(Copy.doorDesktopSay).not.toMatch(/Tailscale|network/i);
  });

  /**
   * A DOOR'S SENTENCE IS ANNOUNCED, NOT JUST ITS NAME.
   *
   * An explicit `accessibilityLabel` REPLACES the label React Native would derive from the child
   * text. With only the name in it, a screen reader announced "Your own computer, button" and
   * dropped "open Settings → Devices there and scan its code" — so the desktop door would take
   * somebody straight to a camera without ever saying what to point it at. On a door the second
   * line is not decoration: it is which machine does the organizing, and what to do next.
   */
  it("a door announces its factual line, not only its name", () => {
    /* ── AND THE THIRD LINE TOO, WHICH IS WHERE THE FOURTH DOOR'S WHOLE COST LIVES ────────────
       The label was `(name, say)`. On doors two to four the third line carries what the door asks
       for next; on door ONE it carries the CONDITION — "only while the app is open" — which is
       the decision itself. A reader who heard "Standalone on this phone. Your mailbox, organized
       on this phone." and not the condition has been told the opposite of the ruling.

       Asserted as the JOIN rather than as a substring of the label, because `(name, say)` is
       still a substring of the expression that appends the third line. */
    expect(doors).toContain("need === undefined ? say : `${say} ${need}`");
    expect(doors).toContain("Copy.ariaNameThenSentence(");
    expect(doors, "a bare name drops the sentence a screen reader needs")
      .not.toContain("accessibilityLabel={name}");
    // And the third line is DRAWN as well as announced — a label-only line is a line nobody sees.
    expect(doors).toContain("{need !== undefined ? <Txt");
  });

  it("the prefixed base is said out loud, and only when there is one to say", () => {
    expect(Copy.doorSelfApiUnder("https://x/api")).toContain("https://x/api");
    // Rendered behind `probe.prefixed`, so an unprefixed server does not get a line about nothing.
    expect(doors).toContain("probe.prefixed ?");
  });

  /**
   * THE CLOUD CARD DOES NOT PAY FOR A BASE PROBE, and this case exists because the mutation pass
   * found that nothing held it: flipping the Cloud card back to `check(MANAGED_ORIGIN, true)` left
   * the whole suite green.
   *
   * Why it matters — it is a REGRESSION on the door that already works. The hosted service's address
   * is a constant in this app, so the probe can only ever return the origin it was handed, while
   * adding a round trip that can fail. A blip on it would put "ohmail could not find its mail API"
   * where the pair step should be, for the one door whose API location has never been in question.
   *
   * A census rather than a render, in this file's idiom: the property is about which argument a call
   * site passes, and the two call sites are the whole of it.
   */
  it("only a TYPED address is base-probed — the Cloud card's own constant is not", () => {
    // Each call site names its door, and only the address step's door measures the base.
    expect(doors).toContain('check(MANAGED_ORIGIN, "cloud")');
    expect(doors).toContain('check(address, "self")');
    expect(doors).toContain('const measureBase = door === "self";');
    // Exactly two call sites, so a third could not slip in unexamined.
    expect([...doors.matchAll(/\bcheck\(/g)]).toHaveLength(2);
  });

  /**
   * THE FOURTH DOOR IS OFFERED BY THE REGISTRY, NOT BY A FLAG.
   *
   * `Doors.tsx` renders the fourth tile behind `standaloneAvailable`, so the door follows the
   * artifact rather than a capability somebody can set. The lead sentence's COUNT is ruled copy
   * — CHOOSER-DESIGN §7.1 and PHONE-DOOR-DESIGN's copy table both name "One question, four
   * answers" — and is held to the rendered list by `no-host-census.test.ts` §5, which reads the
   * word against the `<Door>` count in both decks. This case pins the mechanism §5 rests on.
   */
  it("the door list is offered by the registry, not by a flag", () => {
    expect(doors).toContain("standaloneAvailable({ startEngine: phoneEngineStart() })");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  NOBODY SPENDS A PAIRING CODE WITHOUT SHOWING SOMEBODY WHAT ANSWERED — the source half
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The TYPE does most of this: `pairWithServer` takes a `PairAdmission` that only `probePairing`
 * makes, so a screen cannot redeem a scanned string. What a type cannot say is that the screen
 * which HAS an admission renders the facts before pressing on — a new entry path could probe,
 * drop the answer on the floor and redeem in the same function, and every existing assertion
 * would stay green.
 *
 * So this is the route beside the one the type closed. It is a CENSUS and not a list: the file
 * set is walked, so a screen added tomorrow is covered without anybody remembering to add it.
 */
describe("the pairing confirmation cannot be routed around", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  /** Every shipped source file of this app — the two trees a screen can live in. */
  const shipped = (): { rel: string; src: string }[] => {
    const out: { rel: string; src: string }[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        out.push({ rel: relative(ROOT, full).split("\\").join("/"), src: readFileSync(full, "utf8") });
      }
    };
    walk(join(ROOT, "app"));
    walk(join(ROOT, "src"));
    return out;
  };

  it("walks a real tree — anti-vacuity, because a renamed directory would census nothing", () => {
    const files = shipped();
    expect(files.length, "the walk found almost no files — it is passing over the app").toBeGreaterThan(60);
    expect(files.map((f) => f.rel)).toContain("app/scan.tsx");
    expect(files.map((f) => f.rel)).toContain("app/connect.tsx");
  });

  it("only the connection layer reaches the REDEEM, and only through an admission", () => {
    // `pairWithServer` is the redeem. One definition, one caller — the connection layer, which
    // is the file the privacy census already admits to the network seam.
    const callers = shipped()
      .filter((f) => /\bpairWithServer\(/.test(f.src))
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual(["src/net/connection.tsx", "src/net/pairing.ts"]);
  });

  it("every screen that can spend a code RENDERS the confirmation", () => {
    const spenders = shipped()
      .filter((f) => f.rel.startsWith("app/") && /\bpairConfirmed\(/.test(f.src));
    // The two entrances: the camera, and the by-hand screen whose pasted-link path is the same
    // unreadable string a QR carries. Anti-vacuity — a census over an empty set proves nothing.
    expect(spenders.map((f) => f.rel).sort()).toEqual(["app/connect.tsx", "app/scan.tsx"]);
    for (const f of spenders) {
      /* A BOUNDARY, NOT A SUBSTRING. `toContain("<PairConfirm")` was satisfied by the mutation
         `<PairConfirmXX` — which renders nothing of the sort — so the census passed over a screen
         that had stopped showing the confirmation. Found by the mutation pass, which is the only
         way a green assertion over a substring is ever found. */
      expect(f.src, `${f.rel} spends a pairing code without rendering PairConfirm`)
        .toMatch(/<PairConfirm[\s/>]/);
      // AND THE TOKEN COMES OUT OF THE CONFIRMING PHASE, not out of the parse. This is what
      // makes the render load-bearing rather than decorative: the only value passed to the
      // redeem is the one the phase was holding while the facts were on screen.
      expect(f.src, `${f.rel} must redeem the token held by the confirming phase`)
        .toMatch(/pairConfirmed\(\s*current\.admission,\s*current\.token\s*\)/);
    }
  });

  it("the confirmation draws the MEASURED address and the ENFORCED key", () => {
    /**
     * What the person is asked about. The address goes out VERBATIM because it is scheme, host
     * and port — the same (host, port) the TLS registry is keyed by, so the screen names what the
     * socket checks rather than something near it. The key is `admission.pin`, which is
     * `admitOrigin`'s enforced value and never the link's: a fingerprint for a DNS-named origin
     * installs nothing, and drawing it beside "compare these characters" is the one outcome that
     * cannot be made honest. Both are rendered through the shared `shortPin` the desktop draws
     * with, because two ends of a comparison computed by two rules compare nothing.
     */
    const confirm = shipped().find((f) => f.rel === "src/ui/PairConfirm.tsx");
    expect(confirm, "the confirmation component moved — this census passed over nothing").toBeDefined();
    if (confirm === undefined) return;
    expect(confirm.src, "the confirmation must name the address it measured")
      .toMatch(/value=\{admission\.origin\}/);
    expect(confirm.src, "the key row must come from the ENFORCED pin, through shortPin")
      .toMatch(/shortPin\(admission\.pin\)/);
  });

  it("every screen that can spend a code gives a DISMISSED one back", () => {
    /**
     * The other half of the same press. A probe has to install the code's key before it can dial
     * a self-signed door, so a confirmation left unpressed — declined, or navigated away from —
     * owes that key back (`net/pairing.ts#discardAdmission`). Until it did, looking at a
     * stranger's code for your own computer's address left the stranger's key enforced for that
     * (host, port), with nothing on any screen saying so.
     *
     * A CALL, not a mention: the identifier appearing in a comment satisfies a substring.
     */
    const spenders = shipped()
      .filter((f) => f.rel.startsWith("app/") && /\bpairConfirmed\(/.test(f.src));
    expect(spenders.map((f) => f.rel).sort()).toEqual(["app/connect.tsx", "app/scan.tsx"]);
    for (const f of spenders) {
      expect(f.src, `${f.rel} can spend a code and never discards a dismissed admission`)
        .toMatch(/\bdiscardAdmission\(\s*\w/);
      /* AND THE PRESS IS NOT A DISMISS. The discard hangs off the confirming phase leaving, and
         a successful pairing leaves it too — so the latch is set immediately before the redeem,
         or navigating away un-pins the computer this phone has just paired with. */
      expect(f.src, `${f.rel} must mark the press immediately before it spends the code`)
        .toMatch(/pressed\.current = true;\s*\n\s*void conn\.pairConfirmed\(/);
    }
  });

  it("no screen calls the redeem from the same function that parses a link", () => {
    // The shape that shipped: `parsePairLink` and the redeem in one callback. Both screens still
    // parse — that is their job — so the property is that the parse and the spend are separated
    // by a state transition, and `setPhase({ k: "confirming"` is that transition by name.
    for (const f of shipped().filter((x) => /\bparsePairLink\(/.test(x.src) && x.rel.startsWith("app/"))) {
      expect(f.src, `${f.rel} parses a pairing link and must hand it to the confirming phase`)
        .toContain('setPhase({ k: "confirming"');
    }
  });
});
