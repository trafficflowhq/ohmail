import { describe, it, expect } from "vitest";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, routingDecisions } from "@trafficflow/db";
import type { LedgerTx, Tx } from "@trafficflow/db";
import type { ClassifierPort, ClassifierInput, ClassifierResult, Destination } from "@trafficflow/core";
import { ScreenerService } from "../src/index.js";
import { makeSuggestionCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * EVERY OUTCOME THE MODEL CAN NAME REACHES THE SURFACE. Six answers used to fold into three
 * words on the way out: measured on a live Screener, many bought suggestions — Receipts,
 * the News pile (`ohmail/Reads` at the time of the measurement) and Quarantine — all rendered
 * as the single word "Screened out", and three reported defects were one. These cases pin the
 * repair: `destination` and `spam` travel beside `decision`, unreduced, on BOTH the fresh
 * purchase and the stored read; `decision` keeps its three values on purpose — bulk controls
 * consume it, so widening it would widen what one press can do.
 */

const NOW = new Date("2026-08-07T12:00:00Z");

class FixedClassifier implements ClassifierPort {
  calls = 0;
  constructor(private readonly result: ClassifierResult) {}
  async classify(_i: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    return this.result;
  }
}

/** An account and a RECORDING spend port — the same shape `screener-ai.test.ts` builds. */
async function billable() {
  const w = await makeSuggestionCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "screener" });
  return { ...w, credits: fakeSpendPort() };
}

function verdict(destination: Destination, spam = false): ClassifierResult {
  return { destination, confidence: 0.9, rationale: `filed to ${destination}`, spam };
}

/**
 * ONE FIXTURE PER OUTCOME, built from real reported cases.
 *
 * `decision` is the posture-aware verdict under the LENIENT default (`people_and_replied`, which
 * every unset preference resolves to), so Reads and Receipts read "yes" here. What must be true of
 * every row regardless of posture is the destination: it is the model's answer, and it survives.
 */
const OUTCOMES: Array<{
  label: string;
  sender: string;
  destination: Destination;
  spam: boolean;
  decision: "yes" | "no" | "hold";
}> = [
  { label: "a real person", sender: "lena@example.com", destination: "INBOX", spam: false, decision: "yes" },
  { label: "a newsletter", sender: "posts-recap@mail.example.com", destination: "ohmail/News", spam: false, decision: "yes" },
  { label: "an order confirmation from a first-contact shop", sender: "orders@shop.example.com", destination: "ohmail/Receipts", spam: false, decision: "yes" },
  { label: "a wordpress update flood", sender: "wordpress@site.example.com", destination: "ohmail/Screened", spam: false, decision: "no" },
  { label: "junk", sender: "blast@spammer.example.com", destination: "ohmail/Quarantine", spam: true, decision: "no" },
  { label: "a sender the model declines to place", sender: "unclear@example.com", destination: "ohmail/Screener", spam: false, decision: "hold" },
];

describe("every destination the model can name survives to the suggestion", () => {
  for (const c of OUTCOMES) {
    it(`${c.label} → ${c.destination}, on the fresh purchase AND on the stored read`, async () => {
      const w = await billable();
      await seedMessage(w.db, w.accountId, w.mailboxId, { from: c.sender });
      const classifier = new FixedClassifier(verdict(c.destination, c.spam));
      const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });

      const bought = await svc.suggest(w.ctx, { senders: [c.sender] });
      expect(bought.suggestions).toHaveLength(1);
      // THE FRESH ANSWER. `destination` is what the model said; `decision` is what a bulk control
      // may do about it. Both are asserted because the defect was one being derived from the other.
      expect(bought.suggestions[0]).toMatchObject({
        sender: c.sender, decision: c.decision, destination: c.destination, spam: c.spam,
      });

      // THE STORED READ, through a second service with no classifier at all — the page-load path.
      // It must answer identically: a suggestion that read one way when bought and another on
      // reload would be the same fold reappearing one layer down.
      const page = await svc.list(w.ctx, {});
      expect(page.items[0]!.aiSuggestion).toMatchObject({
        decision: c.decision, destination: c.destination, spam: c.spam,
      });
    });
  }

  it("spam is reachable end to end: the row on disk carries it and the read path repeats it", async () => {
    // The reported symptom was "it does many screen outs, but never spam". Spam WAS being produced
    // — 5 rows on a live account and 4 on the test account, all `spam=true` — and then folded
    // into the same "no" as an ordinary screen-out. This asserts the whole path, including the
    // column, so a future collapse has to break a stored value and not just a DTO field.
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "blast@spammer.example.com" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(),
      classifier: new FixedClassifier(verdict("ohmail/Quarantine", true)),
      credits: w.credits, pricing: PLANE_PRICING,
    });

    const res = await svc.suggest(w.ctx, { senders: ["blast@spammer.example.com"] });
    expect(res.suggestions[0]!.spam).toBe(true);
    expect(res.suggestions[0]!.destination).toBe("ohmail/Quarantine");

    const rows = await w.db.select().from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(rows.filter((r) => r.inputProvenance === "screener_suggestion")).toHaveLength(1);
    expect(rows[0]!.spam).toBe(true);
    expect(rows[0]!.destination).toBe("ohmail/Quarantine");

    expect((await svc.list(w.ctx, {})).items[0]!.aiSuggestion!.spam).toBe(true);
  });

  it("a label outside the taxonomy is a hold at the gate, never a guess at a pile", async () => {
    // `destination` is read from a `text` column, so it must be total over strings and not over
    // the union. An unrecognised label becomes the gate — which every consumer reads as "the
    // person decides" — rather than the nearest plausible folder.
    const w = await billable();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "odd@example.com" });
    const svc = new ScreenerService({
      adapter: new FakeAdapter(),
      classifier: new FixedClassifier({
        destination: "ohmail/Nonsense" as Destination,
        confidence: 0.99, rationale: "unparseable", spam: false,
      }),
      credits: w.credits, pricing: PLANE_PRICING,
    });

    const res = await svc.suggest(w.ctx, { senders: ["odd@example.com"] });
    expect(res.suggestions[0]!.decision).toBe("hold");
    expect(res.suggestions[0]!.destination).toBe("ohmail/Screener");
  });
});
