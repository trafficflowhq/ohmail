import { accountOfMailbox, accountOfMessage } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { folderState, mailboxFolders, mailboxes, messages } from "@trafficflow/db";
import { MessageService, type ServiceContext } from "../src/index.js";

/**
 * A TRASH PAGE RESOLVES EVERY ROW'S RESTORE TARGET IN ONE READ.
 *
 * `listTrash` asked `mailbox_folders` once per row trashed from a user folder, inside the row
 * loop: a page of fifty such messages cost fifty sequential round trips. The page's distinct
 * (mailbox, folder) pairs are now resolved together, so the page costs the same whatever it holds.
 * The answers stay the rule's: a live folder of THAT mailbox restores to itself, one of the six to
 * itself, anything else — a folder renamed away, another mailbox's or another account's — to INBOX.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }

function counter(db: Db): { on: () => void; off: () => number } {
  const client = (db as unknown as { $client: Doors }).$client;
  let counting = false;
  let n = 0;
  for (const door of ["query", "exec"] as const) {
    const inner = client[door].bind(client);
    client[door] = (...a: unknown[]): Promise<unknown> => {
      if (counting) n += 1;
      return inner(...(a as []));
    };
  }
  return { on: () => { counting = true; n = 0; }, off: () => { counting = false; return n; } };
}

async function world() {
  const db = await makeTestDb();
  const account = randomUUID();
  const stranger = randomUUID();
  const box = async (accountId: string, trashFolder: string | null) => {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${randomUUID().slice(0, 8)}@x.example`, trashFolder,
    }).returning();
    return mb!.id;
  };
  const a = await box(account, "Trash");
  const b = await box(account, "Trash");
  const theirs = await box(stranger, "Trash");
  const folder = (mailboxId: string, name: string) =>
    db.insert(mailboxFolders).values({ mailboxId, accountId: accountOfMailbox(mailboxId), folder: name, uidvalidity: 7n, uidnext: 9n, highestmodseq: 3n });
  await folder(a, "Projects");
  await folder(a, "Clients");
  await folder(b, "Archive");
  await folder(theirs, "Gone"); // another account's folder of that name answers nothing here
  let at = Date.parse("2026-09-26T08:00:00.000Z");
  /** A message sitting in `mailboxId`'s Trash, trashed from `from`. */
  const trashed = async (mailboxId: string, from: string | null): Promise<string> => {
    const [m] = await db.insert(messages).values({
      accountId: account, mailboxId, bodyHash: "h", dedupKey: randomUUID(), subject: "s", fromAddress: "f@x.example",
    }).returning();
    at += 60_000;
    await db.insert(folderState).values({
      messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: "Trash", observedFolder: "Trash", lastSetBy: "us",
      trashedFrom: from, updatedAt: new Date(at),
    });
    return m!.id;
  };
  const ctx: ServiceContext = {
    db, accountId: account, userId: null, now: () => new Date("2026-09-26T12:00:00.000Z"), requestId: "trash",
  };
  return { db, a, b, theirs, trashed, ctx };
}

describe("listTrash resolves its restore targets in one read", () => {
  it("answers each row by the rule", async () => {
    const { a, b, trashed, ctx } = await world();
    const want = new Map<string, string>([
      [await trashed(a, "Projects"), "Projects"],
      [await trashed(a, "Clients"), "Clients"],
      [await trashed(a, "Projects"), "Projects"],
      [await trashed(a, "Archive"), "INBOX"], // b's folder, not a's
      [await trashed(b, "Archive"), "Archive"],
      [await trashed(a, "Gone"), "INBOX"], // only another account has it
      [await trashed(a, "ohmail/News"), "ohmail/News"],
      [await trashed(a, "ohmail/Reads"), "ohmail/News"],
      [await trashed(a, null), "INBOX"],
      [await trashed(a, ""), "INBOX"],
    ]);
    const page = await new MessageService().listTrash(ctx, { view: "trash" });
    expect(page.items).toHaveLength(want.size);
    for (const item of page.items) expect(item.restoreTo, item.id).toBe(want.get(item.id));
  });

  it("the reader answers only from this account's mailboxes, even when handed another's", async () => {
    // Unreachable through listTrash and restore, whose rows are already this account's: the
    // reader's own predicate is what a future caller handing it rows would lean on.
    const { theirs, ctx } = await world();
    type Reader = { restoreTargets: (c: ServiceContext, r: { mailboxId: string; trashedFrom: string }[]) => Promise<(m: string, f: string) => string> };
    const read = await (new MessageService() as unknown as Reader).restoreTargets(ctx, [{ mailboxId: theirs, trashedFrom: "Gone" }]);
    expect(read(theirs, "Gone"), "another account's folder answered this account's restore").toBe("INBOX");
  });

  it("a page of many user-folder rows costs what a page of one does", async () => {
    const one = await world();
    await one.trashed(one.a, "Projects");
    const many = await world();
    for (const from of ["Projects", "Clients", "Projects", "Archive", "Gone", "Clients"]) await many.trashed(many.a, from);
    await many.trashed(many.b, "Archive");

    const count = async (w: Awaited<ReturnType<typeof world>>): Promise<number> => {
      const probe = counter(w.db);
      probe.on();
      await new MessageService().listTrash(w.ctx, { view: "trash" });
      return probe.off();
    };
    const single = await count(one);
    const seven = await count(many);
    expect(seven, `a seven-row page asked ${seven - single} more statements than a one-row page`).toBe(single);
  });

  it("a page with no user-folder origin asks nothing for its targets", async () => {
    const withTarget = await world();
    await withTarget.trashed(withTarget.a, "Projects");
    const without = await world();
    await without.trashed(without.a, "ohmail/News");
    const count = async (w: Awaited<ReturnType<typeof world>>): Promise<number> => {
      const probe = counter(w.db);
      probe.on();
      await new MessageService().listTrash(w.ctx, { view: "trash" });
      return probe.off();
    };
    expect(await count(without), "the targets' read ran with nothing to resolve").toBe((await count(withTarget)) - 1);
  });
});
