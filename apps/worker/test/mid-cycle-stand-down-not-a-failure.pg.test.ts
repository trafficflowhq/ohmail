import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accounts, mailboxCredentials, mailboxes, rules } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type LogFields } from "@trafficflow/core";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * A STAND-DOWN MID-CYCLE IS ITS OWN OUTCOME, NEVER A FAILED CYCLE. A takeover lands while the
 * hosted worker's cycle is parked in its scan; the cycle's permit sees it at the first page of
 * filing and stops. The worker's catch had no arm for the class, so the handover was logged
 * `sync_cycle_failed` and counted toward quarantine. Real worker, lane db, the fleet's real `_meta`.
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 11));
let DB = "";

function recordingLogger() {
  const events: Array<{ event: string; fields: LogFields }> = [];
  function mk(bound: LogFields) {
    const push = (event: string, fields?: LogFields): void => { events.push({ event, fields: { ...bound, ...fields } }); };
    return { level: "debug" as const, child: (f: LogFields) => mk({ ...bound, ...f }), debug: push, info: push, warn: push, error: push };
  }
  return { events, logger: mk({}) };
}

async function waitFor(pred: () => boolean, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("a stand-down in the middle of a hosted cycle", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_midcycle_standdown"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("is logged as a stand-down, is not counted as a failing mailbox, and files nothing", async () => {
    const db: Db = makeDb(DB);
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "midcycle" });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
      organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning();
    const enc = await KP.encrypt("pw");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    await db.insert(rules).values({ accountId, kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5 });

    const fleet = new FakeAdapterFleet();
    let release!: () => void;
    fleet.behave(mb!.id, {
      deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `mc-${randomUUID()}@feed.example` }],
      syncGate: new Promise<void>((r) => { release = r; }),
    });
    const { events, logger } = recordingLogger();
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 60_000,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory, logger,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    // The cycle has passed its gate and is parked in the scan; the takeover lands now.
    expect(await waitFor(() => fleet.syncInFlight === 1), "the cycle never reached its scan").toBe(true);
    fleet.seedClaim(mb!.id, formatClaim({
      authorizedAt: new Date(), capabilities: [], installId: "a-desktop-install", kind: "local",
      displayName: "Desktop", heartbeat: new Date(), claimedAt: new Date(), nonce: "rival-1",
    }));
    release();

    const mine = (event: string) => events.filter((e) => e.event === event && e.fields.mailboxId === mb!.id);
    expect(await waitFor(() => mine("stood_down_mid_cycle").length > 0), "the cycle never stood down mid-page").toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect.soft(mine("sync_cycle_failed").map((e) => String(e.fields.err ?? "")), "a handover was counted as a failed cycle").toEqual([]);
    expect.soft(mine("sync_cycle_stood_down").length, "the worker did not say the cycle stood down").toBeGreaterThan(0);
    expect.soft(mine("sync_cycle_stood_down")[0]?.fields.verdict).toBe("organized_elsewhere:local");
    expect.soft(fleet.movesFor(mb!.id), "the cycle filed after the takeover").toEqual([]);
    expect.soft(worker.stats().quarantined).toBe(0);
  }, 60_000);
});
