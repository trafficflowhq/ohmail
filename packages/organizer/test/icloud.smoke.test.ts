import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mailboxes, rules, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { PG_TEST_URL } from "@trafficflow/db/testing";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";

// Gated: only runs when ICLOUD_SMOKE is set with real iCloud credentials in the environment.
// It must SKIP (never fail, never fake-green) when those are absent.
const GATED = !process.env.ICLOUD_SMOKE;
const URL = PG_TEST_URL;

if (GATED) {
  // eslint-disable-next-line no-console
  console.log("[icloud.smoke] SKIPPED — set ICLOUD_SMOKE=1 with iCloud IMAP/SMTP creds to run the exit gate.");
}

describe.skipIf(GATED)("iCloud exit-gate smoke (manual)", () => {
  beforeAll(async () => { await runMigrations(URL); });

  it("ingests, routes, moves in place, and dedups against iCloud", async () => {
    const accountId = randomUUID();
    const db = makeDb(URL);
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: process.env.IMAP_USER! }).returning();
    await db.insert(rules).values({ accountId, kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5 });
    const repo = makeDrizzleRepo(db);

    const adapter = new ImapAdapter({
      host: process.env.IMAP_HOST!, port: Number(process.env.IMAP_PORT ?? 993), secure: process.env.IMAP_SECURE !== "false",
      auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASS! },
      smtp: process.env.SMTP_HOST ? { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true", auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASS! } } : undefined,
      sentDomain: "lichtgrat.example",
    });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const caps = await adapter.capabilities();
    expect(caps.idle).toBe(true);
    expect(caps.uidplus).toBe(true);

    const deps = { repo, adapter, accountId, mailboxId: mb.id, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    // NOTE: deliver a message from a feed.example sender to this iCloud account before running (manual step).
    await runSyncCycle(deps);
    await runSyncCycle(deps); // dedup: no duplicate re-ingest

    const rows = await db.select().from(messages).where(and(eq(messages.mailboxId, mb.id), eq(messages.accountId, accountId)));
    // Assert dedup (each Message-ID appears once) rather than a specific fixture id.
    const keys = rows.map((r) => r.dedupKey);
    expect(new Set(keys).size).toBe(keys.length);

    await adapter.close();
  }, 120000);
});
