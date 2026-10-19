import { describe, it, expect } from "vitest";
import { and, eq, getTableName, isNull, type Table } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, users, devices, sessions, refreshTokens, type Tx } from "@trafficflow/db";
import { makeSessionLifecycle, makeTestAuthDeps, type ServiceContext } from "../src/index.js";

/**
 * ═══ THE BULK REVOKE IS SET-BASED — a security verb must not be a per-row loop ═══
 *
 * The gate finding this pins: `revokeWebSessions` looped `revokeFamily` per family — two
 * awaited UPDATEs per family, serially. On the accounts this verb exists FOR (hundreds of
 * legacy web sessions; 208 measured on the test account, more on a real one), that is 400+
 * database round trips inside a hosted request with a 60-second ceiling — so "Sign out all
 * other web sessions" could time out having revoked only a PREFIX, report failure, and leave
 * the rest alive: a security action silently half-done. The rewrite claims the whole scope in
 * ONE guarded UPDATE and sweeps the refresh families in bounded IN-chunks, so the statement
 * count is O(1 + n/500), not O(2n).
 *
 * Pinned by counting the UPDATE statements the verb issues against an account of many sessions,
 * per table — the loop shape fails this at 240+, the set shape claims once and sweeps in one
 * chunk — AND by the completeness facts the count exists to protect: every plain session revoked,
 * every family swept, the caller and the paired device untouched.
 */

const NOW = new Date("2026-08-21T12:00:00.000Z");

