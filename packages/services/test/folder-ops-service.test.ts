import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, changeLog, folderOps, folderState, idempotencyKeys, mailboxFolders, mailboxes, messages } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  FolderOpsService, ServiceError, setFoldersEnabled, userFolderById,
  type ServiceContext,
} from "../src/index.js";

/**
 * THE FOLDER VERBS' API HALF — what `POST/PATCH/DELETE /folders` may record and what it must
 * refuse (FOLDERS-SPEC.md stage 2). The worker's pass is tested in `apps/worker`; the pg
 * swap in `folder-rename-swap.pg.test.ts`. HERE: every enqueue-time gate, the pending markers
 * on the wire, the doorbell, and the dismiss ceremony — each refusal a sentence, each accept
 * exactly one command row plus one change row.
 */

const svc = new FolderOpsService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function setup(opts: { enabled?: boolean } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "own@example.com", trashFolder: "Trash" })
    .returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-08-26T00:00:00.000Z"), requestId: "r",
  };
  if (opts.enabled !== false) await setFoldersEnabled(ctx, true);
  return { db, accountId, mailboxId: mb.id, ctx };
}

async function addFolder(db: Db, mailboxId: string, folder: string): Promise<string> {
  const [row] = await db.insert(mailboxFolders)
    .values({ mailboxId, folder, uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n })
    .returning();
  return row.id;
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
};

describe("create", () => {
  it("records the command: an inventory row, a pending marker on the wire, a create change row, and the doorbell", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const { dto, seq } = await svc.create(ctx, { mailboxId, name: "Projects/Acme" });
    expect(dto.name).toBe("Projects/Acme");
    expect(dto.op).toEqual({ kind: "create" });
    expect(seq).not.toBeNull();

    const row = await userFolderById(db, accountId, dto.id);
    expect(row?.op).toEqual({ kind: "create", to: null, error: null });
    const ops = await db.select().from(folderOps).where(eq(folderOps.folderId, dto.id));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe("create");
    const log = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(log.filter((r) => r.entityType === "folder" && r.op === "create" && r.entityId === dto.id)).toHaveLength(1);
    const [box] = await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(box!.at).not.toBeNull();
  });

  it("refuses with the honest code: flag off, bad names, reserved names, collisions, a stood-down mailbox", async () => {
    const off = await setup({ enabled: false });
    expect(await code(svc.create(off.ctx, { mailboxId: off.mailboxId, name: "A" }))).toBe("folders_disabled");

    const { db, mailboxId, ctx } = await setup();
    expect(await code(svc.create(ctx, { mailboxId, name: "" }))).toBe("validation_failed");
    expect(await code(svc.create(ctx, { mailboxId, name: "a//b" }))).toBe("validation_failed");
    expect(await code(svc.create(ctx, { mailboxId, name: " padded" }))).toBe("validation_failed");
    expect(await code(svc.create(ctx, { mailboxId, name: "ratio%" }))).toBe("validation_failed");
    expect(await code(svc.create(ctx, { mailboxId, name: "a".repeat(201) }))).toBe("validation_failed");
    // The reserved families: the mailbox's own belts, the six, INBOX, the ohmail namespace,
    // and the Sent shapes — a folder the passive read would never watch is refused up front.
    for (const name of ["Trash", "Projects/Spam", "INBOX", "ohmail/News", "ohmail", "Sent", "INBOX/Sent Messages", "Papierkorb"]) {
      expect(await code(svc.create(ctx, { mailboxId, name })), name).toBe("validation_failed");
    }

    await addFolder(db, mailboxId, "Projects");
    expect(await code(svc.create(ctx, { mailboxId, name: "Projects" }))).toBe("conflict");

    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));
    expect(await code(svc.create(ctx, { mailboxId, name: "Later" }))).toBe("mailbox_stood_down");
  });

  it("refuses another account's mailbox as not_found — ownership by scoping", async () => {
    const a = await setup();
    const b = await setup();
    expect(await code(svc.create(a.ctx, { mailboxId: b.mailboxId, name: "Steal" }))).toBe("not_found");
  });
});

