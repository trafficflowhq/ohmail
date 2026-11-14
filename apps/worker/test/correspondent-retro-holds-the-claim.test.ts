import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, auditLog, contacts, folderState, mailboxFolders, mailboxes, messageBodies,
  messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { screenerCorrespondentRetroPass } from "../src/screener-correspondent-retro.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * AN ANSWER FROM AN ADDRESS THE COPY DOES NOT NAME (owner ruling 2026-10-08). Delivered through a
 * real sync cycle, answering a Sent copy this account wrote to somebody ELSE: it reaches the Ohbox
 * and is never taught, and the hourly retro releases such a message the gate held before it knew,
 * that message only. A company claim from them stays at the Screener and teaches nothing. A claim
 * from somebody the account wrote TO goes, the fact riding. A row the provider's own report
 * says FAILED authentication is not theirs, and the retro never moves it.
 */
const PHISH = "karten.reaktivierung@gmail.invalid";
const LANDLORD = "landlord@corr.invalid";
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");

/** `trusted`: the provider's authserv-ids. Empty reads every verdict `unavailable`, blind to a fail. */
async function world(o: { trusted?: ReadonlySet<string> } = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `r026-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT }).returning();
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: mb!.accountId, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  // A Sent copy to a THIRD party after the consent point — the phisher was never a recipient.
  const [s] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`,
    subject: "Wohnung", fromAddress: me, messageIdHeader: "s-1@own.invalid",
    date: WROTE, arrivedAt: WROTE, toAddresses: [{ name: null, address: LANDLORD }], ccAddresses: [],
    nativeLocator: { folder: "Sent", ref: "7:1" },
  }).returning();
  await db.insert(messageInstances).values({
    accountId, mailboxId: mb!.id, messageId: s!.id, folder: "Sent", uidvalidity: 7n, uid: 1, isPrimary: true,
  });
  await db.insert(folderState).values({
    messageId: s!.id, accountId: s!.accountId, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us",
    reconcileStatus: "reconciled", conflict: false,
  });
  await db.insert(messageBodies).values({ messageId: s!.id, accountId: s!.accountId, text: "hi", headers: {} });

  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } },
  );
  const queue: Array<{ from: string; subject: string; messageId: string; headers?: string[] }> = [];
  const deliver = async (from: string, subject: string, headers?: string[]) => {
    queue.push({ from, subject, messageId: `m-${randomUUID()}@gmail.invalid`, ...(headers ? { headers } : {}) });
    fleet.behave(mb!.id, { deliver: [...queue] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
      trustedAuthservIds: o.trusted ?? new Set<string>(),
    });
    const [row] = await db.select({ id: messages.id, check: messages.senderCheck, desired: folderState.desiredFolder })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.subject, subject)));
    return row!;
  };
  const desiredOf = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const contactOf = async (address: string) =>
    (await db.select({ source: contacts.source }).from(contacts)
      .where(and(eq(contacts.accountId, accountId), eq(contacts.address, address))))[0]?.source ?? null;
  /** The admissions recorded for one row — the payload is JSON text on the device store. */
  const admissionsOf = async (messageId: string) =>
    (await db.select({ payload: auditLog.payload }).from(auditLog).where(and(
      eq(auditLog.accountId, accountId), eq(auditLog.action, "screener.correspondent_admitted"))))
      .map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>)
      .filter((p) => p.messageId === messageId);
  /** The gate's hold, written over whatever this tree's gate decided: the retro's own question. */
  const holdAtGate = async (messageId: string) => {
    await db.update(folderState).set({ desiredFolder: "ohmail/Screener", lastSetBy: "us" })
      .where(eq(folderState.messageId, messageId));
    await db.delete(contacts).where(eq(contacts.accountId, accountId));
  };
  return { db, accountId, deliver, desiredOf, contactOf, admissionsOf, holdAtGate };
}

const CLAIM = "Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich";
const CITES = ["In-Reply-To: <s-1@own.invalid>"];

