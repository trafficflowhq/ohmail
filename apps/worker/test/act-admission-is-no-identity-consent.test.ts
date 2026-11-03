import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, applyScreenerDecision, auditLog, changeLog, contactNotes, contacts, folderState,
  learningSignals, mailboxFolders, mailboxes, messageInstances, messages, rules, type Tx,
} from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { retireActAdmissionsPass } from "../src/act-admission-retire.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * WHAT THE ACT ON SUGGESTIONS LET IN BEFORE IT STOPPED ADMITTING, through the real ingest.
 *
 * Mail 0148, the act's consent ruled NARROW: a sender the act admitted has not consented to a name
 * claiming a company — the same address's next mail calling itself PostFinance is held at the
 * Screener, the fact on its row; a person's own Screener yes is consent, and the claim is admitted.
 *
 * Owner report 2026-11-02: the act lets nobody in any more, and what it let in before is retired once
 * (`act-admission-retire.ts`): its allow rule and the contact only it wrote go, so the sender's next
 * cold letter waits at the Screener, and no letter moves. Every sender a person chose in any way keeps
 * everything. The admissions are seeded as the 0.30.28 act wrote them: a promoted rule nobody
 * stamped, an inferred contact, and its `screener:auto:` decision.
 */
const SENDER = "kundendienst@karten-service.test";
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
/** Every bulk header a cold sender can write. */
const COLD = [
  "List-Unsubscribe: <https://hire-outreach.example/u/1>, <mailto:unsub@hire-outreach.example>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "Feedback-ID: 1:campaign:hire-outreach",
];

async function world(o: { role?: "organizer" | "reader" } = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `actc-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@example.test`;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: me, createdAt: CONNECT, ...(o.role ? { organizerRole: o.role } : {}),
  }).returning();
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  const sent: Array<{ from: string; subject: string; messageId: string; headers?: string[] }> = [];
  /** One message from `from` under `name`, through a whole sync cycle; its row's place and fact. */
  const deliver = async (name: string, subject: string, from = SENDER, headers?: string[]) => {
    sent.push({ from: `"${name}" <${from}>`, subject, messageId: `m-${randomUUID()}@mail.test`, ...(headers ? { headers } : {}) });
    fleet.behave(mb!.id, { deliver: [...sent] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    const [row] = await db.select({ id: messages.id, check: messages.senderCheck, desired: folderState.desiredFolder })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.subject, subject)));
    return row!;
  };
  /** What the 0.30.28 act wrote when it let `address` in: its rule (unless `rule: false`), an inferred contact, its decision. */
  const actAdmitted = async (address: string, to: string, opt: { rule?: boolean; contact?: { source?: string; name?: string } } = {}) => {
    if (opt.rule !== false) {
      await db.insert(rules).values({
        accountId, kind: "sender", match: address, destination: to, provenance: "promoted", enabled: true, priority: 0,
        retroRequestedAt: new Date(),
      });
    }
    const [c] = await db.insert(contacts).values({
      accountId, address, source: opt.contact?.source ?? "inferred", ...(opt.contact?.name ? { name: opt.contact.name } : {}),
    }).returning();
    await db.insert(learningSignals).values({
      accountId, triggeringActionId: `screener:auto:${randomUUID()}`, kind: "screener", senderAddress: address,
      destination: to, label: "positive",
    });
    return c!.id;
  };
  let uid = 1;
  /** One of the account's own Sent copies, to `to`, written after the mailbox was connected. */
  const wroteTo = async (to: string) => {
    const at = new Date(CONNECT.getTime() + 86_400_000);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`, subject: "Thursday",
      fromAddress: me, messageIdHeader: `sent-${randomUUID()}@example.test`, date: at, arrivedAt: at,
      toAddresses: [{ name: null, address: to }], nativeLocator: { folder: "Sent", ref: `7:${uid}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, mailboxId: mb!.id, messageId: m!.id, folder: "Sent", uidvalidity: 7n, uid: uid++, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  const rulesOf = async () => (await db.select({ id: rules.id, match: rules.match, destination: rules.destination })
    .from(rules).where(eq(rules.accountId, accountId))).sort((a, b) => a.match.localeCompare(b.match));
  const contactsOf = async () => (await db.select({ address: contacts.address, source: contacts.source })
    .from(contacts).where(eq(contacts.accountId, accountId))).sort((a, b) => a.address.localeCompare(b.address));
  const ruleDeletes = async () => (await db.select({ id: changeLog.entityId }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "rule"), eq(changeLog.op, "delete")))).map((r) => r.id);
  const retirements = async () => db.select({ payload: auditLog.payload, inverse: auditLog.inverse }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, "screener.act_admission_retired")));
  const retire = (batch?: number, after?: string) =>
    retireActAdmissionsPass(db, { accountId, ...(batch ? { batch } : {}), ...(after ? { after } : {}) });
  return { db, accountId, deliver, actAdmitted, wroteTo, rulesOf, contactsOf, ruleDeletes, retirements, retire };
}

