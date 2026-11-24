import { describe, it, expect } from "vitest";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { randomUUID } from "node:crypto";
import { accounts, changeScreenerLearning, readScreenerLearning, routingDecisions, updateScreenerLearning, type LedgerTx, type Tx } from "@trafficflow/db";
import { CLASSIFY_DESTINATIONS } from "@trafficflow/core/mail";
import type { ClassifierPort, ClassifierInput, ClassifierResult, Destination } from "@trafficflow/core";
import { ScreenerService, screenerLearningSettings, setScreeningPreference } from "../src/index.js";
import { makeSuggestionCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { eq } from "drizzle-orm";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE MODEL SAID "HOLD THIS AT THE GATE" AND THE SCREENER SHOWED "OHBOX 0.92"
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The case, from production
 *
 * An account whose Ohbox bar reads *"Keep my Ohbox for real people writing to me (not any cold
 * mail advertisers wanting to sell a service)"* bought a suggestion for a first-contact sender
 * pitching accounting services. The stored `routing_decisions` row is quoted verbatim in
 * {@link REPORTED} below. The model was RIGHT: `destination = 'ohmail/Screener'`, and a rationale
 * that says so in words. The surface rendered **"AI suggests Ohbox 0.92"**.
 *
 * ## What was actually broken — not the model, not the schema, the COLLAPSE
 *
 * `screener-service.ts` turned the classifier's six-valued `Destination` into the Screener's
 * yes/no with a DENYLIST: spam, `ohmail/Screened` and `ohmail/Quarantine` were "no", and
 * everything else — by falling off the end of the function — was "yes, admit to the Ohbox".
 * `ohmail/Screener` was not on that list.
 *
 * That is not an edge case. The taxonomy DEFINES `ohmail/Screener` as the answer for a
 * first-contact sender, and every row this service reasons about is a first-contact sender, so
 * it is the MODAL answer. Measured on the hosted service the day this was written: **a large share of stored
 * suggestions, the largest single bucket, at a middling average confidence** — every one of them
 * the model asking for a human, every one of them rendering as "Ohbox" with the hold-this
 * rationale printed underneath it. With "Apply all" pressed, that is a consent gate granting
 * consent in bulk and writing an allow rule per sender.
 *
 * ## Why these tests are shaped the way they are
 *
 * A denylist is the wrong shape for a question whose safe answer is "don't act", so the fix is
 * an exhaustive `Record<Destination, …>` and the first guard below is TOTALITY: every label the
 * model is allowed to emit is driven through the real `suggest()` and must produce a decision
 * that is not an accident. Add a folder to the union and that map stops compiling; add one and
 * lie about it, and this goes red.
 */

const NOW = new Date("2026-07-28T12:00:00Z");

/** The reporter's own words, verbatim from the account that reported this. */
const OWNER_BAR =
  "Keep my Ohbox for real people writing to me (not any cold mail advertisers wanting to sell a service)";

/**
 * THE STORED ROW, VERBATIM. Read off production with
 * `select destination, confidence, spam, rationale from routing_decisions …` for the reported
 * sender. Nothing here is reconstructed: the destination, the confidence and the rationale are
 * the three columns as they sit on disk, which is what makes this a reproduction and not an
 * impression of one.
 */
const REPORTED: ClassifierResult = {
  destination: "ohmail/Screener",
  confidence: 0.92,
  rationale:
    "First-contact sender with German business pitch about accounting services for TrafficFlow "
    + "GmbH; unsolicited cold mail from unknown sender matching user's criteria for Screener hold.",
  spam: false,
};

class Stub implements ClassifierPort {
  seen: ClassifierInput[] = [];
  constructor(private readonly result: ClassifierResult) {}
  async classify(i: ClassifierInput): Promise<ClassifierResult> {
    this.seen.push(i);
    return this.result;
  }
}

/**
 * An account and a RECORDING spend port — the ledger's shape is the entitlements program's, and
 * what this file is about is whether the Screener asks it and acts on what it says.
 */
async function billable(_credits = 50) {
  const w = await makeSuggestionCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "screener-gate" });
  return { ...w, gate: fakeSpendPort() };
}

function service(w: Awaited<ReturnType<typeof billable>>, classifier: ClassifierPort) {
  return new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.gate, pricing: PLANE_PRICING });
}

