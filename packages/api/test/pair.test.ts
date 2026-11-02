import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { pairingTokens, refreshTokens, sessions, users } from "@trafficflow/db";
import { ACCOUNT_HEADER, createApp, type ApiDeps, type Route } from "@trafficflow/api";
import { PAIRING_TTL_BOUNDS, generateToken, hashToken } from "@trafficflow/services";
import { apiRoutes } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { pairRoutes } from "../src/routes/pair.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * ═══ THE PAIRING CEREMONY OVER HTTP — authority, wire shapes, and the table censuses ════════
 *
 * The service's own claims (the atomic burn under concurrency, hash at rest against a real
 * catalog, the register round-trip stamping `email_verified_at`) are proven in
 * `packages/services/test/pairing.pg.test.ts` on real Postgres. THIS file proves what only the
 * route table and the middleware pipeline can prove:
 *
 *  1. **Authority per route.** Mint and revoke demand a session AND a fresh second factor —
 *     watched to fail by the stale-factor cases. Since the managed device-pairing mount the
 *     pairing routes ride `apiRoutes` too, so `step-up-pipeline-census.test.ts` sweeps them as
 *     well; the cases here remain the named, per-route halves (and drive the SELF-HOST table,
 *     where both grants exist). Redeem demands nothing: the token is the credential.
 *
 *  2. **The handler's own envelope.** `POST /pair/redeem` runs on the RAW pipeline — no
 *     `withErrorEnvelope` above it — so the handler must map every refusal to the standard
 *     `ApiError` shape itself. A thrown `ServiceError` escaping this handler is a host-level 500
 *     with a stack; the malformed-JSON and unknown-token cases pin that it never does.
 *
 *     It ran on the ANONYMOUS pipeline until that was found to make a rule unenforceable: that
 *     chain omits `withSession`, so `ctx.accountId` was always empty and the cross-account refusal
 *     could never fire here. RAW resolves the session and still omits the envelope, so this
 *     paragraph's requirement is unchanged and the refusal now works.
 *
 *  3. **The composition censuses.** Pairing mounts on the self-host table (both grants) and,
 *     since the managed device-pairing slice, on the hosted table (device-pair only in effect —
 *     the bag decides; `pair-hosted.test.ts` drives that door and `hello.test.ts` owns the
 *     table census). Here the options census pins the pipeline each route actually runs —
 *     the anonymous/unauthenticated/public fence is asserted over THIS module so it holds
 *     wherever the routes mount.
 *
 *  4. **The paired session's standing.** A `device-pair` redeem hands back a bearer pair whose
 *     device row carries the minter's label (visible in `GET /devices`, revocable by
 *     `DELETE /devices/:id`) and whose session has NO step-up standing — `lastTwofaAt` is NULL
 *     by design (`establishPairedDevice`), so a freshly paired device cannot revoke devices or
 *     mint more pairing tokens until its holder asserts a factor. Pinned here at the HTTP layer
 *     because that is where the privilege would be spent.
 */

