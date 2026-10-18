import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, desc, isNull, like } from "drizzle-orm";
import { generateSync } from "otplib";
import { makeTestDb } from "@trafficflow/db/testing";
import { devices, pairingTokens, refreshTokens, sessions } from "@trafficflow/db";
import {
  authEvents, authThrottle, credentials, loginTokens, pushSubscriptions, recoveryCodes, totpSecrets,
} from "@trafficflow/db/cloud";
import {
  AuthService, makeTestAuthDeps, ServiceError, resolveSession, generateToken, hashToken,
  classifyRefreshFailure, throttleKeysFor, mintPairingToken, redeemDevicePair, OAuthCodeReplayed,
  type AuthDeps, type SessionUser, type SessionEstablished, type ServiceContext,
} from "../src/index.js";
import { SoftwareAuthenticator } from "./webauthn-authenticator.js";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ORIGIN = "http://localhost:3000";
const RPID = "localhost";
const START = new Date("2026-07-27T00:00:00.000Z");

// A mutable test clock shared through the ServiceContext.
class Clock {
  constructor(public t: Date = new Date(START)) {}
  now = (): Date => this.t;
  advance(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
}

interface Harness {
  db: Db;
  svc: AuthService;
  deps: AuthDeps;
  clock: Clock;
  ctxFor(over?: Partial<ServiceContext>): ServiceContext;
}

async function harness(depsOver?: AuthDeps): Promise<Harness> {
  const db = await makeTestDb();
  const clock = new Clock();
  const deps = depsOver ?? makeTestAuthDeps();
  const svc = new AuthService(deps);
  const ctxFor = (over: Partial<ServiceContext> = {}): ServiceContext => ({
    db, accountId: "", userId: null, now: clock.now, requestId: "r", ip: "1.2.3.4", ...over,
  });
  return { db, svc, deps, clock, ctxFor };
}

async function register(h: Harness, email = "gil@x.example", password = "pw-correct-horse-password-password") {
  const { user } = await h.svc.register(h.ctxFor(), { email, password, displayName: "Gil", inviteCode: "INVITE-OK" });
  return user;
}

/** A session-scoped ctx for the given user (used for enrollment/step-up flows). */
function sessionCtx(h: Harness, user: SessionUser, sessionId?: string): ServiceContext {
  return h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sessionId ?? null });
}

/** The latest session row id for a user (tests need it for step-up ctx). */
async function latestSessionId(h: Harness, userId: string): Promise<string> {
  const rows = await h.db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt)).limit(1);
  return rows[0]!.id;
}

/**
 * A step-up'd FULL session ctx for `user`, seeded directly.
 *
 * The factor-enrollment methods now require EITHER an enrollment-scoped session (the
 * first factor, during onboarding) OR a full session with a recent 2FA — so a
 * fabricated ctx with `sessionId: null`, which is what these fixtures used, is no
 * longer an authorized caller for them. That is the point of the change: adding a
 * factor must be no easier than removing one. Tests below whose subject is NOT
 * onboarding use this to get the "already authenticated, adding a factor" caller; the
 * genuine onboarding shapes are exercised in the block (a real enrollment session)
 * and end-to-end in packages/api/test/enrollment-flow.test.ts.
 */
async function stepUppedCtx(h: Harness, user: SessionUser): Promise<ServiceContext> {
  const now = h.clock.now();
  const [row] = await h.db.insert(sessions).values({
    accountId: user.accountId, userId: user.userId, familyId: crypto.randomUUID(),
    scope: "full",
    accessExpiresAt: new Date(now.getTime() + 60 * 60_000),
    refreshExpiresAt: new Date(now.getTime() + 120 * 60_000),
    lastTwofaAt: now, lastSeenAt: now,
  }).returning();
  return sessionCtx(h, user, row!.id);
}

/**
 * Insert a live enrollment-scoped session directly — the shape re-entry used to
 * ACCUMULATE (and the shape two racing registrations could still briefly produce).
 * Seeding it is the only way to test the sweep now that `establishEnrollment`
 * supersedes: the public API can no longer be made to hold two at once, which is
 * exactly the fix.
 */
async function seedEnrollmentSession(h: Harness, user: SessionUser): Promise<string> {
  const token = generateToken();
  const now = h.clock.now();
  const ttl = h.deps.config.loginTokenTtlMs;
  await h.db.insert(sessions).values({
    accountId: user.accountId, userId: user.userId, familyId: crypto.randomUUID(),
    scope: "enrollment", accessTokenHash: hashToken(token),
    accessExpiresAt: new Date(now.getTime() + ttl),
    refreshExpiresAt: new Date(now.getTime() + ttl),
    lastTwofaAt: null, lastSeenAt: now,
  });
  return token;
}

async function enrollTotp(h: Harness, user: SessionUser): Promise<string> {
  const ctx = await stepUppedCtx(h, user);
  const { secret } = await h.svc.totpEnroll(ctx);
  const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
  await h.svc.totpActivate(ctx, { code });
  return secret;
}

async function enrollWebauthn(h: Harness, user: SessionUser): Promise<SoftwareAuthenticator> {
  const ctx = await stepUppedCtx(h, user);
  const auth = new SoftwareAuthenticator();
  const { options } = await h.svc.webauthnRegisterOptions(ctx);
  const cred = auth.register({ rpID: RPID, challenge: (options as any).challenge, origin: ORIGIN });
  await h.svc.webauthnRegisterVerify(ctx, { credential: cred, label: "MacBook" });
  return auth;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("AuthService — registration & first factor", () => {
  it("registers an invite-gated user, gated on 2FA enrollment", async () => {
    const h = await harness();
    const user = await register(h);
    expect(user.email).toBe("gil@x.example");
    expect(user.twofaEnrolled).toEqual({ webauthn: false, totp: false, recoveryCodes: false });
  });

  // A later change sharpened both codes. They used to be the generic `forbidden` / `conflict`, which a
  // client cannot turn into a true sentence: `invite_invalid` and `invite_used` are different
  // problems with different remedies, and `email_taken` means "sign in", not "something
  // conflicted". `invites.ts` owns the taxonomy.
  it("rejects a bad invite code and duplicate email", async () => {
    const h = await harness();
    // A REAL password (>= 12 chars). It used to be `"p"`, which now fails the length rule
    // first and would have masked both refusals below with a 400.
    const PW = "pw-correct-horse-password-password";
    await expect(h.svc.register(h.ctxFor(), { email: "a@x.example", password: PW, displayName: "A", inviteCode: "NOPE" }))
      .rejects.toMatchObject({ code: "invite_invalid", httpStatus: 403 });
    await register(h, "dup@x.example");
    await expect(h.svc.register(h.ctxFor(), { email: "dup@x.example", password: PW, displayName: "D", inviteCode: "INVITE-OK" }))
      .rejects.toMatchObject({ code: "email_taken", httpStatus: 409 });
  });

  it("enforces the advertised 12-character minimum, and a ceiling, SERVER-side", () => {
    // `/join` renders `minLength={12}`; until `requirePassword` that HTML attribute was the
    // entire enforcement, so `curl` could open an account with one character. It matters more
    // than usual here because between `register` and the first factor the password is the ONLY
    // credential, and `login` on a zero-factor user re-mints an enrollment session — so a
    // guessable password lets a stranger enroll THEIR passkey on it.
    return (async () => {
      const h = await harness();
      const bad = ["hunter2", "", "  ", "a".repeat(257)];
      for (const password of bad) {
        await expect(
          h.svc.register(h.ctxFor(), { email: `p${bad.indexOf(password)}@x.example`, password, displayName: "P", inviteCode: "INVITE-OK" }),
          JSON.stringify(password.slice(0, 20)),
        ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
      }
      // The boundary itself is inclusive on both ends.
      await expect(h.svc.register(h.ctxFor(), {
        email: "min@x.example", password: "a".repeat(12), displayName: "P", inviteCode: "INVITE-OK",
      })).resolves.toBeTruthy();
      await expect(h.svc.register(h.ctxFor(), {
        email: "max@x.example", password: "a".repeat(256), displayName: "P", inviteCode: "INVITE-OK",
      })).resolves.toBeTruthy();
    })();
  });

  // this assertion learned the new shape. It used to read
  // `expect(ch.status).toBe("twofa_required"); expect(ch.methods).toEqual([])` for a
  // freshly-registered user, i.e. it asserted the dead end: a login token with
  // zero methods that no endpoint accepts. That state no longer exists — a 2FA-less
  // login now returns the enrollment session (checked in the block below) — so the
  // challenge case is asserted where it is real: on a user who HAS a factor.
  it("password login returns a 2FA challenge (never a full session), methods reflect enrollment", async () => {
    const h = await harness();
    const user = await register(h);
    await enrollTotp(h, user);
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    expect(ch.status).toBe("twofa_required");
    if (ch.status !== "twofa_required") throw new Error("unreachable");
    expect(ch.loginToken).toBeTruthy();
    expect(ch.methods).toContain("totp");
  });

  it("constant-time unknown-email: identical error + password verify still runs (no enumeration)", async () => {
    let verifyCalls = 0;
    const base = makeTestAuthDeps();
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        hash: (p) => base.passwordHasher.hash(p),
        verify: (p, s) => { verifyCalls++; return base.passwordHasher.verify(p, s); },
      },
    };
    const h = await harness(deps);
    await register(h, "known@x.example");

    const wrongPw = await h.svc.login(h.ctxFor(), { email: "known@x.example", password: "WRONG" }).catch((e) => e);
    const callsAfterKnown = verifyCalls;
    const unknown = await h.svc.login(h.ctxFor(), { email: "ghost@x.example", password: "WRONG" }).catch((e) => e);

    expect(wrongPw).toBeInstanceOf(ServiceError);
    expect(unknown).toBeInstanceOf(ServiceError);
    // Identical machine code + message → no account-existence oracle.
    expect(unknown.code).toBe(wrongPw.code);
    expect(unknown.message).toBe(wrongPw.message);
    expect(unknown.code).toBe("credential_refused");
    // The unknown-email path still performed a full scrypt verify (against a decoy).
    expect(verifyCalls).toBeGreaterThan(callsAfterKnown);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage-2. The HTTP-level proof lives in
// packages/api/test/enrollment-flow.test.ts; this block pins the SERVICE-level
// invariants of the enrollment session itself — the ones a route flag cannot
// enforce: what the row contains, that step-up stays unreachable, and that the
// first factor EXCHANGES the session rather than upgrading it in place.
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthService — the enrollment-scoped session", () => {
  const REG = { email: "gil@x.example", password: "pw-correct-horse-password-password", displayName: "Gil", inviteCode: "INVITE-OK" };

  /** Bind a ServiceContext to the session an enrollment token resolves to. */
  async function ctxOf(h: Harness, user: SessionUser, token: string): Promise<ServiceContext & { sessionId: string }> {
    const resolved = await resolveSession(h.db, token, h.clock.now());
    expect(resolved).not.toBeNull();
    return { ...sessionCtx(h, user, resolved!.sessionId), sessionId: resolved!.sessionId };
  }

  it("register mints it: scope='enrollment', no lastTwofaAt, no device, no refresh token, TTL = loginTokenTtlMs", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    expect(reg.status).toBe("enrollment");
    expect(reg.next).toBe("enroll_2fa");
    expect(reg.enrollmentToken).toBeTruthy();
    expect(reg.expiresIn).toBe(Math.floor(h.deps.config.loginTokenTtlMs / 1000));
    expect(reg.user.twofaEnrolled).toEqual({ webauthn: false, totp: false, recoveryCodes: false });

    const rows = await h.db.select().from(sessions)
      .where(and(eq(sessions.userId, reg.user.userId), eq(sessions.scope, "enrollment")));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.lastTwofaAt).toBeNull();                       // step-up unreachable
    expect(row.deviceId).toBeNull();                          // not a manageable device
    expect(row.accessExpiresAt.getTime() - h.clock.now().getTime()).toBe(h.deps.config.loginTokenTtlMs);
    expect(row.refreshExpiresAt.getTime()).toBe(row.accessExpiresAt.getTime());
    // Nothing can extend it: no refresh token row exists at all.
    expect(await h.db.select().from(refreshTokens).where(eq(refreshTokens.userId, reg.user.userId))).toHaveLength(0);

    // resolveSession surfaces the scope, which is what the API gate reads.
    const resolved = await resolveSession(h.db, reg.enrollmentToken, h.clock.now());
    expect(resolved?.scope).toBe("enrollment");
    expect(resolved?.sessionId).toBe(row.id);
    expect(resolved?.lastTwofaAt).toBeNull();

    // …and it dies on its own after the TTL.
    h.clock.advance(h.deps.config.loginTokenTtlMs + 1);
    expect(await resolveSession(h.db, reg.enrollmentToken, h.clock.now())).toBeNull();
  });

  it("never satisfies step-up, so no factor removal and no recovery codes", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    const ctx = await ctxOf(h, reg.user, reg.enrollmentToken);
    await expect(h.svc.requireStepUp(ctx)).rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
    await expect(h.svc.generateRecoveryCodes(ctx)).rejects.toMatchObject({ code: "step_up_required" });
  });

  it("the first factor EXCHANGES it: new session id + new family, old family revoked, step-up fresh", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    const ctx = await ctxOf(h, reg.user, reg.enrollmentToken);
    const before = (await h.db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)))[0]!;

    const { secret } = await h.svc.totpEnroll(ctx);
    const activated = await h.svc.totpActivate(ctx, {
      code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }),
    });
    expect(activated.twofaEnrolled.totp).toBe(true);
    expect(activated.session?.status).toBe("authenticated");
    expect(activated.session?.tokens?.accessToken).toBeTruthy();
    expect(activated.session?.tokens?.refreshToken).toBeTruthy();

    // The enrollment session is gone, not promoted: revoked, and its token is dead.
    const after = (await h.db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)))[0]!;
    expect(after.revokedAt).not.toBeNull();
    expect(after.scope).toBe("enrollment");                   // never rewritten in place
    expect(await resolveSession(h.db, reg.enrollmentToken, h.clock.now())).toBeNull();

    // The replacement is a genuinely new session in a new refresh family.
    const fresh = await resolveSession(h.db, activated.session!.tokens!.accessToken, h.clock.now());
    expect(fresh!.scope).toBe("full");
    expect(fresh!.sessionId).not.toBe(ctx.sessionId);
    expect(fresh!.lastTwofaAt).not.toBeNull();
    const freshRow = (await h.db.select().from(sessions).where(eq(sessions.id, fresh!.sessionId)))[0]!;
    expect(freshRow.familyId).not.toBe(before.familyId);
    // DEVICES: the exchanged web session is DEVICE-LESS by design — a device row now means a
    // NAMED device (a pairing redeem's mint, the desktop's macos claim), never a per-sign-in
    // "Web" row. This line used to assert the opposite ("the real device is registered here");
    // what made that row "real" was only that the enrollment session lacked one, and the
    // distinction both sessions actually share is scope, asserted above.
    expect(freshRow.deviceId).toBeNull();

    // Step-up is satisfied on the exchanged session — recovery codes now work, which
    // is what makes "passkey → codes" a single uninterrupted onboarding.
    const codes = await h.svc.generateRecoveryCodes(sessionCtx(h, reg.user, fresh!.sessionId));
    expect(codes.codes).toHaveLength(10);
  });

  it("a FULL session adding a second factor is NOT exchanged (no churn on the ordinary path)", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    const ctx = await ctxOf(h, reg.user, reg.enrollmentToken);
    const { secret } = await h.svc.totpEnroll(ctx);
    const activated = await h.svc.totpActivate(ctx, {
      code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }),
    });
    const fullCtx = sessionCtx(h, reg.user, (await resolveSession(h.db, activated.session!.tokens!.accessToken, h.clock.now()))!.sessionId);

    const authenticator = new SoftwareAuthenticator();
    const { options } = await h.svc.webauthnRegisterOptions(fullCtx);
    const credential = authenticator.register({ rpID: RPID, challenge: (options as any).challenge, origin: ORIGIN });
    const out = await h.svc.webauthnRegisterVerify(fullCtx, { credential, label: "MacBook" });
    expect(out.twofaEnrolled.webauthn).toBe(true);
    expect(out.session).toBeUndefined();                      // the caller keeps its session
    expect(await resolveSession(h.db, activated.session!.tokens!.accessToken, h.clock.now())).not.toBeNull();
  });

  it("login re-entry mints a FRESH enrollment session and audits it as password-only", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    const resume = await h.svc.login(h.ctxFor(), { email: REG.email, password: REG.password });
    expect(resume.status).toBe("enrollment");
    if (resume.status !== "enrollment") throw new Error("unreachable");
    expect(resume.enrollmentToken).not.toBe(reg.enrollmentToken);
    expect(resume.next).toBe("enroll_2fa");

    // The new one is live and enrollment-scoped; the OLD one is revoked. Re-entry
    // SUPERSEDES. It used to accumulate live siblings, and because the exchange only
    // revoked the family it was handed (each enrollment session gets a fresh one),
    // finishing onboarding on either left the other a fully usable password-only
    // credential — see "sibling enrollment sessions" below.
    expect((await resolveSession(h.db, resume.enrollmentToken, h.clock.now()))?.scope).toBe("enrollment");
    expect(await resolveSession(h.db, reg.enrollmentToken, h.clock.now())).toBeNull();
    const liveEnrollment = await h.db.select().from(sessions).where(and(
      eq(sessions.userId, reg.user.userId), eq(sessions.scope, "enrollment"), isNull(sessions.revokedAt),
    ));
    expect(liveEnrollment).toHaveLength(1);
    const ctx = await ctxOf(h, resume.user, resume.enrollmentToken);
    const audit = await h.svc.listAudit(ctx);
    expect(audit.items.filter((i) => i.event === "enrollment_started")).toHaveLength(2);
    expect(audit.items.every((i) => i.event !== "login")).toBe(true);   // NOT recorded as a login

    // A wrong password gets nothing.
    await expect(h.svc.login(h.ctxFor(), { email: REG.email, password: "WRONG" }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
  });

  it("getSession reports the scope so a resuming client can route itself", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    const ctx = await ctxOf(h, reg.user, reg.enrollmentToken);
    expect((await h.svc.getSession(ctx)).scope).toBe("enrollment");

    const { secret } = await h.svc.totpEnroll(ctx);
    const activated = await h.svc.totpActivate(ctx, {
      code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }),
    });
    const fresh = await resolveSession(h.db, activated.session!.tokens!.accessToken, h.clock.now());
    expect((await h.svc.getSession(sessionCtx(h, reg.user, fresh!.sessionId))).scope).toBe("full");
  });

  it("logout works from an enrollment session (abandoning onboarding is always possible)", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    const ctx = await ctxOf(h, reg.user, reg.enrollmentToken);
    await h.svc.logout(ctx, {});
    expect(await resolveSession(h.db, reg.enrollmentToken, h.clock.now())).toBeNull();
  });

  /**
   * THE BLOCKER THIS SLICE SHIPPED WITH, pinned at the row level. The exchange revoked
   * `revokeFamily(callerFamily)`, and `establishEnrollment` mints a FRESH `familyId`
   * every time — so a sibling enrollment session shared nothing with the one being
   * exchanged and stayed `scope='enrollment'`, live, and able to register an
   * attacker-chosen passkey plus a full session. The predicate is now
   * `user_id + scope='enrollment'`.
   */
  it("sibling enrollment sessions do NOT survive the exchange (revocation is by user+scope)", async () => {
    const h = await harness();
    const reg = await h.svc.register(h.ctxFor(), REG);
    const ctx = await ctxOf(h, reg.user, reg.enrollmentToken);
    const sibling = await seedEnrollmentSession(h, reg.user);
    expect((await resolveSession(h.db, sibling, h.clock.now()))?.scope).toBe("enrollment");

    const { secret } = await h.svc.totpEnroll(ctx);
    await h.svc.totpActivate(ctx, {
      code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }),
    });

    expect(await resolveSession(h.db, sibling, h.clock.now())).toBeNull();
    expect(await resolveSession(h.db, reg.enrollmentToken, h.clock.now())).toBeNull();
    const live = await h.db.select().from(sessions).where(and(
      eq(sessions.userId, reg.user.userId), eq(sessions.scope, "enrollment"), isNull(sessions.revokedAt),
    ));
    expect(live).toHaveLength(0);
  });

  it("ANY full session closes the window: a completed 2FA login revokes a stray enrollment session", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);                 // a factor now exists
    const stray = await seedEnrollmentSession(h, user);
    h.clock.advance(30_000);

    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    if (ch.status !== "twofa_required") throw new Error("unreachable");
    await h.svc.totpVerify(h.ctxFor(), {
      loginToken: ch.loginToken,
      code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }),
    });

    // `establish` is the choke point, so the invariant does not depend on which door
    // the full session came through — hence a live enrollment session and a live full
    // session can never coexist for one user (which is what makes an enrollment
    // session's absence from `GET /devices` harmless).
    expect(await resolveSession(h.db, stray, h.clock.now())).toBeNull();
  });

  it("a FULL session needs recent 2FA to enroll another factor (adding ≙ removing)", async () => {
    const h = await harness();
    const user = await register(h);
    await enrollTotp(h, user);
    const sid = await latestSessionId(h, user.userId);
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid });

    // Fresh — allowed.
    await expect(h.svc.webauthnRegisterOptions(sctx)).resolves.toBeTruthy();

    // Stale (a stolen cookie / an unattended browser / a long-lived bearer): adding a
    // factor would grant durable independent access, so it needs a step-up exactly
    // like `totpRemove` does.
    h.clock.advance(6 * 60_000);
    await expect(h.svc.webauthnRegisterOptions(sctx)).rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
    await expect(h.svc.totpEnroll(sctx)).rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
    await expect(h.svc.webauthnRegisterVerify(sctx, { credential: {}, label: "x" }))
      .rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
    await expect(h.svc.totpActivate(sctx, { code: "000000" }))
      .rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential rate-limiting, hardened alongside the onboarding gate. The password-only re-entry
