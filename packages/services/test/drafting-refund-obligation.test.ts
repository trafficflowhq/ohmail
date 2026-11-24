import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, messages, clientIdempotencyKey, UNMETERED_ACCESS } from "@trafficflow/db";
import type { RefundObligation, RefundObligationPort } from "@trafficflow/db";
import { DraftingService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { ModelDeclinedError, makeSonnetDrafter, type AnthropicLike, type DraftPort } from "@trafficflow/core";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";

/**
 * CHARGED FOR A DRAFT THAT NEVER ARRIVED — the obligation, and the sentence the person reads.
 *
 * The sequence: the spend lands, the drafter throws, the reversal is attempted, the entitlements
 * program is unreachable. Before this, `release` swallowed that and the request threw the
 * drafter's own error — so the debt existed nowhere and the client rendered `failedOpaqueEarly`,
 * whose last four words are "Nothing was charged". The charge had happened.
 *
 * TWO STATES, TWO SENTENCES, asserted apart: `credits: "returned"` when the program took the
 * reversal, `credits: "owed"` when it did not. Never one optional field — the whole point is that
 * a client must not have to guess which of the two happened to somebody's money.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z");

/** A drafter that always throws — the model call this spend paid for, producing nothing. */
const throwingDrafter: DraftPort = {
  async draft() { throw new Error("the model refused"); },
};

/** The obligation store, recording. Production's is a row; this is the same two calls. */
function fakeObligations(): RefundObligationPort & {
  owed: RefundObligation[]; settled: Array<{ accountId: string; attempt: string }>;
} {
  const owed: RefundObligation[] = [];
  const settled: Array<{ accountId: string; attempt: string }> = [];
  return {
    owed, settled,
    async owe(o) {
      // IDEMPOTENT PER (account, attempt), exactly as the unique index is: a double that appended
      // blindly would let a case pass while production refused the second row, or the reverse.
      if (!owed.some((p) => p.accountId === o.accountId && p.attempt === o.attempt)) owed.push(o);
    },
    async settle(accountId, attempt) { settled.push({ accountId, attempt }); },
  };
}

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "a@x-ch.example",
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `obl:${randomUUID()}`,
    subject: "Seed subject", fromAddress: "sender@example.com", snippet: "seed", date: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { db, accountId, messageId: m!.id, ctx };
}

const svc = new DraftingService();
const attemptKey = clientIdempotencyKey("press-1");

