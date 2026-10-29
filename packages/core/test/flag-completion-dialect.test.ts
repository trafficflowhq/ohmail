import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { flagState, mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { DrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE READ-STATE COMPLETION, ON BOTH STORES — the phone runs this statement too.
 *
 * `completeFlagState` is one raw UPDATE with a witness in its `WHERE`-side `CASE`, and both halves
 * of it are dialect-sensitive: the booleans are spelled as literals because the device driver takes
 * no JavaScript boolean, and the verdict comes back as TEXT because the two stores answer a boolean
 * column differently. The sidecar composes the worker's own cycle over the device store
 * (`@trafficflow/worker/sync`), so a server-only spelling here is a phone that cannot settle a read
 * mark at all. Registered in `vitest.sqlite.config.ts`; without that line the device arm is code
 * nothing runs.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000fa";
const MAILBOX = "00000000-0000-4000-8000-0000000000fb";
const MESSAGE = "00000000-0000-4000-8000-0000000000fc";

async function seeded(desiredSeen: boolean, observedSeen: boolean) {
  const db = await makeTestDb();
  await db.insert(mailboxes).values({
    id: MAILBOX, accountId: ACCOUNT, provider: "imap",
    address: "flagcas@example.test", status: "connected",
  });
  await db.insert(messages).values({
    id: MESSAGE, accountId: ACCOUNT, mailboxId: MAILBOX,
    dedupKey: "mid:<flagcas@example.test>", messageIdHeader: "flagcas@example.test",
    bodyHash: "flagcas-hash", subject: "s", fromAddress: "someone@example.test",
    nativeLocator: { folder: "INBOX", ref: "1:10" }, unread: !desiredSeen,
  });
  await db.insert(flagState).values({
    messageId: MESSAGE, desiredSeen, observedSeen,
    lastSetBy: "us", reconcileStatus: "pending", conflict: false,
  });
  const row = async () => (await db.select().from(flagState).where(eq(flagState.messageId, MESSAGE)))[0]!;
  return { db, repo: new DrizzleRepo(db as never), row };
}

describe("the flag completion answers the same question on both stores", () => {
  it("a MATCHED witness converges the row and says so", async () => {
    const { repo, row } = await seeded(true, false);

    expect(await repo.completeFlagState(MESSAGE, {
      expectDesiredSeen: true, observedSeen: true, lastSetBy: "us", physicalObservation: true,
    })).toBe(true);

    const r = await row();
    expect(r.observedSeen).toBe(true);
    expect(r.desiredSeen).toBe(true);
    expect(r.reconcileStatus).toBe("reconciled");
  });

  it("a STALE witness records the server's fact, keeps the newer desire, and stays pending", async () => {
    // The person pressed unread while the STORE was flying: `desired_seen` is false now.
    const { db, repo, row } = await seeded(false, false);
    void db;

    expect(await repo.completeFlagState(MESSAGE, {
      expectDesiredSeen: true, observedSeen: true, lastSetBy: "us", physicalObservation: true,
    })).toBe(false);

    const r = await row();
    expect(r.desiredSeen).toBe(false);
    expect(r.observedSeen).toBe(true);
    expect(r.reconcileStatus).toBe("pending");
  });

  it("a stale-echo caller writes NOTHING on a miss", async () => {
    const { repo, row } = await seeded(false, false);

    expect(await repo.completeFlagState(MESSAGE, {
      expectDesiredSeen: true, observedSeen: true, lastSetBy: "us",
    })).toBe(false);

    const r = await row();
    expect(r.desiredSeen).toBe(false);
    expect(r.observedSeen).toBe(false);
  });

  it("an unanswered STORE records the doubt and reopens our row, moving no observation", async () => {
    const { repo, row } = await seeded(false, false);
    await repo.completeFlagState(MESSAGE, { expectDesiredSeen: false, observedSeen: false, lastSetBy: "us" });
    expect((await row()).reconcileStatus).toBe("reconciled");

    await repo.markFlagUnanswered(MESSAGE);

    expect(await row()).toMatchObject({
      desiredSeen: false, observedSeen: false, reconcileStatus: "pending", conflict: true, attempts: 0,
    });
  });

  it("the walk's report on a doubted row is recorded as the server's flag, and the doubt clears", async () => {
    const { repo, row } = await seeded(true, false);
    await repo.markFlagUnanswered(MESSAGE);

    expect(await repo.applyExternalFlag(MAILBOX, { folder: "INBOX", ref: "1:10" }, true))
      .toEqual({ messageId: MESSAGE, applied: false, changed: false });

    expect(await row()).toMatchObject({
      desiredSeen: true, observedSeen: true, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  });
});

/* WATCHED FAIL: `desired_seen = (${expect})::boolean` — the server's own spelling — dies
 * `unrecognized token: ":"` on all three device cases while the server run stays green. Restored
 * from a pristine copy and proved by `cmp`. */
