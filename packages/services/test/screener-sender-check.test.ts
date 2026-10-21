import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, routingDecisions } from "@trafficflow/db";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "@trafficflow/core";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { ScreenerService } from "../src/index.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * **THE SCREENER CHECKS THE SENDER BEFORE IT BELIEVES THE MAIL.**
 *
 * Measured: two first-time senders at unrelated domains, one "Metanet-Hosting: Ihre Domain läuft
 * in den nächsten 2 Tagen ab" subject between them, both suggested **Reads 0.95** as "an automated
 * service notification from your hosting provider". The model was asked to spot a forged sender
 * with every fact about the sender withheld. These cases drive the REAL service — `suggest` and
 * `list`. Every fixture domain is invented; the BRAND is real, because the dictionary is the half
 * of the comparison that has to be.
 */

const NOW = new Date("2026-07-28T12:00:00Z");

/** The answer the reported screenshot carried — the model believing the mail about itself. */
const READS: ClassifierResult = {
  destination: "ohmail/News", confidence: 0.95, spam: false,
  rationale: "an automated service notification from your hosting provider",
};

class SpyClassifier implements ClassifierPort {
  seen: ClassifierInput[] = [];
  constructor(private readonly result: ClassifierResult = READS) {}
  async classify(i: ClassifierInput): Promise<ClassifierResult> {
    this.seen.push(i);
    return this.result;
  }
}

async function wired() {
  const w = await makeCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "screener" });
  const credits = fakeSpendPort({ verdict: "ok", charged: true, attempt: "1" });
  const classifier = new SpyClassifier();
  return {
    ...w, credits, classifier,
    svc: new ScreenerService({ adapter: new FakeAdapter(), classifier, credits, pricing: PLANE_PRICING }),
    rows: () => w.db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId)),
  };
}

const FORGED = {
  from: "info@domain-renewals-ch.example",
  fromName: "Kundensupport",
  subject: "Metanet-Hosting: Ihre Domain läuft in den nächsten 2 Tagen ab",
  snippet: "Ihre bei metanet registrierte Domain läuft ab. Jetzt verlängern.",
};

describe("a first-time sender naming a company it is not", () => {
  it("stores Quarantine over the model's Reads 0.95, and says which fact decided", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, FORGED);

    const res = await w.svc.suggest(w.ctx, { senders: [FORGED.from] });

    expect(res.suggestions[0]).toMatchObject({
      decision: "no", destination: "ohmail/Quarantine", spam: true,
      reasonCode: "impersonation", reasonBrand: "Metanet",
    });
    expect(res.suggestions[0]!.confidence).toBeGreaterThanOrEqual(0.9);
    // The model's sentence explained the OPPOSITE verdict, so it is not printed under this one.
    expect(res.suggestions[0]!.rationale).toBe("");

    const [stored] = await w.rows();
    expect(stored!.destination).toBe("ohmail/Quarantine");
    expect(stored!.spam).toBe(true);
    // The fact that capped it is stored beside it: the act reads it before it writes a rule.
    expect(stored!.senderReason).toBe("impersonation");
  });

  it("hands the model the facts it could not derive, and no verdict", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, FORGED);
    await w.svc.suggest(w.ctx, { senders: [FORGED.from] });

    const facts = (w.classifier.seen[0] as ClassifierInput & { senderFacts?: string }).senderFacts;
    expect(facts).toContain("domain-renewals-ch.example");
    expect(facts).toContain("Metanet");
    expect(facts).toContain("metanet.ch");
    expect(facts).not.toMatch(/quarantine|spam/i);
  });

  it("the page says why, for a suggestion bought before any of this existed", async () => {
    const w = await wired();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, FORGED);
    // The reported row: stored by an older build, uncapped and unexplained.
    await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: id, inputProvenance: "screener_suggestion",
      destination: "ohmail/News", confidence: 0.95, rationale: READS.rationale,
      spam: false, status: "suggestion",
    });

    const page = await w.svc.list(w.ctx, {});
    expect(page.items[0]!.aiSuggestion).toMatchObject({
      destination: "ohmail/Quarantine", spam: true, decision: "no",
      reasonCode: "impersonation", reasonBrand: "Metanet",
    });
    // Corrected on the screen, and NOT re-bought: the check costs nothing.
    expect(w.classifier.seen).toHaveLength(0);
    expect(w.credits.spends).toEqual([]);
  });
});

