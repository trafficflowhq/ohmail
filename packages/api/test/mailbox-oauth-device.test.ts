import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { mailboxes, mailboxCredentials, refreshTokens, sessions, type Db } from "@trafficflow/db";
import { deviceCeremonyKey, mailboxOauthDeviceCeremonies } from "@trafficflow/db/cloud";
import { MS_AUTHORIZE_SCOPES, DEVICE_CODE_GRANT_TYPE, type FetchLike } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { generateToken, hashToken } from "@trafficflow/services";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, seedSessionFor, req, FIXED_NOW } from "./helpers.js";

/**
 * THE DEVICE-CODE DOOR (cloud 0027) — the guards, each one written to fail first.
 *
 * The subject is not "the happy path works". It is the properties that make a POLLED ceremony safe,
 * and every one of them is a property the redirect flow next door does not have to have:
 *
 *  1. **THE READ DOES NOT CONSUME.** A ceremony polled N times is still live on the Nth. This is the
 *     one that would be invisible in a happy-path test: a consuming read passes the first poll and
 *     breaks the second, and the second is where the entire flow lives.
 *  2. **THE CLAIM IS SINGLE-USE.** Granted, declined and expired each spend the ceremony exactly
 *     once, so a replayed poll cannot store a second mailbox.
 *  3. **THE CADENCE IS THE SERVER'S.** An early poll is refused WITHOUT a request to Microsoft, and
 *     `slow_down` widens the stored interval CUMULATIVELY across requests. The client id is shared
 *     by every install using the public registration, so this is somebody else's server's problem
 *     if it is wrong.
 *  4. **CROSS-ACCOUNT IS REFUSED AND THE CEREMONY SURVIVES IT.** Deliberately different from the
 *     redirect flow, which burns a stolen `state`. Here the value never leaves the origin, so
 *     claiming on mismatch would hand any authenticated account a one-request way to kill another
 *     account's live ceremony.
 *  5. **THE SEAM IS SEPARATE.** No fallback from the confidential registration, in either
 *     direction, because a confidential client id fails the device grant outright.
 *  6. **THE PROVENANCE IS STORED.** The mailbox's credential records that the PUBLIC registration
 *     issued its refresh token, which is the only thing that keeps it alive past its first hour.
 *  7. **THE DEVICE CODE IS SEALED AND NEVER LEAVES.** Not in the response, not in the row in clear.
 *
 * ── THE TABLE UNDER TEST IS `selfHostRoutes`, NOT `apiRoutes` ───────────────────────────────
 *
 * These two routes are mounted only by the self-host composition. That is a deliberate absence from
 * the hosted table (asserted below), and it also means the frozen route census over the hosted table
 * cannot see them — so their cost class is asserted here, explicitly, rather than being an
 * arithmetic consequence somewhere else.
 */

/** base64url, no padding — the encoding a JWT segment uses. */
const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

/**
 * A fake `id_token`. Header and signature are `x`: nothing in this flow verifies either, for the
 * reason `addressFromIdToken` records — the token arrives in the body of a TLS response to a POST
 * this process made. A test that signed it would assert a property the implementation deliberately
 * does not have.
 */
const idToken = (claims: Record<string, unknown>): string => `x.${b64u(JSON.stringify(claims))}.x`;

const DEVICE_CODE = "DEVICE-CODE-SECRET-1";
const USER_CODE = "ABCD-EFGH";
const VERIFICATION_URI = "https://microsoft.com/devicelogin";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const CONFIDENTIAL_ID = "99999999-8888-7777-6666-555555555555";

type TokenAnswer = { ok: boolean; status: number; body: unknown };

/**
 * A FAKE IDENTITY PROVIDER SERVING BOTH ENDPOINTS.
 *
 * It records which endpoint was hit and with what form, because half of what is under test is
 * WHICH REQUESTS WERE NOT MADE — an early poll that reached Microsoft is the defect, and a fake that
 * only shaped responses could not see it.
 *
 * The endpoints are ASSERTED rather than merely accepted: the host is a constant in `packages/core`
 * and only the tenant segment comes from data, so a test that matched any URL would not notice a
 * stored endpoint being reintroduced.
 */
