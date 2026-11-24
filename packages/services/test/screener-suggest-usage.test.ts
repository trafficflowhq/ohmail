import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, messages } from "@trafficflow/db";
import type {
  AiCallOptions, AnthropicCallReport, ClassifierInput, ClassifierPort, ClassifierResult,
} from "@trafficflow/core";
import { ScreenerService } from "../src/index.js";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";
import { makeSuggestionCtx, seedMessage, FakeAdapter } from "./helpers.js";

/*
 * THE SCREENER'S USAGE RIDES ITS RELEASE: one line per purchased sender, attributed to the account
 * and `screener` on the host the composition root states, a model fault's line included. A host
 * that states none releases exactly what it always released.
 */

const NOW = new Date("2026-09-30T12:00:00Z");
const YES: ClassifierResult = { destination: "INBOX", confidence: 0.9, rationale: "a person", spam: false };
const REPORT: AnthropicCallReport = {
  model: "claude-haiku-5", ok: true, status: 200, latencyMs: 400, attempts: 1, requestId: "req_s",
  inputTokens: 800, outputTokens: 60, cacheReadTokens: 700, cacheWriteTokens: 0, thinkingTokens: null,
  costMicroUsd: 1100,
};

/** A classifier that reports its call the way the live client does, then answers or throws. */
function reporting(throws = false): ClassifierPort & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async classify(...args: [ClassifierInput, AiCallOptions?]) {
      calls.push(args);
      args[1]?.onUsage?.(throws ? { ...REPORT, ok: false, inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null } : REPORT);
      if (throws) throw new Error("overloaded");
      return YES;
    },
  };
}

async function world() {
  const w = await makeSuggestionCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "screener-usage" });
  await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
  const [m] = await w.db.select().from(messages).where(eq(messages.fromAddress, "alice@ex.example"));
  return { ...w, credits: fakeSpendPort(), messageId: m!.id };
}

describe("the Screener's usage rides its release", () => {
  it("a delivered suggestion's release carries the call's line", async () => {
    const w = await world();
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: reporting(), credits: w.credits, pricing: PLANE_PRICING, usageHost: "api",
    });
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(w.credits.releases).toHaveLength(1);
    expect(w.credits.releases[0]!.refund).toBe(false);
    expect(w.credits.releases[0]!.usage).toEqual([{
      accountId: w.accountId, action: "screener", host: "api", model: "claude-haiku-5",
      at: expect.any(String), ok: true, attempts: 1, inputTokens: 800, outputTokens: 60,
      cacheReadTokens: 700, cacheWriteTokens: 0, thinkingTokens: null,
    }]);
  });

  it("a model fault: the charge stands and the release carries the failed call's line", async () => {
    const w = await world();
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: reporting(true), credits: w.credits, pricing: PLANE_PRICING, usageHost: "api",
    });
    // What the run answers for a sender the model could not judge is the gate tests' subject.
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }).catch(() => undefined);
    expect(w.credits.releases).toHaveLength(1);
    expect(w.credits.releases[0]!.refund).toBe(false);
    expect(w.credits.releases[0]!.usage).toEqual([expect.objectContaining({ ok: false, inputTokens: null })]);
  });

  it("a store fault: the one release is the refund, and it carries the delivered call's line", async () => {
    const w = await world();
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: reporting(), credits: w.credits, pricing: PLANE_PRICING, usageHost: "api",
    });
    (svc as unknown as { store: () => Promise<void> }).store = async () => { throw new Error("store 08006"); };
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }).catch(() => undefined);
    expect(w.credits.releases).toHaveLength(1);
    expect(w.credits.releases[0]!.refund).toBe(true);
    expect(w.credits.releases[0]!.usage).toEqual([expect.objectContaining({ ok: true, inputTokens: 800 })]);
  });

  it("a host that states no usage host: no hook, and the release is what it always was", async () => {
    const w = await world();
    const classifier = reporting();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(classifier.calls).toEqual([[expect.anything(), { beforeDispatch: expect.any(Function) }]]);
    expect(w.credits.releases).toHaveLength(1);
    expect("usage" in w.credits.releases[0]!).toBe(false);
  });
});
