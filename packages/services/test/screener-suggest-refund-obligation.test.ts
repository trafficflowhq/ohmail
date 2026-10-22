import { describe, it, expect, vi } from "vitest";
import { accounts, screenerAttemptKey } from "@trafficflow/db";
import type { RefundObligation, RefundObligationPort } from "@trafficflow/db";
import { makeHaikuClassifier, type AnthropicLike, type ClassifierPort } from "@trafficflow/core";
import { ScreenerService } from "../src/index.js";
import { fakeSpendPort, type FakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICES, PLANE_PRICING } from "./helpers/plane-pricing.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";

/**
 * THE PRESSED SCREENER OWES A REFUND BEFORE IT TRIES ONE. A declined sender and a sender whose
 * store faulted are refunded at the purchase's one door; a release the billing program never
 * receives used to keep that charge with nothing left to return it. The obligation is now written
 * first and settled by a `settled` receipt, as the worker's pass and the drafting route do; a
 * debt whose write throws is named and the refund still tried. Mutations: drop the `owe` (no
 * debt), settle on any receipt, or let a throwing write skip the release (the old order).
 */

const NOW = new Date("2026-10-12T12:00:00Z");

/** The real classifier over Anthropic's documented refusal for the named senders. */
function model(refuse: ReadonlySet<string>): ClassifierPort {
  const client = { messages: { create: async (params: unknown) => {
    const from = (JSON.parse((params as { messages: { content: string }[] }).messages[0]!.content) as { from: string }).from;
    return refuse.has(from)
      ? { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
          usage: { input_tokens: 900, output_tokens: 0 } }
      : { content: [{ type: "text", text: JSON.stringify({ destination: "INBOX", confidence: 0.9, rationale: "a person" }) }],
          stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 40 } };
  } } } as AnthropicLike;
  return makeHaikuClassifier({ client });
}

/** The obligation store, recording into the same event list as the gate's releases. `writeFails`
 *  makes every `owe` throw as a database that has just failed would; `settleFails` every `settle`. */
function obligationsInto(events: string[], writeFails = false, settleFails = false): RefundObligationPort & {
  owed: RefundObligation[]; settled: Array<{ accountId: string; attempt: string }>;
} {
  const owed: RefundObligation[] = [];
  const settled: Array<{ accountId: string; attempt: string }> = [];
  return {
    owed, settled,
    async owe(o) {
      events.push("owe");
      if (writeFails) throw new Error("08006 connection failure");
      owed.push(o);
    },
    async settle(accountId, attempt) {
      events.push("settle");
      if (settleFails) throw new Error("57014 statement timeout");
      settled.push({ accountId, attempt });
    },
  };
}

/** The gate, its releases written into the shared event list in call order. */
function gateInto(events: string[]): FakeSpendPort {
  const gate = fakeSpendPort();
  const release = gate.release.bind(gate);
  gate.release = async (accountId, r) => {
    events.push(r.refund ? "refund" : "release");
    return release(accountId, r);
  };
  return gate;
}

async function world() {
  const w = await makeCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "refund-obligation" });
  const alice = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
  const events: string[] = [];
  return { ...w, alice, events, gate: gateInto(events), obligations: obligationsInto(events) };
}

/** The attempt the gate said it charged for the first spend. */
const firstAttempt = (gate: FakeSpendPort): string => {
  const o = gate.spends[0]!.outcome;
  return o.verdict === "ok" ? o.attempt : "";
};

describe("a declined sender's refund is owed before it is tried", () => {
  it("the refund is LOST: the debt is recorded, unsettled, and `charged` says what was paid", async () => {
    const w = await world();
    w.gate.releasesAreLost();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set(["alice@ex.example"])), credits: w.gate, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations: w.obligations });

    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_declined" }]);
    expect(w.obligations.owed).toEqual([{
      accountId: w.accountId, action: "screener", attemptKey: screenerAttemptKey(w.alice),
      attempt: firstAttempt(w.gate), reason: "drafter_failed", meta: { messageId: w.alice },
    }]);
    expect(w.obligations.settled, "a debt nobody was paid was marked settled").toEqual([]);
    expect(w.events).toEqual(["owe", "refund"]);
    expect(res.charged).toBe(PLANE_PRICES.screener);
  });

  it("the refund LANDS: owed first, then settled, and the credit leaves `charged`", async () => {
    const w = await world();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set(["alice@ex.example"])), credits: w.gate, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations: w.obligations });

    expect(w.events, "the refund was tried before the debt was written").toEqual(["owe", "refund", "settle"]);
    expect(w.obligations.settled).toEqual([{ accountId: w.accountId, attempt: firstAttempt(w.gate) }]);
    expect(res.charged).toBe(0);
  });
});

describe("a sender whose store faulted is refunded the same way", () => {
  function storeFaults(svc: ScreenerService): void {
    (svc as unknown as { store: () => Promise<void> }).store = async () => { throw new Error("store 08006"); };
  }

  it("the refund is LOST: the run's own error stands and the debt waits for the drain", async () => {
    const w = await world();
    w.gate.releasesAreLost();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set()), credits: w.gate, pricing: PLANE_PRICING });
    storeFaults(svc);

    let thrown = "none";
    try {
      await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations: w.obligations });
    } catch (err) { thrown = (err as Error).message; }

    expect(thrown).toBe("store 08006");
    expect(w.obligations.owed).toEqual([expect.objectContaining({
      action: "screener", attemptKey: screenerAttemptKey(w.alice), attempt: firstAttempt(w.gate), reason: "drafter_failed",
    })]);
    expect(w.obligations.settled).toEqual([]);
    expect(w.events).toEqual(["owe", "refund"]);
  });

  it("the refund LANDS: the debt is settled in the same press", async () => {
    const w = await world();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set()), credits: w.gate, pricing: PLANE_PRICING });
    storeFaults(svc);
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations: w.obligations }).catch(() => undefined);
    expect(w.events).toEqual(["owe", "refund", "settle"]);
  });
});

