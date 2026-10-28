import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { retentionPrunePass, signInRetentionPass } from "../src/retention-prune.js";
import { accounts, users, type Tx } from "@trafficflow/db";
import { connectAttempts, loginTokens } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger } from "@trafficflow/core";
import type { Logger } from "@trafficflow/core/mail";

/**
 * The pass's ONE promise of its own: it NEVER THROWS — a retention sweep must not take down a
 * worker that is syncing mail. The prune logic itself is measured on real Postgres in
 * `packages/db/test/retention-prune.pg.test.ts` and at the service seam in
 * `packages/services/test/sync-retention-floor.pg.test.ts`; this file drives the wrapper with a
 * database that fails at every depth and asserts the cycle would have survived it.
 */
function collectingLog(): { log: Logger; events: string[] } {
  const events: string[] = [];
  const log = {
    debug: (e: string) => { events.push(e); },
    info: (e: string) => { events.push(e); },
    warn: (e: string) => { events.push(e); },
    error: (e: string) => { events.push(e); },
  } as unknown as Logger;
  return { log, events };
}

describe("retentionPrunePass never throws", () => {
  it("a database that refuses the roster read is a logged warning, not a cycle abort", async () => {
    const db = {
      select: () => { throw new Error("host deployed ahead of mail 0122"); },
      execute: () => { throw new Error("unreachable"); },
    } as unknown as Tx;
    const { log, events } = collectingLog();
    await expect(retentionPrunePass(db, new Date(), log)).resolves.toBeUndefined();
    expect(events).toContain("retention_prune_failed");
  });

  it("a database that fails mid-account keeps the tick alive for the fixed-age prunes", async () => {
    // The roster answers one account; the per-account prune then throws (the ordinary
    // deployed-ahead-of-the-migration shape); the audit/auth batches still run and return 0.
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [{ id: "00000000-0000-4000-8000-000000000001" }],
    };
    const db = {
      select: () => chain,
      execute: async () => { throw new Error("42703: pruned_through_seq does not exist"); },
    } as unknown as Tx;
    const { log, events } = collectingLog();
    await expect(retentionPrunePass(db, new Date(), log)).resolves.toBeUndefined();
    // One warn per failing account, one per failing fixed-age prune — never a throw.
    expect(events.filter((e) => e === "retention_prune_account_failed")).toHaveLength(1);
    expect(events.filter((e) => e === "retention_prune_failed")).toHaveLength(3);
  });
});

describe("retentionPrunePass ages out connect attempts at 30 days (cloud 0054)", () => {
  it("a 31-day-old row goes, a 29-day-old one stays, and another account's row is untouched", async () => {
    const db = await makeTestDb();
    const now = new Date("2026-10-27T12:00:00.000Z");
    const ago = (days: number): Date => new Date(now.getTime() - days * 86_400_000);
    const [a] = await db.insert(accounts).values({ name: "A" }).returning();
    const [b] = await db.insert(accounts).values({ name: "B" }).returning();
    const row = { door: "test", preset: "imap", outcome: "ok" } as const;
    await db.insert(connectAttempts).values([
      { ...row, accountId: a!.id, at: ago(31) }, { ...row, accountId: a!.id, at: ago(29) },
      { ...row, accountId: b!.id, at: ago(29) },
    ]);
    const { log, events } = collectingLog();
    await retentionPrunePass(db as unknown as Tx, now, log);
    const left = await db.select({ accountId: connectAttempts.accountId, at: connectAttempts.at }).from(connectAttempts);
    expect(left.map((r) => [r.accountId, r.at.getTime()]).sort()).toEqual(
      [[a!.id, ago(29).getTime()], [b!.id, ago(29).getTime()]].sort());
    expect(events).toContain("retention_prune_connect_attempts");
  });
});

describe("signInRetentionPass says what a failed run had already deleted", () => {
  it("the session batch fails on its lock timeout: the tables cleared before it are counted in the log", async () => {
    const db = await makeTestDb();
    const [acct] = await db.insert(accounts).values({ name: "R" }).returning();
    const [user] = await db.insert(users).values({ accountId: acct!.id, email: `r+${randomUUID()}@example.test` }).returning();
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (let i = 0; i < 2; i++) await db.insert(loginTokens).values({ userId: user!.id, tokenHash: randomUUID(), expiresAt: old });
    // The deletes run on the real database; the session batch's transaction is refused as a held lock is.
    const refusing = new Proxy(db, {
      get(target, prop) {
        if (prop === "transaction") {
          return () => Promise.reject(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const lines: Array<Record<string, unknown>> = [];
    const log = createLogger({ service: "worker", level: "info", sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); } });
    await expect(signInRetentionPass(refusing as unknown as Tx, new Date(), log)).resolves.toBeUndefined();
    expect(lines.find((l) => l.event === "sign_in_retention_table")).toMatchObject({ table: "login_tokens", pruned: 2 });
    expect(lines.find((l) => l.event === "sign_in_retention_failed")).toMatchObject({ pruned: 2, cleared: 0 });
    expect(lines.some((l) => l.event === "sign_in_retention_pruned")).toBe(false);
  });
});
