import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { messageBodies, rules } from "@trafficflow/db";
import { buildSeedReview, confirmSeed } from "../src/consent-seed.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE SEED WRITES A SENDER'S BARE KEY ONLY WHERE THAT KEY HAS NO ROW (CONSENT-SEED-WRITES-BESIDE-
 * A-PAUSED-RULE). Any row under the key is a decision, paused included: the review says so and the
 * confirmation writes nothing there. A row narrowed by a subject term is another key, so it
 * decides nothing about the bare one.
 */
const X = "x@corr.invalid";
type World = Awaited<ReturnType<typeof makeCtx>>;

/** One of the account's own sent messages to `X`, with the header the review reads. */
async function wroteTo(w: World): Promise<void> {
  const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "mila@lichtgrat.example", folder: "Sent", subject: "a note" });
  await w.db.insert(messageBodies).values({ messageId: id, accountId: accountOfMessage(id), headers: { to: [X] } });
}

const underTheKey = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"), eq(rules.match, X))))
  .map((r) => ({ destination: r.destination, enabled: r.enabled, provenance: r.provenance, subject: r.subjectContains }));

describe("the seed and a sender who already has a rule", () => {
  it("an enabled rule decides the sender (positive control)", async () => {
    const w = await makeCtx();
    await wroteTo(w);
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: X, destination: "ohmail/News", provenance: "manual" });
    const review = await buildSeedReview(w.ctx);
    expect(review.candidates.find((c) => c.address === X)?.alreadyDecided).toBe(true);
    const out = await confirmSeed(w.ctx, [X]);
    expect(out.rulesCreated).toBe(0);
    expect(await underTheKey(w)).toHaveLength(1);
  });

  it("a PAUSED rule decides the sender too: offered as decided, nothing written beside it", async () => {
    const w = await makeCtx();
    await wroteTo(w);
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: X, destination: "ohmail/Screened", provenance: "manual", enabled: false });
    const review = await buildSeedReview(w.ctx);
    expect(review.candidates.find((c) => c.address === X)?.alreadyDecided).toBe(true);
    const out = await confirmSeed(w.ctx, [X]);
    expect(out.rulesCreated).toBe(0);
    expect(await underTheKey(w)).toEqual([{ destination: "ohmail/Screened", enabled: false, provenance: "manual", subject: null }]);
  });

  it("a rule narrowed by a subject term is another key: the bare key is seeded beside it", async () => {
    const w = await makeCtx();
    await wroteTo(w);
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: X, destination: "ohmail/Receipts", provenance: "manual", subjectContains: "invoice" });
    const review = await buildSeedReview(w.ctx);
    expect(review.candidates.find((c) => c.address === X)?.alreadyDecided).toBe(false);
    const out = await confirmSeed(w.ctx, [X]);
    expect(out.rulesCreated).toBe(1);
    expect((await underTheKey(w)).sort((a, b) => String(a.subject).localeCompare(String(b.subject)))).toEqual([
      { destination: "ohmail/Receipts", enabled: true, provenance: "manual", subject: "invoice" },
      { destination: "INBOX", enabled: true, provenance: "seeded-from-sent", subject: null },
    ]);
  });
});
