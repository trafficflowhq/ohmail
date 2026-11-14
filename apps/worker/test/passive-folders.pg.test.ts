import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, changeLog, folderState, mailboxes, messageInstances, messages, rules,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * THEIR FILING IS THEIRS — the two guarantees that live in SQL, against real Postgres.
 *
 * Mail in a folder the customer made is read, searchable and threaded, and NOTHING ohmail runs ever
 * moves it. The pipeline's early return is one gate; these are the other two, and both of them are
 * queries, so PGlite is green by construction for neither:
 *
 *  1. **`rule-retro`'s candidate set.** Its predicate was `desired_folder <> rule.destination` and
 *     nothing about WHICH folder the message is in, so anything not already at the destination
 *     qualified — the customer's own folders AND their Sent folder, which has been read since the Sent
 *     watch landed. One rule saying "this sender goes to Reads" would have emptied fifteen years of
 *     somebody's archive into a newsletter folder, in their real mailbox, on one pass.
 *  2. **`forgetInstanceAt`'s promotion.** `messages.native_locator` must name an instance that
 *     EXISTS. That held by accident until a message could legitimately hold two instances in ONE
 *     folder (see `pipeline.duplicate-copy.test.ts` for the loop that made it necessary), and the
 *     repair is a `DELETE … RETURNING` plus two `UPDATE`s — real SQL, ordered by a real column.
 */

const AVAILABLE = await realPgAvailable();

const OHBOX = "INBOX";
const READS = "ohmail/News";
const ARCHIVE = "Private/Editor";
const SENT = "Sent Messages";
const SENDER = "editor@example.com";
const NOW = new Date("2026-08-13T12:00:00Z");
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

