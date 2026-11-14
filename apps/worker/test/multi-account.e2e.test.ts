import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, contacts, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker } from "../src/index.js";
import { loadEnabledMailboxes } from "../src/mailboxes.js";
import { LEADER_LOCK_KEY, leaderLockKeyFor } from "../src/leader-lock.js";
import { imapCfg, rawClient, emlOf } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

type Db = ReturnType<typeof makeDb>;
type Cfg = ReturnType<typeof imapCfg>;

/**
 * A logging change set the worker's log CONTRACT: every line is one JSON object with a stable `event`,
 * and the default logger is silent so no embedder inherits stdout noise. Tests that used to
 * grep `console.error` for a prose fragment now inject a collector and assert on the event —
 * which is both more precise (`mailbox_cap_exceeded`, not a substring of a sentence) and the
 * same thing an operator's log-drain rule will match on.
 */
function collectingLogger(): { logger: Logger; events: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  return {
    logger: createLogger({ service: "worker", level: "debug", sink: (l) => lines.push(l) }),
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));

/** Its own database: a no-account-filter worker serves EVERY account it can see (see _isolateddb.ts). */
let DB = "";

async function seedMailbox(db: Db, accountId: string, address: string): Promise<string> {
  const [row] = await db.insert(mailboxes).values({ accountId, provider: "imap", address }).returning();
  return row!.id;
}

async function seedImapCreds(
  db: Db, mailboxId: string, host: string, port: number, user: string, pass: string,
): Promise<void> {
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
async function waitForMessage(db: Db, mailboxId: string, messageId: string, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const rows = await db.select().from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, messageId)));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
}

/** One (account, mailbox, IMAP user) triple with encrypted DB creds and a known contact. */
async function seedAccount(db: Db, opts: { unreachable?: boolean } = {}) {
  const cfg = imapCfg();
  const accountId = randomUUID();
  const mailboxId = await seedMailbox(db, accountId, cfg.auth.user);
  await db.insert(contacts).values({ accountId, address: "anna@x.example" });
  if (opts.unreachable) {
    // Nothing listens on 127.0.0.1:1 → connect fails fast → the mailbox is quarantined.
    await seedImapCreds(db, mailboxId, "127.0.0.1", 1, cfg.auth.user, "nope");
  } else {
    await seedImapCreds(db, mailboxId, cfg.host, cfg.port, cfg.auth.user, cfg.auth.pass);
  }
  return { cfg, accountId, mailboxId };
}

