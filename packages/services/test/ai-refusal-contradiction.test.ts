import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, mailboxes, messages, type AccessVerdict, type SpendOutcome } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import type { ClassifierInput, ClassifierPort, ClassifierResult, DraftInput, DraftPort } from "@trafficflow/core";
import { DraftingService, ScreenerService, type ServiceContext } from "../src/index.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * "NO AI ACTIONS REMAIN ON THIS ACCOUNT" — SAID TO AN ACCOUNT THAT HAD PLENTY
 * Both AI call sites mapped the gate's answer to 503 for `fault`, 409 for the account's own off
 * switch, and 402 for EVERYTHING ELSE — an empty balance and every subscription-state reason
 * alike — so one unreadable subscription read became a payment demand to a funded customer, and
 * neither site logged the reason it was given. The rule these cases hold: a 402 is the one
 * answer a person acts on by spending money, so it is the one that has to be corroborated.
 * `quantity` corroborates itself; a `state` refusal is cross-checked against a FRESH access
 * read, and a read saying AI is available means the two halves disagree — a fault, never a bill.
 */

const NOW = new Date("2026-07-28T12:00:00Z");

/** What the access half answers, as the port states it. */
const ACTIVE: AccessVerdict = {
  ok: true,
  limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true },
};
const AI_OFF: AccessVerdict = {
  ok: true,
  limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: false },
};
const REFUSED: AccessVerdict = { ok: false, reason: "payment_required" };

/**
 * A SPEND DOUBLE THAT FAILS THE WAY THE PROGRAM FAILS: every money answer is a VERDICT and
 * nothing throws — the port's own contract. A double that raised would drive an arm no
 * production caller can reach.
 */
function gateAnswering(outcome: SpendOutcome) {
  return {
    async spend(): Promise<SpendOutcome> { return outcome; },
    async release(): Promise<"settled"> { /* nothing to give back: nothing was charged */ return "settled"; },
  };
}

/**
 * AN ACCESS DOUBLE, recording how it was asked. `access` never throws either, and it records
 * `fresh` because reading a HELD verdict here is the defect next door: a refusal cached a minute
 * ago is exactly the thing that outlives the condition that produced it.
 */
function accessAnswering(verdict: AccessVerdict) {
  const asks: Array<{ fresh: boolean }> = [];
  return {
    asks,
    async access(_id: string, opts?: { fresh?: boolean }): Promise<AccessVerdict> {
      asks.push({ fresh: opts?.fresh === true });
      return verdict;
    },
  };
}

class YesClassifier implements ClassifierPort {
  async classify(_i: ClassifierInput): Promise<ClassifierResult> {
    return { destination: "INBOX", confidence: 0.9, rationale: "a reason", spam: false };
  }
}

/** Every line the real logger wrote, parsed. The REAL one: the field census is under test too. */
let lines: Array<Record<string, unknown>>;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lines = [];
  spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line !== "string") return;
    try { lines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not ours */ }
  });
});
afterEach(() => { spy.mockRestore(); });

const refusals = () => lines.filter((l) => l.event === "screener_suggest_refused" || l.event === "draft_refused");
const contradictions = () => lines.filter((l) => l.event === "refusal_contradicted_by_access");

async function screenerPress(outcome: SpendOutcome, access?: ReturnType<typeof accessAnswering>) {
  const w = await makeCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "refusal" });
  await seedMessage(w.db, w.accountId, w.mailboxId, { from: "stranger@example.com" });
  const svc = new ScreenerService({
    adapter: new FakeAdapter(),
    classifier: new YesClassifier(),
    credits: gateAnswering(outcome), pricing: PLANE_PRICING,
    ...(access ? { access } : {}),
  });
  return svc.suggest(w.ctx, { senders: ["stranger@example.com"] }, { idempotency: null });
}

async function draftPress(outcome: SpendOutcome, access?: ReturnType<typeof accessAnswering>) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x-ch.example" }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: dedup,
    subject: "s", fromAddress: "sender@example.com", snippet: "hi", date: NOW,
  }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
  const drafter: DraftPort = { async draft(_i: DraftInput) { throw new Error("the model was reached"); } };
  return new DraftingService().draftFromMessage(ctx, m!.id, {
    drafter,
    credits: gateAnswering(outcome),
    // A METERED PRESS CARRIES ITS MEMORY. Nothing here reaches it — every case in this file is
    // refused at the gate, before a charge — but the service refuses a metered composition that
    // could not record a refund, and refusing it HERE would hide the refusal these cases measure.
    obligations: { async owe() { /* unreached */ }, async settle() { /* unreached */ } },
    attemptKey: "k-1" as never,
    ...(access ? { access } : {}),
  });
}

/** The status and code of a refusal, whichever service threw it. */
async function statusOf(press: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await press;
  } catch (err) {
    const e = err as { httpStatus?: number; code?: string };
    return { status: e.httpStatus ?? 0, code: e.code ?? "" };
  }
  throw new Error("the press was expected to be refused and was not");
}

