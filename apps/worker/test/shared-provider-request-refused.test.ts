import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, applyScreenerDecision, folderState, mailboxes, messages, organizerRequests, reconcileRuleCreate,
  ruleCreatePayload, rules, SharedProviderDomainError, type Tx,
} from "@trafficflow/db";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";

/**
 * A REQUEST FOR EVERYONE AT A SHARED PROVIDER IS REFUSED BY THE ORGANIZER (mail 0148, acceptance 11).
 * A build before the doors refused it can still queue a `rule.create` letting everyone at gmail.com
 * in, or a `screener.decide` at domain scope there; the organizer's apply refuses both as
 * `invalid_payload` and writes no rule. Queued by hand, as such a build left them; a firm's domain
 * and a deny rule at gmail.com, queued the same way, are applied (the controls). Then the key
 * writer's belt, under every validator: a domain yes at gmail.com reaching it writes nothing.
 */
const ACCT = "00000000-0000-0000-0000-0000000000e7";
const t0 = new Date("2026-10-06T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const ADDRESS = "held@mailbox.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "the-shared-password" }, address: ADDRESS })!;

async function world() {
  const here = await makeTestDb();
  const laptop = await makeTestDb();
  const store = new Map<number, string>();
  let next = 1;
  const list = async (): Promise<MetaRecordsList> => {
    const records: RawMetaMessage[] = [...store.entries()].map(([ref, raw]) => ({ ref, raw }));
    return { records, count: records.length, bytes: records.reduce((n, r) => n + r.raw.length, 0) };
  };
  const reader = { listMetaRecords: list, async append(raw: string) { store.set(next++, raw); } } as RequestReaderIo;
  const organizer = {
    listMetaRecords: list, uidValidity: () => 7_000,
    async ack(raw: string) { store.set(next++, raw); },
    async remove(refs: readonly unknown[]) { for (const r of refs) if (typeof r === "number") store.delete(r); },
  } as RequestOrganizerIo;
  const held = randomUUID();
  await here.insert(mailboxes).values({
    id: held, accountId: ACCT, provider: "imap", address: ADDRESS, organizerRole: "reader",
    organizerState: "held", organizedByCapabilities: "requests,rules", organizedByKind: "local", organizedByName: "laptop",
  });
  await laptop.insert(mailboxes).values({ id: held, accountId: ACCT, provider: "imap", address: ADDRESS });
  const readerCycle = (t: number) => driveOutstandingRequests(here, {
    mailboxId: held, accountId: ACCT, installId: "reader-install",
    adapter: { requestReaderIo: () => reader } as unknown as MailboxAdapter, requestKey: KEY,
  }, { installId: "reader-install", kind: "local" as const }, at(t), () => undefined);
  const laptopCycle = (t: number) => applyMetaRequests(laptop, {
    mailboxId: held, accountId: ACCT, installId: "laptop-install",
    adapter: { requestOrganizerIo: () => organizer } as unknown as MailboxAdapter, requestKey: KEY,
  }, at(t), () => undefined);
  const queueByHand = (kind: string, payload: unknown, decidedAt: Date) => here.insert(organizerRequests)
    .values({ id: randomUUID(), accountId: ACCT, mailboxId: held, kind, payload, decidedAt, state: "pending" });
  const states = async () => (await here.select({ kind: organizerRequests.kind, state: organizerRequests.state, why: organizerRequests.refusedReason })
    .from(organizerRequests).where(eq(organizerRequests.accountId, ACCT))).map((r) => `${r.kind}:${r.state}${r.why ? `(${r.why})` : ""}`).sort();
  const laptopRules = async () => (await laptop.select({ match: rules.match }).from(rules).where(eq(rules.accountId, ACCT))).map((r) => r.match);
  const round = async (t: number) => { await readerCycle(t); await laptopCycle(t + 1); await readerCycle(t + 2); };
  return { queueByHand, states, laptopRules, round };
}

