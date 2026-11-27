import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import { CLOUD_JOURNAL, MAIL_JOURNAL, readJournalOf, runMigrations } from "@trafficflow/db/admin";
import { brandDialect } from "@trafficflow/db/dialect";
import { journalDrift, realPgAvailable, throwawayDb } from "@trafficflow/db/testing";
import { journalThrough } from "../../../packages/db/src/testing-journal.js";
import { FakeAdapterFleet } from "../../../packages/organizer/test/_fakeadapter.js";
import { startWorker } from "../src/index.js";
import { acquireLeaderLock, leaderLockKeyFor } from "../src/leader-lock.js";

const available = await realPgAvailable();
const keys = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));

describe.skipIf(!available)("worker topology on the migration path", () => {
  const fresh = throwawayDb("topology_fresh");
  const legacy = throwawayDb("topology_legacy");

  afterAll(async () => { await Promise.all([fresh.drop(), legacy.drop()]); }, 30_000);

  it("lets the first organizer lead shard zero on a fresh database", async () => {
    await fresh.create(runMigrations);
    await expectLeaders(fresh.url);
  }, 180_000);

  it.each([
    ["keeps the existing organizer width while migrating a populated database", false, 1, 1],
    ["resumes mail sync after the legacy organizer is drained for migration", true, 1, 1],
    ["elects both shards after two workers are drained for migration", true, 2, 2],
    ["uses the recorded width when only one stopped shard has a heartbeat", true, 2, 1],
    ["refuses conflicting stopped widths before recording the migration", true, 2, 2, true],
  ] as const)("%s", async (_name, drained, width, recorded, conflicting = false) => {
    // The 2.0.7 journal heads, including the pre-topology worker heartbeat schema.
    const mailboxId = randomUUID();
    await legacy.create(async (url) => {
      const client = postgres(url, { max: 1, onnotice: () => {} });
      try {
        for (const [journal, tag] of [
          [MAIL_JOURNAL, "0227_calendar_session_scope"],
          [CLOUD_JOURNAL, "0106_security_notice_recipients"],
        ] as const) {
          const head = readJournalOf(journal).find((entry) => entry.tag === tag)!;
          const cut = journalThrough(journal, head.when);
          try {
            const db = brandDialect(drizzle(client), "pg");
            await migrate(db, { migrationsFolder: cut.spec.dir, migrationsSchema: cut.spec.migrationsSchema });
          } finally {
            cut.dispose();
          }
        }
        const accountId = randomUUID();
        await client`INSERT INTO mailboxes (id, account_id, address, provider)
          VALUES (${mailboxId}, ${accountId}, 'mailbox@example.test', 'imap')`;
        const credential = await keys.encrypt("fixture");
        const meta = JSON.stringify({ host: "fixture.invalid", port: 1143, secure: false, user: "fixture" });
        await client`INSERT INTO mailbox_credentials (mailbox_id, account_id, transport, secret_enc, key_version, meta)
          VALUES (${mailboxId}, ${accountId}, 'imap', ${credential.ciphertext}, ${credential.keyVersion}, ${meta}::jsonb)`;
      } finally {
        await client.end();
      }
    });
    const oldWorker = postgres(legacy.url, { max: 1 });
    const apiClock = postgres(legacy.url, { max: 1 });
    try {
      await oldWorker`SELECT pg_advisory_lock(${leaderLockKeyFor(0)})`;
      for (let index = 0; index < recorded; index++) {
        await oldWorker`INSERT INTO worker_heartbeats (shard_index, instance_id, shards, leader)
          VALUES (${index}, ${"fixture-organizer-" + index}, ${conflicting && index === 0 ? 1 : width}, ${!drained})`;
      }
      if (drained) await oldWorker.end();
      await apiClock`SELECT pg_advisory_lock(4207278001::bigint)`;
      if (conflicting) {
        await expect(runMigrations(legacy.url)).rejects.toThrow(/ohmail\.worker_shards/);
        expect(await apiClock`SELECT to_regclass('public.worker_topology') AS topology`).toEqual([{ topology: null }]);
        const override = new URL(legacy.url);
        override.searchParams.set("options", "-c ohmail.worker_shards=2");
        await runMigrations(override.toString());
      } else {
        await runMigrations(legacy.url);
      }
    } finally {
      await Promise.all([oldWorker.end(), apiClock.end()]);
    }
    await expectLeaders(legacy.url, width);
    if (drained) {
      await runMigrations(legacy.url);
      expect(await journalDrift(legacy.url)).toBeNull();
      if (width === 1) await expectReplacementSync(legacy.url, mailboxId);
    }
  }, 180_000);
});

async function expectReplacementSync(url: string, mailboxId: string): Promise<void> {
  const fleet = new FakeAdapterFleet();
  const subject = "Mail after the upgrade";
  fleet.behave(mailboxId, {
    deliver: [{ from: "sender@example.test", subject, messageId: "after-upgrade@example.test" }],
  });
  const worker = await startWorker({
    databaseUrl: url, keyProvider: keys, sentDomain: "example.test", healthPort: 0,
    adapterFactory: fleet.factory, pollIntervalMs: 100,
  });
  const client = postgres(url, { max: 1 });
  try {
    await expect.poll(async () => client`SELECT subject FROM messages WHERE mailbox_id = ${mailboxId}`,
      { timeout: 10_000 }).toEqual([{ subject }]);
  } finally {
    await Promise.all([worker.stop(), client.end()]);
  }
}

async function expectLeaders(url: string, shards = 1): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    expect(await client`SELECT shards FROM worker_topology`).toEqual([{ shards }]);
    const leaders = await Promise.all(Array.from({ length: shards }, (_, index) =>
      acquireLeaderLock(url, leaderLockKeyFor(index), { shards })));
    try {
      expect(await Promise.all(leaders.map((leader) => leader?.verify()))).toEqual(Array(shards).fill(true));
    } finally {
      await Promise.all(leaders.map((leader) => leader?.release()));
    }
  } finally {
    await client.end();
  }
}
