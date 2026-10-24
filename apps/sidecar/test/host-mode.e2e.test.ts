import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

// Every test here stands up the real sidecar (createSidecar boots the engine's PGlite and
// runs its migrations) in the test body — see pglite-budget.ts for the measured cost.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ HOST MODE ON THE REAL COMPOSITION ROOT — armed and disarmed, both pinned ═══════════════
 *
 * `createSidecar({ hostMode: true })` is the desktop-as-host composition: the stdio door gains
 * the window-only pairing mint, its `/hello` flips `pairing: true`, and `handleHost` — the
 * desktop-host door the loopback listener will bind — exists. DISARMED (the default, and every
 * install that has never heard of the flag) is pinned just as hard in the other direction: no
 * mint route, no second door, `pairing: false`. Absent-config-selects-the-dangerous-branch is
 * the ruling's top-ranked risk, so the disarmed suite is not a courtesy — it is the census that
 * goes red if anyone mounts the mint unconditionally.
 *
 * Everything runs against on-disk PGlite through the real `createSidecar`, driving the two
 * doors' own `handle`/`handleHost` — the entries the stdio bridge and the future listener
 * serve. The clock is injected so the step-up-window proof below is a fact, not a sleep.
 */

const AT = new Date("2026-08-18T09:00:00.000Z");

const dirs: string[] = [];
const sidecars: Sidecar[] = [];

afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function standUp(opts: { hostMode?: boolean } = {}): Promise<{ sidecar: Sidecar; clock: { advance(ms: number): void } }> {
  const dir = await freshDataDir("ohmail-host-mode-");
  dirs.push(dir);
  let t = new Date(AT);
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "mila@example.test", pass: "app-password-9f3a" } },
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    now: () => t,
    ...(opts.hostMode !== undefined ? { hostMode: opts.hostMode } : {}),
  });
  sidecars.push(sidecar);
  return { sidecar, clock: { advance: (ms) => { t = new Date(t.getTime() + ms); } } };
}

