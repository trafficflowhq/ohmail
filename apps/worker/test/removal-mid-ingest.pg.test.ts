import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, allocateSeqRange, changeLog, mailboxes, messageFailures, messages, type LedgerTx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { createLogger } from "@trafficflow/core";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { MailboxRemovedError, runSyncCycle } from "../src/sync.js";
import { ingestRunRepository } from "../src/ingest-run.js";
import { INGEST_RUN_BOUNDS } from "../src/config.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A REMOVAL LANDING BETWEEN PLAN AND COMMIT — the ingest refuses instead of leaving mail behind.
 *
 * `planChange` runs its reads and its classifier call outside any transaction, and that gap is
 * where a removal lands: the row is tombstoned and (on a standalone install) the mirror emptied,
 * and the pending ingest then committed its messages into a mailbox that no longer existed. The
 * person removed a mailbox, its mail stayed on the machine, and the window was told the mail had
 * arrived AFTER the receipt saying the mailbox was gone.
 *
 * PGLITE CANNOT HOST THIS. The mechanism is a row lock across two transactions on two
 * connections: one holds `mailboxes` at `share` while it commits, the other asks for it `FOR
 * UPDATE`. A store with one serialized writer has nothing to order and would read green over a
 * plain unlocked select — which is the whole defect, one layer down.
 */
const PG_UP = await realPgAvailable();

