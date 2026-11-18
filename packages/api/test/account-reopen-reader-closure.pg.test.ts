import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { accounts, mailboxes } from "@trafficflow/db";
import { accountLifecycleNotices, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { dbFor, type ServiceContext } from "@trafficflow/services";
import { reopenedCatchUp } from "../src/account-reopen.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * A CLOSURE THE NIGHTLY PASS NEVER SAW still earns its catch-up. The anchor is the park; an
 * account whose Cloud rows are all READERS parks nothing, so the worker's `account_closed` block
 * is the one fact the closure left. Scoped to this file's own accounts, and removed after.
 */

const AVAILABLE = await realPgAvailable();
const CLOSED_AT = new Date("2026-09-27T21:40:00.000Z");
const NOW = new Date("2026-09-28T05:49:41.000Z");

describe.skipIf(!AVAILABLE)("the catch-up for a closure inside one night", () => {
  let owned: OwnedDb;
  let db: OwnedDb["db"];
  const seeded: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 180_000);

  afterAll(async () => {
    if (!AVAILABLE) return;
    if (seeded.length > 0) {
      await db.delete(accountLifecycleNotices).where(inArray(accountLifecycleNotices.accountId, seeded));
      await db.delete(mailboxes).where(inArray(mailboxes.accountId, seeded));
      await db.delete(accounts).where(inArray(accounts.id, seeded));
    }
    await owned?.close().catch(() => {});
  });

  async function world(extra: Partial<typeof mailboxes.$inferInsert>) {
    const [acct] = await db.insert(accounts).values({ name: `night-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    seeded.push(accountId);
    await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `night-${randomUUID().slice(0, 8)}@example.invalid`,
      organizerRole: "reader", organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"), ...extra,
    });
    const bound = dbFor(db, accountId);
    return {
      deps: { db: bound, now: () => NOW } as unknown as ApiDeps,
      ctx: { accountId, db: bound, now: () => NOW } as unknown as ServiceContext,
    };
  }

  it("a parked organizer with no closed notice is anchored on the park (on main since mail 0135)", async () => {
    const w = await world({
      organizerRole: "reader", organizerParkedAt: CLOSED_AT, organizerReleasedAt: CLOSED_AT,
      syncBlockedReason: "account_closed", syncBlockedSince: CLOSED_AT,
    });
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: CLOSED_AT.toISOString() });
  });

  it("a reader-only account with no closed notice is anchored on its account_closed block", async () => {
    const w = await world({ syncBlockedReason: "account_closed", syncBlockedSince: CLOSED_AT });
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: CLOSED_AT.toISOString() });
  });

  it("CONTROL: an account that never closed earns nothing", async () => {
    const w = await world({});
    expect(await reopenedCatchUp(w.deps, w.ctx)).toBeNull();
  });
});
