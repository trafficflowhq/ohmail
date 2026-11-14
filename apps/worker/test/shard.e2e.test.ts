import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages, messageStates } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { loadEnabledMailboxes, accountInShard } from "../src/mailboxes.js";
import { LEADER_LOCK_KEY, leaderLockKeyFor } from "../src/leader-lock.js";
import { runWorkerSupervised } from "../src/supervisor.js";
import { runBubbleUpCron } from "../src/bubble-up-cron.js";
import { runReconcileCron } from "../src/reconcile-cron.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

async function hashOf(accountId: string): Promise<number> {
  const sql = postgres(DB, { max: 1 });
  try {
    const rows = await sql<{ h: number }[]>`SELECT hashtext(${accountId}::text) AS h`;
    return Number(rows[0]!.h);
  } finally { await sql.end({ timeout: 5 }); }
}

/** An account id whose `hashtext` has a chosen sign AND parity — the exact shape that bites. */
async function accountWithHash(want: (h: number) => boolean): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const id = randomUUID();
    if (want(await hashOf(id))) return id;
  }
  throw new Error("could not find an account id with the required hashtext shape");
}

async function seedMailbox(db: Db, accountId: string): Promise<string> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return row!.id;
}

/** A message with a DUE `bubbled_up` state — the row a bubble-up pass flips. */
async function seedDueBubbleUp(db: Db, accountId: string, mailboxId: string): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "later", fromAddress: "a@ex.example", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  const [st] = await db.insert(messageStates).values({
    accountId, messageId: m!.id, state: "bubbled_up", bubbleUpAt: new Date("2020-01-01T00:00:00Z"),
  }).returning();
  return st!.id;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

function cfgFor(fleet: FakeAdapterFleet, extra: Partial<WorkerConfig>): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 250, sentDomain: "trafficflow.test",
    rosterIntervalMs: 400, lockHeartbeatMs: 60_000, mailboxRetryMs: 500,
    healthPort: 0, standbyRetryMs: 400, adapterFactory: fleet.factory,
    ...extra,
  };
}

