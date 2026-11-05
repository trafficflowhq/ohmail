import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { MailboxRemovedError, runSyncCycle } from "../src/sync.js";
import { ingestRunRepository } from "../src/ingest-run.js";
import { INGEST_RUN_BOUNDS } from "../src/config.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * EVERY INGEST COMMIT ASKS WHETHER THE MAILBOX IS STILL THERE — EXACTLY ONCE, AND IN ITS PLACE. The
 * fence is one question with two carriers since the fold: a NEW message asks inside the change-log
 * allocation it was already sending, and every other shape — a second copy, a repair, a re-arrival —
 * asks first with the standing read. Both halves matter and neither is visible in the other's test: a
 * fold covering only the branch it was written for would leave a repair committing into a removed
 * mailbox, and a repair asking at the allocation would take the mailbox row AFTER a `messages` row,
 * which is a deadlock against an erasing removal rather than a refusal (measured: 40P01).
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000fe11";

interface Commit { calls: string[]; asks: number }

/** Records what each commit transaction did, in order, and how often it asked about the mailbox. */
function watching(real: DrizzleRepo, commits: Commit[]): DrizzleRepo {
  const inside = (txRepo: DrizzleRepo, commit: Commit): DrizzleRepo => new Proxy(txRepo, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]): unknown => {
        commit.calls.push(prop);
        // THE TWO CARRIERS OF ONE QUESTION: the standing read, and the fence handed to the
        // allocation. Counting only the first would read the fold as "never asked".
        if (prop === "mailboxStatusForWrite") commit.asks += 1;
        if (prop === "recordChanges" && args[1] !== undefined) commit.asks += 1;
        // A run hands the fence to its own allocation, inside the call.
        if (prop === "persistNewRun" && (args[1] as { mailboxMustBeLive?: unknown }).mailboxMustBeLive !== undefined) commit.asks += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as DrizzleRepo;

  return new Proxy(real, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv) as unknown;
      if (prop !== "transaction" || typeof value !== "function") return value;
      return (fn: (r: DrizzleRepo) => Promise<unknown>): unknown =>
        (value as (f: (r: DrizzleRepo) => Promise<unknown>) => unknown).call(target, (txRepo) => {
          const commit: Commit = { calls: [], asks: 0 };
          commits.push(commit);
          return fn(inside(txRepo, commit));
        });
    },
  }) as DrizzleRepo;
}

/**
 * THE RULE, OF EVERY TRANSACTION IN THE CYCLE — at most one ask, and the ask before any write.
 *
 * Asserted over all of them rather than over the ingest's alone since every writer grew the same
 * fence: a `folder_state` group that asked after taking a `messages` row would be the erasing
 * removal's deadlock partner exactly as a repair commit would. The folded ask is admitted because
 * it sends no read — it rides the allocation, whose own first write takes the mailbox row anyway.
 */
function expectAsksOnceAndFirst(commits: Commit[]): void {
  expect(commits.filter((c) => c.asks > 1).map((c) => c.calls),
    "a transaction asked about the mailbox more than once").toEqual([]);
  expect(
    commits.filter((c) => c.calls.includes("mailboxStatusForWrite")
      && c.calls[0] !== "mailboxStatusForWrite").map((c) => c.calls),
    "a transaction wrote before it asked — that is the lock order the erasing removal deadlocks "
    + "against",
  ).toEqual([]);
}

