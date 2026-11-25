import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { makeAnthropicClient, makeHaikuClassifier } from "@trafficflow/core";
import { accounts, accountSettings, messages, changeScreenerLearning, updateScreenerLearning, screenerAttemptKey, UNMETERED_ACCESS, type AccessPort } from "@trafficflow/db";
import { makeDeclineMemory, screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";
import { NOW, gateInto, held, obligationsInto, world } from "./_auto-suggest-world.js";

const advice = { destination: "ohmail/News", confidence: 0.8, rationale: "A newsletter", spam: false } as const;

it.each(["hosted worker", "standalone drain"])("the %s stops asking after consent is turned Off", async (host) => {
  const scope = await world();
  await held(scope, "first@example.invalid", 1);
  const second = await held(scope, "second@example.invalid", 2);
  const events: string[] = [];
  const credits = gateInto(events);
  const obligations = obligationsInto(events);
  const ask = vi.fn(async () => {
    if (ask.mock.calls.length === 1) {
      await scope.db.update(accountSettings).set({ autoSuggestAt: null })
        .where(eq(accountSettings.accountId, scope.accountId));
    }
    return advice;
  });
  const pass = await screenerAutoSuggestPass(scope.db, {
    accountId: scope.accountId,
    classifier: { screen: ask, classify: ask },
    ...(host === "hosted worker" ? { credits, obligations } : { unmetered: true }),
    now: () => NOW,
    declines: makeDeclineMemory(),
  });
  expect(ask).toHaveBeenCalledTimes(1);
  expect(pass.bought).toBe(1);
  if (host === "hosted worker") {
    expect(credits.releases.map(({ attemptKey, refund }) => ({ attemptKey, refund })).filter((r) => r.refund))
      .toEqual([{ attemptKey: screenerAttemptKey(second), refund: true }]);
    expect(events).toEqual(["release", "owe", "refund", "settle"]);
    expect(pass.chargedAttempts).toBe(1);
  } else {
    expect(pass.chargedAttempts).toBe(0);
  }
});

it("asks once for one held sender with a current On grant", async () => {
  const scope = await world();
  await held(scope, "held@example.invalid", 1);
  const ask = vi.fn(async () => advice);
  const pass = await screenerAutoSuggestPass(scope.db, {
    accountId: scope.accountId,
    classifier: { screen: ask, classify: ask },
    unmetered: true,
    now: () => NOW,
    declines: makeDeclineMemory(),
  });
  expect(ask).toHaveBeenCalledTimes(1);
  expect(pass.bought).toBe(1);
});

it("drops and refunds a model retry after consent is turned Off during the first attempt", async () => {
  const scope = await world();
  const messageId = await held(scope, "held@example.invalid", 1);
  const events: string[] = [];
  const credits = gateInto(events);
  const obligations = obligationsInto(events);
  let sent = 0;
  const client = makeAnthropicClient({
    apiKey: "synthetic",
    maxRetries: 1,
    sleep: async () => undefined,
    fetchImpl: async () => {
      sent++;
      await scope.db.update(accountSettings).set({ autoSuggestAt: null })
        .where(eq(accountSettings.accountId, scope.accountId));
      return Response.json({}, { status: 503 });
    },
  });
  const pass = await screenerAutoSuggestPass(scope.db, {
    accountId: scope.accountId,
    classifier: makeHaikuClassifier({ client }),
    credits, obligations, now: () => NOW, declines: makeDeclineMemory(),
  });
  expect(sent).toBe(1);
  expect(pass.bought).toBe(0);
  expect(pass.chargedAttempts).toBe(0);
  expect(credits.releases[0]).toMatchObject({ attemptKey: screenerAttemptKey(messageId), refund: true });
  expect(events).toEqual(["owe", "refund", "settle"]);
});

it("refunds a managed background suggestion when account AI turns Off after the debit", async () => {
  const scope = await world();
  await held(scope, "held@example.invalid", 1);
  const events: string[] = [];
  const credits = gateInto(events);
  const spend = credits.spend.bind(credits);
  credits.spend = async (...args) => {
    const outcome = await spend(...args);
    await scope.db.update(accounts).set({ aiEnabled: false }).where(eq(accounts.id, scope.accountId));
    return outcome;
  };
  const ask = vi.fn(async () => advice);
  const access: AccessPort = {
    access: async () => ({ ...UNMETERED_ACCESS }),
    accessOrFault: async () => ({ ...UNMETERED_ACCESS }),
  };
  await screenerAutoSuggestPass(scope.db, {
    accountId: scope.accountId, classifier: { screen: ask, classify: ask },
    credits, access, obligations: obligationsInto(events), now: () => NOW, declines: makeDeclineMemory(),
  });
  expect(ask).toHaveBeenCalledTimes(0);
  expect(events).toEqual(["owe", "refund", "settle"]);
});

it.each([false, true])("charges learning only when it supplied context (%s)", async (learned) => {
  const scope = await world();
  await changeScreenerLearning(scope.db, scope, { kind: "notice" }, NOW);
  if (learned) await updateScreenerLearning(scope.db, scope, state => ({ ...state, text: "Keep receipts." }));
  const messageId = await held(scope, "held@fixture.test", 1);
  const credits = gateInto([]);
  credits.answer({ verdict: "ok", charged: true, attempt: "2", chargedCredits: learned ? 2 : 1 });
  const ask = vi.fn(async (_input: import("@trafficflow/core").ClassifierInput) => advice);
  const result = await screenerAutoSuggestPass(scope.db, {
    accountId: scope.accountId, credits, classifier: { screen: ask, classify: ask }, now: () => NOW,
  });
  expect(result.bought).toBe(1);
  expect(credits.spends[0]?.meta).toEqual({ messageId, ...(learned ? { learning: true } : {}) });
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ ...(learned ? { learnedWords: "Keep receipts." } : {}) }), expect.anything());
  if (!learned) expect(ask.mock.calls[0]?.[0]).not.toHaveProperty("learnedWords");
});

it("buys ordinary automatic advice once when the learned prompt would exceed the budget", async () => {
  const scope = await world();
  await updateScreenerLearning(scope.db, scope, state => ({ ...state, notice: false, text: "界".repeat(680) }));
  const messageId = await held(scope, "long@fixture.test", 1);
  await scope.db.update(messages).set({ subject: "界".repeat(1_750) }).where(eq(messages.id, messageId));
  const credits = gateInto([]);
  const ask = vi.fn(async (_input: import("@trafficflow/core").ClassifierInput) => advice);
  const result = await screenerAutoSuggestPass(scope.db, {
    accountId: scope.accountId, credits, classifier: { screen: ask, classify: ask }, now: () => NOW,
  });
  expect(credits.spends.map(spend => spend.meta)).toEqual([{ messageId }]);
  expect(result.bought).toBe(1);
  expect(ask.mock.calls[0]?.[0]).not.toHaveProperty("learnedWords");
  expect(credits.releases.some(release => release.refund)).toBe(false);
});
