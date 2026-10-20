import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { drafts, mailboxes, messages, clientIdempotencyKey } from "@trafficflow/db";
import type { RefundObligation, RefundObligationPort, SpendPort } from "@trafficflow/db";
import type { AnthropicCallReport, DraftCallOptions, DraftPort } from "@trafficflow/core";
import { DraftingService, DRAFT_ADMISSION, DRAFT_USAGE_RELEASE } from "../src/index.js";
import type { DraftsService, ServiceContext } from "../src/index.js";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";

/*
 * THE DRAFT'S USAGE RIDES ITS RELEASE. A delivered draft is released once, after it is stored,
 * carrying the model call's line; a failed call's line rides the refund; a host that states no
 * usage host sends nothing new; and a release that would not fit before the platform's kill is
 * skipped and logged rather than holding a stored draft's answer.
 */

const NOW = new Date("2026-09-30T12:00:00.000Z");
const attemptKey = clientIdempotencyKey("press-usage");

const REPORT: AnthropicCallReport = {
  model: "claude-sonnet-5", ok: true, status: 200, latencyMs: 900, attempts: 1, requestId: "req_1",
  inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 40,
  costMicroUsd: 5400,
};
const FAILED: AnthropicCallReport = {
  ...REPORT, ok: false, status: 529, inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheWriteTokens: null, thinkingTokens: null, costMicroUsd: null,
};

/** A drafter that reports its call the way the live client does, then answers or throws. */
function reportingDrafter(opts: { throws?: boolean; spendMs?: number } = {}): DraftPort & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async draft(...args: [unknown, DraftCallOptions?]) {
      calls.push(args);
      if (opts.spendMs) vi.setSystemTime(Date.now() + opts.spendMs);
      args[1]?.onUsage?.(opts.throws ? FAILED : REPORT);
      if (opts.throws) throw new Error("the model refused");
      return { subject: "Re: Seed subject", body: "Thanks, noted.", rationale: "a reply" };
    },
  };
}

function fakeObligations(order: string[]): RefundObligationPort & { owed: RefundObligation[] } {
  const owed: RefundObligation[] = [];
  return {
    owed,
    async owe(o) { order.push("owe"); owed.push(o); },
    async settle() { order.push("settle"); },
  };
}

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x-ch.example" }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `use:${randomUUID()}`,
    subject: "Seed subject", fromAddress: "sender@example.com", snippet: "seed", date: NOW,
  }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
  const credits = fakeSpendPort();
  const order: string[] = [];
  /** The same port, noting how many drafts were stored when each release arrived. */
  const watched: SpendPort = {
    spend: (...a) => credits.spend(...a),
    release: async (a, r) => {
      order.push(`release:${String((await db.select().from(drafts)).length)}`);
      return credits.release(a, r);
    },
  };
  return { db, accountId, messageId: m!.id, ctx, credits, watched, order, obligations: fakeObligations(order) };
}

/** The `draft_usage_unrecorded` lines written while `run` ran. */
async function unrecordedDuring(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await run();
    return spy.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return {}; } })
      .filter((l) => l.event === "draft_usage_unrecorded");
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => { vi.useRealTimers(); });

