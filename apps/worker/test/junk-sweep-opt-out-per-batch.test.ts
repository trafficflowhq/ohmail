import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageBodies, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter, FILING_BATCH_MAX, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { junkSweepPass } from "../src/junk-sweep.js";
import { acquireLeasePermit } from "../src/lease.js";
import { FakeMetaFolder } from "./_fakeadapter.js";

/**
 * ═══ "USE FOLDERS" OFF STOPS THE NEXT BATCH, NOT THE NEXT CYCLE ═════════════════════════════
 *
 * arm (d): the one-time sweep read `folders_disabled_at` once,
 * when the command was picked up, and the chunks behind it kept moving mail into the provider's
 * Junk after the person had switched the mailbox off. The opt-out is read per batch now and the
 * batch it stops writes nothing.
 *
 * The adapter is the real `ImapAdapter` over a scripted client; the database is PGlite.
 */

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>, n: number) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `oo-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `oo-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  for (let i = 0; i < n; i++) {
    const uid = 100 + i;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<oo-${accountId.slice(0, 8)}-${i}@x>`, bodyHash: `h${i}`,
      subject: `old spam ${i}`, fromAddress: "spammer@example.test",
      nativeLocator: { folder: "ohmail/Quarantine", ref: `1:${uid}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, messageId: m!.id, mailboxId: mb!.id, folder: "ohmail/Quarantine",
      uid, uidvalidity: 1n, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Quarantine", observedFolder: "ohmail/Quarantine",
      lastSetBy: "us", reconcileStatus: "reconciled",
    });
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: `buy things ${i}` });
  }
  return { accountId, mailboxId: mb!.id };
}

function scriptedClient(onMove: (n: number) => Promise<void>) {
  const writes: string[] = [];
  let moves = 0;
  let nextDst = 5000;
  const client = {
    writes,
    usable: true,
    capabilities: new Map<string, boolean>([["IDLE", true], ["UIDPLUS", true], ["MOVE", true]]),
    mailbox: false as unknown,
    async list() {
      return [
        { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() },
        { path: "Junk", name: "Junk", delimiter: "/", flags: new Set<string>(), specialUse: "\\Junk" },
        { path: "ohmail/Quarantine", name: "Quarantine", delimiter: "/", flags: new Set<string>() },
      ];
    },
    async getMailboxLock(path: string) {
      client.mailbox = { path, exists: 60, uidValidity: 1n };
      return { path, release() { /* nothing */ } };
    },
    async fetchAll(range: string) {
      return range.split(",").map(Number).map((uid) => ({ uid, envelope: { messageId: `<q${uid}@x>` } }));
    },
    async search() { return [] as number[]; },
    async messageMove(uids: number[], to: string) {
      writes.push(`MOVE ${uids.length} -> ${to}`);
      moves++;
      await onMove(moves);
      return { uidValidity: 9n, uidMap: new Map(uids.map((u) => [u, nextDst++])) };
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

async function sweepWith(switchOffAfterFirstBatch: boolean) {
  const db = await makeTestDb();
  const n = FILING_BATCH_MAX + 1;           // two batches: fifty, then one
  const { accountId, mailboxId } = await seed(db, n);
  const client = scriptedClient(async (k) => {
    if (switchOffAfterFirstBatch && k === 1) {
      // The person switches this mailbox off under "Use folders" while the first batch lands.
      await db.update(mailboxes).set({ foldersDisabledAt: new Date() }).where(eq(mailboxes.id, mailboxId));
    }
  });
  const adapter = new ImapAdapter(
    { host: "rig.invalid", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client: client as never },
  );
  await adapter.connect();
  const permit = await acquireLeasePermit({
    adapter: { leaseIo: () => new FakeMetaFolder() } as unknown as MailboxAdapter,
    self: { installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null },
    mailboxId, hasRequestKey: false,
  });
  const repo = makeDrizzleRepo(db as unknown as Tx) as unknown as WorkerRepo & {
    transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  };
  const res = await junkSweepPass({
    db: db as unknown as Tx, repo, adapter, accountId, mailboxId, execute: true,
    writeAuthority: { lease: permit },
  });
  return { res, writes: client.writes, n };
}

describe("the one-time sweep asks the Use-folders opt-out per batch", () => {
  it("a mailbox switched off while the first batch moves: the second batch writes nothing", async () => {
    const { res, writes } = await sweepWith(true);
    expect(writes, "a batch moved mail after the mailbox was switched off").toEqual([
      `MOVE ${FILING_BATCH_MAX} -> Junk`,
    ]);
    expect(res.moved).toHaveLength(FILING_BATCH_MAX);
  });

  it("POSITIVE CONTROL — left on, both batches move", async () => {
    const { res, writes, n } = await sweepWith(false);
    expect(writes).toEqual([`MOVE ${FILING_BATCH_MAX} -> Junk`, "MOVE 1 -> Junk"]);
    expect(res.moved).toHaveLength(n);
  });
});