describe("a verdict served from the store", () => {
  it("carries the reason too — pressing again does not replace the sentence with silence", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, FORGED);

    const first = await w.svc.suggest(w.ctx, { senders: [FORGED.from] });
    expect(first.suggestions[0]!.reasonCode).toBe("impersonation");

    // The second press finds the verdict on record and buys nothing — and still says why.
    const again = await w.svc.suggest(w.ctx, { senders: [FORGED.from] });
    expect(w.classifier.seen).toHaveLength(1);
    expect(again.suggestions[0]).toMatchObject({
      destination: "ohmail/Quarantine", reasonCode: "impersonation", reasonBrand: "Metanet",
    });
  });
});

describe("one subject, two strangers", () => {
  it("names the campaign and how many there were", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "a@parcel-notice.example", subject: "Your parcel could not be delivered today",
      snippet: "Confirm your address.",
    });
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "b@delivery-update.example", subject: "Your parcel could not be delivered today",
      snippet: "Confirm your address.",
    });

    const page = await w.svc.list(w.ctx, {});
    expect(page.items).toHaveLength(2);

    const res = await w.svc.suggest(w.ctx, {
      senders: ["a@parcel-notice.example", "b@delivery-update.example"],
    });
    for (const s of res.suggestions) {
      expect(s).toMatchObject({
        destination: "ohmail/Quarantine", reasonCode: "campaign", reasonCount: 2,
      });
    }
    // Stored with the crowd as its reason, which no automatic act turns into a rule on the address.
    const stored = await w.rows();
    expect(stored.map((r) => [r.destination, r.senderReason])).toEqual([
      ["ohmail/Quarantine", "campaign"], ["ohmail/Quarantine", "campaign"],
    ]);
  });
});

describe("the sender's own authentication", () => {
  it("a failed verdict decides, and NULL decides nothing", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "anna@studio-nord.example", fromName: "Anna Brunner",
      subject: "Quick question about Thursday", snippet: "Are you free after four?",
      authVerdict: "fail",
    });
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "tom@studio-sued.example", fromName: "Tom Iten",
      subject: "Lunch on Friday", snippet: "Shall we try the new place?",
    });

    const res = await w.svc.suggest(w.ctx, {
      senders: ["anna@studio-nord.example", "tom@studio-sued.example"],
    });
    const byS = new Map(res.suggestions.map((s) => [s.sender, s]));
    expect(byS.get("anna@studio-nord.example")).toMatchObject({
      destination: "ohmail/Quarantine", reasonCode: "auth_fail",
    });
    const clean = byS.get("tom@studio-sued.example")!;
    expect(clean.destination).toBe("ohmail/News");
    expect(clean.confidence).toBe(0.95);
    expect("reasonCode" in clean).toBe(false);
    expect((await w.rows()).map((r) => r.senderReason).sort()).toEqual(["auth_fail", "none"]);
  });
});

describe("the positive control — no signal, and nothing about the row moves", () => {
  it("the same mail from the brand's own domain stores the model's answer, field for field", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, {
      ...FORGED, from: "support@metanet.ch", fromName: "Metanet",
    });

    const res = await w.svc.suggest(w.ctx, { senders: ["support@metanet.ch"] });
    expect(res.suggestions[0]).toMatchObject({
      destination: "ohmail/News", confidence: 0.95, spam: false, rationale: READS.rationale,
    });
    expect("reasonCode" in res.suggestions[0]!).toBe(false);

    const [stored] = await w.rows();
    expect(stored!.destination).toBe("ohmail/News");
    expect(stored!.confidence).toBeCloseTo(0.95, 5);
    expect(stored!.rationale).toBe(READS.rationale);
    expect(stored!.spam).toBe(false);
    expect(stored!.senderReason, "no fact capped it, and the row says so").toBe("none");

    // …and the request carried no facts block at all, so it is the request it always was.
    expect((w.classifier.seen[0] as ClassifierInput & { senderFacts?: string }).senderFacts)
      .toBeUndefined();

    const page = await w.svc.list(w.ctx, {});
    expect(page.items[0]!.aiSuggestion).toEqual({
      decision: "yes", destination: "ohmail/News", spam: false,
      confidence: 0.95, rationale: READS.rationale,
    });
  });
});