describe("DraftingService — a spend that bought nothing", () => {
  it("the refund is LOST: the debt is recorded and the person is told it is coming back", async () => {
    const { ctx, accountId, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    credits.releasesAreLost();
    const obligations = fakeObligations();

    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter: throwingDrafter, credits, obligations, attemptKey,
    })).rejects.toMatchObject({
      code: "ai_draft_failed",
      httpStatus: 503,
      details: { credits: "owed" },
    });

    // THE DEBT, and it names the attempt the program said it charged — not the attempt key, not
    // the source: a reversal that does not name the attempt reverses a neighbour's charge.
    expect(obligations.owed).toHaveLength(1);
    expect(obligations.owed[0]).toMatchObject({
      accountId, action: "draft", reason: "drafter_failed",
    });
    expect(obligations.owed[0]!.attempt).toBe(credits.spends[0]!.outcome.verdict === "ok"
      ? (credits.spends[0]!.outcome as { attempt: string }).attempt : "");
    // Nothing is marked paid, because nothing was.
    expect(obligations.settled).toEqual([]);
  });

  it("the refund LANDS: the debt is settled in the same request and the person is told so", async () => {
    const { ctx, accountId, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    const obligations = fakeObligations();

    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter: throwingDrafter, credits, obligations, attemptKey,
    })).rejects.toMatchObject({
      code: "ai_draft_failed",
      httpStatus: 503,
      details: { credits: "returned" },
    });

    // THE DEBT IS STILL WRITTEN FIRST. That order is the fix: were it written only on a lost
    // release, an invocation killed between the charge and the reversal would leave nothing.
    expect(obligations.owed).toHaveLength(1);
    expect(obligations.settled).toEqual([
      { accountId, attempt: obligations.owed[0]!.attempt },
    ]);
  });

  it("a DUPLICATE charged nothing, so nothing is owed and the caller's own error stands", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.answer({ verdict: "duplicate", charged: false, attempt: "someone-elses" });
    const obligations = fakeObligations();

    // The drafter's own error, unwrapped: this request moved no money, so it has nothing to say
    // about anybody's credits and must not invent a sentence about them.
    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter: throwingDrafter, credits, obligations, attemptKey,
    })).rejects.toThrow("the model refused");

    expect(obligations.owed).toEqual([]);
    expect(credits.releases).toHaveLength(1);
    expect(credits.releases[0]!.refund).toBe(false);
  });

  it("an UNMETERED host owes nothing and the drafter's error is what it always was", async () => {
    const { ctx, messageId } = await setup();
    await expect(svc.draftFromMessage(ctx, messageId, { drafter: throwingDrafter }))
      .rejects.toThrow("the model refused");
  });

  it("a METERED host with no obligation store is REFUSED before a credit moves", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();

    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter: throwingDrafter, credits, attemptKey,
    })).rejects.toMatchObject({ code: "internal", httpStatus: 500 });

    // BEFORE A CREDIT MOVES is the whole claim: discovering the wiring fault at the moment a
    // refund is owed is discovering it one charge too late.
    expect(credits.spends).toEqual([]);
  });

  it("a letter in a DISCONNECTED mailbox is refused before a credit moves: no draft could be stored there", async () => {
    const { db, ctx, messageId } = await setup();
    const [m] = await db.select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, messageId));
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, m!.mailboxId));
    const credits = fakeSpendPort();
    const drafter = { draft: vi.fn(throwingDrafter.draft) };

    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter, credits, obligations: fakeObligations(), attemptKey,
    })).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    expect(credits.spends).toEqual([]);
    expect(drafter.draft).not.toHaveBeenCalled();
  });
});

/**
 * A DECLINE IS SAID AS ONE. Anthropic's documented refusal, through the real drafter: pressing
 * again draws the same refusal, so the 503 "please retry" sentence is wrong for it — a 422 the
 * person can read, with the same two credit states as any draft that bought nothing, and the debt
 * written first exactly as above. Mutation: delete the `declined` reads in `DraftingService`'s catch.
 */
