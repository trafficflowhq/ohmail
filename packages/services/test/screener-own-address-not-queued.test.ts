import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { ScreenerService } from "../src/screener-service.js";
import { cutlineCounts } from "../src/consent-cutline.js";
import type { ServiceContext } from "../src/context.js";

/**
 * `GET /screener` NEVER LISTS THE ACCOUNT ITSELF (ruling 2026-09-25, row OWN-ADDRESS-GATE-ROW-IS-STILL-A-QUEUE-ROW).
 *
 * The phone's Cloud and paired doors take this page as the waiting shelf exactly, so a message
 * from one of the account's own mailbox addresses sitting at the gate was a row there, with
 * Allow and Screen out, while `cutlineCounts` beside it counted nobody. Both now ask
 * `senderIsOwnSql`. Watch it fail: drop the `not senderIsOwnSql(…)` term from `heldSenderPage`.
 */

const GATE = "ohmail/Screener";
const NOW = new Date("2026-09-25T12:00:00.000Z");
const RECENT = new Date("2026-09-24T09:00:00.000Z");

async function seed() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  await db.insert(accounts).values({ id: accountId, name: `own-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own, organizerRole: "organizer",
  }).returning();
  let n = 0;
  const held = async (from: string): Promise<void> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `own:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: from, date: RECENT, unread: true,
      createdAt: RECENT, nativeLocator: { folder: GATE, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  // The account's own address, spelled as a client might write it, and one stranger beside it.
  await held(own.toUpperCase());
  await held("stranger@x.test");
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null, now: () => NOW, requestId: `own-${randomUUID().slice(0, 8)}`,
  };
  return { db, accountId, own, ctx };
}

const listed = async (ctx: ServiceContext): Promise<string[]> =>
  (await new ScreenerService({}).list(ctx, { limit: 100 })).items.map((i) => i.sender.address.toLowerCase()).sort();

const counted = async (ctx: ServiceContext): Promise<number> =>
  (await cutlineCounts(ctx, { baselineAt: null, dormancyDays: 60 })).activeUndecidedSenders;

describe("the queue page and the count agree that the account is nobody's first-time sender", () => {
  it("own mail at the gate is not a queue row; the stranger beside it is", async () => {
    const { ctx } = await seed();
    expect(await listed(ctx)).toEqual(["stranger@x.test"]);
    expect(await counted(ctx)).toBe(1);
  });

  it("POSITIVE CONTROL — once the address is no longer one of the account's, it is a row again", async () => {
    const { db, accountId, own, ctx } = await seed();
    await db.update(mailboxes).set({ address: "elsewhere@ohmail.test" })
      .where(and(eq(mailboxes.accountId, accountId), eq(mailboxes.address, own)));
    expect(await listed(ctx)).toEqual([own, "stranger@x.test"].sort());
    expect(await counted(ctx)).toBe(2);
  });
});
