import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { accounts, accountSettings, mailboxes, mailboxCredentials, messageBodies, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { SEARCH_DOCUMENT_SHAPE_AT, StaticKeyProvider, createLogger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE SEARCH BACKFILL REACHES THE ACCOUNTS THAT NEVER SYNC. It ran at the tail of a successful
 * visit, so an account whose only mailbox is disabled, and one whose account is parked, had no
 * search document for ever (two such accounts in production). It is a cycle-tail section now,
 * listing the accounts with living mail and no marker. Driven through the real worker, beside an
 * open account (whose visits keep the cycles and so the tail running) and an account whose marker
 * is already written: that one's rows stay as they are, so the list is not "every account".
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 31));
let DB = "";

/** A plane that parks the accounts in `parked` and opens every other one. */
function fakePlane(): { server: Server; url: () => string; parked: Set<string>; close: () => Promise<void> } {
  const parked = new Set<string>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const accountId = (JSON.parse(raw || "{}") as { accountId?: string }).accountId ?? "";
      const closed = parked.has(accountId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        entitlements: {
          mailboxLimit: closed ? 0 : null, canAddMailbox: !closed, aiEnabled: !closed, syncEnabled: !closed,
          storageBytesLimit: null, reason: closed ? "canceled" : "active",
        },
        balance: 0, setupCredits: { remaining: 0, expiresAt: null },
        storageUsedBytes: 0, invoiceGranted: false, manageUrl: null,
        lifecycle: closed
          ? { state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
              closedAt: "2026-09-01T00:00:00.000Z", erasureAt: "2026-10-01T00:00:00.000Z", erasedAt: null, formerlyPaid: false }
          : { state: "active", closedReason: null, trialEndsAt: null, graceUntil: null,
              closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false },
      }));
    });
  });
  return {
    server, parked,
    url: () => {
      const a = server.address();
      if (a === null || typeof a === "string") throw new Error("the fake plane has no port");
      return `http://127.0.0.1:${a.port}`;
    },
    close: () => new Promise((r) => { server.close(() => { r(); }); }),
  };
}

/** An account with one mailbox and three stored messages that carry no search document. */
async function seedAccount(db: Db, status: "active" | "disabled"): Promise<{ accountId: string; ids: string[] }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "backfill" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, status,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 3_600_000),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sib:${randomUUID()}`, subject: `Stored ${i}`,
      fromAddress: `s${i}@club.example`, nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: `stored words ${i}`, html: null });
    ids.push(m!.id);
  }
  return { accountId, ids };
}

async function waitFor(cond: () => Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start >= ms) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const documented = async (db: Db, ids: readonly string[]): Promise<number> => {
  const rows = (await db.execute(sql`select count(*)::int as n from message_search where message_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
};
const marked = async (db: Db, accountId: string): Promise<boolean> =>
  (await db.select({ at: accountSettings.searchIndexBuiltAt }).from(accountSettings)
    .where(inArray(accountSettings.accountId, [accountId])))[0]?.at != null;

describe("the search backfill reaches every account that owes it", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_search_backfill_tail"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("indexes an account whose only mailbox is disabled and a parked account, and no account already built", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const open = await seedAccount(db, "active");
    const disabled = await seedAccount(db, "disabled");
    const parked = await seedAccount(db, "active");
    plane.parked.add(parked.accountId);
    const built = await seedAccount(db, "disabled");
    await db.insert(accountSettings).values({ accountId: built.accountId, searchIndexBuiltAt: SEARCH_DOCUMENT_SHAPE_AT });

    const fleet = new FakeAdapterFleet();
    const cfg: WorkerConfig = {
      databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      pollIntervalMs: 250, rosterIntervalMs: 400, lockHeartbeatMs: 60_000, alertIntervalMs: 600_000,
      mailboxRetryMs: 500, maxSyncFailures: 50,
      logger: createLogger({ service: "worker", level: "error", sink: () => { /* dropped */ } }),
      organizer: { installId: "cloud-backfill", displayName: "Cloud", staleAfterMs: 60_000 },
      entitlements: { url: plane.url(), secret: "x".repeat(24), accessTtlMs: 150 },
    };
    const worker = await startWorker(cfg);
    closers.push(() => worker.stop());

    await waitFor(async () => (await documented(db, disabled.ids)) === 3, 30_000, "the disabled-only account's documents");
    await waitFor(async () => (await documented(db, parked.ids)) === 3, 30_000, "the parked account's documents");
    expect(await marked(db, disabled.accountId), "the disabled-only account's marker").toBe(true);
    expect(await marked(db, parked.accountId), "the parked account's marker").toBe(true);
    // The park held for the whole run: its mailbox was never attached, so the documents came from the tail.
    expect(worker.stats().mailboxes, "only the open account's mailbox is on the roster").toBe(1);
    expect(await documented(db, built.ids), "an account with its marker written was indexed again").toBe(0);
  }, 120_000);
});