function fakeIdp(opts: {
  device?: (form: URLSearchParams) => TokenAnswer;
  token?: (form: URLSearchParams, call: number) => TokenAnswer;
} = {}): { fetch: FetchLike; device: URLSearchParams[]; token: URLSearchParams[] } {
  const device: URLSearchParams[] = [];
  const token: URLSearchParams[] = [];
  const fetch: FetchLike = async (url, init) => {
    const form = new URLSearchParams(init.body);
    let r: TokenAnswer;
    if (/\/devicecode$/.test(url)) {
      expect(url).toMatch(/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/devicecode$/);
      device.push(form);
      r = opts.device?.(form) ?? {
        ok: true, status: 200,
        body: {
          device_code: DEVICE_CODE, user_code: USER_CODE,
          verification_uri: VERIFICATION_URI, expires_in: 900, interval: 5,
        },
      };
    } else {
      expect(url).toMatch(/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/);
      token.push(form);
      r = opts.token?.(form, token.length)
        ?? { ok: false, status: 400, body: { error: "authorization_pending" } };
    }
    return {
      ok: r.ok, status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { fetch, device, token };
}

/** The GRANTED answer — a complete, correct token response naming a mailbox address. */
const granted = (): TokenAnswer => ({
  ok: true, status: 200,
  body: {
    access_token: "ACCESS-TOKEN-1",
    refresh_token: "REFRESH-TOKEN-1",
    expires_in: 3600,
    id_token: idToken({ preferred_username: "device-user@contoso-com.example", sub: "opaque-sub" }),
  },
});

const app = createApp(selfHostRoutes);

interface World {
  db: Db;
  deps: ApiDeps;
  token: string;
  accountId: string;
  userId: string;
  sessionId: string;
  idp: ReturnType<typeof fakeIdp>;
  clock: { now: () => Date; advance: (ms: number) => void };
  H: (r: Request, over?: Partial<ApiDeps>) => Promise<Response>;
}

async function world(opts: {
  idp?: ReturnType<typeof fakeIdp>;
  /** `"public"` arms the device door; `"byo-only"` arms ONLY the confidential one; `"none"` neither. */
  arm?: "public" | "byo-only" | "none";
} = {}): Promise<World> {
  const { db, deps, clock } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const idp = opts.idp ?? fakeIdp();
  const arm = opts.arm ?? "public";
  const base: ApiDeps = {
    ...deps,
    appOrigin: "https://mail.example.invalid",
    oauthFetch: idp.fetch,
    ...(arm === "public" ? { msDevice: { clientId: CLIENT_ID, tenant: "common" } } : {}),
    ...(arm === "byo-only"
      ? {
        msOAuth: {
          clientId: CONFIDENTIAL_ID, clientSecret: "THE-SECRET", tenant: "common",
          redirectUri: "https://mail.example.invalid/api/mailboxes/oauth/microsoft/callback",
        },
      }
      : {}),
  };
  return {
    db, deps: base, token: s.token, accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, idp, clock,
    H: (r, over) => app.handle(r, { ...base, ...over, session: null, idempotency: null }),
  };
}

const storedState = ({ accountId, sessionId }: World, state: string): string =>
  deviceCeremonyKey({ accountId, sessionId, state });

const startReq = (token: string): Request =>
  req("POST", "/mailboxes/oauth/microsoft/device/start", { bearer: token, body: "{}" });

const pollReq = (token: string, state: string): Request =>
  req("POST", "/mailboxes/oauth/microsoft/device/poll", { bearer: token, body: JSON.stringify({ state }) });

/** Unwrap the JSON envelope, whichever shape this host is using. */
async function payload<T>(res: Response): Promise<T> {
  const json = (await res.json()) as { data?: T } & T;
  return (json.data ?? json) as T;
}

interface StartPayload {
  state: string; userCode: string; verificationUri: string; expiresAt: string; intervalMs: number;
}

async function start(w: World): Promise<StartPayload> {
  const res = await w.H(startReq(w.token));
  expect(res.status, await res.clone().text()).toBe(201);
  return payload<StartPayload>(res);
}

interface PollPayload {
  status: string; retryAfterMs?: number; expiresAt?: string;
  userCode?: string; verificationUri?: string;
  mailbox?: { id: string; address: string }; created?: boolean;
}

const poll = async (w: World, state: string): Promise<{ res: Response; body: PollPayload }> => {
  const res = await w.H(pollReq(w.token, state));
  return { res, body: await payload<PollPayload>(res.clone()) };
};

beforeEach(() => { vi.restoreAllMocks(); });

describe("cloud 0027 — POST /mailboxes/oauth/microsoft/device/start", () => {
  it("mints a grant bound to the SESSION's account and SEALS the device code", async () => {
    const w = await world();
    const started = await start(w);

    // The two DISPLAY values come back; the credential does not.
    expect(started.userCode).toBe(USER_CODE);
    expect(started.verificationUri).toBe(VERIFICATION_URI);
    expect(JSON.stringify(started)).not.toContain(DEVICE_CODE);
    // Our own handle, 256 bits base64url — and NOT the device code, which would otherwise travel in
    // every poll body and in the operator's proxy logs.
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.state).not.toBe(DEVICE_CODE);

    const [row] = await w.db.select().from(mailboxOauthDeviceCeremonies)
      .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, started.state)));
    expect(row).toBeDefined();
    // The account comes from the session and is part of the stored lookup scope.
    expect(row!.accountId).toBe(w.accountId);
    expect(row!.consumedAt).toBeNull();
    expect(row!.lastPolledAt).toBeNull();
    // SEALED AT REST, exactly like a mailbox password: the ciphertext must not contain the value.
    expect(row!.deviceCodeEnc).not.toContain(DEVICE_CODE);
    expect(row!.deviceCodeKeyVersion).toBeGreaterThan(0);
    const sealed = await w.deps.keyProvider.decrypt(row!.deviceCodeEnc, row!.deviceCodeKeyVersion);
    expect(JSON.parse(sealed)).toEqual({ sessionId: w.sessionId, deviceCode: DEVICE_CODE });
    // Microsoft's own interval and expiry, clamped on the way in.
    expect(row!.pollIntervalMs).toBe(5_000);
    expect(row!.grantExpiresAt.getTime()).toBe(FIXED_NOW.getTime() + 900_000);
  });

  it("is a PUBLIC client request: no secret, and the client id is the DEVICE one", async () => {
    const w = await world();
    await start(w);
    const form = w.idp.device[0]!;
    expect(form.get("client_id")).toBe(CLIENT_ID);
    // The whole reason the seam is separate. A secret on this request would be refused by
    // `clientAuthFields`; there being no field to put one in is the structural half.
    expect(form.has("client_secret")).toBe(false);
  });

  it("asks for openid + email as well as the mail scopes — without them there is no address", async () => {
    // RED FIRST: drop the explicit `scopes` from the route and the device module's default takes
    // over, which is the MAIL scopes alone. The ceremony then completes, the tokens are valid, and
    // `addressFromIdToken` returns null — a 502 that reads as a Microsoft problem and is a scope
    // list one line long. Asserted as a SET, not a prefix.
    const w = await world();
    await start(w);
    const scopes = new Set(w.idp.device[0]!.get("scope")!.split(" "));
    for (const s of MS_AUTHORIZE_SCOPES) expect(scopes.has(s), `scope ${s}`).toBe(true);
    expect(scopes.has("openid")).toBe(true);
    expect(scopes.has("email")).toBe(true);
    expect(scopes.has("offline_access")).toBe(true);
  });

  it("503s naming MS_DEVICE_CLIENT_ID when the door is dark, and asks Microsoft nothing", async () => {
    const w = await world({ arm: "none" });
    const res = await w.H(startReq(w.token));
    expect(res.status).toBe(503);
    const text = await res.text();
    // The sentence names the variable, because the person reading it is the one who can set it.
    expect(text).toContain("MS_DEVICE_CLIENT_ID");
    expect(w.idp.device).toHaveLength(0);
  });

  it("a BYO CONFIDENTIAL registration does NOT arm this door", async () => {
    // THE SEAM, END TO END. A confidential client id fails the device grant outright
    // (`unauthorized_client`, because the grant sends no secret), so borrowing it would take a
    // complete, working registration and turn it into a door that always fails — while the
    // availability read said it was ready. MUTATION: make the route fall back to `deps.msOAuth` and
    // this goes red on the status.
    const w = await world({ arm: "byo-only" });
    const res = await w.H(startReq(w.token));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("MS_DEVICE_CLIENT_ID");
    expect(w.idp.device).toHaveLength(0);
  });

  it("a junk tenant is refused by ITS OWN name, not by telling the operator to set the id", async () => {
    /*
     * FOUND BY REVIEW. Both gaps used to answer `device_client_missing`, so an operator who HAD set
     * the client id was told to set the client id — a remedy pointing at the one variable that is
     * already correct, which reads as "this feature is broken" rather than "fix your tenant".
     *
     * MUTATION: collapse `deviceGate` back to a single `deviceFlowAvailable` check and this goes red
     * on the sentence and on `gap`.
     */
    const w = await world();
    const res = await w.H(startReq(w.token), { msDevice: { clientId: CLIENT_ID, tenant: "../evil" } });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("MS_DEVICE_TENANT");
    expect(text).not.toContain("MS_DEVICE_CLIENT_ID");
    expect(w.idp.device).toHaveLength(0);
  });

  it("…and a MISSING id still names the id, so the two gaps stay distinguishable", async () => {
    const w = await world({ arm: "none" });
    const res = await w.H(startReq(w.token));
    const text = await res.text();
    expect(text).toContain("MS_DEVICE_CLIENT_ID");
    expect(text).not.toContain("MS_DEVICE_TENANT");
  });
});

