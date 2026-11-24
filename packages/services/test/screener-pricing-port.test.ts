import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, routingDecisions, UNPRICED } from "@trafficflow/db";
import type { ClassifierInput, ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { ScreenerService } from "../src/index.js";
import { makeSuggestionCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICES, planePricing } from "./helpers/plane-pricing.js";

/**
 * THE PRICE IS ASKED, NEVER HELD — the Screener's quote through `ActionPricing`.
 *
 * Three hosts, three answers, and nothing else in the run moves between them: an unmetered host
 * quotes and charges 0 and never asks; a metered host with no card withholds the quote and
 * refuses the purchase before the gate is asked; a metered host priced by the program's own card
 * quotes exactly what the card says — the same figure the Screener quoted before this tree
 * stopped holding one.
 */
const NOW = new Date("2026-07-28T12:00:00Z");
const SENDERS = ["a@example.test", "b@example.test"];

class Yes implements ClassifierPort {
  calls = 0;
  async classify(_i: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    return { destination: "INBOX", confidence: 0.9, spam: false, rationale: "a person writing to you" };
  }
}

async function seeded() {
  const w = await makeSuggestionCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "pricing-port" });
  for (const from of SENDERS) await seedMessage(w.db, w.accountId, w.mailboxId, { from });
  const stored = () => w.db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId));
  return { w, model: new Yes(), gate: fakeSpendPort(), stored };
}

describe("the Screener prices through the port", () => {
  it("UNMETERED: quotes 0, charges 0, stores the advice — and never asks for a price", async () => {
    const { w, model, stored } = await seeded();
    const pricing = planePricing();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model, pricing });
    const quote = await svc.suggest(w.ctx, { senders: SENDERS, dryRun: true });
    expect(quote).toMatchObject({ quoted: 2, quotedCredits: 0 });
    const run = await svc.suggest(w.ctx, { senders: SENDERS });
    expect(run).toMatchObject({ quoted: 2, quotedCredits: 0, charged: 0 });
    expect(run.suggestions).toHaveLength(2);
    expect(await stored()).toHaveLength(2);
    expect(pricing.calls, "an unmetered host asked what a suggestion costs").toEqual([]);
  });

  it("METERED, NO CARD: the dry run states no price, and the purchase is refused before any spend", async () => {
    const { w, model, gate, stored } = await seeded();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model, credits: gate, pricing: UNPRICED });
    const quote = await svc.suggest(w.ctx, { senders: SENDERS, dryRun: true });
    expect(quote.quoted).toBe(2);
    expect("quotedCredits" in quote, "a quote with no price was stated").toBe(false);
    await expect(svc.suggest(w.ctx, { senders: SENDERS }))
      .rejects.toMatchObject({ httpStatus: 503, code: "ai_unavailable" });
    expect(gate.spends, "the gate was asked to charge an unstated price").toEqual([]);
    expect(model.calls).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it("an ABSENT port on a metered host is the null default — the same refusal", async () => {
    const { w, model, gate } = await seeded();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model, credits: gate });
    await expect(svc.suggest(w.ctx, { senders: SENDERS }))
      .rejects.toMatchObject({ httpStatus: 503, code: "ai_unavailable" });
    expect(gate.spends).toEqual([]);
  });

  it("METERED, THE PROGRAM'S CARD: quotes and charges what the card says — today's figure", async () => {
    const { w, model, gate } = await seeded();
    const pricing = planePricing();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model, credits: gate, pricing });
    const quote = await svc.suggest(w.ctx, { senders: SENDERS, dryRun: true });
    // Two senders at the card's screener price, 1 — the "2 senders · 2 credits" the Screener said
    // while the price was a constant in this tree.
    expect(PLANE_PRICES.screener).toBe(1);
    expect(quote.quotedCredits).toBe(2);
    const run = await svc.suggest(w.ctx, { senders: SENDERS });
    expect(run).toMatchObject({ quotedCredits: 2, charged: 2 });
    expect(pricing.calls.map((c) => c.action)).toEqual(["screener", "screener"]);
    expect(pricing.calls.every((c) => c.accountId === w.accountId)).toBe(true);
  });

  it("the number is the PORT'S: a card at 3 quotes 6, and the confirmed ceiling is judged in it", async () => {
    const { w, model, gate } = await seeded();
    const pricing = planePricing({ ...PLANE_PRICES, screener: 3 });
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model, credits: gate, pricing });
    expect((await svc.suggest(w.ctx, { senders: SENDERS, dryRun: true })).quotedCredits).toBe(6);
    const run = await svc.suggest(w.ctx, { senders: SENDERS, maxCredits: 5 });
    expect(run).toMatchObject({ charged: 3, stopped: "over_quote" });
    expect(run.suggestions).toHaveLength(1);
  });
});
