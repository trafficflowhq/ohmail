import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import {
  accounts, bindDb, folderState, mailboxes, messageInstances, messages, routingDecisions, SCREENER_SUGGESTION_PROVENANCE,
} from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { AuthService, makeTestAuthDeps } from "../../../packages/services/src/auth/index.js";
import { fakeSpendPort } from "../../../packages/organizer/test/_spendport.js";
import { screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";

const available = await realPgAvailable();
const signupAt = new Date("2026-08-01T00:00:00Z");
const screener = "ohmail/Screener";

it.skipIf(!available)("prepares suggestions after managed signup within the new account's own budget", async () => {
  await runMigrations(PG_TEST_URL);
  const owned = makeOwnedDb(PG_TEST_URL);
  const { db } = owned;
  const address = () => [randomUUID(), "example.test"].join("@");
  async function receive(accountId: string, uid: number) {
    const [mailbox] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: address() }).returning();
    const mailboxId = mailbox!.id;
    const createdAt = new Date(signupAt.getTime() + uid * 1000);
    const [letter] = await db.insert(messages).values({
      accountId, mailboxId, createdAt, date: createdAt,
      bodyHash: "fixture", dedupKey: randomUUID(), subject: "First mail", fromAddress: address(),
      snippet: "Hello.", nativeLocator: { folder: screener, ref: `1:${uid}` },
    }).returning();
    const messageId = letter!.id;
    await db.insert(folderState).values({
      accountId, messageId, desiredFolder: screener, observedFolder: screener,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId, folder: screener, uidvalidity: 1n, uid, isPrimary: true,
    });
    return messageId;
  }
  try {
    const auth = new AuthService(makeTestAuthDeps({ autoSuggestAtSignup: true }));
    const { user } = await auth.register({
      db: bindDb(db, { account: null }),
      accountId: "", userId: null, now: () => signupAt, requestId: "signup", ip: null,
    }, {
      email: address(), displayName: "New user", password: "fixture-signup-password", inviteCode: "INVITE-OK",
    });
    const [other] = await db.insert(accounts).values({ name: "Other account" }).returning();
    await receive(other!.id, 1);
    const first = await receive(user.accountId, 2);
    await receive(user.accountId, 3);
    const credits = fakeSpendPort();
    credits.exclusive();
    credits.budget(1);
    const screen = vi.fn(async () => ({ destination: "ohmail/News" as const, rationale: "Newsletter", confidence: 0.9, spam: false }));

    const result = await screenerAutoSuggestPass(db, {
      accountId: user.accountId, credits, classifier: { screen, classify: screen },
    });
    expect(result).toMatchObject({ bought: 1, chargedAttempts: 1, stopped: "out_of_credits" });
    expect(screen).toHaveBeenCalledTimes(1);
    expect(new Set(credits.spends.map(({ accountId }) => accountId))).toEqual(new Set([user.accountId]));
    const stored = await db.select({ messageId: routingDecisions.messageId }).from(routingDecisions)
      .where(and(eq(routingDecisions.accountId, user.accountId), eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE)));
    expect(stored).toEqual([{ messageId: first }]);
    expect(await db.select({ messageId: routingDecisions.messageId }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, other!.id))).toEqual([]);
  } finally {
    await owned.close();
  }
}, 120_000);
