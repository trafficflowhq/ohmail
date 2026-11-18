import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, mailboxes, organizerRequests, rules } from "@trafficflow/db";
import { schema, makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { RulesService, type ServiceContext } from "@trafficflow/services";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE FAN-OUT UNDER CONCURRENCY — real Postgres, two live connections
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One rule edit becomes a local write plus one request per held mailbox. Both properties below are
 * about what happens when two of those run AT THE SAME TIME, and neither can be expressed on
 * PGlite: it is single-connection, so two awaited calls there are sequential by construction and a
 * sequential test of a concurrent property cannot fail.
 *
 *  1. EXACTLY ONE REQUEST PER (EDIT, MAILBOX). The loop that writes them reads its plan from a
 *     snapshot; two interleaved transactions must not produce a mailbox with two rows from one
 *     edit, nor a mailbox silently skipped. `organizer_requests` has no unique index over
 *     `(mailbox_id, kind, payload)` — two identical rules are a legal thing to ask for — so
 *     nothing in the schema would catch a double write. The count is the only witness.
 *
 *  2. ALL OR NOTHING. The local row and its requests are one decision. A transaction that fails
 *     after writing some of them must leave NONE — otherwise a person's rule exists on one machine
 *     and is queued for a second while the third was dropped, and no surface would ever say so.
 */
const PG_UP = await realPgAvailable();

const ownedA = makeOwnedDb(PG_TEST_URL);
const ownedB = makeOwnedDb(PG_TEST_URL);
const dbA = ownedA.db;
const dbB = ownedB.db;

const NOW = new Date("2026-09-07T09:00:00.000Z");
const svc = new RulesService();

const ctxOn = (db: typeof dbA, accountId: string): ServiceContext => ({
  db: dbFor(db, accountId),
  accountId, userId: null, now: () => NOW, requestId: `fc-${randomUUID().slice(0, 8)}`,
});

/** An account with one ORGANIZED mailbox and `held` readers whose holders advertise `rules`. */
async function world(readers: number): Promise<{ accountId: string; organized: string; held: string[] }> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: `fc-${accountId.slice(0, 8)}` });
  const [own] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `own-${accountId.slice(0, 8)}@fan.test`,
  }).returning();
  const held: string[] = [];
  for (let i = 0; i < readers; i += 1) {
    const [mb] = await dbA.insert(mailboxes).values({
      accountId, provider: "imap", address: `held${i}-${accountId.slice(0, 8)}@fan.test`,
      organizerRole: "reader", organizerState: "held",
      organizedByCapabilities: "requests,rules",
      organizedByKind: "local", organizedByName: `machine-${i}`,
    }).returning();
    held.push(mb!.id);
  }
  return { accountId, organized: own!.id, held };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await ownedA.close(); await ownedB.close(); });