describe("the reported case — a cold sales pitch under the account holder's own words", () => {
  /**
   * THE REGRESSION. Run against the denylist this asserted `"hold"` while `suggest` answered
   * `"yes"`; the second assertion is the one that reads like the bug report.
   */
  it("the model's `ohmail/Screener` is NOT an admission to the Ohbox", async () => {
    const w = await billable();
    await setScreeningPreference(w.ctx, { ohboxBar: OWNER_BAR });
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "b@meetorbitprism.example",
      subject: "Treuhander x TrafficFlow GmbH",
      snippet: "Wir bieten Treuhand- und Buchhaltungsdienstleistungen fur KMU an.",
    });

    const stub = new Stub(REPORTED);
    const res = await service(w, stub).suggest(w.ctx, { senders: ["b@meetorbitprism.example"] });

    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]!.decision).toBe("hold");
    expect(res.suggestions[0]!.decision, "the rationale says hold and the answer said admit").not.toBe("yes");
    // The confidence and the rationale are the model's and travel untouched — the account paid
    // for them, and the fix is about what the number is ATTACHED to, not about hiding it.
    expect(res.suggestions[0]!.confidence).toBe(0.92);
    expect(res.suggestions[0]!.rationale).toBe(REPORTED.rationale);
  });

  it("the account holder's words reach the classifier input for this call", async () => {
    const w = await billable();
    await setScreeningPreference(w.ctx, { ohboxBar: OWNER_BAR });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "b@meetorbitprism.example" });
    const stub = new Stub(REPORTED);
    await service(w, stub).suggest(w.ctx, { senders: ["b@meetorbitprism.example"] });
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]!.ohboxBar).toBe(OWNER_BAR);
  });

  /**
   * The stored row is the MODEL'S answer, not the collapsed one. Two reasons this matters: the
   * verdict must be re-readable under a posture the account changes later, and a suggestion that
   * had been rewritten on the way in could never be audited against what was actually bought.
   */
  it("stores the model's own destination verbatim — the fix is at the read, not the write", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "b@meetorbitprism.example" });
    await service(w, new Stub(REPORTED)).suggest(w.ctx, { senders: ["b@meetorbitprism.example"] });

    const [row] = await w.db.select().from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(row!.destination).toBe("ohmail/Screener");
    expect(row!.confidence).toBe(0.92);
    expect(row!.status).toBe("suggestion");
  });

  /**
   * THE READ PATH AGREES WITH THE PURCHASE. `suggest` and `list` read the same collapse for
   * exactly this reason; a fix applied to one of them is a suggestion that says "hold" when
   * bought and "Ohbox" on the next page load, which is the original defect with a delay on it.
   *
   * It is also what makes this retroactive: the rows already on the hosted service are re-read
   * through here and answer "hold" with nothing backfilled.
   */
  it("`list` reads a stored Screener verdict back as `hold`, not `yes`", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "b@meetorbitprism.example" });
    const svc = service(w, new Stub(REPORTED));
    const bought = await svc.suggest(w.ctx, { senders: ["b@meetorbitprism.example"] });

    const page = await svc.list(w.ctx, {});
    expect(page.items[0]!.aiSuggestion).toEqual({
      // `destination` travels beside the decision now: the collapse to three words was hiding
      // which pile the model named, and this row is the case where the two disagree usefully —
      // the label IS the gate, so the decision is `hold` and the destination says why.
      decision: "hold", destination: "ohmail/Screener", spam: false,
      confidence: 0.92, rationale: REPORTED.rationale, id: bought.suggestions[0]?.id,
    });
  });
});

/**
 * TOTALITY — every label the model may emit, driven through the real `suggest()`.
 *
 * `CLASSIFY_DESTINATIONS` is the list the model is GIVEN, so iterating it is what makes this a
 * guard rather than a restatement: a destination added to the prompt without a screening meaning
 * fails here even if `SCREEN_DISPOSITION` were widened with a wrong guess. The table below is
 * written out per label rather than derived, because a derived expectation is the implementation
 * asserting about itself.
 */
