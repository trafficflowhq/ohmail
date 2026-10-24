import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createApp, apiRoutes, authRoutes, API_VERSION, type ApiDeps, type HelloConfig } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { helloRoutes } from "../src/routes/hello.js";
import { pairRoutes } from "../src/routes/pair.js";
import { makeDeps, req } from "./helpers.js";

/**
 * ═══ `GET /hello` — THE FROZEN NEGOTIATION WIRE SHAPE, and the composition census ═══════════
 *
 * A client's server picker trusts this endpoint to learn what it has been pointed at — managed
 * service, standalone server, or local desktop engine — BEFORE any credential exists. Two
 * consequences this file pins:
 *
 *  1. **The wire shape is a frozen contract.** Exactly these keys, exactly this nesting; a field
 *     dropped or renamed breaks every client that switches on it. Asserted by EXACT key census,
 *     not by presence, and watched to fail: deleting `apiVersion` from the handler's body turned
 *     the key census red (`["apiVersion", …] ≠ [received]`), and deleting `features.pairing`
 *     turned the nested census red — both restored. Presence-only assertions would have stayed
 *     green through a rename.
 *
 *  2. **Every composition mounts it, and the self-host table holds what its contract says.**
 *     The three route tables each answer `/hello`; the self-host table carries no billing, no
 *     waitlist and no admin surface — asserted against the ROUTE TABLE and against the SOURCE
 *     (the module is never even imported), the same two-level check `routes/local.ts` gets.
 *
 * The endpoint is unauthenticated by design, so the strongest claim here is negative: the body
 * is built from the injected descriptor and constants ONLY, so it cannot carry anything
 * per-account — there is no account in scope to leak.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

/** A descriptor with every capability distinct from its sibling, so a swapped field is visible. */
const MANAGED: HelloConfig = {
  flavor: "managed",
  needsSetup: false,
  auth: { password: true, totp: true, webauthn: true, publicSignup: false },
  features: { sse: false, staging: true, ai: true, pairing: false, remoteImages: true },
};

