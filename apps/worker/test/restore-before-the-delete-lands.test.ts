import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { accounts, changeLog, folderState, mailboxes, messageBodies, messageInstances, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { MessageGoneError, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { MailboxService, MessageService, type ServiceContext } from "@trafficflow/services";
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
  // Where the server holds the letter: its one copy, moved by `move`.
  const server = { folder: "INBOX", uid: 11 };
  // Runs once, inside the next IMAP move: the press that lands while the delete is in flight.
  // `dropAnswer`: the next move lands on the server and its answer is lost. `throttled`: the next
  // move reads its letter as gone and sends nothing (imapflow's answer to a FETCH throttled four times).
  const hook: { onMove: (() => Promise<void>) | null; dropAnswer: boolean; throttled: boolean; verdict: "proved" | "undecided" } = {
    onMove: null, dropAnswer: false, throttled: false, verdict: "proved",
  };
  const finds: string[] = [];
  const adapter = {
    move: async (loc: { folder: string; ref: string }, to: string) => {
      moves.push(`${loc.folder}->${to}`);
      if (hook.throttled) {
        hook.throttled = false;
        throw new MessageGoneError(loc, true);
      }
      const f = hook.onMove;
      hook.onMove = null;
      if (f) await f();
      Object.assign(server, { folder: to, uid: to === TRASH ? 900 : 12 });
      if (hook.dropAnswer) {
        hook.dropAnswer = false;
        throw Object.assign(new Error("the connection dropped before the answer"), { code: "ECONNRESET" });
      }
      return { folder: to, ref: to === TRASH ? "9:900" : "7:12" };
    },
    setFlags: async () => {},
    uidsHeld: async (folder: string, uidValidity: string, uids: readonly number[]) => ({
      k: "held", uidValidity, present: new Set(uids.filter((u) => server.folder === folder && server.uid === u)),
    }),
    findLetters: async (folder: string, asks: ReadonlyArray<{ key: string }>) => {
      finds.push(folder);
      return {
        k: "read", uidValidity: "9", verdicts: new Map(asks.map((a) => [a.key, hook.verdict === "undecided" ? { k: "undecided" }
          : server.folder === folder ? { k: "found", locator: { folder, ref: `9:${server.uid}` } } : { k: "absent" }])),
      };
    },
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
  /** The walk reads INBOX without the letter's old UID. */
  const walkForgets = async () => { await repo.forgetInstanceAt(mailboxId, { folder: "INBOX", ref: "7:11" }); };
  const filing = async () => (await new MailboxService({ signatureChecks: false }).list(ctx, { counts: true }))
    .find((m) => m.id === mailboxId)!.pendingMoves;
  return {
    id, ctx, deps, moves, hook, server, finds, fs, deletedAt, instances, body, inImbox, inTrash, reap, changeAt, walkForgets, filing,
  };
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
    // Pending until the organizer confirms the copy is still where the Undo put it; the origin
    // stays as the Undo's mark.
    expect(await w.fs()).toMatchObject({
      desiredFolder: "INBOX", observedFolder: "INBOX", reconcileStatus: "pending", trashedFrom: "INBOX",
    });
    expect(await w.filing(), "an Undo counted as a filing").toBe(0);
    expect(await w.inImbox(), "in its view right away").toBe(true);

    await reconcileMailbox(w.deps);
    expect(w.moves, "nothing was sent to the server").toEqual([]);
    expect(w.finds, "Trash was asked about a letter its folder still holds").toEqual([]);
    expect(await w.fs(), "the settled row kept the Undo's mark").toMatchObject({ reconcileStatus: "reconciled", trashedFrom: null });
    expect(await w.deletedAt()).toBeNull();
    expect(await w.inImbox(), "still in its view after the pass").toBe(true);
    expect(await w.inTrash()).toBe(false);
    expect(await refusal(svc.restore(w.ctx, w.id)), "a second press has nothing to restore").toBe("not_in_trash");
  });

  it("an Undo after a delete whose move landed with its answer lost: found in Trash, then moved back, text whole", async () => {
    const w = await world();
    await svc.delete(w.ctx, w.id);
    w.hook.dropAnswer = true;
    await reconcileMailbox(w.deps);
    expect(w.server, "the precondition: the server moved it to Trash").toEqual({ folder: TRASH, uid: 900 });
    expect(await svc.restore(w.ctx, w.id)).toMatchObject({ restoreTo: "INBOX", pending: false });
    await w.walkForgets();
    expect(await w.reap(), "the reaper took the letter the Undo kept").toBe(0);
    expect(await w.deletedAt()).toBeNull();

    const first = await reconcileMailbox(w.deps);
    expect(w.finds).toEqual([TRASH]);
    expect(await w.fs()).toMatchObject({ desiredFolder: "INBOX", observedFolder: TRASH, reconcileStatus: "pending", trashedFrom: null });
    expect((await w.instances()).map((i) => [i.folder, i.uid]), "the Trash copy is not on record").toEqual([[TRASH, 900]]);
    expect(first.owesMore, "the move back is owed now").toBe(true);
    expect(await w.reap()).toBe(0);

    await reconcileMailbox(w.deps);
    expect(w.moves).toEqual([`INBOX->${TRASH}`, `${TRASH}->INBOX`]);
    expect(w.server).toEqual({ folder: "INBOX", uid: 12 });
    expect(await w.fs()).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX", reconcileStatus: "reconciled" });
    const b = await w.body();
    expect([b.withheldReason ?? null, b.text], "the body was emptied").toEqual([null, "the letter"]);
    expect(await w.inImbox()).toBe(true);
  });

  it("CONTROL — an Undo of a letter no server holds any more lets the reaper take it once the pass looked", async () => {
    const w = await world();
    await svc.delete(w.ctx, w.id);
    await svc.restore(w.ctx, w.id);
    Object.assign(w.server, { folder: "", uid: 0 });
    await w.walkForgets();
    expect(await w.reap()).toBe(0);
    await reconcileMailbox(w.deps);
    expect(w.finds).toEqual([TRASH]);
    expect((await w.fs()).reconcileStatus).toBe("reconciled");
    expect(await w.reap(), "a letter gone from every folder stayed").toBe(1);
  });

  it("CONTROL — a move and its Undo, then a delete in another mail app: Trash is never asked, nothing comes back", async () => {
    // A move undone by its inverse move, and a press into the folder the letter is in.
    for (const presses of [["ohmail/Receipts", "INBOX"], ["INBOX"]]) {
      const w = await world();
      for (const folder of presses) await svc.move(w.ctx, w.id, { folder });
      expect(await w.fs()).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX", reconcileStatus: "pending" });
      Object.assign(w.server, { folder: TRASH, uid: 900 });
      await w.walkForgets();
      const reaped = await w.reap();
      await reconcileMailbox(w.deps);
      await reconcileMailbox(w.deps);
      expect(w.moves, "ohmail undid a delete made in another mail app").toEqual([]);
      expect(w.finds, "Trash was asked about a letter that was only moved").toEqual([]);
      expect(reaped + await w.reap(), "the letter deleted elsewhere was kept").toBe(1);
      expect(await w.inImbox()).toBe(false);
    }
  });

  it("CONTROL — an Undo whose letter Trash cannot prove stays in the Imbox with its text, on the ladder", async () => {
    const w = await world();
    await svc.delete(w.ctx, w.id);
    w.hook.dropAnswer = true;
    await reconcileMailbox(w.deps);
    await svc.restore(w.ctx, w.id);
    await w.walkForgets();
    w.hook.verdict = "undecided";
    await reconcileMailbox(w.deps);
    expect(await w.fs()).toMatchObject({
      desiredFolder: "INBOX", observedFolder: "INBOX", reconcileStatus: "pending", lastErrorClass: "unconfirmed", attempts: 1,
    });
    expect(await w.reap()).toBe(0);
    expect(await w.inImbox()).toBe(true);
    expect((await w.body()).withheldReason ?? null).toBeNull();
    expect(await w.filing(), "an unproven Undo counted as a filing").toBe(0);
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
    expect(await w.fs(), "filed back, the row kept the Undo's mark")
      .toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX", trashedFrom: null });
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

describe("a delete whose move read its letter as gone while the server still held it", () => {
  it("keeps its text and stays owed; the next pass files it into Trash", async () => {
    const w = await world();
    await svc.delete(w.ctx, w.id);
    w.hook.throttled = true;
    await reconcileMailbox(w.deps);
    expect(w.server, "the precondition: nothing moved").toEqual({ folder: "INBOX", uid: 11 });
    expect(await w.fs()).toMatchObject({ desiredFolder: TRASH, observedFolder: "INBOX", reconcileStatus: "pending" });
    expect((await w.body()).text, "a letter the server still holds was emptied").toBe("the letter");

    await reconcileMailbox(w.deps);
    expect(w.moves).toEqual([`INBOX->${TRASH}`, `INBOX->${TRASH}`]);
    expect(await w.fs()).toMatchObject({ desiredFolder: TRASH, observedFolder: TRASH, reconcileStatus: "reconciled" });
    expect(await w.inTrash()).toBe(true);
    expect((await w.body()).withheldReason ?? null).toBeNull();
  });
});