const app = createApp(selfHostRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const STALE = new Date(FIXED_NOW.getTime() - 60 * 60_000);

const mintReq = (bearer: string, body: Record<string, unknown>): Request =>
  req("POST", "/pair", { bearer, body: JSON.stringify(body) });

describe("POST /pair — mint demands a session and a FRESH factor", () => {
  it("no session → 401; stale factor → 403 step_up_required; fresh → the raw token, once", async () => {
    const { db, deps } = await makeDeps();

    const anon = await H(req("POST", "/pair", { body: "{}" }), deps);
    expect(anon.status).toBe(401);

    const stale = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: STALE });
    const refused = await H(mintReq(stale.token, { grant: "invite" }), deps);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("step_up_required");

    const fresh = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(mintReq(fresh.token, { grant: "invite", label: "grandma's invite" }), deps);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    // The mint response's frozen shape — the self-host setup flow and the Phase 3/5 clients parse it.
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "grant", "id", "label", "token"]);
    expect(body.grant).toBe("invite");
    expect(body.label).toBe("grandma's invite");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url

    // …and the raw value is NOT what the row stores. The whole-catalog LIKE sweep is the pg
    // test's; this pins the field-level discipline at the layer that just handed the value out.
    const [row] = await db.select().from(pairingTokens).where(eq(pairingTokens.id, body.id));
    expect(row!.tokenHash).not.toBe(body.token);
    expect(row!.tokenHash).toHaveLength(43); // sha256, base64url — a digest, not the value
    expect(row!.createdByUserId).toBe(fresh.userId);
  });

  it("bounds are the service's: unknown grant, oversize ttl and a device-pair label cap refuse as 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const badGrant = await H(mintReq(s.token, { grant: "backdoor" }), deps);
    expect(badGrant.status).toBe(400);
    expect((await badGrant.json()).error.code).toBe("validation_failed");

    // One second past the device-pair cap, refused rather than clamped.
    const overCap = await H(mintReq(s.token, {
      grant: "device-pair", ttlSeconds: PAIRING_TTL_BOUNDS["device-pair"].maxMs / 1000 + 1,
    }), deps);
    expect(overCap.status).toBe(400);
    expect((await overCap.json()).error.code).toBe("validation_failed");

    const longLabel = await H(mintReq(s.token, { grant: "invite", label: "x".repeat(101) }), deps);
    expect(longLabel.status).toBe(400);
  });
});

describe("GET /pair — the caller's own mints, hashless, and nobody else's", () => {
  it("lists own tokens with the frozen item shape and never a hash; a sibling account sees nothing", async () => {
    const { db, deps } = await makeDeps();
    const alice = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(mintReq(alice.token, { grant: "invite", label: "for Bob" }), deps)).json();

    const anon = await H(req("GET", "/pair"), deps);
    expect(anon.status).toBe(401);

    const list = await (await H(req("GET", "/pair", { bearer: alice.token }), deps)).json();
    expect(list.items).toHaveLength(1);
    // The frozen list-item shape. `token` and any hash are structurally absent — a key census,
    // not a value check, so a field added later carrying the secret fails here by existing.
    expect(Object.keys(list.items[0]).sort()).toEqual(
      ["consumedAt", "createdAt", "expiresAt", "grant", "id", "label", "revokedAt", "status"],
    );
    expect(list.items[0].id).toBe(minted.id);
    expect(list.items[0].status).toBe("live");

    const carol = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const carols = await (await H(req("GET", "/pair", { bearer: carol.token }), deps)).json();
    expect(carols.items).toEqual([]);
  });
});

describe("DELETE /pair/:id — step-up-gated, own tokens only, one answer for every miss", () => {
  it("revokes an own live token (204), refuses a stale factor, 404s a foreign or spent id", async () => {
    const { db, deps } = await makeDeps();
    const alice = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(mintReq(alice.token, { grant: "invite" }), deps)).json();

    const stale = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: STALE });
    const gated = await H(req("DELETE", `/pair/${minted.id}`, { bearer: stale.token }), deps);
    expect(gated.status).toBe(403);
    expect((await gated.json()).error.code).toBe("step_up_required");

    // A FRESH-factored sibling still cannot revoke Alice's token — the same 404 an unknown id
    // gets, so ids are not probeable across accounts.
    const carol = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const notMine = await H(req("DELETE", `/pair/${minted.id}`, { bearer: carol.token }), deps);
    expect(notMine.status).toBe(404);

    const ok = await H(req("DELETE", `/pair/${minted.id}`, { bearer: alice.token }), deps);
    expect(ok.status).toBe(204);
    const again = await H(req("DELETE", `/pair/${minted.id}`, { bearer: alice.token }), deps);
    expect(again.status).toBe(404);

    // …and the revoked token no longer redeems.
    const redeem = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "invite", token: minted.token, email: "bob@example.com" }),
    }), deps);
    expect(redeem.status).toBe(400);
    expect((await redeem.json()).error.code).toBe("pairing_invalid");
  });
});

