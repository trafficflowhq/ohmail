import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import type { ClassifierPort } from "@trafficflow/core";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { pgTestUrl } from "@trafficflow/db/testing";
import { screenerAttemptKey } from "@trafficflow/db";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * **N CONCURRENT BUYERS MUST PRODUCE ONE MODEL CALL, NOT N — the product half of the spend
 * claim.**
 *
 * A charge proves an attempt HAPPENED; it cannot say whether the caller that made it has
 * finished. A port that answered the loser "already paid for, proceed" would be correct for a
 * retry after a crash and a giveaway for a caller still in flight — the loser would go on to a
 * second paid model call for one charge. So the port carries a SIXTH verdict, `inflight`, and
 * this file is what proves the Screener acts on it.
 *
 * Nothing upstream bounds N: `POST /screener/suggest` is `idempotent: true`, so DISTINCT
 * `Idempotency-Key`s do not collapse against each other, and the deployment has no edge rate
 * limit. It also needs no attacker — the worker's auto-suggest cron and a user pressing Suggest
 * select the same held sender by construction (see `screener-cron-press.race.pg.test.ts`).
 *
 * ## What is here and what is not
 *
 * HOW the exclusivity is kept — a claim row, its TTL, the takeover of an expired one, the sweep
 * — belongs to whoever operates metering and is proven there. What is asserted here is the
 * CALLER's behaviour on each verdict: one model call for six buyers, six coherent answers, a
 * released claim making the next ask free, and an `inflight` verdict refused honestly (503, no
 * charge, no model call) rather than proceeded on.
 *
 * ## Why this is still real Postgres and real parallelism
 *
 * The six racers each resolve and STORE through their own connection, and a suggestion the
 * store did not commit is a suggestion the next caller re-buys. PGlite runs one connection and
 * serialises everything put to it, so it cannot represent two callers being inside the window at
 * once — which IS the defect. The classifier sleeps so the window is wide enough to be measured
 * rather than hoped for.
 */
const URL = pgTestUrl(import.meta.url);

/** Six independent connections — one per racer, plus a reader. */
const pools = Array.from({ length: 7 }, () => postgres(URL, { max: 2 }));
const dbs = pools.map((p) => brandDialect(drizzle(p, { schema }), "pg"));
const reader = dbs[6]!;

const NOW = new Date("2026-07-28T12:00:00Z");
const RACERS = 6;

/** How long the model "takes". Wide enough that all six racers are inside the window together. */
const MODEL_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A classifier that COUNTS and is slow. The count is the whole assertion of this file: a spy
 * that answers instantly would let the winner finish before the losers even reach the gate, and
 * the test would pass against the defective code.
 */
function spy(counter: { n: number }, ms = MODEL_MS): ClassifierPort {
  return {
    async classify(i) {
      counter.n++;
      await sleep(ms);
      return { destination: "INBOX", confidence: 0.9, rationale: `about ${i.from.address}`, spam: false };
    },
  };
}

/**
 * ONE PORT, SHARED BY EVERY RACER — which is the production shape and the point.
 *
 * All six requests reach the same entitlements program, so the exclusivity they contend for is
 * ITS state and not each caller's. `exclusive()` makes the double answer the contract: first
 * asker `ok`, another asker for the same source while it is held `inflight`, and a released
 * source `duplicate`. A fresh port per racer would give six holders of one source and prove
 * nothing.
 */
const credits = fakeSpendPort();
credits.exclusive();

function ctxFor(db: Tx, accountId: string): ServiceContext {
  return { db, accountId, userId: null, now: () => NOW, requestId: randomUUID() };
}

async function seedAccount(granted: number, senders: string[]): Promise<{ accountId: string; ids: Map<string, string> }> {
  const accountId = randomUUID();
  await reader.insert(accounts).values({ id: accountId, name: "money1" });
  credits.budget(granted);
  const [mb] = await reader.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `m1-${accountId.slice(0, 8)}@ex.example` }).returning();

  const ids = new Map<string, string>();
  for (const from of senders) {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await reader.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "first contact", fromAddress: from, date: NOW, snippet: "hello",
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await reader.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    ids.set(from, m!.id);
  }
  return { accountId, ids };
}

/** What was CHARGED for this account — the port's own record of every `ok` it answered. */
const debitsOf = async (accountId: string) =>
  credits.spends.filter((c) => c.accountId === accountId && c.action === "screener");

