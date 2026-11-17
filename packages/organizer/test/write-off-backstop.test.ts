import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { mailboxes, messageFailures, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { DeadLetterLedger, MAX_DEAD_LETTERS_PER_CYCLE } from "../src/dead-letter.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE LOCAL BACKSTOP AT ANY ARRIVAL RATE. A local engine has no quarantine, so a defect refusing
 * every message wrote the mail off as it arrived. The hold now follows the cap's number of
 * write-offs IN A ROW with no message stored between them, whatever the cycles look like, and it
 * lives in the store under the build label that set it: the verify's trickle shapes (one, two, one
 * every third cycle), the review's burst, and six relaunches of one build.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000f0264";
const CAP = MAX_DEAD_LETTERS_PER_CYCLE;

/** INBOX delivers `mail` in order; a subject naming a victim is refused at the insert while `refusing`. */
async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: `b-${randomUUID().slice(0, 8)}@example.test` }).returning();
  const fleet = new FakeAdapterFleet();
  fleet.targetedRetry = true;
  const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } });
  const mail: string[] = [];
  const arrive = (...subjects: string[]) => {
    mail.push(...subjects);
    fleet.behave(mb!.id, { deliver: mail.map((s, i) => ({ from: "anna@example.com", subject: s, messageId: `m-${i}@lane.test` })) });
  };
  const refusing = { on: true };
  const inner = makeDrizzleRepo(db as never);
  const refuse = (r: object): object => new Proxy(r, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv) as unknown;
      if (prop === "insertMessage") {
        return async (row: { subject?: string | null }, ...rest: unknown[]) => {
          if (refusing.on && /victim/.test(String(row.subject ?? ""))) throw new Error("a pipeline defect refuses this message");
          return (v as (...a: unknown[]) => unknown).call(t, row, ...rest);
        };
      }
      if (prop === "transaction" && typeof v === "function") {
        return (fn: (x: object) => Promise<unknown>) => (v as (f: (x: object) => Promise<unknown>) => unknown).call(t, (x) => fn(refuse(x)));
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const repo = refuse(inner) as typeof inner;
  const lines: string[] = [];
  const cycle = (deadLetters: DeadLetterLedger, buildVersion = "build-1") => runSyncCycle({
    writeAuthority: FIXTURE_LEASE, repo, adapter, accountId: ACCOUNT, mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP,
    role: "organizer", trustedAuthservIds: new Set<string>(), deadLetters, buildVersion,
    log: createLogger({ service: "worker", sink: (l) => { lines.push(l); } }),
  }).then(() => "served", () => "failed");
  const writtenOff = async () => (await db.select({ uid: messageFailures.uid }).from(messageFailures)
    .where(isNull(messageFailures.resolvedAt))).length;
  const stored = async () => (await db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject);
  const heldLines = () => lines.filter((l) => (JSON.parse(l) as { event: string }).event === "sync_write_offs_held").length;
  /** The clock's re-read healing every write-off — what the retry pass writes when it stores one. */
  const resolveAll = async () => {
    await db.update(messageFailures).set({ resolvedAt: new Date() }).where(eq(messageFailures.mailboxId, mb!.id));
  };
  return { cycle, arrive, writtenOff, stored, heldLines, refusing, resolveAll };
}

const local = () => new DeadLetterLedger({ holdAtCap: true });

describe("the local backstop, at any arrival rate", () => {
  it("one refused message per cycle for 20 cycles: five written off, then the hold", async () => {
    const w = await world();
    const ledger = local();
    for (let i = 0; i < 20; i++) { w.arrive(`victim ${i}`); await w.cycle(ledger); }
    expect(await w.writtenOff()).toBe(CAP);
    expect(ledger.writeOffsHeldSince).toBeInstanceOf(Date);
    expect(w.heldLines()).toBe(1);
  });

  it("two per cycle: the same bound", async () => {
    const w = await world();
    const ledger = local();
    for (let i = 0; i < 20; i++) { w.arrive(`victim ${2 * i}`, `victim ${2 * i + 1}`); await w.cycle(ledger); }
    expect(await w.writtenOff()).toBe(CAP);
    expect(ledger.writeOffsHeldSince).toBeInstanceOf(Date);
    // Twenty cycles, no wait of its own: up to 2.7 s on the CI VMs, 77 s under 10% of a CPU.
  }, 120_000);

  it("one every third cycle, clean cycles between: the same bound — a clean cycle resets nothing", async () => {
    const w = await world();
    const ledger = local();
    const verdicts: string[] = [];
    for (let i = 0; i < 30; i++) { if (i % 3 === 0) w.arrive(`victim ${i}`); verdicts.push(await w.cycle(ledger)); }
    expect(verdicts).toContain("served");
    expect(await w.writtenOff()).toBe(CAP);
    expect(ledger.writeOffsHeldSince).toBeInstanceOf(Date);
  });

  it("the review's burst of twelve: five, then held", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 12 }, (_, i) => `victim ${i}`));
    const ledger = local();
    for (let i = 0; i < 6; i++) await w.cycle(ledger);
    expect(await w.writtenOff()).toBe(CAP);
    expect(ledger.writeOffsHeldSince).toBeInstanceOf(Date);
  });

  it("CONTROL: mixed mail, where messages store between the failures, never holds", async () => {
    const w = await world();
    const ledger = local();
    for (let i = 0; i < 20; i++) { w.arrive(`ordinary ${i}`, `victim ${i}`); await w.cycle(ledger); }
    expect(ledger.writeOffsHeldSince).toBeNull();
    expect(w.heldLines()).toBe(0);
    expect(await w.writtenOff()).toBeGreaterThan(CAP);
    expect((await w.stored()).filter((s) => s.startsWith("ordinary")).length).toBe(20);
  });

  it("CONTROL: the hosted worker's ledger, which its quarantine bounds, holds nothing", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 12 }, (_, i) => `victim ${i}`));
    const ledger = new DeadLetterLedger();
    for (let i = 0; i < 6; i++) await w.cycle(ledger);
    expect(await w.writtenOff()).toBe(12);
  });
});