// login rests entirely on these: for a user with no second factor the password IS
// the only factor in existence.
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthService — lockout integrity", () => {
  const REG = { password: "pw-correct-horse-password-password", displayName: "Gil", inviteCode: "INVITE-OK" };

  it("lockout leaks no account existence: a known and an unknown email answer identically past the threshold", async () => {
    const h = await harness(makeTestAuthDeps({ maxFailures: 3 }));
    await register(h, "known@x.example");
    const attempt = async (email: string): Promise<ServiceError> =>
      h.svc.login(h.ctxFor(), { email, password: "WRONG" }).catch((e) => e as ServiceError);

    for (let i = 0; i < 3; i++) expect((await attempt("known@x.example")).code).toBe("credential_refused");
    for (let i = 0; i < 3; i++) expect((await attempt("ghost@x.example")).code).toBe("credential_refused");

    // The unknown-email branch used to call `throttleFailure` but never
    // `throttleCheck`, so past the threshold a REGISTERED email answered 423 while an
    // unregistered one kept answering 401 — an unlimited, perfectly reliable
    // enumeration oracle.
    const known = await attempt("known@x.example");
    const ghost = await attempt("ghost@x.example");
    expect(known.code).toBe("account_locked");
    expect(known.httpStatus).toBe(423);
    expect(ghost.code).toBe(known.code);
    expect(ghost.httpStatus).toBe(known.httpStatus);
    expect(ghost.message).toBe(known.message);
  });

  it("the failure counter is ATOMIC: concurrent wrong passwords each count", async () => {
    const N = 5;
    const base = makeTestAuthDeps({ maxFailures: N });
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        hash: (p) => base.passwordHasher.hash(p),
        // Hold every verify until all N have finished, so the N `throttleFailure`
        // calls genuinely run concurrently. Without the barrier scrypt's thread-pool
        // scheduling staggers them and the race — which a real multi-connection server
        // hits constantly — simply does not reproduce.
        verify: async (p, s) => {
          const ok = await base.passwordHasher.verify(p, s);
          if (++arrived === N) release();
          await barrier;
          return ok;
        },
      },
    };
    const h = await harness(deps);
    const user = await register(h, "race@x.example");     // uses hash(), never verify()

    // Read-modify-write: all N awaited their SELECT before any write, so all N wrote
    // `1` — arbitrarily many guesses per recorded failure — and the racing INSERTs on
    // an absent row hit the unique constraint and surfaced as 500s, not 401s.
    const results = await Promise.all(
      Array.from({ length: N }, () => h.svc.login(h.ctxFor(), { email: "race@x.example", password: "WRONG" }).catch((e) => e)),
    );
    for (const r of results) {
      expect(r).toBeInstanceOf(ServiceError);
      expect((r as ServiceError).code).toBe("credential_refused");
    }

    // The password's counter is the (address, client) bucket (`throttle-keys.ts`); `user:` is the
    // second factor's and a password failure never touches it.
    const k = throttleKeysFor(h.deps.keyProvider);
    const pwKey = `pw:${k.address("race@x.example")}:${k.client("1.2.3.4")}`;
    void user;
    const row = (await h.db.select().from(authThrottle).where(eq(authThrottle.key, pwKey)).limit(1))[0]!;
    expect(row.failures).toBe(N);
    expect(row.lockedUntil).not.toBeNull();
    await expect(h.svc.login(h.ctxFor(), { email: "race@x.example", password: "pw-correct-horse-password-password" }))
      .rejects.toMatchObject({ code: "account_locked", httpStatus: 423 });
  });

  it("the failure window still rolls: an expired window restarts the count at 1", async () => {
    const h = await harness(makeTestAuthDeps({ maxFailures: 3 }));
    const user = await register(h, "roll@x.example");
    for (let i = 0; i < 2; i++) {
      await h.svc.login(h.ctxFor(), { email: "roll@x.example", password: "WRONG" }).catch(() => {});
    }
    // The window roll is evaluated server-side now; it must still behave.
    await new Promise((r) => setTimeout(r, 5));
    const k = throttleKeysFor(h.deps.keyProvider);
    const key = `pw:${k.address("roll@x.example")}:${k.client("1.2.3.4")}`;
    void user;
    await h.db.update(authThrottle)
      .set({ windowStartedAt: new Date(Date.now() - h.deps.config.failureWindowMs - 60_000) })
      .where(eq(authThrottle.key, key));
    await h.svc.login(h.ctxFor(), { email: "roll@x.example", password: "WRONG" }).catch(() => {});
    const row = (await h.db.select().from(authThrottle).where(eq(authThrottle.key, key)).limit(1))[0]!;
    expect(row.failures).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });

  it("registration is rate-limited: one leaked invite code cannot mint unlimited accounts", async () => {
    const h = await harness(makeTestAuthDeps({ maxRegistrationsPerWindow: 2 }));
    await h.svc.register(h.ctxFor(), { ...REG, email: "r1@x.example" });
    await h.svc.register(h.ctxFor(), { ...REG, email: "r2@x.example" });

    // `inviteCodes` is a reusable `Set.has`, not a consumable invite row, so THIS is
    // what bounds account creation — and it puts the 201-vs-409 email oracle behind
    // the same gate.
    //
    // CHANGED THE REFUSAL, AND THE OLD ONE WAS FALSE. This used to assert
    // `account_locked` / 423 "too many failed attempts", which on a registration endpoint
    // names an account that does not exist yet and failures that did not happen — the
    // caller's third SUCCESSFUL signup trips it exactly as a third typo would. It is a slot
    // claim now (`ip-throttle.ts`) and answers 429 `rate_limited`. The assertion is not
    // weakened: it still requires the third attempt to be refused, still requires a
    // REPEATED address to be refused by the limiter rather than by the email check (i.e.
    // the counter is consulted before any per-address logic), and now also pins the status
    // so a future edit cannot quietly go back to a lockout.
    await expect(h.svc.register(h.ctxFor(), { ...REG, email: "r3@x.example" }))
      .rejects.toMatchObject({ code: "rate_limited", httpStatus: 429 });
    await expect(h.svc.register(h.ctxFor(), { ...REG, email: "r1@x.example" }))
      .rejects.toMatchObject({ code: "rate_limited", httpStatus: 429 });

    // And it is the REGISTRATION namespace only: a login lockout must not have been armed
    // as a side effect. `account_locked` on the login path is a different primitive with a
    // different key, and the two sharing `auth_throttle` must not mean they share a bucket.
    await expect(h.svc.login(h.ctxFor(), { email: "r1@x.example", password: REG.password }))
      .resolves.toMatchObject({ status: "enrollment" });
  });

  it("the registration window ROLLS: a spent bucket frees up, it does not lock out", async () => {
    // The lockout counter this replaced stayed tripped for `lockoutMs` regardless of the
    // window, so a legitimate visitor behind a busy NAT was locked out for a quarter of an
    // hour after somebody else's signups. A slot claim frees the moment the window rolls.
    const h = await harness(makeTestAuthDeps({ maxRegistrationsPerWindow: 1 }));
    await h.svc.register(h.ctxFor(), { ...REG, email: "w1@x.example" });
    await expect(h.svc.register(h.ctxFor(), { ...REG, email: "w2@x.example" }))
      .rejects.toMatchObject({ code: "rate_limited", httpStatus: 429 });

    // Move the CLOCK past the window rather than back-dating the row: the slot claim reads
    // `ctx.now()`, so this exercises the roll the way production reaches it.
    h.clock.advance(h.deps.config.failureWindowMs + 60_000);
    await expect(h.svc.register(h.ctxFor(), { ...REG, email: "w3@x.example" }))
      .resolves.toMatchObject({ status: "enrollment" });
    // …and the counter restarted rather than accumulating.
    const [row] = await h.db.select().from(authThrottle)
      .where(like(authThrottle.key, "register:ip:%")).limit(1);
    expect(row!.failures).toBe(1);
  });

  it("the unknown-email decoy hash is computed once per hasher, not once per service", async () => {
    let hashes = 0;
    const base = makeTestAuthDeps();
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        hash: (p) => { hashes++; return base.passwordHasher.hash(p); },
        verify: (p, s) => base.passwordHasher.verify(p, s),
      },
    };
    const h = await harness(deps);
    expect(hashes).toBe(1);                      // warmed once, off the constructor

    // `apps/web` builds a fresh AuthService PER REQUEST. With a per-instance lazy
    // decoy, every unknown-email login paid hash()+verify() while a known email paid
    // verify() only — a systematic ~2× timing oracle in the code path whose comment
    // promises constant time.
    for (const svc of [h.svc, new AuthService(deps), new AuthService(deps)]) {
      await svc.login(h.ctxFor(), { email: "ghost@x.example", password: "nope" }).catch(() => {});
    }
    expect(hashes).toBe(1);
  });
});