describe("POST /pair/redeem — anonymous, and the handler owns its envelope", () => {
  it("invite grant: anonymous redeem registers an account that is NOT verified — and a forged wire flag cannot change that", async () => {
    // This case used to assert the created account arrived VERIFIED, and that assertion was the
    // defect: the token's holder types any address they like into an anonymous endpoint, nothing
    // is ever mailed, so a verified mark here was a forgery of address control. The bridge's
    // property is registration WITHOUT a mailer; verification is conferred only when the
    // consumed token was the server's own first-boot (ownerless) mint — a session-minted token
    // like this one confers nothing, and the account proves its address later via the ordinary
    // mailed flow.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(mintReq(s.token, { grant: "invite", label: "family" }), deps)).json();

    // No bearer, no cookie — the setup page's exact position. `confersVerified: true` rides in
    // the body DELIBERATELY: the exact field a forger would send. The handler forwards `token`
    // and `email` and nothing else, and the service reads the discriminator off the consumed
    // token row, so the flag must change nothing anywhere below.
    const res = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({
        grant: "invite", token: minted.token, email: "bob@example.com", confersVerified: true,
      }),
    }), deps);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["grant", "invite"]);
    expect(Object.keys(body.invite).sort()).toEqual(["code", "email", "expiresAt"]);
    expect(body.invite.email).toBe("bob@example.com");

    // The client's next move, verbatim: the existing register, invite path — same 201, same
    // enrollment session. Only the verification mark is withheld.
    const reg = await H(req("POST", "/auth/register", {
      body: JSON.stringify({
        email: "bob@example.com", password: "a-long-enough-password",
        displayName: "Bob", inviteCode: body.invite.code,
      }),
    }), deps);
    expect(reg.status, await reg.clone().text()).toBe(201);
    const [bob] = await db.select().from(users).where(eq(users.email, "bob@example.com"));
    expect(bob, "the account itself must exist — only the mark is withheld").toBeDefined();
    expect(bob!.emailVerifiedAt,
      "a user-minted pairing token must never produce a verified account").toBeNull();

    // Single-use: the same token again is one refusal, indistinguishable from unknown.
    const replay = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "invite", token: minted.token, email: "eve@example.com" }),
    }), deps);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe("pairing_invalid");
  });

  it("device-pair grant: the bearer pair works, the device carries the label, and the session has NO step-up standing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(
      mintReq(s.token, { grant: "device-pair", label: "Kitchen iPad" }), deps,
    )).json();

    const res = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), deps);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["grant", "tokens"]);
    expect(Object.keys(body.tokens).sort()).toEqual(
      ["accessToken", "expiresIn", "refreshToken", "tokenType"],
    );
    // No Set-Cookie: a token shown on a screen must not become a browser session.
    expect(res.headers.getSetCookie()).toEqual([]);

    // The pair signs in as the MINTER, and the device row carries the minter's label — the
    // visibility that makes the ceremony revocable and therefore safe to offer.
    const devices = await (await H(req("GET", "/devices", { bearer: body.tokens.accessToken }), deps)).json();
    const iPad = devices.items.find((d: { label: string }) => d.label === "Kitchen iPad");
    expect(iPad).toBeDefined();
    // The redeemer declared nothing, so the device is a BROWSER ("web") — the default that
    // replaced the hardcoded "macos" wire wart. The list must say what actually paired.
    expect(iPad.kind).toBe("web");

    // NO step-up standing (`lastTwofaAt` NULL by design): the paired device cannot mint more
    // pairing tokens — the chain where pairing begets pairing is structurally closed.
    const chained = await H(mintReq(body.tokens.accessToken, { grant: "device-pair" }), deps);
    expect(chained.status).toBe(403);
    expect((await chained.json()).error.code).toBe("step_up_required");
  });

  it("device-pair `kind`: a declared macos lands on the row; junk refuses 400 WITHOUT burning", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    // The native app's arm (Phase 5): the declaration is stored, so the device list stays true.
    const macMint = await (await H(mintReq(s.token, { grant: "device-pair", label: "Studio Mac" }), deps)).json();
    const mac = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: macMint.token, kind: "macos" }),
    }), deps);
    expect(mac.status, await mac.clone().text()).toBe(200);
    const list = await (await H(req("GET", "/devices", {
      bearer: (await mac.clone().json()).tokens.accessToken,
    }), deps)).json();
    expect(list.items.find((d: { label: string }) => d.label === "Studio Mac")?.kind).toBe("macos");

    // An unlisted kind is the caller's bug: refused as 400, never clamped — and refused BEFORE
    // the burn, so the malformed attempt does not cost the single-use token.
    const junkMint = await (await H(mintReq(s.token, { grant: "device-pair", label: "Junk" }), deps)).json();
    const junk = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: junkMint.token, kind: "toaster" }),
    }), deps);
    expect(junk.status).toBe(400);
    expect((await junk.json()).error.code).toBe("validation_failed");
    const retry = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: junkMint.token }),
    }), deps);
    expect(retry.status, "the junk-kind refusal must not have burned the token").toBe(200);
  });

  it("a composition WITHOUT the invite bridge refuses the invite grant as 400 — the device-pair arm untouched", async () => {
    // The desktop-host door's exact position (Phase 3): its store has no `invites` table, so
    // it never wires `services.inviteRedeem` — and the answer must be a refusal the redeemer can
    // act on, never a relation-does-not-exist 500. Mutation-shaped: delete the port from the
    // self-host bag and THIS is the behaviour you get, proven rather than hoped.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const inviteMint = await (await H(mintReq(s.token, { grant: "invite" }), deps)).json();
    const deviceMint = await (await H(mintReq(s.token, { grant: "device-pair", label: "Phone" }), deps)).json();

    const { inviteRedeem: _dropped, ...services } = deps.services!;
    const bare = { ...deps, services: services as ApiDeps["services"] };

    const refused = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "invite", token: inviteMint.token, email: "bob@example.com" }),
    }), bare);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.code).toBe("validation_failed");

    const paired = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: deviceMint.token }),
    }), bare);
    expect(paired.status, await paired.clone().text()).toBe(200);
  });

  it("a token presented under the WRONG grant refuses WITHOUT burning — the grant is a conjunct of the burn", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "Desk" }), deps)).json();

    const asInvite = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "invite", token: minted.token, email: "eve@example.com" }),
    }), deps);
    expect(asInvite.status).toBe(400);
    expect((await asInvite.json()).error.code).toBe("pairing_invalid");

    // NOT burned: the row is untouched and the rightful arm still works.
    const [row] = await db.select().from(pairingTokens).where(eq(pairingTokens.id, minted.id));
    expect(row!.consumedAt).toBeNull();
    const rightful = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), deps);
    expect(rightful.status).toBe(200);
  });

  it("expiry is the clock's decision: a token past its ttl refuses with the one sentence", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(
      mintReq(s.token, { grant: "device-pair", ttlSeconds: 120 }), deps,
    )).json();

    clock.advance(121_000);
    const res = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("pairing_invalid");
  });

  it("the ANONYMOUS pipeline has no envelope above the handler — so the handler's own never leaks a throw", async () => {
    const { deps } = await makeDeps();

    // Malformed JSON: `readBody` THROWS ServiceError; on this pipeline nothing above the
    // handler catches, so a handler without its own mapping would surface the host's raw 500.
    const bad = await H(req("POST", "/pair/redeem", {
      headers: { "content-type": "application/json" }, body: "{not json",
    }), deps);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("validation_failed");

    const noGrant = await H(req("POST", "/pair/redeem", { body: JSON.stringify({ token: "x" }) }), deps);
    expect(noGrant.status).toBe(400);
    expect((await noGrant.json()).error.code).toBe("validation_failed");

    const unknown = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "invite", token: "no-such-token", email: "a@example.com" }),
    }), deps);
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("pairing_invalid");

    // An invalid ADDRESS refuses before anything could be consumed — asserted here at the wire,
    // proven not-burned in the pg suite.
    const badEmail = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "invite", token: "whatever", email: "not-an-address" }),
    }), deps);
    expect(badEmail.status).toBe(400);
    expect((await badEmail.json()).error.code).toBe("validation_failed");
  });

  it("a NON-OBJECT JSON body is a 400, not a 500 — the field access must not throw", async () => {
    const { db, deps } = await makeDeps();
    // `readBody` returns whatever `JSON.parse` gives, and `null`/`[]`/`42` are all valid JSON.
    // Reading `b.grant` off a non-object throws a TypeError, which the anonymous handler's catch
    // would map to `500 internal` — a client-shape error dressed as a server fault. Each of these
    // is the redeemer sending a well-formed body of the wrong shape; the answer is 400.
    for (const body of ["null", "[]", "42", '"a-string"']) {
      const res = await H(req("POST", "/pair/redeem", {
        headers: { "content-type": "application/json" }, body,
      }), deps);
      expect(res.status, `redeem body ${body}`).toBe(400);
      expect((await res.json()).error.code).toBe("validation_failed");
    }

    // The mint handler has the same `b.*` read; it runs on the FULL pipeline, so an unguarded
    // throw there becomes `withErrorEnvelope`'s 500 rather than the 400 a bad shape deserves.
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const mint = await H(req("POST", "/pair", { bearer: s.token,
      headers: { "content-type": "application/json" }, body: "null" }), deps);
    expect(mint.status).toBe(400);
    expect((await mint.json()).error.code).toBe("validation_failed");
  });

  it("a 5xx caught outside the error envelope is LOGGED, not silently swallowed", async () => {
    // The anonymous pipeline has no `withErrorEnvelope` above the handler, so an unexpected
    // failure — a driver fault, a session-mint throw — is consumed by the handler's own catch.
    // It must still emit the structured error log the middleware would, or a persistent redeem
    // outage leaves no request/error-class trace anywhere.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "boom" }), deps)).json();

    const errors: Array<{ event: string; detail: unknown }> = [];
    const spyLogger = {
      error: (event: string, detail?: unknown) => errors.push({ event, detail }),
      warn: () => {}, info: () => {}, debug: () => {},
      child: () => spyLogger,
    };
    // Force a non-ServiceError out of the session mint — the exact shape a driver throw takes.
    const boomAuth = {
      ...deps.services!.auth,
      establishPairedDevice: async () => { throw new Error("driver exploded mid-mint"); },
    };
    const boomDeps = {
      ...deps,
      logger: spyLogger as unknown as ApiDeps["logger"],
      services: { ...deps.services!, auth: boomAuth as unknown as ApiDeps["services"]["auth"] },
    };
    const res = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), boomDeps);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal");
    // The trace exists, and it does NOT leak the driver's message onto the wire.
    expect(errors.length, "the anonymous handler swallowed a 5xx without logging it").toBeGreaterThan(0);
    expect(JSON.stringify(await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: "x" }),
    }), boomDeps).then((r) => r.json()))).not.toContain("driver exploded");
  });
});

