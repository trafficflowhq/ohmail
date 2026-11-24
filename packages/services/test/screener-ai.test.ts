import { describe, it, expect, vi } from "vitest";
import * as suggestionStore from "@trafficflow/db";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { screenerLedgerSource } from "@trafficflow/db";
import { PLANE_PRICES, PLANE_PRICING } from "./helpers/plane-pricing.js";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { accountSettings, accounts, mailboxes, messageInstances, messages, routingDecisions, type LedgerTx, type Tx } from "@trafficflow/db";
import { makeHaikuClassifier, type AnthropicLike, type ClassifierPort, type ClassifierInput, type ClassifierResult } from "@trafficflow/core";
import { ScreenerService, setAutoSuggest, suggestLaneGate } from "../src/index.js";
import { makeSuggestionCtx, seedMessage, FakeAdapter } from "./helpers.js";

/**
 * **The Screener's AI is a PURCHASE, and the read path cannot make it.**
 *
 * ## What this file used to be, and what changed
 *
 * It used to prove that `list`'s per-sender model call was sensitivity-filtered and metered.
 * Both were true, and both were the wrong question: the call was on a `GET`. One page view of
 * a window of rows was a model call per row and a credit per call, on the one endpoint a client
 * re-fetches on every poll, scroll and reload — so the cost of the Screener was a function of
 * how much the user LOOKED at it, and every subject and snippet at the gate went to a third
 * party by the act of opening the page.
 *
 * Generation is now `POST /screener/suggest` over an explicit sender set, priced before it
 * runs. `list` returns what is stored.
 *
 * ## The guard that would have caught the defect
 *
 * "the read path does not call the model, with a classifier and credits wired and eligible mail
 * held" — the first test below. It fails against the code as it stood this morning, and it is
 * the reason this file still exists rather than being deleted with the behaviour it described.
 * The structural half is one level down: `ScreenerReadService` is constructed with a bag that
 * has no `classifier` and no `credits`, so the call does not compile either.
 */

const YES: ClassifierResult = {
  destination: "INBOX", confidence: 0.92, rationale: "looks like a real person", spam: false,
};
const NO: ClassifierResult = {
  destination: "ohmail/Screened", confidence: 0.71, rationale: "bulk sender", spam: false,
};

class SpyClassifier implements ClassifierPort {
  seen: ClassifierInput[] = [];
  constructor(private readonly result: ClassifierResult | Error = YES) {}
  get calls(): number { return this.seen.length; }
  async classify(i: ClassifierInput): Promise<ClassifierResult> {
    this.seen.push(i);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const NOW = new Date("2026-07-28T12:00:00Z");

/**
 * An account, and a RECORDING spend port whose verdict this fixture's options choose.
 *
 * `credits`/`insufficient`/`refused` were a subscription row and a real credit ledger. Whether a
 * charge is exactly-once, refundable and refused when the balance is empty is the entitlements
 * program's property and is proven on its side; what is still this repository's is whether the
 * Screener ASKS, with which action and which bare key, and what it does with each verdict.
 *
 * `spends`/`releases` on the returned port are what the assertions read instead of a ledger.
 */
async function billable(
  opts: { credits?: number; status?: "active" | "canceled"; aiDisabled?: boolean } = {},
) {
  const w = await makeSuggestionCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "screener" });
  const credits = fakeSpendPort(
    opts.aiDisabled
      // THE ACCOUNT'S OWN SWITCH, as the port words it: `refused`, never `insufficient`. The
      // distinction is why the port carries five verdicts — a funded account whose owner turned
      // AI off must not be shown a payment demand.
      ? { verdict: "refused", reason: "ai_disabled" }
      : opts.status === "canceled"
        ? { verdict: "refused", reason: "canceled" }
        : opts.credits === 0
          ? { verdict: "insufficient", reason: "out_of_credits" }
          : { verdict: "ok", charged: true, attempt: "1" },
  );
  return {
    ...w,
    credits,
    /** What the port was asked to charge, in the shape the old ledger read returned. */
    debits: async () => credits.spends.map((c) => ({ source: c.source, reason: "debit_classify" })),
    ledger: async () => credits.spends.map((c) => ({ delta: -1, reason: "debit_classify", source: c.source })),
    stored: () => w.db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId)),
  };
}

describe("GET is a READ: `list` cannot reach the model", () => {
  /**
   * THE REGRESSION GUARD. Everything a wired production host would have — a classifier, a
   * credit gate, a funded plan and ordinary held mail — and the page still costs nothing and
   * sends nothing. Against the code before that change this asserted `classifier.calls === 0` while the
   * implementation made three of them.
   */
  it("a wired classifier + gate + eligible held mail: THREE list calls, ZERO model calls, ZERO credits", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example", subject: "hi" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example", subject: "yo" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "carol@ex.example", subject: "hey" });

    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    for (let i = 0; i < 3; i++) {
      const page = await svc.list(w.ctx, {});
      expect(page.items).toHaveLength(3);
      expect(page.items.every((it) => it.aiSuggestion === null)).toBe(true);
    }

    expect(classifier.calls, "a GET reached the model").toBe(0);
    expect(await w.debits(), "a GET moved money").toEqual([]);
    expect(w.credits.spends, "a GET asked the port for money").toEqual([]);
  });

  it("paging the whole queue is free — the cost of looking does not scale with the backlog", async () => {
    // The user-visible shape of the defect: 40 senders, paged 10 at a time, was 40 model calls
    // and 40 credits for reading a list.
    const w = await billable({ credits: 100 });
    for (let i = 0; i < 40; i++) {
      await seedMessage(w.db, w.accountId, w.mailboxId, {
        from: `s${i}@ex.example`, date: new Date(NOW.getTime() - i * 60_000),
      });
    }
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = await svc.list(w.ctx, { cursor, limit: 10 });
      seen += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toBe(40);
    expect(classifier.calls).toBe(0);
    expect(w.credits.spends, "a stored read asked the port for money").toEqual([]);
  });

  it("`list` returns what is STORED — a bought suggestion survives the next page load", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    expect((await svc.list(w.ctx, {})).items[0]!.aiSuggestion).toBeNull();

    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });

    const after = await svc.list(w.ctx, {});
    expect(after.items[0]!.aiSuggestion)
      .toEqual({
        decision: "yes", destination: "INBOX", spam: false,
        confidence: 0.92, rationale: "looks like a real person",
      });
    // …and reading it again still calls nothing: one model call in the whole test.
    await svc.list(w.ctx, {});
    expect(classifier.calls).toBe(1);
  });

  it("a stored NO reads back as `no` — the verdict is not re-derived by guessing", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bulk@ex.example" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(NO), credits: w.credits, pricing: PLANE_PRICING,
    });
    await svc.suggest(w.ctx, { senders: ["bulk@ex.example"] });
    expect((await svc.list(w.ctx, {})).items[0]!.aiSuggestion)
      .toEqual({
        decision: "no", destination: "ohmail/Screened", spam: false,
        confidence: 0.71, rationale: "bulk sender",
      });
  });
});

