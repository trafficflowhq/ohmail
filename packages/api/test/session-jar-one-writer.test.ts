import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createApp, apiRoutes, csrfTokenFor, dbBusyResponse, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { DbAcquireTimeoutError } from "@trafficflow/db/cloud";
import { refreshTokens } from "@trafficflow/db";
import { generateToken, hashToken, totpNow, type Db } from "@trafficflow/services";
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { makeDeps, seedSession, seedSessionFor, seedStaffSession, req, setCookieMap, FIXED_NOW, type TestClock } from "./helpers.js";

/**
 * THE SESSION JAR HAS ONE WRITER. A sign-in on the cookie surface supersedes the session the jar
 * held before it, inside the mint (`webSession` → `SessionLifecycle.establish`), so a late refresh
 * of that session is refused instead of signing the browser back in to the previous account. The
 * race itself runs on real Postgres (`packages/services/test/session-supersede-race.pg.test.ts`);
 * this file drives the production route table.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const PW = "pw-correct-horse-password";
const ACCESS_LAPSED_MS = 16 * 60_000;

async function codeOf(res: Response): Promise<string | null> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    return null;
  }
}

/** Register over HTTP, enrol TOTP on a seeded full session, and return the shared secret. */
async function person(deps: ApiDeps, db: Db, clock: TestClock, email: string): Promise<string> {
  const reg = await H(req("POST", "/auth/register", {
    body: JSON.stringify({ email, password: PW, displayName: "S", inviteCode: "INVITE-OK" }),
  }), deps);
  expect(reg.status, await reg.clone().text()).toBe(201);
  const { user } = await reg.json() as { user: { userId: string; accountId: string } };
  const { token } = await seedSessionFor(db, { ...user, now: clock.now(), lastTwofaAt: clock.now() });
  const cookie = `tf_session=${token}; tf_csrf=${csrfTokenFor(token)}`;
  const headers = { "x-csrf-token": csrfTokenFor(token) };
  const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps);
  const { secret } = await enroll.json() as { secret: string };
  const act = await H(req("POST", "/auth/2fa/totp/activate", {
    cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }),
  }), deps);
  expect(act.status).toBe(200);
  return secret;
}

/** Password then TOTP, the browser's two presses; `cookie` is whatever the jar sends with them. */
async function signIn(deps: ApiDeps, clock: TestClock, email: string, secret: string, cookie?: string): Promise<Response> {
  clock.advance(30_000);   // one TOTP step per verify: the step before this one is spent
  const login = await H(req("POST", "/auth/login", { cookie, body: JSON.stringify({ email, password: PW }) }), deps);
  expect(login.status, await login.clone().text()).toBe(200);
  const { loginToken } = await login.json() as { loginToken: string };
  return H(req("POST", "/auth/2fa/totp/verify", {
    cookie, body: JSON.stringify({ loginToken, code: totpNow(secret, clock.now()) }),
  }), deps);
}

