import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { carryDialect } from "@trafficflow/db/dialect";
import {
  accounts, accountSettings, accountSyncState, approvals, changeLog, folderState, graduations, learningSignals, mailboxFolders, mailboxes, messageBodies,
  messageInstances, messages, routingDecisions, rules, applyScreenerDecision,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { Logger } from "@trafficflow/core/mail";
import { ApprovalService, LearningService, MessageService, RulesService, deleteAccount, resetScreeningState, type ServiceContext } from "@trafficflow/services";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";
import { screenerAutoActPass, type ScreenerActConsent } from "../src/screener-auto-act.js";
import { screenerCorrespondentRetroPass } from "../src/screener-correspondent-retro.js";

/**
 * ONE LOCK ORDER UNDER A SENDER'S KEY, DRIVEN AS TWO TRANSACTIONS ON REAL POSTGRES: accounts fence,
 * `account_settings`, the rule-key lock, the mailbox row, `contacts`, `folder_state`, the change-log
 * counter, and a graduation's row after it. Each case parks one writer at a known statement, starts
 * the other until it waits too, then lets both go: at the base (or with the order its control puts
 * back) each pair deadlocked (40P01); in order they queue and both commit. The erasure is the
 * shipped `deleteAccount`, the decision `applyScreenerDecision`: a copy would test the copy.
 */
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-10-04T12:00:00.000Z");
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");
const SCREENER = "ohmail/Screener";
const SPAM = "ohmail/Quarantine";
const NEWS = "ohmail/News";

function named(name: string): string {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", name);
  return u.toString();
}
const codeOf = (e: unknown): string | undefined =>
  (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;

describe.skipIf(!AVAILABLE)("writers under a sender's key keep one lock order", () => {
  let base: OwnedDb;
  const clients: OwnedDb[] = [];
  const open = (name: string): OwnedDb => { const o = makeOwnedDb(named(name)); clients.push(o); return o; };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    base = open(`lo-base-${randomUUID().slice(0, 8)}`);
  }, 180_000);
  afterAll(async () => { for (const c of clients) await c.close().catch(() => {}); });

  async function untilWaiting(name: string, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      const rows = await base.db.execute(sql`select count(*)::int as n from pg_stat_activity
        where application_name = ${name} and wait_event_type = 'Lock'`) as unknown as Array<{ n: number }>;
      if ((rows[0]?.n ?? 0) > 0) return;
      if (Date.now() > end) throw new Error(`${name} never waited on a lock`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const capture = (): Logger & { lines: Array<{ event: string; fields: Record<string, unknown> }> } => {
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const put = (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); };
    return { lines, info: put, warn: put, error: put, debug: put } as never;
  };

  it("the auto-act pass and the account's erasure: the fence before the settings lock, both commit", async () => {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await base.db.insert(accounts).values({ id: accountId, name: `lo-act-${tag}` });
    const [mb] = await base.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `lo-act-${tag}@example.test`, status: "connected",
    }).returning();
    await base.db.insert(accountSettings).values({ accountId, screenerAutoActAt: NOW, screeningScope: "all_time" });
    // Confirmed by the provider (`pass`), so the act writes the rule the erasure must take with it.
    const [m] = await base.db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `lo-${tag}`, dedupKey: `lo:${tag}`, subject: "offer",
      fromAddress: `held-${tag}@spam.test`, authVerdict: "pass", nativeLocator: { folder: SCREENER, ref: "1:200" },
    }).returning();
    await base.db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await base.db.insert(routingDecisions).values({
      accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: SPAM, confidence: 0.95, rationale: "", spam: true, status: SCREENER_SUGGESTION_STATUS, senderReason: "none",
    });

    // The pass asks its consent twice: once before the page, once per sender inside the sender's
    // transaction, after the locks it opens with. The second ask parks it there.
    let asked = 0;
    let parked!: () => void;
    const isParked = new Promise<void>((r) => { parked = r; });
    let resume!: () => void;
    const resumed = new Promise<void>((r) => { resume = r; });
    const consent: ScreenerActConsent = {
      async stillGiven() {
        asked += 1;
        if (asked === 2) { parked(); await resumed; }
        return true;
      },
    };
    const log = capture();
    const actName = `lo-act-${tag}`;
    const eraseName = `lo-erase-${tag}`;
    const act = screenerAutoActPass(open(actName).db as unknown as Tx, { accountId, consent, log, now: () => NOW });
    await isParked;
    const eraseCtx = {
      db: open(eraseName).db, accountId, userId: null, now: () => NOW, requestId: `lo-erase-${tag}`,
    } as unknown as ServiceContext;
    const erase = deleteAccount(eraseCtx);
    await untilWaiting(eraseName);
    resume();
    const [actOut, eraseOut] = await Promise.allSettled([act, erase]);

    const failed = log.lines.filter((l) => l.event === "screener_auto_act_failed").map((l) => codeOf(l.fields.err) ?? String(l.fields.err));
    expect(failed, "the act failed").toEqual([]);
    expect(eraseOut.status === "rejected" ? codeOf(eraseOut.reason) ?? String(eraseOut.reason) : "ok", "the erasure failed").toBe("ok");
    expect(actOut.status).toBe("fulfilled");
    const [acct] = await base.db.select({ erasedAt: accounts.erasedAt }).from(accounts).where(eq(accounts.id, accountId));
    expect(acct!.erasedAt).not.toBeNull();
    expect(await base.db.select().from(rules).where(eq(rules.accountId, accountId)), "the act's rule outlived the erasure").toEqual([]);
  }, 60_000);

  it("an account erased before the pass reaches a sender is one account-level line, not a failure per sender", async () => {
    // The erasure's stamp is all the pass's fence reads; the stamp stands in for a committed erasure
    // whose sweep had not reached this page yet. What is under test is how the pass reports it.
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await base.db.insert(accounts).values({ id: accountId, name: `lo-gone-${tag}` });
    const [mb] = await base.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `lo-gone-${tag}@example.test`, status: "connected",
    }).returning();
    await base.db.insert(accountSettings).values({ accountId, screenerAutoActAt: NOW, screeningScope: "all_time" });
    for (const i of [1, 2]) {
      const [m] = await base.db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `gone-${tag}-${i}`, dedupKey: `gone:${tag}:${i}`, subject: "offer",
        fromAddress: `held${i}-${tag}@spam.test`, authVerdict: "pass", nativeLocator: { folder: SCREENER, ref: `1:${300 + i}` },
      }).returning();
      await base.db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      await base.db.insert(routingDecisions).values({
        accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
        destination: SPAM, confidence: 0.95, rationale: "", spam: true, status: SCREENER_SUGGESTION_STATUS, senderReason: "none",
      });
    }
    await base.db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));
    const log = capture();
    const out = await screenerAutoActPass(base.db as unknown as Tx, {
      accountId, log, now: () => NOW, consent: { stillGiven: async () => true },
    });
    const events = log.lines.map((l) => l.event).filter((e) => e.startsWith("screener_auto_act"));
    expect(events).toEqual(["screener_auto_act_account_erased"]);
    expect(out).toMatchObject({ examined: 2, filed: 0, failed: 0 });
  }, 60_000);

  /**
   * A sender with a genuine letter (`pass`, backdated by its Date) and a newer one its provider did
   * not confirm, advised to Spam: the act files the unconfirmed letter alone and writes no rule, on
   * the decision's own order (the fence, `account_settings`, the rule-key lock, the mailbox row
   * FOR SHARE, `folder_state`, the counter). A person's admission of the same sender is the other side.
   * Unlike the pairs above, these two never deadlocked at a base: the door is new, and they hold that
   * it queues behind and ahead of the press in that order, and reads the press's rule once it waited.
   */
  async function unconfirmedWorld(prefix: string) {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await base.db.insert(accounts).values({ id: accountId, name: `${prefix}-${tag}` });
    const [mb] = await base.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${prefix}-${tag}@example.test`, status: "connected",
    }).returning();
    await base.db.insert(accountSettings).values({ accountId, screenerAutoActAt: NOW, screeningScope: "all_time" });
    await base.db.insert(accountSyncState).values({ accountId, nextSeq: 0n }).onConflictDoNothing();
    const sender = `held-${tag}@spam.test`;
    const letter = async (ref: number, authVerdict: string, date: Date): Promise<string> => {
      const [m] = await base.db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `${prefix}-${tag}-${ref}`, dedupKey: `${prefix}:${tag}:${ref}`,
        subject: "offer", fromAddress: sender, authVerdict, senderCheck: "none", date,
        nativeLocator: { folder: SCREENER, ref: `1:${ref}` },
      }).returning();
      await base.db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };
    const genuine = await letter(400, "pass", new Date("2020-01-01T00:00:00.000Z"));
    const forged = await letter(401, "unavailable", NOW);
    await base.db.insert(routingDecisions).values({
      accountId, messageId: forged, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: SPAM, confidence: 0.95, rationale: "", spam: true, status: SCREENER_SUGGESTION_STATUS, senderReason: "none",
    });
    const desiredOf = async (id: string): Promise<string> =>
      (await base.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
    const senderRules = () => base.db.select({ destination: rules.destination, personDecidedAt: rules.personDecidedAt })
      .from(rules).where(and(eq(rules.accountId, accountId), eq(rules.match, sender)));
    /** The person's admission, as the press runs it: the settings row stamped, then the rule-key lock. */
    const admit = (name: string) => {
      const decideDb = open(name).db;
      return decideDb.transaction(async (raw) => applyScreenerDecision(carryDialect(decideDb, raw as object) as unknown as Tx, {
        accountId, scope: "sender", address: sender, appliedFolder: "INBOX", decision: "yes",
        triggeringActionId: `screener:${name}`, now: NOW, overExisting: "converge", decidedBy: "person",
      }));
    };
    return { accountId, tag, genuine, forged, desiredOf, senderRules, admit };
  }

  it("the act's filing of an unconfirmed letter and a person's admission of the sender, the act first: both commit", async () => {
    const w = await unconfirmedWorld("lo-unc");
    // The act parks at its per-sender consent ask, holding the fence and the settings row.
    let asked = 0;
    let parked!: () => void;
    const isParked = new Promise<void>((r) => { parked = r; });
    let resume!: () => void;
    const resumed = new Promise<void>((r) => { resume = r; });
    const consent: ScreenerActConsent = {
      async stillGiven() {
        asked += 1;
        if (asked === 2) { parked(); await resumed; }
        return true;
      },
    };
    const log = capture();
    const actName = `lo-unc-act-${w.tag}`;
    const admitName = `lo-unc-admit-${w.tag}`;
    const act = screenerAutoActPass(open(actName).db as unknown as Tx, { accountId: w.accountId, consent, log, now: () => NOW });
    await isParked;
    const admit = w.admit(admitName);
    await untilWaiting(admitName);
    resume();
    const settled = await Promise.allSettled([act, admit]);
    const codes = settled.map((x) => (x.status === "rejected" ? codeOf(x.reason) ?? String(x.reason) : "ok"));
    expect(codes, "a writer failed").toEqual(["ok", "ok"]);
    const failed = log.lines.filter((l) => l.event === "screener_auto_act_failed").map((l) => codeOf(l.fields.err) ?? String(l.fields.err));
    expect(failed, "the act failed").toEqual([]);
    expect(settled[0].status === "fulfilled" ? settled[0].value : null).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
    expect(await w.desiredOf(w.forged)).toBe(SPAM);
    expect(await w.desiredOf(w.genuine)).toBe("INBOX");
    expect(await w.senderRules()).toEqual([{ destination: "INBOX", personDecidedAt: NOW }]);
  }, 60_000);

  it("a person's admission of the sender and the act's filing of an unconfirmed letter, the press first: both commit, the act files nothing", async () => {
    const w = await unconfirmedWorld("lo-unc2");
    // The gate holds the change-log counter: the admission parks at its first delta, holding the
    // settings row and the rule-key lock; the act then waits at the settings row.
    const gate = open(`lo-unc2-gate-${w.tag}`);
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const gated = gate.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from account_sync_state where account_id = ${w.accountId} for update`);
      held();
      await released;
      throw new Error("gate rolled back");
    }).catch(() => undefined);
    await holding;
    const admitName = `lo-unc2-admit-${w.tag}`;
    const actName = `lo-unc2-act-${w.tag}`;
    const admit = w.admit(admitName);
    await untilWaiting(admitName);
    const log = capture();
    const act = screenerAutoActPass(open(actName).db as unknown as Tx, {
      accountId: w.accountId, consent: { stillGiven: async () => true }, log, now: () => NOW,
    });
    await untilWaiting(actName);
    release();
    await gated;
    const settled = await Promise.allSettled([admit, act]);
    const codes = settled.map((x) => (x.status === "rejected" ? codeOf(x.reason) ?? String(x.reason) : "ok"));
    expect(codes, "a writer failed").toEqual(["ok", "ok"]);
    expect(await w.desiredOf(w.forged)).toBe("INBOX");
    expect(await w.desiredOf(w.genuine)).toBe("INBOX");
    expect(await w.senderRules()).toEqual([{ destination: "INBOX", personDecidedAt: NOW }]);
    expect(settled[1].status === "fulfilled" ? settled[1].value : null, "the act filed over the person's rule")
      .toMatchObject({ filed: 0, kept: 1, failed: 0, unconfirmedDenies: 0 });
  }, 60_000);

  it("the correspondent retro's release and a Screener decision on one sender: both commit", async () => {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    const me = `me-${tag}@own.invalid`;
    const replier = `replier-${tag}@corr.invalid`;
    await base.db.insert(accounts).values({ id: accountId, name: `lo-corr-${tag}` });
    const [mb] = await base.db.insert(mailboxes).values({
      accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT,
    }).returning();
    await base.db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
    await base.db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
    // The account wrote to a list after it connected; the replier answers that copy. Nothing
    // teaches `contacts` the replier: the release checks and moves their citing message, row by row.
    const [s] = await base.db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${tag}`, subject: "the north elevation",
      fromAddress: me, messageIdHeader: `s-${tag}@own.invalid`, date: WROTE, arrivedAt: WROTE,
      toAddresses: [{ name: null, address: `list-${tag}@corr.invalid` }], ccAddresses: [],
      nativeLocator: { folder: "Sent", ref: "7:1" },
    }).returning();
    await base.db.insert(messageInstances).values({
      accountId, mailboxId: mb!.id, messageId: s!.id, folder: "Sent", uidvalidity: 7n, uid: 1, isPrimary: true,
    });
    await base.db.insert(folderState).values({
      messageId: s!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await base.db.insert(messageBodies).values({ messageId: s!.id, text: "Thursday?", headers: {} });
    const [h] = await base.db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `held:${tag}`, subject: "Re: the north elevation",
      fromAddress: replier, date: WROTE, nativeLocator: { folder: SCREENER, ref: "9:2" },
    }).returning();
    await base.db.insert(folderState).values({
      messageId: h!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await base.db.insert(messageBodies).values({ messageId: h!.id, text: "Thursday works.", headers: { "in-reply-to": [`<s-${tag}@own.invalid>`] } });

    // The gate holds the held row (and its message) the release locks first.
    const gate = open(`lo-gate-${tag}`);
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const gated = gate.db.transaction(async (tx) => {
      await tx.execute(sql`select fs.message_id from folder_state fs join messages m on m.id = fs.message_id
        where m.id = ${h!.id} for update`);
      held();
      await released;
      throw new Error("gate rolled back");
    }).catch(() => undefined);
    await holding;

    const retroName = `lo-retro-${tag}`;
    const decideName = `lo-decide-${tag}`;
    const retro = screenerCorrespondentRetroPass(open(retroName).db as unknown as Tx, { accountId, now: () => NOW });
    await untilWaiting(retroName);
    const decideDb = open(decideName).db;
    const decide = decideDb.transaction(async (raw) => applyScreenerDecision(
      carryDialect(decideDb, raw as object) as unknown as Tx, {
        accountId, scope: "sender", address: replier, appliedFolder: "INBOX", decision: "yes",
        triggeringActionId: `screener:lo-${tag}`, now: NOW, overExisting: "converge", decidedBy: "person",
      }));
    await untilWaiting(decideName);
    release();
    await gated;
    const settled = await Promise.allSettled([retro, decide]);
    const codes = settled.map((x) => (x.status === "rejected" ? codeOf(x.reason) ?? String(x.reason) : "ok"));
    expect(codes, "a writer failed").toEqual(["ok", "ok"]);

    const [fs] = await base.db.select({ desired: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, h!.id));
    expect(fs!.desired).toBe("INBOX");
    const ruleRows = await base.db.select({ destination: rules.destination }).from(rules)
      .where(and(eq(rules.accountId, accountId), eq(rules.match, replier)));
    expect(ruleRows).toEqual([{ destination: "INBOX" }]);
  }, 60_000);

  /* THE SCREENING RESET beside a decision that stamps no settings row (the reader drain's, the
     held-mail release's): the reset is parked first on the change-log counter, the decision then
     holds the sender's rule row and wants that counter. The stamped decision is the control: it
     meets the reset at the settings row and queues there. */
  for (const stampBaseline of [false, true]) {
    it(`the screening reset and a decision${stampBaseline ? " that stamps the settings row" : ""}: both commit`, async () => {
      const accountId = randomUUID();
      const tag = accountId.slice(0, 8);
      await base.db.insert(accounts).values({ id: accountId, name: `lo-reset-${tag}` });
      await base.db.insert(mailboxes).values({ accountId, provider: "imap", address: `lo-reset-${tag}@example.invalid`, status: "connected" });
      await base.db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
      await base.db.insert(accountSyncState).values({ accountId, nextSeq: 0n }).onConflictDoNothing();
      const sender = `s-${tag}@example.invalid`;
      await base.db.insert(rules).values({
        accountId, kind: "sender", match: sender, destination: "ohmail/Screened", priority: 0, enabled: false, provenance: "promoted",
      });
      const gate = open(`lo-rgate-${tag}`);
      let held!: () => void;
      const holding = new Promise<void>((r) => { held = r; });
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const gated = gate.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from account_sync_state where account_id = ${accountId} for update`);
        held();
        await released;
        throw new Error("gate rolled back");
      }).catch(() => undefined);
      await holding;
      const resetName = `lo-reset-${tag}`;
      const decideName = `lo-rdec-${tag}`;
      const reset = resetScreeningState({
        db: open(resetName).db, accountId, userId: null, now: () => NOW, requestId: `lo-reset-${tag}`,
      } as unknown as ServiceContext);
      await untilWaiting(resetName);
      const decideDb = open(decideName).db;
      const decide = decideDb.transaction(async (raw) => applyScreenerDecision(
        carryDialect(decideDb, raw as object) as unknown as Tx, {
          accountId, scope: "sender", address: sender, appliedFolder: "INBOX", decision: "yes", stampBaseline,
          triggeringActionId: `screener:lo-reset-${tag}`, now: NOW, overExisting: "converge", decidedBy: "person",
        }));
      await untilWaiting(decideName);
      release();
      await gated;
      const settled = await Promise.allSettled([reset, decide]);
      const codes = settled.map((x) => (x.status === "rejected" ? codeOf(x.reason) ?? String(x.reason) : "ok"));
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
    }, 60_000);
  }

  /* A PERSON'S PAUSE OF A LEARNED RULE beside a move that overrides its route. The move takes the
     change-log counter and then the graduation's row, as an approval and the decision do, so the
     pause ends the graduation after its own delta. The gate parks the move between the two (its
     signal insert); the pause then waits on the counter holding nothing the move wants. */
  it("a person's pause of a learned rule and a move that overrides its route: both commit", async () => {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    const sender = `n-${tag}@example.invalid`;
    const patternKey = `sender:${sender}→${NEWS}`;
    await base.db.insert(accounts).values({ id: accountId, name: `lo-pause-${tag}` });
    const [mb] = await base.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `lo-pause-${tag}@example.invalid`, status: "connected",
      organizerRole: "organizer", organizeConsentedAt: CONNECT,
    }).returning();
    await base.db.insert(accountSyncState).values({ accountId, nextSeq: 0n }).onConflictDoNothing();
    await base.db.insert(graduations).values({
      accountId, patternKey, action: "route", positives: 3, negatives: 0, graduated: true, graduatedAt: CONNECT,
    });
    const [rule] = await base.db.insert(rules).values({
      accountId, kind: "sender", match: sender, destination: NEWS, priority: 0, enabled: true, provenance: "promoted",
    }).returning({ id: rules.id });
    const [m] = await base.db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `p-${tag}`, dedupKey: `p:${tag}`, subject: "the weekly digest",
      fromAddress: sender, nativeLocator: { folder: NEWS, ref: "4:1" },
    }).returning();
    await base.db.insert(folderState).values({
      messageId: m!.id, desiredFolder: NEWS, observedFolder: NEWS, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    const gate = open(`lo-pgate-${tag}`);
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const gated = gate.db.transaction(async (tx) => {
      await tx.execute(sql`lock table learning_signals in share mode`);
      held();
      await released;
      throw new Error("gate rolled back");
    }).catch(() => undefined);
    await holding;
    const ctxOn = (name: string): ServiceContext =>
      ({ db: open(name).db, accountId, userId: null, now: () => NOW, requestId: name }) as unknown as ServiceContext;
    const moveName = `lo-move-${tag}`;
    const pauseName = `lo-pause-${tag}`;
    const move = new MessageService().move(ctxOn(moveName), m!.id, { folder: "INBOX" });
    await untilWaiting(moveName);
    const pause = new RulesService().update(ctxOn(pauseName), rule!.id, { enabled: false } as never);
    await untilWaiting(pauseName);
    release();
    await gated;
    const settled = await Promise.allSettled([move, pause]);
    const codes = settled.map((x) => (x.status === "rejected" ? codeOf(x.reason) ?? String(x.reason) : "ok"));
    expect(codes, "a writer failed").toEqual(["ok", "ok"]);

    const [g] = await base.db.select().from(graduations)
      .where(and(eq(graduations.accountId, accountId), eq(graduations.patternKey, patternKey)));
    expect({ graduated: g!.graduated, positives: g!.positives, negatives: g!.negatives }).toEqual({ graduated: false, positives: 0, negatives: 0 });
    const [r] = await base.db.select().from(rules).where(eq(rules.id, rule!.id));
    expect({ enabled: r!.enabled, stamped: r!.personDecidedAt !== null }).toEqual({ enabled: false, stamped: true });
  }, 60_000);

  /* ── A LEARNED ROUTE'S WRITERS, PAIRWISE, EACH ORDER ─────────────────────────────────────
     A route graduated to News with its promoted rule on and one message it filed. A race parks
     the first writer at a named statement, starts the second until it waits too, then lets both
     go. The two demotion pairs read 40P01 before the override's switch-off left the move. */
  async function learnedRoute(opts: { priorOverride: boolean; positives: number; negatives: number }) {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    const sender = `n-${tag}@example.invalid`;
    const patternKey = `sender:${sender}→${NEWS}`;
    await base.db.insert(accounts).values({ id: accountId, name: `lo-learned-${tag}` });
    const [mb] = await base.db.insert(mailboxes).values({
      accountId, provider: "imap", address: `lo-l-${tag}@example.invalid`, status: "connected",
      organizerRole: "organizer", organizeConsentedAt: CONNECT,
    }).returning();
    await base.db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
    await base.db.insert(accountSyncState).values({ accountId, nextSeq: 0n }).onConflictDoNothing();
    await base.db.insert(graduations).values({
      accountId, patternKey, action: "route", positives: opts.positives, negatives: opts.negatives, graduated: true, graduatedAt: CONNECT,
    });
    const [rule] = await base.db.insert(rules).values({
      accountId, kind: "sender", match: sender, destination: NEWS, priority: 0, enabled: true, provenance: "promoted",
    }).returning({ id: rules.id });
    if (opts.priorOverride) {
      await base.db.insert(learningSignals).values({
        accountId, triggeringActionId: `move:prior-${tag}:1`, kind: "external_move", senderAddress: sender,
        senderDomain: null, destination: NEWS, label: "negative",
      });
    }
    const [m] = await base.db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `l-${tag}`, dedupKey: `l:${tag}`, subject: "the weekly digest",
      fromAddress: sender, nativeLocator: { folder: NEWS, ref: "4:1" },
    }).returning();
    await base.db.insert(folderState).values({
      messageId: m!.id, desiredFolder: NEWS, observedFolder: NEWS, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    const ctxOn = (name: string): ServiceContext =>
      ({ db: open(name).db, accountId, userId: null, now: () => NOW, requestId: name }) as unknown as ServiceContext;
    const state = async () => {
      const [g] = await base.db.select().from(graduations)
        .where(and(eq(graduations.accountId, accountId), eq(graduations.patternKey, patternKey)));
      const [r] = await base.db.select().from(rules).where(eq(rules.id, rule!.id));
      return {
        graduated: g!.graduated, enabled: r!.enabled, stamped: r!.personDecidedAt !== null, demotions: r!.demotions,
      };
    };
    return { accountId, tag, sender, patternKey, ruleId: rule!.id, messageId: m!.id, mailboxId: mb!.id, ctxOn, state };
  }

  type Side = readonly [name: string, run: () => Promise<unknown>];
  /** The gate holds `statement`; `a` starts and waits, `b` starts and waits, both are released. */
  async function race(statement: SQL, a: Side, b: Side): Promise<string[]> {
    const gate = open(`lo-gate-${randomUUID().slice(0, 8)}`);
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const gated = gate.db.transaction(async (tx) => {
      await tx.execute(statement);
      held();
      await released;
      throw new Error("gate rolled back");
    }).catch(() => undefined);
    await holding;
    const settle = (p: Promise<unknown>): Promise<string> =>
      p.then(() => "ok", (e: unknown) => codeOf(e) ?? String(e));
    const first = settle(a[1]());
    await untilWaiting(a[0]);
    const second = settle(b[1]());
    await untilWaiting(b[0]);
    release();
    await gated;
    return Promise.all([first, second]);
  }
  const holdSignals = sql`lock table learning_signals in share mode`;
  const holdCounter = (accountId: string): SQL => sql`select 1 from account_sync_state where account_id = ${accountId} for update`;

  for (const first of ["move", "pause"] as const) {
    it(`a move whose override demotes the route and a person's pause of its rule, the ${first} first: both commit`, async () => {
      const w = await learnedRoute({ priorOverride: true, positives: 3, negatives: 0 });
      const move: Side = [`lo-mv-${w.tag}`, () => new MessageService().move(w.ctxOn(`lo-mv-${w.tag}`), w.messageId, { folder: "INBOX" })];
      const pause: Side = [`lo-pz-${w.tag}`, () => new RulesService().update(w.ctxOn(`lo-pz-${w.tag}`), w.ruleId, { enabled: false } as never)];
      const codes = first === "move" ? await race(holdSignals, move, pause) : await race(holdCounter(w.accountId), pause, move);
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
      expect(await w.state()).toMatchObject({ graduated: false, enabled: false, stamped: true });
    }, 60_000);
  }

  for (const first of ["move", "demotion"] as const) {
    it(`a move that overrides the route and its lifetime demotion, the ${first} first: both commit`, async () => {
      const w = await learnedRoute({ priorOverride: false, positives: 3, negatives: 5 });
      const move: Side = [`lo-mv-${w.tag}`, () => new MessageService().move(w.ctxOn(`lo-mv-${w.tag}`), w.messageId, { folder: "INBOX" })];
      const demote: Side = [`lo-dm-${w.tag}`, () => new LearningService().promoteOrDemote(w.ctxOn(`lo-dm-${w.tag}`), w.patternKey)];
      const codes = first === "move" ? await race(holdSignals, move, demote) : await race(holdCounter(w.accountId), demote, move);
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
      expect(await w.state()).toMatchObject({ graduated: false, enabled: false, stamped: false, demotions: 1 });
    }, 60_000);
  }

  /** A pending routing card for the route's message, as the pipeline enqueues one. */
  async function cardFor(w: { accountId: string; messageId: string }, folder: string): Promise<string> {
    const [rd] = await base.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: w.messageId, inputProvenance: "ai", destination: folder, confidence: 0.6, status: "pending_approval",
    }).returning();
    const [a] = await base.db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId: w.messageId, routingDecisionId: rd!.id, action: "move",
      summary: `Route to ${folder}`, payload: { folder }, confidence: 0.6, status: "pending",
    }).returning({ id: approvals.id });
    return a!.id;
  }
  /** Put the route's message where `folder` says, desired and observed. */
  async function placed(messageId: string, folder: string): Promise<void> {
    await base.db.update(folderState).set({ desiredFolder: folder, observedFolder: folder }).where(eq(folderState.messageId, messageId));
  }

  for (const first of ["approval", "pause"] as const) {
    for (const decision of ["approve", "reject"] as const) {
      it(`an approval (${decision}) and a person's pause of the learned rule, the ${first} first: both commit`, async () => {
        const w = await learnedRoute({ priorOverride: false, positives: 3, negatives: 0 });
        await placed(w.messageId, "INBOX");
        const card = await cardFor(w, NEWS);
        const approval: Side = [`lo-ap-${w.tag}`, () => new ApprovalService({}).decide(w.ctxOn(`lo-ap-${w.tag}`), card, { decision })];
        const pause: Side = [`lo-pz-${w.tag}`, () => new RulesService().update(w.ctxOn(`lo-pz-${w.tag}`), w.ruleId, { enabled: false } as never)];
        const codes = first === "approval" ? await race(holdSignals, approval, pause) : await race(holdCounter(w.accountId), pause, approval);
        expect(codes, "a writer failed").toEqual(["ok", "ok"]);
        expect(await w.state(), "the person's pause did not stand").toMatchObject({ enabled: false, stamped: true });
      }, 60_000);
    }
  }

  for (const first of ["approval", "decision"] as const) {
    it(`an approval and a Screener decision on one held message, the ${first} first: both commit`, async () => {
      const w = await learnedRoute({ priorOverride: false, positives: 0, negatives: 0 });
      await base.db.delete(rules).where(eq(rules.id, w.ruleId));
      await placed(w.messageId, SCREENER);
      const card = await cardFor(w, NEWS);
      const ddb = open(`lo-dc-${w.tag}`).db;
      const approval: Side = [`lo-ap-${w.tag}`, () => new ApprovalService({}).decide(w.ctxOn(`lo-ap-${w.tag}`), card, { decision: "approve" })];
      const decide: Side = [`lo-dc-${w.tag}`, () => ddb.transaction(async (raw) => applyScreenerDecision(carryDialect(ddb, raw as object) as unknown as Tx, {
        accountId: w.accountId, scope: "sender", address: w.sender, appliedFolder: "INBOX", decision: "yes", stampBaseline: false,
        triggeringActionId: `screener:lo-${w.tag}`, now: NOW, overExisting: "converge", decidedBy: "person",
      }))];
      const codes = first === "approval" ? await race(holdSignals, approval, decide) : await race(holdCounter(w.accountId), decide, approval);
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
    }, 60_000);
  }

  for (const first of ["approval", "move"] as const) {
    it(`an approval and an in-app move of one message, the ${first} first: both commit`, async () => {
      const w = await learnedRoute({ priorOverride: false, positives: 0, negatives: 0 });
      await placed(w.messageId, "INBOX");
      const card = await cardFor(w, NEWS);
      const approval: Side = [`lo-ap-${w.tag}`, () => new ApprovalService({}).decide(w.ctxOn(`lo-ap-${w.tag}`), card, { decision: "approve" })];
      const move: Side = [`lo-mv-${w.tag}`, () => new MessageService().move(w.ctxOn(`lo-mv-${w.tag}`), w.messageId, { folder: "ohmail/Receipts" })];
      const codes = first === "approval" ? await race(holdCounter(w.accountId), approval, move) : await race(holdCounter(w.accountId), move, approval);
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
    }, 60_000);
  }

  /* AN APPROVAL AND A PATCH THAT MARKS READ AND FILES ONE MESSAGE: each writes the message's
     `folder_state` row before the change-log counter. Parked at the counter, the first holds the row
     and the second queues behind it, holding nothing the first wants. */
  for (const first of ["patch", "approval"] as const) {
    it(`an approval and a patch that reads and files one message, the ${first} first: both commit`, async () => {
      const w = await learnedRoute({ priorOverride: false, positives: 0, negatives: 0 });
      await placed(w.messageId, "INBOX");
      const card = await cardFor(w, NEWS);
      const approval: Side = [`lo-ap-${w.tag}`, () => new ApprovalService({}).decide(w.ctxOn(`lo-ap-${w.tag}`), card, { decision: "approve" })];
      const patch: Side = [`lo-pt-${w.tag}`, () => new MessageService().patch(w.ctxOn(`lo-pt-${w.tag}`), w.messageId, { unread: false, folder: "ohmail/Receipts" })];
      const codes = first === "patch" ? await race(holdCounter(w.accountId), patch, approval) : await race(holdCounter(w.accountId), approval, patch);
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
    }, 60_000);
  }

  for (const first of ["pause", "decision"] as const) {
    it(`a person's pause of a learned rule and a Screener decision on its sender, the ${first} first: both commit`, async () => {
      const w = await learnedRoute({ priorOverride: false, positives: 3, negatives: 0 });
      const ddb = open(`lo-dc-${w.tag}`).db;
      const decide: Side = [`lo-dc-${w.tag}`, () => ddb.transaction(async (raw) => applyScreenerDecision(carryDialect(ddb, raw as object) as unknown as Tx, {
        accountId: w.accountId, scope: "sender", address: w.sender, appliedFolder: NEWS, decision: "yes", stampBaseline: false,
        triggeringActionId: `screener:lo-${w.tag}`, now: NOW, overExisting: "converge", decidedBy: "person",
      }))];
      const pause: Side = [`lo-pz-${w.tag}`, () => new RulesService().update(w.ctxOn(`lo-pz-${w.tag}`), w.ruleId, { enabled: false } as never)];
      const codes = first === "pause" ? await race(holdCounter(w.accountId), pause, decide) : await race(holdCounter(w.accountId), decide, pause);
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
      expect((await w.state()).stamped, "neither left the person's stamp").toBe(true);
    }, 60_000);
  }

  /* ── THE INGEST'S OVERRIDE, THROUGH THE REAL WORKER COMMIT ───────────────────────────────
     The fake reports the route's message moved to INBOX in another client; `runSyncCycle`
     adopts it, records the override and, after its commit, runs the switch-off it owes. */
  async function ingestCycle(w: Awaited<ReturnType<typeof learnedRoute>>, fleet: FakeAdapterFleet, name: string) {
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: w.accountId, mailboxId: w.mailboxId, onConnectionError: () => {} },
    );
    return runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(open(name).db as never), adapter,
      accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
      trustedAuthservIds: new Set<string>(),
    });
  }
  /** The route's message, delivered into the route's folder by a first cycle. */
  async function deliveredByTheRoute(w: Awaited<ReturnType<typeof learnedRoute>>) {
    await base.db.delete(folderState).where(eq(folderState.messageId, w.messageId));
    await base.db.delete(messages).where(eq(messages.id, w.messageId));
    const fleet = new FakeAdapterFleet();
    const m = { from: w.sender, subject: "the weekly digest", messageId: `lo-in-${w.tag}@example.invalid` };
    fleet.behave(w.mailboxId, { deliver: [{ ...m, folder: NEWS }] });
    await ingestCycle(w, fleet, `lo-c1-${w.tag}`);
    fleet.behave(w.mailboxId, { deliver: [], externalMoves: [{ ...m, toFolder: "INBOX", uid: 77 }] });
    return fleet;
  }

  it("the ingest's override switches the learned rule off after its commit (the worker's door is real)", async () => {
    const w = await learnedRoute({ priorOverride: true, positives: 3, negatives: 0 });
    const fleet = await deliveredByTheRoute(w);
    await ingestCycle(w, fleet, `lo-c2-${w.tag}`);
    expect(await w.state(), "the rule is still on after the worker's commit").toMatchObject({ graduated: false, enabled: false, demotions: 1 });
    const deltas = await base.db.select({ id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "rule"), eq(changeLog.op, "update")));
    expect(deltas.map((d) => d.id), "the switch-off is announced").toEqual([w.ruleId]);
  }, 60_000);

  it("a switch-off that fails after the ingest's commit is logged by name, and the ingest stands", async () => {
    const w = await learnedRoute({ priorOverride: true, positives: 3, negatives: 0 });
    const fleet = await deliveredByTheRoute(w);
    const log = capture();
    const real = makeDrizzleRepo(open(`lo-c2f-${w.tag}`).db as never);
    const failing = Object.assign(Object.create(real) as object, {
      demoteRoute: async () => { throw new Error("the door is down"); },
    }) as unknown as typeof real;
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: w.accountId, mailboxId: w.mailboxId, onConnectionError: () => {} },
    );
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: failing, adapter, log,
      accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
      trustedAuthservIds: new Set<string>(),
    });
    expect(log.lines.map((l) => l.event), "the failed switch-off was not named").toContain("sync_route_demotion_failed");
    const [fs] = await base.db.select({ desired: folderState.desiredFolder }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.accountId, w.accountId), eq(messages.fromAddress, w.sender)));
    expect(fs, "the person's move was not adopted").toEqual({ desired: "INBOX" });
    expect(await w.state(), "the switch-off ran although the door failed").toMatchObject({ enabled: true });
  }, 60_000);

  for (const first of ["ingest", "pause"] as const) {
    it(`the ingest's override and a person's pause of the learned rule, the ${first} first: both commit`, async () => {
      const w = await learnedRoute({ priorOverride: true, positives: 3, negatives: 0 });
      const fleet = await deliveredByTheRoute(w);
      const ingest: Side = [`lo-c2-${w.tag}`, () => ingestCycle(w, fleet, `lo-c2-${w.tag}`)];
      const pause: Side = [`lo-pz-${w.tag}`, () => new RulesService().update(w.ctxOn(`lo-pz-${w.tag}`), w.ruleId, { enabled: false } as never)];
      const codes = first === "ingest" ? await race(holdSignals, ingest, pause) : await race(holdCounter(w.accountId), pause, ingest);
      expect(codes, "a writer failed").toEqual(["ok", "ok"]);
      expect(await w.state(), "the person's pause did not stand").toMatchObject({ graduated: false, enabled: false, stamped: true });
    }, 60_000);
  }
});