describe("the page states the set, the dry run its price, before anything runs", () => {
  it("`suggestable` names exactly the senders a purchase would charge for, and no price", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example" });
    const sensitive = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bank@ex.example" });
    await w.db.update(messages).set({ noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, sensitive));

    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });
    const page = await svc.list(w.ctx, {});

    // Three senders in the queue, all three purchasable. The third used to be excluded for
    // carrying credential material; under the AI-OPEN ruling nothing about the mail's content
    // takes a sender off the shelf, and the quote says so.
    expect(page.items).toHaveLength(3);
    expect(page.suggestable.senders.sort()).toEqual(["alice@ex.example", "bank@ex.example", "bob@ex.example"]);
    // THE READ PATH STATES NO PRICE: the figure a person consents to is the dry run's.
    expect("credits" in page.suggestable).toBe(false);
    expect(page.suggestable.maxPerRequest).toBe(50);

    // Buying exactly what was quoted charges exactly what was quoted.
    const quote = await svc.suggest(w.ctx, { senders: page.suggestable.senders, dryRun: true });
    expect(quote.quotedCredits).toBe(3 * PLANE_PRICES.screener);
    const before = w.credits.spends.length;
    const res = await svc.suggest(w.ctx, { senders: page.suggestable.senders });
    expect(res.charged).toBe(quote.quotedCredits);
    expect((w.credits.spends.length - before) * PLANE_PRICES.screener).toBe(quote.quotedCredits);
  });

  it("the per-request cap is published (50), a batch AT the cap charges in full, and over it is 413", async () => {
    // The cap is the size of ONE request — sized to fit a serverless invocation — and it travels
    // with the quote instead of being a constant two codebases have to agree about. A batch AT the
    // cap is priced and charged in full: a bigger N spends proportionally more, never a clipped
    // prefix. A purchase LARGER than the cap is the client's to split into cap-sized requests
    // (#90); the endpoint refuses an oversized single request rather than truncating it.
    const w = await billable({ credits: 500 });
    for (let i = 0; i < 60; i++) {
      await seedMessage(w.db, w.accountId, w.mailboxId, {
        from: `s${i}@ex.example`, date: new Date(NOW.getTime() - i * 60_000),
      });
    }
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });
    const page = await svc.list(w.ctx, { limit: 60 });
    expect(page.suggestable.senders).toHaveLength(60);
    expect(page.suggestable.maxPerRequest).toBe(50);

    // A request AT the cap — the first 50 senders — is priced and charged for all 50.
    const atCap = page.suggestable.senders.slice(0, 50);
    const bought = await svc.suggest(w.ctx, { senders: atCap });
    expect(bought.quoted).toBe(50);
    expect(bought.charged).toBe(50 * PLANE_PRICES.screener);

    // OVER the cap is REFUSED, never truncated — a control that priced 51 must not buy 50.
    const overCap = Array.from({ length: 51 }, (_, i) => `over${i}@ex.example`);
    await expect(svc.suggest(w.ctx, { senders: overCap }))
      .rejects.toMatchObject({ httpStatus: 413, code: "payload_too_large" });
  });

  it("an already-bought sender drops OUT of the quote — the same page is not sold twice", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });

    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    const page = await svc.list(w.ctx, {});
    expect(page.suggestable.senders).toEqual(["bob@ex.example"]);
  });

  it("a DRY RUN prices the set and touches nothing — no model, no money, no rows", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const quote = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bob@ex.example"], dryRun: true });
    expect(quote).toMatchObject({ dryRun: true, requested: 2, quoted: 2, charged: 0, suggestions: [] });
    expect(classifier.calls).toBe(0);
    expect(await w.debits()).toEqual([]);
    expect(await w.stored()).toEqual([]);

    // …and the quote is the price: the real run charges what the dry run said.
    const real = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bob@ex.example"] });
    expect(real.charged).toBe(quote.quoted);
  });

  it("the quote states the price in CREDITS, not only in senders", async () => {
    /**
     * The confirmation a user reads before they spend says a number of credits, and this is
     * where that number comes from. It is computed here rather than by the client for one
     * reason: `apps/webapp` cannot import `@trafficflow/db`, so a client-side price would be
     * a hardcoded copy of the per-sender price that keeps printing the old figure the day the
     * constant changes — quoting one amount while the purchase moves another.
     *
     * Asserted against `PLANE_PRICES.screener` rather than the literal 1, so this test says
     * "the price is the count times the cost" and not "the price happens to equal the count".
     */
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });

    const quote = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bob@ex.example"], dryRun: true });
    expect(quote.quoted).toBe(2);
    expect(quote.quotedCredits).toBe(2 * PLANE_PRICES.screener);

    // And the quote is a CEILING the real run honours: what it charges is what was quoted.
    const real = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bob@ex.example"] });
    expect(real.charged).toBe(quote.quotedCredits);
    expect(real.quotedCredits).toBe(real.quoted * PLANE_PRICES.screener);
  });

  it("a sensitive sender IS in the price, and the count and the price name the same set", async () => {
    // The two numbers have to include the same senders. A quote that counted 1 and priced 2
    // would be a confirmation whose sentence contradicts itself — and after the AI-OPEN ruling
    // the failure mode inverts: a quote still subtracting the credential-bearing sender would
    // UNDER-price a purchase that then charges for them. Under-quoting is the worse direction.
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const sensitive = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bank@ex.example" });
    await w.db.update(messages).set({ noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, sensitive));

    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });
    const quote = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bank@ex.example"], dryRun: true });
    expect(quote.quoted).toBe(2);
    expect(quote.quotedCredits).toBe(2 * PLANE_PRICES.screener);
    expect(quote.skipped).toEqual([]);
  });

  it("the PAGE quote and the DRY RUN agree about a sensitive sender — one rule, two call sites", async () => {
    // `list().suggestable` and `suggest({dryRun:true})` are two computations of "what would this
    // cost", in two methods, and they used to share the eligibility clause. When the clause was
    // removed from one and not the other the page would price a set the purchase would not buy.
    // Leaving the old filter on either side turns this red.
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const sensitive = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bank@ex.example" });
    await w.db.update(messages).set({ noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, sensitive));

    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });
    const page = await svc.list(w.ctx, {});
    expect(page.suggestable.senders.sort()).toEqual(["alice@ex.example", "bank@ex.example"]);

    const quote = await svc.suggest(w.ctx, { senders: page.suggestable.senders, dryRun: true });
    expect(quote.quoted).toBe(page.suggestable.senders.length);
    expect(quote.quotedCredits).toBe(page.suggestable.senders.length * PLANE_PRICES.screener);

    // …and the real run charges what the quote said.
    const real = await svc.suggest(w.ctx, { senders: page.suggestable.senders });
    expect(real.charged).toBe(quote.quotedCredits);
  });
});

