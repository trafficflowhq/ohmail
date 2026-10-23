import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, auditLog, folderState, mailboxes, messages } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { adoptWithWitness, applyReconcileAction } from "../../src/pipeline.js";
import type { AdapterPort, NativeLocator } from "../../src/ports.js";

/**
 * THE APPLY PATH'S TWO REMAINING BLIND WRITES, AGAINST REAL POSTGRES
 * (a completion that overwrote a newer intent).
 *
 * The status repair and the adoption both derive their write from a row read before this pass's
 * network work, so both go through `completeFolderState`. The whole claim is about one UPDATE's
 * `CASE` reading the row's LIVE desire — a fake compares two JavaScript strings and PGlite runs
 * the statement on the only connection there is, so neither says anything about the SQL. The
 * adoption (the arrival's `adoptWithWitness`) is the only caller that writes `desired_folder`
 * at all, and only on a match.
 *
 * Mutations watched: drop `WHEN ${matched}` from the `desired_folder` SET ⇒ the superseded
 * adoption case goes red; put `upsertFolderState` back on either arm ⇒ that arm's case goes red.
 */
const AVAILABLE = await realPgAvailable();

const SOURCE = "ohmail/News";
const READ = "INBOX";
const NEWER = "ohmail/Screener";
const loc = (folder: string, ref = "1:5"): NativeLocator => ({ folder, ref });
/** The two arms under test never dial; a move would be the defect, so the stub records one. */
const noAdapter = { async move(): Promise<NativeLocator> { throw new Error("dialled"); } } as unknown as AdapterPort;

