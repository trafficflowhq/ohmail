import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, messages, rules, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { ingestRunRepository } from "../src/ingest-run.js";
import { INGEST_RUN_BOUNDS } from "../src/config.js";
import {
  INGEST_RUN_STATEMENTS_CEILING, INGEST_RUN_TRANSACTIONS_CEILING, INGEST_STATEMENTS_CEILING, INGEST_TRANSACTIONS_CEILING,
} from "../../../scripts/perf/ingest-cost-pin.mjs";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ═══ WHAT ONE INGESTED MESSAGE COSTS IN DATABASE ROUND TRIPS ═════════════════════════════
 *
 * The initial mirror build was measured on the hosted service at a slow, flat rate, with
 * no ramp and no decay — hours for an ordinary account. Neither half of the
 * obvious explanation held: IMAP `APPEND` into the same mailbox ran at 65–71/s, and
 * `message_bodies` never lagged `messages` by a row, so neither the mail server nor the body
 * fetch was the limiter.
 *
 * The limiter is THIS number. Ingest is serial and per-message — `planChange` reads, then
 * `commitChange` writes inside its own transaction — and every one of those statements is a
 * network round trip when the database is not in the same process. The count below times the
 * hosted round-trip latency IS the observed rate; the same code path against an in-process store
 * runs two orders of magnitude faster, which is why the desktop builds its mirror in minutes.
 *
 * So this is a RATCHET, and it may only fall. A pass that adds one statement per message adds it
 * to every message of every first sync, and the arithmetic is what makes that visible before a
 * release rather than after one.
 *
 * ── WHY THE MARGINAL COST AND NOT THE TOTAL ─────────────────────────────────────────────────
 *
 * A cycle pays a fixed cost too — the cursor build, the folder reads, the once-per-cycle passes —
 * and that cost is amortised over the batch, so a total divided by the batch size answers a
 * different question at every size. Two sizes give the slope, which is the part that scales with
 * the mailbox, and the intercept is reported for the record rather than pinned.
 *
 * Counted at PGlite's own client, including the handle a transaction hands its callback: drizzle
 * drives `client.transaction(cb)`, and every write inside the per-message transaction goes through
 * that `tx` rather than through the client's own doors. Wrapping only `query`/`exec` counts the
 * read phase and none of the writes — which reads as 4 statements per message instead of 24.
 */

const ACCOUNT = "00000000-0000-4000-8000-00000000a11e";

/** The two doors drizzle drives, on the client and on a transaction's handle alike. */
interface Doors {
  query: (...a: unknown[]) => Promise<unknown>;
  exec: (...a: unknown[]) => Promise<unknown>;
}
interface Client extends Doors {
  transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown>;
}

interface Counted { statements: number; transactions: number; byTable: Map<string, number> }

/** The table a statement names first — what the per-table breakdown is keyed on. */
function tableOf(text: unknown): string {
  const q = typeof text === "string" ? text : String((text as { sql?: unknown } | null)?.sql ?? "");
  const s = q.replace(/\s+/g, " ").trim().toLowerCase();
  if (/^(begin|commit|rollback|savepoint|release)/.test(s)) return "(transaction)";
  if (s.startsWith("with body as")) return "message_bodies+search";
  const m = /^(?:insert into|update|delete from) "?([a-z_]+)"?/.exec(s) ?? /\bfrom "?([a-z_]+)"?/.exec(s);
  return m?.[1] ?? "(other)";
}

/** Ingest `n` delivered messages in ONE cycle and count what the store was asked. */
async function ingest(n: number, opts: { admitAll?: boolean; runs?: boolean } = {}): Promise<Counted> {
  const db = (await makeTestDb()) as unknown as Tx;
  const client = (db as unknown as { $client: Client }).$client;
  const seen: Counted = { statements: 0, transactions: 0, byTable: new Map() };
  let counting = false;
  const instrument = <T extends Doors>(target: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = target[door].bind(target);
      target[door] = (...a: unknown[]): Promise<unknown> => {
        if (counting) {
          seen.statements += 1;
          const t = tableOf(a[0]);
          seen.byTable.set(t, (seen.byTable.get(t) ?? 0) + 1);
        }
        return inner(...(a as []));
      };
    }
    return target;
  };
  instrument(client);
  const innerTx = client.transaction.bind(client);
  client.transaction = (cb) => {
    if (counting) seen.transactions += 1;
    return innerTx((tx) => cb(instrument(tx)));
  };

  const [mb] = await db.insert(mailboxes)
    .values({ accountId: ACCOUNT, provider: "imap", address: `mb-${randomUUID().slice(0, 8)}@lichtgrat.example` })
    .returning();
  // THE IMPORT'S SHAPE: a domain rule admits every fixture sender to the Imbox, so nothing is filed
  // and what is counted is the store's own cost per letter.
  if (opts.admitAll === true) {
    await db.insert(rules).values({
      accountId: ACCOUNT, kind: "domain", match: "x.example", destination: "INBOX", provenance: "manual", enabled: true, priority: 0,
    });
  }
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mb!.id, {
    deliver: Array.from({ length: n }, (_, i) => ({
      from: `s${i % 40}@x.example`, subject: `msg ${i}`, messageId: `m-${i}@x`, seen: i % 10 < 3,
    })),
  });

  counting = true;
  const out = await runSyncCycle({
    // A FIXTURE HOLDS NO ORGANIZER LEASE, and `SyncDeps.writeAuthority` is required, so it
    // says so rather than leaving the field out — an omission is the shape that let a
    // hosted cycle write to a mailbox whose lease it had never asked about.
    writeAuthority: FIXTURE_LEASE,
    repo: opts.runs === true ? ingestRunRepository(makeDrizzleRepo(db as never)) : makeDrizzleRepo(db as never),
    ...(opts.runs === true ? { ingestRuns: INGEST_RUN_BOUNDS } : {}),
    adapter, accountId: ACCOUNT,
    mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP,
    // Both REQUIRED in `SyncDeps`, because for both the absent default is the dangerous branch.
    // The organizer role is the one the cost is measured under; an empty trusted set means every
    // `Authentication-Results` verdict reads "unavailable", which is this fixture's own mail.
    role: "organizer", trustedAuthservIds: new Set<string>(),
  });
  counting = false;

  // THE POSITIVE CONTROL. A cycle that ingested nothing costs almost nothing per message because
  // there are no messages, and every bound below would pass on it.
  expect(out.hasBacklog, "the fixture did not hand over the whole batch in one cycle").toBe(false);
  const rows = await db.select({ id: messages.id }).from(messages);
  expect(rows, `ingest wrote ${rows.length} rows for ${n} delivered messages`).toHaveLength(n);
  return seen;
}