describe("cloud 0027 — the availability read publishes BOTH doors", () => {
  it("device true only where a public client is configured", async () => {
    const armed = await world({ arm: "public" });
    const r1 = await armed.H(req("GET", "/mailboxes/oauth/microsoft/availability", { bearer: armed.token }));
    expect(await payload<{ available: boolean; device: boolean }>(r1)).toMatchObject({ device: true });

    const dark = await world({ arm: "none" });
    const r2 = await dark.H(req("GET", "/mailboxes/oauth/microsoft/availability", { bearer: dark.token }));
    const body = await payload<{ available: boolean; device: boolean }>(r2);
    expect(body.device).toBe(false);
    // The two doors are INDEPENDENT: a deployment with neither reports neither, and the redirect
    // flow's own answer is unaffected by this field existing.
    expect(body.available).toBe(false);
  });

  it("publishes NO part of the registration — not the client id, not the tenant", async () => {
    const w = await world({ arm: "public" });
    const res = await w.H(req("GET", "/mailboxes/oauth/microsoft/availability", { bearer: w.token }));
    const text = await res.text();
    expect(text).not.toContain(CLIENT_ID);
    expect(text).not.toContain("common");
  });
});

describe("cloud 0027 — the poll READS WITHOUT CONSUMING", () => {
  it("three pending polls leave the ceremony live, unconsumed, and pollable", async () => {
    /*
     * THE LOAD-BEARING TEST OF THE WHOLE FLOW, and the one a happy-path suite would not have. A
     * consuming read passes the FIRST poll and breaks every one after it — and the second poll is
     * where this feature lives, because the overwhelmingly common answer is `authorization_pending`
     * for as long as somebody takes to walk to a browser.
     *
     * MUTATION: swap `readDeviceCeremony` for `claimDeviceCeremony` in the poll handler and this
     * goes red on the second poll with `oauth_device_state_invalid`.
     */
    const w = await world();
    const { state } = await start(w);

    for (let i = 1; i <= 3; i++) {
      const { res, body } = await poll(w, state);
      expect(res.status, `poll ${i}`).toBe(200);
      expect(body.status, `poll ${i}`).toBe("pending");
      // The display values come back on every poll, so a page reload mid-ceremony can render the
      // code again rather than stranding a live grant nobody can finish.
      expect(body.userCode).toBe(USER_CODE);
      expect(body.verificationUri).toBe(VERIFICATION_URI);

      const [row] = await w.db.select().from(mailboxOauthDeviceCeremonies)
        .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
      expect(row!.consumedAt, `poll ${i} must not consume`).toBeNull();
      // …and the poll WAS recorded. `last_polled_at` moving is what the cadence fence turns on, so
      // a read that wrote nothing at all would be non-consuming and also unfenced.
      expect(row!.lastPolledAt).not.toBeNull();

      // Each poll needs the interval to have passed, or the fence (below) refuses it.
      w.clock.advance(5_000);
    }
    expect(w.idp.token).toHaveLength(3);
  });

  it("an EARLY poll is refused WITHOUT asking Microsoft, and says when to come back", async () => {
    // The protection of a client id shared with other people's installs. MUTATION: drop the
    // `last_polled_at <= now - poll_interval_ms` clause from the lease and `token` reaches 2.
    const w = await world();
    const { state } = await start(w);

    const first = await poll(w, state);
    expect(first.body.status).toBe("pending");
    expect(w.idp.token).toHaveLength(1);

    // Immediately again — no clock advance.
    const second = await poll(w, state);
    expect(second.res.status).toBe(200);
    expect(second.body.status).toBe("pending");
    expect(second.body.retryAfterMs).toBe(5_000);
    expect(w.idp.token, "the early poll never reached Microsoft").toHaveLength(1);

    // Past the interval, it is allowed again.
    w.clock.advance(5_000);
    await poll(w, state);
    expect(w.idp.token).toHaveLength(2);
  });

  it("slow_down widens the stored interval CUMULATIVELY, across requests", async () => {
    /*
     * RFC 8628 §3.5: the increase is by five seconds and is NOT reset on the next poll. Across a
     * stateless poll route that arithmetic has nowhere to live but the row, so this asserts the
     * COLUMN and not just the response — a value held only in a response is a value the next request
     * has forgotten.
     *
     * MUTATION: drop `noteDeviceCeremonySlowDown` and the interval stays at its first value for ever, so a client
     * Microsoft has asked to slow down keeps hammering a shared application.
     */
    const idp = fakeIdp({ token: () => ({ ok: false, status: 400, body: { error: "slow_down" } }) });
    const w = await world({ idp });
    const { state } = await start(w);

    const expected = [10_000, 15_000, 20_000];
    for (const want of expected) {
      const { body } = await poll(w, state);
      expect(body.status).toBe("pending");
      expect(body.retryAfterMs).toBe(want);
      const [row] = await w.db.select().from(mailboxOauthDeviceCeremonies)
        .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
      expect(row!.pollIntervalMs, "the widened interval is STORED").toBe(want);
      expect(row!.consumedAt, "slow_down is not a terminal verdict").toBeNull();
      // The fence now uses the WIDENED interval, which is the point — advancing by the old one is
      // no longer enough.
      w.clock.advance(want);
    }
  });

  it("the widened interval fences the next poll at the NEW width", async () => {
    const idp = fakeIdp({ token: (_f, call) => (call === 1
      ? { ok: false, status: 400, body: { error: "slow_down" } }
      : { ok: false, status: 400, body: { error: "authorization_pending" } }) });
    const w = await world({ idp });
    const { state } = await start(w);

    await poll(w, state);                       // slow_down → the interval grows by a step
    w.clock.advance(5_000);                     // the OLD interval, deliberately
    const early = await poll(w, state);
    expect(early.body.retryAfterMs).toBe(5_000);
    expect(w.idp.token, "5 s is no longer enough").toHaveLength(1);

    w.clock.advance(5_000);                     // now past the grown interval
    await poll(w, state);
    expect(w.idp.token).toHaveLength(2);
  });
});