describe("the sender set is EXPLICIT, and absence never buys anything", () => {
  const cases: Array<[string, unknown]> = [
    ["absent", {}],
    ["null", { senders: null }],
    ["a string", { senders: "alice@ex.example" }],
    ["an object", { senders: { 0: "alice@ex.example" } }],
    ["empty", { senders: [] }],
    ["blank strings", { senders: ["", "   "] }],
  ];

  for (const [name, body] of cases) {
    it(`refuses a sender set that is ${name} — and classifies nothing`, async () => {
      const w = await billable({ credits: 10 });
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example" });
      const classifier = new SpyClassifier();
      const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

      await expect(svc.suggest(w.ctx, body as never)).rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
      // The assertion that matters is not the 400 — it is that "we could not read what you
      // asked for" did not become "so do all of them".
      expect(classifier.calls).toBe(0);
      expect(await w.debits()).toEqual([]);
    });
  }

  it("a non-string member is refused rather than skipped", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    await expect(svc.suggest(w.ctx, { senders: ["alice@ex.example", 7] } as never))
      .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
    expect(classifier.calls).toBe(0);
  });

  it("over the cap is REFUSED, not truncated — a control that priced 401 must not buy 400", async () => {
    const w = await billable({ credits: 100 });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    const senders = Array.from({ length: 401 }, (_, i) => `s${i}@ex.example`);
    await expect(svc.suggest(w.ctx, { senders })).rejects.toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    expect(classifier.calls).toBe(0);
  });

  it("only the NAMED senders are classified — a held sender nobody asked about is untouched", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "asked@ex.example" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "unasked@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["asked@ex.example"] });
    expect(res).toMatchObject({ requested: 1, quoted: 1, charged: 1 });
    expect(classifier.seen.map((i) => i.from.address)).toEqual(["asked@ex.example"]);
    expect((await w.debits()).map((d) => d.source)).toHaveLength(1);
  });

  it("addresses are matched case-insensitively and de-duplicated before they are priced", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "Alice@Ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["ALICE@ex.example", "alice@Ex.example", " alice@ex.example "] });
    expect(res).toMatchObject({ requested: 1, quoted: 1, charged: 1 });
    expect(classifier.calls).toBe(1);
  });

  it("a sender who is not at the gate costs nothing and is reported, not invented", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["ghost@ex.example"] });
    expect(res).toMatchObject({ requested: 1, quoted: 0, charged: 0 });
    expect(res.skipped).toEqual([{ sender: "ghost@ex.example", reason: "not_held" }]);
    expect(classifier.calls).toBe(0);
  });
});

/**
 * ── AI-OPEN (the ruling of 2026-08-08 on the "Sensitive mail" invariant) ─────────────────────
 *
 * This describe block used to be called "the consent gate is in front of the money" and its three
 * tests asserted that a `no_ai` / sensitive sender was skipped `"withheld"`, cost nothing and
 * never reached a model. That behaviour is gone: on a path a person pressed a button on, the press
 * IS the consent, and what protects the credential is REDACTION rather than refusal.
 *
 * The tests are rewritten rather than deleted, and each one now pins the opposite of what it used
 * to pin, over the SAME fixture. Keeping the fixture is deliberate — `"Your sign-in code"` /
 * `"Use 482913 to sign in."` is the exact message the old guard proved could not be suggested for,
 * so a reader can see one message change sides.
 */
