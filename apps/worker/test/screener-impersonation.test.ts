import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, auditLog, changeLog, contacts, folderState, learningSignals, listAddresses, mailboxFolders,
  mailboxes, messageBodies, messageInstances, messages, rerouteAdvisedLetter, routingDecisions, rules,
  applyMessageMove, fileImpersonationLetters, type Tx,
} from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { claimedIdentity } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  MessageService, autoFiledSummary, makeUnsubscribeService, undoAutoFiled,
  type HostResolver, type OneClickPost, type ServiceContext,
} from "@trafficflow/services";
import {
  screenerImpersonationPass, type ScreenerImpersonationDeps, type ScreenerImpersonationResult,
} from "../src/screener-impersonation.js";
import { repoWithFailingMethod } from "./_fault.js";

/**
 * A HELD LETTER THAT IMPERSONATES A COMPANY IS FILED TO SPAM ON ITS OWN (2026-11-09). The pass files
 * the claim alone, by the pure decision, with no model: a lure asking for payment details is marked
 * `no_ai` and is filed all the same. It writes
 * nothing standing and sends no unsubscribe; any tie between the sender and the account keeps the
 * letter where the person decides, a claim answering the account's own mail and a filing returned by
 * any door included, and so do a code, the switch off, a failed read, the cutline and a mailbox this
 * install does not organize. A walk kept between runs passes the senders it keeps. Runs on both stores
 * (the sqlite project lists this file).
 */

const SCREENER = "ohmail/Screener";
const SPAM = "ohmail/Quarantine";
const DAY = 86_400_000;
/** A company's name over an unrelated address, on an invented domain. */
const PHISH = {
  name: "Metanet", from: "billing@hosting-renewals.example",
  subject: "Erinnerung: Bitte aktualisieren Sie Ihre Zahlungsinformationen",
};

interface World { accountId: string; mailboxId: string; me: string }

