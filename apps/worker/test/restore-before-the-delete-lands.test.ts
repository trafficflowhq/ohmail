import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, changeLog, folderState, mailboxes, messageBodies, messageInstances, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { MessageService, type ServiceContext } from "@trafficflow/services";
import { reconcileMailbox, type SyncDeps } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * RESTORE BEFORE THE DELETE LANDS — the press and the organizer's pass composed on the stores the
 * desktop and the phone carry (and PGlite). A Restore pressed while the delete's move is still
 * owed cancels the delete: nothing is sent to the server and the letter is back at once. Before
 * the fix the restore wrote desired := origin over an observed origin, the status repair settled
 * it, and the letter stayed tombstoned in no view while the server still held it in INBOX.
 */
const TRASH = "Trash";
const t0 = new Date("2026-10-24T08:00:00.000Z");
const svc = new MessageService();

async function world(opts: { instance?: boolean } = {}) {
  const db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "rud" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "p@example.test", trashFolder: TRASH,
    organizerRole: "organizer", organizeConsentedAt: t0,
  }).returning();
  const mailboxId = mb!.id;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, dedupKey: "mid:<r@x>", messageIdHeader: "<r@x>", fromAddress: "anna@x.example",
    subject: "s", date: t0, bodyHash: "h", nativeLocator: { folder: "INBOX", ref: "7:11" },
  }).returning();
  const id = m!.id;
  // The watched copy, as ingest records it.
  if (opts.instance !== false) {
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId: id, folder: "INBOX", uidvalidity: 7n, uid: 11, isPrimary: true,
    });
  }
  await db.insert(messageBodies).values({ messageId: id, text: "the letter" });
  await db.insert(folderState).values({
    messageId: id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
    reconcileStatus: "reconciled", conflict: false,
  });
  const repo = makeDrizzleRepo(db as never);
  const ctx = { db, accountId, userId: null, now: () => new Date(), requestId: "rud" } as unknown as ServiceContext;
  const moves: string[] = [];
  // Runs once, inside the next IMAP move: the press that lands while the delete is in flight.
  const hook: { onMove: (() => Promise<void>) | null } = { onMove: null };
  const adapter = {
    move: async (loc: { folder: string; ref: string }, to: string) => {
      moves.push(`${loc.folder}->${to}`);
      const f = hook.onMove;
      hook.onMove = null;
      if (f) await f();
      return { folder: to, ref: to === TRASH ? "9:900" : "7:12" };
    },
    setFlags: async () => {},
  } as unknown as MailboxAdapter;
  const deps = {
    repo, adapter, accountId, mailboxId, role: "organizer", writeAuthority: FIXTURE_LEASE,
    trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
  } as unknown as SyncDeps;
  const fs = async () => (await db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!;
  const deletedAt = async () =>
    (await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id)))[0]!.d;
  const instances = async () => db.select().from(messageInstances).where(eq(messageInstances.messageId, id));
  const body = async () => (await db.select().from(messageBodies).where(eq(messageBodies.messageId, id)))[0]!;
  const inImbox = async () => (await svc.list(ctx, { view: "imbox" })).items.some((x) => x.id === id);
  const inTrash = async () => (await svc.listTrash(ctx, { view: "trash" })).items.some((x) => x.id === id);
  const reap = async () => repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
  const changeAt = async (seq: number) => (await db.select({ op: changeLog.op, entityId: changeLog.entityId })
    .from(changeLog).where(and(eq(changeLog.accountId, accountId), eq(changeLog.seq, BigInt(seq)))))[0];
  return { id, ctx, deps, moves, hook, fs, deletedAt, instances, body, inImbox, inTrash, reap, changeAt };
}

const refusal = async (p: Promise<unknown>) => p.then(() => "applied", (e: { code?: string }) => String(e.code));

