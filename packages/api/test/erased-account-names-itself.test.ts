import { describe, it, expect } from "vitest";
import {
  createApp, apiRoutes, csrfTokenFor, ACCOUNT_HEADER, ERASED_ANSWER_HEADER, type ApiDeps,
} from "@trafficflow/api";
import { totpNow, type Db } from "@trafficflow/services";
import { makeDeps, req, seedSessionFor, seedMailbox, setCookieMap, type TestClock } from "./helpers.js";

/**
 * AN ERASED ACCOUNT'S 410 NAMES THE ACCOUNT, AND A BROWSER CAN HEAR IT AT THE REFRESH DOOR.
 *
 * Measured at the base: browser 2 of an account erased in browser 1 heard `410 account_erased` on
 * a declared read only inside the fifteen-minute access window; its cookie refresh answered 401
 * `refresh_revoked` even declared, so past the window no browser could ever be told. And no 410
 * named an account, so a client could not tell whose copy to wipe. Watched red: the cookie
 * branch's erased arm cut; `deps.erasedAccount` never assigned; `nameTheAccount` not reading it.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const PW = "pw-correct-horse";
const DECLARED = { [ERASED_ANSWER_HEADER]: "account_erased" };
/** The five names a refused refresh expires, in both spellings. */
const FIVE = ["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"].flatMap((n) => [`__Host-${n}`, n]).sort();

/** A real browser session: register, enrol TOTP, sign in — the jar the web client holds. */
async function browser(deps: ApiDeps, db: Db, clock: TestClock, email: string) {
  const reg = await H(req("POST", "/auth/register", {
    body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }),
  }), deps);
  expect(reg.status).toBe(201);
  const { user } = await reg.json() as { user: { accountId: string; userId: string } };
  const seeded = await seedSessionFor(db, { accountId: user.accountId, userId: user.userId, now: clock.now(), lastTwofaAt: clock.now() });
  const cookie = `tf_session=${seeded.token}; tf_csrf=${csrfTokenFor(seeded.token)}`;
  const headers = { "x-csrf-token": csrfTokenFor(seeded.token) };
  const { secret } = await (await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps)).json() as { secret: string };
  await H(req("POST", "/auth/2fa/totp/activate", { cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }), deps);
  clock.advance(30_000);
  const { loginToken } = await (await H(req("POST", "/auth/login", { body: JSON.stringify({ email, password: PW }) }), deps)).json() as { loginToken: string };
  const verify = await H(req("POST", "/auth/2fa/totp/verify", {
    body: JSON.stringify({ loginToken, code: totpNow(secret, clock.now()) }),
  }), deps);
  expect(verify.status).toBe(200);
  const jar = setCookieMap(verify);
  return {
    accountId: user.accountId, userId: user.userId, minter: seeded.token,
    all: `tf_session=${jar.tf_session}; tf_csrf=${jar.tf_csrf}; tf_refresh=${jar.tf_refresh}; tf_owner=${jar.tf_owner}`,
    refreshOnly: `tf_refresh=${jar.tf_refresh}; tf_csrf=${jar.tf_csrf}`,
    csrf: { "x-csrf-token": jar.tf_csrf! },
  };
}

async function nativePair(deps: ApiDeps, minter: string) {
  const minted = await (await H(req("POST", "/pair", {
    bearer: minter, body: JSON.stringify({ grant: "device-pair", label: "Phone" }),
  }), deps)).json() as { token: string };
  const redeemed = await H(req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token: minted.token }) }), deps);
  expect(redeemed.status).toBe(200);
  return ((await redeemed.json()) as { tokens: { accessToken: string; refreshToken: string } }).tokens;
}

async function codeOf(res: Response): Promise<string | null> {
  try { return ((await res.clone().json()) as { error?: { code?: string } }).error?.code ?? null; } catch { return null; }
}

/** The names a `Set-Cookie` list EXPIRES, sorted. */
function cleared(res: Response): string[] {
  return res.headers.getSetCookie()
    .filter((c) => /max-age=0/i.test(c))
    .map((c) => c.split("=")[0]!.trim()).sort();
}

/** Browser 2 and a paired phone, then the account erased from browser 1. */
async function erasedElsewhere() {
  const { db, deps, clock } = await makeDeps();
  const b2 = await browser(deps, db, clock, "erased-elsewhere@x.test");
  await seedMailbox(db, { accountId: b2.accountId });
  const phone = await nativePair(deps, b2.minter);
  const b1 = await seedSessionFor(db, { accountId: b2.accountId, userId: b2.userId, now: clock.now(), lastTwofaAt: clock.now() });
  const erased = await H(req("DELETE", "/account", { bearer: b1.token }), deps);
  expect(erased.status, await erased.clone().text()).toBe(200);
  return { db, deps, clock, b2, phone };
}

