import { describe, it, expect } from "vitest";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { folderState, mailboxes, messageBodies, messageInstances, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { DrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE REAPER'S SCAN, ON BOTH STORES: the same victims as the whole-mailbox scan, and a cost that
 * follows the instance-less rows. Every shape the predicate tells apart is planted beside a crowd
 * of ordinary messages; the ORACLE is the scan as it stood before (one statement, every live
 * message probed). The phone runs the worker's cycle over the device store, so this file is
 * registered in `vitest.sqlite.config.ts` too.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const MAILBOX = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

type Shape = "ordinary" | "orphan" | "junkParked" | "trashParked" | "tombstoned" | "locatorless" | "keepsSecond" | "otherMailbox";

async function seeded(shapes: Shape[], opts: { strayInOther?: boolean } = {}) {
  const db = await makeTestDb();
  for (const [mid, address] of [[MAILBOX, "reaper@example.test"], [OTHER, "reaper-two@example.test"]] as const) {
    await db.insert(mailboxes).values({ id: mid, accountId: ACCOUNT, provider: "imap", address, status: "connected" });
  }
  const put = async (n: number, mailboxId: string, located: boolean) => db.insert(messages).values({
    id: id(n), accountId: ACCOUNT, mailboxId, dedupKey: `mid:<r${n}@example.test>`, messageIdHeader: `r${n}@example.test`,
    bodyHash: `h${n}`, subject: "s", fromAddress: "someone@example.test",
    nativeLocator: located ? { folder: "INBOX", ref: `1:${n}` } : null, unread: true,
  });
  const instance = (n: number, mailboxId: string, folder: string, primary: boolean) => db.insert(messageInstances).values({
    accountId: ACCOUNT, mailboxId, messageId: id(n), folder, uidvalidity: 1n, uid: n, isPrimary: primary,
  });
  // Ids are handed out in a shuffled order, so a shape's rows are spread across the id space.
  const order = shapes.map((_, i) => i).sort((a, b) => ((a * 7919) % 1009) - ((b * 7919) % 1009));
  for (const [i, shape] of shapes.entries()) {
    const n = 1 + order[i]!;
    await put(n, MAILBOX, shape !== "locatorless");
    if (shape === "ordinary") await instance(n, MAILBOX, "INBOX", true);
    if (shape === "keepsSecond") await instance(n, MAILBOX, "Archive", false);
    if (shape === "otherMailbox") await instance(n, OTHER, "INBOX", true);
    if (shape === "tombstoned") await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, id(n)));
    if (shape === "junkParked") {
      await db.insert(folderState).values({
        messageId: id(n), desiredFolder: "Junk", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "reconciled",
      });
    }
    if (shape === "trashParked") {
      // A landed delete: tombstoned, parked at its Trash UID, no copy on record.
      await db.update(messages).set({ deletedAt: new Date(), nativeLocator: { folder: "Trash", ref: `1:${n}` } }).where(eq(messages.id, id(n)));
      await db.insert(folderState).values({
        messageId: id(n), desiredFolder: "Trash", observedFolder: "Trash", lastSetBy: "us", reconcileStatus: "reconciled",
      });
      await db.insert(messageBodies).values({ messageId: id(n), text: "the text of a deleted letter", html: null });
    }
  }
  // A located, instance-less message in the OTHER mailbox: never this mailbox's victim.
  if (opts.strayInOther) await put(9_000, OTHER, true);
  let selects = 0;
  const counted = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "select") selects += 1;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  /* The scan as it stood before this file: one statement, every live message probed. */
  const oracle = async (limit: number) => (await db.select({ id: messages.id }).from(messages)
    .where(and(
      eq(messages.mailboxId, MAILBOX), eq(messages.accountId, ACCOUNT), isNull(messages.deletedAt),
      sql`${messages.nativeLocator} is not null`,
      sql`not exists (select 1 from ${messageInstances} where ${messageInstances.messageId} = ${messages.id})`,
      sql`not exists (select 1 from ${folderState} where ${folderState.messageId} = ${messages.id}
            and ${folderState.reconcileStatus} = 'reconciled' and ${folderState.desiredFolder} <> ${folderState.observedFolder})`,
    )).orderBy(asc(messages.id)).limit(limit)).map((r) => r.id);
  const deleted = async () => (await db.select({ id: messages.id }).from(messages)
    .where(sql`${messages.deletedAt} is not null`).orderBy(asc(messages.id))).map((r) => r.id);
  const repo = new DrizzleRepo(counted as never);
  /* As the cycle runs it: in a transaction (the victims' change rows need one). */
  const reap = (limit: number) => repo.transaction((r) => r.tombstoneInstanceless(ACCOUNT, MAILBOX, limit));
  return { db, repo, reap, oracle, deleted, selects: () => selects };
}

