import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, bindDb, changeLog, refreshTokens, sessions, users } from "@trafficflow/db";
import {
  credentials, loginTokens, makeOwnedDb, readLock, totpSecrets, webauthnChallenges, type OwnedDb,
} from "@trafficflow/db/cloud";
import { MIGRATOR_ROLE, ownServersAvailable, startLockGround, type LockGround } from "@trafficflow/db/testing";
import {
  AuthService, generateToken, hashToken, makeTestAuthDeps, newTotpSecret, resolveSession, sessionEmailVerifiedAt, totpNow,
  type ServiceContext,
} from "@trafficflow/services";
import { SoftwareAuthenticator } from "./webauthn-authenticator.js";

const own = ownServersAvailable("packages/services/test/auth-runtime-lock.pg.test.ts");
const database = "ground";
const now = new Date();
const expiresAt = new Date(now.getTime() + 3_600_000);
const deps = makeTestAuthDeps();
const auth = new AuthService(deps);

describe.skipIf(!own)("sign-in under the forced account lock", () => {
  let ground: LockGround;
  let api: OwnedDb;
  let migrator: OwnedDb;

  beforeAll(async () => {
    ground = await startLockGround(17, "auth_runtime", database);
    await ground.setup(database);
    await ground.makeRoles(database);
    await ground.setup(database, MIGRATOR_ROLE, { lock: "apply" });
    api = makeOwnedDb(ground.urlAs(database, "ohmail_api"), { role: "api" });
    migrator = makeOwnedDb(ground.urlAs(database, MIGRATOR_ROLE));
    const login = ground.connectAs(database, "ohmail_api");
    try {
      const lock = await readLock(login, { role: "ohmail_api" });
      expect(lock.verdict).toBe("locked");
      expect(lock.role.bypass).toBe(false);
    } finally {
      await login.end();
    }
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await migrator?.close();
    ground?.stop();
  });

  const context = (owner?: { accountId: string; userId: string }, sessionId?: string): ServiceContext => ({
    db: owner ? bindDb(api.db, { account: owner.accountId }) : bindDb(api.db, { account: null }),
    credentialDb: owner ? bindDb(api.db, { account: null }) : undefined,
    accountId: owner?.accountId ?? "", userId: owner?.userId ?? null, sessionId,
    now: () => now, requestId: randomUUID(),
  });

  async function person(name: "A" | "B") {
    const [account] = await migrator.db.insert(accounts).values({ name }).returning({ id: accounts.id });
    const accountId = account!.id;
    const email = [`fixture-${randomUUID()}`, "example.invalid"].join("@");
    const [user] = await migrator.db.insert(users).values({
      accountId, email, displayName: name, emailVerifiedAt: now,
    }).returning({ id: users.id });
    const userId = user!.id;
    const password = generateToken();
    const secret = newTotpSecret();
    const encrypted = await deps.keyProvider.encrypt(secret);
    await migrator.db.insert(credentials).values({
      accountId, userId, passwordHash: await deps.passwordHasher.hash(password),
    });
    await migrator.db.insert(totpSecrets).values({
      accountId, userId, secretEnc: encrypted.ciphertext, keyVersion: encrypted.keyVersion, activated: true,
    });
    return { accountId, userId, email, password, secret };
  }

  async function firstFactor(owner: { accountId: string; userId: string }, consumedAt?: Date) {
    const token = generateToken();
    const [row] = await migrator.db.insert(loginTokens).values({
      ...owner, tokenHash: hashToken(token), methods: ["totp", "webauthn"], expiresAt, consumedAt,
    }).returning({ id: loginTokens.id });
    return { id: row!.id, token };
  }

  async function family(owner: { accountId: string; userId: string }) {
    const familyId = randomUUID();
    const access = generateToken();
    const refresh = generateToken();
    const [session] = await migrator.db.insert(sessions).values({
      accountId: owner.accountId, userId: owner.userId, familyId, accessTokenHash: hashToken(access),
      accessExpiresAt: expiresAt, refreshExpiresAt: expiresAt, lastTwofaAt: now,
    }).returning({ id: sessions.id });
    const sessionId = session!.id;
    await migrator.db.insert(refreshTokens).values({
      accountId: owner.accountId, userId: owner.userId, familyId, sessionId, tokenHash: hashToken(refresh), expiresAt,
    });
    return { familyId, sessionId, access, refresh };
  }

  async function passkey(owner: { accountId: string; userId: string }) {
    const authn = new SoftwareAuthenticator();
    const { sessionId } = await family(owner);
    const ctx = { ...context(owner, sessionId), db: bindDb(migrator.db, { account: owner.accountId }) };
    const { options } = await auth.webauthnRegisterOptions(ctx);
    await auth.webauthnRegisterVerify(ctx, { credential: authn.register({
      rpID: deps.config.rpID, origin: deps.config.origin, challenge: (options as { challenge: string }).challenge,
    }), label: "Passkey" });
    return authn;
  }

  it("starts password sign-in for the keyed address", async () => {
    const a = await person("A");
    const result = await auth.login(context(), { email: a.email, password: a.password });
    expect(result.status).toBe("twofa_required");
  });

  it("refuses another address with the first account’s password", async () => {
    const a = await person("A");
    const b = await person("B");
    await expect(auth.login(context(a), { email: b.email, password: a.password }))
      .rejects.toMatchObject({ code: "credential_refused" });
  });

  it("completes second-factor sign-in for the login token’s owner", async () => {
    const a = await person("A");
    const { token } = await firstFactor(a);
    const result = await auth.totpVerify(context(), {
      loginToken: token, code: totpNow(a.secret, now), kind: "desktop-linux",
    });
    expect(result.user.accountId).toBe(a.accountId);
    const events = await migrator.db.select({ type: changeLog.entityType })
      .from(changeLog).where(eq(changeLog.accountId, a.accountId));
    expect(events).toContainEqual({ type: "settings" });
  });

  it("refuses a spent second-factor login token", async () => {
    const a = await person("A");
    const { token } = await firstFactor(a, now);
    await expect(auth.totpVerify(context(), { loginToken: token, code: totpNow(a.secret, now) }))
      .rejects.toMatchObject({ code: "credential_refused" });
  });

  it("offers only the passkeys of the login token’s account", async () => {
    const a = await person("A");
    const b = await person("B");
    const ownPasskey = await passkey(a);
    await passkey(b);
    const { token } = await firstFactor(a);
    const { options } = await auth.webauthnAssertOptions(context(), { loginToken: token });
    const offered = (options as { allowCredentials: { id: string }[] }).allowCredentials;
    expect(offered.length === 1 && offered[0]?.id === ownPasskey.credentialId.toString("base64url")).toBe(true);
  });

  it("refuses options for a spent passkey login token", async () => {
    const a = await person("A");
    const { token } = await firstFactor(a, now);
    await expect(auth.webauthnAssertOptions(context(), { loginToken: token }))
      .rejects.toMatchObject({ code: "credential_refused" });
  });

  it("opens a passkey challenge when the login account is already named", async () => {
    const a = await person("A");
    const { id, token } = await firstFactor(a);
    const { options } = await auth.webauthnAssertOptions(context(a), { loginToken: token });
    const [row] = await migrator.db.select({ challenge: webauthnChallenges.challenge })
      .from(webauthnChallenges).where(eq(webauthnChallenges.loginTokenId, id));
    expect(row?.challenge === (options as { challenge: string }).challenge).toBe(true);
  });

  it("consumes its passkey challenge and leaves another account’s challenge live", async () => {
    const a = await person("A");
    const b = await person("B");
    const ownPasskey = await passkey(a);
    await passkey(b);
    const la = await firstFactor(a);
    const lb = await firstFactor(b);
    const { options } = await auth.webauthnAssertOptions(context(), { loginToken: la.token });
    await auth.webauthnAssertOptions(context(), { loginToken: lb.token });
    const credential = ownPasskey.assert({
      rpID: deps.config.rpID, origin: deps.config.origin, challenge: (options as { challenge: string }).challenge,
    });
    const result = await auth.webauthnAssertVerify(context(), { loginToken: la.token, credential });
    expect(result.user.accountId).toBe(a.accountId);
    const [other] = await migrator.db.select({ consumedAt: webauthnChallenges.consumedAt })
      .from(webauthnChallenges).where(eq(webauthnChallenges.loginTokenId, lb.id));
    expect(other?.consumedAt).toBeNull();
  });

  it("rotates a refresh token without an access session", async () => {
    const a = await person("A");
    const f = await family(a);
    const { tokens } = await auth.refresh(context(), { refreshToken: f.refresh });
    expect(Boolean(tokens?.refreshToken && tokens.refreshToken !== f.refresh)).toBe(true);
  });

  it("refuses a live foreign refresh without spending it", async () => {
    const a = await person("A");
    const b = await person("B");
    const f = await family(b);
    await expect(auth.refresh(context(a), { refreshToken: f.refresh }))
      .rejects.toMatchObject({ code: "session_conflict" });
    const [row] = await migrator.db.select({ consumedAt: refreshTokens.consumedAt })
      .from(refreshTokens).where(eq(refreshTokens.familyId, f.familyId));
    expect(row?.consumedAt).toBeNull();
  });

  it("revokes a spent foreign refresh family and leaves the ambient family live", async () => {
    const a = await person("A");
    const b = await person("B");
    const own = await family(a);
    const foreign = await family(b);
    await auth.refresh(context(), { refreshToken: foreign.refresh });
    await expect(auth.refresh(context(a, own.sessionId), { refreshToken: foreign.refresh }))
      .rejects.toMatchObject({ code: "refresh_revoked" });
    const [stillLive] = await migrator.db.select({ revokedAt: sessions.revokedAt })
      .from(sessions).where(eq(sessions.id, own.sessionId));
    const [revoked] = await migrator.db.select({ revokedAt: sessions.revokedAt })
      .from(sessions).where(eq(sessions.id, foreign.sessionId));
    expect(stillLive?.revokedAt).toBeNull();
    expect(revoked?.revokedAt).toEqual(now);
  });

  it("signs out the refresh token’s family without an access session", async () => {
    const a = await person("A");
    const f = await family(a);
    const result = await auth.logout(context(), { refreshToken: f.refresh });
    expect(result.familyIds).toEqual([f.familyId]);
    const [revoked] = await migrator.db.select({ revokedAt: sessions.revokedAt })
      .from(sessions).where(eq(sessions.id, f.sessionId));
    expect(revoked?.revokedAt).toEqual(now);
  });

  it("leaves both families live when the browser names the wrong family", async () => {
    const a = await person("A");
    const b = await person("B");
    const ownFamily = await family(a);
    const foreign = await family(b);
    await expect(auth.logout(context(a, ownFamily.sessionId), {
      refreshToken: foreign.refresh, expectedFamily: ownFamily.familyId, browser: true,
    })).rejects.toMatchObject({ code: "session_mismatch" });
    const [stillLive] = await migrator.db.select({ revokedAt: sessions.revokedAt })
      .from(sessions).where(eq(sessions.id, foreign.sessionId));
    expect(stillLive?.revokedAt).toBeNull();
  });

  it("can sign out two proven families without reaching an unrelated session", async () => {
    const a = await person("A");
    const b = await person("B");
    const ambient = await family(a);
    const foreign = await family(b);
    const unrelated = await family(b);
    const result = await auth.logout(context(a, ambient.sessionId), { refreshToken: foreign.refresh });
    expect(new Set(result.familyIds)).toEqual(new Set([ambient.familyId, foreign.familyId]));
    const readRevoke = async (id: string) => {
      const [row] = await migrator.db.select({ at: sessions.revokedAt }).from(sessions).where(eq(sessions.id, id));
      return row?.at;
    };
    expect(await readRevoke(ambient.sessionId)).toEqual(now);
    expect(await readRevoke(foreign.sessionId)).toEqual(now);
    expect(await readRevoke(unrelated.sessionId)).toBeNull();
  });

  it("resolves a bearer’s user in the account named by the session row", async () => {
    const a = await person("A");
    const f = await family(a);
    const found = await resolveSession(bindDb(api.db, { account: null }), f.access, now);
    expect(found).toMatchObject({
      accountId: a.accountId, userId: a.userId, sessionId: f.sessionId,
    });
    const [user] = await bindDb(api.db, { account: found!.accountId })
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.id, found!.userId), eq(users.accountId, found!.accountId)))
      .limit(1);
    expect(user).toEqual({ emailVerifiedAt: now });
  });

  it("the verified mark the spend gate reads: the session's own user under its account, never another account's", async () => {
    const a = await person("A");
    const b = await person("B");
    const f = await family(a);
    const found = (await resolveSession(bindDb(api.db, { account: null }), f.access, now))!;
    const own = bindDb(api.db, { account: found.accountId });
    expect(await sessionEmailVerifiedAt(own, found)).toEqual(now);
    // B's user is verified too: only the lock and the account predicate keep it out.
    expect(await sessionEmailVerifiedAt(own, { accountId: a.accountId, userId: b.userId })).toBeNull();
    // The door's handle names no account: refused before any statement.
    await expect(sessionEmailVerifiedAt(bindDb(api.db, { account: null }), found)).rejects.toMatchObject({ code: "binding_refused" });
  });

  it("a resolved bearer’s scope hides the other account’s session", async () => {
    const a = await person("A");
    const b = await person("B");
    const ownFamily = await family(a);
    const foreign = await family(b);
    const found = await resolveSession(bindDb(api.db, { account: null }), ownFamily.access, now);
    expect(found?.accountId).toBe(a.accountId);
    const rows = await bindDb(api.db, { account: found!.accountId })
      .select({ id: sessions.id }).from(sessions).where(eq(sessions.id, foreign.sessionId));
    expect(rows).toEqual([]);
  });
});