describe("GET /hello — the frozen wire shape", () => {
  it("answers 200 with EXACTLY the contract keys, from the injected descriptor", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/hello"), { ...deps, hello: MANAGED });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The frozen shape. A key added here is a deliberate contract change for every client that
    // negotiates against this endpoint; a key dropped breaks them. Exact, sorted, all three
    // levels — this is the assertion that went red under both recorded mutations.
    expect(Object.keys(body).sort()).toEqual(
      ["apiVersion", "auth", "features", "flavor", "needsSetup", "product"],
    );
    expect(Object.keys(body.auth).sort()).toEqual(["password", "publicSignup", "totp", "webauthn"]);
    expect(Object.keys(body.features).sort())
      .toEqual(["accountHeader", "ai", "forwardParts", "pairing", "remoteImages", "sse", "staging"]);
    expect(body).toEqual({
      product: "ohmail",
      flavor: "managed",
      apiVersion: API_VERSION,
      needsSetup: false,
      auth: { password: true, totp: true, webauthn: true, publicSignup: false },
      // `accountHeader` is NOT in the injected descriptor above — the host does not supply it and
      // cannot. It is a constant this build emits because `createApp.handle` sets the header.
      features: {
        sse: false, staging: true, ai: true, pairing: false, remoteImages: true, accountHeader: true,
        // A forward may name the parts it sends (`forwardParts`); a fixed fact of this build.
        forwardParts: true,
      },
    });
  });

  it("never caches — a capability answer is a statement about the present", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/hello"), { ...deps, hello: MANAGED });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("carries no credential requirement: public + anonymous + raw, cost unauthenticated", () => {
    const matches = apiRoutes.filter((r) => r.pattern === "/hello");
    expect(matches).toHaveLength(1);
    const route = matches[0]!;
    expect(route.method).toBe("GET");
    expect(route.cost).toBe("unauthenticated");
    expect(route.options).toEqual({ public: true, raw: true, anonymous: true });
  });

  it("answers each composition's own truth — the descriptor is served verbatim", async () => {
    const { deps } = await makeDeps();
    const local: HelloConfig = {
      flavor: "local",
      needsSetup: false,
      auth: { password: false, totp: false, webauthn: false, publicSignup: false },
      features: { sse: false, staging: false, ai: false, pairing: false, remoteImages: false },
    };
    const selfhost: HelloConfig = {
      flavor: "selfhost",
      needsSetup: async () => true, // a fresh box: zero users
      auth: { password: true, totp: true, webauthn: true, publicSignup: false },
      // `pairing: true` is this composition's truth since the ceremony mounted in its table —
      // the descriptor apps/server injects must say the same; see `routes/self-host.ts`.
      features: { sse: true, staging: true, ai: false, pairing: true, remoteImages: true },
    };
    // The fourth flavor (Phase 3): the desktop engine's host door — the surface a paired phone
    // reaches. No sign-in ceremony (a device becomes a session through the pairing redeem),
    // pairing announced, SSE honestly off. Widening the union was an additive contract change,
    // recorded here in the same commit that mounted the table (`routes/desktop-host.ts`).
    const desktopHost: HelloConfig = {
      flavor: "desktop-host",
      needsSetup: false,
      auth: { password: false, totp: false, webauthn: false, publicSignup: false },
      features: { sse: false, staging: false, ai: false, pairing: true, remoteImages: true },
    };
    const localBody = await (await H(req("GET", "/hello"), { ...deps, hello: local })).json();
    expect(localBody.flavor).toBe("local");
    expect(localBody.auth.password).toBe(false);
    const shBody = await (await H(req("GET", "/hello"), { ...deps, hello: selfhost })).json();
    expect(shBody.flavor).toBe("selfhost");
    // The capability form was awaited: the fresh-box truth reached the wire as a boolean.
    expect(shBody.needsSetup).toBe(true);
    expect(shBody.features.sse).toBe(true);
    const dhBody = await (await H(req("GET", "/hello"), { ...deps, hello: desktopHost })).json();
    expect(dhBody.flavor).toBe("desktop-host");
    expect(dhBody.auth.password).toBe(false);
    expect(dhBody.features.pairing).toBe(true);
    expect(dhBody.features.sse).toBe(false);
  });

  it("with NO injected descriptor: 503 hello_unconfigured, never a guessed flavor", async () => {
    const { deps } = await makeDeps();
    expect(deps.hello).toBeUndefined();
    const res = await H(req("GET", "/hello"), deps);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("hello_unconfigured");
    // The refusal must not half-answer: none of the contract keys may appear beside the error.
    expect(body.flavor).toBeUndefined();
    expect(body.product).toBeUndefined();
  });

  it("a needsSetup capability that THROWS is a 503, never a guess in either direction", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/hello"), {
      ...deps,
      hello: { ...MANAGED, needsSetup: async () => { throw new Error("db down"); } },
    });
    // `raw` means no error envelope above the handler, so this 503 is also the proof the
    // handler swallowed the throw rather than surfacing the host's generic 500.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("hello_unavailable");
    expect(body.needsSetup).toBeUndefined();
    // …and the capability's own message never reaches the wire: on a standalone server it is a
    // database driver error, which can carry the connection string.
    expect(JSON.stringify(body)).not.toContain("db down");
  });

  it("the body is built from the descriptor and constants only — nothing per-account exists to leak", async () => {
    // Structural, from source: the handler reads `deps.hello`, awaits at most the needsSetup
    // capability, and constructs a literal. It must never read the session (there is none on the
    // anonymous pipeline), the database, or the environment.
    const src = readFileSync(new URL("../src/routes/hello.ts", import.meta.url), "utf8");
    expect(src).not.toContain("deps.db");
    expect(src).not.toContain("deps.session");
    expect(src).not.toContain("process.env");
  });
});

