import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messages, rules, type Tx } from "@trafficflow/db";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * THE RETRO KEYS A RULE THE WAY THE ROUTER DOES — `ruleMatchKey`, spaces only. A rule stored with
 * a TAB before the address files nobody's new mail, and the retro still walked that sender's filed
 * mail as the rule's candidates (the router's re-evaluation kept it). Both halves: the tab-padded
 * rule examines and moves nothing, a space-padded one moves its sender.
 */

const NOW = new Date("2026-09-20T12:00:00Z");
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

async function world(match: string): Promise<{ db: Tx; accountId: string; messageId: string }> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `key-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "hello", fromAddress: "anna@x.test", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  await db.insert(rules).values({
    accountId, kind: "sender", match, destination: "ohmail/News", provenance: "manual", enabled: true,
    retroRequestedAt: new Date("2026-09-20T10:00:00Z"),
  });
  return { db, accountId, messageId: m!.id };
}

const retro = async (match: string): Promise<{ examined: number; desired: string }> => {
  const w = await world(match);
  const res = await ruleRetroPass(w.db, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW);
  const [row] = await w.db.select({ d: folderState.desiredFolder }).from(folderState)
    .where(eq(folderState.messageId, w.messageId));
  return { examined: res.examined, desired: row!.d };
};

describe("rule-retro reads a padded match as the router does", () => {
  it("a tab-padded rule has no candidates", async () => {
    expect(await retro("\tanna@x.test")).toEqual({ examined: 0, desired: "INBOX" });
  });

  it("CONTROL: a space-padded rule moves its sender's mail", async () => {
    expect(await retro("  Anna@x.test ")).toEqual({ examined: 1, desired: "ohmail/News" });
  });
});
