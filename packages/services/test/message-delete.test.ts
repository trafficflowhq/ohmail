import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { MessageService, SearchService, SyncService, ServiceError } from "../src/index.js";
import { changesFor, makeCtx, movedHere, seedMessage } from "./helpers.js";

/**
 * DELETE — the third user-commanded write of the 2026-08-22 amendment (imap-types.ts).
 *
 * What the service owes, each asserted on its own: the move to the provider's Trash is ordinary
 * desired state (never an expunge, never a row delete); a mailbox with NO Trash is refused UP
 * FRONT with nothing written; the mirror side is ONE `delete` change plus the `deleted_at` stamp
 * that every living view excludes — the snapshot bootstrap and search below — while the delta
 * path and GET-by-id still answer (idempotent replay, honest inspection).
 *
 * Mutations watched (each restored, 2026-08-22):
 *  · drop the `no_trash_folder` refusal ⇒ the refusal test red (a folder_state row naming
 *    `null` and a tombstone written for a message nothing can move);
 *  · drop `isNull(messages.deletedAt)` from `getSnapshot` ⇒ the bootstrap test red;
 *  · drop `m.deleted_at is null` from `whereSql` ⇒ the search test red.
 */

const TRASH = "Deleted Messages";

describe("MessageService.delete — to the provider's Trash, out of the living views", () => {
  it("refuses with 422 no_trash_folder when the mailbox has none, and writes nothing", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const svc = new MessageService();
    await expect(svc.delete(ctx, id)).rejects.toMatchObject({ code: "no_trash_folder", httpStatus: 422 });
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.deletedAt).toBeNull();
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("INBOX");
    expect(await changesFor(db, accountId)).toEqual([]);
  });

  it("with a Trash folder: desired state = the trash path, deleted_at stamped, ONE delete change", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ trashFolder: TRASH }).where(eq(mailboxes.id, mailboxId));
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const svc = new MessageService();

    // This mailbox is organized here, so the delete lands locally; `movedHere` says so
    // rather than letting the routed arm's absent `seq` read as a missing property.
    const { dto, seq } = movedHere(await svc.delete(ctx, id));
    expect(dto.id).toBe(id);
    expect(seq).toBeGreaterThan(0);

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    // The worker's queue sees an ordinary pending move whose destination is the trash path.
    expect(fs).toMatchObject({ desiredFolder: TRASH, observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" });
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.deletedAt).not.toBeNull();
    const changes = await changesFor(db, accountId);
    expect(changes.map((c) => [c.entityType, c.op])).toEqual([["message", "delete"]]);
    expect(changes[0]!.entityId).toBe(id);
    // The row is KEPT — it is the message's identity — and GET-by-id still answers honestly.
    expect(await svc.get(ctx, id)).toMatchObject({ id });
  });

  it("a message with no server copy is tombstoned without a pending move", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await db.update(messages).set({ nativeLocator: null }).where(eq(messages.id, id));
    const svc = new MessageService();
    await svc.delete(ctx, id);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("INBOX");   // untouched: nothing on the server to move
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.deletedAt).not.toBeNull();
  });

  it("a letter already gone from the server answers so: no Trash intent, no change, not in Trash", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ trashFolder: TRASH }).where(eq(mailboxes.id, mailboxId));
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, id));
    const svc = new MessageService();

    const res = await svc.delete(ctx, id);
    expect(res).toMatchObject({ alreadyGone: true, dto: { id } });
    expect("seq" in res).toBe(false);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("INBOX");
    expect(await changesFor(db, accountId)).toEqual([]);
    expect((await svc.listTrash(ctx, {})).items.map((t) => t.id)).not.toContain(id);
    // CONTROL: a tombstoned row already filed to Trash takes the ordinary path.
    const trashed = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    movedHere(await svc.delete(ctx, trashed));
    expect("alreadyGone" in await svc.delete(ctx, trashed)).toBe(false);
  });

  it("the snapshot bootstrap no longer hands a fresh mirror the deleted row; the delta tombstones it", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ trashFolder: TRASH }).where(eq(mailboxes.id, mailboxId));
    const keep = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "keep" });
    const gone = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "gone" });
    await new MessageService().delete(ctx, gone);

    const sync = new SyncService();
    const snap = await sync.getSnapshot(ctx, {});
    const snapIds = snap.changes.filter((c) => c.type === "message").map((c) => c.id);
    expect(snapIds).toContain(keep);
    expect(snapIds).not.toContain(gone);

    const delta = await sync.getChanges(ctx, { since: 0 });
    const tomb = delta.changes.deletes.find((c) => c.type === "message" && c.id === gone);
    expect(tomb).toBeDefined();
  });

  it("search is a living view: a deleted message is not a hit over its stored headers", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ trashFolder: TRASH }).where(eq(mailboxes.id, mailboxId));
    const keep = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "kingfisher keep" });
    const gone = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "kingfisher gone" });
    await db.insert(messageBodies).values({ messageId: keep, text: "kingfisher" });
    await db.insert(messageBodies).values({ messageId: gone, text: "kingfisher" });
    const before = await new SearchService().search(ctx, { q: "kingfisher" });
    expect(before.items.map((m) => m.id).sort()).toEqual([keep, gone].sort());

    await new MessageService().delete(ctx, gone);
    const after = await new SearchService().search(ctx, { q: "kingfisher" });
    expect(after.items.map((m) => m.id)).toEqual([keep]);
  });

  it("the folder list is a living view too: a tombstoned row drops out of its former view", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ trashFolder: TRASH }).where(eq(mailboxes.id, mailboxId));
    const keep = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "keep" });
    const gone = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "gone" });
    // The REAPER's shape, not the delete's: deleted_at stamped while folder_state still names
    // the old view — exactly the row that kept appearing in `GET /messages` before the filter.
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, gone));
    const page = await new MessageService().list(ctx, { view: "imbox" });
    expect(page.items.map((m) => m.id)).toEqual([keep]);
  });

  it("ServiceError carries the closed code the client keys on", () => {
    const e = new ServiceError("no_trash_folder", 422, "x");
    expect(e.code).toBe("no_trash_folder");
    expect(e.httpStatus).toBe(422);
  });
});