describe.skipIf(!AVAILABLE)("the apply path writes no pre-I/O desire over a newer one", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** One account, one message, and the folder state as the caller READ it. */
  async function seed(desired: string, observed: string) {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `fca-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@fca.test` }).returning();
    const dedup = `mid:${randomUUID()}`;
    const [m] = await owned.db.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "s", fromAddress: "anna@example.com", nativeLocator: loc(observed),
    }).returning({ id: messages.id });
    await owned.db.insert(folderState).values({
      messageId: m!.id, desiredFolder: desired, observedFolder: observed,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false, attempts: 0,
    });
    return { accountId, messageId: m!.id, repo: makeDrizzleRepo(owned.db) };
  }

  /** The competing door: a decision that commits between the caller's read and this write. */
  const commitNewerDesire = async (messageId: string) => {
    await owned.db.update(folderState)
      .set({ desiredFolder: NEWER, reconcileStatus: "pending" })
      .where(eq(folderState.messageId, messageId));
    // The newer intent's own schedule, written as its deferrals write it: no desired folder, so
    // mail 0163's fresh-intent trigger (which zeroes the schedule on a changed desire) keeps it.
    await owned.db.update(folderState).set({ attempts: 3 }).where(eq(folderState.messageId, messageId));
  };

  const rowOf = async (messageId: string) =>
    (await owned.db.select().from(folderState).where(eq(folderState.messageId, messageId)))[0]!;
  const actionsOf = async (accountId: string) =>
    (await owned.db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).map((r) => r.action);

  it("the status repair writes nothing over a decision committed since", async () => {
    const { accountId, messageId, repo } = await seed(READ, READ);
    await commitNewerDesire(messageId);

    const out = await applyReconcileAction(
      { repo, adapter: noAdapter, accountId, mailboxId: "" },
      { messageId, locator: loc(READ), state: { desiredFolder: READ, observedFolder: READ, lastSetBy: "us" } },
      { type: "none" },
    );

    const row = await rowOf(messageId);
    expect(row.desiredFolder, "before the fix this read INBOX").toBe(NEWER);
    expect(row.attempts, "a stale echo may not reset the newer intent's schedule").toBe(3);
    expect(out.state.desiredFolder, "the caller is told what stands").toBe(NEWER);
  }, 60_000);

  it("POSITIVE CONTROL — the ordinary repair converges the pair", async () => {
    const { accountId, messageId, repo } = await seed(READ, SOURCE);
    const out = await applyReconcileAction(
      { repo, adapter: noAdapter, accountId, mailboxId: "" },
      { messageId, locator: loc(READ), state: { desiredFolder: READ, observedFolder: SOURCE, lastSetBy: "us" } },
      { type: "none" },
    );
    const row = await rowOf(messageId);
    expect(row.desiredFolder).toBe(READ);
    expect(row.observedFolder).toBe(READ);
    expect(row.reconcileStatus).toBe("reconciled");
    expect(out.state.observedFolder).toBe(READ);
    expect(await actionsOf(accountId)).toEqual([]);
  }, 60_000);

  it("the adoption records the placement but does not move a desire it no longer describes", async () => {
    const { accountId, messageId, repo } = await seed(READ, READ);
    await commitNewerDesire(messageId);

    // The arrival's adoption, read before this pass's work: the witness is the desire it saw.
    const out = await adoptWithWitness({ repo, accountId }, messageId, SOURCE, READ);

    const row = await rowOf(messageId);
    expect(row.desiredFolder, "the adoption overwrote a newer decision").toBe(NEWER);
    expect(row.observedFolder, "where the person put it is a fact and is recorded").toBe(SOURCE);
    expect(row.reconcileStatus, "the row must self-heal toward the newer desire").toBe("pending");
    expect(row.lastSetBy, "a declined adoption may not re-author the row").toBe("us");
    expect(out.state.desiredFolder).toBe(NEWER);
    expect(await actionsOf(accountId)).toEqual(["adopt_superseded"]);
  }, 60_000);

  it("POSITIVE CONTROL — an uncontested adoption moves the desire and reconciles", async () => {
    const { accountId, messageId, repo } = await seed(READ, READ);
    // The arrival's adoption, read before this pass's work: the witness is the desire it saw.
    const out = await adoptWithWitness({ repo, accountId }, messageId, SOURCE, READ);
    const row = await rowOf(messageId);
    expect(row.desiredFolder, "the person's own placement is the new desire").toBe(SOURCE);
    expect(row.observedFolder).toBe(SOURCE);
    expect(row.reconcileStatus).toBe("reconciled");
    expect(row.lastSetBy).toBe("external");
    expect(out.state.desiredFolder).toBe(SOURCE);
    expect(await actionsOf(accountId)).toEqual(["adopt_external"]);
  }, 60_000);

  /**
   * THE ADOPTION IS STAMPED WITH A LOWER BOUND OF THE MOVE (mail 0145): this cycle's previous success
   * start, never the moment the worker saw it. An aged ohmail press made after the bound lands over
   * the external move; one made before it is behind it.
   */
  it("an adopted external move is stamped with the bound, not the clock", async () => {
    const { accountId, messageId, repo } = await seed(READ, READ);
    const bound = new Date(Date.now() - 60_000);
    await adoptWithWitness({ repo, accountId, observedSince: bound }, messageId, SOURCE, READ);
    const [row] = await owned.db.select({ d: folderState.decidedAt }).from(folderState).where(eq(folderState.messageId, messageId));
    expect(row!.d?.getTime()).toBe(bound.getTime());
    const { placementDecidedAfter } = await import("@trafficflow/db");
    expect(await placementDecidedAfter(owned.db as never, messageId, new Date(bound.getTime() + 30_000))).toBe(false);
    expect(await placementDecidedAfter(owned.db as never, messageId, new Date(bound.getTime() - 30_000))).toBe(true);
    // No bound (no completed cycle) stamps none: every later press is admitted.
    const other = await seed(READ, READ);
    await adoptWithWitness({ repo: other.repo, accountId: other.accountId, observedSince: null }, other.messageId, SOURCE, READ);
    const [none] = await owned.db.select({ d: folderState.decidedAt }).from(folderState).where(eq(folderState.messageId, other.messageId));
    expect(none!.d).toBeNull();
  }, 60_000);
});