describe("cloud 0027 — the three TERMINAL verdicts each claim the ceremony exactly once", () => {
  it("EXPIRY is judged on the stored deadline, costs no request, and claims", async () => {
    const w = await world();
    const { state } = await start(w);
    // Past Microsoft's own `expires_in`, which was stored absolute at mint time.
    w.clock.advance(900_001);

    const { res, body } = await poll(w, state);
    expect(res.status).toBe(200);
    expect(body.status).toBe("expired");
    expect(w.idp.token, "the deadline is a stored fact, not a question for Microsoft").toHaveLength(0);

    const [row] = await w.db.select().from(mailboxOauthDeviceCeremonies)
      .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
    // Claimed: an aged-out state is dead FOR GOOD rather than dead until a clock is nudged.
    expect(row!.consumedAt).not.toBeNull();

    // And a second poll of it is the unknown-ceremony answer, not a second "expired".
    const again = await poll(w, state);
    expect(again.res.status).toBe(400);
  });

  it("Microsoft's own expired_token claims too", async () => {
    const idp = fakeIdp({ token: () => ({ ok: false, status: 400, body: { error: "expired_token" } }) });
    const w = await world({ idp });
    const { state } = await start(w);
    const { body } = await poll(w, state);
    expect(body.status).toBe("expired");
    const [row] = await w.db.select().from(mailboxOauthDeviceCeremonies)
      .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
    expect(row!.consumedAt).not.toBeNull();
  });

  it("a DECLINED sign-in is a 200 and a claim — it is not an error", async () => {
    // Both spellings mean the same thing and both must land here: Microsoft says
    // `authorization_declined`, RFC 8628 says `access_denied`.
    for (const error of ["authorization_declined", "access_denied"]) {
      const idp = fakeIdp({ token: () => ({ ok: false, status: 400, body: { error } }) });
      const w = await world({ idp });
      const { state } = await start(w);
      const { res, body } = await poll(w, state);
      // 200, because nothing about the request failed: a person declined, which is an outcome.
      expect(res.status, error).toBe(200);
      expect(body.status, error).toBe("declined");
      const [row] = await w.db.select().from(mailboxOauthDeviceCeremonies)
        .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
      expect(row!.consumedAt, error).not.toBeNull();
    }
  });
});

