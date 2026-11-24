import { describe, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, mailboxes } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { dbFor, type ServiceContext } from "../src/index.js";
import { expungeLeavesThePile } from "./_pile-gone-letter.js";

/**
 * The real-Postgres twin of `triage-pile-gone-letter.test.ts`: the reaper's tombstone is a write
 * inside a transaction with a change-log allocation, which PGlite does not witness. Every read is
 * scoped to this file's own random account, so it is a safe co-tenant.
 */
const PG_UP = await realPgAvailable();
// The factory's handle: the binder takes a server handle only from the factory that registered its door.
const owned = makeOwnedDb(PG_TEST_URL);
const db = owned.db;

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await owned.close(); });

describe.skipIf(!PG_UP)("a letter expunged on the server leaves its pile (Postgres)", () => {
  it("the reaper's tombstone takes it out of Answer Later and Reply Run; its return files it again", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pile-gone-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pile-gone-${accountId.slice(0, 8)}@example.test`, status: "connected",
    }).returning();
    const ctx: ServiceContext = {
      db: dbFor(db, accountId), accountId, userId: null, now: () => new Date("2026-10-12T02:00:00Z"), requestId: "pile-gone",
    };
    await expungeLeavesThePile(db, ctx, mb!.id);
  });
});
