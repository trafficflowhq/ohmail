import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { changeLog, eraseOwedMailbox, mailboxes, organizerRequests, rules, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { StaticKeyProvider } from "@trafficflow/core";
import { MailboxService, RulesService, type PatchRuleBody, type ServiceContext } from "@trafficflow/services";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests, settleOwnOutstandingRequests } from "../src/request-drain.js";
import { clearOrganizerStandDown } from "../src/mailboxes.js";

/**
 * A READER'S RULE ROW STATES ONLY WHAT EVERY HOLDER ITS PRESS WENT TO HAS CARRIED OUT. One reader
 * install, one organizer per held mailbox, one `ohmail/_meta` per mailbox; real doors throughout.
 * The rows under the key move in the cycle that finishes the press's last leg — never at the first
 * ack while another holder still runs the old rule. The clock ticks per call, as production's does,
 * so the press's one `decidedAt` is what ties its legs together.
 */
const ACCT = "00000000-0000-0000-0000-0000000000e6";
const t0 = new Date("2026-10-03T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const READER = { installId: "reader-install", kind: "local" as const };
const DAY = 25 * 60;
const svc = new RulesService();
const mbx = new MailboxService({ keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1), allowance: async () => {} });
type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

function sharedMeta() {
  const store = new Map<number, string>();
  let next = 1;
  const list = async (): Promise<MetaRecordsList> => {
    const records: RawMetaMessage[] = [...store.entries()].map(([ref, raw]) => ({ ref, raw }));
    return { records, count: records.length, bytes: records.reduce((n, r) => n + r.raw.length, 0) };
  };
  return {
    reader: { listMetaRecords: list, async append(raw: string) { store.set(next++, raw); } } as RequestReaderIo,
    organizer: {
      listMetaRecords: list, uidValidity: () => 7_000,
      async ack(raw: string) { store.set(next++, raw); },
      async remove(refs: readonly unknown[]) { for (const r of refs) if (typeof r === "number") store.delete(r); },
    } as RequestOrganizerIo,
  };
}

const ANN = { accountId: ACCT, kind: "sender", match: "ann@shop.example", priority: 0, enabled: true, provenance: "manual" };

/** One entry per held mailbox: whether its holder takes `rule.*`, and Ann's rule there (or none). */
async function world(holders: Array<{ rules?: boolean; has: string | null }>, readerRows: string[]) {
  const here = await makeTestDb();
  const log: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const legs: Array<{
    id: string; address: string; laptop: TestDb; readerCycle: (t: number) => Promise<unknown>;
    laptopCycle: (t: number) => Promise<unknown>; round: (t: number) => Promise<void>;
    hereCycle: (t: number) => Promise<unknown>;
  }> = [];
  for (let i = 0; i < holders.length; i++) {
    const address = `held${i}@mailbox.example`;
    const key = deriveRequestKey({ auth: { user: address, pass: "the-shared-password" }, address })!;
    const id = randomUUID();
    const laptop = await makeTestDb();
    await here.insert(mailboxes).values({
      id, accountId: ACCT, provider: "imap", address, organizerRole: "reader", organizerState: "held",
      organizedByCapabilities: holders[i]!.rules === false ? "requests" : "requests,rules",
      organizedByKind: "local", organizedByName: `laptop${i}`,
    });
    await laptop.insert(mailboxes).values({ id, accountId: ACCT, provider: "imap", address });
    if (holders[i]!.has) await laptop.insert(rules).values({ ...ANN, destination: holders[i]!.has! });
    const m = sharedMeta();
    const readerCycle = (t: number) => driveOutstandingRequests(here, { mailboxId: id, accountId: ACCT, installId: READER.installId, adapter: { requestReaderIo: () => m.reader } as unknown as MailboxAdapter, requestKey: key }, READER, at(t), (event, detail) => { log.push({ event, detail }); });
    const laptopCycle = (t: number) => applyMetaRequests(laptop, { mailboxId: id, accountId: ACCT, installId: `laptop${i}`, adapter: { requestOrganizerIo: () => m.organizer } as unknown as MailboxAdapter, requestKey: key }, at(t), () => undefined);
    /** This install organizing the mailbox after a takeover. */
    const hereCycle = (t: number) => applyMetaRequests(here, { mailboxId: id, accountId: ACCT, installId: READER.installId, adapter: { requestOrganizerIo: () => m.organizer } as unknown as MailboxAdapter, requestKey: key }, at(t), () => undefined);
    /** Send, apply on this holder, read the ack. */
    const round = async (t: number) => { await readerCycle(t); await laptopCycle(t + 1); await readerCycle(t + 2); };
    legs.push({ id, address, laptop, readerCycle, laptopCycle, round, hereCycle });
  }
  for (const d of readerRows) await here.insert(rules).values({ ...ANN, destination: d, updatedAt: at(0) });
  let clock = at(1);
  // Production's `now: () => new Date()`: every call is a fresh instant.
  const ctx = {
    db: here, accountId: ACCT, userId: null, requestId: "r",
    now: () => (clock = new Date(clock.getTime() + 1)),
  } as ServiceContext;
  const rowsOf = async (db: TestDb) => (await db.select({ d: rules.destination }).from(rules).where(eq(rules.accountId, ACCT))).map((r) => r.d).sort();
  const deletes = async () => (await here.select().from(changeLog)
    .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule"), eq(changeLog.op, "delete")))).length;
  const states = async () => (await here.select({ m: organizerRequests.mailboxId, kind: organizerRequests.kind, state: organizerRequests.state, why: organizerRequests.refusedReason })
    .from(organizerRequests).where(eq(organizerRequests.accountId, ACCT)))
    .map((r) => `${legs.findIndex((l) => l.id === r.m)}:${r.state}${r.why ? `(${r.why})` : ""}`).sort();
  const firstId = async () => (await here.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCT)))[0]!.id;
  const unfinished = () => log.filter((l) => l.event === "reader_rule_settle_skipped" && l.detail.reason === "press_unfinished").length;
  const ruleDeltas = async () => (await here.select().from(changeLog)
    .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule")))).length;
  return { here, legs, ctx, rowsOf, deletes, ruleDeltas, states, firstId, unfinished, log, setClock: (t: number) => { clock = at(t); } };
}
type World = Awaited<ReturnType<typeof world>>;