describe("cloud 0027 — GRANTED stores the mailbox, with its DOOR recorded", () => {
  it("stores the address from the id_token, the sealed refresh token, and clientKind: public", async () => {
    const idp = fakeIdp({ token: () => granted() });
    const w = await world({ idp });
    const { state } = await start(w);

    const { res, body } = await poll(w, state);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(body.status).toBe("granted");
    expect(body.created).toBe(true);
    // THE ADDRESS COMES FROM MICROSOFT'S TOKEN. Nobody typed it, and nothing in the request carried
    // it — there is no address field anywhere in this ceremony.
    expect(body.mailbox!.address).toBe("device-user@contoso-com.example");

    const [box] = await w.db.select().from(mailboxes)
      .where(and(eq(mailboxes.accountId, w.accountId), eq(mailboxes.address, "device-user@contoso-com.example")));
    expect(box!.authKind).toBe("oauth");

    const [cred] = await w.db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, box!.id), eq(mailboxCredentials.transport, "imap")));
    const meta = cred!.meta as Record<string, unknown>;
    expect(meta.authType).toBe("oauth2");
    expect(meta.provider).toBe("microsoft");
    expect(meta.tenant).toBe("common");
    /*
     * THE LINE THAT KEEPS THIS MAILBOX ALIVE PAST ITS FIRST HOUR.
     *
     * A refresh token is only renewable by the client that obtained it, and this one came from the
     * PUBLIC registration. Without this field the organizer renews against the confidential client,
     * Microsoft refuses, and `refreshAccessToken` maps a rejected client to "provider unavailable"
     * deliberately — so nothing quarantines, nothing pages, and mail stops arriving about an hour
     * after somebody successfully connected the mailbox.
     *
     * MUTATION: drop `clientKind` from the route's `connectOAuth` call and this goes red. Nothing
     * else in this file would notice.
     */
    expect(meta.clientKind).toBe("public");
    // The credential is the REFRESH token, sealed — never the access token, which expires in an
    // hour and is only for the probe.
    expect(cred!.secretEnc).not.toContain("REFRESH-TOKEN-1");
    expect(await w.deps.keyProvider.decrypt(cred!.secretEnc, cred!.keyVersion)).toBe("REFRESH-TOKEN-1");
  });

  it("the token request is the DEVICE grant, on the public client, with no secret", async () => {
    const idp = fakeIdp({ token: () => granted() });
    const w = await world({ idp });
    const { state } = await start(w);
    await poll(w, state);
    const form = w.idp.token[0]!;
    expect(form.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(form.get("device_code")).toBe(DEVICE_CODE);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.has("client_secret")).toBe(false);
  });

  it("a REPLAYED poll after a grant cannot store a second mailbox", async () => {
    // The single-use claim. MUTATION: make `claimDeviceCeremony` a plain read and the second poll
    // stores the mailbox again — which on a reconnect path is a second consent applied to a row
    // nobody asked to change.
    const idp = fakeIdp({ token: () => granted() });
    const w = await world({ idp });
    const { state } = await start(w);

    const first = await poll(w, state);
    expect(first.res.status).toBe(201);

    w.clock.advance(5_000);
    const second = await poll(w, state);
    expect(second.res.status).toBe(400);
    expect(await second.res.text()).toContain("no longer in progress");
  });

  it("no refresh token is a NAMED configuration fault, not a mailbox that dies at teatime", async () => {
    const idp = fakeIdp({ token: () => ({
      ok: true, status: 200,
      body: {
        access_token: "AT", expires_in: 3600,
        id_token: idToken({ preferred_username: "device-user@contoso-com.example" }),
      },
    }) });
    const w = await world({ idp });
    const { state } = await start(w);
    const { res } = await poll(w, state);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("offline_access");
    // NOTHING was stored.
    const rows = await w.db.select().from(mailboxes).where(eq(mailboxes.accountId, w.accountId));
    expect(rows).toHaveLength(0);
  });

  it("no address in the id_token stores nothing and says so", async () => {
    const idp = fakeIdp({ token: () => ({
      ok: true, status: 200,
      body: { access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: idToken({ sub: "no-name" }) },
    }) });
    const w = await world({ idp });
    const { state } = await start(w);
    const { res } = await poll(w, state);
    expect(res.status).toBe(502);
    const rows = await w.db.select().from(mailboxes).where(eq(mailboxes.accountId, w.accountId));
    expect(rows).toHaveLength(0);
  });
});

