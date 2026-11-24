import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { accounts, folderState, mailboxCredentials, mailboxes, messages, type Tx } from "@trafficflow/db";
import { makeOwnedDb, readLock, type OwnedDb } from "@trafficflow/db/cloud";
import { MIGRATOR_ROLE, ownServersAvailable, startLockGround, type LockGround } from "@trafficflow/db/testing";
import { searchIndexOwedAccounts } from "@trafficflow/core/mail";
import { htmlWordsOwedAccounts } from "@ohmail/organizer/html-words-backfill";
import { senderCheckReentered, senderCheckRetirement } from "@ohmail/organizer/sender-check-backfill";
import { loadAttachHosts } from "../src/mailboxes.js";
import { bindWorker, type WorkerBinding } from "../src/start/bind.js";

const own = ownServersAvailable("apps/worker/test/roster-runtime-lock.pg.test.ts");
const database = "ground";

describe.skipIf(!own)("worker scheduling under the forced account lock", () => {
  let ground: LockGround;
  let worker: OwnedDb;
  let migrator: OwnedDb;
  let binding: WorkerBinding;

  beforeAll(async () => {
    ground = await startLockGround(17, "worker_runtime", database);
    await ground.setup(database);
    await ground.makeRoles(database);
    await ground.setup(database, MIGRATOR_ROLE, { lock: "apply" });
    worker = makeOwnedDb(ground.urlAs(database, "ohmail_worker"), { role: "worker" });
    migrator = makeOwnedDb(ground.urlAs(database, MIGRATOR_ROLE));
    binding = bindWorker(worker.db);
    const login = ground.connectAs(database, "ohmail_worker");
    try {
      const lock = await readLock(login, { role: "ohmail_worker" });
      expect(lock.verdict).toBe("locked");
      expect(lock.role.bypass).toBe(false);
    } finally {
      await login.end();
    }
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await migrator?.close();
    ground?.stop();
  });

  async function mailbox(name: "A" | "B", withMail: boolean) {
    const [{ id: accountId }] = await migrator.db.insert(accounts).values({ name }).returning({ id: accounts.id });
    const [{ id: mailboxId }] = await migrator.db.insert(mailboxes).values({
      accountId, provider: "imap", address: [randomUUID(), "example.invalid"].join("@"),
    }).returning({ id: mailboxes.id });
    const host = `imap-${name.toLowerCase()}.example.invalid`;
    await migrator.db.insert(mailboxCredentials).values({
      accountId, mailboxId, transport: "imap", meta: { host }, secretEnc: "unused", keyVersion: 1,
    });
    if (withMail) {
      const [{ id: messageId }] = await migrator.db.insert(messages).values({
        accountId, mailboxId, dedupKey: randomUUID(), bodyHash: randomUUID(),
      }).returning({ id: messages.id });
      await migrator.db.insert(folderState).values({
        accountId, messageId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
      });
    }
    return { accountId, mailboxId, host };
  }

  const forAccount = (accountId: string): Tx => binding.forAccount(accountId).db as unknown as Tx;

  it("classifies scheduled mailboxes by their own IMAP hosts", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    expect(await loadAttachHosts([a, b], binding.forAccount))
      .toEqual(new Map([[a.mailboxId, a.host], [b.mailboxId, b.host]]));
  });

  it("schedules HTML words only for the roster account holding live mail", async () => {
    const a = await mailbox("A", true);
    const b = await mailbox("B", false);
    expect(await htmlWordsOwedAccounts(binding.roster as unknown as Tx, {
      limit: 1, shard: inArray(accounts.id, [a.accountId, b.accountId]), forAccount,
    })).toEqual([a.accountId]);
  });

  it("schedules the search backfill only for the roster account holding live mail", async () => {
    const a = await mailbox("A", true);
    const b = await mailbox("B", false);
    expect(await searchIndexOwedAccounts(binding.roster as unknown as Tx, {
      limit: 1, shard: inArray(accounts.id, [a.accountId, b.accountId]), forAccount,
    })).toEqual([a.accountId]);
  });

  it("re-arms sender checks only for the retired account with a recent unchecked message", async () => {
    const a = await mailbox("A", true);
    const b = await mailbox("B", false);
    const candidates = [a.accountId, b.accountId];
    expect(await senderCheckReentered(binding.roster as unknown as Tx, candidates, new Date(0)))
      .toEqual(new Set());
    const tail = senderCheckRetirement({
      pass: async () => ({ done: true, contactsDone: true }) as never,
      forAccount,
    });
    await tail.run(forAccount(a.accountId), a.accountId);
    await tail.run(forAccount(b.accountId), b.accountId);
    expect(await tail.enter(binding.roster as unknown as Tx, candidates)).toEqual([a.accountId]);
  });
});