describe.skipIf(!PG_UP)("a removal racing a pending ingest", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterAll(async () => { await sql.end({ timeout: 5 }); });

  /** One account with one mailbox, and the mailbox's id. */
  async function seed(tag: string): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `${tag}-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${tag}-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  function adapterFor(accountId: string, mailboxId: string, messageId: string): {
    fleet: FakeAdapterFleet;
    adapter: ReturnType<FakeAdapterFleet["factory"]>;
  } {
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: [{ from: "stranger@elsewhere.test", subject: "still arriving", messageId }],
    });
    return { fleet, adapter };
  }

  it("REFUSES the commit and writes nothing when the mailbox is removed mid-plan", async () => {
    const { accountId, mailboxId } = await seed("rmi");
    const { adapter } = adapterFor(accountId, mailboxId, `rmi-${randomUUID()}@x`);

    /* THE REMOVAL, AT THE MOMENT THE REAL ONE HAPPENS. `findByDedupKey` is a PLAN-phase read —
       outside every transaction — so tombstoning from it puts the removal exactly in the gap the
       finding names, using the real repo and the real cycle rather than a double that answers
       differently. */
    const real = makeDrizzleRepo(db as never);
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

    /* THE LINES THE CYCLE WRITES ARE PART OF THE ANSWER. A refusal classified as evidence about
       the MESSAGE says `sync_message_deferred` — "this message failed but has not exhausted its
       attempts" — about mail that is fine, in a mailbox the person removed, and on the third
       attempt it writes the message off. */
    const events: string[] = [];
    const log = createLogger({
      service: "worker", level: "debug", sink: (line: string) => {
        events.push(String((JSON.parse(line) as { event?: unknown }).event ?? ""));
      },
    });

    const cycle = runSyncCycle({
      // A FIXTURE HOLDS NO ORGANIZER LEASE, and `SyncDeps.writeAuthority` is required, so it
      // says so rather than leaving the field out — an omission is the shape that let a
      // hosted cycle write to a mailbox whose lease it had never asked about.
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId, mailboxId, log,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    await expect(cycle, "the cycle committed into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed, "the removal never happened — the case measured nothing").toBe(true);
    expect(events.filter((e) => e.startsWith("sync_message_")),
      "a removed mailbox was reported as a message that failed").toEqual([]);

    /* NOTHING WRITTEN, OF ANY OF THE THREE KINDS. The message and its change row are the mail
       left behind; the `message_failures` row is the same mail left behind one table along,
       which is what the `attempt` boundary would have written had the refusal been classified as
       evidence about the message. */
    expect({
      mail: (await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      emitted: (await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).length,
      writtenOff: (await db.select().from(messageFailures)
        .where(eq(messageFailures.mailboxId, mailboxId))).length,
    }, "a removed mailbox kept mail, emitted a change, or had a message written off")
      .toEqual({ mail: 0, emitted: 0, writtenOff: 0 });
  }, 60_000);

  it("REFUSES a RUN's commit the same way: a removal while its letters are planned writes nothing", async () => {
    const { accountId, mailboxId } = await seed("rmr");
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: Array.from({ length: 4 }, (_, i) => ({ from: "s@elsewhere.test", subject: `run ${i}`, messageId: `rmr-${i}-${randomUUID()}@x` })),
    });
    const real = ingestRunRepository(makeDrizzleRepo(db as never));
    let plans = 0;
    // Removed while the third letter is planned: the first two are in the open run.
    const repo = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "findByDedupKeys" || typeof value !== "function") return value;
        return async (...args: unknown[]): Promise<unknown> => {
          if (++plans === 3) await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as DrizzleRepo;
    await expect(runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, ingestRuns: INGEST_RUN_BOUNDS,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    }), "the run committed into a removed mailbox").rejects.toBeInstanceOf(MailboxRemovedError);
    expect(plans, "the removal never happened inside the run").toBeGreaterThanOrEqual(3);
    expect({
      mail: (await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      emitted: (await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).length,
      writtenOff: (await db.select().from(messageFailures).where(eq(messageFailures.mailboxId, mailboxId))).length,
    }).toEqual({ mail: 0, emitted: 0, writtenOff: 0 });
  }, 60_000);

  it("HOLDS the row, so a removal waits for the commit rather than overtaking it", async () => {
    /* THE LOCK IS THE MECHANISM, and a plain read would pass the case above while leaving the
       real race open: read `connected`, be overtaken by the removal and its sweep, then commit.
       So the two orders are measured directly — and the control below runs the identical probe
       against a transaction that holds nothing, which is what makes the wait attributable to the
       lock rather than to the sleep. */
    const { mailboxId } = await seed("rml");
    const repo = makeDrizzleRepo(db as never);
    const HELD_MS = 400;

    const removalWait = async (id: string): Promise<number> => {
      const startedAt = Date.now();
      await sql.begin(async (t) => {
        await t`select status from mailboxes where id = ${id} for update`;
      });
      return Date.now() - startedAt;
    };

    let status: string | null = null;
    const ingest = repo.transaction(async (tx) => {
      status = await tx.mailboxStatusForWrite(mailboxId);
      await new Promise((r) => { setTimeout(r, HELD_MS); });
    });
    // Long enough for the share lock to be taken and short enough to leave most of the hold.
    await new Promise((r) => { setTimeout(r, 60); });
    const [waited] = await Promise.all([removalWait(mailboxId), ingest]);
    expect(status, "the ingest read no status at all").toBe("connected");
    expect(waited, "the removal took the row while an ingest was still holding it")
      .toBeGreaterThanOrEqual(HELD_MS / 2);

    /* THE CONTROL — the same probe, the same sleep, no lock taken. */
    const other = await seed("rml-ctl");
    const idle = (async () => { await new Promise((r) => { setTimeout(r, HELD_MS); }); })();
    await new Promise((r) => { setTimeout(r, 60); });
    const [free] = await Promise.all([removalWait(other.mailboxId), idle]);
    expect(free, "the probe waits even with nothing holding the row — it measures the sleep")
      .toBeLessThan(HELD_MS / 2);
  }, 60_000);

  it("HOLDS the row from inside the FOLDED statement too, which is where ingest now asks", async () => {
    /* THE SAME MECHANISM, THROUGH THE CARRIER A NEW MESSAGE USES. Since the fold the ingest's
       question rides in the change-log allocation, so the case above measures the standing read
       and nothing about the statement most commits actually send. A plain predicate there would
       pass every functional case in this file while leaving the race open — the removal would
       take the row, sweep the mail, and this commit would land behind it. */
    const { accountId, mailboxId } = await seed("rmf");
    const HELD_MS = 400;
    let answered: string | null | undefined;

    const removalWait = async (id: string): Promise<number> => {
      const startedAt = Date.now();
      await sql.begin(async (t) => {
        await t`select status from mailboxes where id = ${id} for update`;
      });
      return Date.now() - startedAt;
    };

    const ingest = db.transaction(async (tx) => {
      await allocateSeqRange(tx as unknown as LedgerTx, accountId, 1, {
        mailboxId,
        answer: (status) => { answered = status; },
      });
      await new Promise((r) => { setTimeout(r, HELD_MS); });
    });
    // Long enough for the folded statement to have taken the row, short enough to leave the hold.
    await new Promise((r) => { setTimeout(r, 60); });
    const [waited] = await Promise.all([removalWait(mailboxId), ingest]);
    expect(answered, "the folded statement handed back no status at all").toBe("connected");
    expect(waited, "the removal took the row while a folded allocation was still holding it")
      .toBeGreaterThanOrEqual(HELD_MS / 2);
  }, 60_000);

  it("REFUSES a SECOND COPY of a message we already hold, when the mailbox went in between", async () => {
    /* THE SHAPE THE FOLD DOES NOT COVER, and the reason the fence did not simply move: this
       commit writes an instance row and appends no change at all, so an allocation it never makes
       could not have asked. It is fenced by the standing read, first, before its writes. */
    const { accountId, mailboxId } = await seed("rmc");
    const messageId = `rmc-${randomUUID()}@x`;
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: [{ from: "stranger@elsewhere.test", subject: "twice", messageId }],
    });
    const cycle = (repo: DrizzleRepo): Promise<unknown> => runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId, mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });

    const real = makeDrizzleRepo(db as never);
    await cycle(real);
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      "the first cycle ingested nothing, so there is no copy to arrive").toBe(1);

    // The same message, now also in a folder we watch: a COPY, planned against the row we hold.
    fleet.behave(mailboxId, {
      deliver: [
        { from: "stranger@elsewhere.test", subject: "twice", messageId },
        { from: "stranger@elsewhere.test", subject: "twice", messageId, folder: "ohmail/News" },
      ],
    });
    let removed = false;
    const removing = new Proxy(real, {
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

    const before = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    await expect(cycle(removing), "the copy was recorded into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed, "the removal never happened — the case measured nothing").toBe(true);
    expect((await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).length,
      "the refused cycle still appended to the log").toBe(before.length);
  }, 60_000);

  it("REFUSES the TARGETED RETRY's commit when the mailbox goes between its plan and its commit", async () => {
    /* THE SAME GAP, THROUGH THE OTHER DOOR. `retryFailedMessages` re-reads a UID this mailbox
       wrote off, by name, and runs the same two-phase ingest on it — so its plan phase is outside
       every transaction exactly as the ingest loop's is, and a removal lands in exactly the same
       place. It committed there for as long as the fence existed, because this loop called
       `commitChange` itself instead of the door the fence sits on.
       HERE rather than only in the PGlite file because the mechanism is the row lock: this commit
       takes `mailboxes` at `share` inside its own transaction, which is what orders it against
       `MailboxService.delete`'s `FOR UPDATE`. A store with one serialized writer can host the
       decision and not the ordering. */
    const { accountId, mailboxId } = await seed("rtr");
    const fleet = new FakeAdapterFleet();
    // The retry's door: `retryFailedMessages` returns at its first line without it.
    fleet.targetedRetry = true;
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    // Behind the folder's watermark: the server holds it and `changesSince` never offers it again,
    // which is what makes this the retry's message and not the ingest loop's.
    fleet.behave(mailboxId, {
      behindWatermark: [{
        from: "stranger@elsewhere.test", subject: "written off",
        messageId: `rtr-${randomUUID()}@x`, uid: 11,
      }],
    });

    const real = makeDrizzleRepo(db as never);
    await real.recordMessageFailure(mailboxId, {
      accountId, folder: "INBOX", uidValidity: "1", uid: 11,
      code: "mime_unparseable", version: "the-build-that-could-not-parse-it", nextAttemptAt: null,
    });

    let removed = false;
    const removing = new Proxy(real, {
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

    await expect(runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo: removing, adapter, accountId, mailboxId, buildVersion: "retry-fence-pg",
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    }), "the retry committed a written-off message into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed, "the removal never happened — the case measured nothing").toBe(true);

    /* AND THE RECORD IS STILL OWED. Closing it is the loss that outlasts the cycle: the UID is
       behind the watermark, so the durable row is the only thing that can ever ask for that
       message again. */
    const [owed] = await db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId));
    expect({
      mail: (await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      emitted: (await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).length,
      closed: owed?.resolvedAt !== null,
    }, "the removed mailbox kept the retried mail, emitted a change, or lost its owed record")
      .toEqual({ mail: 0, emitted: 0, closed: false });
  }, 60_000);

  it("ADMITS an ordinary cycle on a mailbox that is still there", async () => {
    // The positive control for the refusal above: the check is asked on every ingest, so a
    // mailbox nobody removed must ingest exactly as it did before it existed.
    const { accountId, mailboxId } = await seed("rma");
    const { adapter } = adapterFor(accountId, mailboxId, `rma-${randomUUID()}@x`);
    const out = await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo: makeDrizzleRepo(db as never), adapter, accountId, mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    expect(out.hasBacklog, "the fixture did not hand the message over in one cycle").toBe(false);
    expect((await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length)
      .toBe(1);
  }, 60_000);
});
