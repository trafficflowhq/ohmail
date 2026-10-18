/* @postpush: alone — this file asserts the unsubscribe drain's OWN sweep totals, and that drain's
 * window is deployment-wide. One post-push run ran it beside 96 co-tenants on one lane database: they
 * seeded the window, the anti-vacuity guard refused by name, and each of the three passed when run
 * alone on a fresh one. The post-push driver reads this marker and runs the file by itself. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { learningSignals,
  accountSettings, accounts, mailboxes, messages, messageBodies, folderState, rules, unsubscribeRecords,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  makeUnsubscribeService, setBlockAutoUnsubscribe, UNSUB_SYNC_MAX,
  type ServiceContext, type HostResolver, type OneClickPost,
} from "@trafficflow/services";

/**
 * THE AUTO-UNSUBSCRIBE SWITCH, ON REAL POSTGRES (mail 0054).
 *
 * ── WHY THIS FILE EXISTS BESIDE THE PGlite ONE ────────────────────────────────────────────
 *
 * `unsubscribe-auto-trigger.test.ts` asserts the switch's LOGIC — default on, opt-out off, the
 * manual button ungated — and PGlite is adequate for every one of those, because each is one
 * statement read by one caller. Three things about this switch are not that, and PGlite is
 * structurally unable to see any of them: it is single-connection, so it serializes what
 * production interleaves, and it is a different implementation of the catalog, so a column the
 * migration failed to add can still exist in its schema image.
 *
 *  1. **THE COLUMN IS REALLY THERE.** `blocked()` swallows a read failure and answers "do not
 *     send" — the safe direction, and a completely silent one. So a migration that never ran
 *     turns the feature off for everybody with no error anywhere, and the PGlite suite would
 *     stay green because it builds its schema from the same journal it is testing. Asserting the
 *     DEFAULT case against a database the real migrator migrated is what distinguishes "the
 *     switch is off" from "the column is missing".
 *  2. **THE READ RACES THE WRITE.** The switch is read AFTER the screen-out transaction has
 *     committed, on a connection that is not the one that wrote the settings row. Somebody
 *     turning the switch off in Settings while a screen-out is in flight is two connections
 *     against one row, which PGlite cannot express.
 *  3. **IT MUST NOT SERIALIZE THE PASS.** The read is one indexed row per pass, taken outside
 *     any transaction the screen-out holds. A `FOR UPDATE`, or a read moved inside the caller's
 *     transaction, would make every concurrent screen-out on an account queue behind it — which
 *     on PGlite looks exactly like correct behaviour, because everything queues there anyway.
 *
 * **NO REAL SENDER IS CONTACTED.** Every request goes to an injected recording port that opens
 * no socket, and the OFF cases use a port that fails the test at the call site if it is reached.
 *
 * `max: 8`, deliberately: `max: 1` would queue the concurrent statements in the client and
 * reintroduce the exact blind spot this file exists to remove.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `sw-pg-${randomUUID().slice(0, 8)}`,
});

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`). Each letter below carries that
 * provider's confirmation of its sender: the automatic arm asks a list only for a confirmed sender.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);

function countingPost(): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

const FORBIDDEN_POST: OneClickPost = {
  async post(url: string) {
    throw new Error(`the unsubscribe port was called, and it must not have been: ${url}`);
  },
};

const svcWith = (post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

interface World { accountId: string; mailboxId: string; messageIds: string[] }

/** One account, one mailbox, N screened-out messages from N DIFFERENT one-click lists. */
async function newWorld(n: number): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `sw-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `sw-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const messageIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `sw:${randomUUID()}`,
      subject: `Weekly ${i}`, fromAddress: `news-${i}@sender-${i}.example`,
      nativeLocator: { folder: "ohmail/Screened", ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, text: "",
      headers: {
        // A DIFFERENT list per message, so nothing here is deduped by the record table's unique
        // index — every message is independently actionable and the only thing that can stop a
        // request is the switch.
        "list-id": [`Weekly <list-${i}.sender.example>`],
        "list-unsubscribe": [`<https://sender-${i}.example/u?t=${randomUUID()}>`],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        "authentication-results": ["mx.google.com; dmarc=pass"],
      },
    });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    messageIds.push(m!.id);
    // A person screened the sender out — the automatic arm's licence (UD-R4-03, mail 0128).
    await db.insert(rules).values({
      accountId, kind: "sender", match: m!.fromAddress.toLowerCase(), destination: "ohmail/Screened",
      provenance: "promoted", personDecidedAt: new Date(),
    });
    await db.insert(learningSignals).values({
      accountId, triggeringActionId: `screener:${randomUUID()}`, kind: "screener",
      senderAddress: m!.fromAddress.toLowerCase(), destination: "ohmail/Screened", label: "positive",
    });
  }
  return { accountId, mailboxId: mb!.id, messageIds };
}

