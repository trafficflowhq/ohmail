import { accountOfMessage } from "../src/parent-account.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { whyTheyStayed, WHY_STAYED_IDS_MAX } from "../src/why-stayed.js";
import { accounts, drafts, folderState, mailboxes, messageStates, messages, threads } from "../src/schema.js";
import type { Tx } from "../src/change-log.js";

/**
 * WHY A ROW STAYED, BY THE PASS'S OWN FACTS: a failed check, a triage state, a reply (a draft
 * answering it, or a Sent reply in its thread), a filing made in another mail app. A row ohmail
 * filed itself with none of those answers nothing, and so does another account's row.
 */
const OWN = "me@home.example";
const THEM = "letters@vendor.example";

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ws-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: OWN }).returning({ id: mailboxes.id });
  const msg = async (o: { setBy?: string; auth?: string; from?: string; threadId?: string; account?: string; mailbox?: string } = {}) => {
    const [m] = await db.insert(messages).values({
      accountId: o.account ?? accountId, mailboxId: o.mailbox ?? mb!.id, bodyHash: "h", dedupKey: randomUUID(), subject: "s",
      fromAddress: o.from ?? THEM, unread: false, authVerdict: o.auth ?? null, threadId: o.threadId ?? null,
      ...(o.from === OWN ? { toAddresses: [{ name: null, address: THEM }] } : {}),
    }).returning({ id: messages.id });
    await db.insert(folderState).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: "ohmail/News", observedFolder: "ohmail/News",
      lastSetBy: o.setBy ?? "us", reconcileStatus: "reconciled", conflict: false });
    return m!.id;
  };
  return { db, accountId, mailboxId: mb!.id, msg };
}

describe("why a row stayed", () => {
  it("names each class by the pass's facts, and nothing for a row ohmail filed", async () => {
    const w = await world();
    const plain = await w.msg();
    const external = await w.msg({ setBy: "external" });
    const failed = await w.msg({ auth: "fail", setBy: "external" });
    const triaged = await w.msg();
    await w.db.insert(messageStates).values({ accountId: w.accountId, messageId: triaged, state: "set_aside" });
    const drafted = await w.msg();
    await w.db.insert(drafts).values({ accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: drafted } as never);
    const [th] = await w.db.insert(threads).values({ accountId: w.accountId, subject: "s" }).returning({ id: threads.id });
    const answered = await w.msg({ threadId: th!.id });
    await w.msg({ from: OWN, threadId: th!.id });

    const got = await whyTheyStayed(w.db, w.accountId, [plain, external, failed, triaged, drafted, answered], [OWN]);
    expect(Object.fromEntries(got)).toEqual({
      [external]: "filed-elsewhere", [failed]: "failed-checks", [triaged]: "set-aside",
      [drafted]: "replied", [answered]: "replied",
    });
  });

  it("answers nothing for another account's row, and bounds the ask", async () => {
    const w = await world();
    const otherAccount = randomUUID();
    await w.db.insert(accounts).values({ id: otherAccount, name: "other" });
    const [ob] = await w.db.insert(mailboxes).values({ accountId: otherAccount, provider: "imap", address: "x@other.example" })
      .returning({ id: mailboxes.id });
    const theirs = await w.msg({ setBy: "external", account: otherAccount, mailbox: ob!.id });
    expect((await whyTheyStayed(w.db, w.accountId, [theirs], [OWN])).size).toBe(0);
    const many = await Promise.all(Array.from({ length: WHY_STAYED_IDS_MAX + 1 }, () => w.msg({ setBy: "external" })));
    expect((await whyTheyStayed(w.db, w.accountId, many, [OWN])).size).toBe(WHY_STAYED_IDS_MAX);
  });
});