describe("revokeWebSessions — set-based, complete, bounded", () => {
  it("revokes 120 sessions + families in one claim and one token chunk, sparing caller and paired", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [acct] = await db.insert(accounts).values({ name: "batch" }).returning();
    const [user] = await db.insert(users)
      .values({ accountId: acct!.id, email: "batch@x.example", displayName: "B" }).returning();
    const me = { accountId: acct!.id, userId: user!.id };

    const mkSession = async (o: { deviceId?: string | null; lastTwofaAt?: Date | null } = {}) => {
      const [s] = await db.insert(sessions).values({
        ...me, deviceId: o.deviceId ?? null, familyId: crypto.randomUUID(),
        accessTokenHash: crypto.randomUUID(), scope: "full",
        accessExpiresAt: new Date(NOW.getTime() + 60_000),
        refreshExpiresAt: new Date(NOW.getTime() + 60_000),
        lastTwofaAt: o.lastTwofaAt ?? null, lastSeenAt: NOW,
      }).returning();
      await db.insert(refreshTokens).values({
        ...me, sessionId: s!.id, familyId: s!.familyId,
        tokenHash: crypto.randomUUID(), expiresAt: new Date(NOW.getTime() + 60_000),
      });
      return s!;
    };

    const caller = await mkSession({ lastTwofaAt: NOW });
    const [dev] = await db.insert(devices).values({ ...me, kind: "web", label: "Mila's phone" }).returning();
    const paired = await mkSession({ deviceId: dev!.id });
    const plain: string[] = [];
    for (let i = 0; i < 120; i++) plain.push((await mkSession()).id);

    // Counts UPDATE statements per table through the transaction boundary too: the verb runs its
    // claim, sweeps and voids inside one tx, so the counter follows the tx handle it hands out.
    const updates: Record<string, number> = {};
    const countWrap = (handle: object): object =>
      new Proxy(handle, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (p === "update") {
            return (...a: unknown[]) => {
              const table = getTableName(a[0] as Table);
              updates[table] = (updates[table] ?? 0) + 1;
              return (t as Tx).update(...(a as [never]));
            };
          }
          if (p === "transaction") {
            return (fn: (tx: object) => unknown, ...rest: unknown[]) =>
              (t as unknown as { transaction: (f: (tx: object) => unknown, ...r: unknown[]) => unknown })
                .transaction((tx) => fn(countWrap(tx)), ...rest);
          }
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    const counting = countWrap(db as object) as unknown as Tx;

    const svc = makeSessionLifecycle({ config: makeTestAuthDeps().config });
    const ctx: ServiceContext = {
      db: counting as unknown as ServiceContext["db"],
      accountId: me.accountId, userId: me.userId, sessionId: caller.id,
      now: () => NOW, requestId: "batch", ip: "1.2.3.4",
    };

    const { revoked } = await svc.revokeWebSessions(ctx);
    expect(revoked).toBe(120);
    // The whole verb in a fixed count: one session claim + one token chunk (the pre-fix loop
    // shape spends 240 on these two, which is what the hosted 60-second ceiling turns into a
    // PARTIAL sign-out), and the pending device-pair codes voided before the claim and after it.
    expect(updates).toEqual({ sessions: 1, refresh_tokens: 1, pairing_tokens: 2 });

    // Completeness — the count is only honest if nothing was left half-done.
    const live = await db.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.userId, me.userId), isNull(sessions.revokedAt)));
    expect(live.map((r) => r.id).sort()).toEqual([caller.id, paired.id].sort());
    const liveTokens = await db.select({ id: refreshTokens.id, sessionId: refreshTokens.sessionId })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, me.userId), isNull(refreshTokens.revokedAt)));
    expect(liveTokens.map((t) => t.sessionId).sort()).toEqual([caller.id, paired.id].sort());
  });

  it("a failure mid-sweep leaves NOTHING half-done, and the retry converges", async () => {
    // The verification pass caught the convergence hole: the session claim used to commit in
    // autocommit and the refresh-family sweep followed separately, so a chunk that failed (or
    // a request that died) left every target session revoked with some refresh rows still
    // live — and the RETRY claimed zero rows (`revoked_at IS NULL`), so it could never
    // revisit those families. The rotation orphan-guard made the leftovers unusable at
    // presentation time, but a security verb whose bookkeeping cannot converge is still the
    // defect. Claim + sweeps now share ONE transaction: a mid-sweep death rolls the claim
    // back, and the retry does the whole job.
    const db = (await makeTestDb()) as unknown as Tx;
    const [acct] = await db.insert(accounts).values({ name: "converge" }).returning();
    const [user] = await db.insert(users)
      .values({ accountId: acct!.id, email: "converge@x.example", displayName: "C" }).returning();
    const me = { accountId: acct!.id, userId: user!.id };

    const mkSession = async (o: { lastTwofaAt?: Date | null } = {}) => {
      const [s] = await db.insert(sessions).values({
        ...me, deviceId: null, familyId: crypto.randomUUID(),
        accessTokenHash: crypto.randomUUID(), scope: "full",
        accessExpiresAt: new Date(NOW.getTime() + 60_000),
        refreshExpiresAt: new Date(NOW.getTime() + 60_000),
        lastTwofaAt: o.lastTwofaAt ?? null, lastSeenAt: NOW,
      }).returning();
      await db.insert(refreshTokens).values({
        ...me, sessionId: s!.id, familyId: s!.familyId,
        tokenHash: crypto.randomUUID(), expiresAt: new Date(NOW.getTime() + 60_000),
      });
      return s!;
    };
    const caller = await mkSession({ lastTwofaAt: NOW });
    for (let i = 0; i < 3; i++) await mkSession();

    // A handle whose FIRST refresh-token update dies — the refresh sweep, after the claim,
    // wherever it runs (autocommit or inside a transaction: `transaction` is intercepted so the
    // tx handle is wrapped the same way).
    const failingWrap = (handle: object, state: { updates: number }): object =>
      new Proxy(handle, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (p === "update") {
            return (...a: unknown[]) => {
              if (getTableName(a[0] as Table) === "refresh_tokens" && ++state.updates === 1) {
                throw new Error("chunk killed mid-sweep (test)");
              }
              return (t as Tx).update(...(a as [never]));
            };
          }
          if (p === "transaction") {
            return (fn: (tx: object) => unknown, ...rest: unknown[]) =>
              (t as unknown as { transaction: (f: (tx: object) => unknown, ...r: unknown[]) => unknown })
                .transaction((tx) => fn(failingWrap(tx, state)), ...rest);
          }
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });

    const svc = makeSessionLifecycle({ config: makeTestAuthDeps().config });
    const ctx = (handle: object): ServiceContext => ({
      db: handle as unknown as ServiceContext["db"],
      accountId: me.accountId, userId: me.userId, sessionId: caller.id,
      now: () => NOW, requestId: "converge", ip: "1.2.3.4",
    });

    // Attempt 1 dies mid-sweep…
    await expect(svc.revokeWebSessions(ctx(failingWrap(db as object, { updates: 0 }))))
      .rejects.toThrow("chunk killed mid-sweep");
    // …and left nothing half-done: either everything rolled back (the fix) or — the pre-fix
    // red — sessions revoked with tokens alive, which the retry below can then never finish.
    // Attempt 2, clean handle: the verb converges to fully-revoked.
    const retry = await svc.revokeWebSessions(ctx(db as object));
    expect(retry.revoked).toBe(3);

    const liveSessions = await db.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.userId, me.userId), isNull(sessions.revokedAt)));
    expect(liveSessions.map((r) => r.id)).toEqual([caller.id]);
    const liveTokens = await db.select({ sessionId: refreshTokens.sessionId }).from(refreshTokens)
      .where(and(eq(refreshTokens.userId, me.userId), isNull(refreshTokens.revokedAt)));
    expect(liveTokens.map((t) => t.sessionId)).toEqual([caller.id]);
  });
});
