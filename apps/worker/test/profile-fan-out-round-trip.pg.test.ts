import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accountSettings, idempotencyKeys, mailboxes, type Tx, accountPass, readPassProgress } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { setScreeningPreference, type ScreeningPreferenceUpdate } from "@trafficflow/services/mail";
import { profileRoundTrip } from "./_profile-round-trip.js";

/**
 * The PGlite round trip's twin, with the organizer's drain on a real server: the fence, the
 * idempotency claim and the settings upsert run in one Postgres transaction. The reader stays on
 * PGlite; its store is not the subject. Every read is scoped to this run's own account.
 */

const AVAILABLE = await realPgAvailable();
const sql = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
const NOW = new Date("2026-09-20T10:00:00.000Z");
const T = 30_000;
const mine: string[] = [];

async function screening(update: ScreeningPreferenceUpdate, seed?: Omit<typeof accountSettings.$inferInsert, "accountId">) {
  const accountId = randomUUID();
  mine.push(accountId);
  if (seed) await db.insert(accountSettings).values({ ...seed, accountId });
  const rt = await profileRoundTrip({
    organizerDb: db, accountId, now: NOW, press: (ctx) => setScreeningPreference(ctx, update),
  });
  const [stored] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId));
  return { rt, stored, tidy: await readPassProgress(db as unknown as Tx, accountPass("ohbox_tidy", accountId)) };
}

describe.skipIf(!AVAILABLE)("a reader's screening edit reaches an organizer on real Postgres", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 120_000);
  afterEach(async () => {
    for (const accountId of mine.splice(0)) {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.accountId, accountId));
      await db.delete(accountSettings).where(eq(accountSettings.accountId, accountId));
      await db.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
    }
  });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("the object travels, the drain applies it, the reader is told applied", async () => {
    const { rt, stored, tidy } = await screening({ ohboxPolicy: "people_only", ohboxBar: "People I write back to." });
    expect(rt.drain).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });
    expect(rt.ack?.outcome, `refused: ${rt.ack?.reason}`).toBe("applied");
    expect(rt.readerRow?.state).toBe("applied");
    expect(stored?.ohboxPolicy).toBe("people_only");
    expect(stored?.ohboxBar).toBe("People I write back to.");
    expect(tidy.requestedAt).not.toBeNull();
  }, T);

  it("a partial edit leaves the keys it does not carry, and does not re-arm the backlog", async () => {
    const { rt, stored, tidy } = await screening({ impersonationFiling: false }, {
      ohboxPolicy: "people_only", ohboxBar: "old words",
    });
    expect(rt.readerRow?.state).toBe("applied");
    expect(stored?.impersonationFilingOffAt).not.toBeNull();
    expect(stored?.ohboxPolicy).toBe("people_only");
    expect(stored?.ohboxBar).toBe("old words");
    expect(tidy.requestedAt).toBeNull();
  }, T);
});
