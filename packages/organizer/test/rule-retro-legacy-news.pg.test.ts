import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * "ALSO MOVE" REACHES MAIL STILL FILED UNDER THE OLD NEWS NAME. A
 * mailbox organized before 0.22 holds News mail in the legacy folder; the retro pass's candidate
 * set is the one organized set, so a press into the Ohbox moves it, and a subject rule's own mail
 * stays. Under a News rule a row already in either spelling is at its place and never moves.
 * Real Postgres: the pass locks the rule row and commits cursor and journal in one transaction.
 */

const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
const AVAILABLE = await realPgAvailable();
const SENDER = "alerts@shop.example";
const TERM = "[Weekly-Digest]";
const NOW = new Date("2026-09-25T13:05:00Z");

describe.skipIf(!AVAILABLE)("rule-retro over mail in the legacy News folder", () => {
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
    await db.insert(accounts).values({ id: accountId, name: `f025-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  async function seed(w: World, subject: string, folder: string): Promise<string> {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject, fromAddress: SENDER, nativeLocator: { folder, ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  const desiredOf = async (id: string): Promise<string> => {
    const [row] = await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, id));
    return row!.d;
  };
  const movesOf = (w: World, id: string) => db.select({ meta: changeLog.meta }).from(changeLog)
    .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, id), eq(changeLog.op, "move")));
  const run = (w: World) =>
    ruleRetroPass(db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW);

  it("a press into the Ohbox moves the sender's mail out of the old News folder, and the subject's stays", async () => {
    const w = await newWorld();
    const oldA = await seed(w, "Order fulfilled", LEGACY_NEWS_FOLDER);
    const oldB = await seed(w, "Your parcel is on its way", LEGACY_NEWS_FOLDER);
    const split = await seed(w, `${TERM} week 38`, LEGACY_NEWS_FOLDER);
    const here = await seed(w, "Order received", "INBOX");
    // The reported pair: the bare rule the press re-armed, and the older subject split in the old spelling.
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: "INBOX",
      provenance: "seeded-from-sent", enabled: true, retroRequestedAt: new Date("2026-09-25T13:02:29Z"),
    });
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: LEGACY_NEWS_FOLDER,
      provenance: "manual", enabled: true, subjectContains: TERM,
    });

    const res = await run(w);
    expect(res.rules).toBe(1);
    expect(res.moved, "the old News folder is outside the pass's candidate set").toBe(2);
    expect(await desiredOf(oldA)).toBe("INBOX");
    expect(await desiredOf(oldB)).toBe("INBOX");
    expect((await movesOf(w, oldA))[0]!.meta).toEqual({ from: LEGACY_NEWS_FOLDER, to: "INBOX" });
    // The subject rule outranks the bare rule for its own mail: it stays where the split put it.
    expect(await desiredOf(split)).toBe(LEGACY_NEWS_FOLDER);
    expect(await movesOf(w, split)).toHaveLength(0);
    expect(await desiredOf(here)).toBe("INBOX");
  }, 120_000);

  it("under a News rule, mail in either spelling is already at its place and never moves", async () => {
    const w = await newWorld();
    const legacy = await seed(w, "Weekly letter 37", LEGACY_NEWS_FOLDER);
    const inbox = await seed(w, "Weekly letter 38", "INBOX");
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: "ohmail/News",
      provenance: "manual", enabled: true, retroRequestedAt: new Date("2026-09-25T13:02:29Z"),
    });

    const res = await run(w);
    expect(res.moved).toBe(1);
    expect(await desiredOf(inbox)).toBe("ohmail/News");
    expect(await desiredOf(legacy)).toBe(LEGACY_NEWS_FOLDER);
    expect(await movesOf(w, legacy)).toHaveLength(0);
  }, 120_000);
});
