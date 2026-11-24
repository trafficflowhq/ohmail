import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accountOfMailbox, accountOfMessage, accounts, flagState, folderState, mailboxCredentials, mailboxFolders,
  mailboxes, messageBodies, messages, upsertDesiredSeen,
} from "../src/index.js";
import { ACCOUNT_NAMED_BY_EVERY_INSERT } from "../src/account-scope.js";
import { makeTestDb } from "../src/testing.js";

/**
 * EVERY INSERT INTO A TABLE THAT BORROWED ITS ACCOUNT NAMES THE ACCOUNT (mail 0201). A server holds
 * it with NOT NULL. A device's column is nullable, so there the rule is held by the test store,
 * which refuses the insert as a server would; this file is that refusal's proof on whichever
 * store the run is (the sqlite project runs it too), and the proof that a writer which has only
 * the parent's id stores the parent's account.
 */
async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "borrowers" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `b-${accountId}@example.test` }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, dedupKey: `mid:<${randomUUID()}@example.test>`, bodyHash: "b",
  }).returning();
  return { db, accountId, mailboxId: mb!.id, messageId: m!.id };
}

/** One insert per table, with the account or without it. */
function inserts(w: Awaited<ReturnType<typeof world>>, named: boolean): Record<(typeof ACCOUNT_NAMED_BY_EVERY_INSERT)[number], () => Promise<unknown>> {
  const account = named ? { accountId: w.accountId } : {};
  return {
    message_bodies: () => w.db.insert(messageBodies).values({ messageId: w.messageId, text: "t", ...account } as never),
    folder_state: () => w.db.insert(folderState).values({
      messageId: w.messageId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", ...account,
    } as never),
    flag_state: () => w.db.insert(flagState).values({ messageId: w.messageId, desiredSeen: true, observedSeen: true, lastSetBy: "us", ...account } as never),
    mailbox_credentials: () => w.db.insert(mailboxCredentials).values({
      mailboxId: w.mailboxId, transport: "imap", secretEnc: "sealed", keyVersion: 1, ...account,
    } as never),
    mailbox_folders: () => w.db.insert(mailboxFolders).values({ mailboxId: w.mailboxId, folder: "INBOX", ...account } as never),
  };
}

describe("an insert into a table that borrowed its account", () => {
  it("is refused on this store when it does not name the account, table by table", async () => {
    const w = await world();
    const unnamed = inserts(w, false);
    for (const table of ACCOUNT_NAMED_BY_EVERY_INSERT) {
      await expect(unnamed[table](), table).rejects.toThrow();
    }
  });

  it("is stored when it names it", async () => {
    const w = await world();
    const named = inserts(w, true);
    for (const table of ACCOUNT_NAMED_BY_EVERY_INSERT) await named[table]();
    const tables = {
      message_bodies: messageBodies, folder_state: folderState, flag_state: flagState,
      mailbox_credentials: mailboxCredentials, mailbox_folders: mailboxFolders,
    } as const;
    for (const table of ACCOUNT_NAMED_BY_EVERY_INSERT) {
      const rows = await w.db.select({ a: tables[table].accountId }).from(tables[table]);
      expect(rows.map((r) => r.a), table).toEqual([w.accountId]);
    }
  });

  it("a writer that holds only the parent's id stores the parent's account", async () => {
    const w = await world();
    // The read-state door takes a message id and no account.
    await upsertDesiredSeen(w.db as never, w.messageId, false, true, new Date("2026-11-14T10:00:00Z"));
    const [flag] = await w.db.select({ a: flagState.accountId }).from(flagState).where(eq(flagState.messageId, w.messageId));
    expect(flag!.a).toBe(w.accountId);
    await w.db.insert(folderState).values({
      messageId: w.messageId, accountId: accountOfMessage(w.messageId), desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    await w.db.insert(mailboxFolders).values({ mailboxId: w.mailboxId, accountId: accountOfMailbox(w.mailboxId), folder: "Archive" });
    const [filed] = await w.db.select({ a: folderState.accountId }).from(folderState).where(eq(folderState.messageId, w.messageId));
    const [folder] = await w.db.select({ a: mailboxFolders.accountId }).from(mailboxFolders).where(eq(mailboxFolders.mailboxId, w.mailboxId));
    expect([filed!.a, folder!.a]).toEqual([w.accountId, w.accountId]);
  });

  it("a parent that is not there gives no account, and the insert is refused", async () => {
    const w = await world();
    await expect(w.db.insert(folderState).values({
      messageId: randomUUID(), accountId: accountOfMessage(randomUUID()), desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    })).rejects.toThrow();
  });
});
