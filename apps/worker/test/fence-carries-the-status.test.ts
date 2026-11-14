import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages, messageFailures, MailboxErasedError, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { MailboxRemovedError, refusalIsRemoval, runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";
import { readSource } from "./_start-function.js";

/**
 * THE TARGETED RETRY IS FENCED, AND A REMOVAL HAS TWO CLASSES. Neither claim could be made before
 * `FakeAdapterFleet.targetedRetry` existed: `retryFailedMessages` returns at its first line without
 * a `fetchByUid`, so the gap row about it survived a fix and a close with nothing measuring either.
 * (1) the re-read commits through the ingest's own fenced door, so a removal landing while a
 * written-off UID is being fetched refuses the commit and stops the cycle. (2) the cycle's fence
 * raises `MailboxRemovedError` and the ingest repository raises `MailboxErasedError` — one fact,
 * two doors; `rethrowRefusal` names both and every arm with a sentence asks `refusalIsRemoval`.
 * PGlite measures the DECISION here; the lock order is `mailbox-fence-epq.pg.test.ts`'s.
 */
const BUILD = "fence-status-test-build";
const OLD_BUILD = "fence-status-older-build";

async function seedMailbox(db: Tx, tag: string): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `fs-${tag}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `fs-${tag}-${randomUUID().slice(0, 8)}@x.test`,
    status: "connected",
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

/** One written-off UID, owed and DUE — recorded by a build that is not the running one. */
async function seedOwedUid(
  repo: DrizzleRepo, accountId: string, mailboxId: string, uid: number,
): Promise<void> {
  await repo.recordMessageFailure(mailboxId, {
    accountId, folder: "INBOX", uidValidity: "1", uid,
    code: "unclassified", version: OLD_BUILD, nextAttemptAt: null,
  });
}

/** The adapter that can be asked by UID, holding the owed message behind every watermark. */
function fleetFor(mailboxId: string, held: { from: string; subject: string; messageId: string }, uid: number): {
  fleet: FakeAdapterFleet; adapter: ReturnType<FakeAdapterFleet["factory"]>;
} {
  const fleet = new FakeAdapterFleet();
  fleet.targetedRetry = true;
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: "unused", mailboxId, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mailboxId, { behindWatermark: [{ ...held, uid }] });
  return { fleet, adapter };
}

/**
 * THE REMOVAL LANDS WHERE THE ROW SAYS IT DOES — while the written-off UID is being re-read. The
 * adapter is the plan phase of this loop (`planChange` runs on what it answers, outside every
 * transaction), so tombstoning after its answer puts the removal in the gap the commit must close.
 */
function removingAfterFetch(
  adapter: ReturnType<FakeAdapterFleet["factory"]>, db: Tx, mailboxId: string,
): { adapter: ReturnType<FakeAdapterFleet["factory"]>; removed: () => boolean } {
  let removed = false;
  const proxy = new Proxy(adapter as object, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "fetchByUid" || typeof value !== "function") return value;
      return async (...args: unknown[]): Promise<unknown> => {
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (!removed) {
          removed = true;
          await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));
        }
        return out;
      };
    },
  }) as ReturnType<FakeAdapterFleet["factory"]>;
  return { adapter: proxy, removed: () => removed };
}

/**
 * THE INGEST REPOSITORY'S OWN REFUSAL, where production raises it: INSIDE the write transaction,
 * on the repo the transaction hands its callback. A proxy over the outer repo alone never sees the
 * write and passes for the wrong reason (`_workerenv.ts#repoWithFailingMethod`'s measurement).
 */
function erasingAt(real: DrizzleRepo, method: string): { repo: DrizzleRepo; threw: () => number } {
  let threw = 0;
  const wrap = (target: DrizzleRepo): DrizzleRepo => new Proxy(target as object, {
    get(obj, prop, receiver): unknown {
      const value = Reflect.get(obj, prop, receiver);
      if (prop === "transaction" && typeof value === "function") {
        return (fn: (r: DrizzleRepo) => Promise<unknown>): Promise<unknown> =>
          (value as (f: (r: DrizzleRepo) => Promise<unknown>) => Promise<unknown>)
            .call(obj, (tx) => fn(wrap(tx)));
      }
      if (prop !== method || typeof value !== "function") return value;
      return (): never => { threw++; throw new MailboxErasedError("fs-erased"); };
    },
  }) as DrizzleRepo;
  return { repo: wrap(real), threw: () => threw };
}

function recorder(): { events: string[]; log: ReturnType<typeof createLogger> } {
  const events: string[] = [];
  const log = createLogger({
    service: "worker", level: "debug", sink: (line: string) => {
      events.push(String((JSON.parse(line) as { event?: unknown }).event ?? ""));
    },
  });
  return { events, log };
}

const cycle = (over: Record<string, unknown>): Promise<unknown> => runSyncCycle({
  buildVersion: BUILD, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
  trustedAuthservIds: new Set<string>(),
  ...over,
} as never);

const held = (tag: string): { from: string; subject: string; messageId: string } => ({
  from: "stranger@elsewhere.test", subject: "owed", messageId: `fs-${tag}-${randomUUID()}@x`,
});

describe("the targeted retry commits through the fence", () => {
  it("POSITIVE CONTROL — a live mailbox takes the re-read message and closes the record", async () => {
    /* Without this the refusal below is satisfied by a loop that never reached its commit — and
       that is not hypothetical: until `targetedRetry` existed the loop returned at line one. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "rt-ok");
    const repo = makeDrizzleRepo(db as never);
    await seedOwedUid(repo, accountId, mailboxId, 71);
    const { fleet, adapter } = fleetFor(mailboxId, held("rt-ok"), 71);

    await cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId });

    expect(fleet.targetedFetches.map((f) => f.uids), "the targeted re-read never ran")
      .toEqual([[71]]);
    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows.length, "the re-read message was not ingested").toBe(1);
    const [owed] = await db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId));
    expect(owed?.resolvedAt ?? null, "the record was left owed after a successful re-ingest")
      .not.toBeNull();
  }, 60_000);

  it("REFUSES the re-read's commit when the mailbox is removed under the fetch", async () => {
    /* THE ROW, measured at last. The commit goes through `commitFenced`, so the question is asked
       inside the transaction that would have written the message. Mutation watched: route the
       commit back through `commitChange` and the message lands in a `disabled` mailbox. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "rt-gone");
    const repo = makeDrizzleRepo(db as never);
    await seedOwedUid(repo, accountId, mailboxId, 72);
    const { adapter: raw } = fleetFor(mailboxId, held("rt-gone"), 72);
    const { adapter, removed } = removingAfterFetch(raw, db, mailboxId);

    const { events, log } = recorder();
    await expect(cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, log }),
      "the retry wrote a re-read message into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed(), "the removal never happened — the case measured nothing").toBe(true);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows.length, "a removed mailbox gained the re-read message").toBe(0);
    const [owed] = await db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId));
    expect(owed?.resolvedAt ?? null,
      "the record was closed for a message nothing wrote — the only thing still asking for it")
      .toBeNull();
    expect(events.filter((e) => e === "message_retry_mailbox_removed"),
      "the refusal was silent, or was reported more than once")
      .toEqual(["message_retry_mailbox_removed"]);
    expect(events.filter((e) => e === "message_retry_failed"),
      "a removed mailbox was recorded against the message as a failure").toEqual([]);
  }, 60_000);

  it("takes the ERASURE class by the same arm, and never as a message fault", async () => {
    /* THE SECOND CLASS. The ingest repository fences on the erasure stamp and raises
       `MailboxErasedError` — a class `rethrowRefusal` did not name, so the arms below read it as
       a message that failed: re-recorded, re-scheduled, and the cycle carrying on to file and flag
       mail in a mailbox somebody erased. MUTATION WATCHED: move `refusalIsRemoval` below the
       `rethrowRefusal` call and the sentence goes (the class leaves through the classifier);
       remove `MailboxErasedError` from `rethrowRefusal` and `message_retry_failed` appears. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "rt-erased");
    const real = makeDrizzleRepo(db as never);
    await seedOwedUid(real, accountId, mailboxId, 73);
    const { repo, threw } = erasingAt(real, "insertMessage");
    const { adapter } = fleetFor(mailboxId, held("rt-erased"), 73);

    const { events, log } = recorder();
    await expect(cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, log }),
      "an erased mailbox's refusal was swallowed by the arms it passed")
      .rejects.toBeInstanceOf(MailboxErasedError);
    expect(threw(), "the fixture never refused a write — the case measured nothing")
      .toBeGreaterThan(0);

    expect(events.filter((e) => e === "message_retry_mailbox_removed"),
      "the erasure left with no sentence — the arm that names a removal did not see this class")
      .toEqual(["message_retry_mailbox_removed"]);
    expect(events.filter((e) => e === "message_retry_failed" || e === "message_retry_deferred"),
      "an erased mailbox was recorded against the message as a fault").toEqual([]);
    const [owed] = await db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId));
    expect(owed?.resolvedAt ?? null, "the record was closed on a mailbox that is gone").toBeNull();
  }, 60_000);

  it("leaves a catch arm that has NO sentence for it — the classifier, not the arm", async () => {
    /* WHERE THE CLASS MEMBERSHIP IS LOAD-BEARING, and the arm above is not. The retry's own
       removal arm throws before `rethrowRefusal` is reached, so that case is green with the class
       absent — a mutation watched green is a question, and this is its answer. `claimMessageFailures`
       is a repository WRITE with a catch that swallows everything it is not told to rethrow: without
       `MailboxErasedError` in the classifier it logs `message_retry_claim_failed` and RETURNS, and
       the cycle goes on to file and flag mail in a mailbox somebody erased. MUTATION WATCHED: drop
       the class from `rethrowRefusal` and this case reds on both halves. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "rt-claim");
    const real = makeDrizzleRepo(db as never);
    await seedOwedUid(real, accountId, mailboxId, 74);
    const { repo, threw } = erasingAt(real, "claimMessageFailures");
    const { adapter } = fleetFor(mailboxId, held("rt-claim"), 74);

    const { events, log } = recorder();
    await expect(cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, log }),
      "an erasure was swallowed by an arm that has nothing to say about it, and the cycle carried on")
      .rejects.toBeInstanceOf(MailboxErasedError);
    expect(threw(), "the fixture never refused the claim — the case measured nothing")
      .toBeGreaterThan(0);
    expect(events.filter((e) => e === "message_retry_claim_failed"),
      "an erased mailbox was reported as a claim that failed").toEqual([]);
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("a removal has ONE question and TWO classes", () => {
  const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "../src");

  it("the predicate answers both doors, and nothing else", () => {
    expect([
      refusalIsRemoval(new MailboxRemovedError("gone")),
      refusalIsRemoval(new MailboxErasedError("erased")),
      refusalIsRemoval(new Error("an ordinary fault")),
      refusalIsRemoval("a thrown string"),
    ]).toEqual([true, true, false, false]);
  });

  /**
   * THE ARMS, DERIVED. Every place that reads a CYCLE refusal asks the predicate: an arm spelled
   * `err instanceof MailboxRemovedError` is green the day it is written and dead the day the second
   * class arrives, which is what happened to the three reconcile arms once. `sync.ts` declares both
   * classes and the predicate, so its own mentions are the declaration. `mailboxes.ts` is excluded
   * and the case below is why rather than a bare skip: its one mention translates its own
   * `fenceErased` call into `BootstrapRefusedError` on a door no cycle refusal reaches, and its
   * removal twin is the `status === "disabled"` line beside it.
   */
  it("no arm outside the declarations names one class by hand", () => {
    const offenders: string[] = [];
    for (const file of ["index.ts", "reconcile-cron.ts", "request-drain.ts", "restart.ts"]) {
      const src = withoutComments(readSource(join(SRC, file)));
      for (const m of src.match(/instanceof\s+Mailbox(?:Removed|Erased)Error/g) ?? []) {
        offenders.push(`${file}: ${m}`);
      }
    }
    expect(offenders,
      "a removal arm names one class by hand — it goes dead when the other one arrives; ask refusalIsRemoval")
      .toEqual([]);
  });

  it("…and the one excluded arm still carries its own removal twin", () => {
    const src = withoutComments(readFileSync(join(SRC, "mailboxes.ts"), "utf8"));
    expect(
      /instanceof\s+MailboxErasedError/.test(src) && /row\.status\s*===\s*"disabled"/.test(src),
      "the launch seal's erasure arm lost the disabled check beside it — it is now one class short "
      + "and belongs in the census above")
      .toBe(true);
  });
});
