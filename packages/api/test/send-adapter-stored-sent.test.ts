import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import { makeSendAdapter } from "../src/send-adapter.js";
import { makeDeps } from "./helpers.js";

/**
 * THE SEND FILES ITS COPY WHERE THE SYNC READS SENT. The API's send adapter is its own dial, so it
 * must hand the adapter the Sent folder the sync's last attach recorded (`mailboxes.sent_folder`);
 * without it the send decides alone and, where two folder names contest Sent, can file into a
 * folder the scan does not watch. Mutation watched red (2026-10-02): dropping `storedFolders` from
 * the config reddens the first case.
 */
async function seeded(sentFolder: string | null) {
  const d = await makeDeps();
  const [acct] = await d.db.insert(accounts).values({ name: "stored-sent" }).returning();
  const [mb] = await d.db.insert(mailboxes).values({
    accountId: acct!.id, provider: "imap", address: "u@stored.example",
  }).returning();
  const enc = await d.deps.keyProvider.encrypt("imap-pass");
  await d.db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "imap.stored.example", port: 993, secure: true, user: "u@stored.example" },
  });
  if (sentFolder !== null) {
    await d.db.update(mailboxes).set({ sentFolder }).where(eq(mailboxes.id, mb!.id));
  }
  const built: ImapConfig[] = [];
  const newAdapter = ((cfg: ImapConfig) => {
    built.push(cfg);
    return { connect: async (): Promise<void> => undefined, close: async (): Promise<void> => undefined };
  }) as never;
  await makeSendAdapter(d.deps, mb!.id, {}, newAdapter);
  return built;
}

describe("makeSendAdapter — the stored Sent folder reaches the adapter", () => {
  it("hands over the folder the last attach recorded", async () => {
    const built = await seeded("Gesendete Elemente");
    expect(built.map((c) => c.storedFolders)).toEqual([{ sent: "Gesendete Elemente" }]);
  });

  it("a mailbox no attach has decided for hands over null — the adapter decides by flag and name", async () => {
    const built = await seeded(null);
    expect(built.map((c) => c.storedFolders)).toEqual([{ sent: null }]);
  });
});
