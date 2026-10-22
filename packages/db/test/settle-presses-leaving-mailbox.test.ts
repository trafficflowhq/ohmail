import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { settlePressesLeavingMailbox, settleReaderRuleRows } from "../src/request-apply.js";
// Through `schema.js`, whose `./schema-mail.js` the SQLite project points at the device twin.
import { accounts, changeLog, mailboxes, organizerRequests, rules } from "../src/schema.js";
import type { Tx } from "../src/change-log.js";

/**
 * A MAILBOX LEAVES: each distinct press with an unfinished rule leg on it is asked of the belt once,
 * oldest first. Finished legs (applied, a delete refused `no_such_rule`) and other kinds ask nothing.
 */
const T = (m: number): Date => new Date(Date.UTC(2026, 9, 3, 8, m));
const key = (match: string) => ({ kind: "sender", match });

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `spl-${accountId.slice(0, 8)}` });
  // Both held elsewhere: this install is a pure reader of the account.
  const held = { organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,rules", organizedByKind: "local", organizedByName: "laptop" } as const;
  const [a] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@mailbox.example", status: "disabled", ...held }).returning();
  const [b] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "b@mailbox.example", ...held }).returning();
  for (const match of ["ann@shop.example", "bob@shop.example"]) {
    await db.insert(rules).values({ accountId, kind: "sender", match, destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual", updatedAt: T(0) });
  }
  const leg = (mailboxId: string, kind: string, payload: unknown, decidedAt: Date, state: string, refusedReason: string | null = null) =>
    db.insert(organizerRequests).values({ id: randomUUID(), accountId, mailboxId, kind, payload, decidedAt, state, refusedReason });
  const leave = (mailboxId: string) => (db as unknown as Tx).transaction((tx) => settlePressesLeavingMailbox(tx as unknown as Tx, { accountId, mailboxId }));
  const left = async () => (await db.select({ m: rules.match, d: rules.destination }).from(rules).where(eq(rules.accountId, accountId)))
    .map((r) => `${r.m}:${r.d}`).sort();
  const deltas = async () => (await db.select().from(changeLog).where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "rule")))).length;
  /** The reader's ack path asking the belt about one press, in its own unit. */
  const settle = (request: { kind: string; payload: unknown; decidedAt: Date }) =>
    (db as unknown as Tx).transaction((tx) => settleReaderRuleRows(tx as unknown as Tx, accountId, request));
  return { db, accountId, a: a!.id, b: b!.id, leg, leave, left, deltas, settle };
}