describe("the correspondent retro and a held identity claim", () => {
  it("a brand claim citing a Sent copy stays at the Screener after the retro, and its address is not taught", async () => {
    const w = await world();
    const phish = await w.deliver(`"PostFinance" <${PHISH}>`, CLAIM, CITES);
    expect(phish, "the gate's reply arm holds a claim").toMatchObject({ desired: "ohmail/Screener", check: "impersonation" });
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(0);
    expect(await w.desiredOf(phish.id)).toBe("ohmail/Screener");
    expect(await w.contactOf(PHISH)).toBeNull();
  });

  it("a company's own address nothing confirmed, answering a copy written to somebody else, stays held and marked", async () => {
    const w = await world();
    const brand = await w.deliver(`"PayPal" <service@paypal.com>`, "Ihr Konto", CITES);
    expect(brand, "an answer is no confirmation (mail 0176)").toMatchObject({ desired: "ohmail/Screener", check: "none" });
    const [row] = await w.db.select({ held: messages.unconfirmedHold }).from(messages).where(eq(messages.id, brand.id));
    expect(row!.held).toBe(true);
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(0);
    expect(await w.desiredOf(brand.id)).toBe("ohmail/Screener");
    expect(await w.contactOf("service@paypal.com")).toBeNull();
    expect(await w.admissionsOf(brand.id)).toEqual([]);
  });

  it("beside a confirmed answer the retro releases, a held unconfirmed one from the same address stays", async () => {
    const w = await world({ trusted: new Set(["mx.google.com"]) });
    const PASSED = "Authentication-Results: mx.google.com; dkim=pass header.d=paypal.com; dmarc=pass header.from=paypal.com";
    const confirmed = await w.deliver(`"PayPal" <service@paypal.com>`, "Ihre Unterlagen", [...CITES, PASSED]);
    expect(confirmed, "premise: a confirmed answer is let in at the gate").toMatchObject({ desired: "INBOX" });
    await w.holdAtGate(confirmed.id);
    const unconfirmed = await w.deliver(`"PayPal" <service@paypal.com>`, "Ihr Konto", CITES);
    expect(unconfirmed, "premise: held and marked").toMatchObject({ desired: "ohmail/Screener", check: "none" });
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(1);
    expect(await w.desiredOf(confirmed.id)).toBe("INBOX");
    expect(await w.desiredOf(unconfirmed.id), "mail 0176: an answer is no confirmation").toBe("ohmail/Screener");
  });

  it("a CLEAN answer citing a copy written to somebody else reaches the Ohbox at the gate, untaught", async () => {
    const w = await world();
    const clean = await w.deliver(`"Karten Service" <${PHISH}>`, "Ihre Unterlagen", CITES);
    expect(clean, "an answer to mail this account sent").toMatchObject({ desired: "INBOX" });
    expect(await w.contactOf(PHISH), "no contact, person or inferred").toBeNull();
    expect(await w.admissionsOf(clean.id)).toEqual([expect.objectContaining({ via: "replied", named: false })]);
  });

  it("the retro releases such an answer held from before, that message only, and teaches nothing", async () => {
    const w = await world();
    const clean = await w.deliver(`"Karten Service" <${PHISH}>`, "Ihre Unterlagen", CITES);
    const other = await w.deliver(`"Karten Service" <${PHISH}>`, "Noch etwas");
    // Held by a gate that did not know yet: the answer and, older, a mail of theirs citing nothing.
    await w.holdAtGate(clean.id);
    await w.db.update(folderState).set({ desiredFolder: "ohmail/Screener", lastSetBy: "us" })
      .where(eq(folderState.messageId, other.id));
    await w.db.update(messages).set({ date: new Date("2026-09-20T00:00:00.000Z") }).where(eq(messages.id, other.id));
    await w.db.update(messages).set({ date: WROTE }).where(eq(messages.id, clean.id));
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(1);
    expect(await w.desiredOf(clean.id)).toBe("INBOX");
    expect(await w.desiredOf(other.id), "a correspondent for the message that cites, only").toBe("ohmail/Screener");
    expect(await w.contactOf(PHISH)).toBeNull();
    // The gate's admission at ingest, then the retro's move with its inverse — both unnamed.
    const admitted = await w.admissionsOf(clean.id);
    expect(admitted.every((a) => a.via === "replied" && a.named === false)).toBe(true);
    expect(admitted).toContainEqual(expect.objectContaining({ from: "ohmail/Screener", to: "INBOX" }));
    expect(await w.admissionsOf(other.id)).toEqual([]);
  });

  it("the retro releases such an answer held UNDER a newer mail of theirs citing nothing", async () => {
    const w = await world();
    const clean = await w.deliver(`"Karten Service" <${PHISH}>`, "Ihre Unterlagen", CITES);
    const other = await w.deliver(`"Karten Service" <${PHISH}>`, "Noch etwas");
    await w.holdAtGate(clean.id);
    await w.db.update(folderState).set({ desiredFolder: "ohmail/Screener", lastSetBy: "us" })
      .where(eq(folderState.messageId, other.id));
    // The newer one is what the Screener shows; the answer under it is asked all the same.
    await w.db.update(messages).set({ date: new Date("2026-09-23T09:00:00.000Z") }).where(eq(messages.id, clean.id));
    await w.db.update(messages).set({ date: new Date("2026-09-24T09:00:00.000Z") }).where(eq(messages.id, other.id));
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(1);
    expect(await w.desiredOf(clean.id)).toBe("INBOX");
    expect(await w.desiredOf(other.id), "a correspondent for the message that cites, only").toBe("ohmail/Screener");
    expect(await w.contactOf(PHISH)).toBeNull();
    expect(await w.admissionsOf(clean.id)).toContainEqual(
      expect.objectContaining({ from: "ohmail/Screener", to: "INBOX", via: "replied", named: false }));
    expect(await w.admissionsOf(other.id)).toEqual([]);
  });

  it("CONTROL: such an answer that FAILED authentication stays at the Screener after the retro", async () => {
    const w = await world({ trusted: new Set(["mx.google.com"]) });
    const forged = await w.deliver(`"Karten Service" <${PHISH}>`, "Ihre Unterlagen",
      [...CITES, "Authentication-Results: mx.google.com; dmarc=fail header.from=gmail.invalid"]);
    expect(forged).toMatchObject({ desired: "ohmail/Screener" });
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(0);
    expect(await w.desiredOf(forged.id)).toBe("ohmail/Screener");
    expect(await w.contactOf(PHISH)).toBeNull();
  });

  it("a claim from somebody the account wrote TO, citing that very copy, goes to the Ohbox — the fact riding", async () => {
    const w = await world();
    const claim = await w.deliver(`"PostFinance" <${LANDLORD}>`, CLAIM, CITES);
    // The gate holds every claim; the retro releases it within the hour, like any recipient's.
    expect(claim).toMatchObject({ desired: "ohmail/Screener", check: "impersonation" });
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(1);
    expect(await w.desiredOf(claim.id)).toBe("INBOX");
    expect(await w.contactOf(LANDLORD)).toBe("person");
    // Found because the account wrote TO them: a claim's own references are read by no arm.
    expect(await w.admissionsOf(claim.id)).toEqual([expect.objectContaining({ via: "wrote", named: true })]);
  });

  it("a forged From of somebody the account wrote to, FAILING DMARC, stays at the Screener after the retro", async () => {
    const w = await world({ trusted: new Set(["mx.google.com"]) });
    const forged = await w.deliver(LANDLORD, "Neue Kontoverbindung",
      ["Authentication-Results: mx.google.com; dmarc=fail header.from=corr.invalid"]);
    expect(forged, "the provider's own report screens it").toMatchObject({ desired: "ohmail/Screener" });
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(0);
    expect(await w.desiredOf(forged.id)).toBe("ohmail/Screener");
    expect(await w.admissionsOf(forged.id)).toEqual([]);
  });

  it("CONTROL: the same mail with the provider's PASS is released — the reader is live, not blind", async () => {
    const w = await world({ trusted: new Set(["mx.google.com"]) });
    const genuine = await w.deliver(LANDLORD, "Neue Kontoverbindung",
      ["Authentication-Results: mx.google.com; dmarc=pass header.from=corr.invalid"]);
    expect(genuine).toMatchObject({ desired: "ohmail/Screener" });
    await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(await w.desiredOf(genuine.id)).toBe("INBOX");
    expect(await w.contactOf(LANDLORD)).toBe("person");
  });

  it("CONTROL: the same claim from somebody the account wrote TO goes to the Ohbox, the fact riding", async () => {
    const w = await world();
    const phish = await w.deliver(`"PostFinance" <${LANDLORD}>`, CLAIM);
    expect(phish).toMatchObject({ check: "impersonation" });
    await w.db.update(folderState).set({ desiredFolder: "ohmail/Screener", lastSetBy: "us" })
      .where(eq(folderState.messageId, phish.id));
    await w.db.delete(contacts).where(eq(contacts.accountId, w.accountId));
    await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(await w.desiredOf(phish.id)).toBe("INBOX");
    expect(await w.contactOf(LANDLORD)).toBe("person");
  });

  it("CONTROL: the same claim with no reference stays held after the retro", async () => {
    const w = await world();
    const phish = await w.deliver(`"PostFinance" <${PHISH}>`, "Ihre PostFinance Karte: Reaktivierung");
    expect(phish).toMatchObject({ desired: "ohmail/Screener", check: "impersonation" });
    await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(await w.desiredOf(phish.id)).toBe("ohmail/Screener");
  });
});