describe("device sign-in expires even when completion is in flight", () => {
  const expire = (w: World, expiresAt: string) => w.clock.advance(Date.parse(expiresAt) - w.clock.now().getTime());

  it("refuses approval that returns at the deadline without probing the mailbox", async () => {
    let reachDeadline: () => void;
    const w = await world({ idp: fakeIdp({ token: () => {
      reachDeadline();
      return granted();
    } }) });
    const { state, expiresAt } = await start(w);
    reachDeadline = () => expire(w, expiresAt);

    const { res, body } = await poll(w, state);
    expect(w.idp.token.length).toBe(1);
    expect(body.status).toBe("expired");
    expect(res.status).toBe(200);
    expect(vi.mocked(ImapAdapter.prototype.connect).mock.calls.length).toBe(0);
    expect((await poll(w, state)).res.status).toBe(400);
  });

  it.each([
    { change: "create", window: "probe" },
    { change: "reconnect", window: "probe" },
    { change: "create", window: "write" },
    { change: "reconnect", window: "write" },
  ])("rolls back $change when the deadline passes during the mailbox $window", async ({ change, window }) => {
    const w = await world({ idp: fakeIdp({ token: () => granted() }) });
    const existingMailbox = change === "reconnect";
    if (existingMailbox) {
      const first = await start(w);
      expect((await poll(w, first.state)).res.status).toBe(201);
    }
    const credentials = () => w.db.select({ sealed: mailboxCredentials.secretEnc })
      .from(mailboxCredentials).where(eq(mailboxCredentials.accountId, w.accountId));
    const before = await credentials();
    const { state, expiresAt } = await start(w);
    const probe = vi.mocked(ImapAdapter.prototype.connect);
    probe.mockClear();
    const encrypt = w.deps.keyProvider.encrypt.bind(w.deps.keyProvider);
    const seal = vi.spyOn(w.deps.keyProvider, "encrypt");
    if (window === "probe") {
      probe.mockImplementation(async () => { expire(w, expiresAt); });
    } else {
      seal.mockImplementation(async (value) => {
        const sealed = await encrypt(value);
        expire(w, expiresAt);
        return sealed;
      });
    }

    const { res, body } = await poll(w, state);
    expect(probe.mock.calls.length).toBe(1);
    expect(w.clock.now().getTime()).toBe(Date.parse(expiresAt));
    expect(body.status).toBe("expired");
    expect(res.status).toBe(200);
    expect(seal.mock.calls.length).toBe(window === "probe" ? 0 : 1);
    const boxes = await w.db.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.accountId, w.accountId));
    expect(boxes).toHaveLength(existingMailbox ? 1 : 0);
    const after = await credentials();
    expect(after).toHaveLength(before.length);
    expect(after[0]?.sealed === before[0]?.sealed).toBe(true);
    expect((await poll(w, state)).res.status).toBe(400);
  });
});