/** Holder 1's leg is sent and unanswered while holder 0 applies and its ack is read. */
async function firstAckWhileTheOtherIsSent(w: World) {
  await w.legs[1]!.readerCycle(2);
  await w.legs[0]!.round(3);
}

describe("two holders: the reader's row waits for the second", () => {
  it("delete: the row stays at the first ack and goes in the cycle that reads the last", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await firstAckWhileTheOtherIsSent(w);
    expect(await w.states()).toEqual(["0:applied", "1:sent"]);
    expect(await w.rowsOf(w.here), "the row went while holder 1 still runs the rule").toEqual(["ohmail/News"]);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual(["ohmail/News"]);
    expect(w.unfinished(), "the early ack is logged once").toBe(1);
    await w.legs[1]!.laptopCycle(6); await w.legs[1]!.readerCycle(7);
    expect(await w.states()).toEqual(["0:applied", "1:applied"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
  });

  it("update: the row keeps the old destination until both holders file to the new one", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
    await firstAckWhileTheOtherIsSent(w);
    expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual(["ohmail/Receipts"]);
    expect(await w.rowsOf(w.here), "the row moved while holder 1 still files to News").toEqual(["ohmail/News"]);
    await w.legs[1]!.laptopCycle(6); await w.legs[1]!.readerCycle(7);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
  });

  it("create: the row appears only once both holders have made the rule", async () => {
    const w = await world([{ has: null }, { has: null }], []);
    await svc.create(w.ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/Receipts" });
    await firstAckWhileTheOtherIsSent(w);
    expect(await w.rowsOf(w.here), "the row appeared while holder 1 has no such rule").toEqual([]);
    await w.legs[1]!.laptopCycle(6); await w.legs[1]!.readerCycle(7);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
  });

  it("CONTROL: an update leg refused no_such_rule does not finish it — only a delete's does", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: null }], ["ohmail/News"]);
    await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
    await w.legs[1]!.round(2);
    await w.legs[0]!.round(5);
    expect(await w.states()).toEqual(["0:applied", "1:refused(no_such_rule)"]);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
  });
});

