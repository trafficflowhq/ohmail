import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { accounts, accountSettings, UNMETERED_ACCESS, type AccessPort } from "@trafficflow/db";
import { ScreenerService } from "../src/index.js";
import { FakeAdapter, makeCtx, seedMessage } from "./helpers.js";
import { PLANE_PRICES, PLANE_PRICING } from "./helpers/plane-pricing.js";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";

async function world(access?: AccessPort) {
  const w = await makeCtx();
  const sender = "held@example.invalid";
  await w.db.insert(accounts).values({ id: w.accountId, name: "suggestion-consent" });
  await seedMessage(w.db, w.accountId, w.mailboxId, { from: sender });
  await w.db.insert(accountSettings).values({ accountId: w.accountId, autoSuggestAt: null });
  const setConsent = (autoSuggestAt: Date | null) => w.db.update(accountSettings)
    .set({ autoSuggestAt }).where(eq(accountSettings.accountId, w.accountId));
  const ask = vi.fn(async () => ({
    destination: "ohmail/News" as const, confidence: 0.8, rationale: "A newsletter", spam: false,
  }));
  const credits = fakeSpendPort();
  const service = new ScreenerService({
    adapter: new FakeAdapter(), classifier: { screen: ask, classify: ask }, credits, pricing: PLANE_PRICING, access,
  });
  return { ...w, sender, service, ask, credits, setConsent };
}

it("drops an automatic suggestion with persisted Off", async () => {
  const { ctx, sender, service, ask, credits } = await world();
  const result = await service.suggest(ctx, { senders: [sender], automatic: true });
  expect(ask).not.toHaveBeenCalled();
  expect(credits.spends).toHaveLength(0);
  expect(result.charged).toBe(0);
  expect(result.suggestions).toHaveLength(0);
});

it("buys a pressed suggestion with automatic suggestions Off and managed access On", async () => {
  const { ctx, sender, service, ask } = await world({
    access: async () => ({ ...UNMETERED_ACCESS }),
    accessOrFault: async () => ({ ...UNMETERED_ACCESS }),
  });
  const result = await service.suggest(ctx, { senders: [sender] });
  expect(ask).toHaveBeenCalledTimes(1);
  expect(result.charged).toBe(PLANE_PRICES.screener);
  expect(result.suggestions).toHaveLength(1);
});

it("calls the model once for a held sender with a current On grant", async () => {
  const { ctx, sender, service, ask, setConsent } = await world();
  await setConsent(new Date("2026-08-01T00:00:00Z"));
  const result = await service.suggest(ctx, { senders: [sender], automatic: true });
  expect(ask).toHaveBeenCalledTimes(1);
  expect(result.charged).toBe(PLANE_PRICES.screener);
  expect(result.suggestions).toHaveLength(1);
});

it("refunds a managed suggestion when the account AI switch turns Off after the debit", async () => {
  const { db, accountId, ctx, sender, service, ask, credits, setConsent } = await world({
    access: async () => ({ ...UNMETERED_ACCESS }),
    accessOrFault: async () => ({ ...UNMETERED_ACCESS }),
  });
  await setConsent(new Date("2026-08-01T00:00:00Z"));
  const spend = credits.spend.bind(credits);
  credits.spend = async (...args) => {
    const outcome = await spend(...args);
    await db.update(accounts).set({ aiEnabled: false }).where(eq(accounts.id, accountId));
    return outcome;
  };
  const result = await service.suggest(ctx, { senders: [sender], automatic: true });
  expect(ask).toHaveBeenCalledTimes(0);
  expect(credits.releases).toEqual([expect.objectContaining({ refund: true })]);
  expect(result.charged).toBe(0);
});

it("honors an admitted setup purchase when ordinary AI credits are empty", async () => {
  const { ctx, sender, service, ask, setConsent } = await world({
    access: async () => ({ ...UNMETERED_ACCESS }),
    accessOrFault: async () => ({
      ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: false }, dispatchAiEnabled: true,
    }),
  });
  await setConsent(new Date("2026-08-01T00:00:00Z"));
  const result = await service.suggest(ctx, { senders: [sender], automatic: true });
  expect(ask).toHaveBeenCalledTimes(1);
  expect(result.charged).toBe(PLANE_PRICES.screener);
});
