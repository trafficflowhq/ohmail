import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, messageFailures } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { dbFor, makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * MailboxDTO.setAside — HOW MANY OF THIS MAILBOX'S MESSAGES ARE SET ASIDE. The managed web reads it
 * for the desktop's and phone's own sentence. It counts unresolved `message_failures` rows of THIS
 * mailbox, one per message: a resolved row (re-read, gone, or voided by a UIDVALIDITY reset) and
 * another mailbox's row are not counted. PGlite: a question of which rows one count reads.
 */
const NOW = new Date("2026-10-07T06:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP });
type Db = Awaited<ReturnType<typeof makeTestDb>>;
const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" });

async function seed(db: Db, address: string): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await db.insert(accounts).values({ name: "set-aside" }).returning();
  const [mb] = await db.insert(mailboxes).values({ accountId: a!.id, provider: "imap", address }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}
const row = (ids: { accountId: string; mailboxId: string }, uid: number, resolvedAt: Date | null = null) => ({
  accountId: ids.accountId, mailboxId: ids.mailboxId, folder: "Archive", uidvalidity: 300n, uid,
  code: "mime_too_large", attempts: 1, firstFailedAt: NOW, lastFailedAt: NOW, resolvedAt,
});

describe("MailboxDTO.setAside — the messages this mailbox set aside", () => {
  it("is 0 with nothing set aside, and 0 is an answer", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, "one@example.test");
    expect((await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).setAside).toBe(0);
  });

  it("counts this mailbox's unresolved rows, and neither a resolved row nor another mailbox's", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, "two@example.test");
    const other = await seed(db, "other@example.test");
    await db.insert(messageFailures).values([
      row(ids, 9), row(ids, 10), row(ids, 11, NOW), row(other, 9),
    ]);
    expect((await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).setAside).toBe(2);
    expect((await svc.get(ctxFor(db, other.accountId), other.mailboxId)).setAside).toBe(1);
  });
});