/** The marginal statements per letter, by table, between two cycle sizes. */
function perTable(small: Counted, large: Counted, span: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of new Set([...small.byTable.keys(), ...large.byTable.keys()])) {
    const d = ((large.byTable.get(t) ?? 0) - (small.byTable.get(t) ?? 0)) / span;
    if (d !== 0) out[t] = Number(d.toFixed(2));
  }
  return out;
}

describe("the ingest's per-message database cost", () => {
  it("stays at or below the round-trip count the hosted mirror-build rate is made of", async () => {
    const small = await ingest(40);
    const large = await ingest(200);
    const span = 200 - 40;
    const perMessage = (large.statements - small.statements) / span;
    const txPerMessage = (large.transactions - small.transactions) / span;
    const perCycle = small.statements - 40 * perMessage;

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      statements40: small.statements, statements200: large.statements,
      transactions40: small.transactions, transactions200: large.transactions,
      statementsPerMessage: Number(perMessage.toFixed(2)),
      transactionsPerMessage: Number(txPerMessage.toFixed(2)),
      statementsPerCycle: Math.round(perCycle),
      byTable: perTable(small, large, span),
    }));

    /*
     * MEASURED 24.0 statements and 2.0 transactions per message (40 to 200 in one cycle, no classifier),
     * 9 per cycle; bounds sit half a statement above and the SIZES are part of the pin (a range of cycle sizes
     * reads 20.9 and 1.4). THE RISE 24.00 to 25.00 IS A RULING, not measurement drift (2026-09-14): the
     * removal fence now covers the whole cycle rather than the ingest commit alone, and transactions are
     * UNCHANGED both sides — one read, no new locking. The fall to 24.0 is the dedup lookup's keys asked
     * in one statement. The per-message statement is `fileOne`'s
     * completion group, and this fixture has no `moveMany`, so it is the UNBATCHED WORST CASE
     * (production pays it once per chunk). A ratchet may only FALL, so its bound is written as a
     * ruling. Both bounds live in `scripts/perf/ingest-cost-pin.mjs` — the portable harness reads
     * them too, and two instruments with two literals drift into a false finding.
     */
    expect(
      perMessage,
      `ingest now costs ${perMessage.toFixed(2)} statements per message; every one of them is a `
      + "round trip on the hosted service, and the first-sync rate is that count times the latency",
    ).toBeLessThanOrEqual(INGEST_STATEMENTS_CEILING);
    expect(
      txPerMessage,
      `ingest now opens ${txPerMessage.toFixed(2)} transactions per message`,
    ).toBeLessThanOrEqual(INGEST_TRANSACTIONS_CEILING);
    // And the reading is a real one: a counter that never fired would satisfy every bound above.
    expect(large.statements, "nothing was counted").toBeGreaterThan(1000);
    expect(large.transactions, "no transaction was counted").toBeGreaterThan(100);
  }, 300_000);

  it("the import's shape: letters a rule admits, nothing filed", async () => {
    const small = await ingest(40, { admitAll: true, runs: true });
    const large = await ingest(200, { admitAll: true, runs: true });
    const span = 200 - 40;
    const perMessage = (large.statements - small.statements) / span;
    const txPerMessage = (large.transactions - small.transactions) / span;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      shape: "import", statementsPerMessage: Number(perMessage.toFixed(2)),
      transactionsPerMessage: Number(txPerMessage.toFixed(2)),
      statementsPerCycle: Math.round(small.statements - 40 * perMessage), byTable: perTable(small, large, span),
    }));
    // MEASURED 1.10 statements and 0.01 transactions per letter: the dedup read per letter, and one
    // run's writes spread over its hundred letters. Both bounds are rulings, as above.
    expect(perMessage, `the import now costs ${perMessage.toFixed(2)} statements per letter`)
      .toBeLessThanOrEqual(INGEST_RUN_STATEMENTS_CEILING);
    expect(txPerMessage, `the import now opens ${txPerMessage.toFixed(2)} transactions per letter`)
      .toBeLessThanOrEqual(INGEST_RUN_TRANSACTIONS_CEILING);
    expect(large.statements, "nothing was counted").toBeGreaterThan(200);
  }, 300_000);
});
