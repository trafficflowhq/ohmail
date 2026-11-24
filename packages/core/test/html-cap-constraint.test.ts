import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, messageBodies } from "@trafficflow/db";
import { STORED_HTML_CAP_BYTES, prepareHtmlForStorage } from "../src/html-storage.js";

/**
 * Migration `0022_message_body_html_cap` — the 256 KiB ceiling on one stored html body.
 *
 * The tripwire for the 2026-08-01 storage outage, where mailparser's default `cid:` →
 * `data:…;base64,…` rewriting stored 372 MB of ATTACHMENT bytes in this column and filled a
 * 512 MB database from one mailbox. Two other tests prove the constraint EXISTS
 * (the health route's test, via `SCHEMA_CHECK_MARKERS`) and that its literal has not
 * moved (`packages/core/test/html-storage.test.ts`, and the catalog diff in
 * `journal-split.pg.test.ts`). This one proves it BITES — that the database actually refuses
 * the write, rather than carrying a constraint nobody has watched reject anything.
 */
describe("migration 0022 round-trip (message_bodies html cap)", () => {
  const acct = "00000000-0000-0000-0000-0000000022a0";

  async function seedMessage(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: `g+${crypto.randomUUID()}@x-ch.example`,
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId: acct, mailboxId: mb!.id, bodyHash: "h", dedupKey: `k:${crypto.randomUUID()}`,
    }).returning();
    return m!.id;
  }

  it("REJECTS an html body over the cap — the constraint is not decoration", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const tooBig = "x".repeat(STORED_HTML_CAP_BYTES + 1);
    await expect(
      db.insert(messageBodies).values({ messageId, accountId: acct, text: "t", html: tooBig }),
    ).rejects.toThrow(/message_bodies_html_cap|violates check constraint/i);
  });

  it("measures BYTES, not characters — the multibyte body a char cap would wave through", async () => {
    // An emoji is four UTF-8 bytes but only two `.length` units. A cap expressed in
    // characters would admit it; `octet_length` does not.
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const emoji = "😀".repeat(100_000);
    expect(emoji.length).toBeLessThan(STORED_HTML_CAP_BYTES);
    await expect(
      db.insert(messageBodies).values({ messageId, accountId: acct, text: "t", html: emoji }),
    ).rejects.toThrow(/message_bodies_html_cap|violates check constraint/i);
  });

  it("ACCEPTS a body exactly at the cap — the boundary is inclusive, as <= says", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const exact = "x".repeat(STORED_HTML_CAP_BYTES);
    const [row] = await db.insert(messageBodies)
      .values({ messageId, accountId: acct, text: "t", html: exact }).returning();
    expect(row!.html!.length).toBe(STORED_HTML_CAP_BYTES);
  });

  it("ACCEPTS null — no html, and sensitive mail whose html is never stored", async () => {
    const db = await makeTestDb();
    const messageId = await seedMessage(db);
    const [row] = await db.insert(messageBodies)
      .values({ messageId, accountId: acct, text: "redacted", html: null }).returning();
    expect(row!.html).toBeNull();
  });

  it("whatever prepareHtmlForStorage returns is ACCEPTED — the code satisfies the constraint", async () => {
    // The reconciliation, executed rather than asserted on paper: the writer's output must be
    // storable by definition, or the tripwire fires on correct code and quarantines a mailbox.
    const db = await makeTestDb();
    const monsters = [
      `<img src="data:image/png;base64,${"A".repeat(2_000_000)}">`,   // the outage's shape
      "<p>" + "x".repeat(STORED_HTML_CAP_BYTES * 2) + "</p>",         // genuinely huge text
      "😀".repeat(200_000),                                           // multibyte over the cap
    ];
    for (const raw of monsters) {
      const messageId = await seedMessage(db);
      const prepared = prepareHtmlForStorage(raw);
      const [row] = await db.insert(messageBodies)
        .values({ messageId, accountId: acct, text: "t", html: prepared }).returning();
      expect(Buffer.byteLength(row!.html!, "utf8")).toBeLessThanOrEqual(STORED_HTML_CAP_BYTES);
    }
  });
});
