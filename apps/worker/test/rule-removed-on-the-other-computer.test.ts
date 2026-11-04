import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, organizerRequests, rules } from "@trafficflow/db";
import { RulesService, type ServiceContext } from "@trafficflow/services";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";

/**
 * A RULE REMOVED ON THE OTHER COMPUTER STAYS REMOVED HERE (HIGH 1). Two
 * installs that each organize one mailbox and read the other's: a rule added here travels to the
 * laptop, the person removes it on the laptop, this install applies that removal, and only then
 * reads its own create's ack. The ack may not bring the rule back. Real doors on both installs;
 * registered in the SQLite project too, because the phone's sidecar runs these drains.
 */
const ACCT = "00000000-0000-0000-0000-0000000000e4";
const t0 = new Date("2026-10-03T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const HELD = "held@mailbox.example";
const OWN = "own@mailbox.example";
const keyOf = (a: string) => deriveRequestKey({ auth: { user: a, pass: "basic-account-password" }, address: a })!;
const svc = new RulesService();

function meta() {
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

async function twoInstalls() {
  const here = await makeTestDb();
  const laptop = await makeTestDb();
  const held = randomUUID();
  const own = randomUUID();
  const reader = (by: string, kind: string) => ({
    organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,rules",
    organizedByKind: kind, organizedByName: by,
  });
  // Here organizes OWN and reads HELD; the laptop organizes HELD and reads OWN.
  await here.insert(mailboxes).values({ id: own, accountId: ACCT, provider: "imap", address: OWN });
  await here.insert(mailboxes).values({ id: held, accountId: ACCT, provider: "imap", address: HELD, ...reader("laptop", "local") });
  await laptop.insert(mailboxes).values({ id: held, accountId: ACCT, provider: "imap", address: HELD });
  await laptop.insert(mailboxes).values({ id: own, accountId: ACCT, provider: "imap", address: OWN, ...reader("cloud", "cloud") });
  let clock = at(1);
  const ctxOf = (db: typeof here) => ({ db, accountId: ACCT, userId: null, requestId: "r", now: () => clock }) as ServiceContext;
  const mHeld = meta();
  const mOwn = meta();
  const io = (m: ReturnType<typeof meta>) => ({
    requestReaderIo: () => m.reader, requestOrganizerIo: () => m.organizer,
  }) as unknown as MailboxAdapter;
  const readCycle = (db: typeof here, mailboxId: string, address: string, m: ReturnType<typeof meta>, installId: string, t: number) =>
    driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId, adapter: io(m), requestKey: keyOf(address) }, { installId, kind: "local" }, at(t), () => undefined);
  const organizeCycle = (db: typeof here, mailboxId: string, address: string, m: ReturnType<typeof meta>, installId: string, t: number) =>
    applyMetaRequests(db, { mailboxId, accountId: ACCT, installId, adapter: io(m), requestKey: keyOf(address) }, at(t), () => undefined);
  const rowsOf = async (db: typeof here) => (await db.select({ match: rules.match, destination: rules.destination })
    .from(rules).where(eq(rules.accountId, ACCT))).map((r) => `${r.match}>${r.destination}`).sort();
  return {
    here, laptop, rowsOf, setClock: (t: number) => { clock = at(t); },
    hereCtx: ctxOf(here), laptopCtx: ctxOf(laptop),
    hereReadsHeld: (t: number) => readCycle(here, held, HELD, mHeld, "here-i", t),
    laptopOrganizesHeld: (t: number) => organizeCycle(laptop, held, HELD, mHeld, "laptop-i", t),
    laptopReadsOwn: (t: number) => readCycle(laptop, own, OWN, mOwn, "laptop-i", t),
    hereOrganizesOwn: (t: number) => organizeCycle(here, own, OWN, mOwn, "here-i", t),
  };
}
const BOB = { kind: "sender", match: "bob@shop.example", destination: "ohmail/Receipts" };

describe("a rule removed on the other computer, then this install's create ack", () => {
  it("the removal applied here before the ack is read: the rule stays removed on both", async () => {
    const w = await twoInstalls();
    await svc.create(w.hereCtx, BOB);
    await w.hereReadsHeld(2);
    await w.laptopOrganizesHeld(3);
    expect(await w.rowsOf(w.laptop)).toEqual(["bob@shop.example>ohmail/Receipts"]);
    const [onLaptop] = await w.laptop.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCT));
    w.setClock(4);
    await svc.remove(w.laptopCtx, onLaptop!.id);
    await w.laptopReadsOwn(5);
    await w.hereOrganizesOwn(6);
    expect(await w.rowsOf(w.here), "here applied the laptop's removal").toEqual([]);
    await w.hereReadsHeld(7);
    const states = (await w.here.select({ kind: organizerRequests.kind, state: organizerRequests.state })
      .from(organizerRequests)).map((r) => `${r.kind}:${r.state}`);
    expect(states, "the create's ack was read").toEqual(["rule.create:applied"]);
    expect(await w.rowsOf(w.here), "the create's ack brought back a rule the person removed").toEqual([]);
    expect(await w.rowsOf(w.laptop)).toEqual([]);
  });

  it("CONTROL: with no removal, the ack leaves the rule the press wrote here as it is", async () => {
    const w = await twoInstalls();
    await svc.create(w.hereCtx, BOB);
    await w.hereReadsHeld(2);
    await w.laptopOrganizesHeld(3);
    await w.hereReadsHeld(4);
    expect(await w.rowsOf(w.here)).toEqual(["bob@shop.example>ohmail/Receipts"]);
    expect(await w.rowsOf(w.laptop)).toEqual(["bob@shop.example>ohmail/Receipts"]);
  });
});