describe("a debt whose write fails is named, and the refund is still tried", () => {
  /** Every log line the purchase writes, captured from the default sink. */
  async function logged<T>(fn: () => Promise<T>): Promise<{ lines: Array<Record<string, unknown>>; value: T | undefined; thrown: string }> {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      try { lines.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* not a log line */ }
    });
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    let value: T | undefined;
    let thrown = "none";
    try { value = await fn(); } catch (err) { thrown = (err as Error).message; } finally { spy.mockRestore(); errs.mockRestore(); }
    return { lines, value, thrown };
  }

  it("a decline: the refund is released, nothing is settled, and the line names the account and attempt", async () => {
    const w = await world();
    const obligations = obligationsInto(w.events, true);
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set(["alice@ex.example"])), credits: w.gate, pricing: PLANE_PRICING });

    const { lines, value } = await logged(() => svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations }));

    expect(w.events, "a debt that could not be written skipped the refund").toEqual(["owe", "refund"]);
    expect(obligations.settled).toEqual([]);
    expect(value!.charged, "the refund settled, so the credit left `charged`").toBe(0);
    const named = lines.filter((l) => l.event === "screener_suggest_refund_unrecorded");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ accountId: w.accountId, attempt: firstAttempt(w.gate) });
    expect(JSON.stringify(named[0]), "the line carried the sender's address").not.toContain("alice@ex.example");
  });

  it("a store fault: the run's own error stands and the refund is still released", async () => {
    const w = await world();
    const obligations = obligationsInto(w.events, true);
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set()), credits: w.gate, pricing: PLANE_PRICING });
    (svc as unknown as { store: () => Promise<void> }).store = async () => { throw new Error("store 08006"); };

    const { thrown } = await logged(() => svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations }));

    expect(thrown).toBe("store 08006");
    expect(w.events).toEqual(["owe", "refund"]);
    expect(obligations.settled).toEqual([]);
  });
});

/**
 * A SETTLE THAT THROWS AFTER A SETTLED REFUND: the program took the refund, so the purchase says
 * so (`charged` drops the credit), the failure is named with the account and the attempt, and it
 * is never reported as a failed claim release. The debt stays open; the drain's re-send names the
 * same attempt, which the program reverses once. Mutation: rethrow the settle in `reverseCharge`.
 */
describe("a settle that throws after a settled refund is named, not a failed release", () => {
  it("a decline: the refund settles, the credit leaves `charged`, and no release is reported failed", async () => {
    const w = await world();
    const obligations = obligationsInto(w.events, false, true);
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set(["alice@ex.example"])), credits: w.gate, pricing: PLANE_PRICING });

    const lines: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    const out = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      try { lines.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* not a log line */ }
    });
    const err = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
    let charged = -1;
    try {
      charged = (await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations })).charged;
    } finally {
      out.mockRestore();
      err.mockRestore();
    }

    expect(w.events).toEqual(["owe", "refund", "settle"]);
    expect(charged, "the refund settled, so the credit left `charged`").toBe(0);
    const named = lines.filter((l) => l.event === "screener_suggest_refund_settle_failed");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ accountId: w.accountId, attempt: firstAttempt(w.gate) });
    expect(JSON.stringify(named[0]), "the line carried the sender's address").not.toContain("alice@ex.example");
    expect(lines.filter((l) => l.event === "screener_suggest_release_failed"), "a settled release was reported failed").toEqual([]);
    expect(errors, "a raw print on the suggest path").toEqual([]);
  });
});

describe("nothing is owed where nothing was refunded", () => {
  it("a delivered suggestion keeps its charge and owes nothing", async () => {
    const w = await world();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set()), credits: w.gate, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations: w.obligations });
    expect(res.suggestions.map((s) => s.sender)).toEqual(["alice@ex.example"]);
    expect(w.obligations.owed).toEqual([]);
    expect(w.events).toEqual(["release"]);
  });

  it("a model OUTAGE keeps the charge for the free retry and owes nothing", async () => {
    const w = await world();
    const outage: ClassifierPort = { async classify(): Promise<never> { throw new Error("anthropic 529"); } };
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: outage, credits: w.gate, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations: w.obligations });
    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_unavailable" }]);
    expect(w.obligations.owed).toEqual([]);
    expect(w.events).toEqual(["release"]);
  });

  it("a decline on a DUPLICATE charged nothing here, so it owes nothing", async () => {
    const w = await world();
    w.gate.answer({ verdict: "duplicate", charged: false, attempt: "someone-elses" });
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set(["alice@ex.example"])), credits: w.gate, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { obligations: w.obligations });
    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_declined" }]);
    expect(w.obligations.owed).toEqual([]);
    expect(w.events).toEqual(["release"]);
  });

  it("a metered host with no store still refunds, and names the debt it cannot record", async () => {
    const w = await world();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: model(new Set(["alice@ex.example"])), credits: w.gate, pricing: PLANE_PRICING });
      await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    } finally {
      spy.mockRestore();
    }
    expect(w.events).toEqual(["refund"]);
    expect(lines.filter((l) => l.includes("\"event\":\"screener_suggest_refund_unrecorded\""))).toHaveLength(1);
  });
});