describe("AuthService — WebAuthn (primary 2FA)", () => {
  it("register + assert establishes a session and marks webauthn enrolled", async () => {
    const h = await harness();
    const user = await register(h);
    const auth = await enrollWebauthn(h, user);

    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const { options } = await h.svc.webauthnAssertOptions(h.ctxFor(), { loginToken: ch.loginToken });
    const assertion = auth.assert({ rpID: RPID, challenge: (options as any).challenge, origin: ORIGIN });
    const est = await h.svc.webauthnAssertVerify(h.ctxFor(), { loginToken: ch.loginToken, credential: assertion }) as SessionEstablished;

    expect(est.status).toBe("authenticated");
    expect(est.tokens?.accessToken).toBeTruthy();
    expect(est.tokens?.refreshToken).toBeTruthy();
    expect(est.user.twofaEnrolled.webauthn).toBe(true);
  });

  it("signature-counter regression (clone) is rejected", async () => {
    const h = await harness();
    const user = await register(h);
    const auth = await enrollWebauthn(h, user);

    // First assertion succeeds and advances the stored counter to 1.
    const ch1 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const o1 = await h.svc.webauthnAssertOptions(h.ctxFor(), { loginToken: ch1.loginToken });
    const a1 = auth.assert({ rpID: RPID, challenge: (o1.options as any).challenge, origin: ORIGIN }); // counter → 1
    await h.svc.webauthnAssertVerify(h.ctxFor(), { loginToken: ch1.loginToken, credential: a1 });

    // A cloned authenticator replays a LOWER counter → must be rejected.
    const ch2 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const o2 = await h.svc.webauthnAssertOptions(h.ctxFor(), { loginToken: ch2.loginToken });
    const clone = auth.assert({ rpID: RPID, challenge: (o2.options as any).challenge, origin: ORIGIN, counter: 0 });
    await expect(h.svc.webauthnAssertVerify(h.ctxFor(), { loginToken: ch2.loginToken, credential: clone }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
  });

  it("a WebAuthn challenge is single-use (cannot be replayed)", async () => {
    const h = await harness();
    const user = await register(h);
    const auth = await enrollWebauthn(h, user);
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const { options } = await h.svc.webauthnAssertOptions(h.ctxFor(), { loginToken: ch.loginToken });
    const assertion = auth.assert({ rpID: RPID, challenge: (options as any).challenge, origin: ORIGIN });
    await h.svc.webauthnAssertVerify(h.ctxFor(), { loginToken: ch.loginToken, credential: assertion });
    // The loginToken is now consumed → a second verify with the same material fails.
    await expect(h.svc.webauthnAssertVerify(h.ctxFor(), { loginToken: ch.loginToken, credential: assertion }))
      .rejects.toBeInstanceOf(ServiceError);
  });
});

describe("AuthService — TOTP (fallback 2FA)", () => {
  it("enroll → activate → verify establishes a session; secret is stored encrypted", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);

    // Secret at rest is envelope-encrypted, not the base32 plaintext.
    const row = (await h.db.select().from(totpSecrets).where(eq(totpSecrets.userId, user.userId)).limit(1))[0]!;
    expect(row.secretEnc).not.toContain(secret);
    expect(row.keyVersion).toBe(1);

    h.clock.advance(30_000); // move to a fresh step so activation's consumed step is behind us
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    const est = await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });
    expect(est.status).toBe("authenticated");
    expect(est.user.twofaEnrolled.totp).toBe(true);
  });

  it("intra-window replay: the same code at the same timestep cannot be used twice", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);

    h.clock.advance(60_000); // fresh step, unrelated to activation
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });

    const ch1 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const est = await h.svc.totpVerify(h.ctxFor(), { loginToken: ch1.loginToken, code });
    expect(est.status).toBe("authenticated");

    // Same code, same 30s window, brand-new login token → replay rejected.
    const ch2 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    await expect(h.svc.totpVerify(h.ctxFor(), { loginToken: ch2.loginToken, code }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });

    // A fresh code in the NEXT window works again.
    h.clock.advance(30_000);
    const ch3 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const next = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    const est3 = await h.svc.totpVerify(h.ctxFor(), { loginToken: ch3.loginToken, code: next });
    expect(est3.status).toBe("authenticated");
  });
});

/**
 * Replacing an ACTIVE authenticator. Enrolling over one used to delete only a
 * never-activated row and insert, and `unique(user_id)` answered 23505. The replacement is a
 * pending trio on the same row: the authenticator in use keeps working until a code from the new
 * one is confirmed, and only that code promotes it. Every arm starts from a user who activated
 * through `totpActivate` and signed in once, so `last_consumed_step` is set before the enrol.
 */
describe("AuthService — replace authenticator", () => {
  const codeOf = (h: Harness, secret: string): string =>
    generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
  const totpRow = async (h: Harness, userId: string) =>
    (await h.db.select().from(totpSecrets).where(eq(totpSecrets.userId, userId)))[0];
  const stepOf = (h: Harness): bigint => BigInt(Math.floor(h.clock.now().getTime() / 30_000));

  async function signInWith(h: Harness, secret: string): Promise<SessionEstablished> {
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    if (ch.status !== "twofa_required") throw new Error("unreachable");
    return h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code: codeOf(h, secret) });
  }

  async function activatedUser(h: Harness) {
    const user = await register(h);
    const oldSecret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    const est = await signInWith(h, oldSecret);
    const resolved = await resolveSession(h.db, est.tokens!.accessToken, h.clock.now());
    const ctx = sessionCtx(h, user, resolved!.sessionId);
    const live = (await totpRow(h, user.userId))!;
    expect(live.activated).toBe(true);
    expect(live.lastConsumedStep).not.toBeNull();
    h.clock.advance(30_000);
    return { user, oldSecret, ctx, live };
  }

  it("enrolling over an active authenticator answers a secret and writes the pending trio only", async () => {
    const h = await harness();
    const { user, ctx, live } = await activatedUser(h);
    const out = await h.svc.totpEnroll(ctx);
    expect(out.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(out.otpauthUrl).toContain(out.secret);

    const rows = await h.db.select().from(totpSecrets).where(eq(totpSecrets.userId, user.userId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.secretEnc).toBe(live.secretEnc);
    expect(row.keyVersion).toBe(live.keyVersion);
    expect(row.activated).toBe(true);
    expect(row.lastConsumedStep).toBe(live.lastConsumedStep);
    // All three set (the CHECK refuses a half-set trio on Postgres only).
    expect(typeof row.pendingSecretEnc).toBe("string");
    expect(row.pendingSecretEnc).not.toContain(out.secret);
    expect(row.pendingKeyVersion).toBe(1);
    expect(row.pendingStartedAt).toEqual(h.clock.now());
  });

  it("during the pending the old code passes step-up and sign-in, the pending code fails both", async () => {
    const h = await harness();
    const { oldSecret, ctx } = await activatedUser(h);
    const { secret: next } = await h.svc.totpEnroll(ctx);
    h.clock.advance(30_000);

    await expect(h.svc.stepUpTotp(ctx, { code: codeOf(h, next) }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
    await expect(signInWith(h, next)).rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });

    await expect(h.svc.stepUpTotp(ctx, { code: codeOf(h, oldSecret) })).resolves.toEqual({ ok: true });
    h.clock.advance(30_000);
    await expect(signInWith(h, oldSecret)).resolves.toMatchObject({ status: "authenticated" });
  });

  it("activating with the pending code promotes it; then the old code fails and the new one passes", async () => {
    const h = await harness();
    const { user, oldSecret, ctx, live } = await activatedUser(h);
    const { secret: next } = await h.svc.totpEnroll(ctx);
    const pendingEnc = (await totpRow(h, user.userId))!.pendingSecretEnc;
    h.clock.advance(30_000);

    const out = await h.svc.totpActivate(ctx, { code: codeOf(h, next) });
    expect(out.twofaEnrolled.totp).toBe(true);
    expect(out.session).toBeUndefined();
    const row = (await totpRow(h, user.userId))!;
    expect(row.secretEnc).toBe(pendingEnc);
    expect(row.secretEnc).not.toBe(live.secretEnc);
    expect([row.pendingSecretEnc, row.pendingKeyVersion, row.pendingStartedAt]).toEqual([null, null, null]);
    expect(row.lastConsumedStep).toBe(stepOf(h));
    // The step the promote spent is spent: the same code at once is a replay.
    await expect(h.svc.stepUpTotp(ctx, { code: codeOf(h, next) })).rejects.toMatchObject({ httpStatus: 401 });

    h.clock.advance(30_000);
    await expect(h.svc.stepUpTotp(ctx, { code: codeOf(h, oldSecret) })).rejects.toMatchObject({ httpStatus: 401 });
    await expect(h.svc.stepUpTotp(ctx, { code: codeOf(h, next) })).resolves.toEqual({ ok: true });
    h.clock.advance(30_000);
    await expect(signInWith(h, oldSecret)).rejects.toMatchObject({ httpStatus: 401 });
    await expect(signInWith(h, next)).resolves.toMatchObject({ status: "authenticated" });
  });

  it("a code from the OLD authenticator at activation is refused and the row does not move", async () => {
    const h = await harness();
    const { user, oldSecret, ctx, live } = await activatedUser(h);
    await h.svc.totpEnroll(ctx);
    const before = (await totpRow(h, user.userId))!;
    h.clock.advance(30_000);

    await expect(h.svc.totpActivate(ctx, { code: codeOf(h, oldSecret) }))
      .rejects.toMatchObject({ code: "unprocessable", httpStatus: 422 });
    const after = (await totpRow(h, user.userId))!;
    expect(after).toEqual(before);
    expect(after.secretEnc).toBe(live.secretEnc);
  });

  it("a pending older than the TTL is refused; at the TTL exactly it still promotes", async () => {
    const ttl = makeTestAuthDeps().config.totpPendingTtlMs;
    const stale = await harness();
    const s = await activatedUser(stale);
    const { secret: staleNext } = await stale.svc.totpEnroll(s.ctx);
    stale.clock.advance(ttl + 30_000);
    await expect(stale.svc.totpActivate(await stepUppedCtx(stale, s.user), { code: codeOf(stale, staleNext) }))
      .rejects.toMatchObject({ httpStatus: 422, message: "no TOTP enrollment in progress" });
    expect((await totpRow(stale, s.user.userId))!.secretEnc).toBe(s.live.secretEnc);

    const edge = await harness();
    const e = await activatedUser(edge);
    const { secret: edgeNext } = await edge.svc.totpEnroll(e.ctx);
    edge.clock.advance(ttl);
    await expect(edge.svc.totpActivate(await stepUppedCtx(edge, e.user), { code: codeOf(edge, edgeNext) }))
      .resolves.toMatchObject({ twofaEnrolled: { totp: true } });
    expect((await totpRow(edge, e.user.userId))!.secretEnc).not.toBe(e.live.secretEnc);
  });

  it("a second enrol supersedes the first: the first pending's code no longer promotes", async () => {
    const h = await harness();
    const { user, ctx, live } = await activatedUser(h);
    const { secret: first } = await h.svc.totpEnroll(ctx);
    const { secret: second } = await h.svc.totpEnroll(ctx);
    const secondEnc = (await totpRow(h, user.userId))!.pendingSecretEnc;
    h.clock.advance(30_000);

    await expect(h.svc.totpActivate(ctx, { code: codeOf(h, first) })).rejects.toMatchObject({ httpStatus: 422 });
    expect((await totpRow(h, user.userId))!.secretEnc).toBe(live.secretEnc);
    await h.svc.totpActivate(ctx, { code: codeOf(h, second) });
    expect((await totpRow(h, user.userId))!.secretEnc).toBe(secondEnc);
  });

  it("removing the authenticator removes the pending trio with it", async () => {
    const h = await harness();
    const { user, ctx } = await activatedUser(h);
    await enrollWebauthn(h, user);
    await h.svc.totpEnroll(ctx);
    expect((await totpRow(h, user.userId))!.pendingSecretEnc).not.toBeNull();

    await h.svc.totpRemove(ctx);
    expect(await totpRow(h, user.userId)).toBeUndefined();
    expect((await h.svc.getSession(ctx)).user.twofaEnrolled.totp).toBe(false);
    // The next enrol is a first enrolment again: an unactivated row, no trio.
    await h.svc.totpEnroll(ctx);
    const row = (await totpRow(h, user.userId))!;
    expect([row.activated, row.pendingSecretEnc]).toEqual([false, null]);
  });

  it("an enrollment-scoped session cannot promote a replacement", async () => {
    const h = await harness();
    const { user, ctx } = await activatedUser(h);
    const { secret: next } = await h.svc.totpEnroll(ctx);
    const before = (await totpRow(h, user.userId))!;
    const token = await seedEnrollmentSession(h, user);
    const resolved = await resolveSession(h.db, token, h.clock.now());
    expect(resolved!.scope).toBe("enrollment");
    h.clock.advance(30_000);

    await expect(h.svc.totpActivate(sessionCtx(h, user, resolved!.sessionId), { code: codeOf(h, next) }))
      .rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
    expect(await totpRow(h, user.userId)).toEqual(before);
  });

  it("twofaEnrolled.totp reads true at every step of a replacement", async () => {
    const h = await harness();
    const { oldSecret, ctx } = await activatedUser(h);
    const totpOn = async () => (await h.svc.getSession(ctx)).user.twofaEnrolled.totp;
    expect(await totpOn()).toBe(true);
    await h.svc.totpEnroll(ctx);
    expect(await totpOn()).toBe(true);
    const { secret: next } = await h.svc.totpEnroll(ctx);
    expect(await totpOn()).toBe(true);
    h.clock.advance(30_000);
    await h.svc.totpActivate(ctx, { code: codeOf(h, oldSecret) }).catch(() => undefined);
    expect(await totpOn()).toBe(true);
    const out = await h.svc.totpActivate(ctx, { code: codeOf(h, next) });
    expect(out.twofaEnrolled.totp).toBe(true);
    expect(await totpOn()).toBe(true);
  });

  it("a pending TTL that is not a positive finite number is refused at construction", () => {
    const base = makeTestAuthDeps();
    expect(base.config.totpPendingTtlMs).toBe(15 * 60_000);
    expect(() => new AuthService(base)).not.toThrow();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, undefined]) {
      const config = { ...base.config, totpPendingTtlMs: bad } as unknown as AuthDeps["config"];
      expect(() => new AuthService({ ...base, config }), String(bad)).toThrow(/totpPendingTtlMs/);
    }
  });
});