describe("the ingest's removal fence, per commit", () => {
  it("asks once through the allocation for a new message, and once up front for a copy", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `fence-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;

    const commits: Commit[] = [];
    const repo = watching(makeDrizzleRepo(db as never), commits);
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    const messageId = `once-${randomUUID()}@x`;
    const cycle = (): Promise<unknown> => runSyncCycle({
      // A FIXTURE HOLDS NO ORGANIZER LEASE, and `SyncDeps.writeAuthority` is required, so it
      // says so rather than leaving the field out — an omission is the shape that let a
      // hosted cycle write to a mailbox whose lease it had never asked about.
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId: ACCOUNT, mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    });

    // ── THE NEW MESSAGE ────────────────────────────────────────────────────────────────────
    fleet.behave(mailboxId, { deliver: [{ from: "s@x.example", subject: "first", messageId }] });
    await cycle();
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      "the fixture never ingested anything — the case measures nothing").toBe(1);

    /* THE SHAPE THIS ASSERTED UNTIL 2026-09-14 was "exactly one transaction asked", because the
       ingest commit was the only writer in the cycle that asked at all. Every writer asks now
       (`fencedLiveGroup`), so that count is no longer the invariant — and accepting the new count
       would be accepting a number rather than a rule. The rule that was always the point survives
       whole and is asserted of EVERY transaction instead: no transaction asks twice, and each one
       asks BEFORE it writes — asking after a write is the lock order an erasing removal deadlocks
       against — with the new-message commit the one exception, because it folds the question into
       the allocation it was already sending and so never sends a read of its own. */
    expectAsksOnceAndFirst(commits);
    const ingests = commits.filter((c) => c.asks > 0);
    const written = ingests.find((c) => c.calls.includes("insertMessage"));
    expect(written, "no transaction wrote the message, or the one that did never asked")
      .toBeDefined();
    expect(written!.calls.includes("mailboxStatusForWrite"),
      "the new-message commit paid for a read of its own — the fold did not happen").toBe(false);

    // ── THE SAME MESSAGE ARRIVING SOMEWHERE ELSE — a copy, not a new message ───────────────
    commits.length = 0;
    fleet.behave(mailboxId, {
      deliver: [
        { from: "s@x.example", subject: "first", messageId },
        { from: "s@x.example", subject: "first", messageId, folder: "ohmail/News" },
      ],
    });
    await cycle();
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      "the copy was ingested as a second message — the case is measuring the new path again")
      .toBe(1);

    expectAsksOnceAndFirst(commits);
    const repairs = commits.filter((c) => c.asks > 0);
    expect(repairs.length, "the repair commit never asked at all").toBeGreaterThan(0);
    expect(repairs.some((c) => c.calls[0] === "mailboxStatusForWrite"),
      "no transaction asked with a read of its own — the repair took the fold, which is only "
      + "sound for a genuinely new message").toBe(true);
  }, 60_000);

  it("asks once for a whole run, through the run's own allocation", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `run-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;
    const commits: Commit[] = [];
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: Array.from({ length: 5 }, (_, i) => ({ from: "s@x.example", subject: `run ${i}`, messageId: `run-${i}-${randomUUID()}@x` })),
    });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: watching(ingestRunRepository(makeDrizzleRepo(db as never)), commits),
      adapter, accountId: ACCOUNT, mailboxId, storageCap: UNMETERED_STORAGE_CAP, ingestRuns: INGEST_RUN_BOUNDS,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length).toBe(5);
    expectAsksOnceAndFirst(commits);
    const runs = commits.filter((c) => c.calls.includes("persistNewRun"));
    expect(runs.map((c) => c.asks), "the five letters were not one run asking once").toEqual([1]);
    expect(runs[0]!.calls.includes("mailboxStatusForWrite"), "the run paid for a read of its own").toBe(false);
  }, 60_000);

  it("asks even when the plan was NEW and the insert lost the race", async () => {
    /* THE ONE `new` COMMIT THAT ALLOCATES NOTHING. `insertMessage` is an upsert and the loser
       returns straight away, so the allocation that carries the folded question is never sent —
       and a fence that lived only there would let this commit through unasked. The plan phase's
       lookup is hidden here, which is precisely what a concurrent winner does to it: the read
       happened before the other transaction committed.
       WATCHED FAIL: with the settling read removed from `commitFenced`, this case reports zero
       asks and the refusal below never happens. */
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `lost-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;

    const commits: Commit[] = [];
    const real = makeDrizzleRepo(db as never);
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    const messageId = `lost-${randomUUID()}@x`;
    const cycle = (repo: DrizzleRepo): Promise<unknown> => runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId: ACCOUNT, mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    });

    fleet.behave(mailboxId, { deliver: [{ from: "s@x.example", subject: "raced", messageId }] });
    await cycle(real);
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length)
      .toBe(1);

    // The copy arrives, and the plan phase cannot see the row this account already holds.
    fleet.behave(mailboxId, {
      deliver: [
        { from: "s@x.example", subject: "raced", messageId },
        { from: "s@x.example", subject: "raced", messageId, folder: "ohmail/News" },
      ],
    });
    const blind = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === "findByDedupKeys" && typeof value === "function") return async () => new Map();
        if (prop !== "findByDedupKey" || typeof value !== "function") return value;
        return async (): Promise<null> => null;
      },
    }) as DrizzleRepo;
    await cycle(watching(blind, commits));

    const losers = commits.filter((c) => c.calls.includes("insertMessage"));
    expect(losers.map((c) => c.asks),
      "the commit whose insert lost never asked whether the mailbox was still there").toEqual([1]);
    expect(losers[0]!.calls.includes("recordChanges"),
      "the loser allocated after all — this case is no longer the branch it was written for")
      .toBe(false);

    // And the refusal that absence would cost: the same commit, with the mailbox gone.
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));
    fleet.behave(mailboxId, {
      deliver: [
        { from: "s@x.example", subject: "raced", messageId },
        { from: "s@x.example", subject: "raced", messageId, folder: "ohmail/Receipts" },
      ],
    });
    await expect(cycle(blind), "a lost insert committed into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
  }, 60_000);
});
