import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, users } from "../src/schema-mail.js";
import { loginTokens, oauthAuthCodes, platformSignals, pushSubscriptions } from "../src/schema-cloud.js";
import { makeTestDb } from "../src/testing.js";

/**
 * WHAT CLOUD 0103 MAKES THE STORE REFUSE. Each of these was accepted before it: a second row under
 * one secret's hash, a wake registration for an account that does not exist, and, the other way
 * round, a platform's name other than the one host the list was closed to.
 */
const LATER = new Date(Date.now() + 3_600_000);

async function world() {
  const db = await makeTestDb();
  const [acct] = await db.insert(accounts).values({ name: "keys" }).returning();
  const [user] = await db.insert(users).values({ accountId: acct!.id, email: `k-${acct!.id}@example.test` }).returning();
  return { db, accountId: acct!.id, userId: user!.id };
}

/** The driver's error carries the SQLSTATE on itself or on its cause, by driver. */
const stateOf = async (attempt: Promise<unknown>): Promise<string> => {
  try { await attempt; return "accepted"; } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "refused without a state";
  }
};

describe("the keys cloud 0103 added", () => {
  it("a secret's look-up hash answers for one row", async () => {
    const { db, accountId, userId } = await world();
    const token = { userId, accountId, tokenHash: `th-${randomUUID()}`, expiresAt: LATER };
    await db.insert(loginTokens).values(token);
    expect(await stateOf(db.insert(loginTokens).values(token))).toBe("23505");
    const code = {
      userId, accountId, clientId: "desktop", codeHash: `ch-${randomUUID()}`, codeChallenge: "cc",
      redirectUri: "ohmail://cb", expiresAt: LATER,
    };
    await db.insert(oauthAuthCodes).values(code);
    expect(await stateOf(db.insert(oauthAuthCodes).values(code))).toBe("23505");
  });

  it("a wake registration names an account that exists", async () => {
    const { db, accountId } = await world();
    const row = { transport: "webpush", endpoint: `https://push.example.test/${randomUUID()}`, p256dh: "p", auth: "a" };
    expect(await stateOf(db.insert(pushSubscriptions).values({ ...row, accountId }))).toBe("accepted");
    expect(await stateOf(db.insert(pushSubscriptions).values({
      ...row, endpoint: `${row.endpoint}-2`, accountId: randomUUID(),
    }))).toBe("23503");
  });

  it("a platform's name is a word of the shape, whichever platform it is", async () => {
    const { db } = await world();
    const at = (n: number): Date => new Date(Date.UTC(2026, 0, 1, 0, n));
    const row = (provider: string, n: number) => db.insert(platformSignals).values({ provider, project: "ohmail-api", windowStart: at(n) });
    expect(await stateOf(row("vercel", 0))).toBe("accepted");
    expect(await stateOf(row("railway", 1))).toBe("accepted");
    expect(await stateOf(row("fly-io", 2))).toBe("accepted");
    for (const [n, word] of ["Railway", "rail way", "", "9lives", "a".repeat(33)].entries()) {
      expect(await stateOf(row(word, 10 + n)), JSON.stringify(word)).toBe("23514");
    }
  });
});