describe("a state refusal the access view contradicts is a fault, not a bill", () => {
  it("THE REPORTED CASE — `no_subscription` against an active, AI-enabled account is 503", async () => {
    // The exact pair from the report: the gate says the subscription may not spend, the account's
    // own access says AI is on. 402 here is the sentence that was on the card for twelve hours.
    const access = accessAnswering(ACTIVE);
    expect(await statusOf(screenerPress({ verdict: "refused", reason: "no_subscription" }, access)))
      .toEqual({ status: 503, code: "ai_unavailable" });
    // ASKED FRESH. A held verdict is the thing under suspicion.
    expect(access.asks).toEqual([{ fresh: true }]);
    expect(contradictions()).toHaveLength(1);
  });

  it("…and the drafting twin answers the same, because one module decides both", async () => {
    const access = accessAnswering(ACTIVE);
    expect(await statusOf(draftPress({ verdict: "refused", reason: "no_subscription" }, access)))
      .toEqual({ status: 503, code: "ai_unavailable" });
    expect(access.asks).toEqual([{ fresh: true }]);
  });

  it("an access read that AGREES leaves the 402 exactly where it was", async () => {
    // The positive control on the refusal above, and the half that must not move: a genuinely
    // cancelled account still meets a payment demand, with its reason.
    const access = accessAnswering(REFUSED);
    expect(await statusOf(screenerPress({ verdict: "refused", reason: "canceled" }, access)))
      .toEqual({ status: 402, code: "insufficient_credits" });
    expect(contradictions()).toHaveLength(0);
  });

  it("access saying AI is OFF agrees too — `ok: true` alone is not the answer", async () => {
    // A verdict can be `ok` and still say AI is off. Reading only `ok` would turn every such
    // refusal into a 503 and leave the account with no sentence it could act on.
    const access = accessAnswering(AI_OFF);
    expect(await statusOf(screenerPress({ verdict: "refused", reason: "past_due" }, access)))
      .toEqual({ status: 402, code: "insufficient_credits" });
    expect(contradictions()).toHaveLength(0);
  });

  it("AN EMPTY BALANCE IS UNCHANGED — 402, and nobody is asked about it", async () => {
    // The hard stop. `quantity` is the one refusal a payment fixes, it corroborates itself, and
    // a second question about it would only be a way to get it wrong.
    const access = accessAnswering(ACTIVE);
    expect(await statusOf(screenerPress({ verdict: "insufficient", reason: "out_of_credits" }, access)))
      .toEqual({ status: 402, code: "insufficient_credits" });
    expect(access.asks, "an empty balance asked the access half about itself").toEqual([]);
  });

  it("…and a draft on an empty balance is the same 402, the model never reached", async () => {
    // The drafter double throws a plain error if it is called, which no refusal carries: a press
    // that went on to the model answers with no status at all.
    const access = accessAnswering(ACTIVE);
    expect(await statusOf(draftPress({ verdict: "insufficient", reason: "out_of_credits" }, access)))
      .toEqual({ status: 402, code: "insufficient_credits" });
    expect(access.asks).toEqual([]);
  });

  it("the account's own off switch is still 409, and asks nobody either", async () => {
    const access = accessAnswering(ACTIVE);
    expect(await statusOf(screenerPress({ verdict: "refused", reason: "ai_disabled" }, access)))
      .toEqual({ status: 409, code: "ai_disabled" });
    expect(access.asks).toEqual([]);
  });

  it("a gate FAULT is 503 without asking — we do not bill for our own outage", async () => {
    const access = accessAnswering(REFUSED);
    expect(await statusOf(screenerPress({ verdict: "fault" }, access)))
      .toEqual({ status: 503, code: "ai_unavailable" });
    expect(access.asks).toEqual([]);
  });

  it("NO ACCESS READER WIRED: the answer is what it always was", async () => {
    // A host that composed no access half is no worse off than before this existed. The
    // cross-check narrows a payment demand; it never widens one.
    expect(await statusOf(screenerPress({ verdict: "refused", reason: "no_subscription" })))
      .toEqual({ status: 402, code: "insufficient_credits" });
  });

  it("an access read that FAILS is not a contradiction — an unknown cannot clear a refusal", async () => {
    // Failing the way the client fails would be a verdict; this double throws, which is the
    // caller-bug shape, and the answer must still be the refusal the gate actually gave.
    const access = {
      async access(): Promise<AccessVerdict> { throw new Error("the credit check could not be reached"); },
    };
    expect(await statusOf(screenerPress({ verdict: "refused", reason: "no_subscription" }, access as never)))
      .toEqual({ status: 402, code: "insufficient_credits" });
  });
});

describe("every refusal is on the record, through the real logger", () => {
  it("carries the verdict, the class, the reason and the account", async () => {
    // THE REAL LOGGER, not a fake one: the field census drops a name it does not know and reports
    // it in `droppedFields`, and a suite that injects its own sink measures what the call site
    // HANDS OVER rather than what is emitted. That is how six instrumented fields have been
    // silently refused here before.
    await statusOf(screenerPress({ verdict: "refused", reason: "no_subscription" })).catch(() => null);
    const [line] = refusals();
    expect(line, "the refusal wrote no line at all").toBeTruthy();
    expect(line!.event).toBe("screener_suggest_refused");
    expect(line!.verdict).toBe("refused");
    expect(line!.refusal).toBe("state");
    expect(line!.reason).toBe("no_subscription");
    expect(typeof line!.accountId).toBe("string");
    expect(line!.droppedFields, "the census refused a field this line exists to carry").toBeUndefined();
  });

  it("the drafting site writes its own event, with the same four facts", async () => {
    await statusOf(draftPress({ verdict: "insufficient", reason: "out_of_credits" }));
    const [line] = refusals();
    expect(line!.event).toBe("draft_refused");
    expect(line!.verdict).toBe("insufficient");
    expect(line!.refusal).toBe("quantity");
    expect(line!.reason).toBe("out_of_credits");
    expect(line!.droppedFields).toBeUndefined();
  });

  it("ONE LINE PER REQUEST, not one per sender", async () => {
    await statusOf(screenerPress({ verdict: "refused", reason: "past_due" }));
    expect(refusals()).toHaveLength(1);
  });
});