describe("the hold lives in the store, under the build label that set it", () => {
  it("thirty refused messages across six relaunches of one build: five written off in all", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 30 }, (_, i) => `victim ${i}`));
    for (let launch = 0; launch < 6; launch++) {
      const ledger = local();
      for (let i = 0; i < 3; i++) await w.cycle(ledger);
      if (launch > 0) expect(ledger.writeOffsHeldSince, `launch ${launch}`).toBeInstanceOf(Date);
    }
    expect(await w.writtenOff()).toBe(CAP);
    // Eighteen cycles over thirty messages, no wait of its own: up to 3.1 s on the CI VMs, 101 s under
    // 10% of a CPU.
  }, 180_000);

  it("a relaunch under the same label is held before it writes anything off", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 6 }, (_, i) => `victim ${i}`));
    const first = local();
    for (let i = 0; i < 3; i++) await w.cycle(first);
    const held = first.writeOffsHeldSince;
    const again = local();
    w.arrive("victim late");
    await w.cycle(again);
    /* The store's instant for the fifth write-off; memory stamped the same moment a statement earlier. */
    expect(Math.abs((again.writeOffsHeldSince?.getTime() ?? 0) - (held?.getTime() ?? 1e15))).toBeLessThan(1000);
    expect(await w.writtenOff()).toBe(CAP);
  });

  it("a new build label lifts the hold and reads the written-off mail again — and a fixed build stores it", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 6 }, (_, i) => `victim ${i}`));
    const first = local();
    for (let i = 0; i < 3; i++) await w.cycle(first);
    expect(first.writeOffsHeldSince).toBeInstanceOf(Date);
    w.refusing.on = false;
    const next = local();
    for (let i = 0; i < 2; i++) await w.cycle(next, "build-2");
    expect(next.writeOffsHeldSince).toBeNull();
    expect(await w.writtenOff()).toBe(0);
    expect((await w.stored()).length).toBe(6);
  });

  it("a new build that still refuses starts its own count: the old label's write-offs do not hold it", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 6 }, (_, i) => `victim ${i}`));
    const first = local();
    for (let i = 0; i < 3; i++) await w.cycle(first);
    expect(await w.writtenOff()).toBe(CAP);
    const next = local();
    for (let i = 0; i < 2; i++) await w.cycle(next, "build-2");
    expect(await w.writtenOff()).toBe(CAP + 1);
  });

  it("the store's answer outranks memory: write-offs healed by the clock lift a running engine's hold", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 6 }, (_, i) => `victim ${i}`));
    const ledger = local();
    for (let i = 0; i < 3; i++) await w.cycle(ledger);
    expect(ledger.writeOffsHeldSince).toBeInstanceOf(Date);
    await w.resolveAll();
    await w.cycle(ledger);
    expect(ledger.writeOffsHeldSince).toBeNull();
  });

  it("a stored message lifts a hold in the running engine too", async () => {
    const w = await world();
    w.arrive(...Array.from({ length: 6 }, (_, i) => `victim ${i}`));
    const ledger = local();
    for (let i = 0; i < 3; i++) await w.cycle(ledger);
    expect(ledger.writeOffsHeldSince).toBeInstanceOf(Date);
    w.arrive("ordinary after");
    await w.cycle(ledger);
    expect(ledger.writeOffsHeldSince).toBeNull();
  });
});
