import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, folderState, mailboxes, messageBodies, messages, type Tx } from "@trafficflow/db";
import { gateReleasePass } from "../src/gate-release.js";

/**
 * THE ONE-TIME REPAIR NEVER RELEASES A CLAIM (mail 0148, a twin reader of the act's consent): for a
 * sender who is only a contact it desires their held mail into the Ohbox, so a row the check never
 * reached is checked first, as the act does — a claim is marked and stays at the gate, a row already
 * marked is not selected, and only a row checked clean is released. CONTROL: the benign row moves.
 * A row whose own provider says it FAILED authentication is not the contact's, and stays too.
 */
const GATE = "ohmail/Screener";
const SENDER = "pal@karten-service.test";

async function world(source: "inferred" | "person" | null = null) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `grc-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  let n = 0;
  const held = async (
    fromName: string, senderCheck: "impersonation" | "none" | null, authVerdict: string | null = null, unconfirmed = false,
  ) => {
    const i = n++;
    const at = new Date("2026-09-01T09:00:00.000Z");
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `grc:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: SENDER, fromName, date: at, unread: true, createdAt: at,
      senderCheck, senderCheckBrand: senderCheck === "impersonation" ? "PostFinance" : null, authVerdict,
      ...(unconfirmed ? { unconfirmedHold: true } : {}),
      nativeLocator: { folder: GATE, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  await db.insert(contacts).values({ accountId, address: SENDER, ...(source === null ? {} : { source }) });
  const row = async (id: string) => (await db.select({ desired: folderState.desiredFolder, check: messages.senderCheck })
    .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId)).where(eq(messages.id, id)))[0]!;
  return { db: db as unknown as Tx, accountId, held, row };
}

describe("the gate-release repair and the identity fact", () => {
  it("checks an unchecked row first: the claim is marked and held, the benign row is released", async () => {
    const w = await world();
    const benign = await w.held("Pal Meier", null);
    const claim = await w.held("PostFinance", null);
    const marked = await w.held("PostFinance", "impersonation");
    const r = await gateReleasePass(w.db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, contactRowsReleased: 1, completed: true });
    expect(await w.row(benign)).toEqual({ desired: "INBOX", check: "none" });
    expect(await w.row(claim)).toEqual({ desired: GATE, check: "impersonation" });
    expect(await w.row(marked)).toEqual({ desired: GATE, check: "impersonation" });
  });

  it("a contact's held row that FAILED authentication stays; the one beside it that passed is released", async () => {
    const w = await world();
    const forged = await w.held("Pal Meier", "none", "fail");
    const genuine = await w.held("Pal Meier", "none", "pass");
    const r = await gateReleasePass(w.db, { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, contactRowsReleased: 1, completed: true });
    expect((await w.row(forged)).desired, "the provider said this mail is not the contact's").toBe(GATE);
    expect((await w.row(genuine)).desired).toBe("INBOX");
  });

  it("a letter held for want of confirmation stays while only an inferred contact knows the sender; a person's contact releases it", async () => {
    const inferred = await world("inferred");
    const held = await inferred.held("PayPal", "none", null, true);
    const clean = await inferred.held("Pal Meier", "none");
    expect(await gateReleasePass(inferred.db, { accountId: inferred.accountId }))
      .toMatchObject({ ran: true, contactRowsReleased: 1, completed: true });
    expect((await inferred.row(held)).desired, "mail 0176: only a person's word lets it in").toBe(GATE);
    expect((await inferred.row(clean)).desired).toBe("INBOX");
    // CONTROL: a person's contact is the person skip; the gate would not hold the row now.
    const person = await world("person");
    const consented = await person.held("PayPal", "none", null, true);
    expect(await gateReleasePass(person.db, { accountId: person.accountId })).toMatchObject({ contactRowsReleased: 1 });
    expect((await person.row(consented)).desired).toBe("INBOX");
  });
});
