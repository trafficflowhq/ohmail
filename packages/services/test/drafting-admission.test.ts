import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, clientIdempotencyKey } from "@trafficflow/db";
import type { RefundObligation, RefundObligationPort } from "@trafficflow/db";
import { ENTITLEMENTS_CALL_BUDGET_MS } from "@trafficflow/db/cloud";
import { DraftingService, DRAFT_ADMISSION, dbFor, draftWindow } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import type { DraftCallOptions, DraftInput, DraftPort } from "@trafficflow/core";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";

/**
 * DRAFTING-ROUTE-HAS-NO-ADMISSION-ARITHMETIC — never charge for a draft that cannot finish.
 *
 * On a host the platform kills at a ceiling, the spend used to land and the model call could run
 * past the kill: no catch, no refund, and a sentence claiming nothing was charged. Now a spend is
 * taken only while the least model time is left, and the model call is cut before the kill so the
 * one door (the owed row, then the release by flag) runs and the person reads what happened.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z");
const attemptKey = clientIdempotencyKey("press-1");

function fakeObligations(): RefundObligationPort & { owed: RefundObligation[] } {
  const owed: RefundObligation[] = [];
  return {
    owed,
    async owe(o) { if (!owed.some((p) => p.attempt === o.attempt)) owed.push(o); },
    async settle() { /* the release landed; nothing else to do */ },
  };
}

/** A drafter that answers at once, and one that never answers and records the signal it was handed. */
const quick: DraftPort = { async draft() { return { subject: "Re: hi", body: "Thanks.", rationale: "r" }; } };
function hanging(): DraftPort & { signals: (AbortSignal | undefined)[]; calls: number } {
  const signals: (AbortSignal | undefined)[] = [];
  const port = {
    signals, calls: 0,
    draft(_input: DraftInput, opts?: DraftCallOptions) {
      port.calls += 1;
      signals.push(opts?.signal);
      return new Promise<never>(() => { /* a model that never answers, and ignores the signal */ });
    },
  };
  return port;
}

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x-ch.example" }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `adm:${randomUUID()}`,
    subject: "Seed subject", fromAddress: "sender@example.com", snippet: "seed", date: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { ctx, messageId: m!.id };
}

describe("drafting takes a charge only with time to use it", () => {
  it("the arithmetic's spend budget is the entitlements client's own", () => {
    expect(DRAFT_ADMISSION.spendCallCeilingMs).toBe(ENTITLEMENTS_CALL_BUDGET_MS);
    expect(draftWindow(undefined, 0), "a host that states no ceiling gets no window").toBeNull();
    const w = draftWindow(60_000, 0)!;
    expect(w.modelDeadline).toBe(60_000 - DRAFT_ADMISSION.closeReserveMs);
    expect(w.admitUntil).toBe(w.modelDeadline - DRAFT_ADMISSION.spendCallCeilingMs - DRAFT_ADMISSION.minModelMs);
  });

  it("refuses before the spend when the least model time is not left — nothing is charged", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    const drafter = hanging();
    // Less time than the spend call plus the least model time plus the close: admitUntil is past.
    const svc = new DraftingService(undefined, undefined, { invocationBudgetMs: 5_000 });
    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter, credits, obligations: fakeObligations(), attemptKey,
    })).rejects.toMatchObject({ code: "ai_unavailable", httpStatus: 503 });
    expect(credits.spends, "no credit moved").toHaveLength(0);
    expect(drafter.calls, "and no model was asked").toBe(0);
  });

  it("admits a press with the invocation ahead of it — the positive control", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    const svc = new DraftingService(undefined, undefined, { invocationBudgetMs: 60_000 });
    const out = await svc.draftFromMessage(ctx, messageId, {
      drafter: quick, credits, obligations: fakeObligations(), attemptKey,
    });
    expect(out.draftId).toBeTruthy();
    expect(credits.spends).toHaveLength(1);
  });

  it("cuts a model call that would outlive the invocation, and returns the charge by flag", async () => {
    const { ctx, messageId } = await setup();
    const credits = fakeSpendPort();
    const obligations = fakeObligations();
    const drafter = hanging();
    // A 300 ms invocation with nothing reserved: admitted at once, cut at 300 ms.
    const svc = new DraftingService(undefined, undefined, {
      invocationBudgetMs: 300, admission: { spendCallCeilingMs: 0, minModelMs: 0, closeReserveMs: 0 },
    });
    await expect(svc.draftFromMessage(ctx, messageId, {
      drafter, credits, obligations, attemptKey,
    })).rejects.toMatchObject({ code: "ai_draft_failed", httpStatus: 503, details: { credits: "returned" } });
    expect(credits.spends).toHaveLength(1);
    expect(obligations.owed, "the debt is written before the reversal").toHaveLength(1);
    expect(credits.releases).toEqual([expect.objectContaining({ refund: true })]);
    expect(drafter.signals[0]?.aborted, "the drafter was told to stop").toBe(true);
  });

  it("a host with no ceiling hands the drafter no deadline", async () => {
    const { ctx, messageId } = await setup();
    const seen: (AbortSignal | undefined)[] = [];
    const recording: DraftPort = {
      async draft(input, opts) { seen.push(opts?.signal); return quick.draft(input); },
    };
    await new DraftingService().draftFromMessage(ctx, messageId, { drafter: recording });
    expect(seen).toEqual([undefined]);
  });
});