const recordsOf = async (accountId: string) =>
  db.select().from(unsubscribeRecords).where(eq(unsubscribeRecords.accountId, accountId));

describe.skipIf(!PG_UP)("the auto-unsubscribe switch, against the real migrated catalog", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * THE MIGRATION RAN, PROVED BY THE DEFAULT STILL WORKING.
   *
   * This is the assertion the PGlite suite cannot make. `blocked()` catches a read failure and
   * answers "do not send", so a database missing `block_auto_unsubscribe_at` produces a feature
   * that is silently off — no throw, no 500, and a `sweep` of zeros that reads exactly like an
   * account that opted out. Drop the column from `0054_auto_unsubscribe_optout.sql` and this
   * goes red; drop it from the journal and this goes red; leave both alone and PGlite cannot
   * tell the difference.
   */
  it("DEFAULT: a migrated database with no settings row still unsubscribes", async () => {
    const w = await newWorld(1);
    const post = countingPost();

    const sweep = await svcWith(post).onScreenOut(ctx(w.accountId), w.messageIds);

    expect(sweep, "the default stopped sending — the column is probably missing")
      .toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toHaveLength(1);
    expect(await recordsOf(w.accountId)).toHaveLength(1);
  });

  it("OFF: the opt-out written through the real service suppresses the whole pass", async () => {
    const w = await newWorld(3);
    // Through `setBlockAutoUnsubscribe`, not a hand-written INSERT: the claim is that what the
    // Settings switch stores is what the seam reads, and a test that writes the column itself
    // would still pass if the writer put the instant in the wrong column.
    await setBlockAutoUnsubscribe(ctx(w.accountId), true);

    const sweep = await svcWith(FORBIDDEN_POST).onScreenOut(ctx(w.accountId), w.messageIds);

    expect(sweep).toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
    // The evidence surface. `unsubscribe_records` is the durable record of every request this
    // service has ever made, so "zero rows" is the strongest available statement that nothing
    // left the building — stronger than the port's call count, which lives only in this process.
    expect(await recordsOf(w.accountId)).toHaveLength(0);
  });

  it("OFF then ON again: clearing the opt-out restores the pass, with nothing consumed", async () => {
    const w = await newWorld(2);
    await setBlockAutoUnsubscribe(ctx(w.accountId), true);
    expect((await svcWith(FORBIDDEN_POST).onScreenOut(ctx(w.accountId), w.messageIds)).posted)
      .toBe(0);

    await setBlockAutoUnsubscribe(ctx(w.accountId), false);
    const post = countingPost();

    // THE HALF THAT WOULD NOT BE TRUE IF THE BLOCKED PASS HAD WRITTEN `refused` ROWS. The record
    // table's unique key is (mailbox, list), so a row written while the switch was off would
    // consume the claim for ever — a reversible preference with an irreversible side effect, and
    // the user would find their lists permanently unreachable after one round trip of the switch.
    expect(await svcWith(post).onScreenOut(ctx(w.accountId), w.messageIds))
      .toEqual({ considered: 2, posted: 2, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toHaveLength(2);
  });

  /**
   * THE RACE, WHICH IS THE REASON THIS IS A pg TEST AND NOT A PGlite ONE.
   *
   * The switch is read after the screen-out has committed, on a pooled connection that is not the
   * one Settings wrote on. Somebody pressing the switch while a screen-out is in flight is two
   * connections against one row.
   *
   * WHAT IS ASSERTED IS NOT AN ORDERING — that would be a race in the test. It is that BOTH
   * outcomes are internally consistent: whichever way the interleaving falls, the number of
   * requests made and the number of record rows agree, and the ON outcome is bounded by the batch
   * size. A read that saw a torn row, or a pass that half-applied the switch across its own batch,
   * fails this even though the outcome is nondeterministic.
   */
  it("a switch flipped mid-flight produces one consistent outcome, never a half-applied pass", async () => {
    const w = await newWorld(6);
    const post = countingPost();

    const [, ] = await Promise.all([
      svcWith(post).onScreenOut(ctx(w.accountId), w.messageIds),
      setBlockAutoUnsubscribe(ctx(w.accountId), true),
    ]);

    const rows = await recordsOf(w.accountId);
    // One read per pass, so the pass is all-or-nothing: either it saw no opt-out and worked the
    // batch, or it saw one and did nothing. A per-message read would let the switch land
    // mid-batch and produce a count strictly between the two.
    //
    // THE BATCH IS WHAT THE REQUEST MAY POST TO, not what it was handed: six targets against a
    // per-request ceiling of `UNSUB_SYNC_MAX` is five, with the sixth left to the hourly drain.
    // The fixture is DELIBERATELY larger than the ceiling — the switch's property is about one
    // read per pass, and it has to hold on the batch shape where a ceiling is also acting.
    const batch = Math.min(w.messageIds.length, UNSUB_SYNC_MAX);
    expect(batch).toBeLessThan(w.messageIds.length);
    expect([0, batch], `a half-applied pass sent ${post.calls.length} of ${batch}`)
      .toContain(post.calls.length);
    expect(rows).toHaveLength(post.calls.length);
  });

  /**
   * IT MUST NOT SERIALIZE. Two accounts, two passes, at the same time — the shape a hosted
   * deployment is in constantly. A `FOR UPDATE` on the settings row, or a read pulled inside a
   * transaction the caller holds, would make these queue; on PGlite they queue regardless, which
   * is exactly why that suite cannot make this claim.
   */
  it("two accounts' passes do not block on each other's settings row", async () => {
    const a = await newWorld(2);
    const b = await newWorld(2);
    await setBlockAutoUnsubscribe(ctx(b.accountId), true);
    const post = countingPost();

    const [sweepA, sweepB] = await Promise.all([
      svcWith(post).onScreenOut(ctx(a.accountId), a.messageIds),
      svcWith(FORBIDDEN_POST).onScreenOut(ctx(b.accountId), b.messageIds),
    ]);

    expect(sweepA).toEqual({ considered: 2, posted: 2, skipped: 0, failed: 0, remaining: 0 });
    expect(sweepB).toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
    expect(await recordsOf(b.accountId)).toHaveLength(0);
  });

  /**
   * THE MANUAL BUTTON, on real Postgres for the same reason as the default case: the read that
   * would gate it does not exist on this path at all, and the assertion is that it stays that
   * way against a catalog that really has the column to read.
   */
  it("OFF: the per-message button still sends — the switch names the automatic pass only", async () => {
    const w = await newWorld(1);
    await setBlockAutoUnsubscribe(ctx(w.accountId), true);
    const post = countingPost();

    const result = await svcWith(post).unsubscribe(ctx(w.accountId), w.messageIds[0]!);

    expect(result.posted).toBe(true);
    expect(post.calls).toHaveLength(1);
  });
});