describe("totality — every taxonomy label has a decided, non-accidental answer", () => {
  const EXPECTED: Record<Destination, "yes" | "no" | "hold"> = {
    "INBOX": "yes",
    "ohmail/News": "yes",          // lenient posture; `people_only` tightens it, covered below
    "ohmail/Receipts": "yes",
    "ohmail/Screened": "no",
    "ohmail/Quarantine": "no",
    "ohmail/Screener": "hold",
  };

  it("the prompt's taxonomy and the screening table cover exactly the same labels", () => {
    expect([...CLASSIFY_DESTINATIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const destination of CLASSIFY_DESTINATIONS) {
    it(`${destination} ⇒ ${EXPECTED[destination]}`, async () => {
      const w = await billable();
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: "who@example.com" });
      const res = await service(w, new Stub({
        destination, confidence: 0.8, rationale: "a plain verdict", spam: false,
      })).suggest(w.ctx, { senders: ["who@example.com"] });
      expect(res.suggestions[0]!.decision).toBe(EXPECTED[destination]);
    });
  }

  /**
   * An unrecognised label — a column written by an older build, a hand-run migration, anything
   * that is a `string` by the time it is read back — is NOT advice. It reads `hold`, never `yes`.
   * `coerceClassifierResult` already maps an unknown one to the gate on the way IN; this is the
   * same answer on the way OUT, where the value has lost its type.
   */
  it("a destination outside the taxonomy reads `hold` — an unknown label is not an admission", async () => {
    const w = await billable();
    const messageId = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "odd@example.com" });
    await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId, inputProvenance: "screener_suggestion",
      destination: "ohmail/SomethingNew", confidence: 0.99, rationale: "?", spam: false,
      status: "suggestion",
    });
    const page = await service(w, new Stub(REPORTED)).list(w.ctx, {});
    expect(page.items[0]!.aiSuggestion!.decision).toBe("hold");
  });
});

/**
 * THE RATIONALE IS CROSS-CHECKED AGAINST THE FIELD.
 *
 * A routing answer travels on two channels and only one of them is schema-checked. When the prose
 * reasons its way to the gate and the field names a folder past it, the reply is not advice
 * anybody should act on — so the pair reads `hold` and the bulk control cannot touch it.
 *
 * The asymmetry is the design: a false positive costs a suggestion that reads "this one needs
 * you", which for a queue of first-contact strangers is the status quo. A false negative admits a
 * stranger to the Ohbox and writes them an allow rule.
 */
describe("the consistency check — prose that concludes `hold` outranks a field that says admit", () => {
  const CONTRADICTORY: ClassifierResult = {
    destination: "INBOX", confidence: 0.9, spam: false,
    rationale: "Unsolicited cold outreach from an unknown sender; belongs in the Screener for review.",
  };

  it("an INBOX field with a Screener rationale is downgraded to `hold`", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "pitch@example.com" });
    const res = await service(w, new Stub(CONTRADICTORY))
      .suggest(w.ctx, { senders: ["pitch@example.com"] });
    expect(res.suggestions[0]!.decision).toBe("hold");
  });

  /**
   * THE NEGATION GUARD, and it is the half that keeps the check usable. "not a Screener case" is
   * how an INBOX verdict actually mentions the gate; without this the check would fire on prose
   * that AGREES with its own field and every confident admission would be downgraded.
   */
  it("a rationale that mentions the gate only to rule it out still reads `yes`", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "known@example.com" });
    const res = await service(w, new Stub({
      destination: "INBOX", confidence: 0.95, spam: false,
      rationale: "Replies to a thread the account holder started; not a Screener case.",
    })).suggest(w.ctx, { senders: ["known@example.com"] });
    expect(res.suggestions[0]!.decision).toBe("yes");
  });

  it("an ordinary admission with no mention of the gate is untouched", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "friend@example.com" });
    const res = await service(w, new Stub({
      destination: "INBOX", confidence: 0.88, rationale: "A person writing personally.", spam: false,
    })).suggest(w.ctx, { senders: ["friend@example.com"] });
    expect(res.suggestions[0]!.decision).toBe("yes");
  });
});