describe("a Restore pressed before the delete's move landed", () => {
  it("cancels the delete: back at once, nothing sent to the server, and it stays back after a pass", async () => {
    const w = await world();
    await svc.delete(w.ctx, w.id);
    const out = await svc.restore(w.ctx, w.id);
    expect(out).toMatchObject({ restoreTo: "INBOX", pending: false });
    expect(await w.deletedAt(), "the tombstone is cleared by the press").toBeNull();
    expect(await w.changeAt(out.seq), "one update change re-adds the row in every mirror")
      .toEqual({ op: "update", entityId: w.id });
    expect(await w.fs()).toMatchObject({
      desiredFolder: "INBOX", observedFolder: "INBOX", reconcileStatus: "reconciled", trashedFrom: null,
    });
    expect(await w.inImbox(), "in its view right away").toBe(true);

    await reconcileMailbox(w.deps);
    expect(w.moves, "nothing was sent to the server").toEqual([]);
    expect(await w.deletedAt()).toBeNull();
    expect(await w.inImbox(), "still in its view after the pass").toBe(true);
    expect(await w.inTrash()).toBe(false);
    expect(await refusal(svc.restore(w.ctx, w.id)), "a second press has nothing to restore").toBe("not_in_trash");
  });

  it("a press that lands DURING the delete's move: the copy is kept, and the next pass brings it back", async () => {
    const w = await world();
    await svc.delete(w.ctx, w.id);
    let pressed: unknown = null;
    w.hook.onMove = async () => { pressed = await svc.restore(w.ctx, w.id); };
    const first = await reconcileMailbox(w.deps);
    expect(pressed).toMatchObject({ restoreTo: "INBOX", pending: false });
    expect(await w.deletedAt(), "back at once").toBeNull();
    expect((await w.instances()).map((i) => [i.folder, i.isPrimary]), "the Trash copy is not forgotten")
      .toEqual([[TRASH, true]]);
    expect(await w.fs()).toMatchObject({ desiredFolder: "INBOX", observedFolder: TRASH, reconcileStatus: "pending" });
    expect(first.owesMore, "the move back is owed now").toBe(true);

    expect(await w.reap(), "the reaper takes nothing").toBe(0);
    expect(await w.deletedAt()).toBeNull();

    await reconcileMailbox(w.deps);
    expect(w.moves).toEqual([`INBOX->${TRASH}`, `${TRASH}->INBOX`]);
    expect(await w.fs()).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
    expect(await w.deletedAt()).toBeNull();
    const b = await w.body();
    expect(b.withheldReason ?? null, "the body is never husked").toBeNull();
    expect(b.text).toBe("the letter");
    expect(await w.inImbox()).toBe(true);
  });

  it("a delete that landed first restores as today: pending, the tombstone stands until the move back", async () => {
    const w = await world();
    await svc.delete(w.ctx, w.id);
    await reconcileMailbox(w.deps);
    expect((await w.fs()).observedFolder).toBe(TRASH);
    const out = await svc.restore(w.ctx, w.id);
    expect(out).toMatchObject({ restoreTo: "INBOX", pending: true });
    expect(await w.deletedAt(), "the server still holds it in Trash").not.toBeNull();
    expect(await w.changeAt(out.seq)).toEqual({ op: "move", entityId: w.id });

    await reconcileMailbox(w.deps);
    expect(w.moves).toEqual([`INBOX->${TRASH}`, `${TRASH}->INBOX`]);
    expect(await w.deletedAt()).toBeNull();
    expect(await w.inImbox()).toBe(true);
  });

  it("a letter with no watched copy on record keeps today's path", async () => {
    const w = await world({ instance: false });
    await svc.delete(w.ctx, w.id);
    const out = await svc.restore(w.ctx, w.id);
    expect(out).toMatchObject({ restoreTo: "INBOX", pending: true });
    expect(await w.deletedAt(), "the tombstone stands").not.toBeNull();
    expect(await w.fs()).toMatchObject({ desiredFolder: "INBOX", reconcileStatus: "pending" });
  });
});