describe("AI-OPEN: every held sender is suggestable, and the code is what does not travel", () => {
  it("a no_ai / sensitive sender IS suggested for — with the passcode redacted out of the payload", async () => {
    // THE GUARD THAT MAKES THE WHOLE POLICY A MEASUREMENT RATHER THAN A CLAIM.
    //
    // Two assertions, and they have to hold together or the change is not shippable: the sender
    // gets an answer (the ruling), and the digits `482913` are not in what the port received (the
    // redaction). Either one alone is satisfiable by a defect — sending raw satisfies the first,
    // refusing satisfies the second.
    //
    // It asserts against `classifier.seen`, which is what the PORT was handed. That is the seam
    // that matters: a redaction applied further down, inside the bundled Anthropic parameter
    // builder, would leave this assertion red while looking correct — and would leave the
    // sidecar's local model reading the code.
    const w = await billable({ credits: 10 });
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "no-reply@bank.example", subject: "Your sign-in code", snippet: "Use 482913 to sign in.",
    });
    await w.db.update(messages).set({ noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, id));

    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["no-reply@bank.example"] });

    // FIRST: the sender was asked about at all. This is the ruling.
    expect(classifier.calls, "a held sender was still withheld from the model").toBe(1);
    expect(res.skipped, "a held sender produced a skip").toEqual([]);
    expect(res.suggestions).toHaveLength(1);
    expect(res.quoted).toBe(1);
    expect(await w.stored()).toHaveLength(1);

    // SECOND: the one-time passcode did not leave the building. The subject and the snippet are
    // both checked, because the subject is the field stored RAW and is where the code usually is.
    const sent = classifier.seen[0]!;
    expect(`${sent.subject}\n${sent.snippet}`, "the passcode reached the port")
      .not.toContain("482913");
    expect(sent.snippet).toContain("[REDACTED]");
    // The words survive. That is the ruling's other half: what is withheld is the VALUE, and that
    // this message is about signing in is exactly what the user paid to have noticed.
    expect(sent.subject).toContain("sign-in code");
    // And the caller declared what it had done, which is the only reason the outbound sink does
    // not throw on the surviving authentication vocabulary.
    expect(sent.outbound).toBe("prescreened");

    // THIRD: it was charged, once, like any other suggestion. A run that spends must say so.
    expect(res.charged).toBe(PLANE_PRICES.screener);
    expect(w.credits.spends).toHaveLength(1);
  });

  it("an ENCODED passcode does not reach the port either — neither the blob nor its decode", async () => {
    // Y2-A1-2. `screenOutboundText` DECODES embedded base64 before judging, so this message is
    // correctly flagged — but the redactor used to rewrite only the ORIGINAL bytes, and `CODE`'s
    // `\b` finds no boundary inside a contiguous base64 run. The intact blob went to the port
    // marked `prescreened`, one trivial decode away from the passcode. The subject is stored RAW,
    // so a blob there travelled even more directly.
    //
    // Asserted against `classifier.seen` — what the PORT was handed — for the same reason the
    // plaintext guard above is: this seam is what every implementation receives, bundled or not.
    // BOTH forms are checked; either alone is satisfiable by a defect (keeping the blob satisfies
    // the decoded assertion, echoing the decode satisfies the encoded one).
    const blob = Buffer.from("Your one-time passcode is 482913. Do not share it.", "utf8").toString("base64");
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "no-reply@bank.example",
      subject: `Fwd: ${blob}`,
      snippet: `Content-Transfer-Encoding: base64\n\n${blob}`,
    });

    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["no-reply@bank.example"] });

    expect(classifier.calls).toBe(1);
    expect(res.suggestions).toHaveLength(1);
    const sent = classifier.seen[0]!;
    const wire = `${sent.subject}\n${sent.snippet}`;
    expect(wire, "the encoded blob reached the port").not.toContain(blob);
    expect(wire, "the decoded passcode reached the port").not.toContain("482913");
    // Categorical: nothing of the embedded decoder's size is left for any model to decode.
    expect(wire).not.toMatch(/[A-Za-z0-9+/]{16,}/);
    expect(sent.outbound).toBe("prescreened");
  });

  it("ORDINARY mail is passed through BYTE-IDENTICAL — the redactor does not run on everything", async () => {
    // The anti-vacuity half of the guard above, and it guards a real hazard rather than a
    // theoretical one: `CODE` matches `[A-Z0-9]{6,10}` and any 4–8 digit run, so an unconditional
    // redaction would blank `ORDER`, `WELCOME` and every order number in the Screener. If this
    // goes red, every suggestion in the product just got worse.
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "shop@ex.example", subject: "Order 4429117 shipped", snippet: "Your parcel left the depot.",
    });

    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    await svc.suggest(w.ctx, { senders: ["shop@ex.example"] });

    const sent = classifier.seen[0]!;
    expect(sent.subject).toBe("Order 4429117 shipped");
    expect(sent.snippet).toBe("Your parcel left the depot.");
    expect(sent.subject).not.toContain("[REDACTED]");
  });

  it("`indeterminate` (no_ai with a NULL category) is suggestable too", async () => {
    // The class that was most of the reporting account's withheld senders: `no_ai` true with
    // no category — a detector saying "I could not read this confidently", which used to be
    // enough to decline a purchase the user had asked for.
    const w = await billable({ credits: 10 });
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "unknown@ex.example" });
    await w.db.update(messages).set({ noAi: true, sensitivityCategory: null })
      .where(eq(messages.id, id));

    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["unknown@ex.example"] });
    expect(res.skipped).toEqual([]);
    expect(res.suggestions).toHaveLength(1);
    expect(classifier.calls).toBe(1);
  });

  it("the sensitive sender stays SCREENABLE — the queue never narrowed, and still does not", async () => {
    const w = await billable({ credits: 10 });
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bank@ex.example" });
    await w.db.update(messages).set({ noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, id));

    const svc = new ScreenerService({ adapter: new FakeAdapter(), credits: w.credits, pricing: PLANE_PRICING });
    expect((await svc.list(w.ctx, {})).items).toHaveLength(1);
    const res = await svc.decide(w.ctx, id, { decision: "yes" });
    expect(res.appliedFolder).toBe("INBOX");
  });

  it("out of credits with NOTHING served is a 402 — not a 200 that looks like it worked", async () => {
    // A run the gate stopped end to end did not succeed, and answering 200 would make the
    // client render an empty success. 402 is the sentence that tells them what to do.
    const w = await billable({ credits: 0 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    await expect(svc.suggest(w.ctx, { senders: ["alice@ex.example"] }))
      .rejects.toMatchObject({ httpStatus: 402, code: "insufficient_credits" });
    expect(classifier.calls, "the model was asked about mail nobody paid for").toBe(0);
    // The port WAS asked — once, before any model call — and its refusal is what stopped the
    // run. Asserting it was never asked would pass on a service that skipped the money question.
    expect(w.credits.spends).toHaveLength(1);
    expect(w.credits.releases, "a refusal released nothing").toEqual([]);
  });

  it("a CANCELED subscription holding credits spends none of them here either", async () => {
    const w = await billable({ credits: 10, status: "canceled" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    await expect(svc.suggest(w.ctx, { senders: ["alice@ex.example"] }))
      .rejects.toMatchObject({ httpStatus: 402, code: "insufficient_credits" });
    expect(classifier.calls).toBe(0);
    expect(w.credits.spends).toHaveLength(1);
  });

  it("the OWNER'S OWN off switch is a 409, never a demand for money", async () => {
    // 402 to a fully funded account whose owner turned AI off would be wrong three times over:
    // they have credits, buying more changes nothing, and they chose the state.
    const w = await billable({ credits: 10, aiDisabled: true });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    await expect(svc.suggest(w.ctx, { senders: ["alice@ex.example"] }))
      .rejects.toMatchObject({ httpStatus: 409, code: "ai_disabled" });
    expect(classifier.calls).toBe(0);
    expect(w.credits.spends).toHaveLength(1);
  });

  it("credits running out MID-SET stops the spend and reports where it stopped", async () => {
    const w = await billable({ credits: 2 });
    // TWO `ok`s, then the balance is out — the port answering what it would answer, in order.
    w.credits.answerOnce({ verdict: "ok", charged: true, attempt: "1" });
    w.credits.answerOnce({ verdict: "ok", charged: true, attempt: "1" });
    w.credits.answer({ verdict: "insufficient", reason: "out_of_credits" });
    for (const s of ["a@ex.example", "b@ex.example", "c@ex.example", "d@ex.example"]) {
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: s });
    }
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["a@ex.example", "b@ex.example", "c@ex.example", "d@ex.example"] });
    expect(res.quoted).toBe(4);
    expect(res.charged).toBe(2);
    expect(res.suggestions).toHaveLength(2);
    expect(res.skipped.map((s) => s.reason)).toEqual(["out_of_credits", "out_of_credits"]);
    // A PARTIAL run is a 200 that says where it stopped — throwing here would discard two
    // suggestions the account has already paid for.
    expect(res.stopped).toBe("out_of_credits");
    expect(classifier.calls, "the model was asked about mail nobody paid for").toBe(2);
    expect(w.credits.spends.length).toBeGreaterThan(0);
  });

  it("a failed purchase and its replacement cost one credit in total", async () => {
    const w = await billable({ credits: 10 });
    const from = `returning@${"example.test"}`;
    const first = await seedMessage(w.db, w.accountId, w.mailboxId, { from });
    const failed = new ScreenerService({
      classifier: new SpyClassifier(new Error("model unavailable")), credits: w.credits, pricing: PLANE_PRICING,
    });
    expect((await failed.suggest(w.ctx, { senders: [from] })).skipped[0]?.reason).toBe("model_unavailable");
    const newer = await seedMessage(w.db, w.accountId, w.mailboxId, { from, date: w.ctx.now() });
    const recovered = new ScreenerService({
      classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });
    expect((await recovered.suggest(w.ctx, { senders: [from] })).suggestions[0]?.messageId).toBe(newer);
    expect(w.credits.releases.filter((release) => release.refund)).toEqual([
      expect.objectContaining({ refund: true, meta: { messageId: first } }),
    ]);
    expect(w.credits.spends.filter(({ outcome }) => outcome.verdict === "ok")).toHaveLength(2);
  });

  it("a model outage refunds its debit and names the failed sender", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(new Error("anthropic 503")),
      credits: w.credits, pricing: PLANE_PRICING,
    });

    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_unavailable" }]);
    expect(res.charged).toBe(0);
    expect(res.suggestions).toEqual([]);
    expect(await w.stored()).toEqual([]);
    expect(w.credits.spends).toHaveLength(1);
    expect(w.credits.releases).toEqual([
      expect.objectContaining({ refund: true, attempt: "1" }),
    ]);
    const second = await billable({ credits: 10 });
    await seedMessage(second.db, second.accountId, second.mailboxId, { from: "retry@ex.example" });
    const healthy = new SpyClassifier();
    let calls = 0;
    const transient: ClassifierPort = {
      async classify(input) {
        if (++calls === 1) throw new Error("temporary model timeout");
        return healthy.classify(input);
      },
    };
    const recovered = new ScreenerService({
      adapter: new FakeAdapter(), classifier: transient, credits: second.credits, pricing: PLANE_PRICING,
    });
    const result = await recovered.suggest(second.ctx, { senders: ["retry@ex.example"] });
    expect(result.skipped).toEqual([]);
    expect(result.suggestions).toHaveLength(1);
    expect(calls).toBe(2);
    expect(second.credits.spends).toHaveLength(1);
    expect(result.charged).toBe(1);

  });

  /**
   * The real classifier over a client giving Anthropic's documented refusal (its refusals page,
   * read 2026-10-12: HTTP 200, no content) for the named senders and a screening answer otherwise.
   */
  function refusingFor(refuse: ReadonlySet<string>, asked: string[]): ClassifierPort {
    const client = { messages: { create: async (params: unknown) => {
      const from = (JSON.parse((params as { messages: { content: string }[] }).messages[0]!.content) as { from: string }).from;
      asked.push(from);
      return refuse.has(from)
        ? { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
            usage: { input_tokens: 900, output_tokens: 0 } }
        : { content: [{ type: "text", text: JSON.stringify({ destination: "INBOX", confidence: 0.9, rationale: "a person" }) }],
            stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 40 } };
    } } } as AnthropicLike;
    return makeHaikuClassifier({ client });
  }

  /**
   * A DECLINE IS SAID FOR THAT SENDER AND REFUNDED — and does not stop the others. Haiku 5.5's
   * safety classifiers can refuse one sender's mail; the pressed path answered `model_unavailable`
   * ("asking again costs nothing") and kept the charge, though asking again draws the same refusal.
   * Mutations: delete the `ModelDeclinedError` arm in `ScreenerService`'s lane catch, or the
   * door's settled-receipt `charged` correction.
   */
  it("a DECLINED sender is said as `model_declined`, refunded, and the next sender is answered", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example" });
    const asked: string[] = [];
    const classifier = refusingFor(new Set(["alice@ex.example"]), asked);
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bob@ex.example"] });

    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_declined" }]);
    expect(res.suggestions.map((s) => s.sender)).toEqual(["bob@ex.example"]);
    expect(asked.sort()).toEqual(["alice@ex.example", "bob@ex.example"]);
    expect(res.charged, "the declined sender's settled refund was reported as spent").toBe(1);
    const refunds = w.credits.releases.filter((r) => r.refund);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ action: "screener" });
    expect(await w.stored()).toHaveLength(1);
  });

  it("a decline whose refund is LOST stays in `charged` — the number says what was paid", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    w.credits.releasesAreLost();
    const classifier = refusingFor(new Set(["alice@ex.example"]), []);
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });

    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_declined" }]);
    expect(w.credits.releases.map((r) => r.refund)).toEqual([true]);
    expect(res.charged, "a refund nobody took was reported as returned").toBe(1);
  });

  it("a deployment with NO classifier refuses the purchase — it does not succeed emptily", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const svc = new ScreenerService({ adapter: new FakeAdapter(), credits: w.credits, pricing: PLANE_PRICING });
    await expect(svc.suggest(w.ctx, { senders: ["alice@ex.example"] }))
      .rejects.toMatchObject({ httpStatus: 503, code: "suggest_unconfigured" });
    expect(await w.debits()).toEqual([]);
  });
});