const create = (kind: string, match: string, destination: string) => ruleCreatePayload({
  key: { kind, match, subjectContains: null, bodyContains: null }, destination, enabled: true, applyRetro: true,
});

describe("a request for everyone at a shared provider, from a build that did not refuse it", () => {
  it("a rule.create letting everyone at gmail.com in is refused invalid_payload; no rule is written", async () => {
    const w = await world();
    await w.queueByHand("rule.create", create("domain", " GMAIL.com ", "inbox"), at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["rule.create:refused(invalid_payload)"]);
    expect(await w.laptopRules()).toEqual([]);
  });

  it("a screener.decide yes at domain scope on gmail.com is refused invalid_payload", async () => {
    const w = await world();
    await w.queueByHand("screener.decide", {
      scope: "domain", address: personalAt("fixture.mila", "gmail.com"), appliedFolder: "INBOX", decision: "yes", match: "gmail.com", applyRetro: true,
    }, at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["screener.decide:refused(invalid_payload)"]);
    expect(await w.laptopRules()).toEqual([]);
  });

  it("CONTROLS: a firm's domain and a deny rule at gmail.com are applied", async () => {
    const w = await world();
    await w.queueByHand("rule.create", create("domain", "firma.example", "inbox"), at(1));
    await w.queueByHand("rule.create", create("domain", "gmail.com", "screened"), at(1.5));
    await w.round(2);
    expect(await w.states()).toEqual(["rule.create:applied", "rule.create:applied"]);
    expect((await w.laptopRules()).sort()).toEqual(["firma.example", "gmail.com"]);
  });
});

describe("the key writer's belt, under every validator", () => {
  async function bench() {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `belt-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@x.example` }).returning();
    const held = async (from: string) => {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `belt:${randomUUID()}`, subject: "hello", fromAddress: from,
        senderCheck: "none", nativeLocator: { folder: "ohmail/Screener", ref: `1:${randomUUID().slice(0, 6)}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };
    type InTx = (f: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
    const inTx = (db as unknown as { transaction: InTx }).transaction.bind(db) as InTx;
    const decide = (address: string, id: string) => inTx((tx) => applyScreenerDecision(tx, {
      accountId, scope: "domain", address, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:belt:${id}`, now: new Date(), stampBaseline: false, applyRetro: true,
      overExisting: "converge", liftOverDomain: false, decidedBy: "person",
    } as never));
    const ruleMatches = async () => (await db.select({ match: rules.match }).from(rules).where(eq(rules.accountId, accountId))).map((r) => r.match);
    return { held, decide, ruleMatches };
  }

  it("the create door itself throws by name for an allow rule at gmail.com; a deny there is created", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `door-${accountId.slice(0, 8)}` });
    type InTx = (f: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
    const inTx = (db as unknown as { transaction: InTx }).transaction.bind(db) as InTx;
    const door = (destination: string) => inTx((tx) => reconcileRuleCreate(tx, {
      accountId, now: new Date(),
      create: { op: "create", key: { kind: "domain", match: "gmail.com", subjectContains: null, bodyContains: null }, destination, enabled: true, applyRetro: false },
    } as never));
    expect(await door("INBOX").then(() => null, (e: unknown) => e)).toBeInstanceOf(SharedProviderDomainError);
    expect(await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, accountId))).toHaveLength(0);
    await door("ohmail/Screened");
    expect(await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, accountId))).toHaveLength(1);
  });

  it("a domain yes at gmail.com reaching the writer throws by name and writes no rule", async () => {
    const b = await bench();
    const id = await b.held(personalAt("fixture.nadja", "gmail.com"));
    const err = await b.decide(personalAt("fixture.nadja", "gmail.com"), id).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SharedProviderDomainError);
    expect(await b.ruleMatches()).toEqual([]);
  });

  it("CONTROL: a domain yes at a firm's domain is written", async () => {
    const b = await bench();
    const id = await b.held("anna@firma.example");
    await b.decide("anna@firma.example", id);
    expect(await b.ruleMatches()).toEqual(["firma.example"]);
  });
});
