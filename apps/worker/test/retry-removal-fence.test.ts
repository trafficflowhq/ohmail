import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { changeLog, mailboxes, messageFailures, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger } from "@trafficflow/core";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { MailboxRemovedError, runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE TARGETED RETRY ASKS THE SAME QUESTION THE INGEST ASKS — through the same door.
 * `retryFailedMessages` re-reads a written-off UID by name and runs the two-phase ingest on it, its plan
 * phase outside every transaction as the ordinary path's is, so the same gap existed: a removal between
 * plan and commit left the retried message and its bodies in a mailbox somebody had removed. The loop
 * was unreachable from this fleet until `FakeAdapterFleet.targetedRetry` — see that flag for why it is
 * off by default. WHAT THIS FILE DOES NOT CLAIM: on PGlite it measures the DECISION, not the LOCK ORDER
 * that makes it race-proof; that is `removal-mid-ingest.pg.test.ts`, and it is the same statement either
 * way because the fix routes this commit through `commitFenced`.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000fe21";
const BUILD = "targeted-retry-test-build";

/** One mailbox, and a written-off UID the server still holds behind the folder's watermark. */
async function seed(db: Tx, tag: string): Promise<{ mailboxId: string; uid: number }> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCOUNT, provider: "imap", address: `${tag}-${randomUUID().slice(0, 8)}@x.test`,
  }).returning();
  return { mailboxId: mb!.id, uid: 7 };
}

/**
 * A fleet whose adapter CAN be asked by UID, holding one message the ordinary batch never offers.
 *
 * `behindWatermark` rather than `deliver` on purpose: a written-off UID is behind the Sent
 * watermark and inside every known-set, so if the batch could still offer it the ingest loop would
 * take it and every assertion below would be about the ordinary path.
 */
function fleetHolding(mailboxId: string, uid: number, messageId: string): {
  fleet: FakeAdapterFleet; adapter: ReturnType<FakeAdapterFleet["factory"]>;
} {
  const fleet = new FakeAdapterFleet();
  fleet.targetedRetry = true;
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mailboxId, {
    behindWatermark: [{ from: "stranger@elsewhere.test", subject: "written off", messageId, uid }],
  });
  return { fleet, adapter };
}

/** The durable record a previous cycle left: deterministic code, due to THIS build and no other. */
async function writeOff(repo: DrizzleRepo, mailboxId: string, uid: number): Promise<void> {
  await repo.recordMessageFailure(mailboxId, {
    accountId: ACCOUNT, folder: "INBOX", uidValidity: "1", uid,
    code: "mime_unparseable", version: "the-build-that-could-not-parse-it", nextAttemptAt: null,
  });
}

/** Every event the cycle logged, in order. */
function recorder(): { events: string[]; log: ReturnType<typeof createLogger> } {
  const events: string[] = [];
  const log = createLogger({
    service: "worker", level: "debug", sink: (line: string) => {
      events.push(String((JSON.parse(line) as { event?: unknown }).event ?? ""));
    },
  });
  return { events, log };
}

/**
 * How often each commit transaction asked whether the mailbox was still there, and whether it paid
 * a read of its own to do it. The fence has TWO carriers since the fold — the standing
 * `mailboxStatusForWrite`, and the mailbox handed to the change-log allocation — so counting only
 * the first would read a folded ask as "never asked".
 */