describe("DraftingService — the model declined the draft", () => {
  // Anthropic's refusals page, read 2026-10-12: HTTP 200, no content, the stop reason says why.
  const refusing = { messages: { create: async () => ({
    id: "msg_refusal", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [],
    stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
    usage: { input_tokens: 900, output_tokens: 0 },
  }) } } as AnthropicLike;
  const decliningDrafter: DraftPort = makeSonnetDrafter(refusing);

  it("keeps the charge when the model runs out of tokens after showing draft words", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    const obligations = fakeObligations();
    const delivered: string[] = [];
    const drafter: DraftPort = {
      async draft(_input, call) {
        call?.onPreview?.("Here are the first words.");
        throw new ModelDeclinedError("max_tokens", null);
      },
    };

    const err = await svc.draftFromMessage(ctx, messageId, {
      drafter, credits, obligations, attemptKey, onPreview: (text) => delivered.push(text),
    }).catch((e: unknown) => e);
    expect(delivered).toEqual(["Here are the first words."]);
    expect(credits.releases.map((release) => release.refund)).toEqual([false]);
    expect(obligations.owed).toEqual([]);
    expect(err).toMatchObject({
      code: "ai_draft_declined", httpStatus: 422, retryable: false, details: { credits: "used" },
    });
  });

  it("the refund LANDS: 422 `ai_draft_declined`, credits returned, not retryable", async () => {
    const { ctx, accountId, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    const obligations = fakeObligations();

    const err = await svc.draftFromMessage(ctx, messageId, {
      drafter: decliningDrafter, credits, obligations, attemptKey,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "ai_draft_declined", httpStatus: 422, retryable: false, details: { credits: "returned" },
    });
    expect(obligations.owed).toHaveLength(1);
    expect(obligations.owed[0]).toMatchObject({ accountId, action: "draft", reason: "drafter_failed" });
    expect(obligations.settled).toEqual([{ accountId, attempt: obligations.owed[0]!.attempt }]);
    expect(credits.releases.map((r) => r.refund)).toEqual([true]);
  });

  it("the refund is LOST: 422 with credits owed, and the debt stands", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    credits.releasesAreLost();
    const obligations = fakeObligations();

    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter: decliningDrafter, credits, obligations, attemptKey,
    })).rejects.toMatchObject({ code: "ai_draft_declined", httpStatus: 422, details: { credits: "owed" } });
    expect(obligations.owed).toHaveLength(1);
    expect(obligations.settled).toEqual([]);
  });

  it("a DUPLICATE charged nothing: the decline is said and no credit sentence is invented", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.answer({ verdict: "duplicate", charged: false, attempt: "someone-elses" });
    const obligations = fakeObligations();

    const err = await svc.draftFromMessage(ctx, messageId, {
      drafter: decliningDrafter, credits, obligations, attemptKey,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ai_draft_declined", httpStatus: 422 });
    expect((err as { details?: unknown }).details).toBeUndefined();
    expect(obligations.owed).toEqual([]);
    expect(credits.releases.map((r) => r.refund)).toEqual([false]);
  });

  it("an UNMETERED host says the decline too", async () => {
    const { ctx, messageId } = await setup();
    const err = await svc.draftFromMessage(ctx, messageId, { drafter: decliningDrafter }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ai_draft_declined", httpStatus: 422 });
    expect((err as { details?: unknown }).details).toBeUndefined();
  });
});

/**
 * A DEBT THAT CANNOT BE WRITTEN, AND A SETTLE THAT FAILS. The refund is still tried when its debt
 * write throws, and the person is told `owed` only where a debt is on record: a refund the program
 * did not take, whose debt was not written either, answers the uncharged shape, whose same-key retry
 * is free. A settle that throws after a settled refund is named and the person reads "back".
 * Mutations: let the write's throw skip the release, or answer `owed` without a debt on record.
 */
