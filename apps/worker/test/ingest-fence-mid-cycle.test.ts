import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { ingestRunRepository } from "../src/ingest-run.js";
import { INGEST_RUN_BOUNDS } from "../src/config.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * AN ERASURE THAT LANDS BETWEEN TWO MESSAGES OF ONE CYCLE TAKES EVERYTHING AFTER IT. The cycle
 * commits one message per transaction and plans from reads taken before any of them, so a mailbox
 * erased after message N is invisible to every plan already made and N+1 would land against a
 * tombstone whose mail has just been swept. The stamp is the only thing that can refuse it:
 * `mailboxes` survives its own sweep, so the key every ingested row hangs off is still there.
 * `erased_at` is stamped ALONE, with `status` left `connected` — the production erasure disables
 * the mailbox in the same transaction, so a case driving the real verb would be green for nothing.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000e8a5";

describe("the ingest's erasure fence, mid-cycle", () => {
  it("writes nothing after an erasure that lands between two messages of one cycle", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `mid-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;

    // The erasure lands BETWEEN two commit transactions — the window a per-cycle check cannot see
    // and the one this fence was written for. Stamped on the outer handle after the first commit
    // returns, so no statement of it is inside the transaction it is racing.
    const real = makeDrizzleRepo(db as never);
    let commits = 0;
    let erasedAfter: number | null = null;
    const erasing = new Proxy(real, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv) as unknown;
        if (prop !== "transaction" || typeof value !== "function") return value;
        return async (fn: (r: DrizzleRepo) => Promise<unknown>): Promise<unknown> => {
          const out = await (value as (f: (r: DrizzleRepo) => Promise<unknown>) => Promise<unknown>)
            .call(target, fn);
          commits += 1;
          if (erasedAfter === null && (await db.select({ id: messages.id }).from(messages)).length === 1) {
            erasedAfter = commits;
            await db.update(mailboxes).set({ erasedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
          }
          return out;
        };
      },
    }) as DrizzleRepo;

    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: Array.from({ length: 4 }, (_, i) => ({
        from: `s${i}@x.example`, subject: `msg ${i}`, messageId: `mid-${i}@x`,
      })),
    });

    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo: erasing, adapter, accountId: ACCOUNT, mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    }).catch((err: unknown) => err);

    expect(erasedAfter, "the erasure never landed — the case measures nothing").not.toBeNull();
    const rows = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.mailboxId, mailboxId));
    expect(rows.length,
      "a message was written into a mailbox erased earlier in the same cycle — its mail came back")
      .toBe(1);
    // The mailbox was erased and NOT disabled: the older removal fence is not what answered.
    const [after] = await db.select({ status: mailboxes.status }).from(mailboxes)
      .where(eq(mailboxes.id, mailboxId));
    expect(after!.status).toBe("connected");
  }, 60_000);

  it("writes no run after an erasure that lands between two runs of one cycle", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `runs-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;
    const real = ingestRunRepository(makeDrizzleRepo(db as never));
    let erased = false;
    const erasing = new Proxy(real, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv) as unknown;
        if (prop !== "transaction" || typeof value !== "function") return value;
        return async (fn: (r: DrizzleRepo) => Promise<unknown>): Promise<unknown> => {
          const out = await (value as (f: (r: DrizzleRepo) => Promise<unknown>) => Promise<unknown>).call(target, fn);
          if (!erased && (await db.select({ id: messages.id }).from(messages)).length === 2) {
            erased = true;
            await db.update(mailboxes).set({ erasedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
          }
          return out;
        };
      },
    }) as DrizzleRepo;
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mailboxId, {
      deliver: Array.from({ length: 6 }, (_, i) => ({ from: `s${i}@x.example`, subject: `msg ${i}`, messageId: `runs-${i}@x` })),
    });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: erasing, adapter, accountId: ACCOUNT, mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, ingestRuns: { ...INGEST_RUN_BOUNDS, maxMembers: 2 },
      role: "organizer", trustedAuthservIds: new Set<string>(),
    }).catch((err: unknown) => err);
    expect(erased, "the erasure never landed between two runs").toBe(true);
    expect((await db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      "a run was written into a mailbox erased earlier in the same cycle").toBe(2);
  }, 60_000);

  it("refuses a second copy of a message it already holds, once the mailbox is erased", async () => {
    /* THE COMMIT THE HAND-OVER DOES NOT COVER, and why the standing read carries the stamp too. A
       new message defers its question to the change-log allocation it is already sending; a COPY
       of a message this mailbox already holds appends no change at all, so an allocation it never
       makes could not have asked. It writes all the same — the copy's locator becomes known — and
       `commitFenced` asks for it first, with the read that now returns both stamps.
       WATCHED FAIL: with the erasure arm cut from `mailboxStatusForWrite`, the copy's instance row
       lands in the erased mailbox. */
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `copy-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;

    const repo = makeDrizzleRepo(db as never);
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    const messageId = `copy-${randomUUID()}@x`;
    const cycle = (): Promise<unknown> => runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo, adapter, accountId: ACCOUNT, mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    });

    fleet.behave(mailboxId, { deliver: [{ from: "s@x.example", subject: "twice", messageId }] });
    await cycle();
    const instances = async (): Promise<number> =>
      (await db.select({ id: messageInstances.id }).from(messageInstances)
        .where(eq(messageInstances.mailboxId, mailboxId))).length;
    expect(await instances(), "the first cycle ingested nothing, so there is no copy to arrive")
      .toBe(1);

    await db.update(mailboxes).set({ erasedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
    fleet.behave(mailboxId, {
      deliver: [
        { from: "s@x.example", subject: "twice", messageId },
        { from: "s@x.example", subject: "twice", messageId, folder: "ohmail/News" },
      ],
    });
    await cycle().catch((err: unknown) => err);

    expect(await instances(),
      "the copy's locator was recorded against a mailbox that had been erased").toBe(1);
    const [after] = await db.select({ status: mailboxes.status }).from(mailboxes)
      .where(eq(mailboxes.id, mailboxId));
    expect(after!.status).toBe("connected");
  }, 60_000);
});
