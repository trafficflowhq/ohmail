import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxCredentials, mailboxes, UNMETERED_ACCESS } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * DOES OHMAIL READ THIS MAILBOX'S PROVIDER'S WORD ON WHO SENT A MESSAGE — `MailboxDTO.providerConfirms`,
 * off the IMAP host its credential row records, by the one map ingest and the unsubscribe read
 * (`providerAuthservIds`). Where no mailbox's provider is read, a screen-out unsubscribes nobody by
 * itself, and the clients say no such request before the press. A row with no recorded host cannot
 * say, and says nothing.
 */

const NOW = new Date("2026-10-18T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP, accessOf: async () => UNMETERED_ACCESS, signatureChecks: false });

async function fourMailboxes() {
  const db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "provider confirms" }).returning();
  const accountId = a!.id;
  const add = async (address: string, host: string | null): Promise<string> => {
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address }).returning();
    if (host !== null) {
      const enc = await KP.encrypt("password-password");
      await db.insert(mailboxCredentials).values({
        mailboxId: mb!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
        meta: { host, port: 993, secure: true, user: address },
      });
    }
    return mb!.id;
  };
  const gmail = await add("one@gmail.example", "imap.gmail.com");
  const microsoft = await add("two@outlook.example", "outlook.office365.com");
  const other = await add("three@infomaniak.example", "mail.infomaniak.com");
  const unknown = await add("four@nowhere.example", null);
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
  return { ctx, gmail, microsoft, other, unknown };
}

describe("MailboxDTO.providerConfirms", () => {
  it("true at a provider whose authserv-id is known, false at any other, absent with no recorded host", async () => {
    const { ctx, gmail, microsoft, other, unknown } = await fourMailboxes();
    const rows = new Map((await svc.list(ctx)).map((m) => [m.id, m]));
    expect(rows.get(gmail)!.providerConfirms).toBe(true);
    expect(rows.get(microsoft)!.providerConfirms).toBe(true);
    expect(rows.get(other)!.providerConfirms).toBe(false);
    expect("providerConfirms" in rows.get(unknown)!, "a row that cannot say claims nothing").toBe(false);
  });

  /* A deployment that checks a sender's own signature at ingest confirms senders at every mailbox
     with a recorded host: the screen-out's unsubscribe can be sent there, so the disclosure says so. */
  it("true at every recorded host where this deployment checks signatures, absent with none", async () => {
    const { ctx, gmail, microsoft, other, unknown } = await fourMailboxes();
    const checking = makeMailboxService({ keyProvider: KP, accessOf: async () => UNMETERED_ACCESS, signatureChecks: true });
    const rows = new Map((await checking.list(ctx)).map((m) => [m.id, m]));
    expect(rows.get(gmail)!.providerConfirms).toBe(true);
    expect(rows.get(microsoft)!.providerConfirms).toBe(true);
    expect(rows.get(other)!.providerConfirms, "an unmapped host where signatures are checked").toBe(true);
    expect("providerConfirms" in rows.get(unknown)!).toBe(false);
  });
});
