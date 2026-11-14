import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messages } from "@trafficflow/db";
import { MessageService, type ServiceContext } from "@trafficflow/services";

/**
 * A SCREENER CARD'S MOVE BY ID IS CONDITIONAL (`from`): the server applies it only while the letter
 * is still where the card counted it. A press replayed after the person filed the letter elsewhere
 * is refused `stale_press` and leaves it where they put it; an unconditional move is unchanged.
 * Run in both projects (PGlite here, `pnpm test:sqlite`).
 */

const svc = new MessageService();
const t0 = new Date("2026-10-10T09:00:00.000Z");
type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seed(at: string): Promise<{ db: Db; ctx: ServiceContext; id: string }> {
  const db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "card-move" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: "person@example.test", organizeConsentedAt: t0,
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId: a!.id, mailboxId: mb!.id, dedupKey: "mid:<card@example.test>", messageIdHeader: "<card@example.test>",
    fromAddress: "stranger@example.test", subject: "s", date: t0, bodyHash: "h", nativeLocator: { folder: at, ref: "1:1" },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: at, observedFolder: at, lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
  });
  return { db, ctx: { db, accountId: a!.id, userId: null, now: () => t0, requestId: "r" } as ServiceContext, id: m!.id };
}

const desired = async (db: Db, id: string) =>
  (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "applied"; } catch (e) { return String((e as { code?: string }).code); }
};

describe("a card's move by id is conditional", () => {
  it("is applied while the letter is still where the card counted it", async () => {
    const w = await seed("INBOX");
    expect(await refusal(svc.move(w.ctx, w.id, { folder: "ohmail/News", from: "INBOX" }))).toBe("applied");
    expect(await desired(w.db, w.id)).toBe("ohmail/News");
  });

  it("is refused stale_press once the person filed the letter elsewhere, and leaves it there", async () => {
    const w = await seed("ohmail/Receipts");
    expect(await refusal(svc.move(w.ctx, w.id, { folder: "ohmail/News", from: "INBOX" }))).toBe("stale_press");
    expect(await desired(w.db, w.id)).toBe("ohmail/Receipts");
  });

  it("CONTROL: a move with no condition is unchanged", async () => {
    const w = await seed("ohmail/Receipts");
    expect(await refusal(svc.move(w.ctx, w.id, { folder: "ohmail/News" }))).toBe("applied");
    expect(await desired(w.db, w.id)).toBe("ohmail/News");
  });
});