describe("the options census — the pipeline each pairing route actually runs", () => {
  const key = (r: Route): string => `${r.method} ${r.pattern}`;

  it("redeem is anonymous + public + unauthenticated; mint and revoke are step-up ceremonies; the list is a read", () => {
    const byKey = new Map(pairRoutes.map((r) => [key(r), r]));
    expect([...byKey.keys()].sort()).toEqual(
      ["DELETE /pair/:id", "GET /pair", "POST /pair", "POST /pair/redeem", "POST /pair/state"],
    );
    // The state read by a token's hash: no session, no burn, a ceremony like the revoke.
    const state = byKey.get("POST /pair/state")!;
    expect(state.cost).toBe("ceremony");
    expect(state.options).toEqual({ public: true });

    const redeem = byKey.get("POST /pair/redeem")!;
    expect(redeem.cost).toBe("unauthenticated");
    // `credentialSubject` joined this set when the redeem's own answer was found to name nobody:
    // it mints a full bearer session from the pairing token in the body, and on the anonymous
    // pipeline there is no session for the account header to fall back to — so a successful pair
    // came back with no `X-Ohmail-Account` at all. The flag moves the header's value to the
    // account the TOKEN resolved to. It grants nothing: `anonymous` and `public` are unchanged and
    // are what decide this route's authority. See `account-header-census.test.ts`, which derives
    // the set of credential routes from the handlers rather than listing them.
    // `anonymous` LEFT this set, and the flag it lost was the one making a rule unenforceable:
    // ANONYMOUS_PIPELINE omits `withSession`, so `ctx.accountId` was always empty here and the
    // cross-account refusal could never fire — a session for one account could redeem another's
    // pairing token, spend it, and be handed their session. `raw` rather than plain `public`
    // because FULL_PIPELINE would add CSRF, which the cookie-bearing redeem case below cannot
    // satisfy. See `routes/pair.ts`.
    expect(redeem.options).toEqual({ public: true, raw: true, credentialSubject: true });

    const mint = byKey.get("POST /pair")!;
    expect(mint.cost).toBe("ceremony");
    expect(mint.options).toEqual({ stepUp: true });

    const revoke = byKey.get("DELETE /pair/:id")!;
    expect(revoke.cost).toBe("ceremony");
    expect(revoke.options).toEqual({ stepUp: true });

    const list = byKey.get("GET /pair")!;
    expect(list.cost).toBe("read");
    expect(list.options).toBeUndefined();
  });

  it("the spend-gate fence holds over THIS module: anonymous ⇒ unauthenticated ⇒ public", () => {
    // `spend-gate.test.ts` asserts this pairing over `apiRoutes`, which these routes never
    // enter — the same fence is therefore owed here, in both directions, or an anonymous
    // pairing route could quietly claim a gated class nothing can enforce on its pipeline.
    for (const r of pairRoutes) {
      if (r.options?.anonymous) {
        expect(r.cost, `${key(r)} resolves no session, so it cannot be gated`).toBe("unauthenticated");
      }
      if (r.cost === "unauthenticated") {
        expect(r.options?.public, `${key(r)} claims no user session decides anything`).toBe(true);
      }
    }
  });

  it("the mount census is hello.test.ts's; this is the tripwire copy nearest the module", () => {
    expect(selfHostRoutes.filter((r) => r.pattern.startsWith("/pair"))).toHaveLength(5);
    // The hosted table carries the ceremony whole since the managed device-pairing mount
    // (watched red here at `[]` before this line moved); the local table never does.
    expect(apiRoutes.filter((r) => r.pattern.startsWith("/pair"))).toHaveLength(5);
    expect(localRoutes.filter((r) => r.pattern.startsWith("/pair"))).toEqual([]);
  });
});

