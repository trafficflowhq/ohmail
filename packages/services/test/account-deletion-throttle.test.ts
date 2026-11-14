import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { users } from "@trafficflow/db";
import {
  authThrottle, AUTH_THROTTLE_RETENTION_MS, PROBE_BUDGET, probeRowsOfAccount, spendProbeBudget,
} from "@trafficflow/db/cloud";
import { eq } from "drizzle-orm";
import {
  deleteAccount, makeTestAuthDeps, throttleKeysFor, DEFAULT_AUTH_CONFIG, LIVE_BODY_WINDOW_MS, type ServiceContext,
} from "../src/index.js";
import { NOTICE_EVERY_MS } from "../src/auth/auth-service.js";
import { NOW, seedFullAccount } from "./helpers/erasure-fixture.js";

/**
 * ERASURE REACHES EVERY THROTTLE ROW THAT NAMES THE ACCOUNT'S PEOPLE, including the ones keyed by a
 * hash of their address that no `users` join can build in SQL — and spares a neighbour's. Plus the
 * pin that keeps it true: every throttle policy fits under the prune's one retention constant.
 * That both doors hand the keyer over, and say whether refunds drain, is held at the doors:
 * `packages/api/test/account-delete.test.ts` and `internal-account-lifecycle.test.ts`.
 */
const keys = throttleKeysFor(makeTestAuthDeps().keyProvider);
/** One login typed into both accounts' connect forms: their probe rows differ by the account alone. */
const typed = keys.address("typed@example.invalid");
/** A key's family words, never its hashes or ids: `imap:mailbox:probe:smtp`, `pw`, `email`. */
const family = (k: string): string => k.split(":").filter((s) => /^[a-z-]+$/.test(s)).join(":");

function families(accountId: string, userId: string, email: string): string[] {
  const hA = keys.address(email);
  const hC = keys.client("10.0.0.1");
  return [
    `pw:${hA}:${hC}`, `pwa:${hA}`, `known:${hA}:${hC}`, `user:${userId}`, `factor-day:${userId}`,
    `notice:factor:${userId}`, `notice:ceiling:${hA}`, `email:${email}`,
    // The mail quota's two budgets for the address (`mail-service.ts`).
    `mail:unsolicited:${hA}`, `mail:transactional:${hA}`,
    // The connect probes' slots, IMAP and SMTP (`imap-probe.ts`).
    `imap:mailbox:probe:${typed}:${accountId}`, `imap:mailbox:probe:smtp:${typed}:${accountId}`,
    // Load it now's admission, by the account's keyed hash (`live-body-admit.ts`).
    `live-body:${keys.client(accountId)}`,
  ];
}

describe("erasure and the sign-in throttle", () => {
  it("removes every family for the account's addresses and spares another address's rows", async () => {
    const db = await makeTestDb();
    const mine = await seedFullAccount(db, "Erased");
    const theirs = await seedFullAccount(db, "Kept");
    const emailOf = async (id: string) => (await db.select({ e: users.email }).from(users).where(eq(users.id, id)))[0]!.e;
    await db.delete(authThrottle);
    // The probes' budget rows, by their own writer: the typed login's windows and the account's.
    for (const a of [mine, theirs]) {
      expect(await spendProbeBudget(db, { accountId: a.accountId, target: typed, now: NOW })).toBeNull();
    }
    const budgetOf = async (accountId: string) => (await db.select({ key: authThrottle.key }).from(authThrottle))
      .map((r) => r.key).filter((k) => k.endsWith(`:${accountId}`));
    const myKeys = [...families(mine.accountId, mine.userId, await emailOf(mine.userId)), ...await budgetOf(mine.accountId)];
    const theirKeys = [...families(theirs.accountId, theirs.userId, await emailOf(theirs.userId)), ...await budgetOf(theirs.accountId)];
    expect(myKeys.filter((k) => k.startsWith("probe-rate:")), "the spend wrote no rows").toHaveLength(4);
    await db.insert(authThrottle).values([...myKeys, ...theirKeys].filter((k) => !k.startsWith("probe-rate:"))
      .map((key) => ({ key, failures: 1 })));

    const ctx: ServiceContext = { db, accountId: mine.accountId, userId: mine.userId, now: () => NOW, requestId: "del" };
    await deleteAccount(ctx, { throttleKeys: keys });

    const left = new Set((await db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key));
    for (const k of myKeys) expect(left.has(k), `left behind: ${family(k)}`).toBe(false);
    for (const k of theirKeys) expect(left.has(k), `a neighbour's row went: ${family(k)}`).toBe(true);
  });

  it("matches an account id as written: LIKE's wildcards in it match nothing else", async () => {
    const db = await makeTestDb();
    await db.delete(authThrottle);
    // A trailing escape character, unescaped, is an error; `_` and `%`, unescaped, match `aXbYYc`.
    const id = "a_b%c\\";
    const gone = [`imap:mailbox:probe:h:${id}`, `probe-rate:a:60:${id}`];
    const kept = ["imap:mailbox:probe:h:aXbYYc\\", `imap:mailbox:probe:h:${id}d`, "probe-rate:a:60:aXbYYc\\"];
    await db.insert(authThrottle).values([...gone, ...kept].map((key) => ({ key, failures: 0 })));
    await db.delete(authThrottle).where(probeRowsOfAccount(id));
    expect((await db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key).sort())
      .toEqual(kept.sort());
  });

  it("every throttle policy fits under the prune's one retention", () => {
    const c = DEFAULT_AUTH_CONFIG;
    const spans = {
      password: c.failureWindowMs + c.lockoutMs,
      addressCeiling: c.failureWindowMs * 2,
      factorDay: c.factorDayMs * 2,
      notice: NOTICE_EVERY_MS,
      mail: 60 * 60_000,
      probe: Math.max(...[...PROBE_BUDGET.target, ...PROBE_BUDGET.account].map((w) => w.windowMs)),
      liveBody: LIVE_BODY_WINDOW_MS,
    };
    for (const [name, ms] of Object.entries(spans)) expect(ms, name).toBeLessThanOrEqual(AUTH_THROTTLE_RETENTION_MS);
  });
});