describe("AuthService — sessions & refresh reuse", () => {
  /** Establish a full session and return its first refresh token. */
  async function establishRefresh(h: Harness): Promise<string> {
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    const est = await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });
    return est.tokens!.refreshToken;
  }

  /** The cookie surface opts into the concurrent-rotation grace; native/bearer stays strict. */
  const GRACE = { concurrentGrace: true } as const;

  it("refresh reuse revokes the whole family — a token replayed AFTER the grace window", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);

    const rot = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    const r2 = rot.tokens!.refreshToken;
    expect(r2).toBeTruthy();
    expect(r2).not.toEqual(r1);
    // The rotated token is USED — the real client carried on. This is what separates theft from
    // the lost-response client: a replay of r1 now proves a second holder, because the first
    // one demonstrably rotated past it and kept going. (A wholly-dormant tail instead takes the
    // recovery path — its own tests below.)
    const rot2 = await h.svc.refresh(h.ctxFor(), { refreshToken: r2 }, GRACE);
    const r3 = rot2.tokens!.refreshToken;

    // The grace window keys the distinction on time-since-consumed, so step CLEAR of it before
    // the replay: this is what a stolen token looks like, and it must still burn the family
    // EVEN on the grace-enabled cookie surface.
    h.clock.advance(h.deps.config.refreshReuseGraceMs + 1_000);

    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    // r3 (same family) is now dead too.
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r3 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
  });

  it("the reuse sweep LEAVES AN AUDIT ROW — who, when, which family, what triggered it", async () => {
    // The Aug-21 incident's missing record: the sweep revoked a working desktop's family and
    // the only evidence was raw session rows correlated by revoked_at after the fact. The
    // rotation's reuse branch now writes `refresh_reuse_revoked` with the family and session
    // ids in the detail slot, and this is the row the `session_reuse_revoked` alert and the
    // admin account view read.
    const h = await harness();
    const r1 = await establishRefresh(h);
    const rot = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    expect(rot.tokens).toBeTruthy();
    // Consume the rotated token so the tail is USED — the theft reading, not the dormant
    // lost-response one the recovery path re-admits.
    await h.svc.refresh(h.ctxFor(), { refreshToken: rot.tokens!.refreshToken }, GRACE);
    h.clock.advance(h.deps.config.refreshReuseGraceMs + 1_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked" });

    const rows = await h.db.select().from(authEvents)
      .where(eq(authEvents.event, "refresh_reuse_revoked"));
    expect(rows, "the sweep must leave exactly one record of itself").toHaveLength(1);
    // The FULL session, not the register-time enrollment one — pick it by its family, which
    // is the family the refresh rotation ran on (every refresh_tokens row carries it).
    const fam = await h.db.select().from(refreshTokens);
    const familyId = fam[0]!.familyId;
    const [sess] = await h.db.select().from(sessions).where(eq(sessions.familyId, familyId));
    expect(rows[0]!.accountId, "who — the account").toBe(sess!.accountId);
    expect(rows[0]!.userId, "who — the user").toBe(sess!.userId);
    expect(rows[0]!.device, "which family").toContain(`family=${familyId}`);
    expect(rows[0]!.device, "which session").toContain(`session=${sess!.id}`);
    // …and the family really is swept, in the same call that wrote the row.
    expect(fam.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("a failed audit record NEVER vetoes the sweep — the family dies either way", async () => {
    // Both failure directions were reviewed (see the branch's comment): sequential autocommit
    // loses the record permanently; a bare transaction rolls the SWEEP back — and on the
    // cookie surface the handler then clears the jar, so the consumed token is never
    // re-presented while a separately held descendant keeps the compromised family ALIVE.
    // The shipped shape is transaction-then-fallback: bookkeeping failure costs the record,
    // never the revocation.
    class AuditFailsOnReuse extends AuthService {
      protected override async audit(
        ...args: Parameters<AuthService["audit"]>
      ): Promise<void> {
        if (args[2] === "refresh_reuse_revoked") throw new Error("audit sink down");
        return super.audit(...args);
      }
    }
    const db = await makeTestDb();
    const clock = new Clock();
    const svc = new AuditFailsOnReuse(makeTestAuthDeps());
    const h: Harness = {
      db, svc, deps: makeTestAuthDeps(), clock,
      ctxFor: (over: Partial<ServiceContext> = {}): ServiceContext => ({
        db, accountId: "", userId: null, now: clock.now, requestId: "r", ip: "1.2.3.4", ...over,
      }),
    } as Harness;
    const r1 = await establishRefresh(h);
    const rot = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    // A USED tail — the theft reading; a dormant one would take the recovery path instead.
    await h.svc.refresh(h.ctxFor(), { refreshToken: rot.tokens!.refreshToken }, GRACE);
    h.clock.advance(h.deps.config.refreshReuseGraceMs + 1_000);

    // The reuse presentation: the audit write dies inside the transaction; the fallback
    // redoes the sweep alone and the caller still gets the ordinary reuse 401.
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked" });
    const fam = await h.db.select().from(refreshTokens);
    expect(fam.every((row) => row.revokedAt !== null),
      "a bookkeeping fault must never leave a compromised family alive").toBe(true);
    // The record is the documented cost of that asymmetric failure — lost, not half-written.
    expect(await h.db.select().from(authEvents)
      .where(eq(authEvents.event, "refresh_reuse_revoked"))).toHaveLength(0);
  });

  it("a GRACE re-rotation writes NO reuse row — a benign multi-tab race is not an incident", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    h.clock.advance(2_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE)).resolves.toBeTruthy();
    const rows = await h.db.select().from(authEvents)
      .where(eq(authEvents.event, "refresh_reuse_revoked"));
    expect(rows, "the grace path revokes nothing and must record nothing").toHaveLength(0);
  });

  it("reuse on a STRICT (native/bearer) surface revokes immediately — grace is cookie-only", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);

    // No grace flag: this is the native body / OAuth grant surface, which holds its token
    // privately and rotates serially. An immediate re-presentation of a consumed token is theft
    // here, full stop — the multi-tab race does not exist without a shared cookie jar.
    const rot = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 });
    const r2 = rot.tokens!.refreshToken;
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r2 }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
  });

  it("a re-presentation WITHIN the grace window re-rotates instead of revoking (multi-tab)", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);

    // Tab A wins the rotation: r1 → r2.
    const rotA = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    const r2 = rotA.tokens!.refreshToken;

    // Tab B raced with A and still held r1 (the shared cookie jar had not yet taken A's new
    // cookie). It arrives well inside the window. Against the pre-fix code this threw 401 and
    // revoked the family — the sign-out this whole slice is about. Now it re-rotates.
    h.clock.advance(2_000);
    const rotB = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    expect(rotB.tokens!.refreshToken).toBeTruthy();
    expect(rotB.tokens!.refreshToken).not.toEqual(r1);
    expect(rotB.tokens!.refreshToken).not.toEqual(r2);

    // The family is ALIVE: the winner's own token still rotates, and so does the grace-loser's.
    // Nothing was revoked, so no session was signed out.
    h.clock.advance(2_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r2 }, GRACE)).resolves.toBeTruthy();
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: rotB.tokens!.refreshToken }, GRACE))
      .resolves.toBeTruthy();

    const fam = await h.db.select().from(refreshTokens);
    expect(fam.every((row) => row.revokedAt === null)).toBe(true);
  });

  it("the grace window does NOT resurrect an already-revoked family", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);

    const rot = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    const r2 = rot.tokens!.refreshToken;

    // Sign out — this revokes the whole family, still well inside the grace window of r1's
    // consumption. A revoked token must fail closed: `revokedAt` is set on r1's row, so the
    // presentation never reaches the grace branch at all. The latest session row is the one the
    // 2FA login established, which is r1's family.
    const sessRow = (await h.db.select().from(sessions).orderBy(desc(sessions.createdAt)).limit(1))[0]!;
    await h.svc.logout(h.ctxFor({ userId: sessRow.userId, accountId: sessRow.accountId, sessionId: sessRow.id }));

    h.clock.advance(1_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r2 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const fam = await h.db.select().from(refreshTokens);
    expect(fam.every((row) => row.revokedAt !== null)).toBe(true);
  });

  // ── The LOST-RESPONSE RECOVERY (`recoverLostRotation`) ──────────────────────────────────────
  //
  // The shape a browser leaves when a rotation committed server-side and the response never
  // landed (lid closed mid-refresh): the jar re-presents a token consumed minutes-to-hours ago,
  // and the family's tail — the token that response carried — was NEVER used by anyone.
  // Measured on a live account (re-presented many minutes after consumption,
  // successor never consumed → family burned, owner signed out every morning). No grace width
  // fixes that; the USE discriminator does.

  it("a stale re-presentation with a NEVER-USED tail recovers instead of revoking (lost response)", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);

    // The rotation whose response the browser lost: r2 exists server-side, nobody holds it.
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);

    // Half an hour later — far outside the grace window — the jar still presents r1.
    h.clock.advance(30 * 60_000);
    const rec = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    expect(rec.tokens!.refreshToken).toBeTruthy();
    expect(rec.tokens!.refreshToken).not.toEqual(r1);

    // Nothing was revoked, and the recovered token is a working credential.
    const fam = await h.db.select().from(refreshTokens);
    expect(fam.every((row) => row.revokedAt === null), "recovery revokes nothing").toBe(true);
    h.clock.advance(61_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: rec.tokens!.refreshToken }, GRACE))
      .resolves.toBeTruthy();

    // EXACTLY ONE LIVE TIP after the recovery chain: the dormant tail was consumed in the claim.
    const live = (await h.db.select().from(refreshTokens))
      .filter((row) => row.consumedAt === null && row.revokedAt === null);
    // (establishRefresh's enrollment exchange holds a second family; scope to the recovered one.)
    const familyId = fam.find((row) => hashToken(r1) === row.tokenHash)!.familyId;
    expect(live.filter((row) => row.familyId === familyId)).toHaveLength(1);

    // The re-admission is AUDITED, with the reuse row's exact detail convention — and it is
    // recorded as recovery, never as a reuse sweep.
    const rows = await h.db.select().from(authEvents);
    const recovered = rows.filter((r) => r.event === "refresh_recovered");
    expect(recovered, "one recovery, one row").toHaveLength(1);
    expect(recovered[0]!.device).toContain(`family=${familyId}`);
    expect(rows.filter((r) => r.event === "refresh_reuse_revoked")).toHaveLength(0);
  });

  it("recovery is IDLE-BOUND: inside a full access window a dormant tail is a healthy session, not a lost response", async () => {
    // The first review finding: an unconsumed successor is the NORMAL state between two
    // rotations — an awake client sits on its fresh token until the access token expires. A
    // thief replaying the just-rotated-past token during that window must take the sweep, not
    // a recovery: only after `accessTtlMs` of silence (an awake client is forced to rotate by
    // then) does "nothing was spent" mean "nobody is there".
    const h = await harness();
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);

    // Past the grace window, inside the access window: the replay-during-idle attack shape.
    h.clock.advance(5 * 60_000);   // grace is 60 s; accessTtl is 15 min
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const fam = await h.db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(r1)));
    expect(fam[0]!.revokedAt, "the family burned — loud, exactly the pre-recovery answer").not.toBeNull();
  });

  it("an ANCIENT token cannot ride a live rotation's grace — adjacency is on the OLDEST spend", async () => {
    // A second review finding: a live client rotates every access window, so "within 60 s of some
    // rotation" recurs for ever — an attacker replaying an ancient token would only need to
    // retry until they land inside one. The racer classification therefore keys on the OLDEST
    // spend after the presented token: one stale spend proves the chain continued in real
    // use, and no freshness of the LATEST rotation may override it.
    const h = await harness();
    const r1 = await establishRefresh(h);
    const rot1 = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    h.clock.advance(2_000);
    const rot2 = await h.svc.refresh(h.ctxFor(), { refreshToken: rot1.tokens!.refreshToken }, GRACE);

    // Much later, the (still live) client rotates again — a FRESH spend exists…
    h.clock.advance(30 * 60_000);
    await h.svc.refresh(h.ctxFor(), { refreshToken: rot2.tokens!.refreshToken }, GRACE);
    // …and the ancient r1, replayed 2 s after it, must still take the sweep.
    h.clock.advance(2_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const fam = await h.db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(r1)));
    expect(fam[0]!.revokedAt, "the family burned — the ancient replay was theft").not.toBeNull();
  });

  it("recovery is refused the moment the tail was USED — the theft reading stands", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);
    const rot = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    // The tail is spent: whoever holds the chain moved past r1 and KEPT GOING.
    await h.svc.refresh(h.ctxFor(), { refreshToken: rot.tokens!.refreshToken }, GRACE);

    h.clock.advance(30 * 60_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const fam = await h.db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(r1)));
    expect(fam[0]!.revokedAt, "the family burned").not.toBeNull();
  });

  it("recovery is single-use per presented token — a second stale replay of it burns the family", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);

    h.clock.advance(30 * 60_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE)).resolves.toBeTruthy();

    // The recovery consumed the dormant tail, so r1 is no longer the newest-consumed token:
    // a THIRD presentation finds a consumption after its own and takes the sweep.
    h.clock.advance(30 * 60_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const fam = await h.db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(r1)));
    expect(fam[0]!.revokedAt).not.toBeNull();
  });

  it("recovery is COOKIE-ONLY — the strict (native/bearer) surface still revokes a dormant-tail replay", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 });   // native: no grace flag

    h.clock.advance(30 * 60_000);
    // Same dormant-tail shape, strict surface: a bearer client rotates serially and holds its
    // token privately, so a stale re-presentation is theft there, full stop.
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const fam = await h.db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(r1)));
    expect(fam[0]!.revokedAt).not.toBeNull();
  });

  it("a once-recovered token cannot re-enter by timing its replay near a healthy rotation", async () => {
    // A later review finding: with the fresh-spend evidence read FIRST, a family that had
    // already recovered past token A would re-admit A whenever its replay landed within the
    // grace of a legitimate rotation on the recovered line — the round-2 ancient-token hole,
    // re-opened through the other evidence set. Any OLD evidence must dominate.
    const h = await harness();
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);       // lost
    h.clock.advance(30 * 60_000);
    const rec = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);   // recovery — its mint is now OLD evidence
    const m = rec.tokens!.refreshToken;

    h.clock.advance(30 * 60_000);
    await h.svc.refresh(h.ctxFor(), { refreshToken: m }, GRACE);        // a healthy rotation, just now
    h.clock.advance(2_000);                                             // replay A inside ITS grace
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    const fam = await h.db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(r1)));
    expect(fam[0]!.revokedAt, "the twice-replayed token burned its family").not.toBeNull();
  });

  it("a claim-killed tail presented late answers a PLAIN 401 — never the sweep", async () => {
    // The kill is not a presentation: nobody outside the server ever held the killed token in
    // a spendable state, so its late re-presentation (the double-lost jar, or a thief holding
    // a dead row) names no second holder of the family's REAL chain — and sweeping would
    // revoke the healthy line the recovery just re-established. Caught by the round-3 pg net:
    // carrying a killed tail into the next round swept a live family.
    const h = await harness();
    const r1 = await establishRefresh(h);
    const rot = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    const killedTail = rot.tokens!.refreshToken;   // about to be killed by the recovery below

    h.clock.advance(30 * 60_000);
    const rec = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);   // kills killedTail
    expect(rec.tokens!.refreshToken).toBeTruthy();

    h.clock.advance(30 * 60_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: killedTail }, GRACE))
      .rejects.toMatchObject({ code: "refresh_expired", httpStatus: 401, message: "refresh token expired" });
    // The family is NOT swept: the recovered line still rotates.
    const fam = await h.db.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(rec.tokens!.refreshToken)));
    expect(fam[0]!.revokedAt, "the healthy line survived the dead row's replay").toBeNull();
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: rec.tokens!.refreshToken }, GRACE))
      .resolves.toBeTruthy();
  });

  it("recovery works again after a full healthy cycle — kill-stamps never masquerade as spends", async () => {
    // The round-3 pg net's exact failure, pinned deterministically: a recovery's kill-stamps
    // used to read as real spends to every later classification on the family, so the SECOND
    // lost-response event on one family swept instead of recovering.
    const h = await harness();
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);   // lost
    h.clock.advance(30 * 60_000);
    const rec1 = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);   // recovery #1
    const m = rec1.tokens!.refreshToken;

    // A healthy cycle on the recovered line…
    h.clock.advance(2 * 60_000);
    await h.svc.refresh(h.ctxFor(), { refreshToken: m }, GRACE);   // …whose response is LOST too
    h.clock.advance(30 * 60_000);
    // …and the second lost-response event still recovers.
    const rec2 = await h.svc.refresh(h.ctxFor(), { refreshToken: m }, GRACE);
    expect(rec2.tokens!.refreshToken).toBeTruthy();
    const fam = await h.db.select().from(refreshTokens);
    expect(fam.every((row) => row.revokedAt === null), "nothing swept across two recoveries").toBe(true);
  });

  it("recovery never resurrects a revoked or signed-out family", async () => {
    const h = await harness();
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);

    // Sign the session out — `revokeFamily` kills tokens and session together.
    const sessRow = (await h.db.select().from(sessions).orderBy(desc(sessions.createdAt)).limit(1))[0]!;
    await h.svc.logout(h.ctxFor({ userId: sessRow.userId, accountId: sessRow.accountId, sessionId: sessRow.id }));

    h.clock.advance(30 * 60_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
  });

  // ── A FAULT IS NOT A REPLAY (`SESSION-REFRESH-RECOVERY-SWALLOWED-AS-TOKEN-REUSE`) ───────────
  //
  // `recoverLostRotation` answered `null` for EVERY thrown value, and `null` there falls through
  // to the reuse sweep: a fault anywhere inside the recovery — a driver error, a missing dialect
  // marking, a lock timeout — revoked the family and told the person their token had been
  // stolen. Measured on `lane/phone-p2c`: a database handle read from the wrong place inside the
  // block produced five tests asserting a legitimate refresh was an attack, with the real message
  // discarded. The decision is now by the thrown value's TYPE.

  it("a FAULT inside the recovery is surfaced as a fault — not as reuse, and the family lives", async () => {
    // The seam is the audit write the recovery makes inside its own transaction: a real fault in
    // the same place, with the same wrapping — it propagates out of `inTransaction` exactly as a
    // driver error does, and its rollback is the same rollback.
    let sinkDown = true;
    class RecoveryFaults extends AuthService {
      protected override async audit(
        ...args: Parameters<AuthService["audit"]>
      ): Promise<void> {
        if (sinkDown && args[2] === "refresh_recovered") throw new Error("the dialect marking is missing");
        return super.audit(...args);
      }
    }
    const db = await makeTestDb();
    const clock = new Clock();
    const h: Harness = {
      db, svc: new RecoveryFaults(makeTestAuthDeps()), deps: makeTestAuthDeps(), clock,
      ctxFor: (over: Partial<ServiceContext> = {}): ServiceContext => ({
        db, accountId: "", userId: null, now: clock.now, requestId: "r", ip: "1.2.3.4", ...over,
      }),
    } as Harness;

    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);   // the rotation whose response was lost
    h.clock.advance(30 * 60_000);                                   // the lost-response shape, recovery entered

    // Captured rather than asserted through `.rejects`, so the CLASS and the message are both
    // readable: what this used to answer was a `ServiceError` saying "refresh token reuse detected".
    const thrown: unknown = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE)
      .then(() => "resolved" as const, (e: unknown) => e);
    expect(thrown, "a faulted recovery must not resolve").not.toBe("resolved");
    expect(thrown instanceof ServiceError,
      "a fault was dressed as a session refusal").toBe(false);
    expect((thrown as Error).message,
      "the recovery's real fault was discarded and rewritten as an attack verdict")
      .toBe("the dialect marking is missing");

    // NOTHING WAS REVOKED. This is the harm: every device on the family lost its session for a blip.
    const fam = await h.db.select().from(refreshTokens);
    expect(fam.every((row) => row.revokedAt === null),
      "a fault inside the recovery burned the family").toBe(true);
    expect(await h.db.select().from(authEvents).where(eq(authEvents.event, "refresh_reuse_revoked")),
      "a reuse was recorded for a fault nobody detected as reuse").toHaveLength(0);

    // THE TOKEN WAS KEPT, so the next attempt spends it. The claim rolled back with the fault,
    // which leaves the presented token, the dormant tail and the family exactly as they were —
    // and the same presentation, with the fault gone, recovers.
    sinkDown = false;
    const back = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    expect(back.tokens!.refreshToken, "the retry within the window found nothing left to spend").toBeTruthy();
    expect(back.tokens!.refreshToken).not.toEqual(r1);
  });

  it("a 5xx ServiceError inside the recovery is a fault too — the status decides, not the class", async () => {
    // `ServiceError` is not itself the discriminator: the service raises 500s of its own, and one
    // of those inside the recovery is as much a fault as a driver error. Only a 4xx is a verdict.
    class RecoveryRefuses extends AuthService {
      protected override async audit(
        ...args: Parameters<AuthService["audit"]>
      ): Promise<void> {
        if (args[2] === "refresh_recovered") throw new ServiceError("internal", 500, "the audit sink is unreachable");
        return super.audit(...args);
      }
    }
    const db = await makeTestDb();
    const clock = new Clock();
    const h: Harness = {
      db, svc: new RecoveryRefuses(makeTestAuthDeps()), deps: makeTestAuthDeps(), clock,
      ctxFor: (over: Partial<ServiceContext> = {}): ServiceContext => ({
        db, accountId: "", userId: null, now: clock.now, requestId: "r", ip: "1.2.3.4", ...over,
      }),
    } as Harness;
    const r1 = await establishRefresh(h);
    await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE);
    h.clock.advance(30 * 60_000);

    const thrown: unknown = await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE)
      .then(() => "resolved" as const, (e: unknown) => e);
    expect((thrown as ServiceError).httpStatus, "a 500 was answered as a 401").toBe(500);
    expect((thrown as ServiceError).message).toBe("the audit sink is unreachable");
    const fam = await h.db.select().from(refreshTokens);
    expect(fam.every((row) => row.revokedAt === null), "a 5xx burned the family").toBe(true);
  });

  it("the refresh door names its refusal — missing, expired, revoked; unknown reads as revoked", async () => {
    const h = await harness();
    await expect(h.svc.refresh(h.ctxFor(), {}, GRACE))
      .rejects.toMatchObject({ code: "refresh_missing", httpStatus: 401, message: "missing refresh token" });
    const r1 = await establishRefresh(h);
    const r2 = (await h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE)).tokens!.refreshToken;
    const r3 = (await h.svc.refresh(h.ctxFor(), { refreshToken: r2 }, GRACE)).tokens!.refreshToken;
    h.clock.advance(h.deps.config.refreshReuseGraceMs + 1_000);
    await expect(h.svc.refresh(h.ctxFor(), { refreshToken: r1 }, GRACE))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401, message: "refresh token reuse detected" });
    const refusal = async (token: string) => {
      const e = await h.svc.refresh(h.ctxFor(), { refreshToken: token }, GRACE).then(() => null, (x: unknown) => x);
      return { code: (e as ServiceError).code, status: (e as ServiceError).httpStatus, message: (e as ServiceError).message };
    };
    // A token of the swept family and one that never existed answer identically.
    const swept = await refusal(r3);
    expect(swept).toEqual({ code: "refresh_revoked", status: 401, message: "invalid refresh token" });
    expect(await refusal("n".repeat(43))).toEqual(swept);
    // The idle window closing is its own name.
    const h2 = await harness();
    const idle = await establishRefresh(h2);
    h2.clock.advance(h2.deps.config.refreshTtlMs + 1_000);
    await expect(h2.svc.refresh(h2.ctxFor(), { refreshToken: idle }, GRACE))
      .rejects.toMatchObject({ code: "refresh_expired", httpStatus: 401, message: "refresh token expired" });
  });

  it("classifyRefreshFailure — the one classification both doors take", () => {
    // The door the route shares with the service. A 401 is the only thing that may clear a
    // browser's jar; a 4xx about the REQUEST leaves this browser's own session alone; everything
    // else is a fault and decides nothing.
    expect(classifyRefreshFailure(new ServiceError("unauthorized", 401, "refresh token reuse detected")))
      .toBe("session_refused");
    expect(classifyRefreshFailure(new ServiceError("unauthorized", 401, "invalid refresh token")))
      .toBe("session_refused");
    // The three names the door answers with now: keyed on the STATUS, so each still clears the jar.
    for (const code of ["refresh_missing", "refresh_expired", "refresh_revoked"]) {
      expect(classifyRefreshFailure(new ServiceError(code, 401, "refused")), code).toBe("session_refused");
    }
    expect(classifyRefreshFailure(new ServiceError("session_conflict", 409, "a credential for another account")))
      .toBe("request_refused");
    expect(classifyRefreshFailure(new ServiceError("internal", 500, "auth service not configured")))
      .toBe("fault");
    expect(classifyRefreshFailure(new Error("the pool went away"))).toBe("fault");
    expect(classifyRefreshFailure(Object.assign(new Error("acquire timed out"), { name: "DbAcquireTimeoutError" })))
      .toBe("fault");
    // A thrown primitive and a thrown nothing are faults, not verdicts.
    expect(classifyRefreshFailure("boom")).toBe("fault");
    expect(classifyRefreshFailure(undefined)).toBe("fault");
  });
});

