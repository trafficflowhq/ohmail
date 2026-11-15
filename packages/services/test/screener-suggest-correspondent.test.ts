import { accountOfMailbox, accountOfMessage } from "@trafficflow/db";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxFolders, mailboxes, messageBodies, messageInstances, messages, routingDecisions } from "@trafficflow/db";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "@trafficflow/core";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { ScreenerService } from "../src/index.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * THE PRESSED SUGGESTION CANNOT SAY SPAM OVER SOMEBODY THIS ACCOUNT WROTE TO (FIX-023): the
 * signal the correspondent predicate reads off the mailbox rides into `capSuggestion`, so a 1.0
 * Spam from the model is stored and answered as the Ohbox with the reason. The model is told the
 * fact too; the refusal does not depend on it listening. `.invalid` senders throughout.
 */
const NOW = new Date("2026-07-28T12:00:00Z");
const SPAM: ClassifierResult = { destination: "ohmail/Quarantine", confidence: 1, spam: true, rationale: "spam, clearly" };

class SpyClassifier implements ClassifierPort {
  seen: ClassifierInput[] = [];
  async classify(i: ClassifierInput): Promise<ClassifierResult> { this.seen.push(i); return SPAM; }
}

async function wired() {
  const w = await makeCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "screener-corr" });
  await w.db.update(mailboxes).set({ createdAt: new Date("2026-07-01T00:00:00Z") }).where(eq(mailboxes.id, w.mailboxId));
  await w.db.insert(mailboxFolders).values({ mailboxId: w.mailboxId, accountId: accountOfMailbox(w.mailboxId), folder: "Sent", uidvalidity: 7n, uidnext: 9n });
  const [sent] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: "sent:corr-1",
    subject: "the north elevation", fromAddress: "mila@lichtgrat.example", messageIdHeader: "sent-1@own.invalid",
    date: new Date("2026-07-27T15:12:00Z"), arrivedAt: new Date("2026-07-27T15:12:00Z"),
    toAddresses: [{ name: null, address: "them@corr.invalid" }], nativeLocator: { folder: "Sent", ref: "7:1" },
  }).returning();
  await w.db.insert(messageInstances).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageId: sent!.id, folder: "Sent", uidvalidity: 7n, uid: 1, isPrimary: true,
  });
  const classifier = new SpyClassifier();
  const credits = fakeSpendPort({ verdict: "ok", charged: true, attempt: "1" });
  return {
    ...w, classifier,
    svc: new ScreenerService({ adapter: new FakeAdapter(), classifier, credits, pricing: PLANE_PRICING }),
    rows: () => w.db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId)),
  };
}

describe("a pressed suggestion about a correspondent", () => {
  it("ACCEPTANCE: the model's 1.0 Spam is stored and answered as the Ohbox, with the reason", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "them@corr.invalid", subject: "Re: the north elevation" });
    const res = await w.svc.suggest(w.ctx, { senders: ["them@corr.invalid"] });
    expect(res.suggestions[0]).toMatchObject({
      decision: "yes", destination: "INBOX", spam: false, reasonCode: "correspondent", rationale: "",
    });
    const [stored] = await w.rows();
    expect(stored!.destination).toBe("INBOX");
    expect(stored!.spam).toBe(false);
    const facts = (w.classifier.seen[0] as ClassifierInput & { senderFacts?: string }).senderFacts;
    expect(facts).toContain("this account wrote to this sender");
  });

  it("an answer from an address the copy does not name is answered the same way, for that message", async () => {
    // The copy went to them@; the answer comes from another address and cites it: a correspondent
    // for this message (owner ruling 2026-10-08), so the bought Spam is capped with the reason.
    const w = await wired();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "assistant@else.invalid", subject: "Re: the north elevation" });
    await w.db.insert(messageBodies).values({ messageId: id, accountId: accountOfMessage(id), text: "", headers: { "in-reply-to": ["<sent-1@own.invalid>"] } });
    const res = await w.svc.suggest(w.ctx, { senders: ["assistant@else.invalid"] });
    expect(res.suggestions[0]).toMatchObject({ decision: "yes", destination: "INBOX", reasonCode: "correspondent" });
  });

  /** An answer from an address the copy does not name, under a company's name in the display name. */
  const claimant = async (w: Awaited<ReturnType<typeof wired>>, checked: boolean): Promise<string> => {
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, {
      from: "assistant@else.invalid", fromName: "PayPal", subject: "Re: the north elevation",
    });
    await w.db.insert(messageBodies).values({ messageId: id, accountId: accountOfMessage(id), text: "", headers: { "in-reply-to": ["<sent-1@own.invalid>"] } });
    if (checked) {
      await w.db.update(messages).set({ senderCheck: "impersonation", senderCheckBrand: "PayPal" }).where(eq(messages.id, id));
    }
    return id;
  };

  it("such an answer under a company's name is no correspondent: the reason is the claim", async () => {
    const w = await wired();
    await claimant(w, true);
    const res = await w.svc.suggest(w.ctx, { senders: ["assistant@else.invalid"] });
    expect(res.suggestions[0]!.reasonCode).toBe("impersonation");
  });

  it("the same before the backfill has checked the row: the page's own reading of the name decides", async () => {
    const w = await wired();
    await claimant(w, false);
    const res = await w.svc.suggest(w.ctx, { senders: ["assistant@else.invalid"] });
    expect(res.suggestions[0]!.reasonCode).toBe("impersonation");
  });

  it("CONTROL: a stranger's Spam stands", async () => {
    const w = await wired();
    await seedMessage(w.db, w.accountId, w.mailboxId, { from: "stranger@spam.invalid" });
    const res = await w.svc.suggest(w.ctx, { senders: ["stranger@spam.invalid"] });
    expect(res.suggestions[0]).toMatchObject({ decision: "no", destination: "ohmail/Quarantine", spam: true });
    expect(res.suggestions[0]!.reasonCode).toBeUndefined();
  });
});
