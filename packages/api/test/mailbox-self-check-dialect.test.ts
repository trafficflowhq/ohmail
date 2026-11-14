import { accountOfMailbox } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { mailboxCredentials, mailboxFolders, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { selfCheckMailbox } from "../src/mailbox-self-check.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * The self-check's store read, on whichever store this project runs — the phone's engine reads
 * the same two tables through its own binder. An epoch above 2^31 (the protocol's ceiling) is
 * the value a double or a 32-bit column would lose, and the grouped count is the statement the two
 * stores spell by their own casts. The admission port is the local one, as on the phone.
 */
const EPOCH = "4294967295";

async function world(held: Record<string, number>, epoch = EPOCH) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `rd-${randomUUID().slice(0, 8)}@example.invalid`,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  for (const [folder, n] of Object.entries(held)) {
    await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), folder, uidvalidity: BigInt(epoch) });
    for (let uid = 1; uid <= n; uid++) {
      const key = `${folder}-${uid}-${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, messageIdHeader: key, bodyHash: key, dedupKey: key,
        subject: "s", fromAddress: "a@example.invalid", snippet: "",
      }).returning({ id: messages.id });
      await db.insert(messageInstances).values({
        accountId, mailboxId: mb!.id, messageId: m!.id, folder, uidvalidity: BigInt(epoch), uid,
      });
    }
  }
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: async () => true, release: async () => {} } },
    now: () => new Date("2026-09-27T06:00:00.000Z"),
  } as unknown as ApiDeps;
  return { deps, accountId, mailboxId: mb!.id };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
});

describe("the self-check's store read, on this project's store", () => {
  it("counts instances by folder under a 64-bit epoch, and compares them with the server's", async () => {
    const w = await world({ INBOX: 3, Archive: 2 });
    vi.spyOn(ImapAdapter.prototype, "folderStatus").mockImplementation(async (folder) =>
      ({ k: "status", messages: folder === "INBOX" ? 3 : 4, uidValidity: EPOCH, uidNext: 9 }));
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId);
    expect(r.folders).toEqual([
      { folder: "INBOX", k: "in_step", server: 3, mirror: 3 },
      { folder: "Archive", k: "server_more", server: 4, mirror: 2 },
    ]);
  });

  it("the recorded epoch survives the store whole: one digit off reads as a renumbered folder", async () => {
    const w = await world({ INBOX: 1 });
    vi.spyOn(ImapAdapter.prototype, "folderStatus").mockResolvedValue({ k: "status", messages: 1, uidValidity: "4294967294", uidNext: 2 });
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId);
    expect(r.folders).toEqual([{ folder: "INBOX", k: "uidvalidity_changed", server: 1, mirror: 1 }]);
  });
});
