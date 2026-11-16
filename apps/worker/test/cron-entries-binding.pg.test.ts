import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, mailboxes } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { carries, flightsOf, recordPgWire, type PgWireFlight } from "@trafficflow/db/testing";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { doorOf, namedBy, refusedOf } from "../../../test/support/wire-doors.js";
import { runBubbleUpCron } from "../src/bubble-up-cron.js";
import { runProposalCron } from "../src/proposal-cron.js";
import { runWorkflowCron } from "../src/workflow-cron.js";
import type { WorkerConfig } from "../src/config.js";

/**
 * THE ORGANIZER'S SCHEDULED ENTRIES, READ OFF THE WIRE.
 *
 * Three passes the organizer's own tail runs are also run on a schedule of their own, each a
 * process with its own pool: letters that come back up, proposals, and the workflows' due runs.
 * Each is run here as its schedule runs it, against a store that holds two accounts, A and B, a
 * mailbox each. Everything it wrote to the database is read through `flightsOf`:
 *
 * - which mailboxes and accounts this shard serves is read in a transaction that names no account;
 * - everything done for one account rides a transaction that names that account, and never carries
 *   the other account's ids;
 * - no statement outside a transaction names a table an account owns.
 *
 * An entry that ran on its pool's own handle would, where rows are locked by account, find nothing
 * to do and report a clean run; and the writer's fence refuses such a handle on a server's pool.
 */
const wire = recordPgWire();
let DB = "";

interface Owned { accountId: string; mailboxId: string }

/** Wait until the wire has been quiet for a moment. */
async function settled(): Promise<void> {
  let last = -1;
  for (;;) {
    const n = wire.read().flushes.length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 60));
  }
}

const ENTRIES = {
  "the letters that come back up": async (config: WorkerConfig) => (await runBubbleUpCron(config)).ran,
  "the proposals": async (config: WorkerConfig) => (await runProposalCron(config)).ran,
  "the workflows' due runs": async (config: WorkerConfig) => (await runWorkflowCron(config)).ran,
} as const;

describe("the organizer's scheduled entries bind each account's work to it (their own functions, real Postgres)", () => {
  let seed: OwnedDb;
  let a: Owned;
  let b: Owned;

  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_crons");
    seed = makeOwnedDb(DB);
  }, 120_000);

  beforeEach(async () => {
    await truncateAll(DB);
    const made: Owned[] = [];
    for (let i = 0; i < 2; i++) {
      const [acct] = await seed.db.insert(accounts).values({ name: `cron-${randomUUID().slice(0, 8)}` }).returning();
      const [mb] = await seed.db.insert(mailboxes)
        .values({ accountId: acct!.id, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
      made.push({ accountId: acct!.id, mailboxId: mb!.id });
    }
    [a, b] = made as [Owned, Owned];
  }, ISOLATED_DB_RESET_BUDGET_MS);

  afterAll(async () => { await seed.close(); });

  /** Run one entry as its schedule does, and answer every flight it wrote. */
  async function run(entry: keyof typeof ENTRIES): Promise<PgWireFlight[]> {
    await settled();
    wire.start();
    const ran = await ENTRIES[entry]({ databaseUrl: DB, pollIntervalMs: 1000, sentDomain: "trafficflow.test" });
    await settled();
    expect(ran, "the entry took the shard's lock and ran").toBe(true);
    return flightsOf(wire.read());
  }

  for (const entry of Object.keys(ENTRIES) as Array<keyof typeof ENTRIES>) {
    it(`${entry}: the roster on the view that names no account, each account's work under that account`, async () => {
      const flights = await run(entry);

      // Nothing it wrote is outside what the organizer's doors admit, and nothing is of what they still owe.
      const owed = new Set<string>();
      expect(refusedOf("worker", flights, [], owed)).toEqual([]);
      expect([...owed]).toEqual([]);

      // Outside a transaction's binding: no table an account owns.
      for (const f of flights.filter((x) => doorOf(x) === "plain")) {
        expect(f.statements.flatMap((s) => namedBy(s).reads).filter((t) => t === "mailboxes" || t === "accounts")).toEqual([]);
      }

      // Both accounts were worked, each under its own name, and neither's flights carry the other's ids.
      const ofA = flights.filter((f) => f.account === a.accountId);
      const ofB = flights.filter((f) => f.account === b.accountId);
      expect(ofA.length, "A's work").toBeGreaterThan(0);
      expect(ofB.length, "B's work").toBeGreaterThan(0);
      expect(flights.filter((f) => f.account !== null && f.account !== a.accountId && f.account !== b.accountId)).toEqual([]);
      expect(ofA.some((f) => carries(f, b.accountId) || carries(f, b.mailboxId))).toBe(false);
      expect(ofB.some((f) => carries(f, a.accountId) || carries(f, a.mailboxId))).toBe(false);

      // An account's id rides no transaction that names nobody but the roster's own read of who is served.
      for (const f of flights.filter((x) => doorOf(x) === "nothing")) {
        const tables = [...new Set(f.statements.flatMap((s) => namedBy(s).reads))];
        expect(tables.every((t) => t === "mailboxes" || t === "accounts"), tables.join(",")).toBe(true);
      }
    }, 60_000);
  }
});