describe("DraftingService — the refund survives a failed debt write", () => {
  const refusing = { messages: { create: async () => ({
    id: "msg_refusal", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [],
    stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
    usage: { input_tokens: 900, output_tokens: 0 },
  }) } } as AnthropicLike;
  const decliningDrafter: DraftPort = makeSonnetDrafter(refusing);

  /** A store whose `owe` or `settle` throws as a database that has just failed would. */
  function failingObligations(fails: "owe" | "settle"): ReturnType<typeof fakeObligations> {
    const inner = fakeObligations();
    return {
      ...inner,
      async owe(o) {
        if (fails === "owe") throw new Error("08006 connection failure");
        await inner.owe(o);
      },
      async settle(accountId, attempt) {
        if (fails === "settle") throw new Error("57014 statement timeout");
        await inner.settle(accountId, attempt);
      },
    };
  }

  /** Every structured line the request writes, from the default sink, and what it threw. */
  async function logged(fn: () => Promise<unknown>): Promise<{ lines: Array<Record<string, unknown>>; err: unknown }> {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      try { lines.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* not a log line */ }
    });
    let err: unknown = null;
    try { await fn(); } catch (e) { err = e; } finally { spy.mockRestore(); }
    return { lines, err };
  }

  const charged = (credits: ReturnType<typeof fakeSpendPort>): string => {
    const o = credits.spends[0]!.outcome;
    return o.verdict === "ok" ? o.attempt : "";
  };

  it("the debt write THROWS and the refund LANDS: the person is told the credits are back", async () => {
    const { ctx, accountId, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    const obligations = failingObligations("owe");

    const { lines, err } = await logged(() => svc.draftFromMessage(ctx, messageId, {
      drafter: throwingDrafter, credits, obligations, attemptKey,
    }));

    expect(err).toMatchObject({ code: "ai_draft_failed", httpStatus: 503, details: { credits: "returned" } });
    expect(credits.releases.map((r) => r.refund), "the refund was skipped when its debt could not be written").toEqual([true]);
    expect(obligations.settled, "a debt that was never written was settled").toEqual([]);
    const named = lines.filter((l) => l.event === "draft_refund_unrecorded");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ accountId, attempt: charged(credits) });
    expect(JSON.stringify(named[0]), "the line carried the sender's address").not.toContain("sender@example.com");
  });

  it("the debt write THROWS and the refund is LOST: no credit sentence is promised, and the refund was tried", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    credits.releasesAreLost();
    const obligations = failingObligations("owe");

    const { err } = await logged(() => svc.draftFromMessage(ctx, messageId, {
      drafter: throwingDrafter, credits, obligations, attemptKey,
    }));

    // "will be returned" would be a promise no record backs: the drafter's own error is the answer.
    expect((err as Error).message).toBe("the model refused");
    expect((err as { details?: unknown }).details).toBeUndefined();
    expect(credits.releases.map((r) => r.refund)).toEqual([true]);
    expect(obligations.owed).toEqual([]);
  });

  it("a DECLINE whose debt write throws and whose refund is lost answers the plain decline", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    credits.releasesAreLost();

    const { err } = await logged(() => svc.draftFromMessage(ctx, messageId, {
      drafter: decliningDrafter, credits, obligations: failingObligations("owe"), attemptKey,
    }));

    expect(err).toMatchObject({ code: "ai_draft_declined", httpStatus: 422 });
    expect((err as { details?: unknown }).details).toBeUndefined();
    expect(credits.releases.map((r) => r.refund)).toEqual([true]);
  });

  it("the settle THROWS after a settled refund: the person is told the credits are back, and the line is named", async () => {
    const { ctx, accountId, messageId } = await setup();
    const credits = fakeSpendPort();
    credits.exclusive();
    const obligations = failingObligations("settle");

    const { lines, err } = await logged(() => svc.draftFromMessage(ctx, messageId, {
      drafter: throwingDrafter, credits, obligations, attemptKey,
    }));

    expect(err).toMatchObject({ code: "ai_draft_failed", httpStatus: 503, details: { credits: "returned" } });
    expect(obligations.owed).toHaveLength(1);
    const named = lines.filter((l) => l.event === "draft_refund_settle_failed");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ accountId, attempt: charged(credits) });
  });
});

it("withholds a paid press when the account turns AI off before the model dispatch", async () => {
  const { db, ctx, accountId, messageId } = await setup();
  await db.insert(accounts).values({ id: accountId, name: "draft account", aiEnabled: true });
  const credits = fakeSpendPort();
  const spend = credits.spend.bind(credits);
  credits.spend = async (...args) => {
    const outcome = await spend(...args);
    await db.update(accounts).set({ aiEnabled: false }).where(eq(accounts.id, accountId));
    return outcome;
  };
  const draft = vi.fn(async () => ({ subject: "Reply", body: "A draft", rationale: "" }));
  await svc.draftFromMessage(ctx, messageId, {
    drafter: { draft }, credits, obligations: fakeObligations(), attemptKey,
    access: {
      access: async () => ({ ...UNMETERED_ACCESS }),
      accessOrFault: async () => ({ ...UNMETERED_ACCESS }),
    },
  }).catch(() => undefined);
  expect(draft).toHaveBeenCalledTimes(0);
  expect(credits.releases).toEqual([expect.objectContaining({ refund: true })]);
});