describe("shard seam", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_shard"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("serves accounts whose hashtext is NEGATIVE (not a random-uuid coin flip)", async () => {
    const db = makeDb(DB);
    // `hashtext` is int4 and half its range is negative. For a negative ODD hash, a plain
    // `h % 2` yields -1, which equals NEITHER shardIndex 0 nor 1 — the account is served by
    // NOBODY. Picking such an id deliberately is what makes this assertion bite; 20 random
    // uuids only make it likely.
    const negative = await accountWithHash((h) => h < 0 && h % 2 !== 0);
    const positive = await accountWithHash((h) => h > 0 && h % 2 !== 0);
    const negMb = await seedMailbox(db, negative);
    const posMb = await seedMailbox(db, positive);

    const s0 = await loadEnabledMailboxes(db, { shards: 2, shardIndex: 0 });
    const s1 = await loadEnabledMailboxes(db, { shards: 2, shardIndex: 1 });
    const ids0 = new Set(s0.map((m) => m.mailboxId));
    const ids1 = new Set(s1.map((m) => m.mailboxId));

    // Each of the two lands in EXACTLY one shard — complete and disjoint.
    expect(Number(ids0.has(negMb)) + Number(ids1.has(negMb))).toBe(1);
    expect(Number(ids0.has(posMb)) + Number(ids1.has(posMb))).toBe(1);
    // Normalized modulo: a negative odd hash belongs to shard 1, a positive odd one to shard 1
    // as well only if its own modulo says so — assert against the arithmetic, not a guess.
    const expectShard = (h: number): number => ((h % 2) + 2) % 2;
    expect(ids1.has(negMb)).toBe(expectShard(await hashOf(negative)) === 1);
    expect(ids1.has(posMb)).toBe(expectShard(await hashOf(positive)) === 1);

    // `accountInShard` (the crons' guard) must agree with the roster query exactly.
    expect(await accountInShard(db, negative, { shards: 2, shardIndex: 0 })).toBe(ids0.has(negMb));
    expect(await accountInShard(db, negative, { shards: 2, shardIndex: 1 })).toBe(ids1.has(negMb));
    // shards = 1 ⇒ everything is in shard 0, and the key is the historical one.
    expect(await accountInShard(db, negative, { shards: 1, shardIndex: 0 })).toBe(true);
    expect(leaderLockKeyFor(0)).toBe(LEADER_LOCK_KEY);
    expect(leaderLockKeyFor(1)).toBe(LEADER_LOCK_KEY + 1n);
  }, 60000);

  it("runs TWO shard workers side by side, each serving a disjoint slice", async () => {
    const db = makeDb(DB);
    const byMailbox = new Map<string, string>();          // mailboxId → accountId
    for (let i = 0; i < 12; i++) {
      const accountId = randomUUID();
      byMailbox.set(await seedMailbox(db, accountId), accountId);
    }

    const f0 = new FakeAdapterFleet();
    const f1 = new FakeAdapterFleet();
    // Two REAL instances at once, on DIFFERENT lock keys — this is the seam's actual claim.
    const w0 = await runWorkerSupervised(cfgFor(f0, { shards: 2, shardIndex: 0 }));
    closers.push(() => w0.stop());
    const w1 = await runWorkerSupervised(cfgFor(f1, { shards: 2, shardIndex: 1 }));
    closers.push(() => w1.stop());

    expect(w0.state()).toBe("leader");
    expect(w1.state()).toBe("leader");                    // NOT standby: a different lock key

    const served = (f: FakeAdapterFleet): Set<string> =>
      new Set([...f.open.entries()].filter(([, n]) => n > 0).map(([id]) => id));
    await waitFor(() => served(f0).size + served(f1).size === 12, 15000, "both shards to attach their slice");

    const set0 = served(f0);
    const set1 = served(f1);
    expect(set0.size).toBeGreaterThan(0);
    expect(set1.size).toBeGreaterThan(0);
    expect([...set0].some((id) => set1.has(id))).toBe(false);      // disjoint
    expect(set0.size + set1.size).toBe(12);                        // complete
  }, 60000);

  it("scopes the bubble-up backstop to its OWN shard's accounts", async () => {
    const db = makeDb(DB);
    const a = await accountWithHash((h) => ((h % 2) + 2) % 2 === 0);
    const b = await accountWithHash((h) => ((h % 2) + 2) % 2 === 1);
    const stateA = await seedDueBubbleUp(db, a, await seedMailbox(db, a));
    const stateB = await seedDueBubbleUp(db, b, await seedMailbox(db, b));

    // Shard 0's cron takes lock key `LEADER_LOCK_KEY + 0`; shard 1's worker would hold
    // `+ 1`. An unscoped pass would therefore mutate shard 1's rows behind that worker's back.
    const res = await runBubbleUpCron({
      databaseUrl: DB, pollIntervalMs: 1000, sentDomain: "trafficflow.test", shards: 2, shardIndex: 0,
    });
    expect(res.ran).toBe(true);
    expect(res.flipped).toBe(1);

    const [rowA] = await db.select().from(messageStates).where(eq(messageStates.id, stateA));
    const [rowB] = await db.select().from(messageStates).where(eq(messageStates.id, stateB));
    // `resurfaced`, not `none`: a due row's schedule is spent by being flipped, and the state it
    // lands in is what pins it at the top of the Ohbox until it is read. This assertion is about
    // SHARD SCOPING and still is — "flipped" versus "untouched" — but it named the flip's target,
    // and the target changed when resurfacing was introduced. Three other bubble-up tests were
    // updated with it and this one was missed, so it asserted a behaviour the pass no longer has.
    expect(rowA!.state).toBe("resurfaced");               // its own shard: flipped
    expect(rowB!.state).toBe("bubbled_up");               // the OTHER shard: untouched
  }, 60000);

  it("refuses a reconcile sweep of a mailbox outside its shard, or one it does not own", async () => {
    const db = makeDb(DB);
    const owner = await accountWithHash((h) => ((h % 2) + 2) % 2 === 1);   // lives in shard 1
    const mailboxId = await seedMailbox(db, owner);
    const imap = { host: "fake.invalid", port: 1143, secure: false, user: "u", pass: "p" };

    // Shard 0's cron must NOT sweep a shard-1 mailbox: shard 1's worker holds a different
    // lock and believes it is the only writer.
    const wrongShard = await runReconcileCron({
      databaseUrl: DB, accountId: owner, mailboxId, imap,
      pollIntervalMs: 1000, sentDomain: "trafficflow.test", shards: 2, shardIndex: 0,
    });
    expect(wrongShard).toEqual({ ran: false, reason: "other-shard" });

    // A TF_ACCOUNT_ID that does not own TF_MAILBOX_ID is a loud refusal, not a sweep that
    // writes rows under the wrong account.
    await expect(runReconcileCron({
      databaseUrl: DB, accountId: randomUUID(), mailboxId, imap,
      pollIntervalMs: 1000, sentDomain: "trafficflow.test", shards: 2, shardIndex: 1,
    })).rejects.toThrow(/belongs to account/);
  }, 60000);
});