describe("SEC3-MONEY-1 — the spend claim is exclusive, not just deduplicated", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => { await Promise.all(pools.map((p) => p.end({ timeout: 5 }))); });

  it("SIX concurrent purchases of ONE sender make ONE model call and ONE debit", async () => {
    // THE FINDING, as a number. Before the claim this was six calls for one credit — the ledger
    // collapsed the money and nothing collapsed the cost.
    const sender = "burst@ex.example";
    const { accountId } = await seedAccount(50, [sender]);
    const calls = { n: 0 };

    const results = await Promise.all(dbs.slice(0, RACERS).map((db) =>
      new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING })
        .suggest(ctxFor(db, accountId), { senders: [sender] })));

    expect(calls.n, "N model calls for one charge — the money boundary is open").toBe(1);

    // SIX ASKS, ONE CHARGE. The asks are all recorded — every racer did consult the port, which
    // is what makes the single charge the PORT's answer rather than five callers skipping it.
    expect(await debitsOf(accountId), "every racer asked").toHaveLength(RACERS);
    const charged = credits.spends.filter((c) => c.accountId === accountId).length;
    expect(charged, "every racer asked exactly once").toBe(RACERS);
    expect(results.reduce((s, r) => s + r.charged, 0), "more than one attempt reported a charge")
      .toBe(1);

    // ── AND ALL SIX CALLERS GET A COHERENT ANSWER ─────────────────────────────────────────
    //
    // Not "one wins and five get an error": the losers wait for the holder's verdict and serve
    // it. One request paid, one model ran, six people were answered, and every answer is the
    // SAME verdict — which is the property a per-request model call could never have, because
    // six independent classifications may legitimately disagree.
    for (const r of results) {
      expect(r.suggestions, "a caller was left with no answer at all").toHaveLength(1);
      expect(r.suggestions[0]!.rationale).toBe(`about ${sender}`);
      expect(r.skipped).toEqual([]);
    }
    expect(new Set(results.map((r) => r.suggestions[0]!.destination)).size).toBe(1);
  }, 30_000);

  it("the claim is RELEASED on completion, so a later ask is still a free retry", async () => {
    // The exclusivity must not outlive the work. A claim that survived its holder would turn the
    // "a charge buys one unit of work and every retry of it is free" contract into "and then the
    // sender is locked for a minute" — so the row goes away when the model call ends, and the
    // NEXT ask over the same message answers `duplicate` and costs nothing.
    const sender = "release@ex.example";
    const { accountId, ids } = await seedAccount(50, [sender]);
    const calls = { n: 0 };
    const svc = new ScreenerService({ classifier: spy(calls, 1), credits, pricing: PLANE_PRICING });

    await svc.suggest(ctxFor(dbs[0]!, accountId), { senders: [sender] });
    // THE RELEASE HAPPENED FOR THIS SENDER, and it is the caller's half of the contract: the
    // work ended, so the claim goes back. A holder that never released would leave the next
    // asker `inflight` for the length of whatever bound the program keeps.
    //
    // Counted BY SOURCE and not by total: the module-scoped port is shared by every case in
    // this file, so a total is a reading of whoever ran before.
    const mine = credits.releases.filter(
      (r) => r.accountId === accountId && r.attemptKey === screenerAttemptKey(ids.get(sender)!),
    );
    expect(mine.length, "the work ended and the claim was not released").toBeGreaterThanOrEqual(1);

    // A second ask is served from the STORE (layer 1) and never reaches either the gate or the
    // model — the cheapest of the three layers, and the one this change must not disturb.
    const again = await svc.suggest(ctxFor(dbs[0]!, accountId), { senders: [sender] });
    expect(calls.n).toBe(1);
    expect(again.suggestions).toHaveLength(1);
    expect(again.charged).toBe(0);
    expect(await debitsOf(accountId)).toHaveLength(1);
    expect(ids.get(sender)).toBe(again.suggestions[0]!.messageId);
  }, 30_000);

  it("an INFLIGHT verdict is refused honestly — 503, no charge, no model call", async () => {
    // The verdict the port answers when another caller holds this exact work, and the one that
    // must never be read as `duplicate`. **503 rather than 402** is the assertion, not an
    // incidental: the account is fully funded, and the only thing standing between it and a
    // suggestion is another caller's concurrency — so a payment demand would be a bill for
    // somebody else's overlap. 503's own words are the right instruction too ("temporarily
    // unavailable; please retry"), because retrying IS what clears this.
    //
    // How long the holder may hold it, and what happens when a holder dies, is the entitlements
    // program's bound and is proven on its side; what is asserted here is that the caller stops.
    const sender = "inflight@ex.example";
    const { accountId, ids } = await seedAccount(50, [sender]);
    const calls = { n: 0 };
    const svc = new ScreenerService({ classifier: spy(calls, 1), credits, pricing: PLANE_PRICING });

    credits.answer({ verdict: "inflight", source: `screener:${ids.get(sender)!}` });
    await expect(svc.suggest(ctxFor(dbs[0]!, accountId), { senders: [sender] }))
      .rejects.toMatchObject({ code: "ai_unavailable", httpStatus: 503 });
    expect(calls.n, "an inflight verdict did not stop the model call").toBe(0);

    // …and the same request succeeds the moment the port stops saying so, which is what makes
    // the refusal above the verdict rather than a broken fixture.
    credits.answer({ verdict: "ok", charged: true, attempt: "after-inflight" });
    const after = await svc.suggest(ctxFor(dbs[0]!, accountId), { senders: [sender] });
    expect(calls.n, "the caller never recovered").toBe(1);
    expect(after.suggestions).toHaveLength(1);
    expect(ids.get(sender)).toBe(after.suggestions[0]!.messageId);
  }, 30_000);
});