describe.skipIf(!PG_UP)("two rule edits fanning out at once", () => {
  it("writes exactly one request per (edit, mailbox) — no duplicate, none skipped", async () => {
    const w = await world(3);

    // Two DIFFERENT edits, started together on two live connections so their fan-out loops
    // interleave. Different matches, so each edit's rows are identifiable by their payload.
    const [a, b] = await Promise.all([
      svc.create(ctxOn(dbA, w.accountId), {
        kind: "sender", match: "a@corp.example", destination: "ohmail/News",
      }),
      svc.create(ctxOn(dbB, w.accountId), {
        kind: "sender", match: "b@corp.example", destination: "ohmail/Receipts",
      }),
    ]);
    expect("pending" in a).toBe(false);
    expect("pending" in b).toBe(false);

    const rows = await dbA.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, w.accountId));

    // Three held mailboxes, two edits ⇒ six rows and not five, not seven.
    expect(rows).toHaveLength(6);

    // EXACTLY ONE per (edit, mailbox). Keyed on the payload's own match, so a row written twice
    // for one mailbox is visible as a count of two rather than hidden in the total.
    for (const match of ["a@corp.example", "b@corp.example"]) {
      const mine = rows.filter((r) => (r.payload as { key: { match: string } }).key.match === match);
      expect(mine).toHaveLength(3);
      expect(new Set(mine.map((r) => r.mailboxId))).toEqual(new Set(w.held));
    }

    // …and the ORGANIZED mailbox was never sent one: an install does not ask itself.
    expect(rows.some((r) => r.mailboxId === w.organized)).toBe(false);

    // Both local rows exist — the fan-out did not cost either edit its direct write.
    const ruleRows = await dbA.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(ruleRows).toHaveLength(2);
  });

  it("is ALL OR NOTHING — a transaction that fails after some requests leaves none", async () => {
    /* The local row and its requests are one decision. Driven by failing INSIDE the service's own
     * transaction, after the fan-out has written rows, so the rollback is the real one rather than
     * a simulated cleanup: the requests are written, then the transaction throws, and the
     * assertion is that the database kept nothing.
     *
     * `rules.match` has no length ceiling in the schema, so the failure is forced with a
     * deliberately invalid follow-up write on the SAME transaction handle — the point is that a
     * throw anywhere after the requests discards them, not which throw it is. */
    const w = await world(2);

    // The transaction is the account's: opened on its bound handle, so the binding rides it.
    await expect(dbFor(dbA, w.accountId).transaction(async (tx) => {
      const ctx = { ...ctxOn(dbA, w.accountId), db: tx as unknown as ServiceContext["db"] };
      await svc.create(ctx, { kind: "sender", match: "c@corp.example", destination: "ohmail/News" });
      // Rows exist at this point, inside the transaction…
      const mid = await tx.select().from(organizerRequests)
        .where(eq(organizerRequests.accountId, w.accountId));
      expect(mid).toHaveLength(2);
      throw new Error("forced rollback after the fan-out");
    })).rejects.toThrow(/forced rollback/);

    // …and none of them survived the rollback, nor did the rule.
    const after = await dbB.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, w.accountId));
    expect(after).toEqual([]);
    const ruleRows = await dbB.select().from(rules)
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "c@corp.example")));
    expect(ruleRows).toEqual([]);
  });

  it("a demotion committing mid-flight does not produce a request for a mailbox we also wrote", async () => {
    /* THE INTERLEAVING THE PLAIN READ CANNOT SEE. `planAccountFanOut` reads without a lock, so
     * between its snapshot and the writes another connection can change a role. The property that
     * must hold is the one that would corrupt data if it did not: a mailbox must never end up BOTH
     * counted as organized (its rule written locally) and sent a request for the same edit, which
     * on `rule.create` would mean the rule applied twice. */
    const w = await world(1);

    const [, ] = await Promise.all([
      svc.create(ctxOn(dbA, w.accountId), {
        kind: "sender", match: "d@corp.example", destination: "ohmail/News",
      }),
      dbB.update(mailboxes).set({
        organizerRole: "reader", organizerState: "held",
        organizedByCapabilities: "requests,rules",
        organizedByKind: "local", organizedByName: "raced-in",
      }).where(eq(mailboxes.id, w.organized)),
    ]);

    const rows = await dbA.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, w.accountId));
    const forOrganized = rows.filter((r) => r.mailboxId === w.organized);
    const ruleRows = await dbA.select().from(rules)
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "d@corp.example")));

    // Whichever way the race fell, the two outcomes are mutually exclusive for that mailbox:
    // either the edit was written locally for it and no request went to it, or it was treated as
    // held and got exactly one — never both, which is the state that applies a rule twice.
    if (ruleRows.length > 0) expect(forOrganized).toHaveLength(0);
    else expect(forOrganized).toHaveLength(1);
    // The genuinely held mailbox got its request either way.
    expect(rows.filter((r) => r.mailboxId === w.held[0]!)).toHaveLength(1);
  });
});
