import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, changeLog, folderState, mailboxes, messageInstances, messages,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { PendingFolderState, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { NativeLocator } from "@trafficflow/core";
import { completeFiling, type SpecialFolderMap } from "../src/junk-filing.js";

/**
 * ═══ A DELETE WITH TWO WATCHED INSTANCES MUST NEVER HIDE THE SURVIVOR FOR EVER ═══════════════
 *
 * THE FAILURE THIS FILE PINS SHUT, as the sequence it actually takes: the API's delete tombstones
 * the row (`deleted_at` + the `delete` change) and writes the pending move to native \Trash; the
 * worker moves the PRIMARY copy there and its completion parks the locator — `forgetInstanceAt`
 * removes the Trash instance and PROMOTES the surviving watched copy (the unexpunged-source
 * shape: a client that copied instead of moving, Exchange's re-rendered second copy). Before this
 * fix the completion then converged the folder_state, and the message was owed to nobody: the
 * survivor is a KNOWN locator, so no scan ever emits the create that resurrects a tombstone, and
 * a reconciled row never re-enters the reconciler's queue. Server-resident, invisible in every
 * client, permanently.
 *
 * The semantics ruled here, against imap-types.ts's amendment (delete = the user-commanded move
 * to native \Trash, never an expunge; the IMAP mailbox is the master): the user deleted the
 * MESSAGE, and every instance is a physical copy of it — so the completion keeps the pending row
 * OPEN at the survivor's folder, and the next reconcile pass files that copy to Trash through the
 * same seam. One copy per pass, until nothing watched remains; the tombstone stands throughout,
 * because it is converging to the truth rather than contradicting it.
 *
 * Real Postgres (:5433), not PGlite: every claim is `message_instances` bookkeeping under the
 * partial-unique primary index plus `folder_state`'s derived `reconcile_status` — exactly the
 * transactional class CLAUDE.md records PGlite being blind to.
 *
 * Mutations watched (each restored, 2026-08-24):
 *  · revert `completeFiling`'s survivor branch (always write the converged park)
 *      ⇒ "keeps the move owed" red on `reconcile_status: expected 'pending', got 'reconciled'`
 *        and on the queue assertion (the row vanishes from `listPendingFolderStates`).
 *  · make `forgetInstanceAt` answer null even when it promoted
 *      ⇒ same test red the same way — the completion cannot see the survivor.
 */

const AVAILABLE = await realPgAvailable();
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

const TRASH = "Trash";
const SENT = "Sent";
const SPECIAL: SpecialFolderMap = { junkFolder: "[Gmail]/Spam", trashFolder: TRASH, sentFolder: SENT };

describe.skipIf(!AVAILABLE)("delete filing — a promoted survivor keeps the move owed", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  /**
   * The exact state the API's `delete` leaves for the worker when the message has a second
   * watched copy: row tombstoned, `delete` change emitted, folder_state pending toward the
   * mailbox's trash path — seeded verbatim rather than described.
   */
  async function seedDeleted(opts: { instances: Array<{ folder: string; uid: number; primary: boolean }> }) {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `ds-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `ds-${tag}@example.test`, status: "connected",
      junkFolder: SPECIAL.junkFolder, trashFolder: SPECIAL.trashFolder,
    }).returning();
    const primary = opts.instances.find((i) => i.primary)!;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<ds-${tag}@example.test>`,
      messageIdHeader: `ds-${tag}@example.test`,
      fromAddress: "someone@example.test", subject: "s",
      bodyHash: `ds-hash-${tag}`,
      nativeLocator: LOC(primary.folder, `1:${primary.uid}`),
      deletedAt: new Date(),
    }).returning();
    for (const i of opts.instances) {
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId: mb!.id, folder: i.folder, uid: i.uid,
        uidvalidity: 1n, isPrimary: i.primary,
      });
    }
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: TRASH, observedFolder: primary.folder,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });
    const repo = makeDrizzleRepo(db as never) as WorkerRepo & {
      transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
    };
    // The API emits its `delete` change inside its own transaction; seq allocation requires one.
    await repo.transaction(async (r) => {
      await r.recordChange({
        accountId, entityType: "message", entityId: m!.id, op: "delete", meta: null,
      });
    });
    return { accountId, mailboxId: mb!.id, messageId: m!.id, repo };
  }

  const pendingOf = async (repo: WorkerRepo, mailboxId: string): Promise<PendingFolderState[]> =>
    repo.listPendingFolderStates(mailboxId);

  it("keeps the move owed: pending at the survivor's folder, locator repointed, tombstone standing", async () => {
    const { accountId, mailboxId, messageId, repo } = await seedDeleted({
      instances: [
        { folder: "INBOX", uid: 300, primary: true },
        { folder: "ohmail/News", uid: 41, primary: false },
      ],
    });

    // CYCLE 1 — the adapter moved the primary INBOX copy to Trash; this is its completion.
    // TRUE: the completion re-opened the row, and the caller owes that to the scheduler
    // (`reconcileFolders` folds it into `owesMore`) — without it the surviving copy waits for
    // the next poll, or is never reached by a drain that stops on backlog alone.
    const [p1] = await pendingOf(repo, mailboxId);
    expect(p1!.desiredFolder).toBe(TRASH);
    expect(await completeFiling(repo, accountId, mailboxId, p1!, LOC(TRASH, "9:900"), SPECIAL))
      .toBe(true);

    // The survivor was promoted: it is the message's one instance and its locator.
    const inst = await db.select().from(messageInstances)
      .where(eq(messageInstances.messageId, messageId));
    expect(inst).toHaveLength(1);
    expect(inst[0]!.folder).toBe("ohmail/News");
    expect(inst[0]!.isPrimary).toBe(true);
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect((row!.nativeLocator as NativeLocator).folder).toBe("ohmail/News");
    // The tombstone stands — the delete is converging, not being contradicted.
    expect(row!.deletedAt).not.toBeNull();

    // THE FIX: the folder_state is PENDING at the survivor, never converged over a watched copy.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.reconcileStatus, "a watched survivor means the delete is not done").toBe("pending");
    expect(fs!.desiredFolder).toBe(TRASH);
    expect(fs!.observedFolder).toBe("ohmail/News");
    // (`satisfiedBy` is not a column — it is an input to `reconcileStatusFor`, and the stored
    // `pending` above IS the proof the completion did not pass it here.)

    // And the reconciler genuinely gets it back, carrying the SURVIVOR's locator to move from.
    const queue = await pendingOf(repo, mailboxId);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.messageId).toBe(messageId);
    expect(queue[0]!.nativeLocator).toEqual(LOC("ohmail/News", "1:41"));

    // CYCLE 2 — the adapter moved the survivor to Trash; the completion now converges (FALSE:
    // nothing was re-opened, no continuation is owed).
    expect(await completeFiling(repo, accountId, mailboxId, queue[0]!, LOC(TRASH, "9:901"), SPECIAL))
      .toBe(false);
    expect(await db.select().from(messageInstances)
      .where(eq(messageInstances.messageId, messageId))).toHaveLength(0);
    const [fs2] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs2!.reconcileStatus).toBe("reconciled");
    expect(fs2!.observedFolder).toBe(TRASH);
    expect(await pendingOf(repo, mailboxId)).toHaveLength(0);
    const [after] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(after!.deletedAt).not.toBeNull();

    // ONE delete change for the whole episode — the API's. Nothing here re-emits or resurrects.
    const changes = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message"),
    ));
    expect(changes.map((c) => c.op)).toEqual(["delete"]);

    // And the reaper has nothing to add: the row is already tombstoned, so the converged,
    // instanceless end state is not re-reaped into a second delete.
    const reaped = await repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
    expect(reaped).toBe(0);
  });

  it("THREE watched copies drain one per pass, and the loop terminates", async () => {
    const { accountId, mailboxId, messageId, repo } = await seedDeleted({
      instances: [
        { folder: "INBOX", uid: 300, primary: true },
        { folder: "ohmail/News", uid: 41, primary: false },
        { folder: "ohmail/Screened", uid: 7, primary: false },
      ],
    });
    let ref = 900;
    for (let cycle = 0; cycle < 3; cycle++) {
      const queue = await pendingOf(repo, mailboxId);
      expect(queue, `cycle ${cycle} must still owe the move`).toHaveLength(1);
      await completeFiling(repo, accountId, mailboxId, queue[0]!, LOC(TRASH, `9:${ref++}`), SPECIAL);
    }
    expect(await pendingOf(repo, mailboxId)).toHaveLength(0);
    expect(await db.select().from(messageInstances)
      .where(eq(messageInstances.messageId, messageId))).toHaveLength(0);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.reconcileStatus).toBe("reconciled");
  });

  it("a \\Sent survivor is NEVER re-opened onto — the completion converges instead", async () => {
    /* The stale-row wedge this exclusion closes: Sent is enumerated from a UID watermark, and a
       delete below it is deliberately never reported — so a recorded Sent instance (own_copy at
       send time) can outlive its server copy, and a re-open onto it would retry MessageGoneError
       for ever with `primaryInstanceVanished` held false by the stale promoted primary. The
       product half agrees: deleting the received copy leaves the record of what you sent, in
       every mainstream client. */
    const { accountId, mailboxId, messageId, repo } = await seedDeleted({
      instances: [
        { folder: "INBOX", uid: 300, primary: true },
        { folder: SENT, uid: 12, primary: false },
      ],
    });
    const [p] = await pendingOf(repo, mailboxId);
    expect(await completeFiling(repo, accountId, mailboxId, p!, LOC(TRASH, "9:900"), SPECIAL))
      .toBe(false);
    // Converged — no pending move retries against a locator Sent's enumeration can never retire.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.reconcileStatus).toBe("reconciled");
    expect(await pendingOf(repo, mailboxId)).toHaveLength(0);
    // The Sent copy stays recorded and promoted (the pre-fix park, unchanged for this folder);
    // the tombstone stands.
    const inst = await db.select().from(messageInstances)
      .where(eq(messageInstances.messageId, messageId));
    expect(inst).toHaveLength(1);
    expect(inst[0]!.folder).toBe(SENT);
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.deletedAt).not.toBeNull();
  });

  it("the single-instance delete keeps its one-pass completion byte-for-byte", async () => {
    const { accountId, mailboxId, messageId, repo } = await seedDeleted({
      instances: [{ folder: "INBOX", uid: 300, primary: true }],
    });
    const [p] = await pendingOf(repo, mailboxId);
    await completeFiling(repo, accountId, mailboxId, p!, LOC(TRASH, "9:900"), SPECIAL);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.reconcileStatus).toBe("reconciled");
    expect(fs!.observedFolder).toBe(TRASH);
    expect(await pendingOf(repo, mailboxId)).toHaveLength(0);
    expect(await db.select().from(messageInstances)
      .where(eq(messageInstances.messageId, messageId))).toHaveLength(0);
  });
});
