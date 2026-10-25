import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mailboxes, messages, folderState, rules, contacts } from "../src/index.js";
import { makeDb, closeDb } from "../src/cloud.js";
import { runMigrations } from "../src/migrate.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { pgTestUrl } from "../src/testing.js";

const URL = pgTestUrl(import.meta.url);
const ACCT = randomUUID(); // fresh account per run → idempotent against the persistent test DB

describe("schema extension (rules, contacts, folder_state upsert)", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => { await closeDb(); });

  it("persists rules and contacts and upserts folder_state by message_id", async () => {
    const db = makeDb(URL);
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: ACCT, provider: "imap", address: "mila@lichtgrat.example" }).returning();
    const [msg] = await db.insert(messages).values({
      accountId: ACCT, mailboxId: mb.id, messageIdHeader: "u@x", bodyHash: "h",
      dedupKey: "mid:u@x", subject: "s", fromAddress: "a@b.example",
    }).returning();

    await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: "a@b.example", destination: "INBOX", priority: 5 });
    await db.insert(contacts).values({ accountId: ACCT, address: "a@b.example" });

    // upsert folder_state twice on the same message → single row, updated values
    await db.insert(folderState)
      .values({ messageId: msg.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" })
      .onConflictDoUpdate({ target: folderState.messageId, set: { observedFolder: "ohmail/News" } });
    await db.insert(folderState)
      .values({ messageId: msg.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" })
      .onConflictDoUpdate({ target: folderState.messageId, set: { observedFolder: "ohmail/Screened" } });

    const fs = await db.select().from(folderState).where(eq(folderState.messageId, msg.id));
    expect(fs).toHaveLength(1);
    expect(fs[0].observedFolder).toBe("ohmail/Screened");

    const rs = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(rs[0].match).toBe("a@b.example");
  });
});