/** The two behaviours that were already correct, so the fix is provably not a rewrite of them. */
describe("what did NOT change", () => {
  it("spam is still a hard `no`, whatever the label says", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "spam@example.com" });
    const res = await service(w, new Stub({
      destination: "INBOX", confidence: 0.6, rationale: "phishing", spam: true,
    })).suggest(w.ctx, { senders: ["spam@example.com"] });
    expect(res.suggestions[0]!.decision).toBe("no");
  });

  it("`people_only` still demotes Reads to `no`, and the lenient default still admits it", async () => {
    for (const [policy, expected] of [["people_only", "no"], ["people_and_replied", "yes"]] as const) {
      const w = await billable();
      await setScreeningPreference(w.ctx, { ohboxPolicy: policy });
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: "news@example.com" });
      const res = await service(w, new Stub({
        destination: "ohmail/News", confidence: 0.9, rationale: "a newsletter", spam: false,
      })).suggest(w.ctx, { senders: ["news@example.com"] });
      expect(res.suggestions[0]!.decision, policy).toBe(expected);
    }
  });

  /**
   * IDEMPOTENCY AND PRICE ACCOUNTING ARE UNTOUCHED. A `hold` is a bought answer like any other:
   * it is stored, it is charged once, and asking again serves the store rather than the model.
   * The alternative — treating "no actionable advice" as "nothing was bought" — would re-offer
   * the sender as suggestable and charge for the same message twice.
   */
  it("a `hold` is charged exactly once and served from the store on the second ask", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "b@meetorbitprism.example" });
    const stub = new Stub(REPORTED);
    const svc = service(w, stub);

    const first = await svc.suggest(w.ctx, { senders: ["b@meetorbitprism.example"] });
    expect(first.charged).toBe(1);
    expect(first.quoted).toBe(1);

    const second = await svc.suggest(w.ctx, { senders: ["b@meetorbitprism.example"] });
    expect(second.charged, "a stored hold was re-bought").toBe(0);
    expect(second.quoted, "a stored hold was re-quoted").toBe(0);
    expect(second.suggestions[0]!.decision).toBe("hold");
    expect(stub.seen, "the model was consulted twice for one message").toHaveLength(1);

    // …and the page does not offer it for sale again.
    const page = await svc.list(w.ctx, {});
    expect(page.suggestable.senders).toEqual([]);
  });
});

/**
 * ═══ WHAT IS LEFT, FROM THE LEDGER — AND THE THREE WAYS TO GET IT WRONG ══════════════════════
 *
 * A run tells the person what it cost. The next question is what they have left, and the client
 * is categorically not allowed to work it out: subtracting `charged` from a remembered figure is
 * a second ledger, wrong after a renewal, a refund, an expiry, or a second tab — and wrong
 * upward, which is the direction that promises a purchase the account cannot make. Invariant
 * #10: the side that moves the money is the side that names it.
 *
 * So the number comes from `credit_balances`, through the injected `remaining` reader, and:
 *
 *  · it is read AFTER the loop, so it describes the account the run left behind;
 *  · it is ABSENT — never `0` — on a deployment that supplies no reader, because zero is a real
 *    balance with a real sentence and an unmetered install has neither;
 *  · a reader that THROWS is also absent. The suggestions are already bought and paid for; a
 *    courtesy read failing must not turn a successful purchase into an error, and must not
 *    report an empty balance to a funded account.
 *
 * MUTATIONS WATCHED: reading the balance BEFORE the loop turns "after the spend" red with the
 * opening figure; `remainingCredits: remainingCredits ?? 0` turns "absent, not zero" red;
 * removing the try/catch turns "a failed read is silence" red with the thrown error.
 */
