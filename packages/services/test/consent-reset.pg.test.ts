import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, accountSettings, changeLog, contacts, folderState, learningSignals, mailboxes, messages, routingDecisions, ruleRemovals, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { resetScreeningState, unmovedReport } from "../src/consent-reset.js";
import type { ServiceContext } from "../src/context.js";

/**
 * RESET SCREENING STATE, AGAINST REAL POSTGRES.
 *
 * The two properties that cannot be seen anywhere else:
 *
 *   · every deleted rule leaves a change-log row behind. `rule` is a synced entity, so a bulk
 *     DELETE that skipped the log would leave every mirror showing rules that no longer exist,
 *     with no event that could ever remove them. Nothing about the delete itself would look
 *     wrong.
 *   · `folder_state` is untouched. The reset restores an account's *decisions*, not its
 *     mailbox — un-making past moves would be thousands more moves, made on an assumption.
 */

const AVAILABLE = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");

const NOW = new Date("2026-08-05T09:00:00.000Z");
const ACCOUNT = randomUUID();
const OTHER = randomUUID();
let mailboxId = "";

const ctx: ServiceContext = {
  db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "consent-reset",
};

async function held(folder: string): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: ACCOUNT, mailboxId, bodyHash: randomUUID(), dedupKey: randomUUID(),
    fromAddress: `s-${randomUUID().slice(0, 8)}@example.com`, subject: "s", date: NOW, snippet: "",
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: folder, observedFolder: folder,
    lastSetBy: "us", reconcileStatus: "reconciled",
  });
  return m!.id;
}

async function folderSnapshot(): Promise<string[]> {
  const rows = await db.select({
    id: folderState.messageId, desired: folderState.desiredFolder,
    observed: folderState.observedFolder, status: folderState.reconcileStatus,
  }).from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(eq(messages.accountId, ACCOUNT));
  return rows.map((r) => `${r.id}|${r.desired}|${r.observed}|${r.status}`).sort();
}

describe.skipIf(!AVAILABLE)("resetting screening state keeps every message", () => {
  let before: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `reset-${ACCOUNT.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `reset-${ACCOUNT.slice(0, 8)}@example.com`,
    }).returning({ id: mailboxes.id });
    mailboxId = mb!.id;

    // Mail a past decision physically moved, plus mail that was never touched.
    const screenerIds = [await held("ohmail/Screener"), await held("ohmail/Screener")];
    await held("ohmail/News");
    await held("INBOX");

    for (const p of ["promoted", "manual", "seeded-from-sent"]) {
      await db.insert(rules).values({
        accountId: ACCOUNT, kind: "sender", match: `${p}@example.com`,
        destination: "INBOX", provenance: p, enabled: true,
      });
    }
    await db.insert(contacts).values([
      { accountId: ACCOUNT, address: "a@example.com" },
      { accountId: ACCOUNT, address: "b@example.com" },
    ]);
    // A bought Screener suggestion, and the routing audit — only the first is screening state.
    await db.insert(routingDecisions).values({
      accountId: ACCOUNT, messageId: screenerIds[0]!, inputProvenance: "screener_suggestion",
      destination: "INBOX", status: "suggestion",
    });
    await db.insert(routingDecisions).values({
      accountId: ACCOUNT, messageId: screenerIds[1]!, inputProvenance: "ai",
      destination: "ohmail/Screener", status: "auto_applied",
    });
    await db.insert(learningSignals).values([
      { accountId: ACCOUNT, triggeringActionId: `screener:${randomUUID()}`, kind: "screener", label: "positive" },
      { accountId: ACCOUNT, triggeringActionId: `approval:${randomUUID()}`, kind: "approval", label: "positive" },
    ]);
    // Removals the person recorded before starting over, and another account's, which stays.
    await db.insert(accounts).values({ id: OTHER, name: `reset-${OTHER.slice(0, 8)}` });
    for (const accountId of [ACCOUNT, OTHER]) {
      await db.insert(ruleRemovals).values({
        accountId, ruleKey: `["sender","removed@example.com","",""]`, kind: "sender", match: "removed@example.com", removedAt: NOW,
      });
    }

    before = await folderSnapshot();
  }, 120_000);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("reports what it will not un-move, before touching anything", async () => {
    const report = await unmovedReport(ctx);
    const byFolder = new Map(report.map((p) => [p.folder, p]));
    expect(byFolder.get("ohmail/Screener")!.messages).toBe(2);
    expect(byFolder.get("ohmail/Screener")!.observed).toBe(2);
    expect(byFolder.get("ohmail/News")!.messages).toBe(1);
    // INBOX is where mail already was — it is not somewhere a decision put it.
    expect(byFolder.has("INBOX")).toBe(false);
  });

  it("DELETES THE DECISIONS, TELLS THE CLIENTS, AND MOVES NO MAIL", async () => {
    const result = await resetScreeningState(ctx);

    expect(result.rulesDeleted).toBe(3);
    expect(result.contactsDeleted).toBe(2);
    expect(result.screenerSuggestionsDeleted).toBe(1);
    expect(result.learningSignalsDeleted).toBe(1);

    expect(await db.select().from(rules).where(eq(rules.accountId, ACCOUNT))).toHaveLength(0);
    expect(await db.select().from(contacts).where(eq(contacts.accountId, ACCOUNT))).toHaveLength(0);
    // A start-over is local by nature: no removal is recorded, and none recorded before is left to travel.
    expect(await db.select().from(ruleRemovals).where(eq(ruleRemovals.accountId, ACCOUNT))).toHaveLength(0);
    expect(await db.select().from(ruleRemovals).where(eq(ruleRemovals.accountId, OTHER))).toHaveLength(1);
    // The routing AUDIT survives: the reset moves nothing, so why each message sits where it
    // does is still true, and deleting it would erase the explanation for mail that stays put.
    const audit = await db.select().from(routingDecisions).where(eq(routingDecisions.accountId, ACCOUNT));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.inputProvenance).toBe("ai");
    // Screener learning goes; approval learning is a different axis and stays.
    const learning = await db.select().from(learningSignals).where(eq(learningSignals.accountId, ACCOUNT));
    expect(learning.map((l) => l.kind)).toEqual(["approval"]);

    // ONE DELETE EVENT PER RULE — without these the mirrors never stop showing them.
    const deletes = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, ACCOUNT), eq(changeLog.entityType, "rule"), eq(changeLog.op, "delete"),
    ));
    expect(deletes).toHaveLength(3);

    // …AND THE MAILBOX IS EXACTLY AS IT WAS.
    expect(await folderSnapshot()).toEqual(before);

    // The report describes state the reset deliberately left alone.
    expect(result.unmoved.find((p) => p.folder === "ohmail/Screener")!.messages).toBe(2);

    const [settings] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, ACCOUNT));
    expect(settings!.screeningResetAt).not.toBeNull();
    expect(settings!.seedConfirmedAt).toBeNull();
  });

  it("running it twice is a no-op, not a second round of events", async () => {
    const again = await resetScreeningState(ctx);
    expect(again.rulesDeleted).toBe(0);
    expect(again.contactsDeleted).toBe(0);
    const deletes = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, ACCOUNT), eq(changeLog.entityType, "rule"), eq(changeLog.op, "delete"),
    ));
    expect(deletes).toHaveLength(3);
    expect(await folderSnapshot()).toEqual(before);
  });
});