describe("a sign-in supersedes the session its jar held", () => {
  it("B signs in beside A's lapsed cookie: A's late refresh is refused, never re-mints A", async () => {
    const { db, deps, clock } = await makeDeps();
    const aSecret = await person(deps, db, clock, "jar-a@x.example");
    const bSecret = await person(deps, db, clock, "jar-b@x.example");
    const jar = setCookieMap(await signIn(deps, clock, "jar-a@x.example", aSecret));
    expect(jar.tf_session && jar.tf_refresh, "positive control: A's jar was minted").toBeTruthy();
    clock.advance(ACCESS_LAPSED_MS);

    const b = await signIn(deps, clock, "jar-b@x.example", bSecret, `tf_session=${jar.tf_session}`);
    expect(b.status, await b.clone().text()).toBe(200);
    expect(setCookieMap(b).tf_session, "B's own session was not minted").toBeTruthy();

    const late = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${jar.tf_refresh}` }), deps);
    expect(`${late.status} ${await codeOf(late)}`, "the jar's previous session renewed after B signed in")
      .toBe("401 refresh_revoked");
  });

  it("only the JAR's session: the same account in another browser keeps renewing", async () => {
    const { db, deps, clock } = await makeDeps();
    const aSecret = await person(deps, db, clock, "jar2-a@x.example");
    const bSecret = await person(deps, db, clock, "jar2-b@x.example");
    const jar = setCookieMap(await signIn(deps, clock, "jar2-a@x.example", aSecret));
    const other = setCookieMap(await signIn(deps, clock, "jar2-a@x.example", aSecret));
    clock.advance(ACCESS_LAPSED_MS);
    expect((await signIn(deps, clock, "jar2-b@x.example", bSecret, `tf_session=${jar.tf_session}`)).status).toBe(200);
    const renew = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${other.tf_refresh}` }), deps);
    expect(renew.status, "a session this jar never held was revoked").toBe(204);
  });

  it("a BEARER-ONLY host reads no cookie and revokes nothing, whatever the request carries", async () => {
    const { db, deps: cookieDeps, clock } = await makeDeps();
    const deps = { ...cookieDeps, allowCookieAuth: false };
    const aSecret = await person(cookieDeps, db, clock, "jar3-a@x.example");
    const bSecret = await person(cookieDeps, db, clock, "jar3-b@x.example");
    const a = await signIn(deps, clock, "jar3-a@x.example", aSecret);
    const aTokens = (await a.json() as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    clock.advance(ACCESS_LAPSED_MS);
    const b = await signIn(deps, clock, "jar3-b@x.example", bSecret, `tf_session=${aTokens.accessToken}`);
    expect(b.status).toBe(200);
    expect(b.headers.getSetCookie(), "a bearer-only host set a cookie").toEqual([]);
    const renew = await H(req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: aTokens.refreshToken }) }), deps);
    expect(renew.status, "a cookie on a bearer-only host revoked a session").toBe(200);
  });
});

/** A live refresh row for a seeded session — the jar's `tf_refresh`. */
async function seedRefresh(db: Db, s: { accountId: string; userId: string; sessionId: string }): Promise<string> {
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: randomUUID(),
    tokenHash: hashToken(refresh), expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
  });
  return refresh;
}

describe("the resume marker goes with an answer that finds nothing to rotate", () => {
  it("a jar holding tf_resume and no tf_refresh hears refresh_missing AND loses the marker", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("POST", "/auth/refresh", { cookie: "tf_resume=1", body: "{}" }), deps);
    expect(`${res.status} ${await codeOf(res)}`).toBe("401 refresh_missing");
    expect(res.headers.getSetCookie(), "the marker outlived the answer, so every visit loops through the splash")
      .toEqual(["tf_resume=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0"]);
  });

  it("control: no marker, or a bearer-only host, sets no cookie at all", async () => {
    const { deps } = await makeDeps();
    const bare = await H(req("POST", "/auth/refresh", { body: "{}" }), deps);
    expect(`${bare.status} ${await codeOf(bare)}`).toBe("401 refresh_missing");
    expect(bare.headers.getSetCookie()).toEqual([]);
    const bearer = await H(req("POST", "/auth/refresh", { cookie: "tf_resume=1", body: "{}" }), { ...deps, allowCookieAuth: false });
    expect(bearer.status).toBe(401);
    expect(bearer.headers.getSetCookie()).toEqual([]);
  });
});

describe("a busy refresh door says a replay is safe", () => {
  const busyHandle = (): never => new Proxy({}, { get() { throw new DbAcquireTimeoutError(5_000); } }) as never;

  it("both branches answer 503 db_busy with retryable: true", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    for (const r of [
      req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }),
      req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: refresh, attemptId: randomUUID() }) }),
    ]) {
      const res = await H(r, { ...deps, sessionDb: busyHandle });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string; retryable?: boolean } }).error)
        .toMatchObject({ code: "db_busy", retryable: true });
    }
  });

  it("the statement is the refresh door's and the send's alone, and absent it a public write stays not-retryable", () => {
    // The send's reservation deduplicates every replay of its key, so a busy pool may invite one.
    expect(apiRoutes.filter((r) => r.options?.replaySafe).map((r) => `${r.method} ${r.pattern}`).sort())
      .toEqual(["POST /auth/refresh", "POST /drafts/:id/send"]);
    const post = req("POST", "/auth/login", { body: "{}" });
    const body = async (r: Response) => ((await r.json()) as { error: { retryable?: boolean } }).error.retryable;
    return Promise.all([
      expect(body(dbBusyResponse(post, {}))).resolves.toBe(false),
      expect(body(dbBusyResponse(post, { routeIsReplaySafe: true }))).resolves.toBe(true),
    ]);
  });
});