describe("an admission the act made is no consent to a name claiming a company", () => {
  it("a sender the act let in is held when the same address claims PostFinance", async () => {
    const w = await world();
    const first = await w.deliver("Anna Meier", "Ihre Bestellung");
    expect(first, "premise: a stranger's first mail is held").toMatchObject({ desired: "ohmail/Screener", check: "none" });
    await w.actAdmitted(SENDER, "INBOX");

    const claim = await w.deliver("PostFinance", "Ihre Karte wird gesperrt");
    expect(claim).toMatchObject({ desired: "ohmail/Screener", check: "impersonation" });
  });

  it("CONTROL: a person's own Screener yes is consent, and the same claim is admitted with the fact", async () => {
    const w = await world();
    const first = await w.deliver("Anna Meier", "Ihre Bestellung");
    await (w.db as unknown as { transaction: (f: (tx: Tx) => Promise<unknown>) => Promise<unknown> }).transaction((tx) =>
      applyScreenerDecision(tx, {
        accountId: w.accountId, scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "yes",
        triggeringActionId: `screener:press:${first.id}`, now: new Date(), stampBaseline: false, applyRetro: true,
        overExisting: "converge", liftOverDomain: true, decidedBy: "person",
      }));
    const [contact] = await w.db.select({ source: contacts.source }).from(contacts)
      .where(and(eq(contacts.accountId, w.accountId), eq(contacts.address, SENDER)));
    expect(contact!.source, "premise: the press wrote a person's contact").toBe("person");

    const claim = await w.deliver("PostFinance", "Ihre Karte wird gesperrt");
    expect(claim).toMatchObject({ desired: "INBOX", check: "impersonation" });
  });
});

