import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, accountSettings, mailboxes, messages, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  ScreenerService, confirmSeed, resetScreeningState, type ServiceContext,
} from "@trafficflow/services";

/**
 * THE SCREENING BASELINE, STAMPED ON THE FIRST DECIDE — mail 0056, on real Postgres.
 *
 * The baseline is the instant the cutline measures its dormancy window back from. Establishing it
 * is a one-time event and the value matters (readers do arithmetic on it, not an `IS NOT NULL`
 * check), which makes "which write wins" a question with a wrong answer rather than a tie.
 *
 * ── WHY `.pg.test.ts` ────────────────────────────────────────────────────────────────────
 *
 * The stamp is `INSERT … ON CONFLICT (account_id) DO UPDATE … WHERE screening_baseline_at IS
 * NULL`, inside the decide transaction. Its correctness under concurrency is a property of the
 * primary-key row lock: two decides land together, Postgres serialises them, and the loser
 * re-evaluates the predicate against the WINNER'S COMMITTED ROW and skips.
 *
 * PGlite is single-connection, so two `await`ed decides there are sequential by construction — a
 * sequential test of a concurrent property cannot fail, and a read-then-write implementation
 * passes it while producing two different baselines on a live account. Same argument, same shape
 * and same `max: 4` as `consent-auto-suggest.concurrency.pg.test.ts` beside it.
 *
 * ── THE FOUR PROPERTIES ──────────────────────────────────────────────────────────────────
 *
 * 1. NO BASELINE BEFORE THE FIRST DECIDE. NULL is the pre-0056 behaviour at every layer, so an
 *    account that has never decided anything must not carry one — including an account that has
 *    a settings row for other reasons.
 * 2. THE FIRST DECIDE STAMPS IT.
 * 3. A LATER DECIDE DOES NOT MOVE IT. Re-stamping would drag the cutoff forward on every press
 *    and silently drop senders out of the queue as a side effect of answering a different one.
 * 4. A SCREENING RESET CLEARS IT. Without that, the reset deletes every rule — making every
 *    sender undecided again — while the old baseline goes on filing all of their pre-cutoff mail
 *    into History, so "start over" produces an empty Screener.
 * 5. CONCURRENT FIRST DECIDES PRODUCE ONE BASELINE. Two devices, or a client firing a batch.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string, now?: Date): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => now ?? new Date(),
  requestId: `baseline-${randomUUID().slice(0, 8)}`,
});

interface World { accountId: string; held: string[]; addresses: string[] }

/** An account with `senders` distinct first-contact senders, one held message each. */
async function newWorld(senders = 2): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `bl-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `bl-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const held: string[] = [];
  const addresses: string[] = [];
  for (let i = 0; i < senders; i += 1) {
    const address = `sender${i}-${accountId.slice(0, 8)}@waiting.test`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `bl:${randomUUID()}`,
      subject: `Hello ${i}`, fromAddress: address,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    held.push(m!.id);
    addresses.push(address);
  }
  return { accountId, held, addresses };
}

const baselineOf = async (accountId: string): Promise<Date | null> => {
  const [row] = await db.select().from(accountSettings)
    .where(eq(accountSettings.accountId, accountId)).limit(1);
  return row?.screeningBaselineAt ?? null;
};

describe.skipIf(!PG_UP)("mail 0056 — the screening baseline on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("an account that has never decided anything carries NO baseline", async () => {
    const w = await newWorld(1);
    expect(await baselineOf(w.accountId)).toBeNull();

    // …and neither does one whose settings row exists for another reason. `confirmSeed` is
    // answered BEFORE any mail has been screened, so it is deliberately not the baseline event —
    // an absent row and a row with a NULL baseline must read the same.
    await confirmSeed(ctx(w.accountId), []);
    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, w.accountId)).limit(1);
    expect(row).toBeDefined();
    expect(row!.screeningBaselineAt).toBeNull();
  });

  it("THE FIRST DECIDE STAMPS IT, and a LATER decide does not move it", async () => {
    const w = await newWorld(2);
    const svc = new ScreenerService({});

    const first = new Date("2026-08-05T12:00:00.000Z");
    await svc.decide(ctx(w.accountId, first), w.held[0]!, { decision: "yes", dest: "INBOX" });
    expect((await baselineOf(w.accountId))?.toISOString()).toBe(first.toISOString());

    // A second decide, a week later. The baseline is established ONCE — re-stamping would drag
    // the cutoff forward and drop every sender whose newest mail just fell behind it.
    const later = new Date("2026-08-12T12:00:00.000Z");
    await svc.decide(ctx(w.accountId, later), w.held[1]!, { decision: "no", dest: "ohmail/Screened" });
    expect((await baselineOf(w.accountId))?.toISOString()).toBe(first.toISOString());
  });

  it("A SCREENING RESET CLEARS IT — otherwise the reset is a no-op for the cutline", async () => {
    // Without this the reset does most of nothing the user asked for: every rule is deleted, so
    // every sender is undecided again, but the OLD baseline still stands — and all the mail that
    // predates it goes straight back to History. The Screener comes back empty.
    const w = await newWorld(1);
    const svc = new ScreenerService({});
    const first = new Date("2026-08-05T12:00:00.000Z");
    await svc.decide(ctx(w.accountId, first), w.held[0]!, { decision: "yes", dest: "INBOX" });
    expect(await baselineOf(w.accountId)).not.toBeNull();

    await resetScreeningState(ctx(w.accountId));
    expect(await baselineOf(w.accountId)).toBeNull();
    // …and the row is still there, carrying the reset stamp — this nulls one column, it does not
    // delete the account's settings.
    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, w.accountId)).limit(1);
    expect(row!.screeningResetAt).not.toBeNull();
  });

  it("TWO CONCURRENT FIRST DECIDES PRODUCE ONE BASELINE, not two and not a 23505", async () => {
    const w = await newWorld(2);
    const svc = new ScreenerService({});

    // Two DIFFERENT senders, so neither decide is a duplicate of the other and both genuinely run
    // the whole transaction — including the stamp. Different `now`s so a second write would be
    // visible as a different value rather than hidden behind an identical one.
    const a = new Date("2026-08-05T12:00:00.000Z");
    const b = new Date("2026-08-05T12:00:30.000Z");
    const results = await Promise.allSettled([
      svc.decide(ctx(w.accountId, a), w.held[0]!, { decision: "yes", dest: "INBOX" }),
      svc.decide(ctx(w.accountId, b), w.held[1]!, { decision: "yes", dest: "ohmail/News" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled"),
      `a decide failed: ${JSON.stringify(results)}`).toBe(true);

    // ONE row, and its baseline is one of the two instants — whichever transaction committed
    // first. The assertion is deliberately not "it is `a`": the interleaving is Postgres's to
    // choose, and pinning it would be testing the scheduler rather than the invariant.
    const rows = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, w.accountId));
    expect(rows).toHaveLength(1);
    const stamped = rows[0]!.screeningBaselineAt;
    expect(stamped).not.toBeNull();
    expect([a.toISOString(), b.toISOString()]).toContain(stamped!.toISOString());
  });
});
