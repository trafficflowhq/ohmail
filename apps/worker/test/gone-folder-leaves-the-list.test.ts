import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts, changeLog, folderOps, mailboxFolders, mailboxes, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapBoundExceeded, type ChangeBatch, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";

/**
 * A FOLDER THE SERVER STATED GONE LEAVES THE FOLDER LIST — the worker half of that change.
 *
 * The rows of `mailbox_folders` are the folder list every client draws, and nothing retired one:
 * a folder deleted elsewhere stayed listed, and an empty one was never even asked about. The
 * cycle now drops the row and writes the folder `delete` the delta carries. A dead epoch's
 * residue in that folder is forgotten too, so its message is reaped rather than kept alive by a
 * copy the server does not have. Controls: a command of the user's keeps its row; a pass that
 * stopped on an overrun retires nothing; a folder still remembered and not stated gone stays.
 */

async function seeded() {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "gone-folder-leaves-the-list" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `t-${accountId.slice(0, 8)}@example.test` }).returning();
  const mailboxId = mb!.id;
  const row = async (folder: string, uidvalidity: bigint) => (await db.insert(mailboxFolders)
    .values({ mailboxId, accountId, folder, uidvalidity, uidnext: 9n, highestmodseq: 1n }).returning())[0]!.id;
  const ids = { clients: await row("Clients", 3n), projects: await row("Projects", 7n), kept: await row("Kept", 4n) };
  // A letter whose only instance is RESIDUE: Projects at epoch 6, a reset the row (epoch 7) is past.
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: "residue@example.test", bodyHash: "residue", dedupKey: "mid:<residue@example.test>",
    subject: "left behind", fromAddress: "anna@example.test", nativeLocator: { folder: "Projects", ref: "6:1" },
  }).returning();
  await db.insert(messageInstances).values({
    accountId, mailboxId, messageId: m!.id, folder: "Projects", uidvalidity: 6n, uid: 1, isPrimary: true,
  });
  const folders = async () => (await db.select({ f: mailboxFolders.folder }).from(mailboxFolders)
    .where(eq(mailboxFolders.mailboxId, mailboxId))).map((r) => r.f).sort();
  const folderDeletes = async () => (await db.select({ id: changeLog.entityId, type: changeLog.entityType, op: changeLog.op })
    .from(changeLog).where(eq(changeLog.accountId, accountId)))
    .filter((r) => r.type === "folder" && r.op === "delete").map((r) => r.id).sort();
  const residue = async () => (await db.select({ id: messageInstances.id }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, mailboxId), eq(messageInstances.folder, "Projects")))).length;
  const reaped = async () => (await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, m!.id)))[0]!.d !== null;
  return { db, accountId, mailboxId, ids, repo: makeDrizzleRepo(db), folders, folderDeletes, residue, reaped };
}

const adapterOf = (batch: ChangeBatch): MailboxAdapter => ({ changesSince: async () => batch }) as unknown as MailboxAdapter;
const goneBatch = (extra: Partial<ChangeBatch> = {}): ChangeBatch => ({
  creates: [], moves: [], flagChanges: [], deletes: [], hasBacklog: false, foldersGone: ["Clients", "Projects"],
  newCursor: { folders: { Clients: { uidValidity: "3", uidNext: 9, highestModseq: "1" }, Projects: { uidValidity: "7", uidNext: 9, highestModseq: "1" } } },
  ...extra,
});
const quietBatch = (): ChangeBatch => ({
  creates: [], moves: [], flagChanges: [], deletes: [], hasBacklog: false, unchanged: true, newCursor: { folders: {} },
});

const cycle = (repo: WorkerRepo, adapter: MailboxAdapter, s: { accountId: string; mailboxId: string }) => runSyncCycle({
  repo, adapter, accountId: s.accountId, mailboxId: s.mailboxId, role: "reader",
  writeAuthority: { noLease: "reader" as const }, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
});

