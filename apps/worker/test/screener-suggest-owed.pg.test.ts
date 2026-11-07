import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { asc, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, journalDrift } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import {
  schema, screenerSuggestOwed,
  markScreenerSuggestOwed, owedSuggestAccounts, clearScreenerSuggestOwed,
} from "@trafficflow/db/cloud";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ClassifierInput, ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { runSyncCycle } from "../src/sync.js";
import { screenerAutoSuggestPass } from "../src/screener-auto-suggest.js";
import { fakeSpendPort } from "./_spendport.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE SUGGEST-OWED MARK (cloud 0039), against REAL POSTGRES on the lane database.
 *
 * The mark is what turns "a suggestion arrives on the cycle's cadence tail" (over a minute,
 * measured on a test account) into "the cycle serves the account whose ingest just held a
 * sender FIRST". Four
 * claims, and the mutation that turns each red (each watched through `mutation-control.sh`):
 *
 *  1. the WRITER'S OPT-IN GATE — flip `auto_suggest_at IS NOT NULL` in `markScreenerSuggestOwed`
 *     and an account that never opted in gains a row;
 *  2. the INGEST SEAM — drop `passive !== true` from `planHeldAtGate` (sync.ts) and a READER's
 *     adopted placement marks a mailbox nobody here organizes;
 *  3. the ORDER — the reader answers oldest first, which is what "served FIRST" means over
 *     several owed accounts;
 *  4. ONE PURCHASE PER SENDER — a second ingest from a decided-about sender re-mints the
 *     representative, and the pass's per-sender entitlement (not this table) keeps the second
 *     cycle from buying again; asserted here so the owed serve cannot be blamed for a double buy.
 *
 * Real Postgres and not PGlite because the writer is a raw `INSERT … SELECT … ON CONFLICT` — the
 * exact statement production runs — and the seam test drives the REAL `runSyncCycle` commit path.
 */

const AVAILABLE = await realPgAvailable();
const SCREENER = "ohmail/Screener";