describe("AuthService — lockout (both stages)", () => {
  it("locks out after repeated FIRST-FACTOR (password) failures", async () => {
    const h = await harness(makeTestAuthDeps({ maxFailures: 3 }));
    await register(h, "lock1@x.example");
    for (let i = 0; i < 3; i++) {
      await expect(h.svc.login(h.ctxFor(), { email: "lock1@x.example", password: "WRONG" }))
        .rejects.toMatchObject({ code: "credential_refused" });
    }
    // Even the correct password is now refused with a lockout.
    await expect(h.svc.login(h.ctxFor(), { email: "lock1@x.example", password: "pw-correct-horse-password-password" }))
      .rejects.toMatchObject({ code: "account_locked", httpStatus: 423 });
  });

  it("locks out after repeated SECOND-FACTOR (2FA) failures", async () => {
    const h = await harness(makeTestAuthDeps({ maxFailures: 3 }));
    const user = await register(h, "lock2@x.example");
    await enrollTotp(h, user);

    let lastErr: ServiceError | null = null;
    for (let i = 0; i < 3; i++) {
      const ch = await h.svc.login(h.ctxFor(), { email: "lock2@x.example", password: "pw-correct-horse-password-password" });
      lastErr = await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code: "000000" }).catch((e) => e);
    }
    expect(lastErr).toBeInstanceOf(ServiceError);
    expect(lastErr!.code).toBe("account_locked");
    expect(lastErr!.httpStatus).toBe(423);
  });

  // ── REPLAYS ARE NOT GUESSES — the lockout prices guessing, and only guessing ───────────────
  //
  // The single-use-per-timestep guard refuses the code that JUST signed someone in when they
  // type it again at the step-up sheet — with the wrong-code sentence, deliberately. Counting
  // those refusals as failed attempts locked a real account 2026-08-28: five presentations of
  // one just-consumed code inside eleven seconds (the same six digits still showing in the
  // authenticator) reached `maxFailures` and bought a fifteen-minute lockout with nothing
  // guessed by anybody. A replay is refused, audited, and NOT counted: reaching that arm at
  // all requires a code that VERIFIES against the secret, which no guesser has.

  it("a replayed (just-consumed) code never locks the account — the step-up sheet's shape", async () => {
    const h = await harness(makeTestAuthDeps({ maxFailures: 3 }));
    const user = await register(h, "replay-stepup@x.example");
    const secret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    const ch = await h.svc.login(h.ctxFor(), { email: "replay-stepup@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });

    const sid = await latestSessionId(h, user.userId);
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid });

    // The measured shape: the person re-types the code that just signed them in, five times.
    // Every one refused with the wrong-code sentence — never a 423, however many.
    for (let i = 0; i < 5; i++) {
      h.clock.advance(2_000);
      await expect(h.svc.stepUpTotp(sctx, { code }))
        .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
    }
    // maxFailures is 3 here: had these counted, the account would be locked twice over.
    const [thr] = await h.db.select().from(authThrottle)
      .where(eq(authThrottle.key, `user:${user.userId}`));
    expect(thr?.lockedUntil ?? null, "no lockout for re-typing a spent code").toBeNull();
    expect(thr?.failures ?? 0, "the reserved slots were all refunded").toBe(0);

    // …and the NEXT code works first try.
    h.clock.advance(30_000);
    const next = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await expect(h.svc.stepUpTotp(sctx, { code: next })).resolves.toEqual({ ok: true });

    // The trail keeps the truth: five 2fa_failed rows, each naming the replay — an
    // investigation reads a person re-typing a spent code, not five guesses.
    const rows = (await h.db.select().from(authEvents)
      .where(eq(authEvents.event, "2fa_failed")))
      .filter((r) => r.userId === user.userId);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.device === "single-use timestep replayed")).toBe(true);
  });

  it("a replayed code at SIGN-IN does not count toward the lockout either", async () => {
    const h = await harness(makeTestAuthDeps({ maxFailures: 3 }));
    const user = await register(h, "replay-signin@x.example");
    const secret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    const ch1 = await h.svc.login(h.ctxFor(), { email: "replay-signin@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch1.loginToken, code });

    // A second sign-in inside the same 30-second step — the desktop-then-browser shape.
    const ch2 = await h.svc.login(h.ctxFor(), { email: "replay-signin@x.example", password: "pw-correct-horse-password-password" });
    for (let i = 0; i < 3; i++) {
      h.clock.advance(1_000);
      await expect(h.svc.totpVerify(h.ctxFor(), { loginToken: ch2.loginToken, code }))
        .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
    }
    const [thr] = await h.db.select().from(authThrottle)
      .where(eq(authThrottle.key, `user:${user.userId}`));
    expect(thr?.lockedUntil ?? null).toBeNull();

    // The fresh code still signs in — nothing was spent by the replays.
    h.clock.advance(30_000);
    const next = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    const est = await h.svc.totpVerify(h.ctxFor(), { loginToken: ch2.loginToken, code: next });
    expect(est.status).toBe("authenticated");
  });

  it("WRONG codes still lock — the replay exemption does not blunt the guessing price", async () => {
    const h = await harness(makeTestAuthDeps({ maxFailures: 3 }));
    const user = await register(h, "replay-wrong@x.example");
    const secret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    const ch = await h.svc.login(h.ctxFor(), { email: "replay-wrong@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });

    const sid = await latestSessionId(h, user.userId);
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid });

    // One replay (refunded), then genuinely wrong codes: the budget is untouched by the
    // replay and spent by the guesses, so the third GUESS locks.
    await expect(h.svc.stepUpTotp(sctx, { code })).rejects.toMatchObject({ code: "credential_refused" });
    let lastErr: ServiceError | null = null;
    for (let i = 0; i < 3; i++) {
      lastErr = await h.svc.stepUpTotp(sctx, { code: "000000" }).catch((e) => e);
    }
    expect(lastErr).toBeInstanceOf(ServiceError);
    expect(lastErr!.code).toBe("account_locked");
    expect(lastErr!.httpStatus).toBe(423);
  });
});

