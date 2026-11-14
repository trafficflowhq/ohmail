import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, contacts, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { imapCfg, rawClient, emlOf } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { randomUUID } from "node:crypto";

// Its OWN database: since that change there is no account filter, so a worker pointed at the shared
// `trafficflow_test` accumulator would try to open every historical mailbox (see _isolateddb.ts).
let DB_URL = "";

type Db = ReturnType<typeof makeDb>;
type Cfg = ReturnType<typeof imapCfg>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));

/** Seed an ENCRYPTED imap cred row (pure DB-creds path — the worker never sees plaintext env). */
async function seedImapCreds(db: Db, mailboxId: string, host: string, port: number, user: string, pass: string): Promise<void> {
  const enc = await KP.encrypt(pass);
  await db.insert(mailboxCredentials).values({
    mailboxId, accountId: accountOfMailbox(mailboxId), transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host, port, secure: false, user },
  });
}

async function appendTo(cfg: Cfg, from: string, subject: string, messageId: string): Promise<void> {
  const c = await rawClient(cfg);
  await c.append("INBOX", emlOf({ from, subject, messageId }));
  await c.logout();
}

/**
 * Wait for the message with this Message-ID (RFC 5322) to be ingested into this mailbox.
 *
 * By `message_id_header`, not `dedup_key`: since that change slice 2 the key is `fp1:<sha256>` over every
 * field a sender chooses, so a test cannot spell it out — and "the message I appended" is exactly
 * what the header names. Case is significant now (`normalizeMessageId` stopped folding it).
 */
async function waitForMessage(db: Db, mailboxId: string, messageId: string, ms = 10000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const rows = await db.select().from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, messageId)));
    if (rows.length > 0) return rows.length;
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

describe("worker multi-mailbox (DB creds)", () => {
  beforeAll(async () => { DB_URL = await prepareIsolatedDb("trafficflow_worker_mmb"); }, 60000);
  beforeEach(async () => { await truncateAll(DB_URL); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("syncs ALL enabled mailboxes from encrypted DB creds (one message per mailbox)", async () => {
    const cfg1 = imapCfg();
    const cfg2 = imapCfg();
    const accountId = randomUUID();
    const db = makeDb(DB_URL);
    const [m1] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: cfg1.auth.user }).returning();
    const [m2] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: cfg2.auth.user }).returning();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });

    // Pure DB-creds path: encrypted rows, NO env imap passed to the worker.
    await seedImapCreds(db, m1.id, cfg1.host, cfg1.port, cfg1.auth.user, cfg1.auth.pass);
    await seedImapCreds(db, m2.id, cfg2.host, cfg2.port, cfg2.auth.user, cfg2.auth.pass);

    await appendTo(cfg1, "anna@x.example", "mbox one", "mm1@x");
    await appendTo(cfg2, "anna@x.example", "mbox two", "mm2@x");

    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP,
      pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    });
    closers.push(() => worker.stop());

    expect(await waitForMessage(db, m1.id, "mm1@x")).toBe(1);
    expect(await waitForMessage(db, m2.id, "mm2@x")).toBe(1);
  }, 30000);

  it("bootstraps env creds into an encrypted row exactly once (RC3 idempotency)", async () => {
    const cfg = imapCfg();
    const accountId = randomUUID();
    const db = makeDb(DB_URL);
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: cfg.auth.user }).returning();

    const envConfig = {
      databaseUrl: DB_URL, accountId, mailboxId: mb.id,
      imap: { host: cfg.host, port: cfg.port, secure: false, user: cfg.auth.user, pass: cfg.auth.pass },
      keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    };

    const w1 = await startWorker(envConfig);
    await w1.stop();

    const after1 = await db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, mb.id), eq(mailboxCredentials.transport, "imap")));
    expect(after1.length).toBe(1);
    // The stored secret is encrypted (not the plaintext) and round-trips to the env pass.
    expect(after1[0]!.secretEnc).not.toContain(cfg.auth.pass);
    expect(await KP.decrypt(after1[0]!.secretEnc, after1[0]!.keyVersion)).toBe(cfg.auth.pass);
    const firstSecret = after1[0]!.secretEnc;

    // Second boot with the same env creds must NOT create a duplicate or overwrite.
    const w2 = await startWorker(envConfig);
    await w2.stop();

    const after2 = await db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, mb.id), eq(mailboxCredentials.transport, "imap")));
    expect(after2.length).toBe(1);
    expect(after2[0]!.secretEnc).toBe(firstSecret); // unchanged — env never overwrites a DB row
  }, 30000);

  it("isolates a failed mailbox: marks it status=error and keeps syncing the healthy one (RC2)", async () => {
    const good = imapCfg();
    const accountId = randomUUID();
    const db = makeDb(DB_URL);
    const [mGood] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: good.auth.user }).returning();
    const [mBad] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "bad@trafficflow.test" }).returning();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });

    await seedImapCreds(db, mGood.id, good.host, good.port, good.auth.user, good.auth.pass);
    // Unreachable endpoint (nothing listening on 127.0.0.1:1) → connect fails fast.
    await seedImapCreds(db, mBad.id, "127.0.0.1", 1, "bad@trafficflow.test", "nope");

    await appendTo(good, "anna@x.example", "healthy", "ok1@x");

    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP,
      pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    });
    closers.push(() => worker.stop());

    // The healthy mailbox still syncs...
    expect(await waitForMessage(db, mGood.id, "ok1@x")).toBe(1);
    // ...and the failed one is quarantined, not fatal to the worker.
    const [badRow] = await db.select().from(mailboxes).where(eq(mailboxes.id, mBad.id));
    expect(badRow!.status).toBe("error");
  }, 30000);
});
