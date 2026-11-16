import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, attachments, mailboxes, messages } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { createLogger, type Logger, type MimeStructure } from "@trafficflow/core/mail";
import { readerFor, repairedPart, type AttachmentAdapter, type RepairRow } from "../src/attachments-service.js";
import { dbFor, type Db, type ServiceContext } from "../src/context.js";

/**
 * THE REPAIR'S WRITE, ON REAL POSTGRES. The write is a compare-and-set on the section the request
 * read, so two repairs of one row converge on one verified value and a repair whose read went
 * stale writes nothing. PGlite has one connection and cannot interleave two writers; this file
 * holds two repairs at a barrier so both reach the UPDATE together. Scoped to its own accounts.
 */
const AVAILABLE = await realPgAvailable();

const RIGHT = new Uint8Array(Buffer.from("the pdf the row describes"));
const WRONG = new Uint8Array(Buffer.from("another part of the message"));
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const leaf = (type: string, name: string): MimeStructure => ({
  type, encoding: "base64", params: { name }, id: null, disposition: { type: "attachment", params: { filename: name } }, size: null, children: [],
});
const multi = (children: MimeStructure[]): MimeStructure =>
  ({ type: "multipart/mixed", encoding: null, params: { boundary: "b" }, id: null, disposition: null, size: null, children });
/** The pdf lives at 2.1; 3.9.18 stored it as 2.2.1. */
const TREE = multi([multi([leaf("text/plain", "t.txt")]), multi([leaf("application/pdf", "a.pdf"), leaf("application/zip", "b.zip")])]);

function capture(): { log: Logger; lines: () => Array<Record<string, unknown>> } {
  const raw: string[] = [];
  return { log: createLogger({ service: "attachments", sink: (l) => { raw.push(l); } }), lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** Resolves for every caller once `n` have arrived: both repairs reach their write together. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => { release = r; });
  return async () => { arrived += 1; if (arrived === n) release(); await all; };
}

/** A fake door whose download of 2.1 waits at `meet` before answering. */
function door(meet?: () => Promise<void>): AttachmentAdapter {
  return {
    fetchPart: async (_l, partId) => {
      if (partId === "2.1" && meet) await meet();
      return { contentType: "application/pdf", filename: null, body: partId === "2.1" ? RIGHT : WRONG };
    },
    fetchStructure: async () => TREE,
    close: async () => { /* nothing */ },
  };
}

describe.skipIf(!AVAILABLE)("the repair's compare-and-set on real Postgres", () => {
  let db: Db;
  // The factory's handle: the binder takes a server handle only from the factory that registered its door.
  let owned: OwnedDb | undefined;
  const seededAccounts: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 120_000);

  afterAll(async () => {
    if (seededAccounts.length > 0) {
      await db.delete(attachments).where(inArray(attachments.accountId, seededAccounts));
      await db.delete(messages).where(inArray(messages.accountId, seededAccounts));
      await db.delete(mailboxes).where(inArray(mailboxes.accountId, seededAccounts));
      await db.delete(accounts).where(inArray(accounts.id, seededAccounts));
    }
    await owned?.close();
  });

  async function seeded(partId: string | null): Promise<{ ctx: ServiceContext; row: RepairRow; stored: () => Promise<string | null> }> {
    const accountId = randomUUID();
    seededAccounts.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `repair-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `repair-${accountId.slice(0, 8)}@example.test` }).returning();
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `repair:${randomUUID()}`, subject: "s",
      fromAddress: "sender@example.test", nativeLocator: { folder: "INBOX", ref: "1:7" },
    }).returning();
    const [a] = await db.insert(attachments).values({
      accountId, messageId: m!.id, filename: "a.pdf", contentType: "application/pdf", sizeBytes: RIGHT.byteLength,
      inline: false, partId, contentSha256: sha(RIGHT),
    }).returning();
    const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => new Date(), requestId: "repair-pg" };
    const row: RepairRow = { id: a!.id, partId, contentSha256: sha(RIGHT), contentType: "application/pdf", filename: "a.pdf" };
    const stored = async () => (await db.select({ p: attachments.partId }).from(attachments).where(eq(attachments.id, a!.id)))[0]!.p;
    return { ctx, row, stored };
  }

  it("two concurrent repairs of one row both serve the file, and exactly one write lands", async () => {
    const { ctx, row, stored } = await seeded("2.2.1");
    const meet = barrier(2);
    const [c1, c2] = [capture(), capture()];
    const served = await Promise.all([
      repairedPart(row, readerFor(door(meet), { folder: "INBOX", ref: "1:7" }), ctx, { log: c1.log }),
      repairedPart(row, readerFor(door(meet), { folder: "INBOX", ref: "1:7" }), { ...ctx }, { log: c2.log }),
    ]);

    expect(served.map((f) => sha(f.body))).toEqual([sha(RIGHT), sha(RIGHT)]);
    expect([...c1.lines(), ...c2.lines()].map((l) => l.healed).sort()).toEqual([false, true]);
    expect(await stored()).toBe("2.1");
  });

  it("a repair whose read went stale — the section moved underneath — serves the file and writes nothing", async () => {
    const { ctx, row, stored } = await seeded("9.9");
    const c = capture();

    const got = await repairedPart({ ...row, partId: "2.2.1" }, readerFor(door(), { folder: "INBOX", ref: "1:7" }), ctx, { log: c.log });

    expect(sha(got.body)).toBe(sha(RIGHT));
    expect(c.lines()[0]).toMatchObject({ event: "attachment_part_repaired", healed: false });
    expect(await stored()).toBe("9.9");
  });

  it("a null read writes over a null, and a stale null read does not write over a section", async () => {
    const fresh = await seeded(null);
    const c1 = capture();
    await repairedPart(fresh.row, readerFor(door(), { folder: "INBOX", ref: "1:7" }), fresh.ctx, { log: c1.log });
    expect([c1.lines()[0]?.healed, await fresh.stored()]).toEqual([true, "2.1"]);

    const moved = await seeded("2.1");
    const c2 = capture();
    await repairedPart({ ...moved.row, partId: null }, readerFor(door(), { folder: "INBOX", ref: "1:7" }), moved.ctx, { log: c2.log });
    expect([c2.lines()[0]?.healed, await moved.stored()]).toEqual([false, "2.1"]);
  });
});