/**
 * ── THE AUTOMATIC BATCH IS NOT A PRESS (the "Sensitive mail" invariant; ruled 2026-10-15) ───────────────────
 *
 * The opt-in's on-open batch asks with `automatic: true`, and the one-time opt-in is not the press.
 * So that request is held to the always-on pass's own rule (`automaticAiAdmits`): a sender whose
 * representative is `no_ai`, or carries a sensitivity category, is skipped `no_auto_ai` — never
 * priced, charged or handed to the port. The same senders PRESSED behave exactly as the block above.
 */
describe("AUTOMATIC: the opt-in's batch is not a press", () => {
  const INDETERMINATE = "unknown@ex.example";
  const CATEGORISED = "no-reply@bank.example";
  const ORDINARY = "shop@ex.example";
  const FLAGGED = [INDETERMINATE, CATEGORISED];

  /** `no_ai` with no category, a category with `no_ai` false, and ordinary mail: each half alone. */
  async function flaggedQueue() {
    const w = await billable({ credits: 10 });
    const a = await seedMessage(w.db, w.accountId, w.mailboxId, { from: INDETERMINATE });
    await w.db.update(messages).set({ noAi: true, sensitivityCategory: null }).where(eq(messages.id, a));
    const b = await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: CATEGORISED, subject: "Your sign-in code", snippet: "Use 482913 to sign in.",
    });
    await w.db.update(messages).set({ noAi: false, sensitivityCategory: "otp" }).where(eq(messages.id, b));
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: ORDINARY, subject: "Order 4429117 shipped" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    return { w, classifier, svc };
  }

  async function addCopy(w: Awaited<ReturnType<typeof billable>>, from: string) {
    const [message] = await w.db.select({ id: messages.id }).from(messages).where(eq(messages.fromAddress, from));
    await w.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: message!.id,
      folder: "ohmail/Screener", uidvalidity: 1n, uid: 1, isPrimary: true,
    });
    return message!.id;
  }

  it.each([
    { name: "an account without auto-suggest", enabled: false, waiting: ORDINARY },
    { name: "a sensitive-category letter", enabled: true, waiting: CATEGORISED },
    { name: "a letter marked no AI", enabled: true, waiting: INDETERMINATE },
  ])("a press on $name with a no_slot item must not come back deferred", async ({ enabled, waiting }) => {
    const { w, classifier, svc } = await flaggedQueue();
    await w.db.update(accountSettings).set({ autoSuggestAt: enabled ? w.ctx.now() : null })
      .where(eq(accountSettings.accountId, w.accountId));
    await addCopy(w, waiting);
    const delivered = `delivered@${"example.test"}`;
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: delivered });
    const acquire = vi.spyOn(suggestLaneGate, "acquire").mockResolvedValueOnce(false);
    try {
      const result = await svc.suggest(w.ctx, { senders: [waiting, delivered] });
      expect(result.stopped).toBe("spend_unavailable");
      expect.soft(result.deferred).toBeUndefined();
      expect.soft(await w.stored()).toHaveLength(1);
      expect(classifier.calls).toBe(1);
      expect(w.credits.spends).toHaveLength(1);
    } finally {
      acquire.mockRestore();
    }
  });

  it.each([false, true])("only hands a no-slot sender to the worker inside the cutline (%s)", async (outside) => {
    const { w, classifier, svc } = await flaggedQueue();
    const messageId = await addCopy(w, ORDINARY);
    if (outside) {
      await w.db.update(accountSettings).set({ screeningBaselineAt: w.ctx.now() }).where(eq(accountSettings.accountId, w.accountId));
      const old = new Date("2020-01-01");
      await w.db.update(messages).set({ date: old, arrivedAt: old, createdAt: old }).where(eq(messages.id, messageId));
    }
    const delivered = `delivered@${"example.test"}`;
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: delivered });
    const acquire = vi.spyOn(suggestLaneGate, "acquire").mockResolvedValueOnce(false);
    try {
      const result = await svc.suggest(w.ctx, { senders: [ORDINARY, delivered] });
      expect(result.stopped).toBe("spend_unavailable");
      expect(result.deferred).toBe(outside ? undefined : true);
      expect((await w.stored()).filter((r) => r.status === "retry_due")).toHaveLength(outside ? 0 : 1);
      expect(classifier.calls).toBe(1);
    } finally {
      acquire.mockRestore();
    }
  });

  it("reports a stop when the worker would see a different representative", async () => {
    const { w, svc } = await flaggedQueue();
    await addCopy(w, ORDINARY);
    const delivered = `delivered@${"example.test"}`;
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: delivered });
    const acquire = vi.spyOn(suggestLaneGate, "acquire").mockImplementationOnce(async () => {
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: ORDINARY, date: w.ctx.now() });
      return false;
    });
    try {
      const result = await svc.suggest(w.ctx, { senders: [ORDINARY, delivered] });
      expect(result).toMatchObject({ charged: 1, stopped: "spend_unavailable", suggestions: [{ sender: delivered }] });
      expect(result.deferred).toBeUndefined();
      expect(await w.stored()).toHaveLength(1);
    } finally {
      acquire.mockRestore();
    }
  });

  it("can hand the whole chunk to the worker without charging for an unclaimed slot", async () => {
    const { w, classifier, svc } = await flaggedQueue();
    await addCopy(w, ORDINARY);
    const acquire = vi.spyOn(suggestLaneGate, "acquire").mockResolvedValueOnce(false);
    try {
      expect(await svc.suggest(w.ctx, { senders: [ORDINARY] })).toMatchObject({
        charged: 0, suggestions: [], stopped: "spend_unavailable", deferred: true,
      });
      expect(classifier.calls).toBe(0);
      expect(w.credits.spends).toEqual([]);
      expect(await w.stored()).toMatchObject([{ status: "retry_due" }]);
    } finally {
      acquire.mockRestore();
    }
  });

  it("clears deferred work when automatic suggestions are switched off", async () => {
    const { w } = await flaggedQueue();
    const messageId = await addCopy(w, ORDINARY);
    await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId, destination: "ohmail/Screener",
      inputProvenance: "screener_suggestion_retry", status: "retry_due",
    });
    await setAutoSuggest(w.ctx, false);
    await setAutoSuggest(w.ctx, true);
    expect(await w.stored()).toEqual([]);
  });

  it("a failed retry record leaves the completed suggestions and a stoppage in the reply", async () => {
    const { w, svc } = await flaggedQueue();
    await addCopy(w, ORDINARY);
    const delivered = `delivered@${"example.test"}`;
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: delivered });
    const acquire = vi.spyOn(suggestLaneGate, "acquire").mockResolvedValueOnce(false);
    const record = vi.spyOn(suggestionStore, "recordScreenerSuggestionRetry")
      .mockRejectedValueOnce(new Error("retry store unavailable"));
    try {
      const result = await svc.suggest(w.ctx, { senders: [ORDINARY, delivered] });
      expect(result).toMatchObject({ charged: 1, stopped: "spend_unavailable", suggestions: [{ sender: delivered }] });
      expect(result.deferred).toBeUndefined();
      expect(record).toHaveBeenCalledTimes(1);
    } finally {
      acquire.mockRestore();
      record.mockRestore();
    }
  });

  it("an automatic batch hands NEITHER flagged sender to the port; the press asks about both, as today", async () => {
    const { w, classifier, svc } = await flaggedQueue();

    const auto = await svc.suggest(w.ctx, { senders: [...FLAGGED, ORDINARY], automatic: true });
    // AT THE SERVICE BOUNDARY: the only input the model client was handed is the ordinary sender's.
    expect(classifier.seen.map((i) => i.from.address), "a flagged sender reached the port").toEqual([ORDINARY]);
    expect(auto.skipped).toEqual(FLAGGED.map((sender) => ({ sender, reason: "no_auto_ai" })));
    expect(auto.suggestions.map((s) => s.sender)).toEqual([ORDINARY]);
    expect(auto.quoted).toBe(1);
    expect(auto.charged).toBe(PLANE_PRICES.screener);
    expect(w.credits.spends, "a flagged sender was charged").toHaveLength(1);

    // THE PRESS, for the same two senders: asked about, the code redacted, charged — as today.
    const pressed = await svc.suggest(w.ctx, { senders: FLAGGED });
    expect(classifier.seen.slice(1).map((i) => i.from.address).sort()).toEqual([...FLAGGED].sort());
    expect(pressed.skipped).toEqual([]);
    expect(pressed.suggestions).toHaveLength(2);
    expect(pressed.charged).toBe(2 * PLANE_PRICES.screener);
    expect(classifier.seen.map((i) => `${i.subject}\n${i.snippet}`).join("\n")).not.toContain("482913");
  });

  it("an automatic DRY RUN prices only what the rule admits — the opt-in's quote is the batch's", async () => {
    const { w, classifier, svc } = await flaggedQueue();
    const quote = await svc.suggest(w.ctx, { senders: [...FLAGGED, ORDINARY], dryRun: true, automatic: true });
    expect(quote).toMatchObject({ dryRun: true, quoted: 1, quotedCredits: PLANE_PRICES.screener, charged: 0 });
    expect(quote.skipped.map((s) => s.reason)).toEqual(["no_auto_ai", "no_auto_ai"]);
    // The press's quote over the same set still prices all three.
    expect((await svc.suggest(w.ctx, { senders: [...FLAGGED, ORDINARY], dryRun: true })).quoted).toBe(3);
    expect(classifier.calls).toBe(0);
    expect(w.credits.spends).toEqual([]);
  });

  it("the rule reads the REPRESENTATIVE: a flagged newest message is not swapped for an older one", async () => {
    const { w, classifier, svc } = await flaggedQueue();
    // The ordinary sender writes again, newer, flagged: their representative is now that message.
    const newer = await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: ORDINARY, date: new Date("2026-07-28T11:00:00Z"),
    });
    await w.db.update(messages).set({ noAi: true }).where(eq(messages.id, newer));
    const auto = await svc.suggest(w.ctx, { senders: [ORDINARY], automatic: true });
    expect(auto.skipped).toEqual([{ sender: ORDINARY, reason: "no_auto_ai" }]);
    expect(classifier.calls).toBe(0);
  });

  it("`automatic: false` is a press; anything but a boolean is a 400 that asks nobody", async () => {
    const { w, classifier, svc } = await flaggedQueue();
    for (const bad of ["true", 1, null, {}]) {
      await expect(svc.suggest(w.ctx, { senders: FLAGGED, automatic: bad }), `automatic: ${JSON.stringify(bad)}`)
        .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
    }
    expect(classifier.calls).toBe(0);
    expect(w.credits.spends).toEqual([]);
    const pressed = await svc.suggest(w.ctx, { senders: FLAGGED, automatic: false });
    expect(pressed.suggestions).toHaveLength(2);
    expect(classifier.calls).toBe(2);
  });
});