const crowd = (n: number, s: Shape = "ordinary"): Shape[] => Array.from({ length: n }, () => s);

describe("the reaper finds the whole scan's victims from the instance-less rows alone", () => {
  it("every shape: only the instance-less, live, located, unparked messages of this mailbox go, in id order", async () => {
    const shapes: Shape[] = [
      ...crowd(40), ...crowd(5, "orphan"), ...crowd(3, "junkParked"), ...crowd(2, "tombstoned"),
      ...crowd(2, "locatorless"), ...crowd(2, "keepsSecond"), ...crowd(3, "otherMailbox"),
    ];
    const { reap, oracle, deleted } = await seeded(shapes, { strayInOther: true });
    const expected = await oracle(200);
    expect(expected, "the planted orphans are the oracle's whole answer").toHaveLength(5);
    const before = new Set(await deleted());

    expect(await reap(3)).toBe(3);
    const first = (await deleted()).filter((x) => !before.has(x));
    expect(first, "a bounded pass takes the FIRST victims by id, as the scan did").toEqual(expected.slice(0, 3));

    expect(await reap(200)).toBe(2);
    expect((await deleted()).filter((x) => !before.has(x))).toEqual(expected);
    expect(await reap(200)).toBe(0);
    expect(await oracle(200)).toEqual([]);
  });

  it("across the check's chunks and the limit: the same first victims as the scan, parked rows passed over", async () => {
    // 150 instance-less rows (three chunks of candidates), 40 of them junk-parked, among 60 ordinary.
    const shapes: Shape[] = [...crowd(60), ...crowd(110, "orphan"), ...crowd(40, "junkParked")];
    const { reap, oracle, deleted } = await seeded(shapes);
    const expected = await oracle(200);
    expect(expected).toHaveLength(110);
    expect(await reap(70)).toBe(70);
    expect(await deleted()).toEqual(expected.slice(0, 70));
    expect(await reap(200)).toBe(40);
    expect(await deleted()).toEqual(expected);
  });

  it("a mailbox with nothing instance-less costs one read, however many messages it holds", async () => {
    const { repo, selects } = await seeded([...crowd(300), ...crowd(2, "keepsSecond")]);
    const at = selects();
    expect(await repo.tombstoneInstanceless(ACCOUNT, MAILBOX, 200)).toBe(0);
    /* The candidate read is one statement built from two selects (the EXCEPT's halves); a check of
       the candidates would be a third, and a per-message walk of the rows would be five more. */
    expect(selects() - at, "the reaper walked the mailbox instead of reading its instance-less rows").toBe(2);
  });

  it("a letter whose delete landed in Trash is never the reaper's; this store lists and drops it", async () => {
    const { db, repo, reap, oracle } = await seeded([...crowd(20), ...crowd(4, "trashParked"), ...crowd(3, "orphan")]);
    const list = (afterId?: string, limit = 10) =>
      repo.listTrashParked(ACCOUNT, MAILBOX, { folder: "Trash", limit, ...(afterId !== undefined ? { afterId } : {}) });
    const parked = await list();
    expect(parked).toHaveLength(4);
    expect(await list(parked[1]!.messageId, 2), "a page after the second row").toEqual(parked.slice(2));
    expect(await reap(200), "the reaper took a letter parked in Trash").toBe(3);
    expect(await oracle(200)).toEqual([]);
    expect(await list()).toEqual(parked);

    const gone = parked.slice(0, 3).map((p) => ({ ...p, expectDesired: "Trash" }));
    expect(await repo.transaction((r) => r.dropGoneFromTrash(ACCOUNT, MAILBOX, "Trash", gone))).toEqual(gone.map((g) => g.messageId));
    expect(await list()).toEqual(parked.slice(3));
    const husks = await db.select({ id: messageBodies.messageId }).from(messageBodies)
      .where(eq(messageBodies.withheldReason, "expunged")).orderBy(asc(messageBodies.messageId));
    expect(husks.map((h) => h.id)).toEqual(gone.map((g) => g.messageId));
  });

  it("the check runs once per chunk of candidates, not once per message", async () => {
    const { repo, selects } = await seeded([...crowd(200), ...crowd(70, "junkParked")]);
    const at = selects();
    expect(await repo.tombstoneInstanceless(ACCOUNT, MAILBOX, 200)).toBe(0);
    expect(selects() - at, "70 parked candidates are two chunks of the check").toBe(2 + 2);
  });
});
