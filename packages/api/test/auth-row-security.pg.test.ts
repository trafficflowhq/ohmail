import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { accounts, pairingTokens, users } from "@trafficflow/db";
import { createPolicyStatement } from "@trafficflow/db/admin";
import {
  API_ROLE, LOCK_READERS, READER_SCHEMA, WORKER_ROLE, lockedTables, makeOwnedDb,
  credentials, invites, loginTokens, oauthAuthCodes, policiesFor, policyList, readerStatement, waitlist, type OwnedDb,
} from "@trafficflow/db/cloud";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import { hashToken, makeAuthService, makeMailService, makeTestAuthDeps, makeWaitlistService, SpyMailer, throttleKeysFor, totpNow, type Db } from "@trafficflow/services";
import { SoftwareAuthenticator } from "../../services/test/webauthn-authenticator.js";
import { FIXED_NOW, perRequest, req, seedSession, setCookieMap } from "./helpers.js";

const pgUp = await realPgAvailable();
const ground = throwawayDb("auth_row_security");
const app = createApp(apiRoutes);

describe.skipIf(!pgUp)("sign-in doors under forced row security", () => {
  let owner: OwnedDb;
  let runtime: OwnedDb;
  let now = FIXED_NOW;
  const mailer = new SpyMailer();
  const authDeps = makeTestAuthDeps({ publicSignup: true, maxDesktopApprovalsPerWindow: 25 });
  const mail = makeMailService({
    mailer,
    config: { appUrl: "http://localhost:3001", siteUrl: "http://localhost:3000", supportEmail: "support@example.test" },
    throttleKeys: throttleKeysFor(authDeps.keyProvider),
  });
  const auth = makeAuthService({ ...authDeps, mail });
  const funnel = makeWaitlistService({ throttleKeys: throttleKeysFor(authDeps.keyProvider) });
  type Tokens = { accessToken: string; refreshToken: string };

  beforeAll(async () => {
    await ground.createFromTemplate();
    owner = makeOwnedDb(ground.url);
    const ddl = (statement: string) => owner.db.execute(sql.raw(statement));
    // PostgreSQL roles are cluster-wide. Keep their credentials and attributes untouched.
    for (const role of [API_ROLE, WORKER_ROLE]) {
      await ddl(`do $$ begin create role ${role} nologin; exception when duplicate_object then null; end $$`);
    }
    await ddl(`grant select, insert, update, delete on all tables in schema public to ${API_ROLE}`);
    await ddl(`create schema ${READER_SCHEMA}`);
    for (const reader of LOCK_READERS) await ddl(readerStatement(reader));
    for (const policy of policiesFor(policyList(), new Set([API_ROLE, WORKER_ROLE]))) {
      await ddl(createPolicyStatement(policy));
    }
    for (const table of lockedTables()) {
      await ddl(`alter table public."${table}" enable row level security`);
      await ddl(`alter table public."${table}" force row level security`);
    }
    const url = new URL(ground.url);
    url.searchParams.set("options", `-c role=${API_ROLE}`);
    runtime = makeOwnedDb(url.toString(), { role: "api" });
    const [role] = await runtime.db.execute(sql`
      select current_user = ${API_ROLE} and not rolsuper and not rolbypassrls as restricted
      from pg_roles where rolname = current_user
    `);
    expect(role?.restricted).toBe(true);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await Promise.all([runtime?.close(), owner?.close()]);
    await ground.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  function request(method: string, path: string, body?: unknown, bearer?: string, cookies?: Record<string, string>) {
    const deps = perRequest({
      ...({
        now: () => now, requestId: randomUUID(), session: null,
        authConfig: authDeps.config, keyProvider: authDeps.keyProvider, services: { auth, waitlist: funnel },
      } as unknown as Omit<ApiDeps, "db">),
      db: runtime.db as unknown as Db,
    });
    return app.handle(req(method, path, {
      bearer, body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "x-forwarded-for": "198.18.0.1",
        ...(cookies?.tf_csrf ? { "x-csrf-token": cookies.tf_csrf } : {}),
      },
      cookie: cookies && Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; "),
    }), deps);
  }

  function proof() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }

  const steppedUpSession = () => seedSession(owner.db as unknown as Db, { now, lastTwofaAt: now });

  async function deviceCode(bearer: string) {
    const issued = await request("POST", "/pair", { grant: "device-pair" }, bearer);
    expect(issued.status).toBe(200);
    const { token } = await issued.json() as { token: string };
    return { grant: "device-pair", token, kind: "mobile-android" };
  }

  async function desktopCode(bearer: string) {
    const issued = await request("POST", "/auth/desktop-link", {}, bearer);
    expect(issued.status).toBe(200);
    const { code } = await issued.json() as { code: string };
    return { code, kind: "desktop-linux" };
  }

  async function askDesktop() {
    const { verifier, challenge } = proof();
    const asked = await request("POST", "/auth/desktop-approval", { challenge, kind: "desktop-linux", label: "Workstation" });
    expect(asked.status, "desktop approval issue").toBe(200);
    const { approvalId } = await asked.json() as { approvalId: string };
    return { approvalId, verifier, kind: "desktop-linux" };
  }

  it("registers, verifies, signs in and connects a desktop through the browser", async () => {
    const email = `signup-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const registration = await request("POST", "/auth/register", { email, password, displayName: "Cloud user" });
    expect(registration.status, "public registration").toBe(202);
    expect(registration.headers.has("set-cookie")).toBe(false);
    const delivered = mailer.only("email_verification");
    const token = new URL(delivered.data.verifyUrl).searchParams.get("token");
    const verification = { token, password };
    const wrongPassword = { token, password: randomBytes(24).toString("base64url") };
    expect((await request("POST", "/auth/verify-email", wrongPassword)).status).toBe(401);
    const other = await steppedUpSession();
    expect((await request("POST", "/auth/verify-email", verification, other.token)).status).toBe(409);
    const verified = await request("POST", "/auth/verify-email", verification);
    expect(verified.status, "mail verification after refusals").toBe(200);
    expect((await request("POST", "/auth/verify-email", verification)).status).toBe(400);
    const enrollment = setCookieMap(verified);

    const enroll = await request("POST", "/auth/2fa/totp/enroll", {}, undefined, enrollment);
    expect(enroll.status).toBe(200);
    const { secret } = await enroll.json() as { secret: string };
    const activate = await request("POST", "/auth/2fa/totp/activate", { code: totpNow(secret, now) }, undefined, enrollment);
    expect(activate.status).toBe(200);
    now = new Date(now.getTime() + 30_000);

    const login = await request("POST", "/auth/login", { email, password });
    expect(login.status, "password sign-in").toBe(200);
    const { loginToken } = await login.json() as { loginToken: string };
    const browser = await request("POST", "/auth/2fa/totp/verify", { loginToken, code: totpNow(secret, now) });
    expect(browser.status, "complete sign-in").toBe(200);
    const totpCookies = setCookieMap(browser);
    const passkey = new SoftwareAuthenticator();
    const relyingParty = { rpID: "localhost", origin: "http://localhost:3000" };
    const registrationOptions = await request("POST", "/auth/2fa/webauthn/register/options", {}, undefined, totpCookies);
    expect(registrationOptions.status).toBe(200);
    const prepare = await registrationOptions.json() as { options: { challenge: string } };
    const credential = passkey.register({ ...relyingParty, challenge: prepare.options.challenge });
    expect((await request("POST", "/auth/2fa/webauthn/register/verify", { credential }, undefined, totpCookies)).status).toBe(200);

    const passkeyLogin = await request("POST", "/auth/login", { email, password });
    expect(passkeyLogin.status).toBe(200);
    const next = await passkeyLogin.json() as { loginToken: string };
    const assertionOptions = await request("POST", "/auth/2fa/webauthn/assert/options", next);
    expect(assertionOptions.status).toBe(200);
    const { options } = await assertionOptions.json() as { options: { challenge: string } };
    const assertion = passkey.assert({ ...relyingParty, challenge: options.challenge });
    const signedIn = await request("POST", "/auth/2fa/webauthn/assert/verify", { ...next, credential: assertion });
    expect(signedIn.status, "passkey sign-in").toBe(200);
    const cookies = setCookieMap(signedIn);

    const desktop = await askDesktop();
    const path = `/auth/desktop-approval/${desktop.approvalId}`;
    const page = await request("GET", path, undefined, undefined, cookies);
    expect(page.status, "desktop approval read").toBe(200);
    expect((await page.json() as { approved: boolean }).approved).toBe(false);
    expect((await request("POST", "/auth/desktop-approval/claim", desktop)).status).toBe(202);
    expect((await request("POST", `${path}/confirm`, {}, undefined, cookies)).status, "desktop approval confirmation").toBe(200);
    expect((await request("GET", path, undefined, other.token)).status).toBe(404);
    expect((await request("POST", `${path}/confirm`, {}, other.token)).status).toBe(404);
    expect((await request("POST", `${path}/deny`, {}, other.token)).status).toBe(404);
    expect((await request("POST", "/auth/desktop-approval/claim", desktop, other.token)).status).toBe(409);
    const claimed = await request("POST", "/auth/desktop-approval/claim", desktop);
    expect(claimed.status, "desktop approval claim").toBe(200);
    expect(claimed.headers.get("X-Ohmail-Account")).toBe(signedIn.headers.get("X-Ohmail-Account"));
    expect(claimed.headers.has("set-cookie")).toBe(false);
    const { tokens } = await claimed.json() as { tokens: Tokens };
    expect((await request("GET", "/auth/session", undefined, tokens.accessToken)).status).toBe(200);
    expect((await request("POST", "/auth/desktop-approval/claim", desktop)).status).toBe(410);

    const refreshed = await request("POST", "/auth/refresh", { refreshToken: tokens.refreshToken });
    expect(refreshed.status, "desktop session refresh").toBe(200);
    const renewed = await refreshed.json() as { tokens: Tokens };
    expect((await request("GET", "/auth/session", undefined, renewed.tokens.accessToken)).status).toBe(200);
    expect((await request("POST", "/auth/refresh/logout", { refreshToken: renewed.tokens.refreshToken })).status).toBe(204);
    expect((await request("GET", "/auth/session", undefined, renewed.tokens.accessToken)).status).toBe(401);
    expect((await request("POST", "/auth/logout", {}, undefined, cookies)).status).toBe(204);
    expect((await request("GET", "/auth/session", undefined, undefined, cookies)).status).toBe(401);
  }, 30_000);

  it("issues a bare approval and lets a signed-in user deny it", async () => {
    const browser = await seedSession(owner.db as unknown as Db, { now, lastTwofaAt: now });
    const desktop = await askDesktop();
    expect((await request("POST", `/auth/desktop-approval/${desktop.approvalId}/deny`, {}, browser.token)).status).toBe(200);
    const denied = await request("POST", "/auth/desktop-approval/claim", desktop);
    expect(denied.status).toBe(410);
    expect((await denied.json() as { error: { code: string } }).error.code).toBe("approval_denied");
  });

  it("redeems a device code and opens a session", async () => {
    const browser = await steppedUpSession();
    const other = await steppedUpSession();
    const pairing = await deviceCode(browser.token);
    expect((await request("POST", "/pair/redeem", pairing, other.token)).status).toBe(409);
    const state = await request("POST", "/pair/state", { tokenHash: hashToken(pairing.token) });
    expect(state.status).toBe(200);
    expect((await state.json() as { state: string }).state).toBe("live");
    const paired = await request("POST", "/pair/redeem", pairing);
    expect(paired.status).toBe(200);
    expect(paired.headers.get("X-Ohmail-Account")).toBe(browser.accountId);
    const { tokens } = await paired.json() as { tokens: Tokens };
    expect((await request("GET", "/auth/session", undefined, tokens.accessToken)).status).toBe(200);
    const used = await request("POST", "/pair/state", { tokenHash: hashToken(pairing.token) });
    expect((await used.json() as { state: string }).state).toBe("spent");

    const { challenge, verifier } = proof();
    const offered = await request("POST", "/pair/handoff", { refreshToken: tokens.refreshToken, challenge, target: "ohcal" });
    expect(offered.status).toBe(200);
    const { handoff } = await offered.json() as { handoff: { token: string } | null };
    expect(handoff !== null, "phone handoff issued a code").toBe(true);
    const connected = await request("POST", "/pair/redeem", {
      grant: "app-handoff", token: handoff!.token, verifier, kind: "mobile-android",
    });
    expect(connected.status, "phone handoff redeemed").toBe(200);
    const child = await connected.json() as { tokens: Tokens };
    expect((await request("GET", "/auth/session", undefined, child.tokens.accessToken)).status).toBe(200);
  });

  it("connects a desktop using a typed code", async () => {
    const browser = await steppedUpSession();
    const other = await steppedUpSession();
    const desktop = await desktopCode(browser.token);
    expect((await request("POST", "/auth/desktop-claim", desktop, other.token)).status).toBe(409);
    const claimed = await request("POST", "/auth/desktop-claim", desktop);
    expect(claimed.status, "typed desktop code redemption").toBe(200);
    expect(claimed.headers.get("X-Ohmail-Account")).toBe(browser.accountId);
    const { tokens } = await claimed.json() as { tokens: Tokens };
    expect((await request("GET", "/auth/session", undefined, tokens.accessToken)).status).toBe(200);
  });

  it("reissues a verification email for an unverified account", async () => {
    mailer.reset();
    const browser = await seedSession(owner.db as unknown as Db, { now, emailVerified: false });
    expect((await request("POST", "/auth/verify-email/resend", {})).status).toBe(401);
    expect((await request("POST", "/auth/verify-email/resend", {}, browser.token)).status).toBe(200);
    expect(mailer.ofTemplate("email_verification")).toHaveLength(1);
  });

  async function oauthCode(bearer: string) {
    const { challenge, verifier } = proof();
    const client_id = "tf-macos";
    const redirect_uri = "trafficflow://auth";
    const query = new URLSearchParams({ response_type: "code", code_challenge_method: "S" + "256",
      code_challenge: challenge, client_id, redirect_uri, state: randomUUID() });
    const started = await request("GET", `/oauth/authorize?${query}`, undefined, bearer);
    expect(started.status).toBe(302);
    const handle = new URL(started.headers.get("location")!).searchParams.get("request");
    const approved = await request("POST", "/oauth/authorize", { request: handle }, bearer);
    expect(approved.status).toBe(200);
    const { redirect } = await approved.json() as { redirect: string };
    const code = new URL(redirect).searchParams.get("code");
    if (!code) throw new Error("OAuth approval did not issue a code");
    return { grant_type: "authorization_code", client_id, redirect_uri, code, code_verifier: verifier };
  }

  it("exchanges an OAuth authorization code and ends the family if that code is presented again", async () => {
    const browser = await steppedUpSession();
    const exchange = await oauthCode(browser.token);
    const exchanged = await request("POST", "/oauth/token", exchange);
    expect(exchanged.status, "authorization code exchange").toBe(200);
    const { accessToken } = await exchanged.json() as Tokens;
    expect((await request("GET", "/auth/session", undefined, accessToken)).status).toBe(200);
    expect((await request("POST", "/oauth/token", exchange)).status).toBe(400);
    expect((await request("GET", "/auth/session", undefined, accessToken)).status).toBe(401);
  });

  it("refuses credentials for an erased account before spending them", async () => {
    const browser = await steppedUpSession();
    const pairing = await deviceCode(browser.token);
    const typed = await desktopCode(browser.token);
    const approval = await askDesktop();
    const confirm = await request("POST", `/auth/desktop-approval/${approval.approvalId}/confirm`, {}, browser.token);
    expect(confirm.status).toBe(200);
    const oauth = await oauthCode(browser.token);
    await owner.db.update(accounts).set({ erasedAt: now }).where(eq(accounts.id, browser.accountId));

    expect((await request("POST", "/pair/redeem", pairing)).status).toBe(410);
    expect((await request("POST", "/auth/desktop-claim", typed)).status).toBe(400);
    expect((await request("POST", "/auth/desktop-approval/claim", approval)).status).toBe(410);
    expect((await request("POST", "/oauth/token", oauth)).status).toBe(400);

    const [pairRow] = await owner.db.select({ consumedAt: pairingTokens.consumedAt }).from(pairingTokens)
      .where(eq(pairingTokens.tokenHash, hashToken(pairing.token)));
    const [typedRow] = await owner.db.select({ consumedAt: loginTokens.consumedAt }).from(loginTokens)
      .where(eq(loginTokens.tokenHash, hashToken(typed.code)));
    const [approvalRow] = await owner.db.select({ consumedAt: loginTokens.consumedAt }).from(loginTokens)
      .where(eq(loginTokens.id, approval.approvalId));
    const [oauthRow] = await owner.db.select({ consumedAt: oauthAuthCodes.consumedAt }).from(oauthAuthCodes)
      .where(eq(oauthAuthCodes.codeHash, hashToken(oauth.code)));
    expect([pairRow?.consumedAt, typedRow?.consumedAt, approvalRow?.consumedAt, oauthRow?.consumedAt])
      .toEqual([null, null, null, null]);
  });

  it("answers a repeated public signup the same way and leaves the existing account alone", async () => {
    mailer.reset();
    const email = `again-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const first = await request("POST", "/auth/register", { email, password, displayName: "First" });
    expect(first.status).toBe(202);
    const identity = { id: users.id, accountId: users.accountId, name: users.displayName, verifiedAt: users.emailVerifiedAt };
    const before = await owner.db.select(identity).from(users).where(eq(users.email, email));
    expect(before).toHaveLength(1);
    const credential = { hash: credentials.passwordHash };
    const [original] = await owner.db.select(credential).from(credentials).where(eq(credentials.userId, before[0]!.id));
    mailer.reset();

    const again = await request("POST", "/auth/register", {
      email, password: randomBytes(24).toString("base64url"), displayName: "Second",
    });
    expect(again.status).toBe(202);
    expect(await again.text()).toBe(await first.text());
    expect(again.headers.has("set-cookie")).toBe(false);
    expect(mailer.ofTemplate("account_exists")).toHaveLength(1);
    expect(mailer.ofTemplate("email_verification")).toHaveLength(0);

    const after = await owner.db.select(identity).from(users).where(eq(users.email, email));
    expect(after).toEqual(before);
    const [current] = await owner.db.select(credential).from(credentials).where(eq(credentials.userId, before[0]!.id));
    expect(original !== undefined && current?.hash === original.hash, "stored password is unchanged").toBe(true);
  });

  it("accepts an email-bound invite and marks the signup on the waitlist", async () => {
    const email = `invited-${randomUUID()}@example.test`;
    const joined = await request("POST", "/waitlist", { email });
    expect(joined.status, "waitlist signup").toBe(202);
    const other = await steppedUpSession();
    expect((await request("POST", "/waitlist", { email, tier: "solo" }, other.token)).status).toBe(202);

    const password = randomBytes(24).toString("base64url");
    const inviteCode = randomBytes(12).toString("hex");
    await owner.db.insert(invites).values({
      email, codeHash: hashToken(inviteCode), issuedBy: "operator",
      expiresAt: new Date(now.getTime() + 60_000), confersVerified: true,
    });
    const signup = { email, password, inviteCode, displayName: "Invited user" };
    const wrongAddress = await request("POST", "/auth/register", { ...signup, email: `other-${randomUUID()}@example.test` });
    expect(wrongAddress.status).toBe(403);
    expect((await request("POST", "/auth/register", signup, other.token)).status).toBe(409);
    const [invite] = await owner.db.select({ consumedAt: invites.consumedAt }).from(invites)
      .where(eq(invites.codeHash, hashToken(inviteCode)));
    expect(invite?.consumedAt).toBeNull();

    const registered = await request("POST", "/auth/register", signup);
    expect(registered.status, "invite registration").toBe(201);
    const [entry] = await owner.db.select({ registeredAt: waitlist.registeredAt, tier: waitlist.tier })
      .from(waitlist).where(eq(waitlist.email, email));
    const [user] = await owner.db.select({ emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.email, email));
    expect(entry?.registeredAt).toEqual(now);
    expect(entry?.tier).toBe("solo");
    expect(user?.emailVerifiedAt).toEqual(now);
  });
});
