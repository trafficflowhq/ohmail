import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountWritesHere, listSentRequests, mailboxes, markRequestsSent, organizerRequests, rules, type Tx,
} from "@trafficflow/db";
import { RulesService, type RuleMutation, type ServiceContext } from "@trafficflow/services";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";

/**
 * A RULE MADE ON A DEVICE THAT DOES NOT ORGANIZE THE MAILBOX REACHES THE ONE THAT DOES
 * (RULE-CREATE-FROM-A-NON-ORGANIZER-DEVICE-IS-REFUSED), and the reader's own rows then follow the
 * answer without undoing a later press (RULE-BELT-CANNOT-SEE-A-REMOVAL, RULE-BELT-GUARD-READS-ONE-TWIN).
 * Real doors throughout: `RulesService` on this install's store, the reader's drain with its belt,
 * the organizer's apply. Only the legacy and garbage rows are written by hand, because no door
 * sends either any more.
 */
const ACCT = "00000000-0000-0000-0000-0000000000d4";
const t0 = new Date("2026-10-03T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const ADDRESS = "held@mailbox.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "the-shared-password" }, address: ADDRESS })!;
const READER = { installId: "reader-install", kind: "local" as const };
const svc = new RulesService();

function sharedMeta() {
  const store = new Map<number, string>();
  let next = 1;
  // One whole read of the folder, as `readMetaRecords` answers since the meta-folder window row.
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

/** `mixed`: this install also organizes a mailbox of its own; otherwise every live mailbox is held elsewhere. */
async function world(mixed: boolean) {
  const here = await makeTestDb();
  const laptop = await makeTestDb();
  if (mixed) await here.insert(mailboxes).values({ accountId: ACCT, provider: "imap", address: "own@mailbox.example" });
  const held = randomUUID();
  await here.insert(mailboxes).values({
    id: held, accountId: ACCT, provider: "imap", address: ADDRESS, organizerRole: "reader",
    organizerState: "held", organizedByCapabilities: "requests,rules", organizedByKind: "local", organizedByName: "laptop",
  });
  await laptop.insert(mailboxes).values({ id: held, accountId: ACCT, provider: "imap", address: ADDRESS });
  let clock = at(0);
  let ticking = false;
  // `ticking`: every call is a fresh instant, as production's `now: () => new Date()` is.
  const ctx = {
    db: here, accountId: ACCT, userId: null, requestId: "r",
    now: () => (ticking ? (clock = new Date(clock.getTime() + 1)) : clock),
  } as ServiceContext;
  const m = sharedMeta();
  const readerIo = { requestReaderIo: () => m.reader } as unknown as MailboxAdapter;
  const log: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const readerCycle = (t: number) => driveOutstandingRequests(here, { mailboxId: held, accountId: ACCT, installId: READER.installId, adapter: readerIo, requestKey: KEY }, READER, at(t), (event, detail) => { log.push({ event, detail }); });
  const laptopCycle = (t: number) => applyMetaRequests(laptop, { mailboxId: held, accountId: ACCT, installId: "laptop-install", adapter: { requestOrganizerIo: () => m.organizer } as unknown as MailboxAdapter, requestKey: KEY }, at(t), () => undefined);
  /** A reader cycle, the organizer's cycle, a reader cycle: the request is sent, applied and its ack read. */
  const round = async (t: number) => { await readerCycle(t); await laptopCycle(t + 1); await readerCycle(t + 2); };
  const rowsOf = async (db: typeof here) => (await db.select({ match: rules.match, destination: rules.destination })
    .from(rules).where(eq(rules.accountId, ACCT))).map((r) => `${r.match}>${r.destination}`).sort();
  const states = async () => (await here.select({ kind: organizerRequests.kind, state: organizerRequests.state, why: organizerRequests.refusedReason })
    .from(organizerRequests).where(eq(organizerRequests.accountId, ACCT))).map((r) => `${r.kind}:${r.state}${r.why ? `(${r.why})` : ""}`).sort();
  /** A row no door writes any more: one queued by an older build, or a corrupt one. */
  const queueByHand = async (kind: string, payload: unknown, decidedAt: Date) => {
    await here.insert(organizerRequests).values({ id: randomUUID(), accountId: ACCT, mailboxId: held, kind, payload, decidedAt, state: "pending" });
  };
  return {
    here, laptop, ctx, held, log, round, readerCycle, laptopCycle, rowsOf, states, queueByHand,
    setClock: (t: number) => { clock = at(t); }, tick: () => { ticking = true; },
  };
}
const BOB = { kind: "sender", match: "bob@shop.example", destination: "ohmail/Receipts" };
const BOB_ROW = "bob@shop.example>ohmail/Receipts";

describe("A. a rule added on a device that does not organize the mailbox", () => {
  for (const mixed of [false, true]) {
    const label = mixed ? "mixed account" : "reader-only account";
    it(`${label}: RulesService.create reaches the organizer and the rule is made there`, async () => {
      const w = await world(mixed);
      w.setClock(1);
      await svc.create(w.ctx, BOB);
      /* FLAT ON THE WIRE: every shipped organizer (the deployed worker, every 0.25.x desktop) reads
         only this shape. This install's validator also reads the nested one, so it cannot see this.
         A priority the press did not state travels absent, which a shipped organizer reads as 0 and
         this one as "keep the stored priority". */
      const [queued] = await w.here.select({ payload: organizerRequests.payload }).from(organizerRequests);
      expect(Object.keys(queued!.payload as object).sort()).toEqual(["applyRetro", "destination", "enabled", "key"]);
      await w.round(2);
      expect(await w.states(), "the organizer refused the create the door queued").toEqual(["rule.create:applied"]);
      expect(await w.rowsOf(w.laptop)).toEqual([BOB_ROW]);
      // One row here either way: the belt's insert on a reader-only account, the press's own on a mixed one.
      expect(await w.rowsOf(w.here)).toEqual([BOB_ROW]);
    });
  }

  it("a create naming no priority over the organizer's raised rule keeps that priority; a stated one is written", async () => {
    for (const stated of [undefined, 2]) {
      const w = await world(false);
      await w.laptop.insert(rules).values({
        accountId: ACCT, kind: BOB.kind, match: BOB.match, destination: BOB.destination, priority: 5, enabled: true, provenance: "manual",
      });
      w.setClock(1);
      await svc.create(w.ctx, stated === undefined ? BOB : { ...BOB, priority: stated });
      await w.round(2);
      expect(await w.states()).toEqual(["rule.create:applied"]);
      const [row] = await w.laptop.select({ priority: rules.priority }).from(rules).where(eq(rules.accountId, ACCT));
      expect(row!.priority, `the organizer's rule after a create naming ${stated ?? "no"} priority`).toBe(stated ?? 5);
    }
    // Two worlds of two PGlite stores each, no wait of its own: up to 3.8 s on the CI VMs, 94 s under
    // 10% of a CPU.
  }, 180_000);

  it("CONTROL: a change to an existing rule, from the same door, is carried out by the organizer", async () => {
    const w = await world(false);
    const ann = { accountId: ACCT, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" };
    await w.here.insert(rules).values({ ...ann, updatedAt: at(0) });
    await w.laptop.insert(rules).values(ann);
    const [row] = await w.here.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCT));
    w.setClock(1);
    await svc.update(w.ctx, row!.id, { destination: "ohmail/Receipts" });
    await w.round(2);
    expect(await w.states()).toEqual(["rule.update:applied"]);
    expect(await w.rowsOf(w.laptop)).toEqual(["ann@shop.example>ohmail/Receipts"]);
  });

  it("a create queued by an older build, its fields nested under `set`, is applied rather than refused", async () => {
    const w = await world(false);
    const key = { kind: "sender", match: "bob@shop.example", subjectContains: null, bodyContains: null };
    await w.queueByHand("rule.create", { key, set: { destination: "receipts", priority: 0, enabled: true }, applyRetro: true }, at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["rule.create:applied"]);
    expect(await w.rowsOf(w.laptop)).toEqual([BOB_ROW]);
    expect(await w.rowsOf(w.here)).toEqual([BOB_ROW]);
  });

  it("CONTROL: a garbage create is still refused invalid_payload", async () => {
    const w = await world(false);
    const key = { kind: "sender", match: "bob@shop.example", subjectContains: null, bodyContains: null };
    await w.queueByHand("rule.create", { key, destination: "nowhere" }, at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["rule.create:refused(invalid_payload)"]);
    expect(await w.rowsOf(w.laptop)).toEqual([]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("a create naming its fields in both shapes is refused whole, never half-read", async () => {
    const w = await world(false);
    const key = { kind: "sender", match: "bob@shop.example", subjectContains: null, bodyContains: null };
    await w.queueByHand("rule.create", { key, destination: "receipts", set: { destination: "reads" } }, at(1));
    await w.round(2);
    expect(await w.states()).toEqual(["rule.create:refused(invalid_payload)"]);
    expect(await w.rowsOf(w.laptop)).toEqual([]);
  });
});

describe("B. a mixed account's Remove after its Create, against the create's ack", () => {
  it("both legs acked in one cycle: the rule stays removed on both installs", async () => {
    const w = await world(true);
    w.setClock(1);
    const made = await svc.create(w.ctx, BOB) as RuleMutation;
    w.setClock(2);
    await svc.remove(w.ctx, made.rule.id);
    await w.round(3);
    expect(await w.states()).toEqual(["rule.create:applied", "rule.delete:applied"]);
    expect(await w.rowsOf(w.laptop)).toEqual([]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("the create's ack read after the person's Remove: the removed rule does not come back here", async () => {
    const w = await world(true);
    w.setClock(1);
    const made = await svc.create(w.ctx, BOB) as RuleMutation;
    await w.readerCycle(2); await w.laptopCycle(3);
    w.setClock(4);
    await svc.remove(w.ctx, made.rule.id);
    expect(await w.rowsOf(w.here), "the local Remove did not remove").toEqual([]);
    await w.readerCycle(5);
    expect(await w.states()).toEqual(["rule.create:applied", "rule.delete:sent"]);
    expect(await w.rowsOf(w.here), "the create's ack brought back the rule removed after it").toEqual([]);
  });

  it("the same, and the delete leg then expires unanswered: the removed rule stays gone here", async () => {
    const w = await world(true);
    w.setClock(1);
    const made = await svc.create(w.ctx, BOB) as RuleMutation;
    await w.readerCycle(2); await w.laptopCycle(3);
    w.setClock(4);
    await svc.remove(w.ctx, made.rule.id);
    await w.readerCycle(5);
    await w.readerCycle(5 + 25 * 60);
    expect(await w.states()).toEqual(["rule.create:applied", "rule.delete:expired"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("a delete settled before its create in one cycle: the rule stays gone here", async () => {
    const w = await world(true);
    w.setClock(1);
    const made = await svc.create(w.ctx, BOB) as RuleMutation;
    w.setClock(2);
    await svc.remove(w.ctx, made.rule.id);
    await w.readerCycle(3); await w.laptopCycle(4);
    /* The settle walks the sent rows in the order they are listed. The create's row is written
       again, unchanged, so it sits after the delete's: the order an unordered read hands back. */
    const [create] = await w.here.select().from(organizerRequests)
      .where(and(eq(organizerRequests.accountId, ACCT), eq(organizerRequests.kind, "rule.create")));
    await w.here.delete(organizerRequests).where(eq(organizerRequests.id, create!.id));
    await w.here.insert(organizerRequests).values(create!);
    // The fixture's premise, read without an ORDER BY: the heap now hands the delete back first.
    const heap = await w.here.select({ kind: organizerRequests.kind }).from(organizerRequests).where(eq(organizerRequests.accountId, ACCT));
    expect(heap.map((r) => r.kind)).toEqual(["rule.delete", "rule.create"]);
    await w.readerCycle(5);
    expect(await w.states()).toEqual(["rule.create:applied", "rule.delete:applied"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("CONTROL: a Remove and then a new Create of the same rule leaves the rule here", async () => {
    const w = await world(true);
    const ann = { accountId: ACCT, kind: "sender", match: "bob@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" };
    const [old] = await w.here.insert(rules).values({ ...ann, updatedAt: at(0) }).returning({ id: rules.id });
    await w.laptop.insert(rules).values(ann);
    w.setClock(1);
    await svc.remove(w.ctx, old!.id);
    w.setClock(2);
    await svc.create(w.ctx, BOB);
    await w.round(3);
    expect(await w.states()).toEqual(["rule.create:applied", "rule.delete:applied"]);
    expect(await w.rowsOf(w.laptop)).toEqual([BOB_ROW]);
    expect(await w.rowsOf(w.here)).toEqual([BOB_ROW]);
  });

  it("ISOLATION: another account organized here does not stop a reader-only account's create ack", async () => {
    const w = await world(false);
    w.setClock(1);
    await svc.create(w.ctx, BOB);
    // A mailbox of ANOTHER account that this install organizes: it says nothing about this one.
    await w.here.insert(mailboxes).values({ accountId: "00000000-0000-0000-0000-0000000000d5", provider: "imap", address: "other@mailbox.example" });
    await w.round(2);
    expect(await w.rowsOf(w.here)).toEqual([BOB_ROW]);
  });

  it("ISOLATION: whether a press wrote here is read over this account's own mailboxes only", async () => {
    const w = await world(false);
    const [other] = await w.here.insert(mailboxes)
      .values({ accountId: "00000000-0000-0000-0000-0000000000d5", provider: "imap", address: "other@mailbox.example" })
      .returning({ id: mailboxes.id });
    // Every bound value of every statement the read sends, through the handle's own query logger.
    const session = (w.here as unknown as { session: { logger: unknown } }).session;
    const quiet = session.logger;
    const bound: unknown[] = [];
    session.logger = { logQuery: (_q: string, params: unknown[]) => { bound.push(...params); } };
    try {
      expect(await accountWritesHere(w.here as unknown as Tx, ACCT), "every live mailbox is held elsewhere").toBe(false);
    } finally {
      session.logger = quiet;
    }
    expect(bound, "the account's own mailbox is read").toContain(w.held);
    expect(bound, "another account's mailbox is never read").not.toContain(other!.id);
  });

  it("the reader lists its sent requests in the order they were decided", async () => {
    const w = await world(false);
    const key = { kind: "sender", match: "bob@shop.example", subjectContains: null, bodyContains: null };
    // Written newest first, so an unordered read hands them back the wrong way round.
    await w.queueByHand("rule.delete", { key }, at(3));
    await w.queueByHand("rule.update", { key, set: { priority: 1 } }, at(2));
    await w.queueByHand("rule.create", { key, destination: "receipts" }, at(1));
    const sent = await (w.here as unknown as Tx).transaction(async (tx) => {
      const ids = (await tx.select({ id: organizerRequests.id }).from(organizerRequests)).map((r) => r.id);
      await markRequestsSent(tx, ids, at(4));
      return listSentRequests(tx, w.held);
    });
    expect(sent.map((r) => r.kind)).toEqual(["rule.create", "rule.update", "rule.delete"]);
  });
});

describe("C/D. a mixed account's press over twins under one key, the clock ticking per call", () => {
  const seed = async (w: Awaited<ReturnType<typeof world>>) => {
    const ann = { accountId: ACCT, kind: "sender", match: "ann@shop.example", enabled: true, provenance: "manual" };
    const [x] = await w.here.insert(rules).values({ ...ann, destination: "ohmail/News", priority: 5, updatedAt: at(0) }).returning({ id: rules.id });
    await w.here.insert(rules).values({ ...ann, destination: "ohmail/Receipts", priority: 0, updatedAt: at(0) });
    await w.laptop.insert(rules).values({ ...ann, destination: "ohmail/News", priority: 5 });
    return x!.id;
  };
  const annHere = async (w: Awaited<ReturnType<typeof world>>) =>
    (await w.here.select({ destination: rules.destination, enabled: rules.enabled }).from(rules).where(eq(rules.accountId, ACCT)))
      .map((r) => `${r.destination}:${r.enabled ? "on" : "paused"}`).sort();

  for (const ticking of [false, true]) {
    const clock = ticking ? "ticking clock" : "frozen clock";
    // One rule per key: the local press converges the sender's key onto the row it names, and the
    // ack of that same press must not rewrite or delete what the person just wrote here.
    it(`D (${clock}): a plain Change on the shown row is the sender's one rule, and the ack leaves it`, async () => {
      const w = await world(true);
      const x = await seed(w);
      w.setClock(1);
      if (ticking) w.tick();
      await svc.update(w.ctx, x, { destination: "INBOX" });
      expect(await annHere(w), "the local press").toEqual(["INBOX:on"]);
      await w.round(2);
      expect(await w.states()).toEqual(["rule.update:applied"]);
      expect(await annHere(w), "the ack of the person's own press rewrote their rule").toEqual(["INBOX:on"]);
    });

    it(`C (${clock}): pausing the acting twin leaves the pressed row, paused, and the ack does not delete it`, async () => {
      const w = await world(true);
      const x = await seed(w);
      w.setClock(1);
      if (ticking) w.tick();
      await svc.update(w.ctx, x, { enabled: false });
      expect(await annHere(w), "the local press").toEqual(["ohmail/News:paused"]);
      await w.round(2);
      expect(await w.states()).toEqual(["rule.update:applied"]);
      expect(await annHere(w), "the ack of the person's own press rewrote their rows").toEqual(["ohmail/News:paused"]);
    });
  }
});
