import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageBodies, messages, rules, type Tx } from "@trafficflow/db";
import { planChange, commitChange, UNMETERED_STORAGE_CAP, type Change } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { cutlineCounts } from "../src/consent-cutline.js";
import { heldReleaseGroups, heldReleaseTotal } from "../src/held-release-service.js";
import { materializeMessage, messageRowToDTO } from "../src/dto/materialize.js";
import type { ServiceContext } from "../src/context.js";

/**
 * The server's facts: a letter whose place somebody decided is
 * stated on the wire and is no undecided residence of its sender (the client partition's twin,
 * an admitted answer); a rule group offers only what its pass moves.
 */

const NOW = new Date("2026-10-10T07:00:00.000Z");
const GATE = "ohmail/Screener";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `says-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  const letter = async (o: { from: string; folder: string; decidedAt?: Date; auth?: string }) => {
    const at = new Date("2026-10-10T06:42:00.000Z");
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `s:${randomUUID()}`, subject: "the north elevation",
      snippet: "", fromAddress: o.from, senderCheck: "none", authVerdict: o.auth ?? null, date: at, unread: true,
      createdAt: at, nativeLocator: { folder: o.folder, ref: "1:1" },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: o.folder, observedFolder: o.folder, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false, decidedAt: o.decidedAt ?? null,
    });
    return m!.id as string;
  };
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `s-${randomUUID().slice(0, 8)}` };
  return { db, tx: db as unknown as Tx, accountId, mailboxId: mb!.id as string, ctx, letter };
}

describe("a letter whose place somebody decided", () => {
  it("is stated on the wire, and an undecided letter is not", async () => {
    const w = await world();
    const answer = await w.letter({ from: "b+r31x@answers.example", folder: "INBOX", decidedAt: NOW });
    const plain = await w.letter({ from: "b+r31x@answers.example", folder: "INBOX" });
    const dto = async (id: string) => {
      const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
      const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, id));
      return messageRowToDTO(m!, fs, undefined, []);
    };
    expect((await dto(answer)).placeDecided).toBe(true);
    expect("placeDecided" in (await dto(plain))).toBe(false);
  });

  it("is stated for a letter another client filed on arrival, not for the sender's Ohbox letter", async () => {
    const w = await world();
    const from = "piet@people.invalid";
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: from, destination: "INBOX", enabled: true, priority: 0, provenance: "promoted" });
    const repo = makeDrizzleRepo(w.db);
    const ingest = async (folder: string, ref: string) => {
      const raw = Buffer.from([`Message-ID: <${ref}@people.invalid>`, `From: ${from}`, "To: me@ohmail.test",
        "Subject: the invoice", "Content-Type: text/plain; charset=utf-8", "", "Attached."].join("\r\n"));
      const change: Change = { type: "create", locator: { folder, ref }, raw, seen: false, internalDate: NOW };
      const plan = await planChange(change, { repo, accountId: w.accountId, mailboxId: w.mailboxId, routing: repo, readerMode: false });
      const { messageId } = await repo.transaction((tx) => commitChange(plan, {
        repo: tx, routing: tx, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      }));
      return (await materializeMessage(w.db, w.accountId, messageId))!;
    };
    const filed = await ingest("ohmail/News", "5:1");
    expect([filed.folder, filed.placeDecided]).toEqual(["ohmail/News", true]);
    const ohbox = await ingest("INBOX", "1:1");
    expect([ohbox.folder, "placeDecided" in ohbox]).toEqual(["INBOX", false]);
  });

  it("is no undecided residence: an author whose only letter is an admitted answer owes no decision", async () => {
    const w = await world();
    await w.letter({ from: "b+r31x@answers.example", folder: "INBOX", decidedAt: NOW });
    expect((await cutlineCounts(w.ctx, {})).activeUndecidedSenders).toBe(0);
  });

  it("CONTROL: a stranger's INBOX letter nothing decided is still owed a decision", async () => {
    const w = await world();
    await w.letter({ from: "c+fresh@stranger.example", folder: "INBOX" });
    expect((await cutlineCounts(w.ctx, {})).activeUndecidedSenders).toBe(1);
  });
});

describe("a rule group offers what its pass moves", () => {
  const SENDER = "news@letters.example";
  it("an admitting rule's group leaves out a letter whose authentication failed", async () => {
    const w = await world();
    await w.letter({ from: SENDER, folder: GATE });
    await w.letter({ from: SENDER, folder: GATE, auth: "fail" });
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: SENDER, destination: "INBOX", enabled: true, priority: 0, provenance: "manual" });
    const groups = await heldReleaseGroups(w.tx, w.accountId);
    expect(groups.map((g) => g.count)).toEqual([1]);
    expect(await heldReleaseTotal(w.tx, w.accountId, groups)).toBe(1);
  });

  it("CONTROL: a denying rule's group counts it, because the pass moves it whatever the verdict", async () => {
    const w = await world();
    await w.letter({ from: SENDER, folder: GATE });
    await w.letter({ from: SENDER, folder: GATE, auth: "fail" });
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: SENDER, destination: "ohmail/Screened", enabled: true, priority: 0, provenance: "manual" });
    expect((await heldReleaseGroups(w.tx, w.accountId)).map((g) => g.count)).toEqual([2]);
  });
});