describe("a staff credential is refused at the attachment bytes door", () => {
  it("the admin secret plus a live staff session answers 401 on GET /attachments/:id", async () => {
    const { db, deps } = await makeDeps();
    const secret = "admin-secret-for-tests-abcdefghij-fixture-token";
    const staff = await seedStaffSession(db, { now: FIXED_NOW });
    const d = { ...deps, admin: { secret, environment: "test" } as AdminConfig };
    const id = randomUUID();
    const asStaff = await H(req("GET", `/attachments/${id}`, {
      bearer: secret, headers: { [STAFF_SESSION_HEADER]: staff.token },
    }), d);
    expect(asStaff.status, "a staff credential reached an account's attachment").toBe(401);
    const customer = await seedSession(db, { now: FIXED_NOW });
    const own = await H(req("GET", `/attachments/${id}`, { bearer: customer.token }), d);
    expect(own.status, "positive control: the door is reached by the account's own session").not.toBe(401);
  });
});

describe("every server reader takes both cookie spellings, and the server still writes the bare names", () => {
  it("__Host-tf_session authenticates, and wins over a bare tf_session naming somebody else", async () => {
    const { db, deps } = await makeDeps();
    const mine = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/auth/session", { cookie: `tf_session=${other.token}; __Host-tf_session=${mine.token}` }), deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { accountId: string } }).user.accountId).toBe(mine.accountId);
  });

  it("a __Host- jar passes the double-submit check on a cookie-authenticated write", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const cookie = `__Host-tf_session=${s.token}; __Host-tf_csrf=${csrfTokenFor(s.token)}`;
    const res = await H(req("POST", "/auth/logout", { cookie, headers: { "x-csrf-token": csrfTokenFor(s.token) }, body: "{}" }), deps);
    expect(res.status, await res.clone().text()).toBe(204);
  });

  it("__Host-tf_refresh rotates at the refresh door, and the answer writes the bare names", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const res = await H(req("POST", "/auth/refresh", { cookie: `__Host-tf_refresh=${refresh}`, body: "{}" }), deps);
    expect(res.status, await res.clone().text()).toBe(204);
    const names = Object.keys(setCookieMap(res)).sort();
    expect(names).toEqual(["tf_csrf", "tf_refresh", "tf_resume", "tf_session"]);
    expect(res.headers.getSetCookie().some((c) => /domain=/i.test(c)), "a cookie grew a Domain=").toBe(false);
  });
});

/* ── THE CENSUS: the refresh credential has one reader ─────────────────────────────────────── */

const REPO = join(import.meta.dirname, "..", "..", "..");
const SERVER_ROOTS = ["packages/api/src", "packages/services/src", "apps/api-vercel/src"];
/** The NAME in code, any spelling a reader could use; its one type declaration is not a read. */
const REFRESH_NAME = /["'`](?:__Host-)?tf_refresh["'`]|\.tf_refresh\b|__Host-tf_refresh/g;
const NAME_DECLARATION = /export type CredentialCookie\b/;

function serverSources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return serverSources(p);
    return /\.tsx?$/.test(n) ? [{ path: relative(REPO, p), text: readFileSync(p, "utf8") }] : [];
  });
}

function refreshReaders(files: Array<{ path: string; text: string }>): string[] {
  return files.flatMap((f) => {
    const text = scan.withoutComments(f.text);
    const lines = text.split("\n");
    return [...text.matchAll(REFRESH_NAME)]
      .filter((m) => !NAME_DECLARATION.test(lines[scan.lineOf(text, m.index!) - 1]!))
      .map(() => f.path);
  });
}

describe("census — the refresh credential is read in exactly one route", () => {
  const files = SERVER_ROOTS.flatMap((r) => serverSources(join(REPO, r)));

  it("one read, at the refresh door, in either spelling", () => {
    expect(files.length, "the census read no files").toBeGreaterThan(50);
    expect(refreshReaders(files)).toEqual(["packages/api/src/routes/session-lifecycle.ts"]);
  });

  it("…and a second reader anywhere is counted (positive control)", () => {
    const planted = [...files, {
      path: "planted.ts",
      text: 'const t = jar["__Host-tf_refresh"];\nconst u = jar.tf_refresh;\nvoid jarCookie(parseCookies(h.get("cookie")), "tf_refresh");\n',
    }];
    expect(refreshReaders(planted).filter((p) => p === "planted.ts")).toHaveLength(3);
  });
});