describe("a folder the server stated gone", () => {
  it("leaves the folder list: the row goes, the delta carries the delete, its residue is reaped", async () => {
    const s = await seeded();
    const adapter = adapterOf(goneBatch());
    await cycle(s.repo, adapter, s);
    expect(await s.folders(), "a folder the server does not have kept its row").toEqual(["Kept"]);
    expect(await s.folderDeletes(), "no folder delete reached the delta").toEqual([s.ids.clients, s.ids.projects].sort());
    expect(await s.residue(), "a dead epoch's copy outlived the folder's own statement").toBe(0);
    // The reaper ran before the retirement in that cycle; the next one owes it, even unchanged.
    (adapter as unknown as { changesSince: () => Promise<ChangeBatch> }).changesSince = async () => quietBatch();
    await cycle(s.repo, adapter, s);
    expect(await s.reaped(), "a letter whose only copy was in the gone folder is still live").toBe(true);
  });

  it("keeps a row a user's command owns, and retires the other", async () => {
    const s = await seeded();
    await s.db.insert(folderOps).values({
      accountId: s.accountId, mailboxId: s.mailboxId, folderId: s.ids.clients, op: "rename", toFolder: "Clients2",
    });
    await cycle(s.repo, adapterOf(goneBatch()), s);
    expect(await s.folders(), "a folder with a command in flight was retired under it").toEqual(["Clients", "Kept"]);
    expect(await s.folderDeletes()).toEqual([s.ids.projects]);
    const [op] = await s.db.select({ id: folderOps.id }).from(folderOps).where(eq(folderOps.folderId, s.ids.clients));
    expect(op, "the command was cascaded away").toBeDefined();
  });

  it("is not retired on a pass that stopped on an overrun", async () => {
    const s = await seeded();
    // The one overrun a cycle survives to its end: a message's own bytes, set aside and rethrown.
    const breach = new ImapBoundExceeded("body_overrun", 1_000, 2_000_000, "Kept", { uidValidity: "4", uid: 3 });
    const run = cycle(s.repo, adapterOf(goneBatch({
      overrun: { folder: "Kept", uidValidity: "4", uid: 3, breach },
    })), s);
    await expect(run).rejects.toBe(breach);
    expect(await s.folders(), "a pass that kept something back retired a folder").toEqual(["Clients", "Kept", "Projects"]);
    expect(await s.folderDeletes()).toEqual([]);
  });

  it("a folder the server lists with no row yet joins the list through the delta, once", async () => {
    const s = await seeded();
    const fresh = (): ChangeBatch => ({
      creates: [], moves: [], flagChanges: [], deletes: [], hasBacklog: false,
      newCursor: { folders: {
        Fresh: { uidValidity: "5", uidNext: 1, highestModseq: "1" }, Kept: { uidValidity: "4", uidNext: 10, highestModseq: "2" },
        // New rows too, and none is a folder of the user's: the Imbox, Sent, the ohmail namespace.
        INBOX: { uidValidity: "2", uidNext: 1, highestModseq: "1" }, Sent: { uidValidity: "8", uidNext: 1, highestModseq: "1" },
        "ohmail/News": { uidValidity: "9", uidNext: 1, highestModseq: "1" },
      } },
    });
    await cycle(s.repo, adapterOf(fresh()), s);
    const creates = async () => (await s.db.select({ id: changeLog.entityId, type: changeLog.entityType, op: changeLog.op })
      .from(changeLog).where(eq(changeLog.accountId, s.accountId)))
      .filter((r) => r.type === "folder" && r.op === "create").map((r) => r.id);
    const [row] = await s.db.select({ id: mailboxFolders.id }).from(mailboxFolders)
      .where(and(eq(mailboxFolders.mailboxId, s.mailboxId), eq(mailboxFolders.folder, "Fresh")));
    expect(await creates(), "a folder new to the store reached no client, or an excluded one did").toEqual([row!.id]);
    // The same folder's cursor moving again is not a second arrival; an existing row never was one.
    const again = fresh();
    again.newCursor.folders.Fresh = { uidValidity: "5", uidNext: 3, highestModseq: "4" };
    await cycle(s.repo, adapterOf(again), s);
    expect(await creates()).toEqual([row!.id]);
  });

  it("positive control: a pass that states nothing gone retires nothing", async () => {
    const s = await seeded();
    await cycle(s.repo, adapterOf(goneBatch({ foldersGone: undefined })), s);
    expect(await s.folders()).toEqual(["Clients", "Kept", "Projects"]);
    expect(await s.folderDeletes()).toEqual([]);
    expect(await s.residue()).toBe(1);
  });
});
