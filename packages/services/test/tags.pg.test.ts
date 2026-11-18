import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { accounts, mailboxes, messages, tags, messageTags } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  TagsService, deleteAccount, materializeMessage, materializeMessages, type ServiceContext,
} from "@trafficflow/services";

/**
 * TAGS, ON REAL POSTGRES — the two claims PGlite structurally cannot check.
 *
 * PGlite is a single-connection, single-process Postgres. It serializes everything, so a lock
 * that is missing behaves exactly like a lock that is held and a lost update never reproduces.
 * Three production bugs in this repo were invisible to it, and a mutation that removed
 * `FOR UPDATE` from the folder mover let two passes double-move a whole batch of messages while the PGlite
 * suite stayed green. So the two properties this slice's concurrency rests on are asserted here,
 * against a real pool, or they are not asserted at all:
 *
 *   1. TWO CONCURRENT TOGGLES OF DIFFERENT TAGS ON ONE MESSAGE BOTH SURVIVE. This is the
 *      property the DELTA wire shape exists to provide. The rejected design — PATCH the full
 *      next `labels` array, as `types.ts` originally described — is a read-modify-write, and
 *      under a real pool the second writer's array (computed before the first committed) erases
 *      the first writer's tag. That is silent data loss on mail, so the test drives both
 *      directions at once and demands both rows.
 *
 *   2. DELETE-A-TAG VS ASSIGN-THAT-TAG NEVER ENDS IN AN FK 500. `remove` clears `message_tags`
 *      then deletes the parent; without the `FOR UPDATE` on the `tags` row a concurrent
 *      `assign` slips a child row in between the two statements and the parent delete dies on
 *      its foreign key. With the lock, the assigner blocks on the parent row and then fails its
 *      own lookup — a truthful 404, not a 500.
 *
 * A `max: 8` pool, deliberately: `max: 1` would queue the "concurrent" statements in the client
 * and reintroduce the exact blind spot this file exists to remove.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let owned: OwnedDb;
let db: OwnedDb["db"];
const svc = new TagsService();

const ctx = (accountId: string): ServiceContext => ({
  db: dbFor(db, accountId),
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `tags-pg-${randomUUID().slice(0, 8)}`,
});

interface World { accountId: string; messageId: string }

async function newWorld(): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `w6-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `w6-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `w6:${randomUUID()}`,
    subject: "Invoice 41", fromAddress: "billing@example.test",
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  return { accountId, messageId: m!.id };
}

const labelsOf = async (w: World): Promise<string[]> => {
  const rows = await db.select({ tagId: messageTags.tagId }).from(messageTags)
    .where(and(eq(messageTags.messageId, w.messageId), eq(messageTags.accountId, w.accountId)));
  return rows.map((r) => r.tagId).sort();
};

describe.skipIf(!PG_UP)("tags — the concurrency PGlite cannot see", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); await client?.end({ timeout: 5 }); });

  it("two concurrent toggles of DIFFERENT tags on one message both survive", async () => {
    const w = await newWorld();
    const a = (await svc.create(ctx(w.accountId), { name: "invoices" })).dto;
    const b = (await svc.create(ctx(w.accountId), { name: "travel" })).dto;

    // Both at once, from two pool connections. Under the rejected array-PATCH shape one of
    // these two tags is gone when the dust settles.
    await Promise.all([
      svc.assign(ctx(w.accountId), w.messageId, a.id, true),
      svc.assign(ctx(w.accountId), w.messageId, b.id, true),
    ]);

    expect(await labelsOf(w), "a concurrent toggle lost the other tag").toEqual([a.id, b.id].sort());
  });

  it("the SAME tag toggled on by eight callers at once leaves exactly one row", async () => {
    const w = await newWorld();
    const tag = (await svc.create(ctx(w.accountId), { name: "receipts" })).dto;

    await Promise.all(
      Array.from({ length: 8 }, () => svc.assign(ctx(w.accountId), w.messageId, tag.id, true)),
    );

    // `ON CONFLICT DO NOTHING` on the (message_id, tag_id) PK. A synthetic id would have
    // allowed eight rows here and the UI would have rendered the chip eight times.
    expect(await labelsOf(w)).toEqual([tag.id]);
  });

  it("deleting a tag while it is being assigned never raises an FK error", async () => {
    const w = await newWorld();
    const tag = (await svc.create(ctx(w.accountId), { name: "doomed" })).dto;

    // Race the delete against assigns of the very tag being deleted. Every outcome must be
    // either success or a clean 404 — never a foreign-key 500, and never a surviving orphan.
    const outcomes = await Promise.allSettled([
      svc.remove(ctx(w.accountId), tag.id),
      ...Array.from({ length: 6 }, () => svc.assign(ctx(w.accountId), w.messageId, tag.id, true)),
    ]);

    for (const o of outcomes) {
      if (o.status === "rejected") {
        const code = (o.reason as { code?: string }).code;
        expect(code, `expected a clean refusal, got: ${String(o.reason)}`).toBe("not_found");
      }
    }
    // The parent is gone and NOTHING references it.
    const parent = await db.select().from(tags).where(eq(tags.id, tag.id));
    expect(parent, "the tag survived its own delete").toHaveLength(0);
    const orphans = await db.select().from(messageTags).where(eq(messageTags.tagId, tag.id));
    expect(orphans, "an assignment outlived the tag it names").toHaveLength(0);
  });

  it("tag-or-create under a concurrent race yields ONE tag, not two", async () => {
    const w = await newWorld();

    // Six callers each type the same new name at the same moment, each minting its own id.
    // The `lower(name)` unique index is what makes exactly one of them the real tag; the
    // others must resolve to the winner rather than 409-ing a user for typing a word.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        svc.assign(ctx(w.accountId), w.messageId, randomUUID(), true, "Quarterly"),
      ),
    );

    const rows = await db.select().from(tags).where(eq(tags.accountId, w.accountId));
    expect(rows, "the same name was created twice").toHaveLength(1);
    // Every caller reports the SAME winning tag, and the message carries it once.
    expect(new Set(results.map((r) => r.tagId)).size).toBe(1);
    expect(results[0]!.tagId).toBe(rows[0]!.id);
    expect(await labelsOf(w)).toEqual([rows[0]!.id]);
  });

  it("case-insensitive names collide, so 'Invoices' cannot shadow 'invoices'", async () => {
    const w = await newWorld();
    await svc.create(ctx(w.accountId), { name: "invoices" });
    await expect(svc.create(ctx(w.accountId), { name: "Invoices" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  /**
   * THE GUARD THAT CLOSES "BUILT, TESTED, UNREACHABLE".
   *
   * Everything else here proves rows land in the right tables. This proves the rows come BACK
   * through the path the UI actually reads. `MessageDTO.labels` was a hardcoded `[]` in
   * `materialize.ts` for the whole of Phase 1, which is precisely why a fully-built tag UI did
   * nothing on a live account while every fixture test passed: the client renders a chip only
   * for `tags.filter(t => m.labels.includes(t.id))`, so an always-empty array is an invisible
   * feature rather than a broken one. Restore that `[]` and this test — and only this test —
   * goes red.
   */
  it("the assignment comes back through materialize, which is what the UI reads", async () => {
    const w = await newWorld();
    const a = (await svc.create(ctx(w.accountId), { name: "alpha" })).dto;
    const b = (await svc.create(ctx(w.accountId), { name: "beta" })).dto;
    await svc.assign(ctx(w.accountId), w.messageId, a.id, true);
    await svc.assign(ctx(w.accountId), w.messageId, b.id, true);

    const dto = await materializeMessage(db as never, w.accountId, w.messageId);
    expect(dto, "the message vanished").toBeTruthy();
    expect([...dto!.labels].sort(), "labels never reached the DTO the UI reads")
      .toEqual([a.id, b.id].sort());

    // And the batch path, which is the one `/sync` uses for every page.
    const many = await materializeMessages(db as never, w.accountId, [w.messageId]);
    expect([...many.get(w.messageId)!.labels].sort()).toEqual([a.id, b.id].sort());

    // Unassigning removes it from the DTO too — not just from the table.
    await svc.assign(ctx(w.accountId), w.messageId, a.id, false);
    const after = await materializeMessage(db as never, w.accountId, w.messageId);
    expect(after!.labels).toEqual([b.id]);
  });

  it("one account's labels never leak into another's materialized message", async () => {
    // `message_tags.account_id` is denormalized, so this asserts the belt-and-braces filter in
    // `materializeMessages` rather than trusting the join.
    const mine = await newWorld();
    const theirs = await newWorld();
    const tag = (await svc.create(ctx(mine.accountId), { name: "mine" })).dto;
    await svc.assign(ctx(mine.accountId), mine.messageId, tag.id, true);

    const dto = await materializeMessage(db as never, theirs.accountId, mine.messageId);
    expect(dto, "another account's message was materialized at all").toBeNull();
  });

  /**
   * THE CLAIM IN THE UI, EXECUTED. `en.json` tells the user "erasing your account erases them",
   * and this is the line that makes that sentence true rather than aspirational.
   *
   * It is also the FK-ordering guard. `message_tags` references BOTH `messages` and `tags` with
   * `ON DELETE no action`, so an erasure that deleted `messages` before clearing assignments
   * would abort the whole transaction — an Art. 17 request that fails on a foreign key. Move
   * the two tag deletes below `messages` in `account-deletion-service.ts` and this goes red with
   * a 23503 rather than with a count mismatch.
   */
  it("erasing the account erases the tags — the sentence the UI shows is executable", async () => {
    const w = await newWorld();
    const tag = (await svc.create(ctx(w.accountId), { name: "keepsake" })).dto;
    await svc.assign(ctx(w.accountId), w.messageId, tag.id, true);

    const result = await deleteAccount(ctx(w.accountId));
    expect(result.deleted.message_tags).toBe(1);
    expect(result.deleted.tags).toBe(1);

    expect(await db.select().from(tags).where(eq(tags.accountId, w.accountId))).toHaveLength(0);
    expect(await db.select().from(messageTags).where(eq(messageTags.accountId, w.accountId)))
      .toHaveLength(0);
  });

  it("a tag is never visible across accounts", async () => {
    const mine = await newWorld();
    const theirs = await newWorld();
    const tag = (await svc.create(ctx(mine.accountId), { name: "private" })).dto;

    // The other account may not assign it, and may not see it.
    await expect(svc.assign(ctx(theirs.accountId), theirs.messageId, tag.id, true))
      .rejects.toMatchObject({ code: "not_found" });
    expect(await svc.list(ctx(theirs.accountId))).toEqual([]);
  });
});