describe("remainingCredits — the balance the run left behind", () => {
  const withReader = (
    w: Awaited<ReturnType<typeof billable>>,
    classifier: ClassifierPort,
    remaining?: (db: never, accountId: string) => Promise<number>,
  ) => new ScreenerService({
    adapter: new FakeAdapter(), classifier, credits: w.gate, pricing: PLANE_PRICING,
    ...(remaining ? { remaining: remaining as never } : {}),
  });

  const ADMIT: ClassifierResult = {
    destination: "INBOX", confidence: 0.9, rationale: "a real person", spam: false,
  };

  it("is ABSENT when the deployment wires no reader — an unmetered install has no balance", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "p@example.test" });
    const res = await withReader(w, new Stub(ADMIT)).suggest(w.ctx, { senders: ["p@example.test"] });
    expect(res.charged).toBeGreaterThan(0);
    // NOT ZERO. `0` is a real balance the client renders as "0 credits left"; absence is the
    // client omitting the clause entirely, and the two must not collapse.
    expect("remainingCredits" in res, "an unmetered deployment reported a balance").toBe(false);
  });

  it("reads the balance AFTER the spend, so it is what the run left behind", async () => {
    const w = await billable(50);
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "p@example.test" });
    // The REAL ledger, through the same `db` the gate debited on. Reading it before the loop
    // would answer 50 — the opening balance — which is the figure a person would act on and
    // then find they cannot.
    // Read THROUGH the port's own record of what it charged, which is the only balance this
    // server can compute now: the opening figure minus the spends the run actually made. Reading
    // before the loop would answer 50 — the figure a person would act on and then find they
    // cannot.
    const balances: number[] = [];
    const res = await withReader(w, new Stub(ADMIT), async () => {
      const n = 50 - w.gate.spends.length;
      balances.push(n);
      return n;
    }).suggest(w.ctx, { senders: ["p@example.test"] });

    expect(res.charged).toBe(1);
    expect(res.remainingCredits).toBe(49);
    expect(balances, "the balance was read more than once, or not at all").toEqual([49]);
  });

  it("a DRY RUN answers the balance too, and spends nothing to do it", async () => {
    const w = await billable(50);
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "p@example.test" });
    const res = await withReader(w, new Stub(ADMIT), async () => 50)
      .suggest(w.ctx, { senders: ["p@example.test"], dryRun: true });
    expect(res.charged).toBe(0);
    expect(res.remainingCredits).toBe(50);
  });

  it("a reader that THROWS is silence, not zero, and never fails the purchase", async () => {
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "p@example.test" });
    const res = await withReader(w, new Stub(ADMIT), async () => {
      throw new Error("the ledger connection dropped");
    }).suggest(w.ctx, { senders: ["p@example.test"] });

    // The work happened and it is paid for. A courtesy read must not undo either.
    expect(res.suggestions).toHaveLength(1);
    expect(res.charged).toBe(1);
    expect("remainingCredits" in res, "a failed read was reported as an empty balance").toBe(false);
  });
});

it("prices and charges learning only when the mailbox contributes context", async () => {
  const w = await billable();
  const { ctx, accountId, mailboxId } = w;
  await changeScreenerLearning(w.db, w, { kind: "notice" }, NOW);
  const base = "cold@fixture.test";
  await seedMessage(w.db, accountId, mailboxId, { from: base });
  const quoteCalls: number[] = [];
  const classifier = new Stub({ destination: "ohmail/Screened", confidence: 0.9, spam: false,
    rationale: "A webinar", topic: "webinar" });
  const svc = new ScreenerService({
    classifier, adapter: new FakeAdapter(), credits: w.gate,
    pricing: { ...PLANE_PRICING, async quoteScreenerLearning(_accountId, count) {
      quoteCalls.push(count);
      return count + Math.floor(count / 2);
    } },
  });
  const cold = await svc.suggest(ctx, { senders: [base], dryRun: true });
  expect(cold.quotedCredits).toBe(1);
  expect(cold.quoteGrant?.pairs[0]?.learning).toBeUndefined();
  expect((await svc.suggest(ctx, { senders: [base] })).charged).toBe(1);
  expect(w.gate.spends[0]?.meta?.learning).toBeUndefined();
  expect(quoteCalls).toEqual([]);

  for (const sender of ["one@fixture.test", "two@fixture.test"]) {
    await seedMessage(w.db, accountId, mailboxId, { from: sender, subject: sender.startsWith("one") ? "An upcoming gathering" : "A video session" });
  }
  await updateScreenerLearning(w.db, w, state => ({ ...state, text: "Screen out webinar invitations." }));
  const senders = ["one@fixture.test", "two@fixture.test"];
  const warm = await svc.suggest(ctx, { senders, dryRun: true });
  expect(warm.quotedCredits).toBe(3);
  expect(warm.quoteGrant?.pairs.map(pair => pair.learning)).toEqual([true, true]);
  w.gate.answerOnce({ verdict: "ok", charged: true, attempt: "11", chargedCredits: 1 });
  w.gate.answerOnce({ verdict: "ok", charged: true, attempt: "12", chargedCredits: 2 });
  const bought = await svc.suggest(ctx, { senders, maxCredits: warm.quotedCredits, quoteGrant: warm.quoteGrant?.proof });
  expect(bought.charged).toBe(3);
  expect(quoteCalls).toEqual([2, 2]);
  expect(w.gate.spends.slice(1).map(spend => spend.meta?.learning)).toEqual([true, true]);
  expect(bought.suggestions).toHaveLength(2);
  expect(bought.suggestions[0]).toMatchObject({ learnedReason: "webinar", rationale: "" });
  const first = bought.suggestions[0]!;
  await svc.decide(ctx, first.messageId, { decision: "yes", shownSuggestionId: first.id });
  const [lesson] = (await readScreenerLearning(w.db, w, NOW))!.lessons;
  expect(lesson).toMatchObject({ kind: "correction", topic: "webinar" });
  const remaining = bought.suggestions[1]!.id!;
  for (const edit of [{ kind: "forget", id: lesson!.id }, { kind: "reset" }, { kind: "enable", enabled: false }]) {
    await screenerLearningSettings(ctx, mailboxId, edit);
    expect(await w.db.select({ id: routingDecisions.id }).from(routingDecisions)
      .where(eq(routingDecisions.id, remaining))).toEqual([{ id: remaining }]);
  }
});