/** A classifier that records every question and answers the same way. */
function spyClassifier(): ClassifierPort & { screened: ClassifierInput[] } {
  const screened: ClassifierInput[] = [];
  const answer = async (input: ClassifierInput): Promise<ClassifierResult> => {
    screened.push(input);
    return { destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter", spam: false };
  };
  return { screened, classify: answer, screen: answer };
}

describe.skipIf(!AVAILABLE)("SCR-SUGGEST-OWED — the mark, its reader, and the ingest seam", () => {
  let db: Tx;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // The drift door, inline rather than through `_workerenv.ts` — importing that module would
    // put this file in the GreenMail box class for a port helper it never dials.
    const drift = await journalDrift(PG_TEST_URL);
    if (drift !== null) throw new Error(`refusing a drifted database: ${drift}`);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 120_000);

  /** An account row + settings, opted in at `optedInAt` (null = never). */
  async function newAccount(optedInAt: Date | null): Promise<string> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `owed-${accountId.slice(0, 8)}` });
    await db.insert(accountSettings).values({ accountId, autoSuggestAt: optedInAt });
    return accountId;
  }

  const rowsOf = async (accountId: string) =>
    db.select({ accountId: screenerSuggestOwed.accountId, owedAt: screenerSuggestOwed.owedAt })
      .from(screenerSuggestOwed).where(eq(screenerSuggestOwed.accountId, accountId))
      .orderBy(asc(screenerSuggestOwed.owedAt));

  it("the mark is gated on the opt-in, and idempotent on the FIRST unserved hold", async () => {
    const optedIn = await newAccount(new Date("2026-08-01T00:00:00Z"));
    const optedOut = await newAccount(null);

    await markScreenerSuggestOwed(db, optedIn);
    const first = await rowsOf(optedIn);
    expect(first).toHaveLength(1);

    // A second hold re-marks NOTHING: the owed order is the FIRST unserved hold's arrival.
    await markScreenerSuggestOwed(db, optedIn);
    const second = await rowsOf(optedIn);
    expect(second).toHaveLength(1);
    expect(second[0]!.owedAt.getTime()).toBe(first[0]!.owedAt.getTime());

    // An account that never opted in gains no row — the gate is inside the statement.
    await markScreenerSuggestOwed(db, optedOut);
    expect(await rowsOf(optedOut)).toHaveLength(0);
  });

  it("the reader answers oldest first, and the clear takes only what the read saw", async () => {
    const a = await newAccount(new Date("2026-08-01T00:00:00Z"));
    const b = await newAccount(new Date("2026-08-01T00:00:00Z"));
    const older = new Date("2026-08-02T10:00:00Z");
    const newer = new Date("2026-08-02T10:05:00Z");
    await db.insert(screenerSuggestOwed).values({ accountId: b, owedAt: newer });
    await db.insert(screenerSuggestOwed).values({ accountId: a, owedAt: older });

    const owed = (await owedSuggestAccounts(db)).filter((r) => r.accountId === a || r.accountId === b);
    expect(owed.map((r) => r.accountId)).toEqual([a, b]);

    // A clear bounded BEFORE the row's instant leaves it — the hold that landed mid-serve.
    await clearScreenerSuggestOwed(db, a, new Date(older.getTime() - 1000));
    expect(await rowsOf(a)).toHaveLength(1);
    // …and a clear at the read instant retires it, for the named account alone.
    await clearScreenerSuggestOwed(db, a, older);
    expect(await rowsOf(a)).toHaveLength(0);
    expect(await rowsOf(b)).toHaveLength(1);
  });

  it("INGEST SEAM — a held first-contact sender fires the seam; a reader's adoption does not", async () => {
    const accountId = await newAccount(new Date("2026-08-01T00:00:00Z"));
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `owed-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;
    const repo = makeDrizzleRepo(db as never);

    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: [{ from: "stranger@first-contact.test", subject: "hello", messageId: `owed-${randomUUID()}@x` }],
    });

    const held: string[] = [];
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      role: "organizer", trustedAuthservIds: new Set<string>(),
      onScreenerHold: (id) => held.push(id),
    });

    // The premise first: the plan really HELD the stranger at the gate.
    const [msg] = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.mailboxId, mailboxId));
    const [fs] = await db.select({ desired: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, msg!.id));
    expect(fs!.desired, "the fixture did not hold the sender — the case measures nothing")
      .toBe(SCREENER);
    expect(held, "the ingest of a held sender never fired the seam").toEqual([accountId]);

    // The other arm: a READER's cycle adopts placement (`passive`), and the seam stays silent —
    // a mark here would put a mailbox nobody here organizes at the front of the suggest queue.
    const readerHeld: string[] = [];
    const [mb2] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `owed-r-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const adapter2 = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId: mb2!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    // Delivered INTO the Screener folder — the previous organizer's hold, which the reader
    // ADOPTS (`passive`) with `desired` = the arrival folder. An INBOX delivery would leave the
    // seam silent for the folder's sake and let the passive arm rot unwatched (measured: the
    // first form of this case stayed green under exactly that mutation).
    fleet.behave(mb2!.id, {
      deliver: [{
        from: "stranger2@first-contact.test", subject: "hi",
        messageId: `owed-r-${randomUUID()}@x`, folder: "ohmail/Screener",
      }],
    });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter: adapter2, accountId, mailboxId: mb2!.id, storageCap: UNMETERED_STORAGE_CAP,
      role: "reader", trustedAuthservIds: new Set<string>(),
      onScreenerHold: (id) => readerHeld.push(id),
    });
    expect(readerHeld, "a reader's adopted placement marked the account owed").toEqual([]);
  }, 60_000);

  it("ONE PURCHASE PER SENDER — a second ingest inside the window does not double-buy", async () => {
    const accountId = await newAccount(new Date("2026-08-01T00:00:00Z"));
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `owed-b-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    let uid = 0;
    const seed = async (at: Date): Promise<void> => {
      uid++;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `owed:${randomUUID()}`,
        subject: "hello again", fromAddress: "repeat@first-contact.test",
        snippet: "s", date: new Date("2026-07-01T00:00:00Z"), createdAt: at,
        nativeLocator: { folder: SCREENER, ref: `1:${uid}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      // Its copy in the Screener, as the ingest records one.
      await db.insert(messageInstances).values({
        accountId, mailboxId: mb!.id, messageId: m!.id, folder: SCREENER, uidvalidity: 1n, uid, isPrimary: true,
      });
    };

    await seed(new Date("2026-08-02T10:00:00Z"));
    const classifier = spyClassifier();
    const gate = fakeSpendPort();
    gate.exclusive();
    gate.budget(10);
    const first = await screenerAutoSuggestPass(db, { accountId, classifier, credits: gate });
    expect(first.bought).toBe(1);
    expect(classifier.screened).toHaveLength(1);

    // The sender sends AGAIN — a newer representative, the shape that used to re-mint rows on
    // the client. The pass's per-sender entitlement answers, not the mark: nothing is re-bought.
    await seed(new Date("2026-08-02T10:00:05Z"));
    const second = await screenerAutoSuggestPass(db, { accountId, classifier, credits: gate });
    expect(second.bought, "the sender was bought a second time for sending again").toBe(0);
    expect(classifier.screened).toHaveLength(1);
  });
});
