import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, changeLog, folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import { senderCheckBackfillPass } from "../src/sender-check-backfill.js";

/**
 * THE IDENTITY BACKFILL (mail 0148, acceptance 15), on whichever store the project runs: the rows
 * ingested before the column get the fact once, a marked row one `message` update and a clean row
 * none, a Sent row stays unchecked, and a second run writes nothing because the NULL set is the
 * cursor. It never moves a row.
 */
async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `scb-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "me@scb.invalid" }).returning();
  const row = async (folder: string, fromName: string | null, from: string, subject = "Hallo") => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject, fromAddress: from, fromName, nativeLocator: { folder, ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const check = async (id: string) => {
    const [r] = await db.select({ c: messages.senderCheck, b: messages.senderCheckBrand }).from(messages)
      .where(eq(messages.id, id));
    return r!;
  };
  const updates = async (id: string) => (await db.select({ seq: changeLog.seq }).from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityId, id), eq(changeLog.op, "update"),
  ))).length;
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const pass = () => senderCheckBackfillPass(db as unknown as Tx, { accountId });
  const passWith = (o: { batch: number; maxPages: number }) =>
    senderCheckBackfillPass(db as unknown as Tx, { accountId, ...o });
  return { row, check, updates, desired, pass, passWith };
}

describe("the identity backfill", () => {
  it("ACCEPTANCE: marks the claim with one delta, clears the clean row with none, leaves Sent, and moves nothing", async () => {
    const w = await world();
    const phish = await w.row("INBOX", "PostFinance", "causmaticstore@gmail.invalid");
    const held = await w.row("ohmail/Screener", null, "ubs.sicherheit@gmail.invalid");
    const benign = await w.row("INBOX", "Anna Brunner", "anna@firma.invalid");
    const sent = await w.row("Sent", "PostFinance", "me@scb.invalid");

    const first = await w.pass();
    expect(first).toMatchObject({ checked: 3, marked: 2, done: true });
    expect(await w.check(phish)).toEqual({ c: "impersonation", b: "PostFinance" });
    expect(await w.check(held)).toEqual({ c: "impersonation", b: "UBS" });
    expect(await w.check(benign)).toEqual({ c: "none", b: null });
    expect(await w.check(sent), "a Sent row is out of scope").toEqual({ c: null, b: null });
    expect(await w.updates(phish)).toBe(1);
    expect(await w.updates(benign), "a clean row changes no DTO").toBe(0);
    expect(await w.desired(phish), "the backfill never moves mail").toBe("INBOX");
    expect(await w.desired(held)).toBe("ohmail/Screener");
  });

  it("MUTATION-WATCH: a second run writes nothing — the NULL set is the cursor", async () => {
    const w = await world();
    const phish = await w.row("INBOX", "PostFinance", "x@gmail.invalid");
    await w.pass();
    const second = await w.pass();
    expect(second).toEqual({ checked: 0, marked: 0, done: true, contactsDone: true });
    expect(await w.updates(phish)).toBe(1);
  });

  it("pages: one page per call, and a call over an empty set says it is done", async () => {
    const w = await world();
    await w.row("INBOX", "Hans", "a@firma.invalid");
    await w.row("INBOX", "Sparkasse Service", "b@gmail.invalid");
    const page = (n: number) => w.passWith({ batch: 1, maxPages: n });
    expect(await page(1)).toMatchObject({ checked: 1, done: false });
    expect(await page(1)).toMatchObject({ checked: 1, done: false });
    expect(await page(1)).toEqual({ checked: 0, marked: 0, done: true, contactsDone: true });
  });
});