describe("two clicks do not pay twice", () => {
  it("re-buying the same sender is a `duplicate`: one debit, one ledger row, the model re-asked", async () => {
    const w = await billable({ credits: 10 });
    const a = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

    const first = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    const second = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });

    expect(first.charged).toBe(1);
    expect(second.charged, "the second click paid again").toBe(0);
    expect((await w.debits()).map((d) => d.source)).toEqual([screenerLedgerSource(a)]);
    expect(w.credits.spends).toHaveLength(1);
    // The stored answer is SERVED, not re-generated. A `duplicate` costs the user nothing and
    // costs us a model call, so the cheapest of the three double-charge layers is this one.
    expect(classifier.calls, "the second click reached the model").toBe(1);
    expect(second.quoted, "an already-bought sender was priced again").toBe(0);
    expect(second.suggestions).toEqual(first.suggestions);
  });

  it("re-buying leaves ONE stored suggestion per message, not a pile", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(await w.stored()).toHaveLength(1);
  });

  it("an Idempotency-Key replay returns the stored response and re-runs nothing", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    const idem = { key: "sg1", requestHash: "h1" };

    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: idem });
    // A SECOND request under the same key never reaches the service in the API (the middleware
    // replays), so what the service must guarantee is the race case: the claim is LOST and the
    // caller is told to replay rather than being handed a second, unrecorded purchase.
    await expect(svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: idem }))
      .rejects.toMatchObject({ name: "IdempotencyRaceLost" });
    expect(w.credits.spends).toHaveLength(1);
  });

  it("the suggestion is stored under a provenance NO existing reader matches", async () => {
    // `routing_decisions` is the pipeline's table. A suggestion borrows the columns and none of
    // the meaning: 'screener' there means "the router sent this to the gate", and reusing it
    // would have merged advice into every count of real routing decisions.
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: new SpyClassifier(), credits: w.credits, pricing: PLANE_PRICING,
    });
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });

    const [row] = await w.stored();
    expect(row!.inputProvenance).toBe("screener_suggestion");
    expect(row!.status).toBe("suggestion");
    expect(["rule", "header", "screener", "ai"]).not.toContain(row!.inputProvenance);
    expect(["auto_applied", "pending_approval", "approved", "rejected"]).not.toContain(row!.status);
  });
});

