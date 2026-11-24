import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { UNMETERED_ACCESS, accounts, mailboxes, messages, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";
import { mailboxErasurePass } from "../src/mailbox-erasure-pass.js";
import { greenmailPorts } from "../../../packages/organizer/test/_greenmail-ports.js";

/**
 * ERASING OHMAIL'S COPY LEAVES THE MAIL SERVER AS IT WAS — the whole erase, as the product runs
 * it: the removal door with the typed address, then the worker pass until it is done. Two
 * mailboxes, one of thousands of messages; the other keeps every row. The IMAP fixture is counted from
 * the SERVER before and after, because "nothing on your mail server is touched" is the claim the
 * confirmation makes. A mistyped address is refused before anything moves.
 */

const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-23T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 5), 1);
const svc = makeMailboxService({ keyProvider: KP, accessOf: async () => UNMETERED_ACCESS });
let client: ReturnType<typeof postgres>;
let db: Tx;

const imapFor = (user: string) => {
  const p = greenmailPorts();
  return new ImapFlow({
    host: p.imapHost, port: p.imapPort, secure: false, auth: { user, pass: "test" }, logger: false,
  });
};
async function serverCount(user: string): Promise<{ inbox: number; folders: number }> {
  const c = imapFor(user);
  await c.connect();
  try {
    const st = await c.status("INBOX", { messages: true });
    return { inbox: st.messages ?? -1, folders: (await c.list()).length };
  } finally { await c.logout(); }
}

async function seedRows(accountId: string, mailboxId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1000) {
    await db.insert(messages).values(Array.from({ length: Math.min(1000, n - i) }, (_, j) => {
      const k = `${mailboxId}:${i + j}`;
      return { accountId, mailboxId, bodyHash: k, dedupKey: k, subject: `m${i + j}`, fromAddress: "a@example.test" };
    }));
  }
}

describe.skipIf(!PG_UP)("the erase takes ohmail's copy and nothing on the mail server", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Tx;
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a mailbox of thousands of messages erased, the sibling whole, the server's mailbox counted equal", async () => {
    const user = `erase-${randomUUID()}@trafficflow.test`;
    const seed = imapFor(user);
    await seed.connect();
    for (let i = 0; i < 5; i += 1) {
      await seed.append("INBOX", `From: a@example.test\r\nTo: ${user}\r\nSubject: s${i}\r\n\r\nbody ${i}\r\n`);
    }
    await seed.logout();
    const serverBefore = await serverCount(user);
    expect(serverBefore.inbox, "the IMAP fixture holds nothing — this case measures nothing").toBe(5);

    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "erase-imap" });
    const [a] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: user }).returning();
    const [b] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `sib-${randomUUID()}@trafficflow.test` }).returning();
    await seedRows(accountId, a!.id, 3000);
    await seedRows(accountId, b!.id, 40);
    const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: "erase-imap" };
    const counted = async () => new Map((await svc.list(ctx, { counts: true })).map((m) => [m.id, m.messageCount]));
    const listedBefore = await counted();

    await expect(svc.delete(ctx, a!.id, { erase: { confirmAddress: "not-this-one@trafficflow.test" } }))
      .rejects.toMatchObject({ code: "erase_not_confirmed" });
    expect(await counted(), "a refused erase moved something").toEqual(listedBefore);

    const res = await svc.delete(ctx, a!.id, { erase: { confirmAddress: user.toUpperCase() } });
    expect(res.erasing).toMatchObject({ messages: 3000, done: false });
    let finished = 0;
    for (let i = 0; i < 10 && finished === 0; i += 1) {
      finished = (await mailboxErasurePass(db, { now: () => NOW, shard: inArray(mailboxes.accountId, [accountId]) })).finished;
    }
    expect(finished, "the pass did not finish the erasure").toBe(1);

    const listedAfter = await counted();
    expect(listedAfter.has(a!.id), "the erased mailbox is still listed").toBe(false);
    expect(listedAfter.get(b!.id), "the other mailbox's messages moved").toBe(listedBefore.get(b!.id));
    expect(await serverCount(user), "the erase touched the mail server").toEqual(serverBefore);
  }, 120_000);
});
