import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo, recipientsOfOwnWriting } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, accountSettings, mailboxFolders, mailboxes, messageInstances, messages, type Tx } from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE OWN-SENT TWIN ADOPTS ONLY THE ACCOUNT'S OWN ROW — through a real sync cycle on the in-process
 * store (PGlite here, the device's SQLite in the `sqlite` project). A Sent copy whose bytes differ
 * from a stored row joins it by Message-ID only when that row already has an instance in the
 * mailbox's Sent folder. An INBOX row under the same id may be a stranger's: adopting it gave their
 * message a Sent instance, and their To and Cc then read as people this account wrote to.
 */
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");

function mail(o: { id: string; from: string; to: string; body: string }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.id}>`, `From: ${o.from}`, `To: ${o.to}`, "Subject: the north elevation",
    "Content-Type: text/plain; charset=utf-8", "", o.body,
  ].join("\r\n"));
}

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `t026-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT }).returning();
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: mb!.accountId, folder: "Sent", uidvalidity: 1n, uidnext: 100n });
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } },
  );
  type Entry = { from: string; subject: string; messageId: string; raw: Buffer; folder?: string; ownAuthored?: boolean; internalDate?: Date };
  const queue: Entry[] = [];
  const deliver = async (e: Omit<Entry, "from" | "subject">) => {
    queue.push({ from: "-", subject: "-", ...e });
    fleet.behave(mb!.id, { deliver: [...queue] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
  };
  const rowsOf = async (messageIdHeader: string) => db.select({ id: messages.id, from: messages.fromAddress })
    .from(messages).where(and(eq(messages.accountId, accountId), eq(messages.messageIdHeader, messageIdHeader)));
  const foldersOf = async (messageId: string) => (await db.select({ folder: messageInstances.folder })
    .from(messageInstances).where(eq(messageInstances.messageId, messageId))).map((r) => r.folder).sort();
  return { db, accountId, me, deliver, rowsOf, foldersOf };
}

describe("the own-sent twin, through a sync cycle", () => {
  it("a stranger's INBOX row under our Sent copy's Message-ID is never adopted: the copy is its own row", async () => {
    const w = await world();
    // The stranger delivers first, under the id our copy will carry, addressed to an accomplice.
    await w.deliver({ messageId: "x-1@own.invalid", raw: mail({
      id: "x-1@own.invalid", from: "mallory@evil.invalid", to: `${w.me}, accomplice@evil.invalid`, body: "their bytes",
    }) });
    await w.deliver({
      messageId: "x-1@own.invalid", folder: "Sent", ownAuthored: true, internalDate: WROTE,
      raw: mail({ id: "x-1@own.invalid", from: w.me, to: "anna@corr.invalid", body: "our bytes" }),
    });
    const rows = await w.rowsOf("x-1@own.invalid");
    expect(rows, "the Sent copy is its own row").toHaveLength(2);
    const theirs = rows.find((r) => r.from === "mallory@evil.invalid")!;
    expect(await w.foldersOf(theirs.id), "the stranger's row was given no Sent instance").toEqual(["INBOX"]);
    const wrote = await recipientsOfOwnWriting(w.db, w.accountId);
    expect(wrote.has("anna@corr.invalid"), "the copy's own recipient").toBe(true);
    expect(wrote.has("accomplice@evil.invalid"), "the stranger's To is nobody this account wrote to").toBe(false);
  });

  it("CONTROL: the provider's re-rendered Sent twin of our own copy joins it — one row", async () => {
    const w = await world();
    await w.deliver({
      messageId: "y-1@own.invalid", folder: "Sent", ownAuthored: true, internalDate: WROTE,
      raw: mail({ id: "y-1@own.invalid", from: w.me, to: "anna@corr.invalid", body: "Thursday works, and I will bring the drawings." }),
    });
    await w.deliver({
      messageId: "y-1@own.invalid", folder: "Sent", ownAuthored: true, internalDate: WROTE,
      raw: mail({ id: "y-1@own.invalid", from: w.me, to: "anna@corr.invalid", body: "Thursday works,\r\nand I will bring the drawings." }),
    });
    const rows = await w.rowsOf("y-1@own.invalid");
    expect(rows, "two Sent copies of one submission are one row").toHaveLength(1);
    expect((await w.foldersOf(rows[0]!.id)).every((f) => f === "Sent")).toBe(true);
  });
});