describe("the 410 names the erased account", () => {
  it("on a declared read, on the native refresh, and on the browser's cookie refresh", async () => {
    const { deps, b2, phone } = await erasedElsewhere();
    const read = await H(req("GET", "/sync?limit=50", { bearer: phone.accessToken, headers: DECLARED }), deps);
    expect(`${read.status} ${await codeOf(read)} ${read.headers.get(ACCOUNT_HEADER)}`).toBe(`410 account_erased ${b2.accountId}`);
    const native = await H(req("POST", "/auth/refresh", {
      headers: DECLARED, body: JSON.stringify({ refreshToken: phone.refreshToken }),
    }), deps);
    expect(`${native.status} ${await codeOf(native)} ${native.headers.get(ACCOUNT_HEADER)}`).toBe(`410 account_erased ${b2.accountId}`);
    const cookieRead = await H(req("GET", "/sync?limit=50", { cookie: b2.all, headers: DECLARED }), deps);
    expect(`${cookieRead.status} ${cookieRead.headers.get(ACCOUNT_HEADER)}`).toBe(`410 ${b2.accountId}`);
  });

  it("past the access window the browser hears it at its refresh door, and the jar is cleared", async () => {
    const { deps, clock, b2 } = await erasedElsewhere();
    clock.advance(16 * 60_000);
    const read = await H(req("GET", "/sync?limit=50", { cookie: b2.all, headers: DECLARED }), deps);
    expect(`${read.status} ${await codeOf(read)}`, "the read no longer carries the verdict").toBe("401 unauthorized");
    const refresh = await H(req("POST", "/auth/refresh", { cookie: b2.refreshOnly, headers: { ...b2.csrf, ...DECLARED } }), deps);
    expect(`${refresh.status} ${await codeOf(refresh)} ${refresh.headers.get(ACCOUNT_HEADER)}`)
      .toBe(`410 account_erased ${b2.accountId}`);
    expect(cleared(refresh), "a refused refresh clears the jar, erased or not").toEqual(FIVE);
    for (const c of refresh.headers.getSetCookie()) expect(c, "the host-only cookie widened").not.toMatch(/domain=/i);
  });
});

describe("what does not change", () => {
  it("an UNDECLARED cookie refresh keeps its 401 refresh_revoked, no account named", async () => {
    const { deps, b2 } = await erasedElsewhere();
    const refresh = await H(req("POST", "/auth/refresh", { cookie: b2.refreshOnly, headers: b2.csrf }), deps);
    expect(`${refresh.status} ${await codeOf(refresh)} ${refresh.headers.get(ACCOUNT_HEADER)}`).toBe("401 refresh_revoked null");
    expect(cleared(refresh)).toEqual(FIVE);
  });

  it("a LIVE account: a declared cookie refresh mints, declared reads name the account as always", async () => {
    const { db, deps, clock } = await makeDeps();
    const b = await browser(deps, db, clock, "live@x.test");
    const read = await H(req("GET", "/sync?limit=50", { cookie: b.all, headers: DECLARED }), deps);
    expect(`${read.status} ${read.headers.get(ACCOUNT_HEADER)}`).toBe(`200 ${b.accountId}`);
    const refresh = await H(req("POST", "/auth/refresh", { cookie: b.refreshOnly, headers: { ...b.csrf, ...DECLARED } }), deps);
    expect(refresh.status, await refresh.clone().text()).toBe(204);
  });

  it("a declared garbage bearer and a declared revoked-but-live account's refresh are 401s naming nobody", async () => {
    const { db, deps, clock } = await makeDeps();
    const garbage = await H(req("GET", "/sync?limit=50", { bearer: "not-a-token", headers: DECLARED }), deps);
    expect(`${garbage.status} ${await codeOf(garbage)} ${garbage.headers.get(ACCOUNT_HEADER)}`).toBe("401 unauthorized null");
    const b = await browser(deps, db, clock, "signed-out@x.test");
    const out = await H(req("POST", "/auth/logout", { cookie: b.all, headers: b.csrf }), deps);
    expect(out.status).toBeLessThan(300);
    const refresh = await H(req("POST", "/auth/refresh", { cookie: b.refreshOnly, headers: { ...b.csrf, ...DECLARED } }), deps);
    expect(`${refresh.status} ${await codeOf(refresh)} ${refresh.headers.get(ACCOUNT_HEADER)}`).toBe("401 refresh_revoked null");
  });
});
