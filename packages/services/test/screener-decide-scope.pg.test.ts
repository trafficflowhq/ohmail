import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import {
  accounts, mailboxes, messages, folderState, changeLog, organizerRequests, rules,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  ScreenerService, type ScreenDecisionResult, type ServiceContext,
} from "@trafficflow/services";

/**
 * A SCREENER DECISION IS ABOUT THE SENDER AND APPLIES ACCOUNT-WIDE (owner ruling, 0.20).
 *
 * ## Why this is a `*.pg.test.ts`
 *
 * The claim is transactional twice over: every mailbox's role is re-read under a `FOR SHARE` row
 * lock inside the decide's own transaction before its bag moves, and the request rows for
 * reader-role mailboxes commit IN THE SAME transaction as the decision — a crash between them
 * would leave a decision half-travelled. PGlite runs the statements but cannot witness the lock,
 * and CLAUDE.md pins transactional guarantees on real Postgres.
 *
 * MUTATION-WATCHED (each restored `cmp`-verified): (1) restore the mailbox filter on the held-bag
 * read (`heldRowsForSender(…, mailboxId)`) and the two-mailbox case goes red — one bag survives;
 * (2) drop the `writeReaderRequest` loop in `applyAsOrganizer` and the reader-mailbox case goes
 * red — no request row, `requested` empty.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `scope-${randomUUID().slice(0, 8)}`,
});

const SENDER = "post@ledgerandloom.test";
const HOLDER_SINCE = new Date("2026-08-20T08:30:00.000Z");

interface World {
  accountId: string;
  /** Organized here. */
  m1: string;
  /** Organized here (case 1) or held by "their-laptop" (case 2/3). */
  m2: string;
  /** Held message ids, keyed by mailbox. */
  held: { m1: string[]; m2: string[] };
}

async function world(m2role: "organizer" | "reader"): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `scope-${accountId.slice(0, 8)}` });
  const mk = async (n: number, role: "organizer" | "reader") => {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `scope-${n}-${accountId.slice(0, 8)}@example.test`,
      ...(role === "reader" ? {
        organizerRole: "reader" as const, organizerState: "held",
        organizedByCapabilities: "requests", organizedByKind: "local",
        organizedByName: "their-laptop", organizedSince: HOLDER_SINCE,
      } : {}),
    }).returning();
    return mb!.id;
  };
  const m1 = await mk(1, "organizer");
  const m2 = await mk(2, m2role);
  const seed = async (mailboxId: string, i: number) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: `h${i}`, dedupKey: `scope:${randomUUID()}`,
      subject: `Bulletin ${i}`, fromAddress: SENDER,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  return {
    accountId, m1, m2,
    held: { m1: [await seed(m1, 0)], m2: [await seed(m2, 1), await seed(m2, 2)] },
  };
}

const desiredOf = async (id: string) => {
  const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
  return fs?.desiredFolder;
};

describe.skipIf(!PG_UP)("decide covers the sender account-wide", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("one decision re-routes the sender's held bag in BOTH organized mailboxes, one move per message", async () => {
    const w = await world("organizer");
    const result = await new ScreenerService({}).decide(
      ctx(w.accountId), w.held.m1[0]!, { decision: "no" },
    ) as ScreenDecisionResult;

    const all = [...w.held.m1, ...w.held.m2];
    for (const id of all) expect(await desiredOf(id), `row ${id} was not re-routed`).toBe("ohmail/Screened");

    expect(new Set(result.mailboxes?.filed)).toEqual(new Set([w.m1, w.m2]));
    expect(result.mailboxes?.requested).toEqual([]);

    // One `move` per message in BOTH mailboxes (the echo a second surface re-derives the row from),
    // and no `update`: a screen-out marks nothing read.
    const opRows = async (op: "move" | "update") => (await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "message"), eq(changeLog.op, op),
    ))).map((r) => r.entityId).sort();
    expect(await opRows("move"), "missing move rows").toEqual([...all].sort());
    expect(await opRows("update"), "the screen-out wrote a read update").toEqual([]);

    // ONE promoted rule for the whole account-wide decision, and nothing queued.
    const created = await db.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(created).toHaveLength(1);
    const queued = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, w.accountId));
    expect(queued).toEqual([]);
  });

  it("a reader-role mailbox's bag is queued on the request road, named in the response, untouched on disk", async () => {
    const w = await world("reader");
    const result = await new ScreenerService({}).decide(
      ctx(w.accountId), w.held.m1[0]!, { decision: "yes" },
    ) as ScreenDecisionResult;

    // The writable mailbox filed now; the held one waits, visibly.
    expect(await desiredOf(w.held.m1[0]!)).toBe("INBOX");
    for (const id of w.held.m2) expect(await desiredOf(id), "a reader mailbox's row moved").toBe("ohmail/Screener");

    expect(result.mailboxes?.filed).toEqual([w.m1]);
    expect(result.mailboxes?.requested).toHaveLength(1);
    const req = result.mailboxes!.requested[0]!;
    expect(req.mailboxId).toBe(w.m2);
    expect(req.holder).toEqual({ kind: "local", name: "their-laptop", since: HOLDER_SINCE.toISOString() });

    // The request row commits WITH the decision, carrying exactly what the holder's drain needs.
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, req.requestId));
    expect(row?.state).toBe("pending");
    expect(row?.mailboxId).toBe(w.m2);
    expect(row?.kind).toBe("screener.decide");
    expect(row?.payload).toEqual({
      scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "yes",
      match: SENDER, applyRetro: true,
    });
  });

  it("the press on the READER mailbox's own row still files the organized mailbox — the branch is the account's, not the representative's", async () => {
    const w = await world("reader");
    // The target is m2's newest held message — pre-0.20 this pressed the 202 reader branch and
    // m1's bag stayed held until somebody noticed.
    const result = await new ScreenerService({}).decide(
      ctx(w.accountId), w.held.m2[0]!, { decision: "yes" },
    ) as ScreenDecisionResult;

    expect("pending" in result).toBe(false);
    expect(await desiredOf(w.held.m1[0]!)).toBe("INBOX");
    for (const id of w.held.m2) expect(await desiredOf(id)).toBe("ohmail/Screener");
    expect(result.mailboxes?.filed).toEqual([w.m1]);
    expect(result.mailboxes?.requested.map((r) => r.mailboxId)).toEqual([w.m2]);
  });
});