describe("what the act let in is retired once, and its next cold letter waits at the Screener", () => {
  it("MUTATION-WATCH: the act's rules and contacts go with their deltas; the next cold letter is held; no letter moves", async () => {
    const w = await world();
    const news = "talent@hire-outreach.example";
    const before = await w.deliver("Hire Outreach", "Quick question about your next role", news, COLD);
    expect(before.desired, "premise: ingest holds a stranger").toBe("ohmail/Screener");
    await w.actAdmitted(news, "ohmail/News");
    await w.actAdmitted("billing@hire-outreach.example", "ohmail/Receipts");
    await w.actAdmitted("hello@hire-outreach.example", "INBOX");
    await w.actAdmitted("digest@hire-outreach.example", "ohmail/Reads", { rule: false });
    const admitted = await w.deliver("Hire Outreach", "A second question", news, COLD);
    expect(admitted.desired, "premise: the act's rule lets the sender's next letter into News").toBe("ohmail/News");
    const ruleIds = (await w.rulesOf()).map((r) => r.id).sort();

    const r = await w.retire();
    expect(r).toMatchObject({ examined: 4, rules: 3, contacts: 4, done: true, next: null });
    expect(await w.rulesOf()).toEqual([]);
    expect(await w.contactsOf()).toEqual([]);
    expect((await w.ruleDeletes()).sort(), "a retired rule left every mirror showing it").toEqual(ruleIds);
    const audits = await w.retirements();
    expect(audits).toHaveLength(4);
    for (const a of audits) {
      expect(a.inverse).toBeNull();
      expect(JSON.stringify(a.payload), "an address in an audit row").not.toContain("@");
    }
    // The decisions on record stay, and no letter moved: the one in News stays there.
    expect(await w.db.select().from(learningSignals).where(eq(learningSignals.accountId, w.accountId))).toHaveLength(4);
    const [stays] = await w.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, admitted.id));
    expect(stays!.d).toBe("ohmail/News");

    for (const [from, subject] of [
      [news, "Following up"], ["billing@hire-outreach.example", "Your invoice"],
      ["hello@hire-outreach.example", "Hello again"], ["digest@hire-outreach.example", "This week's digest"],
    ] as const) {
      expect((await w.deliver("Hire Outreach", subject, from, COLD)).desired, `${from} was let in after the retirement`)
        .toBe("ohmail/Screener");
    }
  });

  it("every sender a person chose keeps everything; the act's own deny and an imported contact are untouched", async () => {
    const w = await world();
    // Retired: the act's own admission, beside the controls.
    await w.actAdmitted("only-the-act@shop.test", "ohmail/News");
    // A person's press after the act.
    await w.actAdmitted("pressed@shop.test", "ohmail/News");
    await w.db.insert(learningSignals).values({
      accountId: w.accountId, triggeringActionId: `screener:press:${randomUUID()}`, kind: "screener",
      senderAddress: "pressed@shop.test", destination: "ohmail/News", label: "positive",
    });
    // A person's contact, a named one and one with a note.
    await w.actAdmitted("person@shop.test", "ohmail/News", { contact: { source: "person" } });
    await w.actAdmitted("named@shop.test", "ohmail/News", { contact: { name: "Anna Example" } });
    const noted = await w.actAdmitted("noted@shop.test", "ohmail/News");
    await w.db.insert(contactNotes).values({ accountId: w.accountId, contactId: noted, body: "met at the fair" });
    // Somebody the account wrote to.
    await w.actAdmitted("wrote-to@shop.test", "INBOX");
    await w.wroteTo("wrote-to@shop.test");
    // A rule a person wrote, and the act's rule a person stamped.
    await w.actAdmitted("manual@shop.test", "ohmail/Receipts", { rule: false });
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "manual@shop.test", destination: "ohmail/Receipts", provenance: "manual",
    });
    await w.actAdmitted("stamped@shop.test", "ohmail/News", { rule: false });
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "stamped@shop.test", destination: "ohmail/News", provenance: "promoted",
      personDecidedAt: new Date(),
    });
    // A domain a person let in, and an AI proposal the person approved.
    await w.actAdmitted("news@club.test", "ohmail/News");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "domain", match: "club.test", destination: "ohmail/News", provenance: "manual",
    });
    await w.actAdmitted("approved@shop.test", "ohmail/News");
    await w.db.insert(learningSignals).values({
      accountId: w.accountId, triggeringActionId: `approval:${randomUUID()}`, kind: "approval",
      senderAddress: "approved@shop.test", destination: "ohmail/News", label: "positive",
    });
    // The act's own deny, and a contact a profile imported before mail 0148 with no decision on record.
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "denied@spam.test", destination: "ohmail/Quarantine", provenance: "promoted",
    });
    await w.db.insert(learningSignals).values({
      accountId: w.accountId, triggeringActionId: `screener:auto:${randomUUID()}`, kind: "screener",
      senderAddress: "denied@spam.test", destination: "ohmail/Quarantine", label: "positive",
    });
    await w.db.insert(contacts).values({ accountId: w.accountId, address: "imported@shop.test", source: "inferred" });

    const rulesBefore = (await w.rulesOf()).filter((r) => r.match !== "only-the-act@shop.test");
    const contactsBefore = (await w.contactsOf()).filter((c) => c.address !== "only-the-act@shop.test");
    const r = await w.retire();
    expect(r).toMatchObject({ rules: 1, contacts: 1, done: true });
    expect(await w.rulesOf(), "a rule of a sender the person chose was retired").toEqual(rulesBefore);
    expect(await w.contactsOf(), "a contact of a sender the person chose was retired").toEqual(contactsBefore);
    expect(await w.retirements()).toHaveLength(1);
  });

  it("a page of senders it keeps still ends: the walk goes on after them", async () => {
    const w = await world();
    await w.actAdmitted("a-kept@shop.test", "ohmail/News", { contact: { source: "person" } });
    await w.actAdmitted("b-kept@shop.test", "ohmail/News", { contact: { name: "Bea" } });
    await w.actAdmitted("c-retired@shop.test", "ohmail/News");
    const pages: Array<{ examined: number; rules: number; done: boolean }> = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await w.retire(1, after);
      pages.push({ examined: r.examined, rules: r.rules, done: r.done });
      if (r.done) break;
      after = r.next!;
    }
    expect(pages.map((p) => p.rules)).toEqual([0, 0, 1, 0]);
    expect(pages[pages.length - 1]!.done).toBe(true);
    expect((await w.rulesOf()).map((x) => x.match)).toEqual(["a-kept@shop.test", "b-kept@shop.test"]);
  });

  it("a replay writes nothing, and an install that reads the mailbox writes nothing", async () => {
    const w = await world();
    await w.actAdmitted("talent@hire-outreach.example", "ohmail/News");
    await w.retire();
    const deltas = (await w.ruleDeletes()).length;
    expect(await w.retire()).toMatchObject({ examined: 0, rules: 0, contacts: 0, done: true });
    expect((await w.ruleDeletes()).length).toBe(deltas);
    expect(await w.retirements()).toHaveLength(1);

    const reader = await world({ role: "reader" });
    await reader.actAdmitted("talent@hire-outreach.example", "ohmail/News");
    const rulesBefore = await reader.rulesOf();
    expect(await reader.retire()).toMatchObject({ rules: 0, contacts: 0, done: true });
    expect(await reader.rulesOf()).toEqual(rulesBefore);
    expect(await reader.contactsOf()).toHaveLength(1);
    expect(await reader.ruleDeletes()).toEqual([]);
    expect(await reader.retirements()).toEqual([]);
  });
});