describe("AuthService — step-up & last-factor guard", () => {
  it("step-up passes inside the 5-min window and fails outside it", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });

    const sid = await latestSessionId(h, user.userId);
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid });

    await expect(h.svc.requireStepUp(sctx)).resolves.toBeUndefined();   // within window
    h.clock.advance(6 * 60_000);                                        // > 5 min later
    await expect(h.svc.requireStepUp(sctx)).rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
  });

  it("cannot remove the last factor; can once another factor exists", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);        // TOTP is the ONLY factor
    h.clock.advance(30_000);
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });
    const sid = await latestSessionId(h, user.userId);
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid });

    await expect(h.svc.totpRemove(sctx)).rejects.toMatchObject({ code: "unprocessable", httpStatus: 422 });

    await enrollWebauthn(h, user);                    // now a second factor exists
    await expect(h.svc.totpRemove(sctx)).resolves.toBeUndefined();
    const after = await h.svc.getSession(sctx);
    expect(after.user.twofaEnrolled.totp).toBe(false);
  });

  /**
   * Removing a second factor is the gesture somebody makes when they
   * believe that factor is compromised, and it used to revoke nothing: every session the removed
   * authenticator had minted stayed live and renewable. The credential-change rule applies —
   * everywhere else is signed out, and the person doing it stays signed in where they are.
   */
  it("removing a factor signs out every OTHER session and leaves the caller's alive", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    await enrollWebauthn(h, user);                   // a second factor, so removal is permitted

    /** One full sign-in through the factor under test; returns its session id. */
    const signIn = async (): Promise<string> => {
      h.clock.advance(31_000);                       // a fresh TOTP timestep — codes are single-use
      const ch = await h.svc.login(
        h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" },
      ) as { loginToken: string };
      const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
      await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });
      return latestSessionId(h, user.userId);
    };
    const sidOther = await signIn();                 // the session the removed factor minted
    const sidCaller = await signIn();                // the one the person is removing it from
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sidCaller });

    await h.svc.totpRemove(sctx);

    const rows = await h.db.select().from(sessions).where(eq(sessions.userId, user.userId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(sidOther)!.revokedAt, "the other session survived a factor removal").not.toBeNull();
    expect(byId.get(sidCaller)!.revokedAt, "the caller was signed out of its own ceremony").toBeNull();
    // Every OTHER session, not just the one that signed in: the enrollment sessions go too.
    expect(rows.filter((r) => r.revokedAt === null).map((r) => r.id)).toEqual([sidCaller]);

    // And the revoked families cannot be rotated back to life — a live session is not the only
    // credential a compromised factor left behind.
    const live = await h.db.select().from(refreshTokens)
      .where(and(eq(refreshTokens.userId, user.userId), isNull(refreshTokens.revokedAt)));
    expect(new Set(live.map((r) => r.familyId))).toEqual(new Set([byId.get(sidCaller)!.familyId]));

    // The positive control: the caller is still signed in, and the factor is gone.
    const after = await h.svc.getSession(sctx);
    expect(after.user.twofaEnrolled.totp).toBe(false);
  });
});

/**
 * Changing the password: the current one plus a fresh second factor, the sign-up rule for the new
 * one, and the credential-change rule. Somebody told their password is known has no other way to
 * take it back, and whoever holds it keeps every session it minted unless they all go.
 */