describe("settlePressesLeavingMailbox", () => {
  it("asks once per unfinished press and settles the one whose live legs finished", async () => {
    const w = await world();
    // Press 1: Remove Ann — A unanswered, B applied. Press 2: Bob to Receipts — A pending, B sent.
    await w.leg(w.a, "rule.delete", { key: key("ann@shop.example") }, T(1), "sent");
    await w.leg(w.b, "rule.delete", { key: key("ann@shop.example") }, T(1), "applied");
    // A second unfinished row of press 1 on A is the same press, asked once.
    await w.leg(w.a, "rule.delete", { key: key("ann@shop.example") }, T(1), "expired");
    await w.leg(w.a, "rule.update", { key: key("bob@shop.example"), set: { destination: "receipts" } }, T(2), "pending");
    await w.leg(w.b, "rule.update", { key: key("bob@shop.example"), set: { destination: "receipts" } }, T(2), "sent");
    // Finished legs and other kinds ask nothing.
    await w.leg(w.a, "rule.create", { key: key("cid@shop.example"), destination: "reads" }, T(3), "applied");
    await w.leg(w.a, "rule.delete", { key: key("dan@shop.example") }, T(4), "refused", "no_such_rule");
    await w.leg(w.a, "screener.decide", { scope: "sender", address: "eve@shop.example", appliedFolder: "INBOX", decision: "yes" }, T(5), "sent");
    const out = await w.leave(w.a);
    expect(out.asked).toBe(2);
    expect(out.settled).toBe(1);
    expect(out.lastSeq).not.toBeNull();
    expect(out.skipped.map((s) => s.reason)).toEqual(["press_unfinished"]);
    expect(await w.left()).toEqual(["bob@shop.example:ohmail/News"]);
    expect(await w.deltas()).toBe(1);
  });

  it("a mailbox with only finished legs asks nothing and records no delta", async () => {
    const w = await world();
    await w.leg(w.a, "rule.delete", { key: key("ann@shop.example") }, T(1), "applied");
    await w.leg(w.a, "rule.delete", { key: key("bob@shop.example") }, T(2), "refused", "no_such_rule");
    const out = await w.leave(w.a);
    expect(out).toEqual({ asked: 0, settled: 0, lastSeq: null, skipped: [] });
    expect(await w.deltas()).toBe(0);
  });

  it("an expired or refused leg is asked but leaves only beside a live finished leg", async () => {
    const w = await world();
    // Ann: expired here, applied on B — settles. Bob: expired here alone, never awaited — holds.
    await w.leg(w.a, "rule.delete", { key: key("ann@shop.example") }, T(1), "expired");
    await w.leg(w.b, "rule.delete", { key: key("ann@shop.example") }, T(1), "applied");
    await w.leg(w.a, "rule.delete", { key: key("bob@shop.example") }, T(2), "expired");
    await w.leg(w.a, "rule.update", { key: key("bob@shop.example"), set: { destination: "receipts" } }, T(3), "refused", "stale");
    const out = await w.leave(w.a);
    expect(out).toMatchObject({ asked: 3, settled: 1 });
    expect(out.skipped.map((s) => s.reason)).toEqual(["press_unfinished", "press_unfinished"]);
    expect(await w.left()).toEqual(["bob@shop.example:ohmail/News"]);
  });

  it("a mailbox organized here asks nothing", async () => {
    const w = await world();
    await w.db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, w.a));
    await w.leg(w.a, "rule.delete", { key: key("ann@shop.example") }, T(1), "sent");
    expect(await w.leave(w.a)).toEqual({ asked: 0, settled: 0, lastSeq: null, skipped: [] });
    expect(await w.left()).toEqual(["ann@shop.example:ohmail/News", "bob@shop.example:ohmail/News"]);
  });

  it("an older create never settles over a later Remove that settled, wherever its legs are", async () => {
    const w = await world();
    await w.db.delete(rules).where(and(eq(rules.accountId, w.accountId), eq(rules.match, "ann@shop.example")));
    // The create: sent here, applied on B. The later Remove: applied on A alone (left now), or on B.
    await w.leg(w.a, "rule.create", { key: key("ann@shop.example"), destination: "receipts" }, T(1), "sent");
    await w.leg(w.b, "rule.create", { key: key("ann@shop.example"), destination: "receipts" }, T(1), "applied");
    await w.leg(w.a, "rule.delete", { key: key("ann@shop.example") }, T(2), "applied");
    const out = await w.leave(w.a);
    expect(out.skipped.map((s) => s.reason)).toEqual(["removed_after"]);
    expect(await w.left()).toEqual(["bob@shop.example:ohmail/News"]);
    expect(await w.deltas()).toBe(0);
  });

  it("two edits to one rule, each naming its own field, both settle at the leave, oldest first", async () => {
    const w = await world();
    // The folder, then the priority: each sent here and applied on B, so neither has settled.
    await w.leg(w.a, "rule.update", { key: key("ann@shop.example"), set: { destination: "receipts" } }, T(1), "sent");
    await w.leg(w.b, "rule.update", { key: key("ann@shop.example"), set: { destination: "receipts" } }, T(1), "applied");
    await w.leg(w.a, "rule.update", { key: key("ann@shop.example"), set: { priority: 5 } }, T(2), "sent");
    await w.leg(w.b, "rule.update", { key: key("ann@shop.example"), set: { priority: 5 } }, T(2), "applied");
    const out = await w.leave(w.a);
    expect(out).toMatchObject({ asked: 2, settled: 2, skipped: [] });
    const ann = await w.db.select({ d: rules.destination, p: rules.priority }).from(rules)
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "ann@shop.example")));
    expect(ann, "the later edit's settling dropped the older one").toEqual([{ d: "ohmail/Receipts", p: 5 }]);
  });

  /** Ann created again as she already is (T(5)): made on A and B, settled by the reader's ack path. */
  const createdAsShe = { kind: "rule.create", payload: { key: key("ann@shop.example"), destination: "reads" }, decidedAt: T(5) };
  const annRow = async (w: Awaited<ReturnType<typeof world>>) => (await w.db.select().from(rules)
    .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "ann@shop.example"))))[0]!;

  it("a create that settles with the row as it asks stamps its press and writes nothing a client reads", async () => {
    const w = await world();
    await w.leg(w.a, createdAsShe.kind, createdAsShe.payload, T(5), "applied");
    await w.leg(w.b, createdAsShe.kind, createdAsShe.payload, T(5), "applied");
    const { settledPressAt: was, ...before } = await annRow(w);
    expect(await w.settle(createdAsShe)).toEqual({ settled: true, lastSeq: null });
    const { settledPressAt: now, ...after } = await annRow(w);
    expect(was).toBeNull();
    expect(now?.getTime(), "the settled create left no press stamp").toBe(T(5).getTime());
    expect(after, "the settle moved a column another reader reads").toEqual(before);
    expect(await w.deltas()).toBe(0);
  });

  it("an older edit and an older Remove stand down at the leave under a later create that settled as it was", async () => {
    const w = await world();
    // Ann: an edit (T(1)) refused here and a Remove (T(2)) expired here, each applied on B.
    await w.leg(w.a, "rule.update", { key: key("ann@shop.example"), set: { destination: "receipts" } }, T(1), "refused", "stale");
    await w.leg(w.b, "rule.update", { key: key("ann@shop.example"), set: { destination: "receipts" } }, T(1), "applied");
    await w.leg(w.a, "rule.delete", { key: key("ann@shop.example") }, T(2), "expired");
    await w.leg(w.b, "rule.delete", { key: key("ann@shop.example") }, T(2), "applied");
    await w.leg(w.a, createdAsShe.kind, createdAsShe.payload, T(5), "applied");
    await w.leg(w.b, createdAsShe.kind, createdAsShe.payload, T(5), "applied");
    expect(await w.settle(createdAsShe)).toEqual({ settled: true, lastSeq: null });
    const out = await w.leave(w.a);
    expect(out).toMatchObject({ asked: 2, settled: 0, lastSeq: null });
    expect(out.skipped.map((s) => s.reason)).toEqual(["newer_settled_press", "newer_settled_press"]);
    expect(await w.left(), "an older press was applied over the later create").toEqual(["ann@shop.example:ohmail/News", "bob@shop.example:ohmail/News"]);
    expect(await w.deltas()).toBe(0);
  });

  it("CONTROL: a press decided after that create still settles at the leave", async () => {
    const w = await world();
    await w.leg(w.a, createdAsShe.kind, createdAsShe.payload, T(5), "applied");
    await w.leg(w.b, createdAsShe.kind, createdAsShe.payload, T(5), "applied");
    expect(await w.settle(createdAsShe)).toEqual({ settled: true, lastSeq: null });
    await w.leg(w.a, "rule.update", { key: key("ann@shop.example"), set: { destination: "receipts" } }, T(7), "refused", "stale");
    await w.leg(w.b, "rule.update", { key: key("ann@shop.example"), set: { destination: "receipts" } }, T(7), "applied");
    const out = await w.leave(w.a);
    expect(out).toMatchObject({ asked: 1, settled: 1, skipped: [] });
    expect(await w.left()).toEqual(["ann@shop.example:ohmail/Receipts", "bob@shop.example:ohmail/News"]);
  });

  it("CONTROL: a later Remove still unanswered on a live mailbox does not stop the older create", async () => {
    const w = await world();
    await w.db.delete(rules).where(and(eq(rules.accountId, w.accountId), eq(rules.match, "ann@shop.example")));
    await w.leg(w.a, "rule.create", { key: key("ann@shop.example"), destination: "receipts" }, T(1), "sent");
    await w.leg(w.b, "rule.create", { key: key("ann@shop.example"), destination: "receipts" }, T(1), "applied");
    await w.leg(w.b, "rule.delete", { key: key("ann@shop.example") }, T(2), "sent");
    const out = await w.leave(w.a);
    expect(out).toMatchObject({ asked: 1, settled: 1 });
    expect(await w.left()).toEqual(["ann@shop.example:ohmail/Receipts", "bob@shop.example:ohmail/News"]);
  });
});