/**
 * THE DEVICE-PAIR REDEEM ANSWERS FOR THE ACCOUNT IT PAIRED WITH — and refuses to pair one
 * account's device against another's session.
 *
 * ── WHAT THIS BLOCK IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────
 *
 * It is EVIDENCE, not a fix. Both behaviours already hold, and they hold one call deeper than the
 * redeem: `establishPairedDevice` inserts the device row and then hands off to `establish`, which
 * is where `refuseCrossAccountCredential` and `noteCredentialAccount` both live — so every seam
 * that mints a session gets them once instead of each remembering.
 *
 * What was missing was anything that watched either of them HERE. The route's own suite asserted
 * the flags (`{ public, raw, credentialSubject }`) and carried a comment saying the cross-account
 * refusal could now fire, and no case made it fire. A flag plus a comment is exactly the shape
 * that reads as a guarantee and is not one, and the distance between the route and the guard is
 * three call frames of somebody else's file.
 *
 * The two facts this pins, which the pipeline supplies and the service consumes:
 *
 *  · `ctx.accountId` is `withSession`'s. It is populated because the route is `public + raw` and
 *    NOT `anonymous` — the anonymous pipeline omits `withSession`, and while it did, the refusal
 *    compared against an operand that was always empty and could never fire.
 *  · `ACCOUNT_HEADER`'s value is `nameTheAccount`'s reading of `deps.credentialAccount`, which the
 *    service reports through `noteCredentialAccount` and which `inTransaction` buffers until the
 *    transaction commits — so a rolled-back mint names nobody.
 *
 * Driven through the ROUTE and not the function, because every one of those operands comes from
 * the pipeline: a test against `establishPairedDevice` would be green with the route reverted to
 * `anonymous`, which is the state this all exists to have left behind.
 */