it("keeps suggestions in progress during a learning update and refunds the provider's two-credit debit", async () => {
  const w = await billable();
  await changeScreenerLearning(w.db, w, { kind: "notice" }, NOW);
  await updateScreenerLearning(w.db, w, state => ({ ...state, text: "Keep receipts." }));
  const senders = ["first@fixture.test", "second@fixture.test"];
  for (const sender of senders) await seedMessage(w.db, w.accountId, w.mailboxId, { from: sender });
  w.gate.answer({ verdict: "ok", charged: true, attempt: "2", chargedCredits: 2 });
  w.gate.answerOnce({ verdict: "ok", charged: true, attempt: "1", chargedCredits: 1 });
  const classify: ClassifierPort["classify"] = async input => {
    expect(input.learnedWords).toBe("Keep receipts.");
    if (input.from.address === senders[1]) throw new Error("Synthetic provider failure");
    await updateScreenerLearning(w.db, w, state => ({ ...state, text: "Keep invoices.", revision: state.revision + 1 }));
    return { destination: "ohmail/Receipts", confidence: 0.9, rationale: "Receipt", spam: false, topic: "other" };
  };
  const svc = new ScreenerService({ classifier: { classify }, adapter: new FakeAdapter(), credits: w.gate,
    pricing: { ...PLANE_PRICING, quoteScreenerLearning: async () => 3 } });
  const bought = await svc.suggest(w.ctx, { senders });
  expect(bought.suggestions.map(s => s.sender)).toEqual([senders[0]]);
  expect(bought.charged).toBe(1);
  expect(w.gate.releases.filter(r => r.refund).map(r => r.attempt)).toEqual(["2"]);
  const first = bought.suggestions[0]!;
  await svc.decide(w.ctx, first.messageId, { decision: "yes", shownSuggestionId: first.id });
  expect((await readScreenerLearning(w.db, w, NOW))!.lessons[0]).toMatchObject({ kind: "correction", topic: "other" });
});

it("quotes and charges one credit when the learned context would exceed the prompt budget", async () => {
  const w = await billable();
  const from = "long@fixture.test";
  await seedMessage(w.db, w.accountId, w.mailboxId, { from, subject: "界".repeat(1_750) });
  await updateScreenerLearning(w.db, w, state => ({ ...state, notice: false, text: "界".repeat(680) }));
  const classifier = new Stub({ destination: "ohmail/News", confidence: 0.9, spam: false, rationale: "" });
  const svc = new ScreenerService({
    classifier, adapter: new FakeAdapter(), credits: w.gate, pricing: PLANE_PRICING,
  });
  const dryRun = await svc.suggest(w.ctx, { senders: [from], dryRun: true });
  expect(dryRun.quotedCredits).toBe(1);
  expect(dryRun.quoteGrant?.pairs[0]?.learning).toBeUndefined();
  const bought = await svc.suggest(w.ctx, { senders: [from], maxCredits: 1, quoteGrant: dryRun.quoteGrant?.proof });
  expect(bought).toMatchObject({ charged: 1, suggestions: [expect.any(Object)] });
  expect(classifier.seen[0]).not.toHaveProperty("learnedWords");
  expect(w.gate.spends[0]?.meta?.learning).toBeUndefined();
  expect(w.gate.releases.some(release => release.refund)).toBe(false);
});
