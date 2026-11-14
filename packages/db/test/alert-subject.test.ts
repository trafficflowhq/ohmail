import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { readJournalOf } from "../src/baseline.js";
import { CLOUD_JOURNAL } from "../src/journal-specs.js";
import { accounts, devices, sessions, users } from "../src/schema-mail.js";
import { alertState } from "../src/schema-cloud.js";
import { makeTestDb } from "../src/testing.js";

/**
 * CLOUD 0102 POINTS A PER-SUBJECT ALERT AT ITS ACCOUNT. Four kinds carry their subject's id in the
 * key; the entry's fills read it from there, through the device or the session where the key
 * names one. Run here as the journal runs them, over rows planted the way 1.0 left them: no pointer.
 */
function fills(): string[] {
  const entry = readJournalOf(CLOUD_JOURNAL).find((e) => e.tag === "0102_alert_subject")!;
  const file = readMigrationFiles({ migrationsFolder: CLOUD_JOURNAL.dir }).find((m) => m.folderMillis === entry.when)!;
  return file.sql.filter((s) => /^\s*(--[^\n]*\n\s*)*UPDATE /i.test(s));
}

describe("the account a per-subject alert is about", () => {
  it("is the one its key names, a named device's or a named session's, and empty for anything else", async () => {
    const db = await makeTestDb();
    const [acct] = await db.insert(accounts).values({ name: "alerts" }).returning();
    const [other] = await db.insert(accounts).values({ name: "another" }).returning();
    const [user] = await db.insert(users).values({ accountId: acct!.id, email: `a-${acct!.id}@example.test` }).returning();
    const [device] = await db.insert(devices).values({ accountId: acct!.id, userId: user!.id, kind: "web" }).returning();
    const [session] = await db.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId: randomUUID(),
      accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 86_400_000),
    }).returning();
    const gone = randomUUID();
    const keys: Record<string, string | null> = {
      [`session_reuse_revoked:${acct!.id}`]: acct!.id,
      [`session_refresh_replayed:${other!.id}`]: other!.id,
      [`device_sync_stale:${device!.id}`]: acct!.id,
      [`session_sync_stale:${session!.id}`]: acct!.id,
      // A subject that is gone, an alert about the service, and a key that only looks like one.
      [`device_sync_stale:${gone}`]: null,
      [`session_reuse_revoked:${gone}`]: null,
      worker_down: null,
      [`worker_down:${acct!.id}`]: null,
    };
    for (const alertKey of Object.keys(keys)) await db.insert(alertState).values({ alertKey, kind: alertKey.split(":")[0]! });

    expect(fills()).toHaveLength(3);
    for (const statement of fills()) await db.execute(sql.raw(statement));

    const after = await db.select({ alertKey: alertState.alertKey, subject: alertState.subjectAccountId }).from(alertState);
    expect(Object.fromEntries(after.map((r) => [r.alertKey, r.subject]))).toEqual(keys);
  });
});