describe("POST /pair/redeem — device-pair, and whose account the answer is about", () => {
  it("ADMITS an ordinary sessionless redeem, and names the account it paired with", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(
      mintReq(s.token, { grant: "device-pair", label: "Spare laptop" }), deps,
    )).json();

    const res = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token, kind: "desktop-linux" }),
    }), deps);

    // THE POSITIVE CONTROL, asserted by its EFFECT and not by a status alone: the pair works, and
    // the device row it created is visible to the session it just minted. A refusal rule whose
    // every case is a refusal has no evidence it admits the right person.
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.clone().json();
    const devices = await (await H(req("GET", "/devices", { bearer: body.tokens.accessToken }), deps)).json();
    expect(devices.items.find((d: { label: string }) => d.label === "Spare laptop")?.kind)
      .toBe("desktop-linux");

    // AND THE ANSWER NAMES THE ACCOUNT. This is what a freshly paired install binds its local
    // store to; without it the header was absent on exactly the responses the flag was added for.
    const named = res.headers.get(ACCOUNT_HEADER);
    expect(named, "a successful pair named no account").toBeTruthy();
    const [row] = await db.select().from(users).where(eq(users.id, s.userId));
    expect(named).toBe(row!.accountId);
  });

  it("a desktop's redeem carrying its install's previous digest ends that family", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const redeem = async (extra: Record<string, unknown> = {}): Promise<Response> => {
      const minted = await (await H(mintReq(s.token, { grant: "device-pair", label: "Spare laptop" }), deps)).json();
      return H(req("POST", "/pair/redeem", {
        body: JSON.stringify({ grant: "device-pair", token: minted.token, kind: "desktop-linux", ...extra }),
      }), deps);
    };
    const first = (await (await redeem()).json()).tokens.refreshToken as string;
    expect((await redeem({ previousSession: hashToken(first) })).status).toBe(200);
    const late = await H(req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: first }) }), deps);
    expect(late.status, "the install's previous family still renews").toBe(401);
  });

  /** One person's pairing redeems, each of a kind, and a renewal of what one of them minted. */
  async function installs(deps: ApiDeps, owner: { token: string }) {
    const redeem = async (kind: string, extra: Record<string, unknown> = {}): Promise<Response> => {
      const minted = await (await H(mintReq(owner.token, { grant: "device-pair", label: "An install" }), deps)).json();
      return H(req("POST", "/pair/redeem", {
        body: JSON.stringify({ grant: "device-pair", token: minted.token, kind, ...extra }),
      }), deps);
    };
    const refreshOf = async (kind: string): Promise<string> => {
      const res = await redeem(kind);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()).tokens.refreshToken as string;
    };
    const renews = async (refreshToken: string): Promise<{ status: number; code: unknown }> => {
      const res = await H(req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken }) }), deps);
      return { status: res.status, code: res.ok ? null : (await res.json()).error?.code };
    };
    return { redeem, refreshOf, renews };
  }

  it.each([["a phone", "mobile-android"], ["a paired browser", "web"]] as const)(
    "%s re-pairing with its previous family named ends that family", async (_name, kind) => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const o = await installs(deps, s);
      const previous = await o.refreshOf(kind);
      expect((await o.redeem(kind, { previousSession: hashToken(previous) })).status).toBe(200);
      expect(await o.renews(previous), "the install's previous family still renews")
        .toEqual({ status: 401, code: "refresh_revoked" });
    },
  );

  it("control: a phone's re-pair names a desktop's, a browser's or another person's family and ends none", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const o = await installs(deps, s);
    const desktop = await o.refreshOf("desktop-linux");
    const pairedWeb = await o.refreshOf("web");
    // A plain browser sign-in's family: no device row, so no install's.
    const [own] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    const plainWeb = generateToken();
    await db.insert(refreshTokens).values({
      accountId: own!.accountId, userId: own!.userId, sessionId: own!.id, familyId: own!.familyId,
      tokenHash: hashToken(plainWeb), expiresAt: new Date(FIXED_NOW.getTime() + 60 * 60_000), createdAt: FIXED_NOW,
    });
    const stranger = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const theirs = await (await installs(deps, stranger)).refreshOf("mobile-android");
    for (const named of [desktop, pairedWeb, plainWeb, theirs]) {
      expect((await o.redeem("mobile-android", { previousSession: hashToken(named) })).status).toBe(200);
    }
    for (const named of [desktop, pairedWeb, plainWeb, theirs]) {
      expect((await o.renews(named)).status, "a family that was not this install's was ended").toBe(200);
    }
  });

  it("control: a malformed previousSession ends nothing and refuses nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const o = await installs(deps, s);
    const previous = await o.refreshOf("mobile-ios");
    for (const previousSession of [previous, "not a digest", 42, { digest: hashToken(previous) }]) {
      expect((await o.redeem("mobile-ios", { previousSession })).status).toBe(200);
    }
    expect((await o.renews(previous)).status).toBe(200);
  });

  it("ADMITS a redeem made while signed in to the SAME account", async () => {
    // The ordinary "pair my other machine from the machine I am sitting at" case. It presents a
    // session, so it is the case a careless refusal would break.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(
      mintReq(s.token, { grant: "device-pair", label: "Same account" }), deps,
    )).json();

    const res = await H(req("POST", "/pair/redeem", {
      bearer: s.token,
      body: JSON.stringify({ grant: "device-pair", token: minted.token, kind: "desktop-macos" }),
    }), deps);

    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, s.userId));
    expect(res.headers.get(ACCOUNT_HEADER)).toBe(row!.accountId);
  });

  it("REFUSES a session for one account redeeming another's token — and does not burn it", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const stranger = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const [ownerRow] = await db.select().from(users).where(eq(users.id, owner.userId));
    const [strangerRow] = await db.select().from(users).where(eq(users.id, stranger.userId));
    expect(ownerRow!.accountId, "the fixture seeded one account twice").not.toBe(strangerRow!.accountId);

    const minted = await (await H(
      mintReq(owner.token, { grant: "device-pair", label: "Owner's tablet" }), deps,
    )).json();

    const res = await H(req("POST", "/pair/redeem", {
      bearer: stranger.token,
      body: JSON.stringify({ grant: "device-pair", token: minted.token, kind: "desktop-linux" }),
    }), deps);

    expect(res.status).toBe(409);
    expect((await res.clone().json()).error.code).toBe("session_conflict");
    // NO SESSION HANDED OVER — the body carries no tokens at all, which is the whole point.
    expect((await res.clone().json()).tokens).toBeUndefined();
    // AND THE REFUSAL IS NOT LABELLED WITH AN ACCOUNT. Nothing was established, so there is
    // nothing for the answer to be about.
    expect(res.headers.get(ACCOUNT_HEADER)).toBeNull();

    // THE TOKEN SURVIVES. The refusal happens inside the transaction that consumed it, so the
    // burn rolls back and the person whose code it is can still use it — a stranger must not be
    // able to spend somebody's single-use pairing code merely by failing to redeem it.
    const after = await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token, kind: "desktop-linux" }),
    }), deps);
    expect(after.status, "the refused attempt burned the account holder's token").toBe(200);
    expect(after.headers.get(ACCOUNT_HEADER)).toBe(ownerRow!.accountId);
  });
});
