import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, routingDecisions } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import type { ClassifierPort } from "@trafficflow/core";
import { ScreenerService, type ScreenerSuggestResult, type ServiceContext } from "@trafficflow/services";
import { pgTestUrl } from "@trafficflow/db/testing";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * **The suggestion purchase under REAL-Postgres concurrency — two purchases of the same suggestions at once.**
 *
 * PGlite runs one connection and serialises everything put to it, so it cannot see the question
 * this file asks: two API instances, two physical connections, two requests that overlap. What
 * they contend for HERE is the mirror — the resolution read and the stored verdict — and the
 * answers this service gives about both.
 *
 * The money arbitration is no longer in this database and is not asserted here: both racers ask
 * ONE port, its double answers the contract (per-source exclusivity, and a budget that runs
 * out), and whether that is kept by a unique index or a lease is the entitlements program's
 * property, proven on its side.
 *
 * Three questions, one per test:
 *
 *  1. is one message charged twice when two requests ask for it simultaneously?
 *  2. can two concurrent purchases together spend more than the port admits?
 *  3. do the racing writers leave a suggestion the user cannot trust?
 */
const URL = pgTestUrl(import.meta.url);

const sqlA = postgres(URL, { max: 5 });
const sqlB = postgres(URL, { max: 5 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-07-28T12:00:00Z");

/** A classifier that answers instantly and counts, shared by both racers. */
function spy(counter: { n: number }): ClassifierPort {
  return {
    async classify(i) {
      counter.n++;
      return { destination: "INBOX", confidence: 0.9, rationale: `about ${i.from.address}`, spam: false };
    },
  };
}

/**
 * ONE PORT FOR BOTH RACERS, which is the production shape: two API instances, one entitlements
 * program. `exclusive()` is not decoration — the `calls.n` assertions below would go green
 * against a port with the exclusivity switched off, which is the one failure a money guard must
 * not have.
 */
const credits = fakeSpendPort();
credits.exclusive();


function ctxFor(db: typeof dbA, accountId: string): ServiceContext {
  return { db, accountId, userId: null, now: () => NOW, requestId: randomUUID() };
}

/** An account with a mailbox, `senders.length` held first-contact rows, and `granted` spends. */
async function seedAccount(granted: number, senders: string[]): Promise<string> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: "w5-race" });
  credits.budget(granted);
  const [mb] = await dbA.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `race-${accountId.slice(0, 8)}@ex.example` }).returning();

  for (const from of senders) {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await dbA.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "first contact", fromAddress: from, date: NOW, snippet: "hello",
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await dbA.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  }
  return accountId;
}

/** Every spend the port was ASKED for on this account, in order. */
const asksOf = (accountId: string) =>
  credits.spends.filter((c) => c.accountId === accountId && c.action === "screener");

