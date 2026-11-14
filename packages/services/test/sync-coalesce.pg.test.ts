import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, messages, recordChange } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { syncService, STALE_COALESCE_SPAN } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { ClientMirror, flatten } from "./_apply-harness.js";

/**
 * THE COALESCED STALE READ ON REAL POSTGRES — the two things PGlite cannot pin.
 *
 * `sync-coalesce.test.ts` proves the equivalence contract (coalesced resume ≡ full replay,
 * deletions included) on PGlite. What only a real server with a SECOND CONNECTION can prove:
 *
 *  1. **The nested DISTINCT ON page runs on the deployed engine.** The coalesced page is a
 *     subquery-in-subquery (`span → latest → page`) that drizzle compiles once and two engines
 *     execute; a syntax or type-mapping divergence between PGlite and Postgres 16 would ship a
 *     500 on exactly the stale-resume path the diet exists for.
 *
 *  2. **`hasMore` against a MOVING horizon strands nothing.** The coalesced page's `hasMore`
 *     compares the emitted cursor against `max(seq)` read at the top of the SAME request — a
 *     bounds read in its own statement, not a transaction. A writer committing between the two
 *     reads can only RAISE the true max, so the worst case is a drain that reports done one
 *     poll early and picks the stragglers up on the next poll — the same tolerate-in-the-safe-
 *     direction posture the 410 ceiling documents. The test drains a >threshold span while a
 *     writer keeps committing, then polls once more and requires FULL convergence.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-08-29T12:00:00.000Z");

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "coalesce-pg",
});

async function commitMessage(accountId: string, mailboxId: string, tag: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [m] = await tx.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `coalesce:${tag}`,
      subject: tag, fromAddress: "anna@x.example", date: NOW,
      nativeLocator: { folder: "INBOX", ref: `1:${tag}` },
    }).returning();
    await tx.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    await recordChange(tx, { accountId, entityType: "message", entityId: m!.id, op: "create", meta: null });
    return m!.id;
  });
}

const touch = (accountId: string, id: string) => db.transaction((tx) =>
  recordChange(tx, { accountId, entityType: "message", entityId: id, op: "update", meta: null }));

describe.skipIf(!PG_UP)("the coalesced stale read (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 6 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("dedups a >threshold span, converges against a live writer, and deletes stay deleted", async () => {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `coalesce-${accountId}@tf.example`,
    }).returning();
    const mailboxId = mb!.id;

    // The mirror's base state: three messages, drained plain.
    const keep = await commitMessage(accountId, mailboxId, "keep");
    const churn = await commitMessage(accountId, mailboxId, "churn");
    const doomed = await commitMessage(accountId, mailboxId, "doomed");
    const mirror = new ClientMirror();
    const base = await syncService.getChanges(ctx(accountId), { limit: 2000 });
    mirror.applyResponse(base);
    const sleptAt = base.cursor;

    // The busy span: churn past the threshold on ONE entity, delete another mid-span.
    for (let i = 0; i < STALE_COALESCE_SPAN / 2; i += 1) await touch(accountId, churn);
    await db.transaction(async (tx) => {
      await tx.delete(folderState).where(eq(folderState.messageId, doomed));
      await tx.delete(messages).where(eq(messages.id, doomed));
      await recordChange(tx, { accountId, entityType: "message", entityId: doomed, op: "delete", meta: null });
    });
    for (let i = 0; i < STALE_COALESCE_SPAN / 2 + 20; i += 1) await touch(accountId, churn);

    // Resume the stale cursor while a writer keeps committing — the moving horizon.
    let stop = false;
    const written: string[] = [];
    const writer = (async () => {
      for (let i = 0; i < 15 && !stop; i += 1) {
        written.push(await commitMessage(accountId, mailboxId, `race-${i}`));
        await new Promise((r) => setTimeout(r, 3));
      }
    })();

    let cursor = sleptAt;
    let wired = 0;
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getChanges(ctx(accountId), { since: cursor, limit: 100 });
      mirror.applyResponse(page);
      wired += flatten(page).length;
      cursor = page.cursor;
      if (!page.hasMore) break;
      if (guard > 100) throw new Error("coalesced drain did not terminate");
    }
    stop = true;
    await writer;

    // The diet happened: far fewer rows than the stale span crossed the wire.
    expect(wired).toBeLessThan(STALE_COALESCE_SPAN / 4);

    // One more poll — the safe-direction race means stragglers land NEXT poll, never never.
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getChanges(ctx(accountId), { since: cursor, limit: 100 });
      mirror.applyResponse(page);
      cursor = page.cursor;
      if (!page.hasMore) break;
      if (guard > 100) throw new Error("straggler poll did not terminate");
    }

    const state = mirror.snapshot();
    expect(state.has(`message:${keep}`)).toBe(true);
    expect(state.has(`message:${churn}`)).toBe(true);
    expect(state.has(`message:${doomed}`), "a deletion inside the coalesced span resurrected").toBe(false);
    for (const id of written) expect(state.has(`message:${id}`), "a mid-drain commit was stranded").toBe(true);
    expect(state.size).toBe(2 + written.length);
  }, 120_000);
});
