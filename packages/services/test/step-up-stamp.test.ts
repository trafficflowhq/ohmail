import { describe, it, expect } from "vitest";
import { eq, desc } from "drizzle-orm";
import { generateSync } from "otplib";
import { makeTestDb } from "@trafficflow/db/testing";
import { bindDb, sessions } from "@trafficflow/db";
import { AuthService, dbFor, makeTestAuthDeps, type AuthDeps, type ServiceContext } from "../src/index.js";

/**
 * ═══ THE STEP-UP RE-STAMP IS A GUARDED WRITE — the service-level cases HTTP cannot reach ═══
 *
 * `stampStepUp` re-stamps `last_twofa_at` with `revoked_at IS NULL AND scope = 'full'` inside
 * the UPDATE itself and judges the RETURNING. The API pipeline already refuses a revoked or
 * enrollment-scoped caller before any handler runs, so the predicate looks redundant from the
 * wire — which is exactly why it needs service-level pins: the gate it survives is the RACE
 * (a session revoked between `withSession`'s read and the stamp's write) and the DIRECT CALLER
 * (a composition that wires the service without the pipeline). A verify that answered
 * `{ok: true}` over an unstamped session would report a ceremony that did not happen.
 */

const PW = "pw-correct-horse";

class Clock {
  constructor(public t: Date = new Date()) {}
  now = (): Date => this.t;
  advance(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
}

async function harness(): Promise<{
  db: Awaited<ReturnType<typeof makeTestDb>>;
  svc: AuthService; clock: Clock;
  ctx(over?: Partial<ServiceContext>): ServiceContext;
}> {
  const db = await makeTestDb();
  const clock = new Clock();
  const deps: AuthDeps = makeTestAuthDeps();
  const svc = new AuthService(deps);
  return {
    db, svc, clock,
    // A door before sign-in holds a handle bound to nothing; a call that carries a session, its account's.
    ctx: (o: Partial<ServiceContext> = {}): ServiceContext => ({
      db: o.accountId === undefined ? bindDb(db, { account: null }) : dbFor(db, o.accountId),
      accountId: "", userId: null, now: clock.now, requestId: "r", ip: "1.2.3.4", ...o,
    }),
  };
}

/** Register → enroll TOTP → sign in. Returns identity, the live session id and a code source. */
async function signIn(h: Awaited<ReturnType<typeof harness>>) {
  const { user } = await h.svc.register(h.ctx(), { email: "gil@x.example", password: PW, displayName: "Gil", inviteCode: "INVITE-OK" });
  const enrollSession = (await h.db.select().from(sessions).where(eq(sessions.userId, user.userId))
    .orderBy(desc(sessions.createdAt)).limit(1))[0]!;
  const enrollCtx = h.ctx({ userId: user.userId, accountId: user.accountId, sessionId: enrollSession.id });
  const { secret } = await h.svc.totpEnroll(enrollCtx);
  const code = (): string => generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) });
  await h.svc.totpActivate(enrollCtx, { code: code() });
  h.clock.advance(30_000);
  const full = (await h.db.select().from(sessions)
    .where(eq(sessions.userId, user.userId)).orderBy(desc(sessions.createdAt)).limit(1))[0]!;
  expect(full.scope).toBe("full");
  return { user, sessionId: full.id, code };
}

describe("stampStepUp refuses in the write, not the read", () => {
  it("a session revoked mid-ceremony gets 401, never {ok:true} over an unstamped row", async () => {
    const h = await harness();
    const { user, sessionId, code } = await signIn(h);

    // The race, made deterministic: the session dies AFTER the pipeline would have admitted
    // it and BEFORE the stamp. The factor code itself is valid.
    const before = (await h.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]!;
    await h.db.update(sessions).set({ revokedAt: h.clock.now() }).where(eq(sessions.id, sessionId));
    h.clock.advance(30_000); // a fresh timestep, so the ONLY refusal in play is the stamp's

    await expect(
      h.svc.stepUpTotp(h.ctx({ userId: user.userId, accountId: user.accountId, sessionId }), { code: code() }),
    ).rejects.toMatchObject({ httpStatus: 401 });

    const row = (await h.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]!;
    expect(row.revokedAt).not.toBeNull(); // still revoked, and…
    // …the stamp did not land on the corpse: `last_twofa_at` is byte-identical to the value
    // the session was minted with (the activation-time exchange stamped it once, honestly).
    expect(row.lastTwofaAt?.toISOString()).toBe(before.lastTwofaAt?.toISOString());
  });

  it("an enrollment-scoped session can never re-stamp itself into step-up standing", async () => {
    const h = await harness();
    const { user } = await h.svc.register(h.ctx(), { email: "gil2@x.example", password: PW, displayName: "Gil", inviteCode: "INVITE-OK" });
    const enrollSession = (await h.db.select().from(sessions).where(eq(sessions.userId, user.userId))
      .orderBy(desc(sessions.createdAt)).limit(1))[0]!;
    expect(enrollSession.scope).toBe("enrollment");
    const enrollCtx = h.ctx({ userId: user.userId, accountId: user.accountId, sessionId: enrollSession.id });
    const { secret } = await h.svc.totpEnroll(enrollCtx);
    await h.svc.totpActivate(enrollCtx, { code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }) });
    h.clock.advance(30_000);

    // Direct service call with the (now superseded, but re-seed a fresh one to be exact)
    // enrollment session: the stamp's `scope = 'full'` predicate refuses even though the
    // factor verifies. Fabricate a LIVE enrollment session to make the case pure.
    const [fresh] = await h.db.insert(sessions).values({
      accountId: user.accountId, userId: user.userId, familyId: crypto.randomUUID(),
      scope: "enrollment",
      accessTokenHash: "fixture", accessExpiresAt: new Date(h.clock.now().getTime() + 60_000),
      refreshExpiresAt: new Date(h.clock.now().getTime() + 60_000),
      lastSeenAt: h.clock.now(),
    }).returning();

    await expect(
      h.svc.stepUpTotp(
        h.ctx({ userId: user.userId, accountId: user.accountId, sessionId: fresh!.id }),
        { code: generateSync({ secret, epoch: Math.floor(h.clock.now().getTime() / 1000) }) },
      ),
    ).rejects.toMatchObject({ httpStatus: 401 });

    const row = (await h.db.select().from(sessions).where(eq(sessions.id, fresh!.id)))[0]!;
    expect(row.lastTwofaAt).toBeNull();
    expect(row.scope).toBe("enrollment");
  });
});
