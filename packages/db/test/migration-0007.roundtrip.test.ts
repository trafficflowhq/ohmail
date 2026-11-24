import { describe, it, expect } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { mailboxes, mailboxCredentials } from "../src/index.js";
import { and, eq } from "drizzle-orm";

// Proves migration 0007 persists the envelope-encrypted credential table (RC1)
// and the new mailboxes lifecycle columns — mirror of the schema.roundtrip style.
describe("migration 0007 round-trip", () => {
  const acct = "00000000-0000-0000-0000-0000000000a7";

  it("new mailboxes columns default correctly on insert", async () => {
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: "mila@lichtgrat.example",
    }).returning();
    // Server defaults keep a bare insert valid (additive cutover, no backfill).
    expect(mb!.status).toBe("connected");
    expect(mb!.authKind).toBe("password");
    expect(mb!.displayName).toBeNull();
    expect(mb!.lastSyncAt).toBeNull();
  });

  it("stores BOTH an imap and an smtp credential row for one mailbox (composite PK)", async () => {
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: "mila@lichtgrat.example",
      displayName: "Personal", status: "connected", authKind: "password",
    }).returning();

    await db.insert(mailboxCredentials).values([
      { mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "enc-imap", keyVersion: 1,
        meta: { host: "imap.example", port: 993, secure: true, user: "mila" } },
      { mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp", secretEnc: "enc-smtp", keyVersion: 1,
        meta: { host: "smtp.example", port: 465, secure: true, user: "mila" } },
    ]);

    const rows = await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mb!.id));
    expect(rows).toHaveLength(2);
    const imap = rows.find((r) => r.transport === "imap")!;
    expect(imap.secretEnc).toBe("enc-imap");
    expect(imap.keyVersion).toBe(1);
    expect(imap.meta).toEqual({ host: "imap.example", port: 993, secure: true, user: "mila" });
    expect(rows.find((r) => r.transport === "smtp")!.secretEnc).toBe("enc-smtp");
  });

  it("composite PK (mailbox_id, transport) rejects a duplicate transport row", async () => {
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: "dup@lichtgrat.example",
    }).returning();
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "a", keyVersion: 1,
    });
    await expect(
      db.insert(mailboxCredentials).values({
        mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "b", keyVersion: 1,
      }),
    ).rejects.toThrow();

    // A second row with a DIFFERENT transport for the same mailbox is allowed.
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp", secretEnc: "c", keyVersion: 1,
    });
    const rows = await db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, mb!.id)));
    expect(rows).toHaveLength(2);
  });
});