describe("the composition census — every table mounts /hello, and self-host holds its contract", () => {
  const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;

  it("apiRoutes, localRoutes AND selfHostRoutes each mount GET /hello exactly once", () => {
    for (const [name, table] of [
      ["apiRoutes", apiRoutes], ["localRoutes", localRoutes], ["selfHostRoutes", selfHostRoutes],
    ] as const) {
      expect(table.filter((r) => key(r) === "GET /hello"), `${name} must mount GET /hello`)
        .toHaveLength(1);
    }
  });

  it("selfHostRoutes serves NO billing, NO waitlist and NO admin path", () => {
    for (const r of selfHostRoutes) {
      expect(r.pattern.startsWith("/billing"), `${key(r)} is a billing route`).toBe(false);
      expect(r.pattern.startsWith("/waitlist"), `${key(r)} is a funnel route`).toBe(false);
      expect(r.pattern.startsWith("/admin"), `${key(r)} crosses accounts`).toBe(false);
    }
  });

  it("`routes/self-host.ts` never IMPORTS those modules — absent from the graph, not filtered", () => {
    // The same two-level check `routes/local.ts` carries: the table above proves nothing routes
    // there, this proves the handlers are not even built into a program that mounts this table.
    const src = readFileSync(new URL("../src/routes/self-host.ts", import.meta.url), "utf8");
    expect(src).not.toContain("./billing.js");
    expect(src).not.toContain("./waitlist.js");
    expect(src).not.toContain(`from "./admin`);
    // …and it must not reach any of them through the hosted barrel either.
    expect(src).not.toContain("./index.js");
  });

  it("mounts the AUTH surface whole — devices included — plus each ruling'd addition", () => {
    const keys = new Set(selfHostRoutes.map(key));
    // authRoutes whole: real sign-in on a standalone server is the hosted ceremony, not a subset.
    for (const r of authRoutes) {
      expect(keys.has(key(r)), `${key(r)} is in authRoutes but not in selfHostRoutes`).toBe(true);
    }
    // The device list rides in authRoutes — named here so a future auth split cannot silently
    // drop the two routes the pairing ceremony's device management stands on.
    expect(keys).toContain("GET /devices");
    expect(keys).toContain("DELETE /devices/:id");
    // The additions over the single-user table, one witness each.
    expect(keys).toContain("POST /mailboxes/oauth/microsoft/start");
    expect(keys).toContain("POST /attachments/staging");
    expect(keys).toContain("DELETE /account");
    expect(keys).toContain("GET /consent");
    expect(keys).toContain("GET /account/ai");
    expect(keys).toContain("GET /workflows/proposals");
    expect(keys).toContain("GET /internal/alerts");
    // …and the whole single-user product set, by containment: a route added to localRoutes
    // joins this table in the same edit, which is the reason self-host spreads the array.
    for (const r of localRoutes) {
      expect(keys.has(key(r)), `${key(r)} is in localRoutes but not in selfHostRoutes`).toBe(true);
    }
  });

  it("holds no duplicate (method, pattern) — the groups it composes are disjoint", () => {
    const keys = selfHostRoutes.map(key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it("the pairing ceremony is mounted HERE, exactly, and it is the pairRoutes module itself", () => {
    // The positive census this assertion flipped to when the module landed (it used to pin the
    // typed empty seam: `selfHostRoutes.filter(/pair/) == []`). Exact set, not presence — a
    // fifth pairing route is a deliberate contract change for the self-host setup page and the
    // Phase 3/5 clients, and it fails here first.
    expect(selfHostRoutes.filter((r) => r.pattern.startsWith("/pair")).map(key).sort()).toEqual([
      "DELETE /pair/:id",
      "GET /pair",
      "POST /pair",
      "POST /pair/redeem",
      "POST /pair/state",
    ]);
    // Identity, not shape — the same check the /hello handler gets below: the mounted routes
    // ARE the module's members, so a fix to the ceremony cannot fork between a re-listed copy
    // and the real one.
    for (const r of pairRoutes) expect(selfHostRoutes).toContain(r);
  });

  it("the HOSTED table mounts the ceremony too — the same objects — and the LOCAL table never does", () => {
    // This census used to read "NEITHER the hosted table NOR the local table mounts any pairing
    // route", and its hosted half was retired DELIBERATELY by the managed device-pairing mount
    // (watched red at the old assertion with the routes mounted, then rewritten here): the
    // hazard it guarded — an anonymous invite redeem minting a registration that bypasses the
    // billing funnel — is now held by the dependency bag instead of by absence. The hosted
    // composition wires no `services.inviteRedeem`, so BOTH invite arms refuse
    // `validation_failed` (`pair.ts`: the redeem's port probe, and the mint's symmetric guard),
    // which `pair-hosted.test.ts` drives over HTTP against the api-vercel bag shape.
    expect(apiRoutes.filter((r) => r.pattern.startsWith("/pair")).map(key).sort()).toEqual([
      "DELETE /pair/:id",
      "GET /pair",
      "POST /pair",
      "POST /pair/redeem",
      "POST /pair/state",
    ]);
    // Identity with the module, exactly as the self-host census above: the hosted mounts ARE
    // `pairRoutes`' members, so burn semantics, envelope and the no-cookie answer cannot fork.
    for (const r of pairRoutes) expect(apiRoutes).toContain(r);

    // The LOCAL half stands unchanged: a single-user engine mints one session per launch and
    // has nobody to invite; its window pairs over the desktop's own doors. Mutation watched
    // red: spreading `pairRoutes` into `localRoutes` turns this red before anything else runs.
    expect(localRoutes.filter((r) => r.pattern.startsWith("/pair"))).toEqual([]);
    // …and the local module graph does not even import it — absent from the artifact, not
    // filtered. (`routes/index.ts` now imports it on purpose; the desktop engine never
    // compiles that table.)
    const src = readFileSync(new URL("../src/routes/local.ts", import.meta.url), "utf8");
    expect(src, "routes/local.ts imports the pairing module").not.toContain("./pair.js");
  });

  it("the sidecar's helloRoutes are the SAME module in every table — one contract, three mounts", () => {
    // Identity, not shape: the three tables must serve the same handler, so a fix to the wire
    // shape cannot land in one composition and miss another.
    const inApi = apiRoutes.find((r) => r.pattern === "/hello");
    const inLocal = localRoutes.find((r) => r.pattern === "/hello");
    const inSelfHost = selfHostRoutes.find((r) => r.pattern === "/hello");
    expect(inApi).toBe(helloRoutes[0]);
    expect(inLocal).toBe(helloRoutes[0]);
    expect(inSelfHost).toBe(helloRoutes[0]);
  });
});
