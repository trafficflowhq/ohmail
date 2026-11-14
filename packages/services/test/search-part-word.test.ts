import { describe, expect, it } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { partWordsOf } from "@trafficflow/db/dialect";
import { SearchService } from "../src/index.js";
import { FOUND_WITHOUT_DOCUMENT, makeCtx, seedMessage, seedSearchDocuments } from "./helpers.js";

/**
 * A PART OF A WORD FINDS WHAT THE WHOLE WORD FINDS, over the fields the whole word reads (subject,
 * people, body) — on both stores: this file runs in the sqlite project too. The words sit in BODIES
 * past the preview, with unrelated subjects, so the header-only substring arm cannot answer for
 * them. Watched red at the base: `elevat` missed every body hit and the monotonicity case failed
 * at `eleva`, where the whole word's stem (`elev`) stops being a prefix of what was typed.
 */
const FILLER = "Notes from the visit follow, with the figures attached for the record. ".repeat(4);
const WORDS = ["elevation", "meeting", "invoices", "nationalization", "running", "happiness", "delivered", "organisation"] as const;

async function corpus(built: boolean) {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  const ids: Record<string, string> = {};
  const put = async (key: string, subject: string, body: string, daysAgo: number) => {
    const id = await seedMessage(db, accountId, mailboxId, {
      subject, from: `sender${daysAgo}@site.example`, snippet: body.slice(0, 200), folder: "INBOX",
      date: new Date(Date.parse("2026-07-20T09:00:00Z") - daysAgo * 86_400_000),
    });
    await db.insert(messageBodies).values({ messageId: id, accountId, text: body });
    ids[key] = id;
  };
  await put("subject", "Elevation survey for the north wall", "See the drawings.", 1);
  await put("preview", "Site notes", "The elevation plan is attached for review.", 2);
  await WORDS.reduce<Promise<void>>((p, w, i) => p.then(() => put(w, `Weekly note ${i}`, `${FILLER} Then the ${w} came up again.`, 10 + i)), Promise.resolve());
  await put("decoy", "Holiday plans", "See you soon.", 30);
  if (built) {
    const r = await searchIndexBackfillPass({ db: db as never, accountId });
    expect(r.marked).toBe(true);
  }
  return { ctx, ids };
}

async function found(ctx: Awaited<ReturnType<typeof corpus>>["ctx"], q: string): Promise<{ tier: string; ids: Set<string> }> {
  const r = await new SearchService().search(ctx, { q, limit: 50 });
  return { tier: r.tier, ids: new Set(r.items.map((m) => m.id)) };
}

const prefixes = (w: string): string[] => Array.from({ length: w.length - 4 }, (_, i) => w.slice(0, 4 + i));