describe("rename", () => {
  it("records the command with the target riding the marker while `name` keeps the mailbox's truth", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const id = await addFolder(db, mailboxId, "Proj");
    const { dto } = await svc.rename(ctx, id, { name: "Neu" });
    expect(dto.name).toBe("Proj");
    expect(dto.op).toEqual({ kind: "rename", to: "Neu" });
    const log = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(log.filter((r) => r.entityId === id && r.op === "update")).toHaveLength(1);
  });

  it("refuses: itself, its own subtree, a colliding target, and any overlapping in-flight command", async () => {
    const { db, mailboxId, ctx } = await setup();
    const id = await addFolder(db, mailboxId, "Proj");
    await addFolder(db, mailboxId, "Proj/Sub");
    await addFolder(db, mailboxId, "Taken");
    expect(await code(svc.rename(ctx, id, { name: "Proj" }))).toBe("validation_failed");
    expect(await code(svc.rename(ctx, id, { name: "Proj/Inside" }))).toBe("validation_failed");
    expect(await code(svc.rename(ctx, id, { name: "Taken" }))).toBe("conflict");

    // One command in flight per SUBTREE: with the rename recorded, a second command on the
    // subject, a descendant, or the target path refuses until it settles.
    await svc.rename(ctx, id, { name: "Neu" });
    expect(await code(svc.rename(ctx, id, { name: "Zwei" }))).toBe("conflict");
    const sub = await db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.folder, "Proj/Sub"));
    expect(await code(svc.remove(ctx, sub[0]!.id))).toBe("conflict");
    expect(await code(svc.create(ctx, { mailboxId, name: "Neu/Kind" }))).toBe("conflict");
  });
});

describe("delete", () => {
  it("records the command only when the mailbox has a discovered Trash — never an expunge path", async () => {
    const { db, mailboxId, ctx } = await setup();
    const id = await addFolder(db, mailboxId, "Alt");
    await db.update(mailboxes).set({ trashFolder: null }).where(eq(mailboxes.id, mailboxId));
    expect(await code(svc.remove(ctx, id))).toBe("no_trash_folder");

    await db.update(mailboxes).set({ trashFolder: "Trash" }).where(eq(mailboxes.id, mailboxId));
    const { dto } = await svc.remove(ctx, id);
    expect(dto.op).toEqual({ kind: "delete" });
  });
});

describe("dismiss", () => {
  it("clears only a FAILED command; a pending one is the worker's until it answers", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const id = await addFolder(db, mailboxId, "Alt");
    await svc.rename(ctx, id, { name: "Neu" });
    expect(await code(svc.dismiss(ctx, id))).toBe("conflict");
    await db.update(folderOps).set({ status: "failed", error: "exists" }).where(eq(folderOps.folderId, id));
    const { dto } = await svc.dismiss(ctx, id);
    expect(dto?.op).toBeUndefined();
    expect(await db.select().from(folderOps).where(eq(folderOps.folderId, id))).toHaveLength(0);
    void accountId;
  });

  it("a failed CREATE takes its never-created row with it, tombstoned on the wire", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const { dto } = await svc.create(ctx, { mailboxId, name: "Nie" });
    await db.update(folderOps).set({ status: "failed", error: "bad_name" }).where(eq(folderOps.folderId, dto.id));
    const out = await svc.dismiss(ctx, dto.id);
    expect(out.dto).toBeNull();
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, dto.id))).toHaveLength(0);
    const log = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(log.filter((r) => r.entityId === dto.id && r.op === "delete")).toHaveLength(1);
  });

  it("an erased account's dismiss is refused 410 and writes nothing, with or without a key", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const { dto } = await svc.create(ctx, { mailboxId, name: "Nie" });
    await db.update(folderOps).set({ status: "failed", error: "bad_name" }).where(eq(folderOps.folderId, dto.id));
    const before = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    await db.insert(accounts).values({ id: accountId, name: "erased", erasedAt: new Date("2026-08-26T00:00:00.000Z") });
    expect(await code(svc.dismiss(ctx, dto.id))).toBe("account_erased");
    expect(await code(svc.dismiss(ctx, dto.id, { idempotency: { key: "k", requestHash: "h" } }))).toBe("account_erased");
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).toEqual(before);
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, dto.id))).toHaveLength(1);
  });
});