describe("the organizer files a held impersonation to Spam on its own", () => {
  let db: Tx;
  beforeAll(async () => { db = (await makeTestDb()) as unknown as Tx; });

  async function newWorld(o: { role?: "organizer" | "reader" } = {}): Promise<World> {
    const accountId = randomUUID();
    const me = `me-${accountId.slice(0, 8)}@own.example`;
    await db.insert(accounts).values({ id: accountId, name: `imp-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: me, status: "connected", createdAt: new Date(Date.now() - 30 * DAY),
      ...(o.role ? { organizerRole: o.role } : {}),
    }).returning();
    await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: mb!.accountId, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
    // 'all_time' so the cutline admits a fixture letter whatever its date.
    await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
    return { accountId, mailboxId: mb!.id, me };
  }

  let uid = 1;
  /** One letter held at the gate, its fact written as ingest writes it, with a one-click unsubscribe route. */
  async function held(w: World, l: {
    name: string | null; from: string; subject?: string; noAi?: boolean; category?: string | null; unconfirmed?: boolean;
    at?: Date; inReplyTo?: string;
  }): Promise<string> {
    const subject = l.subject ?? "Ihre Rechnung";
    const fact = claimedIdentity({ fromName: l.name, fromAddress: l.from, subject });
    const n = uid++;
    const at = l.at === undefined ? {} : { date: l.at, arrivedAt: l.at, createdAt: l.at };
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `imp:${randomUUID()}`,
      subject, fromName: l.name, fromAddress: l.from, authVerdict: "pass",
      senderCheck: fact ? "impersonation" : "none", senderCheckBrand: fact?.brand ?? null,
      noAi: l.noAi ?? false, sensitivityCategory: l.category ?? null, unconfirmedHold: l.unconfirmed ?? false,
      nativeLocator: { folder: SCREENER, ref: `1:${n}` }, ...at,
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: SCREENER, uidvalidity: 1n, uid: n, isPrimary: true,
    });
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "Aufgrund einer ausstehenden Zahlung",
      headers: {
        "list-unsubscribe": ["<https://lure.example/u?t=abc>"],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        "authentication-results": ["mx.google.com; dmarc=pass"],
        ...(l.inReplyTo === undefined ? {} : { "in-reply-to": [`<${l.inReplyTo}>`], references: [`<${l.inReplyTo}>`] }),
      },
    });
    return m!.id;
  }

  /** The account's own Sent copy, written two days ago to `to` under `messageIdHeader`. */
  async function sentCopy(w: World, to: string, messageIdHeader: string): Promise<void> {
    const at = new Date(Date.now() - 2 * DAY);
    const n = uid++;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `sent:${randomUUID()}`,
      subject: "Frage zu meinem Hosting", fromAddress: w.me, date: at, arrivedAt: at, messageIdHeader,
      toAddresses: [{ name: null, address: to }], nativeLocator: { folder: "Sent", ref: `7:${n}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: "Sent", uidvalidity: 7n, uid: n, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  }

  const desiredOf = async (id: string): Promise<string> =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const pass = (w: World, o: Partial<ScreenerImpersonationDeps> = {}) =>
    screenerImpersonationPass(db, { accountId: w.accountId, mailboxIds: [w.mailboxId], ...o });
  const ctxOf = (w: World): ServiceContext =>
    ({ db: db as never, accountId: w.accountId, userId: null, now: () => new Date(), requestId: "imp-put-back" });

  it("files a no_ai lure to Spam alone: one tagged audit row and a move, nothing standing, no unsubscribe", async () => {
    const w = await newWorld();
    const phish = await held(w, { ...PHISH, noAi: true });
    // The same sender's other held letter claims nothing, and stays.
    const other = await held(w, { name: "Kundendienst", from: PHISH.from, subject: "Hallo" });

    const r = await pass(w);
    expect(r).toMatchObject({ ran: true, examined: 1, filed: 1, senders: 1, failed: 0, capped: false });
    expect(await desiredOf(phish)).toBe(SPAM);
    expect(await desiredOf(other), "the sender's letter that claims nothing stays").toBe(SCREENER);

    const audit = await db.select().from(auditLog).where(eq(auditLog.accountId, w.accountId));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toEqual({ mailboxId: w.mailboxId, messageId: phish, from: SCREENER, to: SPAM, why: "impersonation" });
    expect(audit[0]!.inverse).toEqual({ messageId: phish, from: SPAM, to: SCREENER });
    const moves = await db.select({ meta: changeLog.meta }).from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, phish), eq(changeLog.op, "move")));
    expect(moves.map((m) => m.meta)).toEqual([{ from: SCREENER, to: SPAM }]);
    // Nothing about the address: no rule, contact, learning signal or routing decision.
    expect(await db.select().from(rules).where(eq(rules.accountId, w.accountId))).toEqual([]);
    expect(await db.select().from(contacts).where(eq(contacts.accountId, w.accountId))).toEqual([]);
    expect(await db.select().from(learningSignals).where(eq(learningSignals.accountId, w.accountId))).toEqual([]);
    expect(await db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId))).toEqual([]);

    // Filed automatically lists it with its reason; the automatic unsubscribe sends nothing for it.
    const listed = await autoFiledSummary(db, w.accountId);
    expect(listed.items.map((i) => [i.messageId, i.why, i.brand])).toEqual([[phish, "impersonation", "Metanet"]]);
    const calls: string[] = [];
    const post: OneClickPost = { async post(url: string) { calls.push(url); return { status: 200 }; } };
    const resolver: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
    await makeUnsubscribeService({ post, resolver, trustedAuthservIdsFor: async () => new Set(["mx.google.com"]) })
      .drainScreenedOut(db as never, { now: () => new Date(), requestId: "imp-drain" });
    expect(calls, "no one-click request for a letter nobody screened out").toEqual([]);

    expect((await pass(w)).filed, "a second run finds nothing left").toBe(0);
  });

  it("any tie between the sender and the account keeps the letter held", async () => {
    const w = await newWorld();
    const ties: Array<[string, (from: string) => Promise<void>]> = [
      ["a paused rule on the address", async (from) => {
        await db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: from, destination: "INBOX", enabled: false, provenance: "manual" });
      }],
      ["a rule on the domain", async (from) => {
        await db.insert(rules).values({ accountId: w.accountId, kind: "domain", match: from.split("@")[1]!, destination: SPAM, provenance: "promoted" });
      }],
      ["an inferred contact, written as it arrived", async (from) => {
        await db.insert(contacts).values({ accountId: w.accountId, address: from.toUpperCase(), source: "inferred" });
      }],
      ["a list address", async (from) => {
        await db.insert(listAddresses).values({ accountId: w.accountId, address: from });
      }],
      ["a letter the account wrote to them", async (from) => {
        const at = new Date(Date.now() - DAY);
        const [m] = await db.insert(messages).values({
          accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `sent:${randomUUID()}`,
          subject: "Offerte", fromAddress: w.me, date: at, arrivedAt: at,
          toAddresses: [{ name: null, address: from }], nativeLocator: { folder: "Sent", ref: `7:${uid}` },
        }).returning();
        await db.insert(messageInstances).values({
          accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: "Sent", uidvalidity: 7n, uid: uid++, isPrimary: true,
        });
        await db.insert(folderState).values({
          messageId: m!.id, accountId: m!.accountId, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
        });
      }],
    ];
    const kept: string[] = [];
    for (const [i, [, tie]] of ties.entries()) {
      const from = `billing${i}@tie-${i}.example`;
      await tie(from);
      kept.push(await held(w, { name: "PayPal", from }));
    }
    // The account's own address, claiming a company.
    kept.push(await held(w, { name: "PayPal", from: w.me }));
    const control = await held(w, { name: "PayPal", from: "billing@untied.example" });

    const r = await pass(w);
    expect(r.filed, "only the sender with no tie is filed").toBe(1);
    expect(await desiredOf(control)).toBe(SPAM);
    for (const [i, id] of kept.entries()) expect(await desiredOf(id), ties[i]?.[0] ?? "own address").toBe(SCREENER);
  });

  it("the door asks the ties again under its lock: a contact or a rule on the domain written since keeps the letter", async () => {
    const w = await newWorld();
    const door = (address: string, ids: string[]) => db.transaction((tx) => fileImpersonationLetters(carryDialect(db, tx), {
      accountId: w.accountId, address, messageIds: ids, now: new Date(),
    }));
    const a = await held(w, { ...PHISH, from: "a@lure-a.example" });
    await db.insert(contacts).values({ accountId: w.accountId, address: "A@Lure-A.example", source: "inferred" });
    expect(await door("a@lure-a.example", [a])).toMatchObject({ skipped: "tied", rerouted: [] });
    const b = await held(w, { ...PHISH, from: "b@lure-b.example" });
    await db.insert(rules).values({ accountId: w.accountId, kind: "domain", match: "lure-b.example", destination: "INBOX", enabled: false });
    expect(await door("b@lure-b.example", [b])).toMatchObject({ skipped: "tied", rerouted: [] });
    // Only the named letters, only claims, only to Spam: a letter that claims nothing is not moved.
    const c = await held(w, { ...PHISH, from: "c@lure-c.example" });
    const plain = await held(w, { name: "Kundendienst", from: "c@lure-c.example", subject: "Hallo" });
    expect((await door("c@lure-c.example", [c, plain])).rerouted.map((r) => r.messageId)).toEqual([c]);
    for (const [id, want] of [[a, SCREENER], [b, SCREENER], [c, SPAM], [plain, SCREENER]] as const) {
      expect(await desiredOf(id)).toBe(want);
    }
  });

  it("Put back returns the letter for good and exempts its sender", async () => {
    const w = await newWorld();
    const first = await held(w, PHISH);
    expect((await pass(w)).filed).toBe(1);
    expect(await undoAutoFiled(ctxOf(w), { messageIds: [first] })).toEqual({ putBack: [first], requested: [] });
    expect(await desiredOf(first)).toBe(SCREENER);
    const next = await held(w, PHISH);
    const r = await pass(w);
    expect(r.filed).toBe(0);
    expect(await desiredOf(first)).toBe(SCREENER);
    expect(await desiredOf(next), "the sender put back is exempt from the pass").toBe(SCREENER);
  });

  it("files nothing with the switch off, on a failed read, over a code, a held unconfirmed letter, or real mail", async () => {
    const off = await newWorld();
    const offPhish = await held(off, PHISH);
    await db.update(accountSettings).set({ impersonationFilingOffAt: new Date() }).where(eq(accountSettings.accountId, off.accountId));
    expect(await pass(off)).toMatchObject({ ran: false, filed: 0 });
    expect(await desiredOf(offPhish)).toBe(SCREENER);
    await db.update(accountSettings).set({ impersonationFilingOffAt: null }).where(eq(accountSettings.accountId, off.accountId));
    expect((await pass(off)).filed, "CONTROL: turned on again, it files").toBe(1);

    const failed = await newWorld();
    const failedPhish = await held(failed, PHISH);
    const blind = repoWithFailingMethod(db, "select", () => { throw new Error("store down"); }, { times: 1, sync: true });
    expect(await screenerImpersonationPass(blind, { accountId: failed.accountId, mailboxIds: [failed.mailboxId] }))
      .toMatchObject({ ran: false, filed: 0 });
    expect(await desiredOf(failedPhish), "a failed read reads as off").toBe(SCREENER);

    const w = await newWorld();
    const code = await held(w, { ...PHISH, from: "codes@lure-a.example", subject: "Ihr Sicherheitscode", category: "otp" });
    const unconfirmed = await held(w, { name: "PayPal", from: "service@paypal.example", unconfirmed: true });
    const real = await held(w, { name: "Metanet Hosting Support", from: "hello@lure-b.example" });
    const r = await pass(w);
    expect(r.filed).toBe(0);
    expect(r.kept).toMatchObject({ code: 1, not_presented: 1 });
    for (const id of [code, unconfirmed, real]) expect(await desiredOf(id)).toBe(SCREENER);
  });

  it("files nothing outside the cutline, nor in a mailbox this install does not organize", async () => {
    const w = await newWorld();
    await db.update(accountSettings).set({ screeningBaselineAt: new Date(Date.now() - DAY), screeningScope: "window" })
      .where(eq(accountSettings.accountId, w.accountId));
    await db.update(mailboxes).set({ initialImportCompletedAt: new Date(Date.now() - 2 * DAY) }).where(eq(mailboxes.id, w.mailboxId));
    const old = new Date(Date.now() - 200 * DAY);
    const outside = await held(w, PHISH);
    await db.update(messages).set({ date: old, arrivedAt: old }).where(eq(messages.id, outside));
    expect((await pass(w)).filed).toBe(0);
    expect(await desiredOf(outside)).toBe(SCREENER);

    const reader = await newWorld({ role: "reader" });
    const elsewhere = await held(reader, PHISH);
    expect((await pass(reader)).filed, "the door refuses a mailbox this install reads").toBe(0);
    expect(await pass(reader, { mailboxIds: [] })).toMatchObject({ ran: false });
    expect(await desiredOf(elsewhere)).toBe(SCREENER);
  });

  it("the store names the filing as no commanded verdict, beside the act's, until a person moves it to Spam", async () => {
    const w = await newWorld();
    const phish = await held(w, PHISH);
    const advised = await held(w, { name: "Shop", from: "deals@shop.example" });
    expect((await pass(w)).filed).toBe(1);
    await db.transaction((tx) => rerouteAdvisedLetter(carryDialect(db, tx), {
      accountId: w.accountId, address: "deals@shop.example", appliedFolder: SPAM, now: new Date(), messageId: advised,
    }));
    expect(await desiredOf(advised)).toBe(SPAM);
    const repo = makeDrizzleRepo(db);
    expect(await repo.listAiAutoAppliedQuarantine(w.accountId, [phish, advised]), "the act's filing goes to Junk as before")
      .toEqual([phish]);
    expect(await repo.listAiAutoAppliedQuarantine(randomUUID(), [phish]), "another account's filing names nothing").toEqual([]);
    // A move to the pile after the filing is a person's own verdict.
    await db.insert(changeLog).values({
      accountId: w.accountId, seq: 1_000_000n, entityType: "message", entityId: phish, op: "move",
      meta: { from: SCREENER, to: SPAM }, createdAt: new Date(Date.now() + 60_000),
    });
    expect(await repo.listAiAutoAppliedQuarantine(w.accountId, [phish])).toEqual([]);
  });

  it("files at most its bound of senders a run, and the next run takes the rest", async () => {
    const w = await newWorld();
    const ids = [
      await held(w, { ...PHISH, from: "a@lure-a.example" }),
      await held(w, { ...PHISH, from: "b@lure-b.example" }),
    ];
    const first = await pass(w, { sendersPerRun: 1 });
    expect(first).toMatchObject({ filed: 1, capped: true });
    const second = await pass(w, { sendersPerRun: 1 });
    expect(second, "a full page with nothing behind it owes nothing").toMatchObject({ filed: 1, capped: false });
    expect(await pass(w, { sendersPerRun: 1 })).toMatchObject({ examined: 0, filed: 0, capped: false });
    for (const id of ids) expect(await desiredOf(id)).toBe(SPAM);
  });

  it("walks past the senders it keeps: a newer lure is filed within its lap, and a finished lap owes nothing", async () => {
    const w = await newWorld();
    const base = Date.now() - 10 * DAY;
    // Four older senders the rule keeps (a name with a second word), and a lure newer than all of them.
    for (let i = 0; i < 4; i++) {
      await held(w, { name: "Metanet Hosting Support", from: `hello@kept-${i}.example`, at: new Date(base + i * 60_000) });
    }
    const lure = await held(w, { ...PHISH, at: new Date(base + DAY) });
    const walk = {};
    const runs: ScreenerImpersonationResult[] = [];
    for (let i = 0; i < 3; i++) runs.push(await pass(w, { sendersPerRun: 2, walk })); // ceil(4 / 2) + 1
    expect(await desiredOf(lure), "the lure behind the kept senders was never reached").toBe(SPAM);
    expect(runs.map((r) => [r.examined, r.filed, r.capped])).toEqual([[2, 0, true], [2, 0, true], [1, 1, false]]);
    expect(await pass(w, { sendersPerRun: 2, walk }), "a finished lap owes nothing").toMatchObject({ filed: 0, capped: false });
  });

  it("one sender's pile takes no other sender's turn at the read, and one cut while filing is finished next run", async () => {
    const w = await newWorld();
    const lure = await held(w, { ...PHISH, at: new Date(Date.now() - 3 * DAY) });
    // Newer than the lure: six letters the rule keeps from one sender, then four lures from another.
    for (let i = 0; i < 6; i++) {
      await held(w, { name: "Metanet Hosting Support", from: "hello@pile.example", at: new Date(Date.now() - 2 * DAY + i * 60_000) });
    }
    const flood: string[] = [];
    for (let i = 0; i < 4; i++) flood.push(await held(w, { ...PHISH, from: "billing@flood.example", at: new Date(Date.now() - DAY + i * 60_000) }));
    const walk = {};
    expect(await pass(w, { lettersPerRun: 6, walk })).toMatchObject({ filed: 4, capped: true });
    expect(await desiredOf(lure), "the older sender's lure lost its turn to a pile").toBe(SPAM);
    expect(await pass(w, { lettersPerRun: 6, walk })).toMatchObject({ filed: 1, capped: false });
    for (const id of flood) expect(await desiredOf(id)).toBe(SPAM);
  });

  it("a company's answer to the person's own question stays held: a claim citing their Sent copy ties its sender", async () => {
    const w = await newWorld();
    await sentCopy(w, "support@hosting.example", "question-1@own.example");
    // A hosted help desk answers from its own host, citing the question.
    const reply = await held(w, {
      name: "Metanet Support", from: "support@metanet.helpdesk-host.example", subject: "Re: Frage zu meinem Hosting",
      inReplyTo: "question-1@own.example",
    });
    const lure = await held(w, PHISH);
    expect(await pass(w)).toMatchObject({ filed: 1, kept: { correspondent: 1 } });
    expect(await desiredOf(reply), "the reply to the person's own question went to Spam").toBe(SCREENER);
    expect(await desiredOf(lure)).toBe(SPAM);
  });

  it("a filing the person returns to Waiting by any door is never filed again, and its sender's next claim stays", async () => {
    const w = await newWorld();
    const moved = await held(w, { ...PHISH, from: "billing@lure-a.example" });
    const asked = await held(w, { ...PHISH, from: "billing@lure-b.example" });
    expect((await pass(w)).filed).toBe(2);
    // The Spam preview's Not spam → Screener (POST /messages/:id/move), and a reader's Put back as the organizer applies it.
    await new MessageService().move(ctxOf(w), moved, { folder: SCREENER });
    const [row] = await db.select({ key: messages.dedupKey }).from(messages).where(eq(messages.id, asked));
    await db.transaction((tx) => applyMessageMove(carryDialect(db, tx), {
      accountId: w.accountId, mailboxId: w.mailboxId, payload: { dedupKey: row!.key, destination: "screener" }, now: new Date(),
    }));
    const next = [await held(w, { ...PHISH, from: "billing@lure-a.example" }), await held(w, { ...PHISH, from: "billing@lure-b.example" })];
    expect(await pass(w)).toMatchObject({ filed: 0, kept: { put_back: 4 } });
    for (const id of [moved, asked, ...next]) expect(await desiredOf(id)).toBe(SCREENER);
    // The door asks it again under its lock.
    expect(await db.transaction((tx) => fileImpersonationLetters(carryDialect(db, tx), {
      accountId: w.accountId, address: "billing@lure-a.example", messageIds: [next[0]!], now: new Date(),
    }))).toMatchObject({ skipped: "tied", rerouted: [] });
  });
});