describe("AuthService — changing the password", () => {
  const OLD = "pw-correct-horse-password-password";
  const NEW = "new-battery-staple-password";
  const WRONG = "wrong-guess-password";

  /** A full sign-in through TOTP, so the session carries a refresh family. Returns its id. */
  async function signIn(h: Harness, user: SessionUser, secret: string): Promise<string> {
    h.clock.advance(31_000); // a fresh timestep: codes are single-use
    const ch = await h.svc.login(h.ctxFor(), { email: user.email, password: OLD }) as { loginToken: string };
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });
    return latestSessionId(h, user.userId);
  }

  const storedHash = async (h: Harness, userId: string): Promise<string> =>
    (await h.db.select({ hash: credentials.passwordHash }).from(credentials).where(eq(credentials.userId, userId)))[0]!.hash;
  const throttleRows = (h: Harness) => h.db.select().from(authThrottle).orderBy(authThrottle.key);
  const passwordEvents = async (h: Harness, userId: string) =>
    (await h.db.select().from(authEvents).where(eq(authEvents.userId, userId)).orderBy(authEvents.at))
      .filter((r) => r.event.startsWith("password_"));

  it("stores the new hash, signs every other session out with its refresh family, and keeps the caller", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const sidOther = await signIn(h, user, secret);
    const sidCaller = await signIn(h, user, secret);
    const ctx = sessionCtx(h, user, sidCaller);
    const before = await storedHash(h, user.userId);
    const liveBefore = (await h.db.select().from(sessions)
      .where(and(eq(sessions.userId, user.userId), isNull(sessions.revokedAt)))).length;

    const out = await h.svc.changePassword(ctx, { currentPassword: OLD, newPassword: NEW });

    const after = await storedHash(h, user.userId);
    expect(after).not.toBe(before);
    expect(await h.deps.passwordHasher.verify(NEW, after)).toBe(true);
    expect(await h.deps.passwordHasher.verify(OLD, after)).toBe(false);

    const rows = await h.db.select().from(sessions).where(eq(sessions.userId, user.userId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(sidOther)!.revokedAt, "the other session survived the change").not.toBeNull();
    expect(rows.filter((r) => r.revokedAt === null).map((r) => r.id)).toEqual([sidCaller]);
    // The answer is the count and nothing else: no family id reaches the wire.
    expect(out).toEqual({ revoked: liveBefore - 1 });
    const live = await h.db.select().from(refreshTokens)
      .where(and(eq(refreshTokens.userId, user.userId), isNull(refreshTokens.revokedAt)));
    expect(new Set(live.map((r) => r.familyId))).toEqual(new Set([byId.get(sidCaller)!.familyId]));
    await expect(h.svc.getSession(ctx)).resolves.toMatchObject({ user: { userId: user.userId } });

    // The old password signs in nowhere; the new one reaches the second factor.
    await expect(h.svc.login(h.ctxFor(), { email: user.email, password: OLD }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
    await expect(h.svc.login(h.ctxFor(), { email: user.email, password: NEW }))
      .resolves.toMatchObject({ status: "twofa_required" });
  });

  it("audits the refusal and the change, and never a password", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const ctx = sessionCtx(h, user, await signIn(h, user, secret));

    await expect(h.svc.changePassword(ctx, { currentPassword: WRONG, newPassword: NEW }))
      .rejects.toMatchObject({ code: "credential_refused" });
    await h.svc.changePassword(ctx, { currentPassword: OLD, newPassword: NEW });

    expect((await passwordEvents(h, user.userId)).map((r) => [r.event, r.method])).toEqual([
      ["password_change_refused", "password"], ["password_changed", "password"],
    ]);
    const trail = JSON.stringify(await h.db.select().from(authEvents));
    for (const typed of [OLD, NEW, WRONG]) expect(trail).not.toContain(typed);
  });

  it("a wrong current password is refused credential_refused and changes nothing", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const sidOther = await signIn(h, user, secret);
    const sidCaller = await signIn(h, user, secret);
    const before = await storedHash(h, user.userId);

    await expect(h.svc.changePassword(sessionCtx(h, user, sidCaller), { currentPassword: WRONG, newPassword: NEW }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });

    expect(await storedHash(h, user.userId)).toBe(before);
    const live = (await h.db.select().from(sessions)
      .where(and(eq(sessions.userId, user.userId), isNull(sessions.revokedAt)))).map((r) => r.id);
    expect(live).toEqual(expect.arrayContaining([sidOther, sidCaller]));
  });

  it("five wrong tries lock this client like sign-in: the next is 423 even when right, and right works once served", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const ctx = sessionCtx(h, user, await signIn(h, user, secret));
    const k = throttleKeysFor(h.deps.keyProvider);
    const pwKey = `pw:${k.address(user.email)}:${k.client("1.2.3.4")}`;

    for (let i = 0; i < 5; i++) {
      await expect(h.svc.changePassword(ctx, { currentPassword: WRONG, newPassword: NEW }))
        .rejects.toMatchObject({ code: "credential_refused" });
    }
    // Locked by the fifth failure itself, as sign-in's fifth locks: not one attempt later.
    const [locked] = await h.db.select().from(authThrottle).where(eq(authThrottle.key, pwKey));
    expect(locked!.lockedUntil, "the fifth wrong password installed no lock").not.toBeNull();
    await expect(h.svc.changePassword(ctx, { currentPassword: OLD, newPassword: NEW }))
      .rejects.toMatchObject({ code: "account_locked", httpStatus: 423 });
    // Sign-in's own bucket: this client's sign-in is locked by the same five.
    await expect(h.svc.login(h.ctxFor(), { email: user.email, password: OLD }))
      .rejects.toMatchObject({ code: "account_locked" });

    // The lock served, as fifteen minutes would serve it.
    await h.db.update(authThrottle).set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(authThrottle.key, pwKey));
    await expect(h.svc.changePassword(ctx, { currentPassword: OLD, newPassword: NEW }))
      .resolves.toMatchObject({ revoked: expect.any(Number) });
  });

  it("a closed step-up window is refused 403 before anything is counted", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const ctx = sessionCtx(h, user, await signIn(h, user, secret));
    h.clock.advance(6 * 60_000);
    const before = await throttleRows(h);

    await expect(h.svc.changePassword(ctx, { currentPassword: WRONG, newPassword: NEW }))
      .rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });

    expect(await throttleRows(h)).toEqual(before);
    expect(await passwordEvents(h, user.userId)).toEqual([]);
  });

  it("an enrollment-scoped session cannot change the password", async () => {
    const h = await harness();
    const user = await register(h);
    const sid = await latestSessionId(h, user.userId);
    const [row] = await h.db.select({ scope: sessions.scope }).from(sessions).where(eq(sessions.id, sid));
    expect(row!.scope).toBe("enrollment");

    await expect(h.svc.changePassword(sessionCtx(h, user, sid), { currentPassword: OLD, newPassword: NEW }))
      .rejects.toMatchObject({ code: "step_up_required", httpStatus: 403 });
  });

  it("a new password under twelve characters, the same one, or an over-long current one is refused 400 before the throttle and the trail", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const ctx = sessionCtx(h, user, await signIn(h, user, secret));
    const before = await throttleRows(h);

    await expect(h.svc.changePassword(ctx, { currentPassword: OLD, newPassword: "password-1x" }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    await expect(h.svc.changePassword(ctx, { currentPassword: OLD, newPassword: OLD }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    await expect(h.svc.changePassword(ctx, { newPassword: NEW }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    // Sign-in's ceiling on a guess, before scrypt: past it nothing is hashed and nothing counted.
    await expect(h.svc.changePassword(ctx, { currentPassword: "x".repeat(257), newPassword: NEW }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });

    expect(await throttleRows(h)).toEqual(before);
    expect(await passwordEvents(h, user.userId)).toEqual([]);
  });

  it("two overlapping changes: one wins, the other is told 409, and the winner's password is stored", async () => {
    const base = makeTestAuthDeps();
    let racing = false;
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        // Both changes hold here until both have verified the current password, so both write
        // over the same old hash.
        hash: async (p) => {
          const out = await base.passwordHasher.hash(p);
          if (racing) {
            if (++arrived === 2) release();
            await barrier;
          }
          return out;
        },
        verify: (p, s) => base.passwordHasher.verify(p, s),
      },
    };
    const h = await harness(deps);
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const ctxA = sessionCtx(h, user, await signIn(h, user, secret));
    const ctxB = sessionCtx(h, user, await signIn(h, user, secret));
    const NEW_A = "new-alpha-staple-password";
    const NEW_B = "new-bravo-staple-password";

    racing = true;
    const [a, b] = await Promise.allSettled([
      h.svc.changePassword(ctxA, { currentPassword: OLD, newPassword: NEW_A }),
      h.svc.changePassword(ctxB, { currentPassword: OLD, newPassword: NEW_B }),
    ]);
    racing = false;

    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const lost = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "conflict", httpStatus: 409 });
    const winner = a.status === "fulfilled" ? NEW_A : NEW_B;
    const stored = await storedHash(h, user.userId);
    expect(await base.passwordHasher.verify(winner, stored)).toBe(true);
    expect(await base.passwordHasher.verify(winner === NEW_A ? NEW_B : NEW_A, stored)).toBe(false);
  });

  it("a revoked paired device loses its wake registration; the caller's device keeps its own", async () => {
    const h = await harness();
    const user = await register(h);
    const now = h.clock.now();
    const device = async (label: string): Promise<string> => (await h.db.insert(devices).values({
      accountId: user.accountId, userId: user.userId, kind: "mobile-android", label,
    }).returning({ id: devices.id }))[0]!.id;
    const session = async (deviceId: string, lastTwofaAt: Date | null): Promise<string> => (await h.db.insert(sessions).values({
      accountId: user.accountId, userId: user.userId, familyId: randomUUID(), deviceId, scope: "full",
      accessExpiresAt: new Date(now.getTime() + 60 * 60_000), refreshExpiresAt: new Date(now.getTime() + 120 * 60_000),
      lastTwofaAt, lastSeenAt: now,
    }).returning({ id: sessions.id }))[0]!.id;
    const wake = async (deviceId: string): Promise<string> => (await h.db.insert(pushSubscriptions).values({
      accountId: user.accountId, transport: "unifiedpush", endpoint: `https://ntfy.test/${randomUUID()}`, deviceId,
    }).returning({ id: pushSubscriptions.id }))[0]!.id;
    const mine = await device("This phone");
    const paired = await device("The other phone");
    const sidCaller = await session(mine, now);
    await session(paired, null);
    const myRow = await wake(mine);
    const pairedRow = await wake(paired);

    await h.svc.changePassword(sessionCtx(h, user, sidCaller), { currentPassword: OLD, newPassword: NEW });

    const left = (await h.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
      .where(eq(pushSubscriptions.accountId, user.accountId))).map((r) => r.id);
    expect(left).toContain(myRow);
    expect(left).not.toContain(pairedRow);
  });

  /*
   * WHAT IS STILL WAITING TO SIGN SOMEBODY IN. Whoever held the password and a factor may also hold
   * something minted before the change that signs in on its own: a first step waiting for its factor,
   * a desktop link code, a desktop approval a browser confirmed, a device-pair code, an OAuth code.
   * Each redeem mints a session the change never saw, so the change spends them. Each grant below is
   * minted by the OTHER session, the one the change signs out, and presented after the change; the
   * caller's session is the only one left, and what the caller mints afterwards still works.
   */

  /** The session a leaked password signed in, and the one the person changes it from. */
  async function twoSessions(h: Harness) {
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const other = sessionCtx(h, user, await signIn(h, user, secret));
    const caller = sessionCtx(h, user, await signIn(h, user, secret));
    return { user, secret, other, caller };
  }
  const liveSessions = async (h: Harness, userId: string): Promise<string[]> =>
    (await h.db.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))).map((r) => r.id);
  const totpCode = (h: Harness, secret: string): string =>
    generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });

  it("a first step taken with the old password before the change is refused at the factor", async () => {
    const h = await harness();
    const { user, secret, caller } = await twoSessions(h);
    const held = await h.svc.login(h.ctxFor(), { email: user.email, password: OLD }) as { loginToken: string };

    await h.svc.changePassword(caller, { currentPassword: OLD, newPassword: NEW });

    h.clock.advance(31_000); // a fresh timestep, well inside the held token's five minutes
    const code = totpCode(h, secret);
    await expect(h.svc.totpVerify(h.ctxFor(), { loginToken: held.loginToken, code }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
    expect(await liveSessions(h, user.userId)).toEqual([caller.sessionId]);

    // The control: a first step taken with the new password, after the change, reaches a session.
    const fresh = await h.svc.login(h.ctxFor(), { email: user.email, password: NEW }) as { loginToken: string };
    await expect(h.svc.totpVerify(h.ctxFor(), { loginToken: fresh.loginToken, code }))
      .resolves.toMatchObject({ status: "authenticated" });
  });

  it("a desktop link code the other session minted is not claimed after the change", async () => {
    const h = await harness();
    const { user, other, caller } = await twoSessions(h);
    const { code } = await h.svc.issueDesktopLink(other);

    await h.svc.changePassword(caller, { currentPassword: OLD, newPassword: NEW });

    await expect(h.svc.claimDesktopLink(h.ctxFor(), { code }))
      .rejects.toMatchObject({ code: "invalid_code", httpStatus: 400 });
    expect(await liveSessions(h, user.userId)).toEqual([caller.sessionId]);

    const next = await h.svc.issueDesktopLink(caller);
    await expect(h.svc.claimDesktopLink(h.ctxFor(), { code: next.code }))
      .resolves.toMatchObject({ tokens: { tokenType: "Bearer" } });
  });

  it("a device-pair code the other session minted is not redeemed after the change; an invite stays", async () => {
    const h = await harness();
    const { user, other, caller } = await twoSessions(h);
    const pair = await mintPairingToken(other, { grant: "device-pair", label: "Phone" });
    const invite = await mintPairingToken(caller, { grant: "invite", label: "Family" });

    await h.svc.changePassword(caller, { currentPassword: OLD, newPassword: NEW });

    await expect(redeemDevicePair(h.ctxFor(), h.svc, { token: pair.token }))
      .rejects.toMatchObject({ code: "pairing_invalid", httpStatus: 400 });
    expect(await liveSessions(h, user.userId)).toEqual([caller.sessionId]);
    // An invite opens somebody else's NEW account and never a session of this one: it is left.
    const [kept] = await h.db.select({ revokedAt: pairingTokens.revokedAt }).from(pairingTokens)
      .where(eq(pairingTokens.id, invite.id));
    expect(kept!.revokedAt).toBeNull();

    const next = await mintPairingToken(caller, { grant: "device-pair", label: "My phone" });
    await expect(redeemDevicePair(h.ctxFor(), h.svc, { token: next.token }))
      .resolves.toMatchObject({ tokens: { tokenType: "Bearer" } });
  });

  it("a desktop approval the other session confirmed is not claimed after the change", async () => {
    const h = await harness();
    const { user, other, caller } = await twoSessions(h);
    const kind = "desktop-linux" as const;
    const ask = async () => {
      const verifier = generateToken();
      const { approvalId } = await h.svc.issueDesktopApproval(h.ctxFor(), { challenge: hashToken(verifier), kind });
      return { approvalId, verifier, kind };
    };
    const confirmed = await ask();
    await h.svc.confirmDesktopApproval(other, confirmed.approvalId);

    await h.svc.changePassword(caller, { currentPassword: OLD, newPassword: NEW });

    await expect(h.svc.claimDesktopApproval(h.ctxFor(), confirmed))
      .rejects.toMatchObject({ code: "approval_denied", httpStatus: 410 });
    expect(await liveSessions(h, user.userId)).toEqual([caller.sessionId]);

    const next = await ask();
    await h.svc.confirmDesktopApproval(caller, next.approvalId);
    await expect(h.svc.claimDesktopApproval(h.ctxFor(), next))
      .resolves.toMatchObject({ tokens: { tokenType: "Bearer" } });
  });

  it("an OAuth code the other session minted is not exchanged after the change", async () => {
    const h = await harness();
    const { user, other, caller } = await twoSessions(h);
    const verifier = generateToken();
    const mint = async (ctx: ServiceContext): Promise<string> => {
      const { request } = await h.svc.authorize(ctx, {
        response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: `S${"256"}` as const, state: "s", scope: "full",
      });
      const { redirect } = await h.svc.approveAuthorize(ctx, { request });
      return new URL(redirect).searchParams.get("code")!;
    };
    const exchange = (code: string) => h.svc.token(h.ctxFor(), {
      grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
      client_id: "tf-macos", code_verifier: verifier,
    });
    const code = await mint(other);

    await h.svc.changePassword(caller, { currentPassword: OLD, newPassword: NEW });

    const refused = await exchange(code).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ code: "invalid_grant", httpStatus: 400 });
    // Voided, not spent: a spent code presented again is a replay, and this one issued nothing.
    expect(refused).not.toBeInstanceOf(OAuthCodeReplayed);
    expect(await liveSessions(h, user.userId)).toEqual([caller.sessionId]);

    await expect(exchange(await mint(caller))).resolves.toMatchObject({ tokenType: "Bearer" });
  });

  /**
   * A sign-in checks the password, then writes its first step in a transaction of its own. A change
   * that commits between the two has already voided every first step there was, so the one written
   * after it would outlive the change. It is answered as a wrong password is. With the stored hash
   * due a rewrite at today's cost, the sign-in's rewrite misses the changed row, and the new hash it
   * then finds is not one its password verifies: it must not take that hash for its own.
   */
  for (const [also, stale] of [["", false], [", its stored hash due a rewrite", true]] as const) {
    it(`a sign-in that checked the old password while the change committed is refused and writes no first step${also}`, async () => {
      const base = makeTestAuthDeps();
      let hold = false;
      let atVerify!: () => void;
      const reached = new Promise<void>((r) => { atVerify = r; });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const deps: AuthDeps = {
        ...base,
        passwordHasher: {
          hash: (p) => base.passwordHasher.hash(p),
          // The sign-in under test has its answer, and waits here while the change commits.
          verify: async (p, s) => {
            const ok = await base.passwordHasher.verify(p, s);
            if (hold) {
              hold = false;
              atVerify();
              await gate;
            }
            return ok;
          },
          needsRehash: () => stale,
        },
      };
      const h = await harness(deps);
      const { user, caller } = await twoSessions(h);
      const elsewhere = h.ctxFor({ ip: "5.6.7.8" });

      hold = true;
      const racing = h.svc.login(elsewhere, { email: user.email, password: OLD });
      await reached;
      await h.svc.changePassword(caller, { currentPassword: OLD, newPassword: NEW });
      release();

      await expect(racing).rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });
      const firstSteps = await h.db.select().from(loginTokens).where(and(
        eq(loginTokens.userId, user.userId), eq(loginTokens.purpose, "login"), isNull(loginTokens.consumedAt),
      ));
      expect(firstSteps, "a first step outlived the change").toEqual([]);
      expect(await h.deps.passwordHasher.verify(NEW, await storedHash(h, user.userId)), "the change was undone").toBe(true);
      // Counted and audited as a wrong password, against that client.
      const k = throttleKeysFor(h.deps.keyProvider);
      const [bucket] = await h.db.select().from(authThrottle)
        .where(eq(authThrottle.key, `pw:${k.address(user.email)}:${k.client("5.6.7.8")}`));
      expect(bucket!.failures).toBe(1);
      const failed = await h.db.select().from(authEvents).where(and(
        eq(authEvents.userId, user.userId), eq(authEvents.event, "login_failed"), eq(authEvents.ip, "5.6.7.8"),
      ));
      expect(failed).toHaveLength(1);

      await expect(h.svc.login(elsewhere, { email: user.email, password: NEW }))
        .resolves.toMatchObject({ status: "twofa_required" });
    });
  }

  it("a sign-in that rewrites the stored hash at today's cost still gets a first step that works", async () => {
    const base = makeTestAuthDeps();
    let stale = false;
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        hash: (p) => base.passwordHasher.hash(p),
        verify: (p, s) => base.passwordHasher.verify(p, s),
        needsRehash: () => stale,
      },
    };
    const h = await harness(deps);
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    const before = await storedHash(h, user.userId);

    stale = true;
    const step = await h.svc.login(h.ctxFor(), { email: user.email, password: OLD });
    stale = false;

    expect(step).toMatchObject({ status: "twofa_required" });
    expect(await storedHash(h, user.userId), "the sign-in rewrote nothing").not.toBe(before);
    h.clock.advance(31_000);
    const { loginToken } = step as { loginToken: string };
    await expect(h.svc.totpVerify(h.ctxFor(), { loginToken, code: totpCode(h, secret) }))
      .resolves.toMatchObject({ status: "authenticated" });
  });

  it("two sign-ins that rewrite the same stale hash at once both get a first step that works", async () => {
    const base = makeTestAuthDeps();
    let stale = false;
    let hold = false;
    let atVerify!: () => void;
    const reached = new Promise<void>((r) => { atVerify = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        hash: (p) => base.passwordHasher.hash(p),
        // The first sign-in has its answer and waits here while the second rewrites the hash.
        verify: async (p, s) => {
          const ok = await base.passwordHasher.verify(p, s);
          if (hold) {
            hold = false;
            atVerify();
            await gate;
          }
          return ok;
        },
        needsRehash: () => stale,
      },
    };
    const h = await harness(deps);
    const user = await register(h);
    const secret = await enrollTotp(h, user);

    stale = true;
    hold = true;
    const first = h.svc.login(h.ctxFor(), { email: user.email, password: OLD });
    await reached;
    const second = await h.svc.login(h.ctxFor({ ip: "5.6.7.8" }), { email: user.email, password: OLD });
    release();
    const firstStep = await first;
    stale = false;

    expect([firstStep, second]).toMatchObject([{ status: "twofa_required" }, { status: "twofa_required" }]);
    for (const step of [firstStep, second]) {
      h.clock.advance(31_000);
      const { loginToken } = step as { loginToken: string };
      await expect(h.svc.totpVerify(h.ctxFor(), { loginToken, code: totpCode(h, secret) }))
        .resolves.toMatchObject({ status: "authenticated" });
    }
  });
});

