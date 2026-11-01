import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { makeTestDb } from "@trafficflow/db/testing";
import { users } from "@trafficflow/db";
import { authThrottle, AUTH_THROTTLE_RETENTION_MS } from "@trafficflow/db/cloud";
import { eq } from "drizzle-orm";
import { deleteAccount, makeTestAuthDeps, throttleKeysFor, DEFAULT_AUTH_CONFIG, type ServiceContext } from "../src/index.js";
import { NOTICE_EVERY_MS } from "../src/auth/auth-service.js";
import { NOW, seedFullAccount } from "./helpers/erasure-fixture.js";

/**
 * ERASURE REACHES EVERY THROTTLE ROW THAT NAMES THE ACCOUNT'S PEOPLE, including the ones keyed by a
 * hash of their address that no `users` join can build in SQL — and spares a neighbour's. Plus the
 * two pins that keep it true: both production callers hand the keyer over (parsed for the CALL),
 * and every throttle policy fits under the prune's one retention constant.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const keys = throttleKeysFor(makeTestAuthDeps().keyProvider);

function families(userId: string, email: string): string[] {
  const hA = keys.address(email);
  const hC = keys.client("10.0.0.1");
  return [
    `pw:${hA}:${hC}`, `pwa:${hA}`, `known:${hA}:${hC}`, `user:${userId}`, `factor-day:${userId}`,
    `notice:factor:${userId}`, `notice:ceiling:${hA}`, `email:${email}`,
    // The mail quota's two budgets for the address (`mail-service.ts`).
    `mail:unsolicited:${hA}`, `mail:transactional:${hA}`,
  ];
}

describe("erasure and the sign-in throttle", () => {
  it("removes every family for the account's addresses and spares another address's rows", async () => {
    const db = await makeTestDb();
    const mine = await seedFullAccount(db, "Erased");
    const theirs = await seedFullAccount(db, "Kept");
    const emailOf = async (id: string) => (await db.select({ e: users.email }).from(users).where(eq(users.id, id)))[0]!.e;
    const myKeys = families(mine.userId, await emailOf(mine.userId));
    const theirKeys = families(theirs.userId, await emailOf(theirs.userId));
    await db.delete(authThrottle);
    await db.insert(authThrottle).values([...myKeys, ...theirKeys].map((key) => ({ key, failures: 1 })));

    const ctx: ServiceContext = { db, accountId: mine.accountId, userId: mine.userId, now: () => NOW, requestId: "del" };
    await deleteAccount(ctx, { throttleKeys: keys });

    const left = new Set((await db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key));
    for (const k of myKeys) expect(left.has(k), `left behind: ${k.split(":")[0]}`).toBe(false);
    for (const k of theirKeys) expect(left.has(k), `a neighbour's row went: ${k.split(":")[0]}`).toBe(true);
  });

  it("both production callers hand the keyer to the erasure, and say whether refunds drain", () => {
    const root = join(HERE, "..", "..", "..");
    const callers = ["packages/api/src/routes/account.ts", "packages/services/src/account-lifecycle-pass.ts"];
    for (const rel of callers) {
      const src = ts.createSourceFile(rel, readFileSync(join(root, rel), "utf8"), ts.ScriptTarget.Latest, true);
      const calls: ts.CallExpression[] = [];
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "deleteAccount") calls.push(n);
        ts.forEachChild(n, walk);
      };
      walk(src);
      expect(calls.length, `${rel}: no deleteAccount call`).toBeGreaterThan(0);
      for (const c of calls) {
        const opts = c.arguments[1];
        // `drainsRefunds` too: absent, a metered host's erasure would drop a refund still owed.
        for (const key of ["throttleKeys", "drainsRefunds"]) {
          const named = opts !== undefined && ts.isObjectLiteralExpression(opts)
            && opts.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === key);
          expect(named, `${rel}: deleteAccount without ${key}`).toBe(true);
        }
      }
    }
  });

  it("every throttle policy fits under the prune's one retention", () => {
    const c = DEFAULT_AUTH_CONFIG;
    const spans = {
      password: c.failureWindowMs + c.lockoutMs,
      addressCeiling: c.failureWindowMs * 2,
      factorDay: c.factorDayMs * 2,
      notice: NOTICE_EVERY_MS,
      mail: 60 * 60_000,
    };
    for (const [name, ms] of Object.entries(spans)) expect(ms, name).toBeLessThanOrEqual(AUTH_THROTTLE_RETENTION_MS);
  });
});
