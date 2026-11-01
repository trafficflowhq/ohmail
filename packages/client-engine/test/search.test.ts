import { describe, expect, it } from "vitest";
import { DEMO_NOW, FixturesAdapter, OhmailEngine, SearchIndex, type EngineMessage } from "@ohmail/client-engine";

/** The instant local search over the mirror — incl. the canonical 'invoce' typo. */

async function demoEngine(): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

describe("local search", () => {
  it("'invoce' fuzzy-matches \"Invoice\" — in `similar`, not in `items`", async () => {
    const engine = await demoEngine();
    const res = engine.search("invoce");
    // The typo case still WORKS, and it is now labelled: nothing in the corpus contains the
    // reader's characters literally, so the answer is the similar tier and `items` is empty.
    // This test used to read `res.items`, which is exactly the interleaving that put a guess
    // above a match on a query that HAD one.
    expect(res.items).toHaveLength(0);
    expect(res.tier).toBe("similar");
    expect(res.similar.length).toBeGreaterThan(0);
    const erdton = res.similar.find((h) => h.message.id === "erdton");
    expect(erdton).toBeDefined();
    expect(erdton!.message.subject).toBe("Invoice #078 — Pottery Workshop");
    expect(erdton!.matches.some((m) => m.fuzzy && m.term === "invoice" && m.token === "invoce")).toBe(true);
    // …and it is the TOP guess, not merely present.
    expect(res.similar[0]?.message.id).toBe("erdton");
    // Facets describe the tier that is being answered with.
    expect(res.facets.folder["receipts"]).toBeGreaterThanOrEqual(1);
    expect(res.facets.sender.some((s) => s.address === "billing@erdton-atelier.example")).toBe(true);
  });

  it("exact subject terms rank the right message first", async () => {
    const engine = await demoEngine();
    const res = engine.search("talk");
    expect(res.items[0]?.message.id).toBe("petra");
    expect(res.items[0]?.matches[0]?.fuzzy).toBe(false);
    expect(res.facets.hasAttachment.true).toBeGreaterThanOrEqual(1);
  });

  it("matches sender address tokens ('terracotta' → Giulia)", async () => {
    const engine = await demoEngine();
    const res = engine.search("terracotta");
    expect(res.items.map((h) => h.message.id)).toContain("giulia");
  });

  it("multi-token queries AND across tokens, over subject / sender / snippet", async () => {
    const engine = await demoEngine();
    // `f1` is "#118 — the joy of small tools", snippet "Plus: a lamp, a ladle, and one very good
    // pencil." — both words are on the device, one in each field, and AND finds it.
    const res = engine.search("tools ladle");
    expect(res.items.map((h) => h.message.id)).toContain("f1");
    // …and AND is an AND: a token nothing answers empties the result.
    expect(engine.search("ladle zzzzzzzz").items).toHaveLength(0);
  });

  it("a phrase that lives only in a BODY is not a device question — it is an archive one", async () => {
    /**
     * THE COVERAGE RULE, DRIVEN. "honest graphite" is in `f1`'s body and in no other field of
     * any row, and this test asserted it was FOUND until the instant index stopped reading
     * bodies. It is kept, inverted, because the inverted form is the claim the scope sentence
     * now makes — and because a test that merely stopped existing would leave nothing measuring
     * which half of the corpus this index covers.
     *
     * The demo is also the surface with no archive behind it, so it states that rather than
     * implying the answer is everything: `serverSearchAvailable()` is false and the view's
     * `scopeNoArchive` arm is what a reader sees.
     */
    const engine = await demoEngine();
    expect(engine.search("honest graphite").items).toHaveLength(0);
    expect(engine.search("graphite").items).toHaveLength(0);
    expect(engine.search("honest graphite").coverage.full).toBe(0);
    expect(engine.serverSearchAvailable()).toBe(false);
    // The same message is still findable by everything the device DOES hold.
    expect(engine.search("ladle").items.map((h) => h.message.id)).toContain("f1");
  });

  it("empty query returns nothing; index tracks mirror mutations", async () => {
    const engine = await demoEngine();
    expect(engine.search("").items).toHaveLength(0);

    // A screener Yes files new mail — the index must see it on the next search.
    await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes" });
    const res = engine.search("Werkstatt");
    expect(res.items.some((h) => h.message.subject.startsWith("Werkstatt-Besuch"))).toBe(true);
  });
});

/** The first paint of a query with a minus word: the words asked, less every letter that holds the excluded one. */
describe("a minus word only leaves letters out of the first paint", () => {
  const letter = (id: string, subject: string, address: string, snippet: string): EngineMessage => ({
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject, from: { name: null, address },
    to: [], cc: [], date: "2026-09-01T09:00:00.000Z", folder: "INBOX", snippet, unread: false, hasAttachments: false,
    attachmentCount: 0, sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-01T09:00:00.000Z",
  });
  const index = new SearchIndex();
  for (const m of [
    letter("subject", "Mail delivery", "ada@lind.example", "Thanks for waiting."),
    letter("body", "Weekend", "bo@ek.example", "Send me the mail later."),
    letter("prefix", "Quarterly statement", "post@mailroom.example", "Your statement is ready."),
    letter("orchard", "Apples", "cy@lund.example", "The orchard is ready. You can come."),
    letter("thank", "Thank you", "fay@hill.example", "Flowers arrived."),
    letter("feast", "Thanksgiving menu", "gus@bay.example", "Mail me your order."),
  ]) index.add(m);
  const painted = (q: string): string[] => {
    const r = index.search(q);
    return [...r.items, ...r.similar].map((h) => h.message.id).sort();
  };

  it("paints the words asked, less the letters holding the word, its start or a longer word", () => {
    expect(painted("mail")).toEqual(["body", "feast", "prefix", "subject"]);
    expect(painted("mail -thanks")).toEqual(["body", "prefix"]);
    expect(painted("you -thanks")).toEqual(["orchard", "prefix"]);
    expect(painted("is -orchard")).toEqual(["prefix"]);
    expect(painted("mail -zzzqx")).toEqual(painted("mail"));
  });

  it("a minus word alone paints nothing, and a guess never holds the excluded word", () => {
    expect(painted("-thanks")).toEqual([]);
    expect(index.search("delivry").similar.map((h) => h.message.id)).toEqual(["subject"]);
    expect(painted("delivry -thanks")).toEqual([]);
  });
});