describe.skipIf(!AVAILABLE)("passive folders, in SQL", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  interface World { accountId: string; mailboxId: string }

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pf-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /**
   * One stored message in `folder`, with a `folder_state` row.
   *
   * `lastSetBy` defaults to `'us'` DELIBERATELY, including for the archive rows. The pipeline writes
   * `'external'` for a passive arrival and that alone would keep every retro pass out — so seeding
   * `'us'` here is what makes this test measure the FOLDER predicate rather than the label. Delete the
   * folder scope from `selectCandidates` and these rows are candidates again.
   */
  async function seedMessage(
    w: World, folder: string, opts: { uid?: number; lastSetBy?: "us" | "external" } = {},
  ): Promise<string> {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "Frischer Auftritt", fromAddress: SENDER,
      nativeLocator: { folder, ref: `42:${opts.uid ?? 1}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
      lastSetBy: opts.lastSetBy ?? "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  const desiredOf = async (messageId: string): Promise<string> => {
    const [row] = await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, messageId));
    return row!.d;
  };

  const movesFor = (accountId: string, messageId: string) =>
    db.select({ meta: changeLog.meta }).from(changeLog).where(and(
      eq(changeLog.accountId, accountId),
      eq(changeLog.entityId, messageId),
      eq(changeLog.op, "move"),
    ));

  it("a rule NEVER moves mail out of a folder the customer made, or out of Sent", async () => {
    // ANTI-VACUITY IS THE WHOLE TEST. `ohbox` proves the rule fires, on the same sender, in the same
    // pass — so the two negatives below are about the FOLDER and not about a rule that never matched.
    //
    // Mutation watched, and the reported failure is the `examined` line rather than the two
    // negatives, because it is asserted first: replace the
    // `folderState.desiredFolder in (WATCHED_FOLDERS)` term in `selectCandidates` with `1 = 1` and
    // this reads `expected 3 to be 1` — the archive row and the Sent row are candidates again, which
    // is the whole defect in one number.
    const w = await newWorld();
    const ohbox = await seedMessage(w, OHBOX, { uid: 1 });
    const archived = await seedMessage(w, ARCHIVE, { uid: 2 });
    const sent = await seedMessage(w, SENT, { uid: 3 });

    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true,
      retroRequestedAt: new Date("2026-08-13T10:00:00Z"),
    });

    const res = await ruleRetroPass(
      db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW,
    );

    expect(res.rules, "the owed probe found no rule to walk").toBe(1);
    // ONE candidate, not three: the archive row and the Sent row are not in the candidate set at all.
    expect(res.examined).toBe(1);
    expect(res.moved).toBe(1);

    expect(await desiredOf(ohbox), "the rule must still work where ohmail organizes").toBe(READS);
    expect(await desiredOf(archived), "a rule re-filed the customer's own archive").toBe(ARCHIVE);
    expect(await desiredOf(sent), "a rule re-filed mail the customer WROTE").toBe(SENT);
    // …and no journal row claims either of them moved, so no client is told they did.
    expect(await movesFor(w.accountId, archived)).toHaveLength(0);
    expect(await movesFor(w.accountId, sent)).toHaveLength(0);
  }, 120_000);

  it("promotes a surviving instance when the primary is expunged", async () => {
    // `messages.native_locator` names an instance that EXISTS. Delete the promotion block from
    // `DrizzleRepo.forgetInstanceAt` and the last assertion reads `42:400` — a UID the server no
    // longer holds, which every read through a locator then fails on.
    const w = await newWorld();
    const id = await seedMessage(w, OHBOX, { uid: 400 });
    const repo = makeDrizzleRepo(db as unknown as Tx);
    // The primary, as `insertMessage` would have written it, plus the second physical copy
    // `commitChange` records for a same-folder duplicate.
    await db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: id,
      folder: OHBOX, uidvalidity: 42n, uid: 400, isPrimary: true,
      firstSeenAt: new Date("2026-08-01T00:00:00Z"),
    });
    await repo.recordInstance(id, { folder: OHBOX, ref: "42:900" });

    await repo.forgetInstanceAt(w.mailboxId, { folder: OHBOX, ref: "42:400" });

    const rows = await db.select({
      uid: messageInstances.uid, isPrimary: messageInstances.isPrimary,
    }).from(messageInstances).where(eq(messageInstances.messageId, id))
      .orderBy(asc(messageInstances.uid));
    expect(rows).toEqual([{ uid: 900, isPrimary: true }]);
    // The one nothing else in the system would have repaired: the row itself.
    const [msg] = await db.select({ loc: messages.nativeLocator }).from(messages)
      .where(eq(messages.id, id));
    expect(msg!.loc).toEqual({ folder: OHBOX, ref: "42:900" });
  }, 120_000);

  it("leaves the row alone when the vanished instance was NOT the primary", async () => {
    const w = await newWorld();
    const id = await seedMessage(w, OHBOX, { uid: 400 });
    const repo = makeDrizzleRepo(db as unknown as Tx);
    await db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: id,
      folder: OHBOX, uidvalidity: 42n, uid: 400, isPrimary: true,
    });
    await repo.recordInstance(id, { folder: ARCHIVE, ref: "77:5" });

    await repo.forgetInstanceAt(w.mailboxId, { folder: ARCHIVE, ref: "77:5" });

    const [msg] = await db.select({ loc: messages.nativeLocator }).from(messages)
      .where(eq(messages.id, id));
    expect(msg!.loc).toEqual({ folder: OHBOX, ref: "42:400" });
    const rows = await db.select({ uid: messageInstances.uid })
      .from(messageInstances).where(eq(messageInstances.messageId, id));
    expect(rows).toEqual([{ uid: 400 }]);
  }, 120_000);

  it("leaves the last known locator on the row when NOTHING survives", async () => {
    // A message whose every instance is gone is a message the server no longer holds. Inventing a
    // locator for it would be worse than leaving the last known one for the reaper to find.
    const w = await newWorld();
    const id = await seedMessage(w, OHBOX, { uid: 400 });
    const repo = makeDrizzleRepo(db as unknown as Tx);
    await db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: id,
      folder: OHBOX, uidvalidity: 42n, uid: 400, isPrimary: true,
    });

    await repo.forgetInstanceAt(w.mailboxId, { folder: OHBOX, ref: "42:400" });

    const [msg] = await db.select({ loc: messages.nativeLocator }).from(messages)
      .where(eq(messages.id, id));
    expect(msg!.loc).toEqual({ folder: OHBOX, ref: "42:400" });
    expect(await repo.primaryInstanceVanished(id)).toBe(true);
  }, 120_000);
});