describe("device sign-in belongs to the session that started it", () => {
  const signOut = (w: World, allDevices = false) =>
    w.H(req("POST", "/auth/logout", { bearer: w.token, body: JSON.stringify({ allDevices }) }));

  const grantRemains = async (w: World, state: string): Promise<boolean> => {
    const rows = await w.db.select({ pending: mailboxOauthDeviceCeremonies.consumedAt })
      .from(mailboxOauthDeviceCeremonies).where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
    return rows.some((row) => row.pending === null);
  };

  it("refuses another session of the same account and leaves the original grant usable", async () => {
    const w = await world({ idp: fakeIdp({ token: () => granted() }) });
    const { state } = await start(w);
    const other = await seedSessionFor(w.db, { accountId: w.accountId, userId: w.userId, now: FIXED_NOW });

    const refused = await w.H(pollReq(other.token, state));
    expect(refused.status).toBe(400);
    expect(w.idp.token.length).toBe(0);
    expect((await poll(w, state)).res.status).toBe(201);
  });

  it("refuses a grant after the session that started it signs out", async () => {
    const w = await world({ idp: fakeIdp({ token: () => granted() }) });
    const { state } = await start(w);
    const other = await seedSessionFor(w.db, { accountId: w.accountId, userId: w.userId, now: FIXED_NOW });
    const survivor = { ...w, ...other };
    const { state: otherState } = await start(survivor);

    expect((await signOut(w)).status).toBe(204);
    expect(await grantRemains(w, state)).toBe(false);

    expect((await w.H(pollReq(w.token, state))).status).toBe(401);
    const refused = await w.H(pollReq(other.token, state));
    expect(refused.status).toBe(400);
    expect(w.idp.token.length).toBe(0);
    expect((await poll(survivor, otherState)).res.status).toBe(201);
  });

  it("invalidates outstanding grants from every session signed out together", async () => {
    const w = await world();
    await w.db.update(sessions).set({ lastTwofaAt: FIXED_NOW }).where(eq(sessions.id, w.sessionId));
    const other = await seedSessionFor(w.db, { accountId: w.accountId, userId: w.userId, now: FIXED_NOW });
    const { state } = await start(w);
    const otherWorld = { ...w, ...other };
    const { state: otherState } = await start(otherWorld);

    expect((await signOut(w, true)).status).toBe(204);
    expect(await grantRemains(w, state)).toBe(false);
    expect(await grantRemains(otherWorld, otherState)).toBe(false);
  });

  it.each(["browser", "bearer"])("invalidates outstanding grants at %s refresh sign-out", async (carrier) => {
    const w = await world();
    const { state } = await start(w);
    const [session] = await w.db.select({ familyId: sessions.familyId }).from(sessions)
      .where(eq(sessions.id, w.sessionId));
    const family = session!.familyId;
    const refresh = generateToken();
    await w.db.insert(refreshTokens).values({
      accountId: w.accountId, userId: w.userId, sessionId: w.sessionId, familyId: family,
      tokenHash: hashToken(refresh), expiresAt: new Date(FIXED_NOW.getTime() + 60_000), createdAt: FIXED_NOW,
    });
    const csrf = csrfTokenFor(w.token);
    const cookies = `tf_session=${w.token}; tf_refresh=${refresh}; tf_csrf=${csrf}; tf_family=${family}`;
    const headers = { "X-CSRF-Token": csrf, "X-Ohmail-Expected-Family": family };
    const path = "/auth/refresh/logout";
    const request = carrier === "browser" ? { cookie: cookies, headers } : { body: JSON.stringify({ refreshToken: refresh }) };

    expect((await w.H(req("POST", path, request))).status).toBe(204);
    expect(await grantRemains(w, state)).toBe(false);
    if (carrier === "browser") {
      const cleared = await w.H(req("POST", path, {
        cookie: `${cookies}; tf_owner=signed_out_pending`,
        headers: { ...headers, "X-Ohmail-Clear-Logout": "1" },
      }));
      expect(cleared.status).toBe(204);
    }
  });

  it("stores no mailbox when the starting session signs out during the mailbox probe", async () => {
    const w = await world({ idp: fakeIdp({ token: () => granted() }) });
    const { state } = await start(w);
    let signOutStatus: number | undefined;
    vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async () => {
      signOutStatus = (await signOut(w)).status;
    });

    const { res } = await poll(w, state);
    expect(signOutStatus).toBe(204);
    expect(res.status).toBe(401);
    const rows = await w.db.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.accountId, w.accountId));
    expect(rows).toHaveLength(0);
  });

  it("refuses an older grant stored without a session binding", async () => {
    const w = await world({ idp: fakeIdp({ token: () => granted() }) });
    const { state } = await start(w);
    const sealed = await w.deps.keyProvider.encrypt(DEVICE_CODE);
    await w.db.update(mailboxOauthDeviceCeremonies)
      .set({ deviceCodeEnc: sealed.ciphertext, deviceCodeKeyVersion: sealed.keyVersion })
      .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));

    expect((await poll(w, state)).res.status).toBe(400);
    expect(w.idp.token.length).toBe(0);
  });

  it("requires a fresh sign-in for grants stored before the lookup was scoped", async () => {
    const w = await world({ idp: fakeIdp({ token: () => granted() }) });
    const { state } = await start(w);
    await w.db.update(mailboxOauthDeviceCeremonies).set({ state })
      .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));

    const refused = await poll(w, state);
    expect(refused.res.status).toBe(400);
    expect(w.idp.token.length).toBe(0);
  });
});

