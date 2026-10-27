import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, users, devices, sessions, refreshTokens, type Tx } from "@trafficflow/db";
import {
  generateToken, hashToken, makeSessionLifecycle, makeTestAuthDeps, reapStaleWebSessions, type ServiceContext,
} from "../src/index.js";

/**
 * ═══ THE WEB-SESSION REAPER — what it may touch, proven by what survives ═══
 *
 * The predicate is structural (`device_id IS NULL AND scope = 'full' AND last_seen_at <
 * now - 60d`, on the cookie window: `refresh_expires_at - last_seen_at < 100d`), and every
 * arm of it is pinned by a row that DIFFERS in exactly that arm:
 *
 *  · a plain web session idle 61 days      → REAPED, refresh family included
 *  · the same, idle 59 days                → kept (the cutoff is the cutoff)
 *  · a PAIRED device idle 400 days         → kept — paired devices are NEVER auto-reaped;
 *    an idle phone in a drawer keeps its pairing, because re-pairing has a ceremony cost
 *    that a web re-login does not
 *  · an enrollment session, however old    → kept (its own five-minute death owns it)
 *  · an already-revoked session            → not counted twice (the claim is guarded)
 *  · a device-less session on the native window, idle 61 days → kept, and it renews
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-21T12:00:00.000Z");

async function seedUser(db: Tx): Promise<{ accountId: string; userId: string }> {
  const [acct] = await db.insert(accounts).values({ name: "Test" }).returning();
  const [user] = await db.insert(users).values({
    accountId: acct!.id, email: `gil+${acct!.id}@x.example`, displayName: "Gil",
  }).returning();
  return { accountId: acct!.id, userId: user!.id };
}

async function seedSession(db: Tx, o: {
  accountId: string; userId: string; lastSeenAt: Date;
  deviceId?: string | null; scope?: "full" | "enrollment"; revokedAt?: Date | null;
}): Promise<{ id: string; familyId: string }> {
  const [s] = await db.insert(sessions).values({
    accountId: o.accountId, userId: o.userId, deviceId: o.deviceId ?? null,
    familyId: crypto.randomUUID(), scope: o.scope ?? "full",
    accessTokenHash: "fixture",
    accessExpiresAt: new Date(NOW.getTime() + 60_000),
    // The cookie window, written in lockstep with last_seen_at as a rotation writes it.
    refreshExpiresAt: new Date(o.lastSeenAt.getTime() + 90 * DAY),
    lastSeenAt: o.lastSeenAt, revokedAt: o.revokedAt ?? null,
  }).returning();
  return { id: s!.id, familyId: s!.familyId };
}

describe("reapStaleWebSessions", () => {
  it("revokes exactly the stale device-less full sessions, families included", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const me = await seedUser(db);

    const stale = await seedSession(db, { ...me, lastSeenAt: new Date(NOW.getTime() - 61 * DAY) });
    await db.insert(refreshTokens).values({
      accountId: me.accountId, userId: me.userId, sessionId: stale.id, familyId: stale.familyId,
      tokenHash: "fixture-stale", expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const fresh = await seedSession(db, { ...me, lastSeenAt: new Date(NOW.getTime() - 59 * DAY) });

    const [dev] = await db.insert(devices).values({
      accountId: me.accountId, userId: me.userId, kind: "web", label: "Mila's phone",
    }).returning();
    const paired = await seedSession(db, {
      ...me, deviceId: dev!.id, lastSeenAt: new Date(NOW.getTime() - 400 * DAY),
    });
    const enrollment = await seedSession(db, {
      ...me, scope: "enrollment", lastSeenAt: new Date(NOW.getTime() - 400 * DAY),
    });
    const alreadyRevoked = await seedSession(db, {
      ...me, lastSeenAt: new Date(NOW.getTime() - 400 * DAY), revokedAt: new Date(NOW.getTime() - DAY),
    });

    const { reaped } = await reapStaleWebSessions(db, NOW);
    expect(reaped).toBe(1);

    const byId = async (id: string) => (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
    expect((await byId(stale.id)).revokedAt?.toISOString()).toBe(NOW.toISOString());
    expect((await byId(fresh.id)).revokedAt).toBeNull();
    expect((await byId(paired.id)).revokedAt).toBeNull();
    expect((await byId(enrollment.id)).revokedAt).toBeNull();
    // The pre-revoked row keeps ITS OWN revocation time — the guarded claim skipped it.
    expect((await byId(alreadyRevoked.id)).revokedAt?.toISOString()).not.toBe(NOW.toISOString());

    // The stale session's refresh family died with it.
    const fam = (await db.select().from(refreshTokens)
      .where(eq(refreshTokens.familyId, stale.familyId)))[0]!;
    expect(fam.revokedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("reaps a browser but keeps a device-less desktop session, which renews on the native window", async () => {
    // Desktop password sign-ins of v0.11.0–v0.11.1 declared no device kind, so they have no
    // device row; the desktop's rotations write the native window (400 days), a browser's 90.
    const db = (await makeTestDb()) as unknown as Tx;
    const me = await seedUser(db);
    const lifecycle = makeSessionLifecycle({ config: makeTestAuthDeps().config });
    const lastUse = new Date(NOW.getTime() - 61 * DAY);
    const renew = async (at: Date, token: string, surface: "cookie" | "native") => (await lifecycle.refresh(
      { db: db as unknown as ServiceContext["db"], accountId: "", userId: null, now: () => at, requestId: "reap" },
      { refreshToken: token }, { surface })).tokens!.refreshToken;
    const usedOn = async (surface: "cookie" | "native") => {
      const s = await seedSession(db, { ...me, lastSeenAt: lastUse });
      const token = generateToken();
      await db.insert(refreshTokens).values({
        ...me, sessionId: s.id, familyId: s.familyId, tokenHash: hashToken(token),
        expiresAt: new Date(lastUse.getTime() + 90 * DAY),
      });
      return { id: s.id, token: await renew(lastUse, token, surface) };
    };
    const browser = await usedOn("cookie");
    const desktop = await usedOn("native");

    expect((await reapStaleWebSessions(db, NOW)).reaped).toBe(1);
    const revokedAt = async (id: string) => (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!.revokedAt;
    expect(await revokedAt(browser.id)).not.toBeNull();
    expect(await revokedAt(desktop.id)).toBeNull();
    expect(await renew(NOW, desktop.token, "native")).toBeTruthy();
  });

  it("a session that ROTATES between the candidate read and the claim survives the claim", async () => {
    // The gate finding this pins: the claim UPDATE re-stated the structural predicate but not
    // the CUTOFF, so a browser that came back to life in the window between the candidate
    // SELECT and the claim — `mintRotation` stamps `last_seen_at` current on every rotation —
    // was revoked anyway: a just-active session signed out by maintenance. The race is made
    // deterministic by interposing on the reaper's own claim, a transaction per chunk (its lock
    // and its update): the rotation's `last_seen_at` write lands after the candidates are read
    // and before the claim begins.
    const db = (await makeTestDb()) as unknown as Tx;
    const me = await seedUser(db);
    const victim = await seedSession(db, { ...me, lastSeenAt: new Date(NOW.getTime() - 61 * DAY) });

    let raced = false;
    const racing = new Proxy(db as object, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === "transaction") {
          return async (...a: unknown[]) => {
            if (!raced) {
              raced = true;
              // The rotation, landing in the window: the victim is seen NOW.
              await (db as Tx).update(sessions).set({ lastSeenAt: NOW }).where(eq(sessions.id, victim.id));
            }
            return (v as (...b: unknown[]) => unknown).apply(t, a);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as unknown as Tx;

    const { reaped } = await reapStaleWebSessions(racing, NOW);
    expect(reaped).toBe(0);
    const row = (await db.select().from(sessions).where(eq(sessions.id, victim.id)))[0]!;
    expect(row.revokedAt).toBeNull();
    expect(row.lastSeenAt.toISOString()).toBe(NOW.toISOString());
  });

  it("honours the run budget and converges across invocations", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const me = await seedUser(db);
    for (let i = 0; i < 5; i++) {
      await seedSession(db, { ...me, lastSeenAt: new Date(NOW.getTime() - (61 + i) * DAY) });
    }
    const first = await reapStaleWebSessions(db, NOW, { limit: 2 });
    expect(first.reaped).toBe(2);
    const second = await reapStaleWebSessions(db, NOW, { limit: 2 });
    expect(second.reaped).toBe(2);
    const third = await reapStaleWebSessions(db, NOW, { limit: 2 });
    expect(third.reaped).toBe(1);
    const fourth = await reapStaleWebSessions(db, NOW, { limit: 2 });
    expect(fourth.reaped).toBe(0);
  });
});
