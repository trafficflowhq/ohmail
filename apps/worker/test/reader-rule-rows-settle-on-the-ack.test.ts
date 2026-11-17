import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, organizerRequests, rules, settleReaderRuleRows, type Tx } from "@trafficflow/db";
import { RulesService, type ServiceContext } from "@trafficflow/services";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "@ohmail/organizer/request-drain";

/**
 * THE READER'S OWN RULE ROWS FOLLOW THE ORGANIZER'S APPLIED ACK (READER-ONLY-RULE-REMOVAL-KEEPS-THE-ROW),
 * unless the person wrote the row again after deciding the request. Two installs, two stores, one
 * `ohmail/_meta`; every request is stamped apart (`at(n)`), as production's clock does — under a
 * frozen clock two presses are indistinguishable, a fixture hole and not a product case.
 */
const ACCT = "00000000-0000-0000-0000-0000000000b7";
const t0 = new Date("2026-10-02T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const ADDRESS = "shared@mailbox.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "the-shared-password" }, address: ADDRESS })!;
const READER = { installId: "reader-install", kind: "local" as const };
type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

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

/** Ann's rule on both stores; the reader's row last written at `readerStamp`. */
async function world(readerStamp: Date = t0) {
  const mailboxId = randomUUID();
  const reader = await makeTestDb();
  const organizer = await makeTestDb();
  await reader.insert(mailboxes).values({
    id: mailboxId, accountId: ACCT, provider: "imap", address: ADDRESS, organizerRole: "reader",
    organizerState: "held", organizedByCapabilities: "requests,rules", organizedByKind: "local", organizedByName: "laptop",
  });
  await organizer.insert(mailboxes).values({ id: mailboxId, accountId: ACCT, provider: "imap", address: ADDRESS });
  const ann = { accountId: ACCT, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" };
  await reader.insert(rules).values({ ...ann, updatedAt: readerStamp });
  await organizer.insert(rules).values(ann);
  const m = sharedMeta();
  const queue = async (kind: string, payload: unknown, decidedAt: Date) => {
    const id = randomUUID();
    await reader.insert(organizerRequests).values({ id, accountId: ACCT, mailboxId, kind, payload, decidedAt, state: "pending" });
    return id;
  };
  const readerIo = { requestReaderIo: () => m.reader } as unknown as MailboxAdapter;
  const log: Array<{ event: string; detail: Record<string, unknown> }> = [];
  /** Send, apply on the organizer, read the ack — a reader cycle, an organizer cycle, a reader cycle. */
  const round = async (t: number) => {
    await driveOutstandingRequests(reader, { mailboxId, accountId: ACCT, installId: READER.installId, adapter: readerIo, requestKey: KEY }, READER, at(t), () => undefined);
    await applyMetaRequests(organizer, { mailboxId, accountId: ACCT, installId: "organizer-install", adapter: { requestOrganizerIo: () => m.organizer } as unknown as MailboxAdapter, requestKey: KEY }, at(t + 1), () => undefined);
    await driveOutstandingRequests(reader, { mailboxId, accountId: ACCT, installId: READER.installId, adapter: readerIo, requestKey: KEY }, READER, at(t + 2), (event, detail) => { log.push({ event, detail }); });
  };
  const rowsOf = async (db: TestDb) => db.select({ match: rules.match, destination: rules.destination }).from(rules).where(eq(rules.accountId, ACCT));
  const stateOf = async (id: string) => (await reader.select().from(organizerRequests).where(eq(organizerRequests.id, id)))[0]!.state;
  /** The reader's own door, pressed at `now`. */
  const door = (now: Date) => ({ db: reader, accountId: ACCT, userId: null, requestId: "r", now: () => now }) as ServiceContext;
  return { reader, organizer, queue, round, rowsOf, stateOf, door, log };
}
const KEYED = { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null };
const newsOnly = [{ match: "ann@shop.example", destination: "ohmail/News" }];

describe("the reader's rule rows follow the organizer's applied ack", () => {
  it("an applied edit moves the reader's row; an applied removal takes it", async () => {
    const w = await world();
    const edit = await w.queue("rule.update", { key: KEYED, set: { destination: "receipts" } }, at(1));
    await w.round(10);
    expect(await w.stateOf(edit)).toBe("applied");
    expect(await w.rowsOf(w.reader)).toEqual([{ match: "ann@shop.example", destination: "ohmail/Receipts" }]);
    const removal = await w.queue("rule.delete", { key: KEYED }, at(2));
    await w.round(20);
    expect(await w.stateOf(removal)).toBe("applied");
    expect(await w.rowsOf(w.organizer)).toEqual([]);
    expect(await w.rowsOf(w.reader), "the organizer removed the rule and the reader's row stayed").toEqual([]);
  });

  it("an edit then its Undo, acked in two cycles, both settle: the row says News", async () => {
    const w = await world();
    await w.queue("rule.update", { key: KEYED, set: { destination: "receipts" } }, at(1));
    await w.round(10);
    await w.queue("rule.update", { key: KEYED, set: { destination: "reads" }, keepProvenance: true }, at(2));
    await w.round(20);
    expect(await w.rowsOf(w.organizer)).toEqual(newsOnly);
    expect(await w.rowsOf(w.reader), "the Undo's ack did not settle the row").toEqual(newsOnly);
  });

  it("an ack decided before the row's own later write leaves the row: the person's later hand stands", async () => {
    // A mixed account: the press wrote locally at at(1); a later local Undo wrote News back at at(5).
    const w = await world(at(5));
    await w.queue("rule.update", { key: KEYED, set: { destination: "receipts" } }, at(1));
    await w.round(10);
    expect(await w.rowsOf(w.reader), "the older ack overwrote the newer local write").toEqual(newsOnly);
    expect(w.log.filter((l) => l.event === "reader_rule_settle_skipped").map((l) => l.detail.reason)).toEqual(["newer_local_write"]);
  });

  it("an ack decided at the instant of the row's own write is that write, and adds nothing", async () => {
    const w = await world(at(1));
    await w.queue("rule.update", { key: KEYED, set: { destination: "receipts" } }, at(1));
    await w.round(10);
    expect(await w.rowsOf(w.reader)).toEqual(newsOnly);
  });

  it("an applied create writes the rule here", async () => {
    const w = await world();
    const svc = new RulesService();
    // Through the door, so the case reads the payload a reader actually sends.
    await svc.create(w.door(at(1)), { kind: "sender", match: "bob@shop.example", destination: "ohmail/Receipts" });
    await w.round(10);
    const [create] = await w.reader.select().from(organizerRequests).where(eq(organizerRequests.kind, "rule.create"));
    expect(create!.state).toBe("applied");
    expect((await w.rowsOf(w.reader)).map((r) => r.match).sort()).toEqual(["ann@shop.example", "bob@shop.example"]);
    // …stamped with the press that made it, so the next press's ack is not read as older.
    const [bob] = await w.reader.select({ id: rules.id }).from(rules).where(eq(rules.match, "bob@shop.example"));
    await svc.update(w.door(at(2)), bob!.id, { destination: "ohmail/Screened" });
    await w.round(20);
    expect((await w.rowsOf(w.reader)).find((r) => r.match === "bob@shop.example")!.destination).toBe("ohmail/Screened");
  });

  it("CONTROLS: a refusal leaves the reader's row; a request with no decidedAt settles nothing", async () => {
    const w = await world();
    const refused = await w.queue("rule.delete", { key: { ...KEYED, match: "nobody@shop.example" } }, at(1));
    await w.round(10);
    expect(await w.stateOf(refused)).toBe("refused");
    expect(await w.rowsOf(w.reader)).toEqual(newsOnly);
    const out = await (w.reader as unknown as Tx).transaction((tx) =>
      settleReaderRuleRows(tx, ACCT, { kind: "rule.delete", payload: { key: KEYED }, decidedAt: null }));
    expect(out).toEqual({ settled: false, skipped: "no_decided_at" });
    expect(await w.rowsOf(w.reader)).toEqual(newsOnly);
  });
});