interface Commit { calls: string[]; asks: number }
function watching(real: DrizzleRepo, commits: Commit[]): DrizzleRepo {
  const inside = (txRepo: DrizzleRepo, commit: Commit): DrizzleRepo => new Proxy(txRepo, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]): unknown => {
        commit.calls.push(prop);
        if (prop === "mailboxStatusForWrite") commit.asks += 1;
        if (prop === "recordChanges" && args[1] !== undefined) commit.asks += 1;
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

describe("the targeted retry's removal fence", () => {
  it("recovers a written-off UID, and its commit asks about the mailbox exactly once", async () => {
    /* THE POSITIVE CONTROL, and the only case in this suite that proves the loop runs at all: a
       new build arrives, the record is due to it, the message is re-read by UID and committed, and
       the record is closed. Without this the refusal below would be satisfied by a retry that
       never happened. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { mailboxId, uid } = await seed(db, "rtr-ok");
    const messageId = `rtr-ok-${randomUUID()}@x`;
    const { fleet, adapter } = fleetHolding(mailboxId, uid, messageId);

    const commits: Commit[] = [];
    const repo = watching(makeDrizzleRepo(db as never), commits);
    await writeOff(repo, mailboxId, uid);

    await runSyncCycle({
      // A FIXTURE HOLDS NO ORGANIZER LEASE, and `SyncDeps.writeAuthority` is required, so it
      // says so rather than leaving the field out — an omission is the shape that let a
      // hosted cycle write to a mailbox whose lease it had never asked about.
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId: ACCOUNT, mailboxId, buildVersion: BUILD,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });

    expect(fleet.targetedFetches.map((f) => ({ folder: f.folder, uids: f.uids })),
      "the retry never asked the server for the written-off UID").toEqual([
      { folder: "INBOX", uids: [uid] },
    ]);
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      "the re-read message was not committed — the retry does not work at all").toBe(1);
    const [row] = await db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId));
    expect(row?.resolvedAt === null, "the record stayed owed after the message was ingested")
      .toBe(false);

    /* ONE question, and no read of its own: the retried message is a NEW one, so it rides the
       allocation the branch was already sending. A second fence in this loop would read as two.
       "a second transaction asked" was part of this assertion until 2026-09-14, when every writer
       in the cycle grew the same fence — so the claim is now made about the commit that wrote the
       retried message, by name, rather than by its being the only asker. */
    expect(commits.filter((c) => c.asks > 1).map((c) => c.calls),
      "a transaction asked about the mailbox more than once").toEqual([]);
    const retried = commits.filter((c) => c.calls.includes("insertMessage"));
    expect(retried.map((c) => c.asks),
      "the commit that wrote the retried message asked twice, or never asked").toEqual([1]);
    expect(retried[0]!.calls.includes("mailboxStatusForWrite"),
      "the retry's commit paid for a read of its own — it is not going through the ingest's door")
      .toBe(false);
  }, 60_000);

  it("REFUSES the commit when the mailbox is removed between the retry's plan and its commit", async () => {
    /* THE DEFECT. `findByDedupKey` is a PLAN-phase read, outside every transaction, so tombstoning
       from it puts the removal exactly in the gap — the real repo, the real cycle, the real loop.
       WATCHED FAIL: with `commitFenced` in `retryFailedMessages` put back to a bare `commitChange`,
       the cycle resolves, the message row is written and the record is CLOSED, all inside a
       mailbox the person removed. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { mailboxId, uid } = await seed(db, "rtr-gone");
    const messageId = `rtr-gone-${randomUUID()}@x`;
    const { adapter } = fleetHolding(mailboxId, uid, messageId);

    const real = makeDrizzleRepo(db as never);
    await writeOff(real, mailboxId, uid);

    let removed = false;
    const repo = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if ((prop !== "findByDedupKey" && prop !== "findByDedupKeys") || typeof value !== "function") return value;
        return async (...args: unknown[]): Promise<unknown> => {
          if (!removed) {
            removed = true;
            await db.update(mailboxes).set({ status: "disabled" })
              .where(eq(mailboxes.id, mailboxId));
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as DrizzleRepo;

    const { events, log } = recorder();
    const cycle = runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId: ACCOUNT, mailboxId, buildVersion: BUILD, log,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    await expect(cycle, "the retry committed a message into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed, "the removal never happened — the case measured nothing").toBe(true);

    /* NOTHING WRITTEN, AND THE RECORD STILL OWED. The message and its change row are the mail left
       behind. The record matters the other way round: CLOSING it would erase the only durable
       trace of a message the server still holds, on the strength of a commit that was refused. */
    const [row] = await db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId));
    expect({
      mail: (await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      emitted: (await db.select().from(changeLog).where(eq(changeLog.accountId, ACCOUNT))).length,
      closed: row?.resolvedAt !== null,
      code: row?.code,
    }, "a removed mailbox kept mail, emitted a change, or had its owed record closed or rewritten")
      .toEqual({ mail: 0, emitted: 0, closed: false, code: "mime_unparseable" });
    expect(row?.attempts, "the claim never ran, so the retry was not the thing that was refused")
      .toBe(2);

    /* THE LINE THE CYCLE WRITES IS PART OF THE ANSWER — once, and naming the retry rather than a
       message that failed. A refusal classified as evidence about the MESSAGE re-records a code
       against mail that is fine, in a mailbox that is gone. */
    expect(events.filter((e) => e === "message_retry_mailbox_removed"),
      "the refusal was silent, or was reported more than once").toEqual(["message_retry_mailbox_removed"]);
    expect(events.filter((e) => e.startsWith("message_retry_") && e !== "message_retry_mailbox_removed"),
      "a removed mailbox was reported as a message that failed").toEqual([]);
  }, 60_000);

  it("stops the cycle, so the two passes AFTER the retry never run on the removed mailbox", async () => {
    /* WHY THE REFUSAL LEAVES THIS FUNCTION rather than being swallowed like an outage. Two more
       passes run after the retry inside the same cycle — the junk restore's rewrites and
       `reconcileMailbox`'s moves and flag writes — and NEITHER asks this question. Swallowing the
       refusal would shut the retry's door and leave both of those open on a mailbox that is gone,
       which is the same defect one pass along. `MailboxRemovedError` is terminal for the cycle
       where the ingest raises it, and both production callers already read it as a benign skip
       (`index.ts` does not count it toward `maxSyncFailures`; `reconcile-cron.ts` reports it as a
       skip rather than exiting 1), so the class is theirs to receive from here too.
       Both arms, because a counter that reads zero proves nothing until it has been seen move. */
    const db = (await makeTestDb()) as unknown as Tx;
    const reached: string[] = [];
    const countingRepo = (base: DrizzleRepo): DrizzleRepo => new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function" || typeof prop !== "string") return value;
        if (prop !== "listJunkFiledHusks" && prop !== "listPendingFolderStates") return value;
        return (...args: unknown[]): unknown => {
          reached.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DrizzleRepo;

    // ── THE CONTROL: a mailbox nobody removed reaches both passes ──────────────────────────
    const live = await seed(db, "rtr-live");
    const liveFleet = fleetHolding(live.mailboxId, live.uid, `rtr-live-${randomUUID()}@x`);
    const liveRepo = countingRepo(makeDrizzleRepo(db as never));
    await writeOff(liveRepo, live.mailboxId, live.uid);
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo: liveRepo, adapter: liveFleet.adapter, accountId: ACCOUNT, mailboxId: live.mailboxId,
      buildVersion: BUILD, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
      trustedAuthservIds: new Set<string>(),
    });
    expect(new Set(reached), "the two passes after the retry are not reached even on a live "
      + "mailbox — the counter measures nothing")
      .toEqual(new Set(["listJunkFiledHusks", "listPendingFolderStates"]));

    // ── AND THE REFUSAL: the same cycle, on a mailbox that is gone ─────────────────────────
    reached.length = 0;
    const { mailboxId, uid } = await seed(db, "rtr-stop");
    const { fleet, adapter } = fleetHolding(mailboxId, uid, `rtr-stop-${randomUUID()}@x`);
    const repo = countingRepo(makeDrizzleRepo(db as never));
    await writeOff(repo, mailboxId, uid);
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));

    const { events, log } = recorder();
    await expect(runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId: ACCOUNT, mailboxId, buildVersion: BUILD, log,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    }), "the cycle carried on past a mailbox that is gone").rejects.toBeInstanceOf(MailboxRemovedError);
    expect(reached, "a pass after the retry still read the removed mailbox").toEqual([]);
    /* THIS ASKED FOR `message_retry_mailbox_removed` BY NAME until 2026-09-14, and the mailbox
       here is gone BEFORE the cycle starts rather than during it — so with every writer asking,
       the refusal is now raised by the first write of the cycle, which is earlier than the retry
       and strictly better. The claim is narrowed to the two halves still measured true and one
       that is stronger than the old needle: the cycle refuses, no later pass reads the mailbox,
       and the server is never asked for the written-off UID at all. The retry's own event is
       measured where the removal actually lands mid-retry — the case above. */
    expect(fleet.targetedFetches, "the retry re-read a removed mailbox's UID from the server "
      + "before anything refused").toEqual([]);
    expect(events.filter((e) => e.startsWith("message_retry_")),
      "a refusal before the retry was reported as something the retry did").toEqual([]);
  }, 60_000);
});
