import { accountOfUser } from "@trafficflow/db";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials, users } from "@trafficflow/db";
import { loginTokens, makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE HOUR REACHES THE PRUNE. A unit test of the pass says nothing about whether the worker runs
 * it: this starts a real worker on its own database, lets a fresh leader's first tail walk take the
 * maintenance section (the gate starts due), and reads the pass's own log line and the row it took.
 */
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 29));
let DB = "";

function capturing(): { log: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({
    service: "worker", level: "info",
    sink: (line) => {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.event === "string" && o.event.startsWith("sign_in_retention")) lines.push(o);
    },
  });
  return { log, lines };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

describe("the maintenance section runs the sign-in retention pass", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_sign_in_retention"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } },
    ISOLATED_DB_RESET_BUDGET_MS);

  it("a fresh leader's first walk deletes a sign-in record past its horizon and logs the counts", async () => {
    const db = makeDb(DB);
    const [acct] = await db.insert(accounts).values({ name: "r" }).returning();
    const [user] = await db.insert(users).values({ accountId: acct!.id, email: `r+${randomUUID()}@trafficflow.test` }).returning();
    const [old] = await db.insert(loginTokens).values({
      userId: user!.id, accountId: accountOfUser(user!.id), tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 40 * 86_400_000),
    }).returning();
    const [fresh] = await db.insert(loginTokens).values({
      userId: user!.id, accountId: accountOfUser(user!.id), tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 86_400_000),
    }).returning();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
    const enc = await KP.encrypt("pw");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });

    const fleet = new FakeAdapterFleet();
    const { log, lines } = capturing();
    const cfg: WorkerConfig = {
      databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      pollIntervalMs: 600_000, rosterIntervalMs: 600_000, lockHeartbeatMs: 60_000,
      alertIntervalMs: 600_000, mailboxRetryMs: 60_000, maxSyncFailures: 50, logger: log,
    };
    const worker = await startWorker(cfg);
    closers.push(() => worker.stop());

    await waitFor(() => lines.some((l) => l.event === "sign_in_retention_pruned"), 60_000, "the pass's summary line");
    const summary = lines.find((l) => l.event === "sign_in_retention_pruned")!;
    expect(summary).toMatchObject({ pruned: 1, stoppedBy: "dry" });
    expect(lines.find((l) => l.event === "sign_in_retention_table")).toMatchObject({ table: "login_tokens", pruned: 1 });
    expect(await db.select().from(loginTokens).where(eq(loginTokens.id, old!.id))).toEqual([]);
    expect(await db.select().from(loginTokens).where(eq(loginTokens.id, fresh!.id))).toHaveLength(1);
  }, 120_000);
});