describe("cloud 0027 — a cross-account poll is refused AND the ceremony survives it", () => {
  it("returns the missing-grant response and leaves the first account's grant untouched", async () => {
    const w = await world({ idp: fakeIdp({ token: () => granted() }) });
    const { state } = await start(w);
    const other = await seedSession(w.db, { now: FIXED_NOW });

    const missing = await w.H(pollReq(other.token, "never-issued-state-".padEnd(43, "x")));
    const refused = await w.H(pollReq(other.token, state));
    expect(missing.status).toBe(400);
    expect(refused.status).toBe(missing.status);
    expect(await refused.text()).toBe(await missing.text());
    expect(w.idp.token.length).toBe(0);

    const [row] = await w.db.select({
      consumedAt: mailboxOauthDeviceCeremonies.consumedAt,
      lastPolledAt: mailboxOauthDeviceCeremonies.lastPolledAt,
      pollIntervalMs: mailboxOauthDeviceCeremonies.pollIntervalMs,
    }).from(mailboxOauthDeviceCeremonies)
      .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
    expect(row).toEqual({ consumedAt: null, lastPolledAt: null, pollIntervalMs: 5_000 });
    expect((await poll(w, state)).res.status).toBe(201);
  });

  it("an unknown state and a spent state are the SAME answer", async () => {
    // Distinguishing them would be an oracle for whether a given 256-bit value was ever issued.
    const w = await world();
    const never = await w.H(pollReq(w.token, "never-issued-state-".padEnd(43, "x")));
    expect(never.status).toBe(400);

    const { state } = await start(w);
    w.clock.advance(900_001);
    await poll(w, state);                                  // expiry claims it
    const spent = await poll(w, state);
    expect(spent.res.status).toBe(400);
    expect(await spent.res.text()).toContain("no longer in progress");
  });

  it("a malformed state is refused before it becomes a database predicate", async () => {
    const w = await world();
    for (const bad of ["", "has spaces", "x".repeat(600), "semi;colon"]) {
      const res = await w.H(pollReq(w.token, bad));
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("cloud 0027 — a failed poll is not a failed ceremony", () => {
  it("a 5xx from Microsoft leaves the ceremony live and pollable", async () => {
    // MUTATION: claim on the throw path and one flaky proxy hop costs somebody their ceremony.
    let fail = true;
    const idp = fakeIdp({ token: () => (fail
      ? { ok: false, status: 503, body: { error: "server_error" } }
      : granted()) });
    const w = await world({ idp });
    const { state } = await start(w);

    const bad = await poll(w, state);
    expect(bad.res.status).toBe(503);
    const [row] = await w.db.select().from(mailboxOauthDeviceCeremonies)
      .where(eq(mailboxOauthDeviceCeremonies.state, storedState(w, state)));
    expect(row!.consumedAt, "we could not ask is never a verdict about the ceremony").toBeNull();

    fail = false;
    w.clock.advance(5_000);
    const good = await poll(w, state);
    expect(good.res.status).toBe(201);
  });
});

describe("cloud 0027 — where these routes are mounted, and at what cost", () => {
  it("both are cost work — the gated class, asserted here because the hosted census cannot see them", () => {
    /*
     * The frozen route census runs over the HOSTED table. These two are mounted only by the
     * self-host composition, so nothing there would notice them landing in an exempt class — and an
     * exempt class here would be an account with an unproven address able to make this process POST
     * to Microsoft, store a credential, and start a full sync of a mailbox.
     */
    const device = selfHostRoutes.filter((r) => r.pattern.startsWith("/mailboxes/oauth/microsoft/device"));
    expect(device).toHaveLength(2);
    expect(device.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual([
      "POST /mailboxes/oauth/microsoft/device/poll",
      "POST /mailboxes/oauth/microsoft/device/start",
    ]);
    for (const r of device) expect(r.cost, r.pattern).toBe("work");
    // No `raw`, no `public`: both run the full pipeline, session and CSRF included.
    for (const r of device) {
      expect(r.options?.public ?? false, r.pattern).toBe(false);
      expect(r.options?.raw ?? false, r.pattern).toBe(false);
    }
  });

  it("the HOSTED table carries neither, so its artifact never holds the handlers", () => {
    // A deliberate absence, and the reason it is asserted: `selfHostRoutes` is a distinct import
    // list precisely so the hosted build does not pull modules it cannot route to. A future "tidy
    // the two tables together" would put both device handlers into the managed deployment, where
    // there is no public client and no environment variable to arm one.
    expect(apiRoutes.filter((r) => r.pattern.includes("/device/"))).toHaveLength(0);
  });
});


it("a poll that finishes after sign-out cannot return pending display values", async () => {
  const idp = fakeIdp();
  let sessionEnded: (() => Promise<void>) | undefined;
  const w = await world({ idp: {
    ...idp,
    fetch: async (url, init) => {
      const reply = await idp.fetch(url, init);
      if (url.endsWith("/token")) await sessionEnded?.();
      return reply;
    },
  } });
  const started = await start(w);
  sessionEnded = async () => {
    await w.db.update(sessions).set({ revokedAt: FIXED_NOW }).where(eq(sessions.id, w.sessionId));
  };
  const res = await w.H(pollReq(w.token, started.state));
  expect(res.status).toBe(401);
  const body = await payload<PollPayload>(res);
  expect(body.userCode === undefined && body.verificationUri === undefined).toBe(true);
});
