import { describe, it, expect } from "vitest";
import { accounts } from "@trafficflow/db";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "@trafficflow/core";
import { ScreenerService } from "../src/index.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A CONFIRMED RUN COSTS NO MORE THAN THE FIGURE SOMEBODY PRESSED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The question the row carried for three months: is a confirmed Screener run bounded by the
 * credits the quote DISPLAYED, or only by the batch maximum? Ruled 2026-09-22: **by the quote**,
 * with `MAX_SUGGEST_SENDERS` as the second and lower bound.
 *
 * It matters because the quote and the confirm are two requests. The set is the same — the confirm
 * passes the addresses the quote priced — but the PRICE is not: a sender with a stored suggestion
 * is not priced, and a stored suggestion can lapse in between. So a set quoted at "3 senders · 3
 * credits" can cost 5 by the time somebody presses, and nothing in the request said otherwise.
 * A quote is a claim and claims are contracts.
 *
 * Every case below drives the real `suggest()` and reads what the RUN did — `charged`, the
 * suggestions it produced, the senders it refused — never a flag it was handed.
 */

const NOW = new Date("2026-07-28T12:00:00Z");

/** A classifier that answers every sender, so a short run is the ceiling and never the model. */
class Yes implements ClassifierPort {
  calls = 0;
  async classify(_input: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    return {
      destination: "INBOX", confidence: 0.9, spam: false,
      rationale: "a person writing to you",
    };
  }
}

async function billable() {
  const w = await makeCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "quote-ceiling" });
  return { ...w, gate: fakeSpendPort() };
}

const SENDERS = ["a@example.test", "b@example.test", "c@example.test", "d@example.test"];

async function seeded() {
  const w = await billable();
  for (const from of SENDERS) await seedMessage(w.db, w.accountId, w.mailboxId, { from });
  const model = new Yes();
  return { w, model, svc: new ScreenerService({
    adapter: new FakeAdapter(), classifier: model, credits: w.gate, pricing: PLANE_PRICING,
  }) };
}