describe("AuthService — recovery codes", () => {
  it("codes are single-use; a used code is refused, an unused one works", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    // Establish a step-up'd session to generate recovery codes.
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });
    const sid = await latestSessionId(h, user.userId);
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid });

    const { codes } = await h.svc.generateRecoveryCodes(sctx);
    expect(codes.length).toBe(10);

    const l1 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const est = await h.svc.recoveryVerify(h.ctxFor(), { loginToken: l1.loginToken, code: codes[0]! });
    expect(est.status).toBe("authenticated");
    expect(est.remainingCodes).toBe(9);

    // Re-using code[0] fails.
    const l2 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    await expect(h.svc.recoveryVerify(h.ctxFor(), { loginToken: l2.loginToken, code: codes[0]! }))
      .rejects.toMatchObject({ code: "credential_refused" });

    // A different, unused code works.
    const l3 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const est3 = await h.svc.recoveryVerify(h.ctxFor(), { loginToken: l3.loginToken, code: codes[1]! });
    expect(est3.status).toBe("authenticated");

    // Regenerating invalidates the prior set.
    const sid2 = await latestSessionId(h, user.userId);
    const sctx2 = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid2 });
    await h.svc.generateRecoveryCodes(sctx2);
    const l4 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    await expect(h.svc.recoveryVerify(h.ctxFor(), { loginToken: l4.loginToken, code: codes[2]! }))
      .rejects.toMatchObject({ code: "credential_refused" });
  });

  /**
   * `batch_id` was written by every regeneration and read by NOTHING in the repo, so
   * "regenerating invalidates the prior set" rested entirely on the delete having removed the
   * prior rows. Two overlapping regenerations both delete and both insert, and under READ
   * COMMITTED neither delete sees the other's uncommitted rows — so both sheets survived and
   * the retired one stayed a valid second factor.
   *
   * The lock in `generateRecoveryCodes` stops new pairs (proved concurrently in
   * `auth-throttle.concurrency.pg.test.ts`); this proves the OTHER half, which is the one that
   * covers pairs already sitting in the database: whatever rows exist, only the newest batch is
   * honoured. Delete either `eq(recoveryCodes.batchId, batchId)` predicate in `recoveryVerify`
   * and this goes red.
   */
  it("only the NEWEST batch counts, so a surplus batch is inert rather than a live factor", async () => {
    const h = await harness();
    const user = await register(h);
    const secret = await enrollTotp(h, user);
    h.clock.advance(30_000);
    const ch = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const code = generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
    await h.svc.totpVerify(h.ctxFor(), { loginToken: ch.loginToken, code });
    const sid = await latestSessionId(h, user.userId);
    const sctx = h.ctxFor({ userId: user.userId, accountId: user.accountId, sessionId: sid });

    const { codes } = await h.svc.generateRecoveryCodes(sctx);

    // A surplus batch, exactly the shape a raced regeneration used to leave behind: its own
    // `batch_id`, unused, owned by this user — i.e. accepted by the old user+hash+unused match.
    const surplus = "1111-2222-3333";
    await h.db.insert(recoveryCodes).values({
      userId: user.userId, codeHash: hashToken(surplus), batchId: randomUUID(),
      createdAt: new Date(h.clock.now().getTime() - 60_000),
    });

    const l1 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    await expect(h.svc.recoveryVerify(h.ctxFor(), { loginToken: l1.loginToken, code: surplus }))
      .rejects.toMatchObject({ code: "credential_refused", httpStatus: 401 });

    // …and the batch that IS live is untouched by the scoping.
    const l2 = await h.svc.login(h.ctxFor(), { email: "gil@x.example", password: "pw-correct-horse-password-password" });
    const est = await h.svc.recoveryVerify(h.ctxFor(), { loginToken: l2.loginToken, code: codes[0]! });
    expect(est.status).toBe("authenticated");
    // Nine, not nineteen: the count answers for the batch that would actually be accepted.
    expect(est.remainingCodes).toBe(9);
  });
});

describe("AuthService — OAuth2 Authorization-Code + PKCE", () => {
  const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

  /**
   * A REAL session, because the ceremony is bound to one: the request records the session that
   * opened it and only that session may confirm it, so a fabricated ctx with `sessionId: null` is
   * no longer an authorized caller here — `stepUppedCtx`'s reasoning one screen up, verbatim.
   */
  async function authedCtx(h: Harness, user: SessionUser): Promise<ServiceContext> {
    return stepUppedCtx(h, user);
  }

  /**
   * The whole ceremony: open the request, then confirm it. `authorize` mints nothing on its own
   * any more — it writes down what is being asked for and hands back a
   * handle only the opening session can spend, and `approveAuthorize` is what produces the code.
   */
  async function mintCode(h: Harness, user: SessionUser, q: Record<string, string>): Promise<string> {
    // ONE ctx for both halves — the request is bound to the session that opened it, so a second
    // `authedCtx` here would seed a second session and be refused. That is the binding working.
    const ctx = await authedCtx(h, user);
    const { request } = await h.svc.authorize(ctx, q as never);
    const { redirect } = await h.svc.approveAuthorize(ctx, { request });
    return new URL(redirect).searchParams.get("code")!;
  }

  it("issues a short-TTL single-use code and exchanges it with a valid PKCE verifier", async () => {
    const h = await harness();
    const user = await register(h);
    const verifier = "a".repeat(48);
    const ctx = await authedCtx(h, user);
    const { request } = await h.svc.authorize(ctx, {
      response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
      code_challenge: s256(verifier), code_challenge_method: `S${"256"}` as const, state: "xyz", scope: "full",
    });
    const { redirect } = await h.svc.approveAuthorize(ctx, { request });
    const code = new URL(redirect).searchParams.get("code")!;
    // `state` survives the confirmation: it is stored with the request and echoed from the row,
    // never taken from the confirming body.
    expect(new URL(redirect).searchParams.get("state")).toBe("xyz");

    const tokens = await h.svc.token(h.ctxFor(), {
      grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
      client_id: "tf-macos", code_verifier: verifier,
    });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.tokenType).toBe("Bearer");

    // Single-use: the same code cannot be redeemed twice.
    await expect(h.svc.token(h.ctxFor(), {
      grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
      client_id: "tf-macos", code_verifier: verifier,
    })).rejects.toMatchObject({ code: "invalid_grant", httpStatus: 400 });
  });

  it("rejects a redirect_uri / client_id mismatch and a bad PKCE verifier (binding)", async () => {
    const h = await harness();
    const user = await register(h);
    const verifier = "b".repeat(48);
    const mint = () => mintCode(h, user, {
      response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
      code_challenge: s256(verifier), code_challenge_method: `S${"256"}` as const, state: "s",
    });

    // Wrong redirect_uri.
    await expect(h.svc.token(h.ctxFor(), {
      grant_type: "authorization_code", code: await mint(), redirect_uri: "trafficflow://evil",
      client_id: "tf-macos", code_verifier: verifier,
    })).rejects.toMatchObject({ code: "invalid_grant" });

    // Wrong client_id.
    await expect(h.svc.token(h.ctxFor(), {
      grant_type: "authorization_code", code: await mint(), redirect_uri: "trafficflow://auth",
      client_id: "tf-web", code_verifier: verifier,
    })).rejects.toMatchObject({ code: "invalid_grant" });

    // Bad PKCE verifier.
    await expect(h.svc.token(h.ctxFor(), {
      grant_type: "authorization_code", code: await mint(), redirect_uri: "trafficflow://auth",
      client_id: "tf-macos", code_verifier: "wrong-verifier",
    })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  /**
   * The route cannot produce this — `GET /oauth/authorize` is step-up gated and the gate reads a
   * session row — but the SERVICE can, and the service is where the binding is decided. "Nobody in
   * particular opened this" and "this session opened it" are different states, and admitting the
   * first would mean a request minted outside a session could be confirmed by any session at all.
   */
  it("a request that recorded NO session cannot be confirmed by anybody", async () => {
    const h = await harness();
    const user = await register(h);
    const verifier = "c".repeat(48);
    const unbound = h.ctxFor({ userId: user.userId, accountId: user.accountId });
    const { request } = await h.svc.authorize(unbound, {
      response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
      code_challenge: s256(verifier), code_challenge_method: `S${"256"}` as const, state: "s", scope: "full",
    });
    // Neither the ctx that opened it nor a real session may spend it.
    await expect(h.svc.approveAuthorize(unbound, { request }))
      .rejects.toMatchObject({ code: "invalid_grant", httpStatus: 400 });
    await expect(h.svc.approveAuthorize(await authedCtx(h, user), { request }))
      .rejects.toMatchObject({ code: "invalid_grant", httpStatus: 400 });
  });

  it("rejects an unknown client / redirect at authorize time", async () => {
    const h = await harness();
    const user = await register(h);
    await expect(h.svc.authorize(await authedCtx(h, user), {
      response_type: "code", client_id: "tf-macos", redirect_uri: "https://evil.example",
      code_challenge: "x", code_challenge_method: `S${"256"}` as const, state: "s",
    })).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