describe("summary", () => {
  it("counts the subtree and its messages by the SAME derivation the views render with", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const id = await addFolder(db, mailboxId, "Proj");
    await addFolder(db, mailboxId, "Proj/Sub");
    await addFolder(db, mailboxId, "Elsewhere");
    const msg = async (folder: string, opts: { desired?: string; deleted?: boolean } = {}) => {
      const mid = randomUUID();
      await db.insert(messages).values({
        id: mid, accountId, mailboxId, bodyHash: "h", dedupKey: `d-${mid}`,
        nativeLocator: { folder, ref: "1:1" },
        ...(opts.deleted ? { deletedAt: new Date() } : {}),
      });
      if (opts.desired) {
        await db.insert(folderState).values({
          messageId: mid, desiredFolder: opts.desired, observedFolder: folder, lastSetBy: "us",
        });
      }
    };
    await msg("Proj");                                  // counted
    await msg("Proj/Sub");                              // counted
    await msg("Elsewhere", { desired: "Proj/Sub" });    // counted — the RENDERED folder is in the subtree
    await msg("Proj", { desired: "Elsewhere" });        // NOT counted — rendered elsewhere
    await msg("Proj", { deleted: true });               // NOT counted — tombstoned
    const out = await svc.summary(ctx, id);
    expect(out).toEqual({ folders: 2, messages: 3 });
  });
});

describe("idempotency", () => {
  it("a verb's claim rides its own transaction — the stored answer IS the response a replay gets", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const { dto } = await svc.create(ctx, { mailboxId, name: "Einmal" }, {
      idempotency: { key: "idem-1", requestHash: "h1" },
    });
    const [row] = await db.select().from(idempotencyKeys)
      .where(eq(idempotencyKeys.accountId, accountId));
    expect(row).toBeDefined();
    expect(row!.key).toBe("idem-1");
    expect((row!.responseJson as { id: string }).id).toBe(dto.id);
    // The command itself landed exactly once.
    expect(await db.select().from(folderOps).where(eq(folderOps.folderId, dto.id))).toHaveLength(1);
  });
});

describe("the create completion learns where the folder LANDED", () => {
  it("re-spells the commanded row when a namespace server filed it under INBOX", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const { dto } = await svc.create(ctx, { mailboxId, name: "Beweis" });
    const repo = makeDrizzleRepo(db as never);
    const [opRow] = await db.select().from(folderOps).where(eq(folderOps.folderId, dto.id));
    await repo.transaction((r) => r.completeFolderCreate({
      id: opRow!.id, accountId, mailboxId, folder: "Beweis", folderId: dto.id,
    }, "INBOX/Beweis"));
    const row = await userFolderById(db, accountId, dto.id);
    expect(row?.folder).toBe("INBOX/Beweis");
    expect(row?.op).toBeNull();
    const log = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(log.filter((r) => r.entityId === dto.id && r.op === "update")).toHaveLength(1);
  });

  it("defers to the row DISCOVERY already adopted at the landed path — the commanded row retires with a tombstone", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const { dto } = await svc.create(ctx, { mailboxId, name: "Zwei" });
    // Discovery adopted the real path first (the live-measured interleaving).
    const adopted = await addFolder(db, mailboxId, "INBOX/Zwei");
    const repo = makeDrizzleRepo(db as never);
    const [opRow] = await db.select().from(folderOps).where(eq(folderOps.folderId, dto.id));
    await repo.transaction((r) => r.completeFolderCreate({
      id: opRow!.id, accountId, mailboxId, folder: "Zwei", folderId: dto.id,
    }, "INBOX/Zwei"));
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, dto.id))).toHaveLength(0);
    const kept = await userFolderById(db, accountId, adopted);
    expect(kept?.folder).toBe("INBOX/Zwei");
    const log = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(log.filter((r) => r.entityId === dto.id && r.op === "delete")).toHaveLength(1);
    expect(log.filter((r) => r.entityId === adopted && r.op === "update")).toHaveLength(1);
  });
});
