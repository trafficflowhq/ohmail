import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, organizerRequests, ruleCreatePayload, rules } from "@trafficflow/db";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";

/**
 * AN OLDER READER'S RULE ABOUT THE ACCOUNT ITSELF IS REFUSED BY THE ORGANIZER (SENDER-SHEET-
 * OFFERED-ON-OUR-OWN-MAIL). A build before the press doors refused it can still queue a
 * `rule.create` or a `screener.decide` keyed on one of the account's own addresses; the organizer's
 * apply refuses both as `invalid_payload` and writes no rule. The rows are queued by hand, as such a
 * build left them; a create about somebody else, queued the same way, is applied (the control).
 */
const ACCT = "00000000-0000-0000-0000-0000000000e5";
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

const create = (match: string) => ruleCreatePayload({
  key: { kind: "sender", match, subjectContains: null, bodyContains: null }, destination: "screened", enabled: true, applyRetro: true,
});

describe("a request about the account's own address, from a build that did not refuse it", () => {
  it("a rule.create keyed on it is refused invalid_payload and the organizer writes no rule", async () => {
    const w = await world();
    await w.queueByHand("rule.create", create(" Held@Mailbox.example "), at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["rule.create:refused(invalid_payload)"]);
    expect(await w.laptopRules()).toEqual([]);
  });

  it("a screener.decide about it is refused invalid_payload and promotes no rule", async () => {
    const w = await world();
    await w.queueByHand("screener.decide", {
      scope: "sender", address: ADDRESS, appliedFolder: "ohmail/Screened", decision: "no", match: ADDRESS, applyRetro: true,
    }, at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["screener.decide:refused(invalid_payload)"]);
    expect(await w.laptopRules()).toEqual([]);
  });

  it("the same create about somebody else is applied (the positive control)", async () => {
    const w = await world();
    await w.queueByHand("rule.create", create("bob@shop.example"), at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["rule.create:applied"]);
    expect(await w.laptopRules()).toEqual(["bob@shop.example"]);
  });
});
