import { describe, it, expect } from "vitest";
import { eq, desc } from "drizzle-orm";
import { generateSync } from "otplib";
import { makeTestDb } from "@trafficflow/db/testing";
import { bindDb, refreshTokens, sessions } from "@trafficflow/db";
import {
  AuthService, dbFor, makeTestAuthDeps, hashToken, surfaceTtls,
  type AuthDeps, type SessionUser, type ServiceContext,
} from "../src/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  SESSION LIFETIMES: ROLLING, PER SURFACE, WITH NO CEILING
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three properties, and each of them was FALSE in a way nothing failed on before this file:
 *
 *  1. **Rolling means rolling.** A 90-day refresh window under a 90-day absolute cap measured
 *     from `sessions.created_at` is not a rolling window — it is a fixed one with extra steps,
 *     and a browser used every single day was signed out on the ninetieth. The cap is now
 *     `null` on both shipped surfaces, and "the window re-issues from NOW on every rotation" is
 *     asserted rather than assumed: the tests advance the clock past the old ceiling and keep
 *     rotating.
 *  2. **The two surfaces get different windows** — 90 days for the browser, 400 for the desktop
 *     app, which rotates on every launch and is therefore signed in indefinitely in practice.
 *  3. **The DEFAULT is the short one.** This is the property with a real failure mode attached:
 *     `surfaceTtls` resolves an unstated surface to the cookie window, and if that default ever
 *     flips to `native`, every browser session silently becomes a rolling 400-day credential
 *     with nothing erroring, no test naming a surface going red, and no symptom a user could
 *     report. The pin is `surfaceTtls(cfg)` with NO second argument.
 *
 * ── HOW THESE WERE PROVEN TO BITE (each mutation run, watched red, restored) ───────────────
 *
 *   · `surfaceTtls`'s default `= "cookie"` → `= "native"`     ⇒ "an unstated surface", "a cookie
 *                                                               rotation never issues the native
 *                                                               window"
 *   · `establish`'s `o.kind === "macos"` → `o.kind !== "macos"` ⇒ "login mints the cookie window",
 *                                                               "the desktop's own door mints
 *                                                               the native window"
 *   · `mintRotation` reading `this.cfg.refreshTtlMs` again instead of the passed `ttls`
 *                                                             ⇒ "the native surface rolls 400 days"
 *   · `rotateRefresh`'s `ttls.absoluteTtlMs != null` guard removed (treat null as 0)
 *                                                             ⇒ "no ceiling binds a session that
 *                                                               keeps being used"
 *   · the same guard inverted to skip the cap entirely        ⇒ "a ceiling a deployment DOES set"
 */

const DAY = 24 * 60 * 60_000;
const PW = "pw-correct-horse";

/**
 * A movable clock ANCHORED TO REAL TIME, and the anchor is load-bearing rather than tidy.
 *
 * The absolute ceiling is measured as `ctx.now() - sessions.created_at`, and those two clocks are
 * not the same clock: every TTL in the service comes from `ctx.now()`, while `created_at` is a
 * column default filled in by the DATABASE. A fixed literal start (the constant the older auth
 * suites use sits a couple of weeks in the past) therefore makes the cap UNTESTABLE — the row is
 * stamped "now", the service thinks it is a fortnight earlier, and the age of the session comes
 * out negative however far the fake clock is advanced. The two ceiling tests below were green
 * against a cap that never fired until this was anchored.
 */