const json = (body: unknown): { body: string; headers: Record<string, string> } => ({
  body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

function req(method: string, path: string, init: { bearer?: string; body?: string; headers?: Record<string, string>; cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`http://sidecar${path}`, { method, headers, body: init.body });
}

describe("DISARMED — the default composition is byte-identical to the pre-host build", () => {
  it("has no second door, no mint route, and /hello says pairing: false", async () => {
    const { sidecar } = await standUp(); // no flag at all — every install today
    expect(sidecar.handleHost).toBeUndefined();

    // The mint is ABSENT, not gated: 404, not 401 — with the launch bearer presented, so the
    // refusal cannot be a credential problem. Mutation watched red: mounting `hostPairRoutes`
    // unconditionally answers 400 here (the empty body's validation), and this census catches it.
    const res = await sidecar.handle(req("POST", "/pair", { bearer: sidecar.sessionToken, ...json({}) }));
    expect(res.status).toBe(404);
    const list = await sidecar.handle(req("GET", "/pair", { bearer: sidecar.sessionToken }));
    expect(list.status).toBe(404);

    const hello = await (await sidecar.handle(req("GET", "/hello"))).json();
    expect(hello.flavor).toBe("local");
    expect(hello.features.pairing).toBe(false);
  });

  it("hostMode must be the exact boolean true — a garbage value stays disarmed", async () => {
    const { sidecar } = await standUp({ hostMode: "yes" as unknown as boolean });
    expect(sidecar.handleHost).toBeUndefined();
    const res = await sidecar.handle(req("POST", "/pair", { bearer: sidecar.sessionToken, ...json({}) }));
    expect(res.status).toBe(404);
  });
});

describe("ARMED — the stdio door's window-only mint", () => {
  it("mints with the launch bearer, stepUp:false — still minting long after the boot stamp aged out", async () => {
    const { sidecar, clock } = await standUp({ hostMode: true });

    // The stdio door still answers flavor "local" — arming changes what it CARRIES, not what
    // it IS — and the descriptor now announces the ceremony the window can offer.
    const hello = await (await sidecar.handle(req("GET", "/hello"))).json();
    expect(hello.flavor).toBe("local");
    expect(hello.features.pairing).toBe(true);

    const minted = await sidecar.handle(req("POST", "/pair", {
      bearer: sidecar.sessionToken, ...json({ grant: "device-pair", label: "Pixel in the kitchen" }),
    }));
    expect(minted.status).toBe(200);
    const mintedBody = await minted.json();
    expect(typeof mintedBody.token).toBe("string");

    // THE STEP-UP-WINDOW PROOF. The launch session's factor stamp is written ONCE at boot;
    // `stepUpWindowMs` is five minutes. Six minutes later a `stepUp: true` mint would answer
    // 403 step_up_required for the rest of the process's life — the defect the ruling names —
    // and `stepUp: false` (machine login IS the step-up) keeps minting. Mutation watched red:
    // flipping the route to `stepUp: true` fails exactly this assertion.
    clock.advance(6 * 60 * 1000);
    const later = await sidecar.handle(req("POST", "/pair", {
      bearer: sidecar.sessionToken, ...json({ grant: "device-pair", label: "The studio iPad" }),
    }));
    expect(later.status, "the mint must not decay five minutes after launch").toBe(200);
  });

  it("refuses everything that is not a device-pair mint: invite grant, absent grant, no credential", async () => {
    const { sidecar } = await standUp({ hostMode: true });

    // An invite token minted here would be a credential nothing can spend — this engine's own
    // redeem refuses the invite arm — so the mint refuses the grant before the service writes.
    const invite = await sidecar.handle(req("POST", "/pair", {
      bearer: sidecar.sessionToken, ...json({ grant: "invite", label: "first-run" }),
    }));
    expect(invite.status).toBe(400);
    expect((await invite.json()).error.code).toBe("validation_failed");

    const absent = await sidecar.handle(req("POST", "/pair", { bearer: sidecar.sessionToken, ...json({}) }));
    expect(absent.status).toBe(400);

    // No bearer ⇒ 401 from the pipeline: the mint is window-only because the launch bearer
    // never leaves the shell, and this is that boundary answering.
    const anon = await sidecar.handle(req("POST", "/pair", json({ grant: "device-pair" })));
    expect(anon.status).toBe(401);
  });

  it("lists and revokes over the same paths the shared ceremony uses; a revoked token cannot redeem", async () => {
    const { sidecar } = await standUp({ hostMode: true });
    const bearer = sidecar.sessionToken;

    const minted = await (await sidecar.handle(req("POST", "/pair", {
      bearer, ...json({ grant: "device-pair", label: "to be revoked" }),
    }))).json();

    const listed = await (await sidecar.handle(req("GET", "/pair", { bearer }))).json();
    expect(listed.items.some((i: { id: string }) => i.id === minted.id)).toBe(true);

    const revoked = await sidecar.handle(req("DELETE", `/pair/${minted.id}`, { bearer }));
    expect(revoked.status).toBe(204);

    // The revoked token is dead on the HOST door too — one pairing store under both doors.
    const redeem = await sidecar.handleHost!(req("POST", "/pair/redeem",
      json({ grant: "device-pair", token: minted.token })));
    expect(redeem.status).toBeGreaterThanOrEqual(400);

    const again = await sidecar.handle(req("DELETE", `/pair/${minted.id}`, { bearer }));
    expect(again.status).toBe(404);
  });
});

describe("ARMED — the desktop-host door, stdio→host end to end", () => {
  it("/hello answers desktop-host with pairing on and not one Set-Cookie", async () => {
    const { sidecar } = await standUp({ hostMode: true });
    const res = await sidecar.handleHost!(req("GET", "/hello"));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await res.json();
    expect(body.flavor).toBe("desktop-host");
    expect(body.needsSetup).toBe(false);
    expect(body.auth).toEqual({ password: false, totp: false, webauthn: false, publicSignup: false });
    /* `accountHeader` is a CONSTANT of the BUILD, not a host choice: the route table sets it
       `true` outright because `createApp.handle` sets `X-Ohmail-Account` in every composition
       compiled from that table, and a capability a host could contradict is worse than none. It
       is pinned HERE, in the frozen key set, because its whole use is negotiation by ABSENCE — a
       client requires the header only from a server that advertises it, so the day this key stops
       being sent every older client silently stops requiring it. That is exactly the change a
       frozen `toEqual` exists to catch. */
    expect(body.features).toEqual({
      sse: false, staging: false, ai: false, pairing: true,
      // Same composition, same armed egress as the window's own door.
      remoteImages: true, accountHeader: true, forwardParts: true,
    });
  });

  it("the loop the product is: mint on stdio → redeem on the host door → bearer /sync works → refresh rotates", async () => {
    const { sidecar } = await standUp({ hostMode: true });

    // 1. The OWNER mints in the window (the stdio door, launch bearer).
    const minted = await (await sidecar.handle(req("POST", "/pair", {
      bearer: sidecar.sessionToken, ...json({ grant: "device-pair", label: "Pixel in the kitchen" }),
    }))).json();

    // 2. The PHONE redeems on the host door — anonymously; the token is the credential — and
    //    gets the bearer pair with no cookie beside it.
    const redeemed = await sidecar.handleHost!(req("POST", "/pair/redeem",
      json({ grant: "device-pair", token: minted.token })));
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.getSetCookie()).toEqual([]);
    const { tokens } = await redeemed.json();

    // 3. The phone reads mail: bearer /sync against the same engine, same store, same pipeline.
    const sync = await sidecar.handleHost!(req("GET", "/sync", { bearer: tokens.accessToken }));
    expect(sync.status).toBe(200);
    expect(sync.headers.getSetCookie()).toEqual([]);

    // 4. …and its session lives by the shared lifecycle: the refresh rotates, cookie-free.
    const rotated = await sidecar.handleHost!(req("POST", "/auth/refresh",
      json({ refreshToken: tokens.refreshToken })));
    expect(rotated.status).toBe(200);
    expect(rotated.headers.getSetCookie()).toEqual([]);
    const rotatedBody = await rotated.json();
    expect(rotatedBody.tokens.refreshToken).not.toBe(tokens.refreshToken);

    // 5. The device is visible — and takable-back — from the surface the door carries.
    const devices = await (await sidecar.handleHost!(req("GET", "/devices", {
      bearer: rotatedBody.tokens.accessToken,
    }))).json();
    expect(devices.items.some((i: { label: string }) => i.label === "Pixel in the kitchen")).toBe(true);
  });

  it("the host door is bearer-only in BOTH directions: a valid tf_refresh cookie neither rotates nor answers cookies", async () => {
    // The composition-level pin of `allowCookieAuth: false` on the host door's deps. Mutation
    // watched red: flipping the flag in `depsForHost` makes the cookie branch rotate and answer
    // Set-Cookie here.
    const { sidecar } = await standUp({ hostMode: true });
    const minted = await (await sidecar.handle(req("POST", "/pair", {
      bearer: sidecar.sessionToken, ...json({ grant: "device-pair", label: "phone" }),
    }))).json();
    const redeemed = await (await sidecar.handleHost!(req("POST", "/pair/redeem",
      json({ grant: "device-pair", token: minted.token })))).json();

    const viaCookie = await sidecar.handleHost!(req("POST", "/auth/refresh", {
      cookie: `tf_refresh=${redeemed.tokens.refreshToken}`,
    }));
    expect(viaCookie.status).toBe(401);
    expect(viaCookie.headers.getSetCookie()).toEqual([]);

    // Nothing was spent: the same token still rotates through the body.
    const viaBody = await sidecar.handleHost!(req("POST", "/auth/refresh",
      json({ refreshToken: redeemed.tokens.refreshToken })));
    expect(viaBody.status).toBe(200);
  });

  it("a paired session cannot sign the whole account out — allDevices is mass revocation and step-up gates it", async () => {
    // A review's finding, pinned: `POST /auth/logout {"allDevices":true}` forwarded the
    // option into a family-wide revoke, so a paired bearer — whose NULL factor stamp exists
    // precisely so it cannot revoke devices — could sign out the window's launch session and
    // every other paired device in one anonymous-credential request. Mass logout IS device
    // revocation in effect, so it takes device revocation's gate. The phone's OWN sign-out
    // (no flag) stays ungated: taking back your own credential must never be hard.
    const { sidecar } = await standUp({ hostMode: true });
    const minted = await (await sidecar.handle(req("POST", "/pair", {
      bearer: sidecar.sessionToken, ...json({ grant: "device-pair", label: "phone" }),
    }))).json();
    const redeemed = await (await sidecar.handleHost!(req("POST", "/pair/redeem",
      json({ grant: "device-pair", token: minted.token })))).json();

    const nuke = await sidecar.handleHost!(req("POST", "/auth/logout", {
      bearer: redeemed.tokens.accessToken, ...json({ allDevices: true }),
    }));
    expect(nuke.status).toBe(403);
    expect((await nuke.json()).error.code).toBe("step_up_required");

    // Nothing died: the window's launch bearer still works, and so does the phone's.
    expect((await sidecar.handle(req("GET", "/sync", { bearer: sidecar.sessionToken }))).status).toBe(200);
    const own = await sidecar.handleHost!(req("POST", "/auth/logout", {
      bearer: redeemed.tokens.accessToken, ...json({}),
    }));
    expect(own.status).toBe(204);
    expect((await sidecar.handleHost!(req("GET", "/sync", { bearer: redeemed.tokens.accessToken }))).status).toBe(401);
    expect((await sidecar.handle(req("GET", "/sync", { bearer: sidecar.sessionToken }))).status).toBe(200);
  });

  it("the WINDOW takes a pairing back: armed stdio devices list + revoke, alive long after boot", async () => {
    // The other half of the same finding: the mint landed without the take-back, so a paired
    // credential had NO revocation path (the host door's revoke refuses paired sessions by
    // design, and the stdio door served no /devices at all). The window's door now carries
    // both, armed-only, with the machine login as the step-up — proven the same way as the
    // mint, past the five-minute boot stamp.
    const { sidecar, clock } = await standUp({ hostMode: true });
    const minted = await (await sidecar.handle(req("POST", "/pair", {
      bearer: sidecar.sessionToken, ...json({ grant: "device-pair", label: "Pixel in the kitchen" }),
    }))).json();
    const redeemed = await (await sidecar.handleHost!(req("POST", "/pair/redeem",
      json({ grant: "device-pair", token: minted.token })))).json();
    expect((await sidecar.handleHost!(req("GET", "/sync", { bearer: redeemed.tokens.accessToken }))).status).toBe(200);

    clock.advance(6 * 60 * 1000); // past stepUpWindowMs — the boot stamp has decayed
    const listed = await sidecar.handle(req("GET", "/devices", { bearer: sidecar.sessionToken }));
    expect(listed.status).toBe(200);
    const device = (await listed.json()).items.find((i: { label: string }) => i.label === "Pixel in the kitchen");
    expect(device).toBeDefined();

    const revoked = await sidecar.handle(req("DELETE", `/devices/${device.id}`, { bearer: sidecar.sessionToken }));
    expect(revoked.status, "the window must be able to revoke a pairing whenever, not for five minutes").toBe(204);
    expect((await sidecar.handleHost!(req("GET", "/sync", { bearer: redeemed.tokens.accessToken }))).status).toBe(401);
  });

  it("disarmed, the stdio door serves no device surface either — the mount rides the same arm", async () => {
    const { sidecar } = await standUp();
    expect((await sidecar.handle(req("GET", "/devices", { bearer: sidecar.sessionToken }))).status).toBe(404);
  });

  it("the window-only surfaces are structurally absent from the host door", async () => {
    const { sidecar } = await standUp({ hostMode: true });
    // The mint (a remote device must never mint the credential that admits remote devices) and
    // the stored-login forget (the stdio pre-route) — 404: not gated, not mounted. Same answer
    // as before the door served pages, because a WRITE to a path the route table does not know
    // never reaches the static half's fallback.
    for (const [method, path] of [
      ["POST", "/pair"], ["DELETE", "/local/stored-login"],
    ] as const) {
      const res = await sidecar.handleHost!(req(method, path, json({})));
      expect(res.status, `${method} ${path} must be absent from the host door`).toBe(404);
    }
    // The GET shapes changed with the served client: an unrouted GET is now the browser
    // client's INDEX FALLBACK — `/pair` is the pairing landing, and a deep link must reload —
    // so absence here means "not a JSON surface", not "nothing answers". What must hold: the
    // answer is a PAGE (this composition packages no assets, so it is the API-only sentence,
    // still under the door's CSP), never the mint's wire shape and never the AI settings.
    for (const path of ["/pair", "/local/ai"] as const) {
      const res = await sidecar.handleHost!(req("GET", path, {}));
      expect(res.status, `GET ${path}`).toBe(200);
      expect(res.headers.get("content-type"), `GET ${path}`).toContain("text/html");
      expect(res.headers.get("content-security-policy"), `GET ${path}`).toContain("script-src 'self'");
      const body = await res.text();
      expect(body, `GET ${path} must not carry a window-only surface`).not.toContain('"token"');
      expect(body, `GET ${path} must not carry a window-only surface`).not.toContain('"provider"');
    }
    // The invite arm of the redeem refuses cleanly on this composition — no invites table
    // exists here, and the port that would bridge to one is deliberately unwired.
    const invite = await sidecar.handleHost!(req("POST", "/pair/redeem",
      json({ grant: "invite", token: "t".repeat(43), email: "kid@example.com" })));
    expect(invite.status).toBe(400);
    expect((await invite.json()).error.code).toBe("validation_failed");
  });
});