describe.each(([
  ["with the search documents built", true],
  ["before the documents are built (the device's own tables)", false],
] as const).filter(([, built]) => built || FOUND_WITHOUT_DOCUMENT))("a part of a word finds what the whole word finds — %s", (_label, built) => {
  it("(1) `elevat` finds the message whose body alone holds the word, beside the subject hit", async () => {
    const { ctx, ids } = await corpus(built);
    // The positive control: the whole word reaches the body at the base too.
    const whole = await found(ctx, "elevation");
    expect(whole.ids.has(ids.preview!)).toBe(true);
    const part = await found(ctx, "elevat");
    expect(part.tier).toBe("exact");
    expect(part.ids.has(ids.subject!)).toBe(true);
    expect(part.ids.has(ids.preview!)).toBe(true);
    expect(part.ids.has(ids.elevation!)).toBe(true);
    expect(part.ids.has(ids.decoy!)).toBe(false);
  });

  it("(2) every prefix of a word from four letters finds at least the whole word's set", async () => {
    const { ctx } = await corpus(built);
    for (const w of WORDS) {
      const whole = await found(ctx, w);
      expect(whole.tier, w).toBe("exact");
      expect(whole.ids.size, w).toBeGreaterThan(0);
      for (const p of prefixes(w)) {
        const part = await found(ctx, p);
        const missing = [...whole.ids].filter((id) => !part.ids.has(id));
        expect({ p, tier: part.tier, missing: missing.length }).toEqual({ p, tier: "exact", missing: 0 });
      }
    }
  });

  it("(3) a part word inside a two-word query keeps the other word's meaning", async () => {
    const { ctx, ids } = await corpus(built);
    const r = await found(ctx, "elevati plan");
    expect(r.ids.has(ids.preview!)).toBe(true);
    expect(r.ids.has(ids.subject!)).toBe(false);
  });

  it("(4) what the arm inlines is letters and digits, whatever was typed", async () => {
    const { ctx, ids } = await corpus(built);
    const typed = "elevat'ion\\; drop table messages;";
    expect(partWordsOf(typed)).toEqual(["elevat", "ion", "drop", "table", "messages"]);
    const r = await found(ctx, typed);
    expect(r.ids.has(ids.decoy!)).toBe(false);
  });

  it("(5) each side of an `or` keeps its part, up to four part words in all", async () => {
    const { ctx, ids } = await corpus(built);
    const sides = ["elevati", "meetin", "invoic", "nationa"];
    const r = await found(ctx, sides.join(" or "));
    expect(WORDS.slice(0, 4).filter((w) => !r.ids.has(ids[w]!))).toEqual([]);
    // Past four the arm stays shut, as past eight for one side: each word is one more prefix read.
    const past = await found(ctx, [...sides, "runnin"].join(" or "));
    expect(past.ids.has(ids.nationalization!)).toBe(false);
  });
});

/**
 * THE QUERY'S OWN PUNCTUATION NEVER REFUSES AND NEVER BECOMES AN OPERATOR, on both stores. The
 * device store handed the typed text to FTS5 as its query syntax: an apostrophe, a hyphen, a lone
 * double quote or a colon answered a syntax error, and a star was a prefix operator the server's
 * parser does not have. Watched red at the base in the sqlite project: the five shapes below.
 */
describe("the query's own punctuation never refuses and never becomes a search operator", () => {
  async function marks() {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const ids: Record<string, string> = {};
    const put = async (key: string, subject: string, body: string) => {
      const id = await seedMessage(db, accountId, mailboxId, { subject, from: "desk@site.example", snippet: body, folder: "INBOX" });
      await db.insert(messageBodies).values({ messageId: id, accountId, text: body });
      ids[key] = id;
    };
    await put("obrien", "Letter from O'Brien", "Regards.");
    await put("email", "Your e-mail address", "Confirm it.");
    await put("portal", "Portal access", "Granted.");
    await put("colon", "Minutes: budget", "Attached.");
    await put("axa", "axa claim", "Filed.");
    await put("axalta", "Axalta coating", "Quote.");
    await seedSearchDocuments(db, accountId);
    return { ctx, ids };
  }
  const SHAPES = [
    ["an apostrophe", "O'Brien", "obrien"],
    ["a hyphen", "e-mail", "email"],
    ["a lone double quote", '"portal', "portal"],
    ["a colon", "minutes:budget", "colon"],
    ["a star", "axa*", "axa"],
  ] as const;
  for (const [label, q, key] of SHAPES) {
    it(`${label} (${q}) answers and finds its message`, async () => {
      const { ctx, ids } = await marks();
      const r = await found(ctx, q);
      expect(r.tier, q).toBe("exact");
      expect(r.ids.has(ids[key]!), q).toBe(true);
    });
  }

  it("a star is not a prefix operator: `axa*` does not reach `Axalta`", async () => {
    const { ctx, ids } = await marks();
    expect((await found(ctx, "axa*")).ids.has(ids.axalta!)).toBe(false);
  });

  it("the positive control: a plain word and a part of one still match", async () => {
    const { ctx, ids } = await marks();
    expect((await found(ctx, "claim")).ids.has(ids.axa!)).toBe(true);
    expect((await found(ctx, "coati")).ids.has(ids.axalta!)).toBe(true);
  });
});