describe("multi-account worker", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_ma"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    vi.restoreAllMocks();
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("syncs mailboxes of ALL accounts with NO account filter, stamping each account's own id", async () => {
    const db = makeDb(DB);
    const a = await seedAccount(db);
    const b = await seedAccount(db);

    await appendTo(a.cfg, "anna@x.example", "for account A", "ma-a@x");
    await appendTo(b.cfg, "anna@x.example", "for account B", "ma-b@x");

    // NO accountId: exactly the production configuration (TF_ACCOUNT_ID unset).
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    });
    closers.push(() => worker.stop());

    const rowsA = await waitForMessage(db, a.mailboxId, "ma-a@x");
    const rowsB = await waitForMessage(db, b.mailboxId, "ma-b@x");
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    // The account id comes from the MAILBOX ROW, not from one global config value: before
    // the multi-account change every ingested row carried config.accountId, so B's mail would land under A.
    expect(rowsA[0]!.accountId).toBe(a.accountId);
    expect(rowsB[0]!.accountId).toBe(b.accountId);

    expect(worker.stats()).toMatchObject({ mailboxes: 2, accounts: 2 });
  }, 45000);

  it("keeps cycling account B while account A's mailbox is quarantined", async () => {
    const db = makeDb(DB);
    const a = await seedAccount(db, { unreachable: true });
    const b = await seedAccount(db);

    await appendTo(b.cfg, "anna@x.example", "healthy one", "ma-h1@x");

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    });
    closers.push(() => worker.stop());

    // B synced despite A failing at startup...
    expect(await waitForMessage(db, b.mailboxId, "ma-h1@x")).toHaveLength(1);
    const [badRow] = await db.select().from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
    expect(badRow!.status).toBe("error");                    // A quarantined, not fatal
    expect(worker.stats()).toMatchObject({ mailboxes: 1, accounts: 2 });

    // ...and B KEEPS CYCLING afterwards: a message that arrives after A's failure still lands.
    await appendTo(b.cfg, "anna@x.example", "still cycling", "ma-h2@x");
    expect(await waitForMessage(db, b.mailboxId, "ma-h2@x")).toHaveLength(1);
  }, 45000);

  it("serves the shard's FULL duty even when a stale TF_ACCOUNT_ID is configured", async () => {
    const db = makeDb(DB);
    const a = await seedAccount(db);
    const b = await seedAccount(db);
    await appendTo(a.cfg, "anna@x.example", "for account A", "mafilter-a@x");
    await appendTo(b.cfg, "anna@x.example", "for account B", "mafilter-b@x");

    const { logger, events } = collectingLogger();

    // The exact "TF_ACCOUNT_ID left in the environment" footgun (risk 1). It used to NARROW
    // the roster, so account B was silently never synced and a log line was the only warning.
    // Now the filter cannot shrink anything: BOTH accounts sync.
    const worker = await startWorker({
      databaseUrl: DB, accountId: a.accountId, keyProvider: KP, logger,
      pollIntervalMs: 1000, sentDomain: "trafficflow.test", rosterIntervalMs: 60_000,
    });
    closers.push(() => worker.stop());

    expect(await waitForMessage(db, a.mailboxId, "mafilter-a@x")).toHaveLength(1);
    expect(await waitForMessage(db, b.mailboxId, "mafilter-b@x")).toHaveLength(1);
    expect(worker.stats()).toMatchObject({
      mailboxes: 2, accounts: 2, expected: 2, degraded: false,
    });
    // And nothing was reported as unserved, because nothing IS.
    expect(events().some((e) => e.event === "roster_invariant_violated")).toBe(false);
  }, 45000);

  it("caps the mailboxes it serves, says so loudly, and does not double-report the cap as unserved", async () => {
    const db = makeDb(DB);
    const accountId = randomUUID();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    for (let i = 0; i < 3; i++) {
      const cfg = imapCfg();
      const mailboxId = await seedMailbox(db, accountId, cfg.auth.user);
      await seedImapCreds(db, mailboxId, cfg.host, cfg.port, cfg.auth.user, cfg.auth.pass);
    }

    const { logger, events } = collectingLogger();
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, maxMailboxes: 2, logger,
      pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    });
    closers.push(() => worker.stop());

    expect(worker.stats()).toMatchObject({ mailboxes: 2, accounts: 1, expected: 2, truncated: 1 });
    const cap = events().find((e) => e.event === "mailbox_cap_exceeded");
    expect(cap, "the cap must be announced, loudly and greppably").toBeDefined();
    expect(cap!.level).toBe("error");
    expect(cap).toMatchObject({ serving: 2, selected: 3, dropped: 1, maxMailboxes: 2 });
    // Cap truncation is reported by the cap event alone — not a second time as "unserved".
    expect(events().some((e) => e.event === "roster_invariant_violated")).toBe(false);
  }, 45000);

  it("shard seam: shards=2 partitions accounts disjointly and completely, with its own lock key", async () => {
    const db = makeDb(DB);
    const rows = Array.from({ length: 20 }, () => ({
      accountId: randomUUID(), provider: "imap", address: `s-${randomUUID()}@trafficflow.test`,
    }));
    await db.insert(mailboxes).values(rows);

    const all = await loadEnabledMailboxes(db);
    const s0 = await loadEnabledMailboxes(db, { shards: 2, shardIndex: 0 });
    const s1 = await loadEnabledMailboxes(db, { shards: 2, shardIndex: 1 });

    expect(all).toHaveLength(20);
    expect(s0.length + s1.length).toBe(all.length);         // complete
    const ids0 = new Set(s0.map((m) => m.mailboxId));
    expect(s1.some((m) => ids0.has(m.mailboxId))).toBe(false); // disjoint
    expect(s0.length).toBeGreaterThan(0);
    expect(s1.length).toBeGreaterThan(0);
    // The DETERMINISTIC negative-hashtext case (and two live shard workers, and the crons'
    // shard guard) live in `shard.e2e.test.ts`; 20 random uuids only make a starved shard
    // unlikely, they do not prove the modulo normalization.

    // …and each shard contends on its OWN leader lock, shard 0 keeping the historical key.
    expect(leaderLockKeyFor(0)).toBe(LEADER_LOCK_KEY);
    expect(leaderLockKeyFor(1)).toBe(LEADER_LOCK_KEY + 1n);
  }, 30000);
});
