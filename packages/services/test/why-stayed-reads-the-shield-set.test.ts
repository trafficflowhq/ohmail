import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accounts, folderState, mailboxes, messages, threads, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { whyStayed } from "../src/why-stayed-service.js";

/**
 * THE SHEET NAMES THE SHIELD'S OWN FACTS. The backlog pass keeps a conversation the person answered,
 * and its we-answered shield counts a reply sent from a mailbox they later removed; so the sheet
 * asked why that message stayed says "replied" too. The control: the same thread with nobody's
 * reply in it answers nothing.
 */
async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ws-${accountId.slice(0, 8)}` });
  const [main] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "main@stayed.invalid" }).returning();
  const [old] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "old@stayed.invalid", status: "disabled", disabledReason: null,
  }).returning();
  const [th] = await db.insert(threads).values({ accountId, subject: "hello" }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: main!.id, bodyHash: "h", dedupKey: randomUUID(), subject: "hello",
    fromAddress: "friend@elsewhere.invalid", threadId: th!.id,
  }).returning();
  await db.insert(folderState).values({ messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false });
  const reply = () => db.insert(messages).values({
    accountId, mailboxId: old!.id, bodyHash: "h", dedupKey: randomUUID(), subject: "Re: hello",
    fromAddress: "old@stayed.invalid", toAddresses: [{ name: null, address: "friend@elsewhere.invalid" }], threadId: th!.id,
  });
  return { db, accountId, id: m!.id, reply };
}

describe("why a row stayed, by the shield's own set", () => {
  it("a reply sent from a since-removed mailbox reads as replied", async () => {
    const w = await world();
    await w.reply();
    expect(await whyStayed(w.db, w.accountId, [w.id])).toEqual([{ id: w.id, why: "replied" }]);
  });

  it("CONTROL: the same thread with no reply in it answers nothing", async () => {
    const w = await world();
    expect(await whyStayed(w.db, w.accountId, [w.id])).toEqual([]);
  });
});