class Clock {
  constructor(public t: Date = new Date()) {}
  now = (): Date => this.t;
  advance(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
}

interface Harness {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  svc: AuthService;
  deps: AuthDeps;
  clock: Clock;
  ctx(over?: Partial<ServiceContext>): ServiceContext;
}

async function harness(over: Partial<AuthDeps["config"]> = {}): Promise<Harness> {
  const db = await makeTestDb();
  const clock = new Clock();
  const deps = makeTestAuthDeps(over);
  const svc = new AuthService(deps);
  return {
    db, svc, deps, clock,
    // A door before sign-in holds a handle bound to nothing; a call that carries a session, its account's.
    ctx: (o: Partial<ServiceContext> = {}): ServiceContext => ({
      db: o.accountId === undefined ? bindDb(db, { account: null }) : dbFor(db, o.accountId),
      accountId: "", userId: null, now: clock.now, requestId: "r", ip: "1.2.3.4", ...o,
    }),
  };
}

/** Register → enrol TOTP → login → verify. Returns the user and the first refresh token. */
async function signIn(h: Harness, email = "gil@x.example"): Promise<{ user: SessionUser; refresh: string }> {
  const { user } = await h.svc.register(h.ctx(), { email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" });
  const sessionId = (await h.db.select().from(sessions).where(eq(sessions.userId, user.userId))
    .orderBy(desc(sessions.createdAt)).limit(1))[0]!.id;
  const enrollCtx = h.ctx({ userId: user.userId, accountId: user.accountId, sessionId });
  const { secret } = await h.svc.totpEnroll(enrollCtx);
  const code = (): string => generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
  await h.svc.totpActivate(enrollCtx, { code: code() });

  h.clock.advance(30_000);           // TOTP is single-use per 30-second step.
  const ch = await h.svc.login(h.ctx(), { email, password: PW });
  if (ch.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${ch.status}`);
  const est = await h.svc.totpVerify(h.ctx(), { loginToken: ch.loginToken, code: code() });
  return { user: est.user, refresh: est.tokens!.refreshToken };
}

/** The refresh-token row a raw token names — looked up by hash, so it is exactly that token's row. */
async function rowFor(h: Harness, token: string) {
  const row = (await h.db.select().from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token))).limit(1))[0];
  expect(row, "the presented token has a refresh_tokens row").toBeTruthy();
  return row!;
}

/**
 * How long the given token is good for, in days, measured from `from` (the clock at the moment it
 * was minted) — defaulting to now. Passing the mint time explicitly is what lets a test advance
 * the clock between two rotations and still assert each window at full width.
 */
async function windowDays(h: Harness, token: string, from?: Date): Promise<number> {
  const row = await rowFor(h, token);
  return (row.expiresAt.getTime() - (from ?? h.clock.now()).getTime()) / DAY;
}

describe("the surface resolver's default is the STRICTER window", () => {
  /**
   * THE DANGEROUS DEFAULT, PINNED. `surfaceTtls(cfg)` with no surface is what every caller that
   * forgets — a new route, a future refresh path, a refactor that drops an argument — actually
   * gets. It must be the browser's short window. Flip the `= "cookie"` default in `config.ts`
   * to `= "native"` and this goes red; nothing else in the suite would.
   */
  it("an unstated surface resolves to the cookie window, never the native one", async () => {
    const cfg = makeTestAuthDeps().config;

    expect(surfaceTtls(cfg)).toEqual({
      refreshTtlMs: cfg.refreshTtlMs,
      absoluteTtlMs: cfg.sessionAbsoluteTtlMs,
    });
    expect(surfaceTtls(cfg).refreshTtlMs).not.toBe(cfg.nativeRefreshTtlMs);
    // Explicitly the SHORTER of the two: "the default is cookie" and "cookie is stricter" are
    // two claims, and a config that inverted the numbers would satisfy only the first.
    expect(surfaceTtls(cfg).refreshTtlMs).toBeLessThan(surfaceTtls(cfg, "native").refreshTtlMs);
  });

  it("the shipped numbers are 90 days rolling on the web, 400 on native, with no ceiling", async () => {
    const cfg = makeTestAuthDeps().config;
    expect(cfg.refreshTtlMs).toBe(90 * DAY);
    expect(cfg.nativeRefreshTtlMs).toBe(400 * DAY);
    // `null` is the whole of what makes the windows above ROLLING rather than merely long.
    expect(cfg.sessionAbsoluteTtlMs).toBeNull();
    expect(cfg.nativeSessionAbsoluteTtlMs).toBeNull();
    // SIXTY SECONDS of rotation grace, pinned because the number is a measured product
    // decision, not a tuning knob: ten seconds was argued from a sub-second round trip and
    // revoked a real account's family on a wake-time presentation arriving past ten seconds after its
    // token was consumed (2026-08-28). The residual it buys is stated in `config.ts`.
    expect(cfg.refreshReuseGraceMs).toBe(60_000);
  });
});

describe("what each door mints", () => {
  it("a browser login mints the 90-day cookie window, in the token row and on the session", async () => {
    const h = await harness();
    const { user, refresh } = await signIn(h);

    expect(await windowDays(h, refresh)).toBe(90);

    // `sessions.refresh_expires_at` mirrors it. The column is not enforced anywhere yet, which is
    // exactly why it is asserted: a column that reads like a fact has to be one.
    const s = (await h.db.select().from(sessions).where(eq(sessions.userId, user.userId))
      .orderBy(desc(sessions.createdAt)).limit(1))[0]!;
    expect(s.refreshExpiresAt.getTime() - h.clock.now().getTime()).toBe(90 * DAY);
  });

  it("the desktop's own door mints the 400-day native window", async () => {
    const h = await harness();
    const { user, refresh } = await signIn(h);
    const sessionId = (await h.db.select().from(sessions).where(eq(sessions.userId, user.userId))
      .orderBy(desc(sessions.createdAt)).limit(1))[0]!.id;

    // `POST /auth/desktop-link` → `POST /auth/desktop-claim`: the browser mints a one-use code
    // from a step-up-cleared session and the installed app spends it for a session of its own.
    // That session is `kind: "macos"`, and the window follows the kind.
    const linkCtx = h.ctx({ userId: user.userId, accountId: user.accountId, sessionId });
    const { code } = await h.svc.issueDesktopLink(linkCtx);
    const { tokens } = await h.svc.claimDesktopLink(h.ctx({ ip: "10.0.0.9" }), { code });

    expect(await windowDays(h, tokens.refreshToken)).toBe(400);
  });
});

describe("rolling: every rotation re-issues the window from now", () => {
  it("a cookie rotation two months in is still good for a full 90 days", async () => {
    const h = await harness();
    const { refresh } = await signIn(h);
    const mintedExpiry = (await rowFor(h, refresh)).expiresAt.getTime();

    // Sixty days of ordinary use. The token is still live (60 < 90), and the rotation must hand
    // back a window measured from HERE — not what is left of the original one, and not something
    // anchored to the session's creation.
    h.clock.advance(60 * DAY);
    const rotated = await h.svc.refresh(h.ctx(), { refreshToken: refresh }, { concurrentGrace: true, surface: "cookie" });
    const next = rotated.tokens!.refreshToken;

    expect(await windowDays(h, next)).toBe(90);
    // …and that is strictly further out than the token it replaced, by exactly the elapsed time.
    // A non-rolling implementation (expiry derived from `sessions.created_at`) leaves these equal.
    expect((await rowFor(h, next)).expiresAt.getTime() - mintedExpiry).toBe(60 * DAY);
  });

  it("a cookie rotation never issues the native window", async () => {
    const h = await harness();
    const { refresh } = await signIn(h);

    const rotated = await h.svc.refresh(h.ctx(), { refreshToken: refresh }, { concurrentGrace: true, surface: "cookie" });
    const days = await windowDays(h, rotated.tokens!.refreshToken);
    expect(days).toBe(90);
    expect(days).not.toBe(400);
  });

  it("a rotation with NO surface stated takes the cookie window", async () => {
    // The same dangerous default, one level up: this is the shape of a caller that never learned
    // surfaces exist. It must be short-changed, never over-served.
    const h = await harness();
    const { refresh } = await signIn(h);

    const rotated = await h.svc.refresh(h.ctx(), { refreshToken: refresh });
    expect(await windowDays(h, rotated.tokens!.refreshToken)).toBe(90);
  });

  it("the native surface rolls 400 days — through /auth/refresh and through the OAuth grant", async () => {
    const h = await harness();
    const { refresh } = await signIn(h);

    const viaRefresh = await h.svc.refresh(h.ctx(), { refreshToken: refresh }, { surface: "native" });
    expect(await windowDays(h, viaRefresh.tokens!.refreshToken)).toBe(400);

    // `POST /oauth/token` with `grant_type=refresh_token` is the desktop app renewing itself and
    // must agree with the branch above — the two are separate call sites into one rotation.
    const viaGrant = await h.svc.token(h.ctx(), {
      grant_type: "refresh_token", refresh_token: viaRefresh.tokens!.refreshToken,
    });
    expect(await windowDays(h, viaGrant.refreshToken)).toBe(400);
  });

  it("the GRACE re-rotation issues the same window as the hot path", async () => {
    // Two tabs, one jar: the loser's re-presentation inside the grace window goes down a second
    // path into `mintRotation`. It must not be the path where a lifetime quietly differs.
    const h = await harness();
    const { refresh } = await signIn(h);

    const wonAt = h.clock.now();
    const winner = await h.svc.refresh(h.ctx(), { refreshToken: refresh }, { concurrentGrace: true, surface: "cookie" });
    // READ BEFORE THE LOSER ARRIVES. The grace arm converges the family on one live tail, so the
    // loser's presentation collapses the winner's answer and stamps its expiry with the kill
    // (`expires_at = consumed_at`) — after which no row can say what window it was minted with.
    // Each answer is therefore read at the moment it is minted, which is when the claim is true.
    expect(await windowDays(h, winner.tokens!.refreshToken, wonAt)).toBe(90);

    h.clock.advance(2_000);
    const lostAt = h.clock.now();
    const loser = await h.svc.refresh(h.ctx(), { refreshToken: refresh }, { concurrentGrace: true, surface: "cookie" });

    expect(await windowDays(h, loser.tokens!.refreshToken, lostAt)).toBe(90);
    // …and the convergence itself, so the reading above is not quietly measuring two live tails:
    // the winner's answer is consumed and kill-stamped, the loser's is the family's one live tail.
    const wonRow = await rowFor(h, winner.tokens!.refreshToken);
    expect(wonRow.consumedAt, "the winner's answer was converged away").not.toBeNull();
    expect(wonRow.expiresAt.getTime()).toBe(wonRow.consumedAt!.getTime());
    expect((await rowFor(h, loser.tokens!.refreshToken)).consumedAt).toBeNull();
  });
});

describe("the absolute ceiling", () => {
  it("no ceiling binds a session that keeps being used — past the old 90-day cap", async () => {
    // THE DEFECT THIS SLICE FIXES, run as a test. Before it, this loop threw
    // `session has reached its maximum lifetime` on the rotation past day 90, on a session that
    // had been used every two months, and the browser was signed out with no way to tell why.
    const h = await harness();
    const { user, refresh } = await signIn(h);

    let token = refresh;
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(60 * DAY);                                    // 240 days of use, in all
      const rotated = await h.svc.refresh(h.ctx(), { refreshToken: token }, { concurrentGrace: true, surface: "cookie" });
      token = rotated.tokens!.refreshToken;
      expect(await windowDays(h, token)).toBe(90);
    }

    // Nothing was revoked along the way: the family is alive, not merely re-mintable.
    const rows = await h.db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.userId));
    expect(rows.some((r) => r.revokedAt !== null)).toBe(false);
  });

  it("a ceiling a deployment DOES set is still enforced, and only on the surface that sets it", async () => {
    // `null` means "no ceiling", not "unset" — so the enforcement below must stay live and
    // provable, or the nulls above would be indistinguishable from a cap that had been deleted.
    // This config caps the NATIVE surface at ten days and leaves the cookie surface uncapped.
    const h = await harness({ nativeSessionAbsoluteTtlMs: 10 * DAY });
    const { refresh } = await signIn(h);

    h.clock.advance(11 * DAY);
    await expect(h.svc.refresh(h.ctx(), { refreshToken: refresh }, { surface: "native" }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });

    // The cap is PER SURFACE, and the refusal above revoked this family — so a second session
    // proves the cookie surface is untouched by a native ceiling rather than merely surviving it.
    const h2 = await harness({ nativeSessionAbsoluteTtlMs: 10 * DAY });
    const second = await signIn(h2);
    h2.clock.advance(11 * DAY);
    await expect(h2.svc.refresh(h2.ctx(), { refreshToken: second.refresh }, { concurrentGrace: true, surface: "cookie" }))
      .resolves.toBeTruthy();
  });

  it("a cookie ceiling, when set, still ends the session and revokes the family", async () => {
    const h = await harness({ sessionAbsoluteTtlMs: 10 * DAY });
    const { refresh } = await signIn(h);

    h.clock.advance(11 * DAY);
    await expect(h.svc.refresh(h.ctx(), { refreshToken: refresh }, { concurrentGrace: true, surface: "cookie" }))
      .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401 });
    // The family really is dead — a capped session is ended, not just refused once.
    const row = await rowFor(h, refresh);
    expect(row.revokedAt).not.toBeNull();
  });
});