describe("a confirmed run is bounded by the quote the person confirmed", () => {
  it("THE CONTROL: with no ceiling the run buys the whole set", async () => {
    // Chosen first and deliberately: every refusal below is only evidence beside a run that IS
    // admitted. Without this the ceiling could be doing nothing and the cases would still pass.
    const { model, svc, w } = await seeded();
    const res = await svc.suggest(w.ctx, { senders: SENDERS });
    expect(res.suggestions).toHaveLength(4);
    expect(res.charged).toBe(4);
    expect(model.calls).toBe(4);
    expect(res.stopped).toBeUndefined();
  });

  it("a ceiling the set has grown past stops the run at the number that was confirmed", async () => {
    const { model, svc, w } = await seeded();
    // What a control that quoted THREE credits sends back. The set is four now — the shape a
    // lapsed stored suggestion produces between the quote and the press.
    const res = await svc.suggest(w.ctx, { senders: SENDERS, maxCredits: 3 });

    expect(res.charged, "the run cost more than the figure somebody pressed").toBe(3);
    expect(res.suggestions).toHaveLength(3);
    expect(model.calls, "the model was asked about a sender nobody paid for").toBe(3);
    expect(res.stopped).toBe("over_quote");
    // The sender past the ceiling is TOLD, not silently absent: a row with no answer and no
    // reason is the state this product refuses everywhere else.
    expect(res.skipped.map((s) => s.reason)).toEqual(["over_quote"]);
  });

  it("…and it is not priced either — `quoted` is what the run will buy, not what it was asked", async () => {
    const { svc, w } = await seeded();
    const res = await svc.suggest(w.ctx, { senders: SENDERS, maxCredits: 3 });
    expect(res.quoted).toBe(3);
    expect(res.quotedCredits).toBe(3);
    expect(res.requested, "the request's own size is still reported honestly").toBe(4);
  });

  it("a ceiling the set still fits inside changes nothing at all", async () => {
    const { model, svc, w } = await seeded();
    const res = await svc.suggest(w.ctx, { senders: SENDERS, maxCredits: 4 });
    expect(res.charged).toBe(4);
    expect(res.suggestions).toHaveLength(4);
    expect(model.calls).toBe(4);
    expect(res.stopped).toBeUndefined();
  });

  it("a ZERO ceiling buys nothing — it is a real bound, not an absent one", async () => {
    // `0` and "no quote was shown" are different states and `??` would collapse them. A control
    // that pressed a button reading "0 credits" must not be charged for four.
    const { model, svc, w } = await seeded();
    const res = await svc.suggest(w.ctx, { senders: SENDERS, maxCredits: 0 });
    expect(res.charged).toBe(0);
    expect(model.calls).toBe(0);
    expect(res.stopped).toBe("over_quote");
  });

  it("refuses a changed eligible pair inside a partial quote before dispatch", async () => {
    const { model, svc, w } = await seeded();
    const senders = SENDERS.slice(0, 2);
    await svc.suggest(w.ctx, { senders: [senders[0]] });
    const quote = await svc.suggest(w.ctx, { senders, dryRun: true });
    expect(quote.quoted).toBe(1);
    expect(model.calls).toBe(1);

    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: senders[0], date: new Date("2026-07-28T10:00:00Z"),
    });
    const grant = quote.quoteGrant;
    const confirmed = { senders, maxCredits: quote.quotedCredits, quoteGrant: grant?.proof };
    await expect(svc.suggest(w.ctx, confirmed)).rejects.toMatchObject({ code: "suggest_quote_changed" });
    expect(model.calls).toBe(1);
  });

  it("buys the same held pair and serves the cached answer from a stable partial quote", async () => {
    const { model, svc, w } = await seeded();
    const senders = SENDERS.slice(0, 2);
    await svc.suggest(w.ctx, { senders: [senders[0]] });
    const quote = await svc.suggest(w.ctx, { senders, dryRun: true });
    expect(quote.quoted).toBe(1);
    expect(quote.quoteGrant?.pairs.map(({ sender }) => sender)).toEqual([senders[1]]);
    const result = await svc.suggest(w.ctx, {
      senders, maxCredits: quote.quotedCredits, quoteGrant: quote.quoteGrant!.proof,
    });
    expect(result.charged).toBe(1);
    expect(result.suggestions.map(({ sender }) => sender)).toEqual(senders);
    expect(model.calls).toBe(2);
  });

  it("rejects a grant copied to another account even for the same empty set", async () => {
    const { model, svc, w } = await seeded();
    const { ctx: other } = await billable();
    const senders = ["absent@example.test"];
    const quote = await svc.suggest(w.ctx, { senders, dryRun: true });
    expect(quote.quoteGrant?.pairs).toEqual([]);
    await expect(svc.suggest(other, {
      senders, maxCredits: quote.quotedCredits, quoteGrant: quote.quoteGrant!.proof,
    })).rejects.toMatchObject({ code: "suggest_quote_changed" });
    expect(model.calls).toBe(0);
  });

  it("a malformed ceiling is refused, never ignored", async () => {
    // A money bound that silently disappears is worse than one nobody claimed, so this is a 400
    // rather than a fall back to unbounded.
    const { svc, w } = await seeded();
    for (const bad of [-1, 1.5, "3", {}, Number.NaN]) {
      await expect(
        svc.suggest(w.ctx, { senders: SENDERS, maxCredits: bad }),
        `maxCredits: ${String(bad)} was accepted`,
      ).rejects.toThrow(/maxCredits/);
    }
  });

  it("a DRY RUN prices the whole set — a quote is what the ceiling is taken FROM", async () => {
    // The ceiling bounds the confirm. Applying it to the price check would quote a number derived
    // from the previous quote, which is a ladder down to nothing.
    const { model, svc, w } = await seeded();
    const res = await svc.suggest(w.ctx, { senders: SENDERS, dryRun: true });
    expect(res.quoted).toBe(4);
    expect(res.quotedCredits).toBe(4);
    expect(res.charged).toBe(0);
    expect(model.calls).toBe(0);
  });
});
