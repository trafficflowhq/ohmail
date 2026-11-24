import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, folderOps, mailboxFolders, mailboxes, resolveFolderDestination, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { userFolderExclusion } from "@trafficflow/core/adapters/imap-types";

/**
 * WHERE A MOVE INTO A PERSON'S OWN FOLDER MAY GO, on whichever store this run opened (the phone and the
 * desktop organize over the device store; this file is registered in the SQLite project by name), with
 * the exclusion rule both callers hand in. Every refused class is planted WITH an inventory row, so it is
 * the check that refuses it and not the row's absence.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function world(db: Db, o: { sent?: string; trash?: string; junk?: string } = {}) {
  const [a] = await db.insert(accounts).values({ name: `dest-${randomUUID().slice(0, 8)}` }).returning();
  const box = async (accountId: string) => (await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `dest-${randomUUID().slice(0, 8)}@x.test`,
    status: "connected", organizerRole: "organizer",
    sentFolder: o.sent ?? null, trashFolder: o.trash ?? null, junkFolder: o.junk ?? null,
  }).returning())[0]!.id;
  const mailboxId = await box(a!.id);
  const list = async (folder: string, mb = mailboxId, acct = a!.id) =>
    (await db.insert(mailboxFolders).values({ mailboxId: mb, accountId: acct, folder }).returning())[0]!.id;
  const ask = (name: unknown, mb = mailboxId, acct = a!.id) =>
    db.transaction((tx) => resolveFolderDestination(tx as unknown as Tx, { accountId: acct, mailboxId: mb }, name, userFolderExclusion));
  return { accountId: a!.id, mailboxId, box, list, ask };
}

describe("a person's own folder of the letter's mailbox is a destination, by its exact name", () => {
  it("answers the store's own row", async () => {
    const w = await world(await makeTestDb());
    await w.list("Projects/2026/Q3");
    expect(await w.ask("Projects/2026/Q3")).toEqual({ ok: true, folder: "Projects/2026/Q3" });
  });

  it("a name spelt any other way finds nothing: case, composition, a space or slash, the server's delimiter, its encoding", async () => {
    const w = await world(await makeTestDb());
    await w.list("Projects/Café");
    const misses = [
      "projects/café", "PROJECTS/CAFÉ", "Projects/Café", "Projects/Café ", " Projects/Café", "Projects/Café/",
      "Projects.Café", "Projects/Caf&AOk-",
    ];
    for (const name of misses) expect(await w.ask(name), name).toEqual({ ok: false, refusal: "absent" });
    expect(await w.ask("Projects/Café")).toEqual({ ok: true, folder: "Projects/Café" });
  });

  it("a folder of another mailbox, or of another account, is absent here", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const other = await w.box(w.accountId);
    await w.list("Elsewhere", other);
    expect(await w.ask("Elsewhere")).toEqual({ ok: false, refusal: "absent" });
    const stranger = await world(db);
    await stranger.list("Theirs");
    expect(await w.ask("Theirs")).toEqual({ ok: false, refusal: "absent" });
    // My account with their mailbox id resolves nothing either.
    expect(await w.ask("Theirs", stranger.mailboxId)).toEqual({ ok: false, refusal: "absent" });
  });

  it("a name that cannot be a name is unusable before anything is read", async () => {
    const w = await world(await makeTestDb());
    for (const name of [undefined, 3, "", "a\u0000b", "x".repeat(1001), "\udc00"]) {
      expect(await w.ask(name), String(name)).toEqual({ ok: false, refusal: "unusable" });
    }
  });
});

describe("what is not the person's own folder is reserved, even when the mailbox lists it", () => {
  it("the Imbox in any case, ohmail's six and its whole tree, Sent, and Trash or Junk and what lies under them", async () => {
    const w = await world(await makeTestDb(), { sent: "Sent Items", trash: "Deleted", junk: "Spam" });
    const reserved = [
      "INBOX", "Inbox", "inbox",
      "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
      "ohmail/_meta", "Archive/ohmail/x", "OHMAIL/Notes",
      "Sent Items", "Sent", "INBOX/Sent", "[Gmail]/Sent Mail",
      "Deleted", "Deleted/Old", "Spam", "Spam/2025",
    ];
    for (const name of reserved) {
      await w.list(name);
      expect(await w.ask(name), name).toEqual({ ok: false, refusal: "reserved" });
    }
    // The neighbours of those names are the person's own.
    for (const name of ["Deleted Things", "Spammy", "INBOX/Projects", "Sent-ish/x"]) {
      await w.list(name);
      expect(await w.ask(name), name).toEqual({ ok: true, folder: name });
    }
  });
});

describe("a folder a command stands on is busy until the command settles", () => {
  it("a create, rename or delete on it, above it or below it, pending or failed, or a rename into it", async () => {
    const db = await makeTestDb();
    const cases: Array<{ label: string; target: string; on: string; op: "create" | "rename" | "delete"; to?: string; failed?: true }> = [
      { label: "itself, a pending delete", target: "A", on: "A", op: "delete" },
      { label: "itself, a pending create", target: "A", on: "A", op: "create" },
      { label: "itself, a failed rename", target: "A", on: "A", op: "rename", to: "Z", failed: true },
      { label: "a folder above it", target: "A/B", on: "A", op: "delete" },
      { label: "a folder below it", target: "A", on: "A/B/C", op: "create" },
      { label: "a rename into it", target: "A/B", on: "Other", op: "rename", to: "A/B" },
    ];
    for (const c of cases) {
      const w = await world(db);
      const targetId = await w.list(c.target);
      const folderId = c.on === c.target ? targetId : await w.list(c.on);
      await db.insert(folderOps).values({
        accountId: w.accountId, mailboxId: w.mailboxId, folderId,
        op: c.op, toFolder: c.op === "rename" ? c.to! : null, status: c.failed ? "failed" : "pending",
      });
      expect(await w.ask(c.target), c.label).toEqual({ ok: false, refusal: "busy" });
    }
  });

  it("a command on a sibling, or on a name that only starts the same, leaves it free", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await w.list("Proj");
    await w.list("Projects");
    const sibling = await w.list("Projects-old");
    await db.insert(folderOps).values({ accountId: w.accountId, mailboxId: w.mailboxId, folderId: sibling, op: "delete", toFolder: null });
    expect(await w.ask("Projects")).toEqual({ ok: true, folder: "Projects" });
    expect(await w.ask("Proj")).toEqual({ ok: true, folder: "Proj" });
  });
});