describe("a delete leg refused no_such_rule finishes its leg", () => {
  for (const order of ["applied first", "refusal first"] as const) {
    it(`order ${order}: {applied, no_such_rule} — the row goes`, async () => {
      const w = await world([{ has: "ohmail/News" }, { has: null }], ["ohmail/News"]);
      await svc.remove(w.ctx, await w.firstId());
      const [a, b] = order === "applied first" ? [0, 1] : [1, 0];
      await w.legs[a]!.round(2);
      expect(await w.rowsOf(w.here), "the row moved before the last leg answered").toEqual(["ohmail/News"]);
      await w.legs[b]!.round(5);
      expect(await w.states()).toEqual(["0:applied", "1:refused(no_such_rule)"]);
      expect(await w.rowsOf(w.here)).toEqual([]);
      expect(await w.deletes()).toBe(1);
    });
  }

  it("{no_such_rule, no_such_rule} — every holder says nothing runs there, the row goes", async () => {
    const w = await world([{ has: null }, { has: null }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    expect(await w.rowsOf(w.here), "the row went before the second holder answered").toEqual(["ohmail/News"]);
    await w.legs[1]!.round(5);
    expect(await w.states()).toEqual(["0:refused(no_such_rule)", "1:refused(no_such_rule)"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
    // The first refusal is read while the second leg is still pending: one early skip, logged once.
    expect(w.unfinished()).toBe(1);
  });
});

describe("an expired leg holds; a holder refused at the press does not", () => {
  it("{applied, expired} keeps the row; a re-press then completes and the row goes", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    await w.legs[1]!.readerCycle(5);
    await w.legs[1]!.readerCycle(5 + DAY);
    expect(await w.states()).toEqual(["0:applied", "1:expired"]);
    expect(await w.rowsOf(w.here), "an expired leg let the row go").toEqual(["ohmail/News"]);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual(["ohmail/News"]);
    // The person presses Remove again: holder 0 has nothing under the key, holder 1 applies.
    w.setClock(DAY + 9);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(DAY + 10);
    await w.legs[1]!.round(DAY + 13);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual([]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("a holder that takes no rule request has no leg and holds nothing back", async () => {
    const w = await world([{ has: "ohmail/News" }, { rules: false, has: "ohmail/News" }], ["ohmail/News"]);
    const out = await svc.remove(w.ctx, await w.firstId()) as { travel: { refused: unknown[] } };
    expect(out.travel.refused).toHaveLength(1);
    await w.legs[0]!.round(2);
    expect(await w.states()).toEqual(["0:applied"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("CONTROL: one holder, one applied leg — the row goes in the cycle that reads it", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News", "ohmail/Receipts"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes(), "one delete per twin").toBe(2);
    expect(w.unfinished()).toBe(0);
  });
});

describe("a leg that leaves or answers late does not hold the row for ever", () => {
  /** Remove pressed with both holders running Ann's rule; holder 0 applies, holder 1's leg is sent. */
  async function halfApplied() {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[1]!.readerCycle(2);
    await w.legs[0]!.round(3);
    expect(await w.states()).toEqual(["0:applied", "1:sent"]);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
    return w;
  }

  it("the other mailbox is removed before it answers: the row goes at the removal, no second press", async () => {
    const w = await halfApplied();
    w.setClock(20);
    const out = await mbx.delete(w.ctx, w.legs[1]!.id);
    expect(await w.rowsOf(w.here), "a removed rule no organizer runs is still listed").toEqual([]);
    expect(await w.deletes()).toBe(1);
    expect(out.seq, "the removal echoes the delete's seq").not.toBeNull();
    await w.legs[0]!.readerCycle(21);
    expect(await w.deletes(), "settled once").toBe(1);
  });

  it("the other mailbox is switched off (PATCH disabled) before it answers: the row goes, no second press", async () => {
    const w = await halfApplied();
    w.setClock(20);
    await mbx.update(w.ctx, w.legs[1]!.id, { status: "disabled" });
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
    // A second disable is no leave and asks nothing.
    await mbx.update(w.ctx, w.legs[1]!.id, { status: "disabled" });
    expect(await w.deletes()).toBe(1);
  });

  it("the other mailbox is removed and erased, the sweep run to done: the row goes and stays gone", async () => {
    const w = await halfApplied();
    w.setClock(20);
    await mbx.delete(w.ctx, w.legs[1]!.id, { erase: { confirmAddress: w.legs[1]!.address } });
    expect(await w.rowsOf(w.here)).toEqual([]);
    const run = await eraseOwedMailbox(w.here as unknown as Tx, dialect(w.here), {
      accountId: ACCT, mailboxId: w.legs[1]!.id, now: () => at(21), maxSteps: 10,
    });
    expect(run.done).toBe(true);
    await w.legs[0]!.readerCycle(22);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
  });

  it("the other holder applies after the reader expired its leg: the late ack settles, no second press", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    await w.legs[1]!.readerCycle(5);
    await w.legs[1]!.readerCycle(5 + DAY);
    expect(await w.states()).toEqual(["0:applied", "1:expired"]);
    // The organizer's clock reads 23 h 58 min after the press: inside its own stale window.
    await w.legs[1]!.laptopCycle(23 * 60 + 58);
    await w.legs[1]!.readerCycle(6 + DAY);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual([]);
    expect(await w.states()).toEqual(["0:applied", "1:applied"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
  });

  /** Remove pressed, both legs sent, then holder 1's mailbox is set to `status`, then holder 0's round. */
  async function otherLegLeaves(status: "disabled" | "error") {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.readerCycle(2);
    await w.legs[1]!.readerCycle(2);
    await w.here.update(mailboxes).set({ status }).where(eq(mailboxes.id, w.legs[1]!.id));
    await w.legs[0]!.laptopCycle(3);
    await w.legs[0]!.readerCycle(4);
    expect(await w.states()).toEqual(["0:applied", "1:sent"]);
    return w;
  }

  it("a leg on a disabled mailbox is no leg — the row goes at the live holder's ack", async () => {
    const w = await otherLegLeaves("disabled");
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(w.unfinished()).toBe(0);
  });

  it("CONTROL: a mailbox in error is still live — its unanswered leg holds the row", async () => {
    const w = await otherLegLeaves("error");
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
    expect(w.unfinished()).toBe(1);
  });
});

describe("a press whose every holder left settles in the leaving transaction", () => {
  it("delete: the only holder removed before it answers, the row goes", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.readerCycle(2);
    w.setClock(10);
    const out = await mbx.delete(w.ctx, w.legs[0]!.id);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
    expect(out.seq).not.toBeNull();
  });

  it("update: the only holder removed before it answers, the row takes the new destination", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
    await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
    await w.legs[0]!.readerCycle(2);
    w.setClock(10);
    await mbx.delete(w.ctx, w.legs[0]!.id);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
  });

  it("CONTROL: create, the only holder removed before it answers, still writes no row", async () => {
    const w = await world([{ has: null }], []);
    await svc.create(w.ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/Receipts" });
    await w.legs[0]!.readerCycle(2);
    expect(await w.rowsOf(w.here)).toEqual([]);
    w.setClock(10);
    await mbx.delete(w.ctx, w.legs[0]!.id);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("a removal that finishes a create and a later Remove under one key settles them oldest first: the row goes", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.create(w.ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/Receipts" });
    w.setClock(3);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[1]!.readerCycle(4);
    await w.legs[0]!.round(5);
    expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual([]);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
    w.setClock(20);
    await mbx.delete(w.ctx, w.legs[1]!.id);
    expect(await w.rowsOf(w.here), "the create came back over the later Remove").toEqual([]);
  });

  it("CONTROL: a mailbox whose legs all finished asks nothing, records no delta, and answers without a seq", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    await w.legs[1]!.round(5);
    expect(await w.rowsOf(w.here)).toEqual([]);
    const before = await w.ruleDeltas();
    w.setClock(20);
    const out = await mbx.delete(w.ctx, w.legs[1]!.id);
    expect(out.seq).toBeNull();
    expect(await w.ruleDeltas()).toBe(before);
  });
});

describe("a late answer finishes an expired rule leg; nothing settles at expiry", () => {
  it("CONTROL: a late create answer and a later Remove's answer read in one cycle leave no row", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
    await svc.create(w.ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/Receipts" });
    await w.legs[0]!.readerCycle(2);
    await w.legs[0]!.readerCycle(2 + DAY);
    expect(await w.states()).toEqual(["0:expired"]);
    w.setClock(3 + DAY);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.readerCycle(4 + DAY);
    await w.legs[0]!.laptopCycle(23 * 60 + 58);
    expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual([]);
    await w.legs[0]!.readerCycle(5 + DAY);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("CONTROL: an expired leg with no answer holds the row; a late refusal that does not finish it leaves it expired", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: null }], ["ohmail/News"]);
    await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
    await w.legs[0]!.round(2);
    await w.legs[1]!.readerCycle(5);
    await w.legs[1]!.readerCycle(5 + DAY);
    expect(await w.states()).toEqual(["0:applied", "1:expired"]);
    expect(await w.rowsOf(w.here), "settled at expiry").toEqual(["ohmail/News"]);
    // Holder 1 has no such rule: an update refused no_such_rule does not finish the leg.
    await w.legs[1]!.laptopCycle(23 * 60 + 58);
    await w.legs[1]!.readerCycle(6 + DAY);
    expect(await w.states()).toEqual(["0:applied", "1:expired"]);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
  });

  it("CONTROL: a late answer to an expired screener.decide leaves it expired", async () => {
    const w = await world([{ has: null }], []);
    const id = randomUUID();
    const sender = "bob@shop.example";
    await w.here.insert(organizerRequests).values({
      id, accountId: ACCT, mailboxId: w.legs[0]!.id, kind: "screener.decide",
      payload: { scope: "sender", address: sender, appliedFolder: "INBOX", decision: "yes", match: sender },
      decidedAt: at(1), state: "pending",
    });
    await w.legs[0]!.readerCycle(2);
    await w.legs[0]!.readerCycle(2 + DAY);
    expect(await w.states()).toEqual(["0:expired"]);
    await w.legs[0]!.laptopCycle(23 * 60 + 58);
    expect((await w.legs[0]!.laptop.select().from(rules).where(eq(rules.match, sender))).length, "the holder applied it").toBe(1);
    await w.legs[0]!.readerCycle(3 + DAY);
    expect(await w.states()).toEqual(["0:expired"]);
  });
});

describe("a leave never undoes a later decision, nor applies a press nobody waits on", () => {
  const creates = async (w: World) => (await w.here.select().from(changeLog)
    .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule"), eq(changeLog.op, "create")))).length;
  const ann = { kind: "sender", match: "ann@shop.example", destination: "ohmail/Receipts" } as const;
  const leaves = {
    delete: (w: World, i: number) => mbx.delete(w.ctx, w.legs[i]!.id),
    disable: (w: World, i: number) => mbx.update(w.ctx, w.legs[i]!.id, { status: "disabled" }),
  };

  for (const [door, leave] of Object.entries(leaves)) {
    it(`${door}: an old create expired on the leaving mailbox stays settled under the later Remove`, async () => {
      const w = await world([{ has: null }, { has: null }], []);
      // (1) Created: holder 1 applies, holder 0 is away past the window and later refuses it stale.
      await svc.create(w.ctx, ann);
      await w.legs[0]!.readerCycle(2);
      await w.legs[1]!.round(3);
      await w.legs[0]!.readerCycle(2 + DAY);
      expect(await w.states()).toEqual(["0:expired", "1:applied"]);
      expect(await w.rowsOf(w.here)).toEqual([]);
      // (2) Pressed again: both apply, the row appears.
      w.setClock(DAY + 10);
      await svc.create(w.ctx, ann);
      await w.legs[0]!.round(DAY + 11);
      await w.legs[1]!.round(DAY + 14);
      expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual(["ohmail/Receipts"]);
      expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
      // (3) Removed: both apply, the row goes.
      w.setClock(DAY + 20);
      await svc.remove(w.ctx, await w.firstId());
      await w.legs[0]!.round(DAY + 21);
      await w.legs[1]!.round(DAY + 24);
      expect(await w.rowsOf(w.here)).toEqual([]);
      const before = await creates(w);
      // (4) Holder 0's mailbox leaves.
      w.setClock(DAY + 30);
      await leave(w, 0);
      expect(await w.rowsOf(w.here), "the removed rule came back").toEqual([]);
      expect(await creates(w)).toBe(before);
    });
  }

  for (const variant of ["removed", "switched on and off again"] as const) {
    it(`a create sent to a mailbox switched off before it answered, then Removed: that mailbox ${variant}, no row`, async () => {
      const w = await world([{ has: null }, { has: null }], []);
      await svc.create(w.ctx, ann);
      await w.legs[1]!.readerCycle(2);
      w.setClock(3);
      await mbx.update(w.ctx, w.legs[1]!.id, { status: "disabled" });
      await w.legs[0]!.round(4);
      expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
      w.setClock(10);
      await svc.remove(w.ctx, await w.firstId());
      await w.legs[0]!.round(11);
      expect(await w.rowsOf(w.here)).toEqual([]);
      const before = await creates(w);
      w.setClock(20);
      if (variant === "removed") {
        const out = await mbx.delete(w.ctx, w.legs[1]!.id);
        expect(out.seq).toBeNull();
      } else {
        await mbx.update(w.ctx, w.legs[1]!.id, { status: "connected" });
        await mbx.update(w.ctx, w.legs[1]!.id, { status: "disabled" });
      }
      expect(await w.rowsOf(w.here), "the removed rule came back").toEqual([]);
      expect(await creates(w)).toBe(before);
    });
  }

  for (const [door, leave] of Object.entries(leaves)) {
    it(`${door}: a reader-era Remove expired at the takeover is not applied when that mailbox leaves months later`, async () => {
      const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
      await svc.remove(w.ctx, await w.firstId());
      // The person takes the mailbox over here before the Remove was sent: the flip expires it.
      expect(await clearOrganizerStandDown(w.here as never, w.legs[0]!.id, { now: at(2) })).toBe(true);
      await settleOwnOutstandingRequests(w.here, { mailboxId: w.legs[0]!.id, accountId: ACCT }, at(3), () => undefined);
      expect(await w.states()).toEqual(["0:expired"]);
      expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
      // They keep the rule and connect a second mailbox organized here.
      await w.here.insert(mailboxes).values({ accountId: ACCT, provider: "imap", address: "n@mailbox.example" });
      const before = await w.deletes();
      w.setClock(90 * 24 * 60);
      await leave(w, 0);
      expect(await w.rowsOf(w.here), "the abandoned Remove was applied").toEqual(["ohmail/News"]);
      expect(await w.deletes()).toBe(before);
    });
  }

  for (const [door, leave] of Object.entries(leaves)) {
    it(`${door}: a reader-era create the takeover applied here, then removed here, stays removed when that mailbox leaves`, async () => {
      // A second mailbox held elsewhere by an install that takes no rule request: no leg, no row here.
      const w = await world([{ has: null }, { rules: false, has: null }], []);
      await svc.create(w.ctx, ann);
      await w.legs[0]!.readerCycle(2);
      // Taken over inside the day: this install applies the reader-era record as the organizer.
      expect(await clearOrganizerStandDown(w.here as never, w.legs[0]!.id, { now: at(3) })).toBe(true);
      await w.legs[0]!.hereCycle(4);
      await settleOwnOutstandingRequests(w.here, { mailboxId: w.legs[0]!.id, accountId: ACCT }, at(5), () => undefined);
      expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
      expect(await w.states()).toEqual(["0:sent"]);
      // Removed here, where the mailbox is organized: no press, no leg.
      w.setClock(10);
      await svc.remove(w.ctx, await w.firstId());
      expect(await w.rowsOf(w.here)).toEqual([]);
      const before = await creates(w);
      w.setClock(20);
      await leave(w, 0);
      expect(await w.rowsOf(w.here), "the removed rule came back").toEqual([]);
      expect(await creates(w)).toBe(before);
    });
  }

  for (const [door, leave] of Object.entries(leaves)) {
    it(`${door}: a Remove that expired unanswered is not applied when its only mailbox leaves later`, async () => {
      const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
      await svc.remove(w.ctx, await w.firstId());
      await w.legs[0]!.readerCycle(2);
      await w.legs[0]!.readerCycle(2 + DAY);
      expect(await w.states()).toEqual(["0:expired"]);
      await w.here.insert(mailboxes).values({ accountId: ACCT, provider: "imap", address: "n@mailbox.example" });
      w.setClock(90 * 24 * 60);
      await leave(w, 0);
      expect(await w.rowsOf(w.here), "the abandoned Remove was applied").toEqual(["ohmail/News"]);
      expect(await w.deletes()).toBe(0);
    });
  }
});

describe("two edits to one rule answered before the reader reads them: the row ends where every holder does", () => {
  /** Ann's rule as the Rules page lists it: where it files, on or off, its priority. */
  const stateOf = async (db: TestDb) => (await db.select({ d: rules.destination, e: rules.enabled, p: rules.priority })
    .from(rules).where(eq(rules.accountId, ACCT))).map((r) => `${r.d}|${r.e ? "on" : "off"}|p${r.p}`).sort();
  /* The first edit, the second, and the rule every holder runs after both. A reader's update
     travels with only the fields it names, so the second edit does not restate the first. */
  const pairs: Array<[string, PatchRuleBody, PatchRuleBody, string]> = [
    ["the folder, then the priority", { destination: "ohmail/Receipts" }, { priority: 5 }, "ohmail/Receipts|on|p5"],
    ["the folder, then a pause", { destination: "ohmail/Receipts" }, { enabled: false }, "ohmail/Receipts|off|p0"],
    // The shipped clients' shape: every edit names the folder, a lift adds the priority it needs.
    ["a retarget that carried a lift, then one that needed none",
      { destination: "ohmail/Receipts", priority: 6 }, { destination: "ohmail/Screened" }, "ohmail/Screened|on|p6"],
  ];

  for (const [name, first, second, want] of pairs) {
    it(`${name}: one holder, both acks read in one cycle`, async () => {
      const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
      const id = await w.firstId();
      await svc.update(w.ctx, id, first);
      w.setClock(2);
      await svc.update(w.ctx, id, second);
      await w.legs[0]!.round(3);
      expect(await w.states()).toEqual(["0:applied", "0:applied"]);
      expect(await stateOf(w.legs[0]!.laptop)).toEqual([want]);
      expect(await stateOf(w.here), "the older edit was dropped").toEqual([want]);
    });

    /** Holder 0 answers each edit in its own round; holder 1 has both sent and unanswered. */
    const holderOneOwesBoth = async () => {
      const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
      const id = await w.firstId();
      await svc.update(w.ctx, id, first);
      await w.legs[1]!.readerCycle(2);
      await w.legs[0]!.round(3);
      w.setClock(10);
      await svc.update(w.ctx, id, second);
      await w.legs[1]!.readerCycle(11);
      await w.legs[0]!.round(12);
      expect(await w.states()).toEqual(["0:applied", "0:applied", "1:sent", "1:sent"]);
      expect(await stateOf(w.here), "the row moved while holder 1 runs the old rule").toEqual(["ohmail/News|on|p0"]);
      return w;
    };

    it(`${name}: two holders, the second answering both in one cycle`, async () => {
      const w = await holderOneOwesBoth();
      await w.legs[1]!.laptopCycle(20);
      await w.legs[1]!.readerCycle(21);
      expect(await stateOf(w.legs[1]!.laptop)).toEqual([want]);
      expect(await stateOf(w.here), "the older edit was dropped").toEqual([want]);
    });

    for (const door of ["removed", "switched off (PATCH disabled)"] as const) {
      it(`${name}: two holders, the second ${door} before it answers`, async () => {
        const w = await holderOneOwesBoth();
        w.setClock(20);
        if (door === "removed") await mbx.delete(w.ctx, w.legs[1]!.id);
        else await mbx.update(w.ctx, w.legs[1]!.id, { status: "disabled" });
        expect(await stateOf(w.legs[0]!.laptop)).toEqual([want]);
        expect(await stateOf(w.here), "the leave settled the newer edit alone").toEqual([want]);
      });
    }

    it(`${name}: two holders, the second answering both after the reader expired them`, async () => {
      const w = await holderOneOwesBoth();
      await w.legs[1]!.readerCycle(13 + DAY);
      expect(await w.states()).toEqual(["0:applied", "0:applied", "1:expired", "1:expired"]);
      // The holder's clock reads inside its own stale window for both edits.
      await w.legs[1]!.laptopCycle(23 * 60 + 58);
      await w.legs[1]!.readerCycle(14 + DAY);
      expect(await w.states()).toEqual(["0:applied", "0:applied", "1:applied", "1:applied"]);
      expect(await stateOf(w.legs[1]!.laptop)).toEqual([want]);
      expect(await stateOf(w.here), "the late answers settled the newer edit alone").toEqual([want]);
    });

    it(`CONTROL: ${name}: one holder, each ack read in its own cycle`, async () => {
      const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
      const id = await w.firstId();
      await svc.update(w.ctx, id, first);
      await w.legs[0]!.round(2);
      w.setClock(10);
      await svc.update(w.ctx, id, second);
      await w.legs[0]!.round(11);
      expect(await stateOf(w.here)).toEqual([want]);
    });
  }

  it("the folder, then the priority: the first answer late, the second in time, both read in one cycle", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
    const id = await w.firstId();
    await svc.update(w.ctx, id, { destination: "ohmail/Receipts" });
    await w.legs[0]!.readerCycle(2);
    w.setClock(600);
    await svc.update(w.ctx, id, { priority: 5 });
    await w.legs[0]!.readerCycle(601);
    // Past the first leg's window, inside the second's.
    await w.legs[0]!.readerCycle(1450);
    expect(await w.states()).toEqual(["0:expired", "0:sent"]);
    await w.legs[0]!.laptopCycle(23 * 60 + 58);
    await w.legs[0]!.readerCycle(1451);
    expect(await w.states()).toEqual(["0:applied", "0:applied"]);
    expect(await stateOf(w.legs[0]!.laptop)).toEqual(["ohmail/Receipts|on|p5"]);
    expect(await stateOf(w.here), "the late answer settled after the newer one").toEqual(["ohmail/Receipts|on|p5"]);
  });

  it("CONTROL: two retargets, both acks read in one cycle: the row takes the later folder", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
    const id = await w.firstId();
    await svc.update(w.ctx, id, { destination: "ohmail/Receipts" });
    w.setClock(2);
    await svc.update(w.ctx, id, { destination: "ohmail/Screened" });
    await w.legs[0]!.round(3);
    expect(await stateOf(w.legs[0]!.laptop)).toEqual(["ohmail/Screened|on|p0"]);
    expect(await stateOf(w.here)).toEqual(["ohmail/Screened|on|p0"]);
  });

  it("CONTROL: a Remove, then a create under the key, both acks read in one cycle: the row is the create's", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    w.setClock(2);
    await svc.create(w.ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/Receipts" });
    await w.legs[0]!.round(3);
    expect(await stateOf(w.legs[0]!.laptop)).toEqual(["ohmail/Receipts|on|p0"]);
    expect(await stateOf(w.here)).toEqual(["ohmail/Receipts|on|p0"]);
  });
});

describe("a leave never applies an older press over a later create the row already held", () => {
  /* A later create that settles with the reader's row already as it asks writes nothing a client
     reads, so its press is what orders an older press the leave settles afterwards. */
  const stateOf = async (db: TestDb) => (await db.select({ d: rules.destination, e: rules.enabled, p: rules.priority })
    .from(rules).where(eq(rules.accountId, ACCT))).map((r) => `${r.d}|${r.e ? "on" : "off"}|p${r.p}`).sort();
  const annIn = (destination: string) => ({ kind: "sender", match: "ann@shop.example", destination }) as const;
  const stamp = async (w: World) => (await w.here.select({ u: rules.updatedAt }).from(rules)
    .where(eq(rules.accountId, ACCT))).map((r) => r.u.getTime());
  const leaves = {
    delete: (w: World, i: number) => mbx.delete(w.ctx, w.legs[i]!.id),
    disable: (w: World, i: number) => mbx.update(w.ctx, w.legs[i]!.id, { status: "disabled" }),
  };

  /** The later create, a day after the older press expired on holder 1: both holders make it. */
  const createdAgainADayLater = async (w: World) => {
    w.setClock(DAY + 10);
    await svc.create(w.ctx, annIn("ohmail/News"));
    await w.legs[0]!.round(DAY + 11);
    await w.legs[1]!.readerCycle(DAY + 14);
    await w.legs[1]!.laptopCycle(DAY + 15);
    await w.legs[1]!.readerCycle(DAY + 16);
    expect(await w.states()).toEqual(["0:applied", "0:applied", "1:applied", "1:expired"]);
  };

  for (const [door, leave] of Object.entries(leaves)) {
    it(`${door}: an edit refused no_such_rule on the leaving mailbox, then the rule created as it was on both`, async () => {
      // Holder 1 runs no rule for Ann: it refuses the edit and makes the create.
      const w = await world([{ has: "ohmail/News" }, { has: null }], ["ohmail/News"]);
      await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
      w.setClock(2);
      await svc.create(w.ctx, annIn("ohmail/News"));
      await w.legs[0]!.round(3);
      await w.legs[1]!.round(6);
      expect(await w.states()).toEqual(["0:applied", "0:applied", "1:applied", "1:refused(no_such_rule)"]);
      // The create settled with the row as it was: nothing a client reads moved.
      expect(await stateOf(w.here)).toEqual(["ohmail/News|on|p0"]);
      expect(await stamp(w)).toEqual([at(0).getTime()]);
      expect(await w.ruleDeltas()).toBe(0);
      w.setClock(20);
      await leave(w, 1);
      expect(await stateOf(w.legs[0]!.laptop)).toEqual(["ohmail/News|on|p0"]);
      expect(await stateOf(w.here), "the older edit was applied over the later create").toEqual(["ohmail/News|on|p0"]);
      expect(await w.ruleDeltas()).toBe(0);
    });

    it(`${door}: an edit that expired on the leaving mailbox, a day later the rule created as it was on both`, async () => {
      const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
      await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
      await firstAckWhileTheOtherIsSent(w);
      await w.legs[1]!.readerCycle(2 + DAY);
      await createdAgainADayLater(w);
      expect(await stateOf(w.here)).toEqual(["ohmail/News|on|p0"]);
      expect(await w.ruleDeltas()).toBe(0);
      w.setClock(DAY + 30);
      await leave(w, 1);
      expect(await stateOf(w.legs[0]!.laptop)).toEqual(["ohmail/News|on|p0"]);
      expect(await stateOf(w.here), "the older edit was applied over the later create").toEqual(["ohmail/News|on|p0"]);
      expect(await w.ruleDeltas()).toBe(0);
    });

    it(`${door}: a Remove that expired on the leaving mailbox, a day later the rule created again on both`, async () => {
      const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
      await svc.remove(w.ctx, await w.firstId());
      await firstAckWhileTheOtherIsSent(w);
      await w.legs[1]!.readerCycle(2 + DAY);
      await createdAgainADayLater(w);
      expect(await stateOf(w.here)).toEqual(["ohmail/News|on|p0"]);
      w.setClock(DAY + 30);
      await leave(w, 1);
      expect(await stateOf(w.legs[0]!.laptop)).toEqual(["ohmail/News|on|p0"]);
      expect(await stateOf(w.here), "the older Remove took the rule the holder still runs").toEqual(["ohmail/News|on|p0"]);
      expect(await w.deletes()).toBe(0);
    });
  }

  it("CONTROL: a later create that moved the row orders the older edit by the row's own stamp", async () => {
    const w = await world([{ has: "ohmail/Screened" }, { has: null }], ["ohmail/Screened"]);
    await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
    w.setClock(2);
    await svc.create(w.ctx, annIn("ohmail/News"));
    await w.legs[0]!.round(3);
    await w.legs[1]!.round(6);
    expect(await stateOf(w.here)).toEqual(["ohmail/News|on|p0"]);
    w.setClock(20);
    await mbx.delete(w.ctx, w.legs[1]!.id);
    expect(await stateOf(w.legs[0]!.laptop)).toEqual(["ohmail/News|on|p0"]);
    expect(await stateOf(w.here)).toEqual(["ohmail/News|on|p0"]);
  });
});
