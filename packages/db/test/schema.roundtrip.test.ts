import { describe, it, expect } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { mailboxes, messages, folderState } from "../src/index.js";
import { eq } from "drizzle-orm";

describe("schema round-trip", () => {
  it("persists a mailbox, message, and folder state", async () => {
    const db = await makeTestDb();
    const acct = "00000000-0000-0000-0000-000000000001";
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct, provider: "imap", address: "mila@lichtgrat.example" }).returning();
    const [msg] = await db.insert(messages).values({
      accountId: acct, mailboxId: mb.id, messageIdHeader: "abc@x", bodyHash: "deadbeef",
      dedupKey: "mid:abc@x", subject: "Hi", fromAddress: "a@b.example",
    }).returning();
    await db.insert(folderState).values({
      messageId: msg.id, accountId: msg.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });

    const got = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(got[0].dedupKey).toBe("mid:abc@x");
    expect(got[0].noForward).toBe(false);
  });
});