describe("concurrent suggestion purchases against real Postgres", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

  it("two simultaneous purchases of the SAME five senders charge five credits, not ten", async () => {
    // The double-charge this exists to prevent. The attempt key is the MESSAGE, so `sourceFor`
    // composes the same source for both racers and the loser of each race is answered by the one
    // arbiter both connections share — the port.
    const senders = Array.from({ length: 5 }, (_, i) => `race${i}@ex.example`);
    const accountId = await seedAccount(20, senders);
    const calls = { n: 0 };

    const svcA = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    const svcB = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });

    const [a, b] = await Promise.all([
      svcA.suggest(ctxFor(dbA, accountId), { senders }),
      svcB.suggest(ctxFor(dbB, accountId), { senders }),
    ]);

    // Between them they paid for it once, and that is the assertion. What each racer QUOTED is
    // not: a quote prices the senders that have no answer YET, so the racer whose resolution
    // pass runs a moment later legitimately quotes fewer — measured at 4 of 5 here, three runs
    // out of three, once the money answer stopped being a database round trip and got fast
    // enough for the first racer to finish a sender inside the second's pass. Pinning 5 there
    // pins an interleaving, which is the one thing a concurrency test must not assert.
    expect(a.quoted, "a racer priced more senders than were asked for").toBeLessThanOrEqual(5);
    expect(b.quoted, "a racer priced more senders than were asked for").toBeLessThanOrEqual(5);
    expect(Math.max(a.quoted, b.quoted), "neither racer priced the whole set").toBe(5);
    expect(a.charged + b.charged, "one message was charged twice").toBe(5);

    // ── AND THE MODEL RAN ONCE PER MESSAGE, NOT ONCE PER REQUEST (SEC3-MONEY-1) ────────────
    //
    // This line was missing for the whole life of this file, and its absence is the finding. The
    // spy was already here and already shared by both racers; test 2 below reads it and this one
    // did not — so "five credits, not ten" was asserted while TEN paid model calls went by
    // unmeasured. The ledger's `UNIQUE (account_id, source)` collapses the MONEY and can say
    // nothing about the COST, because a debit row proves an attempt happened and not that the
    // caller which wrote it has finished.
    //
    // What makes it true is the exclusive claim taken in the same transaction as the debit: the
    // loser of the race is refused BEFORE `askScreeningQuestion` rather than waved through by
    // `duplicate`. `screener-suggest-exclusive.pg.test.ts` drives that mechanism directly and up
    // to six racers; this is the assertion the original file should have carried.
    expect(calls.n, "the model was asked once per REQUEST instead of once per message").toBe(5);

    // FIVE SOURCES, ASKED MORE THAN ONCE. The distinct-source count is what the arbitration was
    // keyed on; the total number of asks is NOT pinned, for the reason the quote above is not —
    // a sender the other racer has already answered is not re-priced, so it is not re-asked
    // either, and nine asks is as correct as ten. What must hold is that both racers really did
    // consult the port (so the single charge each is the PORT's answer and not a caller quietly
    // skipping the gate) and that at least one source was asked TWICE.
    const asks = asksOf(accountId);
    expect(new Set(asks.map((c) => c.source)).size, "the racers asked under different keys").toBe(5);
    expect(asks.length, "one racer never reached the gate").toBeGreaterThan(5);
    const twice = [...new Set(asks.map((c) => c.source))]
      .filter((src) => asks.filter((c) => c.source === src).length > 1);
    expect(twice.length, "no source was contended — the race did not happen").toBeGreaterThan(0);
    // …and the quote was a ceiling, never an under-statement, on both sides of the race.
    // A metered host priced by the program's card states a quote on both sides.
    expect(a.quotedCredits).toBeTypeOf("number");
    expect(b.quotedCredits).toBeTypeOf("number");
    expect(a.charged).toBeLessThanOrEqual(a.quotedCredits!);
    expect(b.charged).toBeLessThanOrEqual(b.quotedCredits!);
  });

  it("two concurrent purchases cannot together spend more than the balance", async () => {
    // Disjoint sender sets, so nothing is a duplicate and the only thing standing between the
    // two requests and an overdraft is the balance update itself. Three credits, ten messages.
    const mine = Array.from({ length: 5 }, (_, i) => `left${i}@ex.example`);
    const theirs = Array.from({ length: 5 }, (_, i) => `right${i}@ex.example`);
    const accountId = await seedAccount(3, [...mine, ...theirs]);
    const calls = { n: 0 };

    const svcA = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    const svcB = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });

    /*
     * ── ONE RACER MAY TAKE THE WHOLE BALANCE, AND THAT IS AN ANSWER RATHER THAN A FAILURE ──
     *
     * This used to destructure two results and sum their `charged`, which quietly assumed each
     * request would win at least one sender. That was never a promise — it was an artifact of the
     * purchase loop being strictly serial, which interleaved the two racers one sender at a time.
     * Now that a request buys its senders in bounded lanes, one side can take all three credits
     * before the other's first `spend` lands, and a request that bought NOTHING because the
     * balance is empty answers `insufficient_credits` — the 402 this service documents for
     * exactly that case ("a run that produced nothing because of the gate is not a success").
     *
     * So the outcome is asserted as the CLOSED SET it is: each racer either returns, or throws
     * that one error and nothing else. Every claim about the MONEY below is unchanged and now
     * holds across both interleavings rather than the one the serial loop happened to produce.
     */
    const settle = async (p: Promise<ScreenerSuggestResult>) => {
      try {
        return { ok: true as const, res: await p };
      } catch (err) {
        // NAMED, not swallowed. Any other throw — a 503, a driver error, an assertion — must fail
        // this test rather than be counted as "the other racer won".
        expect((err as { code?: string }).code, `an unexpected throw: ${String(err)}`)
          .toBe("insufficient_credits");
        expect((err as { httpStatus?: number }).httpStatus).toBe(402);
        return { ok: false as const, res: null };
      }
    };
    const [a, b] = await Promise.all([
      settle(svcA.suggest(ctxFor(dbA, accountId), { senders: mine })),
      settle(svcB.suggest(ctxFor(dbB, accountId), { senders: theirs })),
    ]);

    // At least one racer must have been served, or the balance was never spendable and this test
    // is measuring nothing.
    expect(a.ok || b.ok, "neither request bought anything — the seed did not fund the race").toBe(true);

    const served = [a.res, b.res].filter((r): r is ScreenerSuggestResult => r !== null);
    expect(served.reduce((n, r) => n + r.charged, 0)).toBe(3);
    // THREE `ok` ANSWERS AND NO MORE, across both racers — the port admitted its budget once
    // and every later ask was refused, which is the property an overdraft would break.
    expect(credits.spends.filter((c) => c.accountId === accountId).length,
      "a racer stopped asking").toBeGreaterThanOrEqual(3);
    // Seven senders were named, priced, and correctly not served — counting the whole of a racer
    // that was refused outright, whose five senders are all unserved by definition.
    const skippedCount = served.reduce((n, r) => n + r.skipped.length, 0)
      + (a.ok ? 0 : mine.length) + (b.ok ? 0 : theirs.length);
    expect(skippedCount).toBe(7);
    expect(served.flatMap((r) => r.skipped).every((s) => s.reason === "out_of_credits")).toBe(true);
    // And the model was never asked about mail nobody paid for. THE assertion of this test: it is
    // true under every interleaving, and it is what an overdraft would break.
    expect(calls.n).toBe(3);
    // Exactly as many suggestions came back as credits moved — no sender was served free.
    expect(served.reduce((n, r) => n + r.suggestions.length, 0)).toBe(3);
  });

  it("racing writers leave ONE readable verdict per sender — never a contradiction", async () => {
    // The delete-then-insert has no unique key to arbitrate it (there is no
    // `UNIQUE (account_id, message_id)` on `routing_decisions`), so an interleaving CAN leave
    // two rows for one message. What must never happen is two rows that DISAGREE, or a `list`
    // that shows a sender without the suggestion their account was charged for.
    const senders = Array.from({ length: 5 }, (_, i) => `both${i}@ex.example`);
    const accountId = await seedAccount(20, senders);
    const calls = { n: 0 };

    const svcA = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    const svcB = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    await Promise.all([
      svcA.suggest(ctxFor(dbA, accountId), { senders }),
      svcB.suggest(ctxFor(dbB, accountId), { senders }),
    ]);

    const page = await svcA.list(ctxFor(dbA, accountId), {});
    expect(page.items).toHaveLength(5);
    expect(page.items.every((i) => i.aiSuggestion !== null), "a paid-for sender has no verdict").toBe(true);
    expect(page.suggestable.senders, "an already-bought sender is still on sale").toEqual([]);

    const stored = await dbA.select().from(routingDecisions)
      .where(and(
        eq(routingDecisions.accountId, accountId),
        eq(routingDecisions.inputProvenance, "screener_suggestion"),
      ));
    for (const messageId of new Set(stored.map((r) => r.messageId))) {
      const forMessage = stored.filter((r) => r.messageId === messageId);
      expect(new Set(forMessage.map((r) => r.destination)).size,
        "two stored suggestions for one message disagree").toBe(1);
    }
  });
});