describe("the draft's usage rides its release", () => {
  it("a delivered draft is released once, after it is stored, carrying the call's line", async () => {
    const w = await setup();
    const svc = new DraftingService(undefined, undefined, { usageHost: "api" });
    await svc.draftFromMessage(w.ctx, w.messageId, {
      drafter: reportingDrafter(), credits: w.watched, obligations: w.obligations, attemptKey,
    });
    expect(w.order).toEqual(["release:1"]);
    expect(w.credits.releases).toHaveLength(1);
    const release = w.credits.releases[0]!;
    expect(release.refund).toBe(false);
    expect(release.usage).toEqual([{
      accountId: w.accountId, action: "draft", host: "api", model: "claude-sonnet-5",
      at: expect.any(String), ok: true, attempts: 1, inputTokens: 1200, outputTokens: 300,
      cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 40,
    }]);
  });

  it("a failed call's line rides the refund, and the debt is written before it", async () => {
    const w = await setup();
    const svc = new DraftingService(undefined, undefined, { usageHost: "api" });
    await expect(svc.draftFromMessage(w.ctx, w.messageId, {
      drafter: reportingDrafter({ throws: true }), credits: w.watched, obligations: w.obligations, attemptKey,
    })).rejects.toThrow("your credits are back");
    expect(w.order).toEqual(["owe", "release:0", "settle"]);
    expect(w.credits.releases).toHaveLength(1);
    expect(w.credits.releases[0]!.refund).toBe(true);
    expect(w.credits.releases[0]!.usage).toEqual([expect.objectContaining({ ok: false, inputTokens: null })]);
  });

  it("a host that states no usage host: no hook, no success release, the drafter called as before", async () => {
    const w = await setup();
    const drafter = reportingDrafter();
    await new DraftingService().draftFromMessage(w.ctx, w.messageId, {
      drafter, credits: w.watched, obligations: w.obligations, attemptKey,
    });
    expect(drafter.calls).toEqual([[expect.anything()]]);
    expect(w.credits.releases).toEqual([]);
  });

  it("the budgeted arm carries the hook beside the signal", async () => {
    const w = await setup();
    const drafter = reportingDrafter();
    const svc = new DraftingService(undefined, undefined, { usageHost: "api", invocationBudgetMs: 60_000 });
    await svc.draftFromMessage(w.ctx, w.messageId, {
      drafter, credits: w.watched, obligations: w.obligations, attemptKey,
    });
    const opts = drafter.calls[0]![1] as DraftCallOptions;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(typeof opts.onUsage).toBe("function");
    expect(w.credits.releases).toHaveLength(1);
  });

  it("a release that no longer fits before the kill is skipped, the draft stands, and the log says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const w = await setup();
    const svc = new DraftingService(undefined, undefined, { usageHost: "api", invocationBudgetMs: 60_000 });
    let out: unknown;
    const lines = await unrecordedDuring(async () => {
      // 56 s of the 60: a 5 s release would end after the platform's kill.
      out = await svc.draftFromMessage(w.ctx, w.messageId, {
        drafter: reportingDrafter({ spendMs: 56_000 }), credits: w.watched, obligations: w.obligations, attemptKey,
      });
    });
    expect(out).toEqual({ draftId: expect.any(String), seq: expect.any(Number) });
    expect(w.credits.releases).toEqual([]);
    expect(lines.map((l) => l.why)).toEqual(["no_time"]);
    // The spend is the fake's clock, no wait of its own: 0.3 s as a rule, 2.5 s once on a loaded CI VM,
    // 13 s under 10% of a CPU.
  }, 30_000);

  it("the boundary: the release, the fault record and the response margin fit exactly, and one ms more does not", async () => {
    const edge = 60_000 - DRAFT_ADMISSION.spendCallCeilingMs - DRAFT_USAGE_RELEASE.faultRecordMs
      - DRAFT_USAGE_RELEASE.responseMarginMs;
    for (const [spendMs, releases, whys] of [[edge, 1, []], [edge + 1, 0, ["no_time"]]] as const) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const w = await setup();
      const svc = new DraftingService(undefined, undefined, { usageHost: "api", invocationBudgetMs: 60_000 });
      const lines = await unrecordedDuring(() => svc.draftFromMessage(w.ctx, w.messageId, {
        drafter: reportingDrafter({ spendMs }), credits: w.watched, obligations: w.obligations, attemptKey,
      }));
      expect(w.credits.releases, `at ${String(spendMs)} ms`).toHaveLength(releases);
      expect(lines.map((l) => l.why)).toEqual(whys);
      vi.useRealTimers();
    }
  });

  it("a store that faults after a delivered call: the store's error stands, and one release carries the line", async () => {
    const w = await setup();
    const drafts = { create: async () => { throw new Error("store 08006"); } } as unknown as DraftsService;
    const drafter = reportingDrafter();
    const svc = new DraftingService(drafts, undefined, { usageHost: "api" });
    let thrown = "none";
    const lines = await unrecordedDuring(async () => {
      try {
        await svc.draftFromMessage(w.ctx, w.messageId, { drafter, credits: w.watched, obligations: w.obligations, attemptKey });
      } catch (err) { thrown = (err as Error).message; }
    });
    expect(thrown).toBe("store 08006");
    expect(drafter.calls).toHaveLength(1);
    expect(w.credits.releases).toHaveLength(1);
    expect(w.credits.releases[0]!.refund).toBe(false);
    expect(w.credits.releases[0]!.usage).toEqual([expect.objectContaining({ ok: true, inputTokens: 1200 })]);
    expect(lines.map((l) => l.why)).toEqual(["store_failed"]);
  });

  it("the control: at 50 s of the 60 the release still fits and is made", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const w = await setup();
    const svc = new DraftingService(undefined, undefined, { usageHost: "api", invocationBudgetMs: 60_000 });
    const lines = await unrecordedDuring(() => svc.draftFromMessage(w.ctx, w.messageId, {
      drafter: reportingDrafter({ spendMs: 50_000 }), credits: w.watched, obligations: w.obligations, attemptKey,
    }));
    expect(w.credits.releases).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it("a release that throws: the draft stands and the log names the failure", async () => {
    const w = await setup();
    const throwing: SpendPort = { spend: w.watched.spend, release: async () => { throw new Error("socket hang up"); } };
    const svc = new DraftingService(undefined, undefined, { usageHost: "api" });
    let out: unknown;
    const lines = await unrecordedDuring(async () => {
      out = await svc.draftFromMessage(w.ctx, w.messageId, {
        drafter: reportingDrafter(), credits: throwing, obligations: w.obligations, attemptKey,
      });
    });
    expect(out).toEqual({ draftId: expect.any(String), seq: expect.any(Number) });
    expect(lines.map((l) => l.why)).toEqual(["release_failed"]);
  });

  it("an unreachable program: the draft stands and the log says the usage was not recorded", async () => {
    const w = await setup();
    w.credits.releasesAreLost();
    const svc = new DraftingService(undefined, undefined, { usageHost: "api" });
    let out: unknown;
    const lines = await unrecordedDuring(async () => {
      out = await svc.draftFromMessage(w.ctx, w.messageId, {
        drafter: reportingDrafter(), credits: w.watched, obligations: w.obligations, attemptKey,
      });
    });
    expect(out).toEqual({ draftId: expect.any(String), seq: expect.any(Number) });
    expect(lines.map((l) => l.why)).toEqual(["unreachable"]);
  });
});