describe("UNMETERED hosts and cross-account reach", () => {
  it("no gate ⇒ suggestions, and not one ledger row", async () => {
    const w = await billable({ credits: 10 });
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: new SpyClassifier() });
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] });
    expect(res.suggestions).toHaveLength(1);
    expect(res.charged).toBe(0);
    expect(w.credits.spends, "nothing was charged").toEqual([]);
  });

  it("naming another account's sender buys nothing — the queue lookup is account-led", async () => {
    // BOTH accounts in ONE database, or this proves nothing: two `makeSuggestionCtx` calls are two
    // separate PGlite instances and a cross-account read would "pass" by having nothing to read.
    const mine = await billable({ credits: 10 });
    const otherAccount = randomUUID();
    await mine.db.insert(accounts).values({ id: otherAccount, name: "other" });
    const [otherMailbox] = await mine.db.insert(mailboxes)
      .values({ accountId: otherAccount, provider: "imap", address: "other@ex.example" }).returning();
    await seedMessage(mine.db, otherAccount, otherMailbox!.id, { from: "victim@ex.example" });

    // Present in the database, held in the Screener, and invisible to this account.
    const theirRows = await mine.db.select().from(messages).where(eq(messages.accountId, otherAccount));
    expect(theirRows).toHaveLength(1);

    const classifier = new SpyClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: mine.credits, pricing: PLANE_PRICING });
    const res = await svc.suggest(mine.ctx, { senders: ["victim@ex.example"] });
    expect(res.skipped).toEqual([{ sender: "victim@ex.example", reason: "not_held" }]);
    expect(classifier.calls).toBe(0);
    expect(await mine.debits()).toEqual([]);
  });
});
