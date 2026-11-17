import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { mailboxes, contacts, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { byMessageId, imapCfg, rawClient, emlOf } from "../../../packages/organizer/test/_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { randomUUID } from "node:crypto";

// Its OWN database: since that change there is no account filter, so a worker pointed at the shared
// `trafficflow_test` accumulator would try to open every historical mailbox (see _isolateddb.ts).
let DB = "";

describe("worker main loop (IDLE → cycle)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_watch"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("ingests a message pushed while idling, then stops cleanly", async () => {
    const cfg = imapCfg();
    const accountId = randomUUID();
    const db = makeDb(DB);
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: cfg.auth.user }).returning();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });

    const worker = await startWorker({
      databaseUrl: DB, accountId, mailboxId: mb.id,
      imap: { host: cfg.host, port: cfg.port, secure: false, user: cfg.auth.user, pass: cfg.auth.pass },
      smtp: undefined, keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 7)),
      pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    });
    closers.push(() => worker.stop());

    const c = await rawClient(cfg);
    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "idle ingest", messageId: "w1@x" }));
    await c.logout();

    // poll for ingestion (IDLE signal OR the 1s safety poll)
    const start = Date.now();
    let seen = 0;
    while (Date.now() - start < 10000) {
      const rows = await db.select().from(messages).where(byMessageId(mb.id, "w1@x"));
      seen = rows.length;
      if (seen > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(seen).toBe(1);
  }, 20000);
});
